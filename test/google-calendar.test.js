'use strict';

// Google Calendar as the booking event source. Two properties matter most: the
// sync gate is OFF so nothing reads or writes in production, and Google feeds
// the EXISTING call lifecycle rather than deciding anything itself.
// Nothing here touches Google or the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  BOOKING_DECISION, classifyCalendarEvent, normalizeCalendarEvent, bookerAttendee,
  matchBookingIdentity, bookingLifecycleAction, providerEventKey, sameInstant, nextSyncState,
  runGoogleCalendarSync,
} = require('../integrations/google-calendar');
const { BOOKING_URL, containsBookingLink, bookingSnippet, bookingUrlHost } = require('../booking');
const { CALL_STATUS, deriveCallLifecycle, deriveNextAction, ACTION_TYPE, ACTION_OWNER } = require('../integrations/pipeline-state');

const root = path.join(__dirname, '..');
// core.autocrlf is on for this repo, so a fresh checkout yields CRLF source.
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
const server = readSource(path.join(root, 'server.js'));
const agent = readSource(path.join(root, 'outreach-agent.js'));
const browser = readSource(path.join(root, 'public', 'index.html'));
const calSrc = readSource(path.join(root, 'integrations', 'google-calendar.js'));

const OWNER = 'me@tryscalelabai.ca';
const opts = { ownerEmails: new Set([OWNER]), bookingCalendarId: OWNER, calendarId: OWNER };
const AT = '2026-09-02T17:00:00.000Z';
const LATER = '2026-09-09T17:00:00.000Z';

const gEvent = (over = {}) => ({
  id: 'ev1', status: 'confirmed', eventType: 'default', summary: 'Discovery call',
  start: { dateTime: AT, timeZone: 'America/Vancouver' }, end: { dateTime: AT },
  organizer: { email: OWNER, self: true },
  attendees: [{ email: OWNER, self: true, organizer: true }, { email: 'lead@x.test', displayName: 'Lead' }],
  // Real appointment-schedule bookings carry this Google-set marker, so the
  // baseline fixture must too — without it this is a manual meeting, not a
  // booking, and the detector is right to refuse it.
  extendedProperties: { shared: { 'goo.createdByAvailId': 'sched1', 'goo.createdBySet': 'default_cita' } },
  ...over,
});

function syncHarness(overrides = {}) {
  const calls = { read: 0, fetch: [], load: 0, plan: 0, apply: [], write: [] };
  const previous = { syncToken: 'old-token', needsFullSync: false };
  const plans = overrides.plans || [];
  const harness = {
    enabled: overrides.enabled !== undefined ? overrides.enabled : true,
    calendarId: overrides.calendarId !== undefined ? overrides.calendarId : OWNER,
    appointmentScheduleId: overrides.appointmentScheduleId !== undefined ? overrides.appointmentScheduleId : 'sched1',
    readState: async () => { calls.read++; return previous; },
    fetchChanges: async args => {
      calls.fetch.push(args);
      if (overrides.fetchResults) return overrides.fetchResults[calls.fetch.length - 1];
      return { ok: true, complete: true, events: [{}], nextSyncToken: 'new-token', at: '2026-08-27T20:00:00.000Z' };
    },
    loadContext: async () => { calls.load++; return { marker: true }; },
    planBookings: async () => { calls.plan++; return plans; },
    applyPlan: async item => { calls.apply.push(item); return overrides.applyResult || { ok: true, leadId: 'L1' }; },
    writeState: async state => { calls.write.push(state); },
    logger: { info() {}, warn() {}, error() {} },
  };
  return { calls, harness };
}

test('live writer performs zero reads or writes while feature flag is OFF', async () => {
  const { calls, harness } = syncHarness({ enabled: false });
  const result = await runGoogleCalendarSync(harness);
  assert.equal(result.skipped, true);
  assert.deepEqual(calls, { read: 0, fetch: [], load: 0, plan: 0, apply: [], write: [] });
});

test('live writer refuses missing calendar or Appointment Schedule configuration', async () => {
  for (const missing of ['calendarId', 'appointmentScheduleId']) {
    const { calls, harness } = syncHarness({ [missing]: '' });
    const result = await runGoogleCalendarSync(harness);
    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.equal(calls.read, 0);
    assert.equal(calls.fetch.length, 0);
  }
});

test('checkpoint advances only after all canonical mutations succeed', async () => {
  const classified = { event: { providerEventId: 'g1' } };
  const { calls, harness } = syncHarness({ plans: [{ action: 'book', outcome: 'book', classified }] });
  const result = await runGoogleCalendarSync(harness);
  assert.equal(result.ok, true);
  assert.equal(result.mutations, 1);
  assert.equal(calls.apply.length, 1);
  assert.equal(calls.write.length, 1);
  assert.equal(calls.write[0].syncToken, 'new-token');
});

test('failed mutation retains checkpoint and replay can safely retry', async () => {
  const classified = { event: { providerEventId: 'g1' } };
  const first = syncHarness({ plans: [{ action: 'reschedule', outcome: 'reschedule', classified }], applyResult: { ok: false, error: 'sheet write failed' } });
  const failed = await runGoogleCalendarSync(first.harness);
  assert.equal(failed.ok, false);
  assert.equal(failed.checkpointAdvanced, false);
  assert.equal(first.calls.write.length, 0);

  const retry = syncHarness({ plans: [{ action: 'reschedule', outcome: 'reschedule', classified }] });
  const recovered = await runGoogleCalendarSync(retry.harness);
  assert.equal(recovered.ok, true);
  assert.equal(retry.calls.apply.length, 1);
  assert.equal(retry.calls.write.length, 1);
});

test('HTTP 410 performs a full sync and checkpoints only the completed replacement walk', async () => {
  const { calls, harness } = syncHarness({ fetchResults: [
    { ok: true, tokenInvalid: true, events: [], at: '2026-08-27T20:00:00.000Z' },
    { ok: true, complete: true, events: [], nextSyncToken: 'fresh-token', at: '2026-08-27T20:00:01.000Z' },
  ] });
  const result = await runGoogleCalendarSync(harness);
  assert.equal(result.ok, true);
  assert.equal(calls.fetch.length, 2);
  assert.equal(calls.fetch[0].syncToken, 'old-token');
  assert.equal(calls.fetch[1].syncToken, null);
  assert.equal(calls.write[0].syncToken, 'fresh-token');
});

