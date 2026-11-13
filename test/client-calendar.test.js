'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  clientCalendarConfig, classifyClientEvent, planClientEvent, createClientCalendarSync,
} = require('../integrations/clients/client-calendar');
const { calendarSyncClientIds } = require('../integrations/clients/email-scope');
const { createMemoryLedgerStore } = require('../integrations/clients/ledger-store');
const ledger = require('../integrations/clients/ledger');
const { activateJoleForTest } = require('../test-support/client-lifecycle');

let restoreActivation;
test.before(() => { restoreActivation = activateJoleForTest(); });
test.after(() => restoreActivation());

const JORGE = 'jorge@jolebtxgroup.com';
const SCHEDULE = 'AcZssZ-jole-schedule';
const ENV = { JOLE_CALENDAR_SYNC_ENABLED: 'true', JOLE_BOOKING_CALENDAR_ID: JORGE, JOLE_BOOKING_APPOINTMENT_SCHEDULE_ID: SCHEDULE };

const joleLead = (id, email, extra = {}) => ({
  id, company: 'Gulf Fab Works LLC', contactName: 'Dana Ops', email,
  leadNiche: 'jole_employer', emailTemplateId: 'jole-industrial-employer-v1', intendedCampaignVersion: 'jole-btx-employer-acquisition',
  campaign: 'jole-btx-employer-acquisition', senderInboxId: '', tradeType: '', ...extra,
});
const scalelabLead = { id: 'sl-1', email: 'owner@staffco-test.invalid', leadNiche: 'staffing', emailTemplateId: 'staffing-v1', company: 'StaffCo' };
const LEADS = [
  joleLead('jl-1', 'dana@gulffab-test.invalid'),
  joleLead('jl-2', 'sam@harborship-test.invalid', { company: 'Harbor Ship', contactName: 'Sam Lee' }),
  scalelabLead,
];

function gEvent({ id = 'evt1', start = '2026-11-20T16:00:00Z', attendees = ['dana@gulffab-test.invalid'], booking = true,
  schedule = SCHEDULE, status = 'confirmed', organizer = JORGE, created = '2026-11-13T18:00:00Z', summary = 'Intro call', ...rest } = {}) {
  return {
    id, status, summary, created, updated: created, htmlLink: `https://calendar.google.com/event?eid=${id}`,
    start: { dateTime: start }, end: { dateTime: new Date(Date.parse(start) + 1800000).toISOString() },
    organizer: { email: organizer, self: organizer === JORGE },
    attendees: [{ email: JORGE, self: true, organizer: organizer === JORGE }, ...attendees.map(email => ({ email, responseStatus: 'accepted' }))],
    ...(booking ? { extendedProperties: { shared: { 'goo.createdByAvailId': schedule, 'goo.createdBySet': 'default_cita' } } } : {}),
    ...rest,
  };
}

function harness({ env = ENV, leads = LEADS, events = [] } = {}) {
  const store = createMemoryLedgerStore();
  let state = {};
  const queue = events.length ? [events] : [];
  const writes = [];
  const service = createClientCalendarSync({
    clientId: 'jole', env,
    fetchChanges: async () => ({ ok: true, complete: true, events: queue.shift() || [], nextSyncToken: `tok-${writes.length + 1}` }),
    readState: async () => JSON.parse(JSON.stringify(state)),
    writeState: async next => { state = JSON.parse(JSON.stringify(next)); writes.push(state); },
    loadLeads: async () => leads,
    getStore: () => store,
    now: () => '2026-11-13T19:00:00.000Z',
    log: { info() {}, warn() {}, error() {} },
  });
  return { store, service, writes, get state() { return state; }, push: batch => queue.push(batch) };
}

test('config: Jole declares its own calendar and stays off without the flag', () => {
  const off = clientCalendarConfig('jole', { JOLE_BOOKING_CALENDAR_ID: JORGE });
  assert.equal(off.supported, true);
  assert.equal(off.ready, false);
  assert.match(off.reason, /JOLE_CALENDAR_SYNC_ENABLED is off/);
  assert.deepEqual(off.ownDomains, ['jolebtxgroup.com']);
  assert.equal(clientCalendarConfig('jole', { JOLE_CALENDAR_SYNC_ENABLED: 'true' }).configured, false);
  assert.equal(clientCalendarConfig('scalelab', ENV).supported, false);
});

test('config: Jole leads still never reach the ScaleLab booking sync', () => {
  assert.equal(calendarSyncClientIds().includes('jole'), false);
});

