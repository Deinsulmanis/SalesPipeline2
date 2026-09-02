'use strict';

// The booked-call journey. Before this, a meeting had exactly two derived
// states — future ("Sales call") and past ("Record call outcome") — and the
// only place to record what happened was the SALES outcome column, whose
// taxonomy lists no_show as a LOSS. Recording a missed meeting therefore made
// the opportunity look dead. Nothing here touches Google or the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  CALL_STATUS, deriveCallLifecycle, callLifecycleActions,
  deriveNextAction, summarizeNextActions, stageTransitionCheck,
  ACTION_TYPE, ACTION_OWNER, ACTION_STATUS,
  LOSS_OUTCOME_IDS, RECOVERABLE_OUTCOME_IDS, MANUAL_HOLD_TAG, HUMAN_OWNED_STAGES,
} = require('../integrations/pipeline-state');
const { buildActivityTimeline } = require('../integrations/activity-timeline');

const root = path.join(__dirname, '..');
// core.autocrlf is on for this repo, so a fresh checkout yields CRLF source.
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
const server = readSource(path.join(root, 'server.js'));
const browser = readSource(path.join(root, 'public', 'index.html'));
const stateSrc = readSource(path.join(root, 'integrations', 'pipeline-state.js'));

function handler() {
  const start = server.indexOf("app.post('/api/leads/:id/call-lifecycle'");
  assert.notEqual(start, -1, 'the route exists');
  const body = server.slice(start);
  return body.slice(0, body.indexOf('\n});'));
}
const route = handler();

// Thu 27 Aug 2026, 12:00 Vancouver.
const NOW = new Date('2026-08-27T19:00:00.000Z');
const FUTURE = '2026-09-02T17:00:00.000Z';
const LATER = '2026-09-09T17:00:00.000Z';
const PAST = '2026-08-20T17:00:00.000Z';

const ev = (eventType, occurredAt, metadata = {}) => ({ eventType, occurredAt, metadata: JSON.stringify(metadata) });
const booked = (at, when = '2026-08-01T10:00:00.000Z') => ev('call_booked', when, { meetingAt: at });
const life = (lead, activities = []) => deriveCallLifecycle(lead, { now: NOW, activities });
const act = (lead, activities = []) => deriveNextAction({ stage: 'call_booked', ...lead }, null, { now: NOW, activities });

// ── 1–8. Booking, scheduled, and the past-meeting rule ──────────────────────

test('1/5. a valid future booking is scheduled and derives Sales call', () => {
  const state = life({ meetingAt: FUTURE }, [booked(FUTURE)]);
  assert.equal(state.status, CALL_STATUS.SCHEDULED);
  assert.equal(state.meetingAt, FUTURE);
  const a = act({ meetingAt: FUTURE }, [booked(FUTURE)]);
  assert.equal(a.type, ACTION_TYPE.SALES_CALL);
  assert.equal(a.owner, ACTION_OWNER.MEETING);
  assert.equal(a.dueAt, FUTURE);
  assert.equal(a.status, ACTION_STATUS.UPCOMING);
});

test('2. booking requires a valid, future meeting time', () => {
  assert.match(route, /A valid meeting date and time is required\./);
  assert.match(route, /A meeting cannot be booked in the past\./);
  assert.match(route, /res\.status\(422\)/);
  // The shared gate still governs the stage itself.
  assert.equal(stageTransitionCheck('call_booked', { meetingAt: '' }).ok, false);
  assert.equal(stageTransitionCheck('call_booked', { meetingAt: FUTURE }).ok, true);
  assert.match(route, /stageTransitionCheck\('call_booked', \{ meetingAt, outcome: lead\.outcome \}\)/);
});