test('unmatched and conflicting bookings are review-only but do not block a safe checkpoint', async () => {
  const plans = ['unmatched', 'conflict'].map((outcome, i) => ({
    outcome, reason: `${outcome} identity`, classified: { event: { providerEventId: `g${i}` } },
  }));
  const { calls, harness } = syncHarness({ plans });
  const result = await runGoogleCalendarSync(harness);
  assert.equal(result.ok, true);
  assert.equal(result.review.length, 2);
  assert.equal(calls.apply.length, 0);
  assert.equal(calls.write.length, 1);
});

// ── BOOKING URL (1–4) ───────────────────────────────────────────────────────

test('1/3. the canonical Google booking URL replaces the Calendly link everywhere', () => {
  assert.equal(BOOKING_URL, 'https://calendar.app.google/h3X8e3WbBKjPrBoVA');
  assert.equal(bookingUrlHost(), 'calendar.app.google');
  // Every CTA derives from the one config value.
  assert.ok(bookingSnippet('Galaxy Dental').includes(BOOKING_URL));
  const bookingSrc = readSource(path.join(root, 'booking.js'));
  assert.match(bookingSrc, /process\.env\.BOOKING_URL \|\| 'https:\/\/calendar\.app\.google\/h3X8e3WbBKjPrBoVA'/);
  // The literal is not scattered: it lives in booking.js and nowhere else in code.
  for (const [name, src] of [['outreach-agent.js', agent], ['server.js', server], ['public/index.html', browser]]) {
    assert.ok(!src.includes('h3X8e3WbBKjPrBoVA'), `${name} must consume the constant, not the literal`);
  }
});

test('2. no live Calendly URL remains in any send path or config', () => {
  const bookingSrc = readSource(path.join(root, 'booking.js'));
  for (const [name, src] of [['booking.js', bookingSrc], ['outreach-agent.js', agent], ['server.js', server]]) {
    assert.ok(!/calendly\.com/i.test(src), `${name} still references a Calendly URL`);
  }
  // No Calendly SDK, webhook or env var was introduced.
  assert.ok(!/calendly/i.test(server));
  assert.ok(!fs.existsSync(path.join(root, 'node_modules', 'calendly')));
});

test('4. the cold-email guard follows the CONFIGURED link, not a dead provider name', () => {
  // This is the bug the URL change would otherwise have introduced: the guard
  // used to test /calendly\.com/, which stops matching anything the moment the
  // booking link moves — silently letting the warm-only asset into cold sends.
  assert.match(agent, /if \(containsBookingLink\(body\)\) return 'cold email contains the warm-only booking link';/);
  // Strip comments: the note explaining the fix names the old provider.
  const agentCode = agent.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert.ok(!/calendly/i.test(agentCode), 'no hard-coded provider domain remains in the guard');
  assert.equal(containsBookingLink(`book here ${BOOKING_URL}`), true);
  assert.equal(containsBookingLink('see calendar.app.google/other'), true, 'host match catches variants');
  assert.equal(containsBookingLink('an ordinary cold email'), false);
  assert.equal(containsBookingLink(''), false);
  assert.equal(containsBookingLink(bookingSnippet('Galaxy Dental')), true, 'the real snippet is caught');
});

// ── EVENT IDENTIFICATION (5–9) ──────────────────────────────────────────────

test('5/9. a booking-shaped event is recognised and its provider id captured', () => {
  const c = classifyCalendarEvent(gEvent(), opts);
  assert.equal(c.decision, BOOKING_DECISION.BOOKED);
  assert.equal(c.attendeeEmail, 'lead@x.test');
  assert.equal(c.meetingAt, AT);
  assert.equal(c.event.providerEventId, 'ev1');
  assert.equal(c.event.timeZone, 'America/Vancouver');
});

test('6/7. personal, all-day, recurring and other-organiser events are ignored', () => {
  const cases = [
    ['all-day', { start: { date: '2026-09-02' }, end: { date: '2026-09-03' } }, /not a timed event/],
    ['out of office', { eventType: 'outOfOffice' }, /never a booking/],
    ['focus time', { eventType: 'focusTime' }, /never a booking/],
    ['recurring shift', { recurringEventId: 'series' }, /recurring series/],
    ['someone else organised', { organizer: { email: 'them@x.test', self: false } }, /not the organizer/],
  ];
  for (const [label, over, reason] of cases) {
    const c = classifyCalendarEvent(gEvent(over), opts);
    assert.equal(c.decision, BOOKING_DECISION.IGNORED, `${label} must be ignored`);
    assert.match(c.reason, reason);
  }
  // A different calendar is never the booking source.
  const other = classifyCalendarEvent(gEvent(), { ...opts, calendarId: 'personal@gmail.test' });
  assert.equal(other.decision, BOOKING_DECISION.IGNORED);
  assert.match(other.reason, /not on the configured booking calendar/);
});

test('8. insufficient or ambiguous metadata fails closed', () => {
  assert.equal(classifyCalendarEvent(gEvent({ id: '' }), opts).decision, BOOKING_DECISION.IGNORED);
  // No attendee at all — nobody to match.
  const noneAtt = classifyCalendarEvent(gEvent({ attendees: [{ email: OWNER, self: true, organizer: true }] }), opts);
  assert.equal(noneAtt.decision, BOOKING_DECISION.IGNORED);
  // Two outside attendees — which one booked? Refuse rather than pick.
  const two = classifyCalendarEvent(gEvent({
    attendees: [{ email: OWNER, self: true, organizer: true }, { email: 'a@x.test' }, { email: 'b@x.test' }],
  }), opts);
  assert.equal(two.decision, BOOKING_DECISION.IGNORED);
  assert.match(two.reason, /no single outside attendee/);
  assert.equal(bookerAttendee(normalizeCalendarEvent(gEvent()), new Set([OWNER])).email, 'lead@x.test');
  // Identification never rests on the title.
  assert.ok(!/summary\s*(===|\.includes|\.match)/.test(calSrc), 'a booking is never identified by its title');
});

// ── IDENTITY (10–14) ────────────────────────────────────────────────────────