test('classify: own-domain staff, resources and Jorge are never prospects', () => {
  const c = classifyClientEvent(gEvent({ attendees: ['ops@jolebtxgroup.com', 'room@resource.calendar.google.com', 'dana@gulffab-test.invalid'] }),
    clientCalendarConfig('jole', ENV));
  assert.equal(c.kind, 'candidate');
  assert.deepEqual(c.outside.map(a => a.email), ['dana@gulffab-test.invalid']);
});

test('classify: an invite the prospect sent counts the organizer as the outside person', () => {
  const raw = gEvent({ booking: false, organizer: 'dana@gulffab-test.invalid', attendees: [] });
  const c = classifyClientEvent(raw, clientCalendarConfig('jole', ENV));
  assert.equal(c.kind, 'candidate');
  assert.deepEqual(c.outside.map(a => a.email), ['dana@gulffab-test.invalid']);
});

test('plan: a booking-page booking by a Jole lead is recorded', () => {
  const plan = planClientEvent(gEvent(), { leads: LEADS.slice(0, 2), meetings: [], state: {}, config: clientCalendarConfig('jole', ENV) });
  assert.equal(plan.action, 'record');
  assert.equal(plan.lead.id, 'jl-1');
  assert.equal(plan.scheduledFor, '2026-11-20T16:00:00Z');
});

test('plan: an event with no Jole lead is ignored and never queued for review', () => {
  const plan = planClientEvent(gEvent({ attendees: ['friend@gmail-test.invalid'] }), { leads: LEADS.slice(0, 2), meetings: [], state: {}, config: clientCalendarConfig('jole', ENV) });
  assert.equal(plan.action, 'none');
  assert.equal(plan.item, undefined);
});

test('plan: hand-made, other-schedule and two-lead events go to review', () => {
  const cfg = clientCalendarConfig('jole', ENV);
  const ctx = { leads: LEADS.slice(0, 2), meetings: [], state: {}, config: cfg };
  const manual = planClientEvent(gEvent({ booking: false }), ctx);
  assert.equal(manual.action, 'review');
  assert.match(manual.reason, /by hand or sent as an invite/);
  assert.equal(manual.item.candidates[0].leadId, 'jl-1');
  assert.equal(planClientEvent(gEvent({ schedule: 'other' }), ctx).reason, 'booked through a different booking page');
  const two = planClientEvent(gEvent({ attendees: ['dana@gulffab-test.invalid', 'sam@harborship-test.invalid'] }), ctx);
  assert.equal(two.action, 'review');
  assert.equal(two.item.candidates.length, 2);
});

test('plan: a ScaleLab lead on Jorge\'s calendar is not a Jole meeting', async () => {
  const h = harness({ events: [gEvent({ attendees: ['owner@staffco-test.invalid'] })] });
  const result = await h.service.run();
  assert.equal(result.mutations, 0);
  assert.deepEqual(await h.store.listMeetings('jole'), []);
  assert.deepEqual(h.state.review, {});
});

test('sync: records, then follows reschedule and cancellation of the same event', async () => {
  const h = harness({ events: [gEvent()] });
  const first = await h.service.run();
  assert.equal(first.ok, true);
  assert.equal(first.mutations, 1);
  let [meeting] = await h.store.listMeetings('jole');
  assert.equal(meeting.meeting_status, 'BOOKED');
  assert.equal(meeting.lead_id, 'jl-1');
  assert.equal(meeting.scheduled_for, '2026-11-20T16:00:00.000Z');
  assert.match(meeting.notes, /Google Calendar event evt1/);
  assert.equal(h.state.links.evt1, meeting.meeting_id);
  assert.equal(h.state.syncToken, 'tok-1');

  // Replay of the same event is a no-op.
  h.push([gEvent()]);
  assert.equal((await h.service.run()).mutations, 0);
  assert.equal((await h.store.listMeetings('jole')).length, 1);

  h.push([gEvent({ start: '2026-11-21T17:00:00Z' })]);
  assert.equal((await h.service.run()).mutations, 1);
  [meeting] = await h.store.listMeetings('jole');
  assert.equal(meeting.meeting_status, 'RESCHEDULED');
  assert.equal(meeting.scheduled_for, '2026-11-21T17:00:00.000Z');

  // Google strips cancellations down to the id.
  h.push([{ id: 'evt1', status: 'cancelled' }]);
  assert.equal((await h.service.run()).mutations, 1);
  [meeting] = await h.store.listMeetings('jole');
  assert.equal(meeting.meeting_status, 'CANCELLED');
});

test('sync: a held meeting is never changed by the calendar', async () => {
  const h = harness({ events: [gEvent()] });
  await h.service.run();
  const [meeting] = await h.store.listMeetings('jole');
  await h.store.updateMeeting({ ...meeting, meeting_status: 'HELD', held_at: '2026-11-20T16:30:00.000Z' });
  h.push([{ id: 'evt1', status: 'cancelled' }]);
  assert.equal((await h.service.run()).mutations, 0);
  assert.equal((await h.store.listMeetings('jole'))[0].meeting_status, 'HELD');
});