test('3. booking sets Call Booked and holds automation first', () => {
  assert.ok(HUMAN_OWNED_STAGES.includes('call_booked'));
  assert.match(route, /if \(stageRequiresHold\('call_booked'\)\) \{/);
  assert.match(route, /applyManualHold\(req\.params\.id, email\)/);
  assert.ok(route.indexOf('applyManualHold') < route.indexOf('values.batchUpdate'),
    'the hold precedes the write, so a failure leaves a held lead');
  const cells = [...route.matchAll(/range: `\$\{SHEET_NAME\}!([A-Z])\$\{rowNum\}`/g)].map(m => m[1]);
  assert.deepEqual(cells.sort(), ['M', 'U'], 'writes only the stage and the meeting time');
});

test('4. re-booking the same time is a no-op, not a duplicate event', () => {
  assert.match(route, /if \(action === 'book' && meetingAt === previousMeetingAt/);
  assert.match(route, /return res\.json\(\{ ok: true, unchanged: true/);
  const early = route.indexOf('unchanged: true');
  assert.ok(early < route.indexOf('appendColdCallActivities'), 'it returns before recording');
});

test('6. a meeting today is due today, on the business calendar', () => {
  // 2026-08-28T05:00Z is 22:00 on the 27th in Vancouver — still today there.
  const todayLate = '2026-08-28T05:00:00.000Z';
  const a = act({ meetingAt: todayLate }, [booked(todayLate)]);
  assert.equal(a.status, ACTION_STATUS.DUE_TODAY, 'must not read as tomorrow');
  // And an early-hours UTC time on the 27th is still today, not yesterday.
  assert.equal(act({ meetingAt: '2026-08-27T23:00:00.000Z' }, []).status, ACTION_STATUS.DUE_TODAY);
});

test('7/8. a passed meeting is Outcome Pending — never assumed to be a no-show', () => {
  const state = life({ meetingAt: PAST }, [booked(PAST)]);
  assert.equal(state.status, CALL_STATUS.OUTCOME_PENDING);
  assert.equal(state.needsResolution, true);
  assert.notEqual(state.status, CALL_STATUS.NO_SHOW);
  assert.notEqual(state.status, CALL_STATUS.COMPLETED);
  assert.match(state.reason, /a human has to say what happened/);
  const a = act({ meetingAt: PAST }, [booked(PAST)]);
  assert.equal(a.type, ACTION_TYPE.RECORD_CALL_OUTCOME);
  assert.equal(a.owner, ACTION_OWNER.HUMAN);
  assert.equal(a.status, ACTION_STATUS.OVERDUE);
  assert.equal(a.needsAttention, true);
});

// ── 9–12. Reschedule ────────────────────────────────────────────────────────

test('9. rescheduling demands a different, valid, future time', () => {
  assert.match(route, /Choose a different time to reschedule to\./);
  // Only a live call can be moved.
  const allowed = callLifecycleActions(life({ meetingAt: FUTURE }, [booked(FUTURE)]), NOW);
  assert.equal(allowed.reschedule, true);
  const done = callLifecycleActions(life({ meetingAt: PAST }, [booked(PAST), ev('meeting_completed', '2026-08-21T10:00:00.000Z', { meetingAt: PAST })]), NOW);
  assert.equal(done.reschedule, false, 'a completed call cannot be rescheduled');
});

test('10/11/12. a reschedule supersedes the old time but keeps it in history', () => {
  const activities = [booked(PAST), ev('meeting_rescheduled', '2026-08-19T10:00:00.000Z', { meetingAt: FUTURE, previousMeetingAt: PAST })];
  const state = life({ meetingAt: FUTURE }, activities);
  assert.equal(state.status, CALL_STATUS.RESCHEDULED);
  assert.equal(state.meetingAt, FUTURE, 'the new time is current');
  assert.equal(state.previousMeetingAt, PAST, 'the old time survives in state');
  assert.equal(state.rescheduleCount, 1);
  // Next Action points at the NEW time.
  const a = act({ meetingAt: FUTURE }, activities);
  assert.equal(a.type, ACTION_TYPE.SALES_CALL);
  assert.equal(a.dueAt, FUTURE);
  assert.equal(a.status, ACTION_STATUS.UPCOMING, 'the passed old time must not make this overdue');
  // Both events remain on the timeline.
  const titles = buildActivityTimeline({ lead: { id: 'L1' }, activities: activities.map(e => ({ ...e, leadId: 'L1' })) })
    .map(x => x.title);
  assert.ok(titles.includes('Call rescheduled'));
  assert.ok(titles.includes('Call booked'));
});

// ── 13–15. Cancellation ─────────────────────────────────────────────────────

test('13/14/15. cancelling retires the meeting without closing the opportunity', () => {
  const activities = [booked(PAST), ev('meeting_cancelled', '2026-08-19T10:00:00.000Z', { meetingAt: PAST })];
  const state = life({ meetingAt: PAST }, activities);
  assert.equal(state.status, CALL_STATUS.CANCELLED);
  assert.equal(state.needsResolution, false);
  // The old time passing must NOT reopen an outcome prompt.
  assert.notEqual(state.status, CALL_STATUS.OUTCOME_PENDING);
  const a = act({ meetingAt: PAST }, activities);
  assert.equal(a.type, ACTION_TYPE.CALL_CANCELLED_REVIEW);
  assert.equal(a.owner, ACTION_OWNER.HUMAN);
  assert.equal(a.needsAttention, true);
  assert.notEqual(a.type, ACTION_TYPE.RECORD_CALL_OUTCOME);
  // No sales outcome is implied or written.
  assert.equal(state.salesOutcome, '');
  assert.ok(!/closed_lost|ghosted/.test(JSON.stringify(a)));
  assert.match(state.reason, /the opportunity is not closed by this/);
});

// ── 16–18. Completion ───────────────────────────────────────────────────────

test('16/17/18. a completed call is a MEETING result, never a won deal', () => {
  const activities = [booked(PAST), ev('meeting_completed', '2026-08-21T10:00:00.000Z', { meetingAt: PAST })];
  const state = life({ meetingAt: PAST }, activities);
  assert.equal(state.status, CALL_STATUS.COMPLETED);
  assert.equal(state.salesOutcome, '', 'completing the call records no sales outcome');
  const a = act({ meetingAt: PAST }, activities);
  assert.equal(a.type, ACTION_TYPE.RECORD_CALL_OUTCOME);
  assert.equal(a.label, 'Record sales outcome', 'it now asks for the SALES result');
  assert.equal(a.owner, ACTION_OWNER.HUMAN);
  assert.ok(!/closed_won|won/i.test(a.type), 'nothing is won automatically');
  assert.notEqual(a.type, ACTION_TYPE.SALES_CALL, 'and it stops offering the call');
  // Once the sales outcome exists, it stops asking.
  const closed = act({ meetingAt: PAST, outcome: 'not_interested' }, activities);
  assert.equal(closed.type, ACTION_TYPE.CLOSE_OUT_CALL);
});

// ── 19–24. No show ──────────────────────────────────────────────────────────

test('19/20. no-show needs an explicit human action, and only after the time', () => {
  // Before the meeting: not offered.
  assert.equal(callLifecycleActions(life({ meetingAt: FUTURE }, [booked(FUTURE)]), NOW).no_show, false);
  // After: offered.
  assert.equal(callLifecycleActions(life({ meetingAt: PAST }, [booked(PAST)]), NOW).no_show, true);
  // Elapsed time alone never produces it.
  assert.equal(life({ meetingAt: PAST }, [booked(PAST)]).status, CALL_STATUS.OUTCOME_PENDING);
  // The state only appears once the event is recorded by hand. (The action to
  // event map sits just above the route, so this checks the whole file.)
  assert.match(server, /no_show: 'meeting_no_show'/);
  assert.match(route, /trigger: 'crm_call_lifecycle'/);
});

test('21/22/23. a no-show needs attention, closes nothing, and stays recoverable', () => {
  const activities = [booked(PAST), ev('meeting_no_show', '2026-08-21T10:00:00.000Z', { meetingAt: PAST })];
  const state = life({ meetingAt: PAST }, activities);
  assert.equal(state.status, CALL_STATUS.NO_SHOW);
  const a = act({ meetingAt: PAST }, activities);
  assert.equal(a.type, ACTION_TYPE.NO_SHOW_FOLLOW_UP);
  assert.equal(a.label, 'Follow up after no-show');
  assert.equal(a.owner, ACTION_OWNER.HUMAN);
  assert.equal(a.needsAttention, true);
  assert.notEqual(a.type, ACTION_TYPE.NONE_LOST);
  // The SALES outcome column is untouched — and that matters, because no_show
  // is a LOSS value there, so writing it would look like a dead deal.
  assert.equal(state.salesOutcome, '');
  assert.ok(LOSS_OUTCOME_IDS.includes('no_show'), 'it IS a loss value in the sales taxonomy');
  assert.ok(!/values\.update[\s\S]{0,200}!V\$\{rowNum\}/.test(route), 'the route never writes the outcome column');
  // Recoverable, so Step 10 can act on it.
  assert.ok(RECOVERABLE_OUTCOME_IDS.includes('no_show'));
  assert.equal(state.resolvedAt, '2026-08-21T10:00:00.000Z', 'when it happened is recorded, for recovery');
});

test('24/25. a new booking supersedes a no-show or a cancellation', () => {
  for (const resolution of ['meeting_no_show', 'meeting_cancelled']) {
    const activities = [
      booked(PAST),
      ev(resolution, '2026-08-21T10:00:00.000Z', { meetingAt: PAST }),
      ev('call_booked', '2026-08-22T10:00:00.000Z', { meetingAt: FUTURE }),
    ];
    const state = life({ meetingAt: FUTURE }, activities);
    assert.equal(state.status, CALL_STATUS.SCHEDULED, `${resolution} must not leak onto the new booking`);
    const a = act({ meetingAt: FUTURE }, activities);
    assert.equal(a.type, ACTION_TYPE.SALES_CALL);
    assert.equal(a.dueAt, FUTURE);
  }
});

// ── 26. The separation ──────────────────────────────────────────────────────

test('26. meeting outcome and sales outcome are separate concepts', () => {
  const completed = [booked(PAST), ev('meeting_completed', '2026-08-21T10:00:00.000Z', { meetingAt: PAST })];
  // A completed meeting with each possible sales outcome still reports completed.
  for (const outcome of ['', 'not_interested', 'timing', 'other']) {
    const state = life({ meetingAt: PAST, outcome }, completed);
    assert.equal(state.status, CALL_STATUS.COMPLETED, 'the MEETING result is independent');
    assert.equal(state.salesOutcome, outcome, 'and the SALES result is carried separately');
  }
  // The lifecycle model names no sales outcome at all.
  const block = stateSrc.slice(stateSrc.indexOf('// ── CALL LIFECYCLE'), stateSrc.indexOf('function buildAction'));
  assert.ok(!/closed_lost|closed_won|ghosted|not_interested/.test(block), 'the model decides no sales outcome');
  // And the route writes no outcome value.
  assert.ok(!/GHOSTED_OUTCOME|outcome: '/.test(route.replace(/salesOutcomeUnchanged[^,]*/g, '')));
});

// ── 27–30. Idempotency and races ────────────────────────────────────────────

test('27/28/29. repeated lifecycle requests record one event', () => {
  assert.match(route, /stableActivityId\('call-lifecycle', \[req\.params\.id, eventType, previousMeetingAt, meetingAt\]\)/);
  assert.match(route, /if \(!allActivities\.some\(a => a\.eventId === eventId\)\)/);
  assert.match(route, /recorded = true;/);
  // Deriving twice from the same duplicated event is stable.
  const twice = [booked(PAST),
    ev('meeting_completed', '2026-08-21T10:00:00.000Z', { meetingAt: PAST }),
    ev('meeting_completed', '2026-08-21T10:00:00.000Z', { meetingAt: PAST })];
  assert.equal(life({ meetingAt: PAST }, twice).status, CALL_STATUS.COMPLETED);
});

test('30. a stale or impossible transition is refused server-side', () => {
  // The route re-derives from STORED history, not from the browser.
  assert.match(route, /const lifecycle = deriveCallLifecycle\(lead, \{ activities \}\);/);
  assert.match(route, /const allowed = callLifecycleActions\(lifecycle\);/);
  assert.match(route, /if \(!allowed\[action\]\) \{/);
  assert.match(route, /code: 'invalid_transition'/);
  // And an optimistic check catches a meeting that moved under the drawer.
  assert.match(route, /if \(expected && expected !== String\(lifecycle\.meetingAt \|\| ''\)\)/);
  assert.match(route, /code: 'meeting_changed'/);
  assert.ok(route.indexOf('invalid_transition') < route.indexOf('values.batchUpdate'),
    'refusal precedes any write');
  // A completed call really is refused a second completion.
  const completed = life({ meetingAt: PAST }, [booked(PAST), ev('meeting_completed', '2026-08-21T10:00:00.000Z', { meetingAt: PAST })]);
  assert.equal(callLifecycleActions(completed, NOW).complete, false);
  assert.equal(callLifecycleActions(completed, NOW).no_show, false);
  assert.equal(callLifecycleActions(completed, NOW).cancel, false);
});

// ── 31–35. Automation safety ────────────────────────────────────────────────

test('31/32/33/34/35. no lifecycle action sends, resumes or rewrites sequence state', () => {
  assert.ok(!/sendEmail|nodemailer|gmail\(|transporter/i.test(route), 'cannot send');
  assert.ok(!/emailStep|lastEmailedAt|emailStatus/.test(route), 'sequence state untouched');
  assert.ok(!/applyResumeToNotes|clearResumeFromNotes|RESUME/.test(route), 'never resumes a sequence');
  assert.ok(!/addSuppression/.test(route), 'suppression untouched');
  // Only the hold WRITER appears, never a remover.
  assert.match(route, /applyManualHold/);
  assert.ok(!/removeHold|clearHold/.test(route));
  // Write range proves it: stage and meeting time only, never agent columns R:T.
  assert.ok(!/![RST]\$\{rowNum\}/.test(route));
  assert.match(route, /automationResumed: false/);
  // The model itself does no I/O.
  const block = stateSrc.slice(stateSrc.indexOf('// ── CALL LIFECYCLE'), stateSrc.indexOf('function buildAction'));
  assert.ok(!/await|sheets\(|fetch\(|sendEmail/i.test(block));
  // Cancelling and no-showing write no lead state at all.
  assert.match(route, /Resolutions write NO lead state at all/);
});

// ── 36–39. Timeline, UI, queues ─────────────────────────────────────────────

test('36. the timeline tells the meeting journey in order, newest first', () => {
  const activities = [
    booked(PAST, '2026-08-01T10:00:00.000Z'),
    ev('meeting_rescheduled', '2026-08-05T10:00:00.000Z', { meetingAt: FUTURE, previousMeetingAt: PAST }),
    ev('meeting_cancelled', '2026-08-06T10:00:00.000Z', { meetingAt: FUTURE }),
    ev('call_booked', '2026-08-07T10:00:00.000Z', { meetingAt: LATER }),
    ev('meeting_no_show', '2026-08-08T10:00:00.000Z', { meetingAt: LATER }),
  ].map(e => ({ ...e, leadId: 'L1' }));
  const titles = buildActivityTimeline({ lead: { id: 'L1' }, activities }).map(x => x.title);
  assert.deepEqual(titles, ['No show', 'Call booked', 'Meeting cancelled', 'Call rescheduled', 'Call booked']);
});

test('37. the drawer offers only the transitions the state permits', () => {
  assert.match(browser, /function callDrawerRows\(next\)/);
  // Takes the stage too: a closed opportunity has no meeting decisions left.
  assert.match(browser, /function callAllowedActions\(call, stage\)/);
  assert.match(browser, /Object\.entries\(allowed\)\.filter\(\(\[, ok\]\) => ok\)/, 'draws only allowed actions');
  for (const label of ['Book call', 'Reschedule', 'Cancel call', 'Mark completed', 'Mark no show']) {
    assert.ok(browser.includes(label), `${label} exists`);
  }
  // Every resolution is confirmed, never a single click.
  const open = browser.slice(browser.indexOf('function openCallModal(action)'), browser.indexOf('async function submitCallAction'));
  assert.ok(!/fetch\(/.test(open), 'opening the modal writes nothing');
  assert.match(open, /onclick="submitCallAction\('\$\{action\}'\)"/);
  assert.match(browser, /does NOT close the opportunity/);
  assert.match(browser, /does NOT mark the deal won/);
});

test('38. the card shows compact lifecycle state', () => {
  assert.match(browser, /function callChipHtml\(action\)/);
  assert.match(browser, /\$\{callChipHtml\(action\)\}/);
  assert.match(browser, /outcome_pending: 'Outcome needed'/);
  assert.match(browser, /Needs follow-up/);
  assert.match(browser, /Needs decision/);
  // Mobile keeps the controls reachable.
  const mobile = browser.slice(browser.indexOf('@media (max-width: 700px)'));
  assert.match(mobile, /\.btn-call \{ min-height:44px/);
});

test('39. call states flow into the existing queues', () => {
  const overdue = act({ meetingAt: PAST }, [booked(PAST)]);
  assert.equal(summarizeNextActions([{ nextAction: overdue }]).overdue, 1);
  const noShow = act({ meetingAt: PAST }, [booked(PAST), ev('meeting_no_show', '2026-08-21T10:00:00.000Z', { meetingAt: PAST })]);
  assert.equal(noShow.needsAttention, true, 'no-show lands in Needs Attention');
  const cancelled = act({ meetingAt: PAST }, [booked(PAST), ev('meeting_cancelled', '2026-08-21T10:00:00.000Z', { meetingAt: PAST })]);
  assert.equal(cancelled.needsAttention, true, 'so does a cancelled call awaiting a decision');
  // No competing dashboard: these are ordinary canonical actions.
  assert.ok(!/callQueue|CallDashboard/.test(browser));
});

// ── 40. Timezone ────────────────────────────────────────────────────────────

test('40. meeting comparisons use the business calendar, not raw UTC', () => {
  // 22:00 Vancouver on the 27th arrives as the 28th in UTC. It is still today.
  assert.equal(act({ meetingAt: '2026-08-28T05:00:00.000Z' }, []).status, ACTION_STATUS.DUE_TODAY);
  // 10:00 Vancouver on the 28th is genuinely tomorrow.
  assert.equal(act({ meetingAt: '2026-08-28T17:00:00.000Z' }, []).status, ACTION_STATUS.UPCOMING);
  // Past/future is an instant comparison, so it is timezone-independent.
  assert.equal(life({ meetingAt: '2026-08-27T18:59:00.000Z' }, []).status, CALL_STATUS.OUTCOME_PENDING);
  assert.equal(life({ meetingAt: '2026-08-27T19:01:00.000Z' }, []).status, CALL_STATUS.SCHEDULED);
  // No second timezone system was invented.
  const block = stateSrc.slice(stateSrc.indexOf('// ── CALL LIFECYCLE'), stateSrc.indexOf('function buildAction'));
  assert.ok(!/America\//.test(block), 'reuses the shared business-calendar helpers');
});

// ── Historical honesty ──────────────────────────────────────────────────────

test('a past meetingAt with no events is Outcome Pending, never reconstructed', () => {
  const state = life({ meetingAt: PAST }, []);
  assert.equal(state.status, CALL_STATUS.OUTCOME_PENDING);
  assert.equal(state.resolvedAt, null, 'no resolution is invented');
  assert.equal(state.rescheduleCount, 0);
  assert.equal(state.previousMeetingAt, '');
  // An unreadable stored time is reported, not guessed around.
  assert.equal(life({ meetingAt: 'not-a-date' }, []).status, CALL_STATUS.NONE);
  assert.match(life({ meetingAt: 'not-a-date' }, []).reason, /cannot be read/);
});

test('no Calendly and no automated follow-up were introduced', () => {
  for (const src of [route, browser.slice(browser.indexOf('// ── CALL LIFECYCLE'), browser.indexOf('// ── MARK GHOSTED'))]) {
    assert.ok(!/calendly/i.test(src), 'no Calendly integration');
    assert.ok(!/sendEmail|reminder|sms/i.test(src), 'no automated follow-up');
  }
});