test('10/11. an exact attendee email maps to the lead', () => {
  const m = matchBookingIdentity('Lead@X.test', {
    coldEmailLeads: [{ id: 'CE1', email: 'lead@x.test' }],
    boardLeads: [{ id: 'CE-CE1', email: 'lead@x.test' }],
  });
  assert.equal(m.status, 'matched');
  assert.equal(m.matchedBy, 'attendee_email');
  assert.equal(m.coldEmailLead.id, 'CE1');
  assert.equal(m.boardLead.id, 'CE-CE1');
});

test('12. name-only and fuzzy matching are forbidden', () => {
  const m = matchBookingIdentity('someone@else.test', {
    coldEmailLeads: [{ id: 'CE1', email: 'lead@x.test', company: 'X Dental', contactName: 'Lead' }],
    boardLeads: [],
  });
  assert.equal(m.status, 'unmatched', 'a different address must not match on name or company');
  // The module contains no company/name/domain matching at all.
  const fn = calSrc.slice(calSrc.indexOf('function matchBookingIdentity'), calSrc.indexOf('// ── LIFECYCLE MAPPING'));
  assert.ok(!/company|displayName|domain|includes\(/.test(fn), 'identity uses exact email only');
});

test('13. an ambiguous address fails closed', () => {
  const dupCe = matchBookingIdentity('lead@x.test', {
    coldEmailLeads: [{ id: 'A', email: 'lead@x.test' }, { id: 'B', email: 'lead@x.test' }], boardLeads: [],
  });
  assert.equal(dupCe.status, 'conflict');
  const dupBoard = matchBookingIdentity('lead@x.test', {
    coldEmailLeads: [], boardLeads: [{ id: 'A', email: 'lead@x.test' }, { id: 'B', email: 'lead@x.test' }],
  });
  assert.equal(dupBoard.status, 'conflict');
  assert.equal(matchBookingIdentity('', {}).status, 'unmatched');
});

test('14. an unknown booking is surfaced, never discarded and never invented', () => {
  const m = matchBookingIdentity('stranger@new.test', { coldEmailLeads: [], boardLeads: [] });
  assert.equal(m.status, 'unmatched');
  assert.match(m.reason, /no Outreach or board lead has this address/);
  assert.equal(m.email, 'stranger@new.test', 'the address is retained for review');
  // The planner reports it rather than dropping it or creating a lead.
  const planner = server.slice(server.indexOf('async function planCalendarBookings'), server.indexOf('async function loadBookingContext'));
  assert.match(planner, /identity\.status !== 'matched'/);
  assert.match(planner, /outcome: identity\.status/);
  assert.ok(!/values\.append|createLead/.test(planner), 'the planner invents no lead');
});

// ── BOOKING → LIFECYCLE (15–19) ─────────────────────────────────────────────

test('15/18. a booking maps to the existing lifecycle and promotion, not a new one', () => {
  const action = bookingLifecycleAction(classifyCalendarEvent(gEvent(), opts), {});
  assert.equal(action.action, 'book');
  assert.equal(action.meetingAt, AT);
  // The sync produces canonical lifecycle actions — book/reschedule/cancel —
  // which the Step 9 route already knows how to apply, holds included.
  assert.ok(!/googleMeetingStatus|calendarStage/.test(calSrc), 'no parallel meeting state');
  assert.ok(!/applyManualHold|values\.update/.test(calSrc), 'the module writes nothing itself');
  assert.match(server, /CALL_STATUS, deriveCallLifecycle/, 'the canonical lifecycle is reused');
});

test('16/17. the same event delivered twice is a no-op', () => {
  const classified = classifyCalendarEvent(gEvent(), opts);
  const first = bookingLifecycleAction(classified, {});
  const again = bookingLifecycleAction(classified, { processedEventIds: new Set([first.key]) });
  assert.equal(again.action, null);
  assert.equal(again.duplicate, true);
  // The key is derived, so it is stable across runs.
  assert.equal(first.key, providerEventKey('ev1', AT));
  assert.equal(bookingLifecycleAction(classified, {}).key, first.key);
});

test('19. a booking stops incompatible stage sequences through the existing condition', () => {
  const { evaluateStageSequence, SEQUENCE_EVENTS } = require('../integrations/stage-sequences');
  const enrolled = { eventType: SEQUENCE_EVENTS.ENROLLED, occurredAt: '2026-08-20T10:00:00.000Z', metadata: JSON.stringify({ sequenceId: 'hot_stale_v1' }) };
  const booked = { eventType: 'call_booked', occurredAt: '2026-08-26T10:00:00.000Z', metadata: '{}' };
  const verdict = evaluateStageSequence({
    boardLead: { stage: 'hot' }, activities: [enrolled, booked], featureEnabled: true, now: new Date('2026-08-27T19:00:00.000Z'),
  });
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.stopReason, 'a meeting was booked');
  // A Google booking writes the SAME call_booked event, so no stop logic is duplicated.
  assert.ok(!/stopReason|sequence_/.test(calSrc), 'the calendar module owns no stop logic');
});

// ── RESCHEDULE (20–24) ──────────────────────────────────────────────────────

test('20/21/22. a moved booking becomes Rescheduled and points at the new time', () => {
  const moved = bookingLifecycleAction(classifyCalendarEvent(gEvent({ start: { dateTime: LATER }, end: { dateTime: LATER } }), opts), { meetingAt: AT });
  assert.equal(moved.action, 'reschedule');
  assert.equal(moved.meetingAt, LATER);
  assert.equal(moved.previousMeetingAt, AT, 'the old time is preserved');
  // Through the canonical lifecycle the new time is authoritative.
  const acts = [
    { eventType: 'call_booked', occurredAt: '2026-08-01T10:00:00.000Z', metadata: JSON.stringify({ meetingAt: AT }) },
    { eventType: 'meeting_rescheduled', occurredAt: '2026-08-02T10:00:00.000Z', metadata: JSON.stringify({ meetingAt: LATER, previousMeetingAt: AT }) },
  ];
  const life = deriveCallLifecycle({ meetingAt: LATER }, { activities: acts, now: new Date('2026-08-27T19:00:00.000Z') });
  assert.equal(life.status, CALL_STATUS.RESCHEDULED);
  assert.equal(life.previousMeetingAt, AT);
  const action = deriveNextAction({ stage: 'call_booked', meetingAt: LATER }, null, { activities: acts, now: new Date('2026-08-27T19:00:00.000Z') });
  assert.equal(action.type, ACTION_TYPE.SALES_CALL);
  assert.equal(action.dueAt, LATER);
});