test('sync: flag off reads nothing; dry run writes nothing', async () => {
  const off = harness({ env: { JOLE_BOOKING_CALENDAR_ID: JORGE }, events: [gEvent()] });
  const skipped = await off.service.run();
  assert.equal(skipped.skipped, true);
  assert.equal(off.writes.length, 0);

  const dry = harness({ events: [gEvent()] });
  const preview = await dry.service.run({ apply: false });
  assert.equal(preview.dryRun, true);
  assert.deepEqual(preview.counts, { record: 1 });
  assert.equal(dry.writes.length, 0);
  assert.deepEqual(await dry.store.listMeetings('jole'), []);
});

test('sync: a failed fetch keeps the checkpoint', async () => {
  const store = createMemoryLedgerStore();
  let state = { syncToken: 'keep-me' };
  const service = createClientCalendarSync({
    clientId: 'jole', env: ENV,
    fetchChanges: async () => ({ ok: false, error: 'forbidden: calendar not shared' }),
    readState: async () => state, writeState: async next => { state = next; },
    loadLeads: async () => LEADS, getStore: () => store, log: { error() {} },
  });
  const result = await service.run();
  assert.equal(result.ok, false);
  assert.equal(state.syncToken, 'keep-me');
  assert.equal(state.lastError, 'forbidden: calendar not shared');
});

test('review: confirm records the meeting and later changes follow it', async () => {
  const h = harness({ events: [gEvent({ id: 'manual1', booking: false })] });
  await h.service.run();
  assert.deepEqual(await h.store.listMeetings('jole'), []);
  const status = await h.service.status();
  assert.equal(status.review.length, 1);
  assert.equal(status.review[0].eventId, 'manual1');

  const confirmed = await h.service.confirm('manual1', { by: 'deins' });
  assert.equal(confirmed.ok, true);
  const [meeting] = await h.store.listMeetings('jole');
  assert.equal(meeting.meeting_status, 'BOOKED');
  assert.equal((await h.service.status()).review.length, 0);

  h.push([gEvent({ id: 'manual1', booking: false, start: '2026-11-22T15:00:00Z' })]);
  await h.service.run();
  assert.equal((await h.store.listMeetings('jole'))[0].scheduled_for, '2026-11-22T15:00:00.000Z');
});

test('review: two leads require a choice; dismissed events never return', async () => {
  const h = harness({ events: [gEvent({ id: 'two', booking: false, attendees: ['dana@gulffab-test.invalid', 'sam@harborship-test.invalid'] })] });
  await h.service.run();
  await assert.rejects(h.service.confirm('two'), { code: 'lead_choice_required' });
  await assert.rejects(h.service.confirm('two', { leadId: 'sl-1' }), { code: 'lead_not_on_event' });
  await h.service.dismiss('two');
  h.push([gEvent({ id: 'two', booking: false, attendees: ['dana@gulffab-test.invalid', 'sam@harborship-test.invalid'], start: '2026-11-25T15:00:00Z' })]);
  await h.service.run();
  assert.equal((await h.service.status()).review.length, 0);
});

test('review: a hand-recorded meeting at the same time is linked, not duplicated', async () => {
  const h = harness({ events: [] });
  await ledger.recordMeetingBooked(h.store, {
    clientId: 'jole', lead: LEADS[0], bookedAt: '2026-11-12T15:00:00Z', scheduledFor: '2026-11-20T16:00:00Z', by: 'operator',
  });
  h.push([gEvent({ id: 'cal1' })]);
  await h.service.run();
  const meetings = await h.store.listMeetings('jole');
  assert.equal(meetings.length, 1);
  assert.equal(h.state.links.cal1, meetings[0].meeting_id);
  // A second event for the same lead, at another time, needs a person.
  h.push([gEvent({ id: 'other', booking: false, start: '2026-12-01T16:00:00Z' })]);
  await h.service.run();
  const review = (await h.service.status()).review;
  assert.equal(review.length, 1);
  assert.match(review[0].reason, /already has a booked meeting/);
  assert.equal((await h.store.listMeetings('jole')).length, 1);
});

test('review: an event that loses its lead or is cancelled leaves the queue', async () => {
  const h = harness({ events: [gEvent({ id: 'm1', booking: false })] });
  await h.service.run();
  assert.equal((await h.service.status()).review.length, 1);
  h.push([{ id: 'm1', status: 'cancelled' }]);
  await h.service.run();
  assert.equal((await h.service.status()).review.length, 0);
});