test('23/24. an unchanged time is not a reschedule, and the old time stops nagging', () => {
  // Same instant expressed with a different offset must not look like a move.
  const same = bookingLifecycleAction(classifyCalendarEvent(gEvent({
    start: { dateTime: '2026-09-02T10:00:00-07:00' }, end: { dateTime: AT },
  }), opts), { meetingAt: AT });
  assert.equal(same.action, null);
  assert.equal(same.unchanged, true);
  assert.equal(sameInstant('2026-09-02T10:00:00-07:00', AT), true, 'compared as instants, not strings');
  assert.equal(sameInstant('not-a-date', AT), false);
  // A title-only edit is likewise not a reschedule.
  const titleEdit = bookingLifecycleAction(classifyCalendarEvent(gEvent({ summary: 'Renamed' }), opts), { meetingAt: AT });
  assert.equal(titleEdit.action, null);
});

// ── CANCELLATION (25–29) ────────────────────────────────────────────────────

test('25/26/27/28. a cancelled Google event maps to Cancelled and closes nothing', () => {
  const c = classifyCalendarEvent(gEvent({ status: 'cancelled' }), opts);
  assert.equal(c.decision, BOOKING_DECISION.CANCELLED);
  // A cancellation only acts on an event this CRM actually booked — Google
  // strips the appointment marker on delete, so our own record is the guard.
  const booked = new Set([providerEventKey('ev1', AT)]);
  const action = bookingLifecycleAction(c, { meetingAt: AT, processedEventIds: booked });
  assert.equal(action.action, 'cancel');
  // Through the canonical lifecycle: cancelled, not lost.
  const acts = [
    { eventType: 'call_booked', occurredAt: '2026-08-01T10:00:00.000Z', metadata: JSON.stringify({ meetingAt: AT }) },
    { eventType: 'meeting_cancelled', occurredAt: '2026-08-02T10:00:00.000Z', metadata: JSON.stringify({ meetingAt: AT }) },
  ];
  const now = new Date('2026-09-20T19:00:00.000Z');
  const life = deriveCallLifecycle({ meetingAt: AT }, { activities: acts, now });
  assert.equal(life.status, CALL_STATUS.CANCELLED);
  const next = deriveNextAction({ stage: 'call_booked', meetingAt: AT }, null, { activities: acts, now });
  assert.equal(next.type, ACTION_TYPE.CALL_CANCELLED_REVIEW);
  assert.equal(next.owner, ACTION_OWNER.HUMAN);
  assert.notEqual(next.type, ACTION_TYPE.NONE_LOST);
  // The module never closes an opportunity or touches a hold.
  assert.ok(!/closed_lost|ghosted|MANUAL_HOLD/.test(calSrc));
});

test('29. a cancellation retry dedupes, and a cancel with nothing booked is a no-op', () => {
  const c = classifyCalendarEvent(gEvent({ status: 'cancelled' }), opts);
  const first = bookingLifecycleAction(c, { meetingAt: AT });
  assert.equal(bookingLifecycleAction(c, { meetingAt: AT, processedEventIds: new Set([first.key]) }).duplicate, true);
  assert.equal(bookingLifecycleAction(c, {}).action, null, 'nothing to cancel');
});

// ── PAST MEETINGS (30–32) ───────────────────────────────────────────────────

test('30/31/32. a past Google booking is never auto-completed or auto-no-showed', () => {
  const past = '2026-08-20T17:00:00.000Z';
  const acts = [{ eventType: 'call_booked', occurredAt: '2026-08-01T10:00:00.000Z', metadata: JSON.stringify({ meetingAt: past }) }];
  const life = deriveCallLifecycle({ meetingAt: past }, { activities: acts, now: new Date('2026-08-27T19:00:00.000Z') });
  assert.equal(life.status, CALL_STATUS.OUTCOME_PENDING);
  assert.notEqual(life.status, CALL_STATUS.COMPLETED);
  assert.notEqual(life.status, CALL_STATUS.NO_SHOW);
  // The calendar module can never emit those actions at all.
  assert.ok(!/'complete'|'no_show'|meeting_completed|meeting_no_show/.test(calSrc),
    'Google cannot prove attendance, so it never resolves a meeting');
});

// ── SYNC (33–39) ────────────────────────────────────────────────────────────

test('33/34/35. the checkpoint advances only after a completed sync', () => {
  const prev = { syncToken: 'TOK1', needsFullSync: false };
  // Failure: token untouched, so the same window is retried.
  const failed = nextSyncState(prev, { ok: false, error: 'network down' });
  assert.equal(failed.syncToken, 'TOK1');
  assert.match(failed.lastError, /network down/);
  // A partial page walk must not look like a finished sync.
  assert.equal(nextSyncState(prev, { ok: true, complete: false }).syncToken, 'TOK1');
  // Success advances.
  const ok = nextSyncState(prev, { ok: true, complete: true, nextSyncToken: 'TOK2', at: 'now' });
  assert.equal(ok.syncToken, 'TOK2');
  assert.equal(ok.lastError, null);
  // The fetcher only reports complete after the page loop finishes.
  const fetcher = server.slice(server.indexOf('async function fetchCalendarChanges'), server.indexOf('async function planCalendarBookings'));
  assert.match(fetcher, /\} while \(pageToken\);/);
  assert.match(fetcher, /return \{ ok: true, complete: true/);
  assert.match(fetcher, /return \{ ok: false, error: error\.message/);
});

test('36/37. an expired sync token triggers a safe full resync without duplicates', () => {
  const reset = nextSyncState({ syncToken: 'OLD' }, { ok: true, tokenInvalid: true });
  assert.equal(reset.syncToken, null);
  assert.equal(reset.needsFullSync, true);
  assert.match(reset.lastError, /410/);
  // 410 is the documented signal, handled explicitly.
  const fetcher = server.slice(server.indexOf('async function fetchCalendarChanges'), server.indexOf('async function planCalendarBookings'));
  assert.match(fetcher, /Number\(status\) === 410/);
  assert.match(fetcher, /tokenInvalid: true/);
  // A resync replays old events, but the derived keys make them no-ops.
  const classified = classifyCalendarEvent(gEvent(), opts);
  const key = bookingLifecycleAction(classified, {}).key;
  assert.equal(bookingLifecycleAction(classified, { processedEventIds: new Set([key]) }).duplicate, true);
});

test('38/39. the gate is off and the dry run mutates nothing', () => {
  assert.match(server, /const CALENDAR_SYNC_ENABLED = process\.env\.GOOGLE_CALENDAR_BOOKING_SYNC_ENABLED === 'true';/);
  assert.notEqual(process.env.GOOGLE_CALENDAR_BOOKING_SYNC_ENABLED, 'true', 'the flag must not be on in this environment');
  // It is not coupled to sending.
  assert.ok(!/GOOGLE_CALENDAR_BOOKING_SYNC_ENABLED[^\n]*SENDING_ENABLED/.test(server));
  // The dry run writes nothing — not even the sync checkpoint.
  const route = server.slice(server.indexOf("app.get('/api/integrations/google-calendar/dry-run'"));
  const body = route.slice(0, route.indexOf('\n});'));
  assert.ok(!/writeCalendarSyncState|values\.update|values\.append|appendColdCallActivities/.test(body),
    'the dry run performs no write');
  assert.match(body, /dryRun: true/);
  assert.match(body, /GOOGLE_BOOKING_CALENDAR_ID is not set/, 'missing config is reported, not guessed around');
});

test('every application-owned live automation launch observes Calendar first and fails closed', () => {
  const guard = server.slice(server.indexOf('async function observeCalendarBeforeAutomation'),
    server.indexOf('// Read-only preview: what WOULD happen if sync were enabled'));
  assert.match(guard, /await calendarObservationInFlight/);
  assert.match(guard, /result\.ok !== true/);
  assert.match(guard, /return \{ ok: false, launched: false, reason \}/);

  const manual = server.slice(server.indexOf("app.post('/api/agent/run'"), server.indexOf("app.post('/api/agent/stop'"));
  assert.ok(manual.indexOf("launchAutomationAfterCalendar('manual live outreach run'") < manual.indexOf('spawnAgent(false)'));
  const scheduled = server.slice(server.indexOf("cron.schedule('0,30 8-11"), server.indexOf("cron.schedule('15,45"));
  assert.ok(scheduled.indexOf("launchAutomationAfterCalendar('scheduled outreach run'") < scheduled.indexOf('spawnAgent(false'));
  const intent = server.slice(server.indexOf('function spawnAgentIntentOnly'), server.indexOf('function spawnAgentCheckOnly'));
  assert.ok(intent.indexOf('launchAutomationAfterCalendar') < intent.indexOf('startAgentProcess'));
  const queued = server.slice(server.indexOf("child.on('exit'"), server.indexOf('function spawnAgent(dryRun'));
  assert.match(queued, /launchAutomationAfterCalendar[\s\S]*spawnAgent\(false/);
});

// ── ARCHITECTURE / REGRESSION ───────────────────────────────────────────────

test('40. manual booking still works and is untouched', () => {
  assert.match(server, /app\.post\('\/api\/leads\/:id\/call-lifecycle', requireAuth/);
  const route = server.slice(server.indexOf("app.post('/api/leads/:id/call-lifecycle'"));
  const body = route.slice(0, route.indexOf('\n});'));
  assert.ok(!/google|calendar|providerEvent/i.test(body), 'the manual path has no Google dependency');
});

test('the calendar module is pure and the browser does no provider parsing', () => {
  // The orchestrator awaits injected adapters, but the module itself imports no
  // provider/Sheets client and performs no direct network or filesystem I/O.
  assert.ok(!/require\(['"](?:googleapis|node:fs|node:https|axios)|sheets\(|google\.|globalThis\.fetch\(/.test(calSrc),
    'the module performs no direct I/O');
  assert.ok(!/gcal|calendarId|providerEventId|eventType/i.test(
    browser.slice(browser.indexOf('// ── CALL LIFECYCLE'), browser.indexOf('// ── MARK GHOSTED'))),
    'the browser receives canonical lifecycle state only');
});

test('35(secrets). no token or credential is ever logged', () => {
  const block = server.slice(server.indexOf('// ── GOOGLE CALENDAR BOOKING SYNC'), server.indexOf('// ── STAGE SEQUENCES'));
  assert.ok(!/console\.log\([^)]*(?:syncToken|access_token|refresh_token|private_key|GOOGLE_SERVICE_ACCOUNT_JSON)/.test(block));
  assert.ok(!/console\.[a-z]+\([^)]*credentials/.test(block));
  // The calendar client requests a READ-ONLY scope.
  assert.match(server, /'https:\/\/www\.googleapis\.com\/auth\/calendar\.readonly'/);
});

// ─────────────────────────────────────────────────────────────────────────────
// APPOINTMENT-SCHEDULE MARKER
// Shapes below are the REAL shapes observed on the live booking calendar
// (deins@scalelabai.ca, read-only inspection). The whole point of this block is
// that the three events are structurally identical: timed, eventType default,
// not recurring, organiser self, exactly one external attendee. Only the
// Google-set marker separates the booking from the two manual meetings.
// ─────────────────────────────────────────────────────────────────────────────
const CAL_ID = 'deins@scalelabai.ca';
const calOpts = { ownerEmails: new Set([CAL_ID]), bookingCalendarId: CAL_ID, calendarId: CAL_ID };

// The genuine Appointment Schedule booking.
const REAL_BOOKING = {
  id: '40e35g55lk7331qkf6b6mp6v7c',
  status: 'confirmed',
  eventType: 'default',
  summary: 'Discovery Call (deins ulmanis)',
  start: { dateTime: '2026-08-28T07:00:00-07:00', timeZone: 'America/Vancouver' },
  end: { dateTime: '2026-08-28T07:30:00-07:00', timeZone: 'America/Vancouver' },
  organizer: { email: CAL_ID, self: true },
  creator: { email: CAL_ID },
  attendees: [
    { email: CAL_ID, self: true, organizer: true, responseStatus: 'accepted' },
    { email: 'deins@tryscalelabai.ca', responseStatus: 'accepted' },
  ],
  extendedProperties: {
    shared: { 'goo.createdByAvailId': '4mnrij3fq82cid8tk4bbks2isl', 'goo.createdBySet': 'default_cita' },
  },
};

// A real manually-created one-to-one. Structurally a booking in every way.
const REAL_MANUAL_MEETING = {
  id: '5mpmao82jk29tfre8t4193or90',
  status: 'confirmed',
  eventType: 'default',
  summary: 'SureSky inc. Discovery call',
  start: { dateTime: '2026-08-20T09:00:00-07:00', timeZone: 'America/Vancouver' },
  end: { dateTime: '2026-08-20T09:30:00-07:00', timeZone: 'America/Vancouver' },
  organizer: { email: CAL_ID, self: true },
  creator: { email: CAL_ID },
  attendees: [
    { email: CAL_ID, self: true, organizer: true, responseStatus: 'accepted' },
    { email: 'contact@suresky.example', responseStatus: 'needsAction' },
  ],
  hangoutLink: 'https://meet.google.com/aaa-bbbb-ccc',
};

test('real manual one-to-one is NOT treated as a booking', () => {
  const result = classifyCalendarEvent(REAL_MANUAL_MEETING, calOpts);
  assert.equal(result.decision, BOOKING_DECISION.IGNORED);
  assert.match(result.reason, /appointment-schedule marker/);
});

test('real appointment-schedule booking IS treated as a booking', () => {
  const result = classifyCalendarEvent(REAL_BOOKING, calOpts);
  assert.equal(result.decision, BOOKING_DECISION.BOOKED);
  assert.equal(result.attendeeEmail, 'deins@tryscalelabai.ca');
  assert.equal(result.appointmentScheduleId, '4mnrij3fq82cid8tk4bbks2isl');
});

test('booking and manual meeting differ ONLY by the marker, proving the marker is what decides', () => {
  // Strip the marker off the real booking: it must stop being a booking.
  const stripped = { ...REAL_BOOKING, extendedProperties: undefined };
  assert.equal(classifyCalendarEvent(stripped, calOpts).decision, BOOKING_DECISION.IGNORED);
  // Add the marker to the real manual meeting: it must become one.
  const marked = { ...REAL_MANUAL_MEETING, extendedProperties: REAL_BOOKING.extendedProperties };
  assert.equal(classifyCalendarEvent(marked, calOpts).decision, BOOKING_DECISION.BOOKED);
});

test('detector ignores event title entirely — a booking-sounding title is not enough', () => {
  const bait = { ...REAL_MANUAL_MEETING, summary: 'Discovery Call (deins ulmanis)' };
  assert.equal(classifyCalendarEvent(bait, calOpts).decision, BOOKING_DECISION.IGNORED);
  // ...and a booking with an unrelated title is still a booking.
  const odd = { ...REAL_BOOKING, summary: 'lunch' };
  assert.equal(classifyCalendarEvent(odd, calOpts).decision, BOOKING_DECISION.BOOKED);
});

test('a booking from a DIFFERENT appointment schedule on the same calendar is ignored', () => {
  const other = {
    ...REAL_BOOKING,
    extendedProperties: { shared: { 'goo.createdByAvailId': 'some-other-schedule', 'goo.createdBySet': 'default_cita' } },
  };
  const result = classifyCalendarEvent(other, { ...calOpts, appointmentScheduleId: '4mnrij3fq82cid8tk4bbks2isl' });
  assert.equal(result.decision, BOOKING_DECISION.IGNORED);
  assert.match(result.reason, /different appointment schedule/);
  // Unconfigured, any schedule on the booking calendar is accepted.
  assert.equal(classifyCalendarEvent(other, calOpts).decision, BOOKING_DECISION.BOOKED);
});

test('cancelling a manual meeting cannot cancel a real booking (marker is stripped on delete)', () => {
  // Google strips extendedProperties from cancelled events, so a cancelled
  // manual meeting is indistinguishable from a cancelled booking.
  const cancelledManual = { id: REAL_MANUAL_MEETING.id, status: 'cancelled' };
  const classified = classifyCalendarEvent(cancelledManual, calOpts);
  assert.equal(classified.decision, BOOKING_DECISION.CANCELLED);

  // The lead has a real meeting on record, booked via a DIFFERENT event.
  const processed = new Set([providerEventKey(REAL_BOOKING.id, '2026-08-28T07:00:00-07:00')]);
  const action = bookingLifecycleAction(classified, { meetingAt: '2026-08-28T07:00:00-07:00', processedEventIds: processed });
  assert.equal(action.action, null, 'must not cancel a booking we did not make');
  assert.match(action.reason, /never booked this event/);
});

test('cancelling an event the CRM DID book still cancels', () => {
  const classified = classifyCalendarEvent({ id: REAL_BOOKING.id, status: 'cancelled' }, calOpts);
  const processed = new Set([providerEventKey(REAL_BOOKING.id, '2026-08-28T07:00:00-07:00')]);
  const action = bookingLifecycleAction(classified, { meetingAt: '2026-08-28T07:00:00-07:00', processedEventIds: processed });
  assert.equal(action.action, 'cancel');
});

// ─────────────────────────────────────────────────────────────────────────────
// REAL RESCHEDULE (observed on the live calendar, read-only)
// Google rescheduled the genuine Appointment Schedule booking IN PLACE: same
// event id, same iCalUID, sequence 0 -> 1, start moved 07:00 -> 07:30. No
// replacement event was created and no cancellation was emitted — the event
// count on the calendar was identical before and after.
// ─────────────────────────────────────────────────────────────────────────────
const SCHEDULE_ID = '4mnrij3fq82cid8tk4bbks2isl';
const BOOKED_AT = '2026-08-28T07:00:00-07:00';
const MOVED_AT = '2026-08-28T07:30:00-07:00';

// The SAME event, after Google applied the reschedule.
const REAL_RESCHEDULED = {
  ...REAL_BOOKING,
  updated: '2026-08-27T20:04:23.399Z',
  sequence: 1,
  start: { dateTime: MOVED_AT, timeZone: 'America/Vancouver' },
  end: { dateTime: '2026-08-28T08:00:00-07:00', timeZone: 'America/Vancouver' },
};

const pinnedOpts = { ...calOpts, appointmentScheduleId: SCHEDULE_ID };

test('the rescheduled appointment-schedule event is still recognised as a booking', () => {
  const result = classifyCalendarEvent(REAL_RESCHEDULED, pinnedOpts);
  assert.equal(result.decision, BOOKING_DECISION.BOOKED);
  assert.equal(result.meetingAt, MOVED_AT);
  assert.equal(result.attendeeEmail, 'deins@tryscalelabai.ca');
});

test('the appointment schedule id survives the reschedule byte-identically', () => {
  const before = classifyCalendarEvent(REAL_BOOKING, calOpts);
  const after = classifyCalendarEvent(REAL_RESCHEDULED, calOpts);
  assert.equal(before.appointmentScheduleId, SCHEDULE_ID);
  assert.equal(after.appointmentScheduleId, SCHEDULE_ID);
  // Identity is preserved too: Google mutated in place rather than replacing.
  assert.equal(after.event.providerEventId, before.event.providerEventId);
  assert.equal(after.event.iCalUID, before.event.iCalUID);
});

test('a booking from a different appointment schedule is rejected when pinned', () => {
  const foreign = {
    ...REAL_RESCHEDULED,
    extendedProperties: { shared: { 'goo.createdByAvailId': 'not-my-schedule', 'goo.createdBySet': 'default_cita' } },
  };
  const result = classifyCalendarEvent(foreign, pinnedOpts);
  assert.equal(result.decision, BOOKING_DECISION.IGNORED);
  assert.match(result.reason, /different appointment schedule/);
});

test('strict detection fails closed when no schedule id is configured', () => {
  const result = classifyCalendarEvent(REAL_RESCHEDULED, { ...calOpts, requireAppointmentScheduleId: true });
  assert.equal(result.decision, BOOKING_DECISION.IGNORED);
  assert.match(result.reason, /requires a configured appointment schedule id/);
});

test('the real reschedule produces exactly one reschedule — no cancel, no duplicate book', () => {
  // The CRM already recorded the original booking.
  const processed = new Set([providerEventKey(REAL_BOOKING.id, BOOKED_AT)]);
  const classified = classifyCalendarEvent(REAL_RESCHEDULED, pinnedOpts);
  const action = bookingLifecycleAction(classified, { meetingAt: BOOKED_AT, processedEventIds: processed });

  assert.equal(action.action, 'reschedule');
  assert.equal(action.previousMeetingAt, BOOKED_AT);
  assert.equal(action.meetingAt, MOVED_AT);
  assert.notEqual(action.action, 'cancel');
  assert.notEqual(action.action, 'book');
});

test('the reschedule never emits a cancellation for the old occurrence', () => {
  // Google emitted NO cancelled event for the old time — the calendar returned
  // the same 7 cancellations before and after. Nothing in the reschedule path
  // can therefore produce a cancel, and eventWasBooked is not even reached.
  const processed = new Set([providerEventKey(REAL_BOOKING.id, BOOKED_AT)]);
  const classified = classifyCalendarEvent(REAL_RESCHEDULED, pinnedOpts);
  assert.notEqual(classified.decision, BOOKING_DECISION.CANCELLED);
  assert.equal(bookingLifecycleAction(classified, { meetingAt: BOOKED_AT, processedEventIds: processed }).action, 'reschedule');
});

test('reprocessing the same reschedule is a no-op', () => {
  const processed = new Set([providerEventKey(REAL_BOOKING.id, BOOKED_AT)]);
  const classified = classifyCalendarEvent(REAL_RESCHEDULED, pinnedOpts);
  const first = bookingLifecycleAction(classified, { meetingAt: BOOKED_AT, processedEventIds: processed });
  assert.equal(first.action, 'reschedule');

  // The writer would record this key; the next sync sees the same event again.
  processed.add(first.key);
  const second = bookingLifecycleAction(classified, { meetingAt: MOVED_AT, processedEventIds: processed });
  assert.equal(second.action, null);
  assert.ok(second.duplicate);
});

test('the rescheduled booking yields one live meeting at the NEW time, and the old time cannot go overdue', () => {
  const timeline = [
    { eventType: 'call_booked', occurredAt: '2026-08-27T19:54:08.000Z', metadata: JSON.stringify({ meetingAt: BOOKED_AT }) },
    { eventType: 'meeting_rescheduled', occurredAt: '2026-08-27T20:04:23.399Z', metadata: JSON.stringify({ meetingAt: MOVED_AT, previousMeetingAt: BOOKED_AT }) },
  ];
  const lead = { stage: 'call_booked', meetingAt: MOVED_AT };
  // 07:15 Vancouver: past the ORIGINAL time, before the new one.
  const now = new Date('2026-08-28T14:15:00.000Z');
  const life = deriveCallLifecycle(lead, { activities: timeline, now });
  assert.equal(life.status, CALL_STATUS.RESCHEDULED);
  assert.equal(life.meetingAt, MOVED_AT);

  const next = deriveNextAction(lead, null, { activities: timeline, now });
  assert.equal(next.dueAt, MOVED_AT, 'the next action must point at the new time');
  assert.ok(!next.overdue, 'the superseded time must not make the lead overdue');
});

test('no title, attendee-name or company text matching exists in the detector', () => {
  // Guards against a future weakening of the deterministic marker rule.
  const from = calSrc.indexOf('function classifyCalendarEvent');
  // Just the classifier body, not the whole tail of the file.
  const detector = calSrc.slice(from, calSrc.indexOf('\n}', from));
  const code = detector.replace(/\/\/.*$/gm, '');            // strip comments
  const logic = code.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "''"); // strip message strings
  // The title is never read at all.
  assert.ok(!/summary/.test(code), 'classification must never read the event title');
  // The attendee name is only ever COPIED OUT, never branched on.
  const nameUses = logic.split('\n').filter(line => /displayName/.test(line));
  assert.deepEqual(nameUses.map(l => l.trim()), ['attendeeName: booker.displayName,'],
    'attendee names may be reported, never used to decide');
  // No fuzzy text predicates anywhere in the decision path.
  // The ONE allowed membership check is against Google's closed eventType enum.
  const predicates = logic.split('\n')
    .filter(line => /\.(includes|match|test|indexOf|startsWith|endsWith)\s*\(/.test(line))
    .map(line => line.trim());
  assert.deepEqual(predicates, ['if (IGNORED_EVENT_TYPES.includes(normalized.eventType)) {'],
    'the only pattern check may be the eventType enum — no text matching');
});

// ─────────────────────────────────────────────────────────────────────────────
// CANCELLATION AFTER A REAL BOOKED -> RESCHEDULED LIFECYCLE
//
// IMPORTANT EVIDENCE NOTE: whether Google preserves the appointment marker on a
// cancelled appointment-schedule booking is UNVERIFIED. The seven cancellations
// on the live calendar all lack it, but none of them was ever an
// appointment-schedule booking (none carries extendedProperties.shared at all),
// so they prove nothing either way. These tests therefore pin BOTH payload
// shapes, so the integration is correct whichever Google does.
// ─────────────────────────────────────────────────────────────────────────────

// Cancelled with everything stripped — the minimal payload Google may send.
const CANCELLED_STRIPPED = { id: REAL_BOOKING.id, status: 'cancelled', sequence: 2 };

// Cancelled with the full payload retained, marker included.
const CANCELLED_FULL = {
  ...REAL_RESCHEDULED, status: 'cancelled', sequence: 2,
};

// The CRM has booked, then rescheduled, this event.
const bookedThenRescheduled = () => new Set([
  providerEventKey(REAL_BOOKING.id, BOOKED_AT),
  providerEventKey(REAL_BOOKING.id, MOVED_AT),
]);

for (const [label, payload] of [['stripped', CANCELLED_STRIPPED], ['full', CANCELLED_FULL]]) {
  test(`a cancelled booking (${label} payload) produces exactly one cancel`, () => {
    const classified = classifyCalendarEvent(payload, { ...pinnedOpts, requireAppointmentScheduleId: true });
    assert.equal(classified.decision, BOOKING_DECISION.CANCELLED);
    // The meeting on record is the RESCHEDULED occurrence, not the original.
    const action = bookingLifecycleAction(classified, {
      meetingAt: MOVED_AT, processedEventIds: bookedThenRescheduled(),
    });
    assert.equal(action.action, 'cancel');
    for (const forbidden of ['reschedule', 'book', 'complete', 'no_show']) {
      assert.notEqual(action.action, forbidden);
    }
  });

  test(`reprocessing the cancellation (${label} payload) is a no-op`, () => {
    const processed = bookedThenRescheduled();
    const classified = classifyCalendarEvent(payload, pinnedOpts);
    const first = bookingLifecycleAction(classified, { meetingAt: MOVED_AT, processedEventIds: processed });
    assert.equal(first.action, 'cancel');
    processed.add(first.key);
    const second = bookingLifecycleAction(classified, { meetingAt: MOVED_AT, processedEventIds: processed });
    assert.equal(second.action, null);
    assert.ok(second.duplicate);
  });
}

test('strict schedule pinning never blocks a cancellation, even with the marker gone', () => {
  // The cancellation branch is evaluated BEFORE any marker or schedule check,
  // so a stripped cancelled payload survives strict mode. This is the whole
  // reason cancellations are validated against our own record instead.
  const strict = { ...calOpts, appointmentScheduleId: SCHEDULE_ID, requireAppointmentScheduleId: true };
  const classified = classifyCalendarEvent(CANCELLED_STRIPPED, strict);
  assert.equal(classified.decision, BOOKING_DECISION.CANCELLED);
  assert.equal(classified.event.appointmentScheduleId, '', 'no marker on this payload');
  const action = bookingLifecycleAction(classified, { meetingAt: MOVED_AT, processedEventIds: bookedThenRescheduled() });
  assert.equal(action.action, 'cancel', 'prior provider identity is what makes this trustworthy');
});

test('an unrelated cancelled meeting is never trusted, even when everything else lines up', () => {
  // Same attendee, same day, same structure, and the lead really does have a
  // live booking. Only the provider identity differs.
  const lookalike = {
    id: '5mpmao82jk29tfre8t4193or90', status: 'cancelled', sequence: 1,
    start: { dateTime: MOVED_AT }, end: { dateTime: '2026-08-28T08:00:00-07:00' },
    organizer: { email: CAL_ID, self: true },
    attendees: [{ email: CAL_ID, self: true, organizer: true }, { email: 'deins@tryscalelabai.ca' }],
    summary: 'Discovery Call (deins ulmanis)',   // deliberately identical title
  };
  const classified = classifyCalendarEvent(lookalike, pinnedOpts);
  const action = bookingLifecycleAction(classified, {
    meetingAt: MOVED_AT, processedEventIds: bookedThenRescheduled(),
  });
  assert.equal(action.action, null);
  assert.match(action.reason, /never booked this event/);
});

test('the cancellation resolves the RESCHEDULED occurrence, not the superseded one', () => {
  const timeline = [
    { eventType: 'call_booked', occurredAt: '2026-08-27T19:54:08.000Z', metadata: JSON.stringify({ meetingAt: BOOKED_AT }) },
    { eventType: 'meeting_rescheduled', occurredAt: '2026-08-27T20:04:23.399Z', metadata: JSON.stringify({ meetingAt: MOVED_AT, previousMeetingAt: BOOKED_AT }) },
    { eventType: 'meeting_cancelled', occurredAt: '2026-08-27T20:30:00.000Z', metadata: JSON.stringify({ meetingAt: MOVED_AT }) },
  ];
  const lead = { stage: 'call_booked', meetingAt: MOVED_AT };
  // Well past BOTH the original and the rescheduled time.
  const now = new Date('2026-08-29T10:00:00.000Z');
  const life = deriveCallLifecycle(lead, { activities: timeline, now });
  assert.equal(life.status, CALL_STATUS.CANCELLED);
  assert.equal(life.meetingAt, MOVED_AT);

  const next = deriveNextAction(lead, null, { activities: timeline, now });
  assert.equal(next.type, ACTION_TYPE.CALL_CANCELLED_REVIEW);
  assert.equal(next.label, 'Decide next step after cancelled call');
  assert.equal(next.owner, ACTION_OWNER.HUMAN);
  assert.ok(next.needsAttention);
  // A cancelled call must never nag as an overdue outcome, nor still ask for a call.
  assert.ok(!next.overdue);
  assert.notEqual(next.type, ACTION_TYPE.SALES_CALL);
});
