'use strict';

// Pipeline buttons, call lifecycle and sales-outcome truthfulness.
//
// The four defects these lock down, in the words of the audit:
//
//   1. Reactivate could restart ordinary cold Email 2 on a lead that was still
//      Call Booked, because eligibility only ever asked the ColdEmail row
//      whether it had a step left — never the Pipeline who owned the lead.
//   2. Saving a loss outcome appended a `closed_lost` timeline event while the
//      stage stayed put, so the permanent record said a deal was lost that was
//      never closed.
//   3. The stage-chip route wrote the stage BEFORE applying the manual hold and
//      treated a hold failure as a log line — a human-owned lead with the cold
//      sequence still live underneath it.
//   4. Mutations refreshed a fraction of the UI, and refusals arrived as
//      "HTTP 422".
//
// Nothing here touches Google or the network: real functions are called
// directly, and route bodies are asserted against source the way the existing
// reactivation and manual-hold suites already do.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  coldReactivationVerdict, coldReactivationSuppressionReader,
  REACTIVATABLE_BLOCKERS, MANUAL_HOLD_TAG,
  deriveCallLifecycle, callLifecycleActions, CALL_STATUS,
  LOSS_OUTCOME_IDS,
} = require('../integrations/pipeline-state');
const { deriveAutomationOwnership, OWNER, BLOCKED_BY } = require('../integrations/automation-ownership');
const { buildActivityTimeline } = require('../integrations/activity-timeline');

const root = path.join(__dirname, '..');
// core.autocrlf is on for this repo, so a fresh checkout yields CRLF source.
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
const serverSrc = readSource(path.join(root, 'server.js'));
const browser = readSource(path.join(root, 'public', 'index.html'));

const NOW = new Date('2026-09-01T12:00:00.000Z');
const FUTURE = '2026-09-20T17:00:00.000Z';
const PAST = '2026-08-20T17:00:00.000Z';

// A held, mid-sequence cold row: mechanically resumable, step 2 pending. Every
// refusal below therefore comes from OWNERSHIP, never from the row running out
// of steps — which is exactly the distinction the bug collapsed.
const twin = (over = {}) => ({
  id: 'CE1', _row: 7, email: 'a@clinic.test', company: 'A Dental',
  emailStatus: 'emailed', emailStep: '1', lastEmailedAt: '2026-08-10T00:00:00.000Z',
  notes: MANUAL_HOLD_TAG + ' promoted from reply', stage: 'Contacted', ...over,
});

function verdictFor(boardLead, { activities = [], sequenceState = null, row = {}, suppressed = [] } = {}) {
  const lead = twin(row);
  const callState = boardLead ? deriveCallLifecycle(boardLead, { activities, now: NOW }) : null;
  const ownership = deriveAutomationOwnership(lead, {
    boardLead, activities, callState,
    suppressionReason: coldReactivationSuppressionReader({ suppressedEmails: new Set(suppressed) }),
    sendingEnabled: true, coldCadenceDue: true, now: NOW,
  });
  return coldReactivationVerdict(lead, { ownership, sequenceState, now: NOW });
}

// ── 1–6. Reactivate may never bypass Pipeline ownership ─────────────────────

test('1. a Call Booked lead cannot schedule ordinary cold reactivation', () => {
  const board = { id: 'L1', stage: 'call_booked', email: 'a@clinic.test', meetingAt: FUTURE };
  const activities = [{ eventType: 'call_booked', occurredAt: '2026-08-30T00:00:00.000Z',
    metadata: JSON.stringify({ meetingAt: FUTURE }) }];
  const v = verdictFor(board, { activities });

  // The row itself is still perfectly resumable — that is the whole point.
  assert.equal(v.nextStep, 2, 'the ColdEmail row still has step 2 pending');
  assert.equal(v.canSchedule, false, 'but a booked call owns the lead');
  assert.ok(v.ownerBlocked, 'the refusal is attributed to ownership, not to the row');
  // Reopening for human work writes nothing, so it stays available.
  assert.equal(v.canKeepManual, true);
});

test('2. a Closed Won lead cannot reactivate ordinary cold outreach', () => {
  const v = verdictFor({ id: 'L1', stage: 'closed_won', email: 'a@clinic.test' });
  assert.equal(v.canSchedule, false);
  assert.equal(v.ownerBlocked, BLOCKED_BY.TERMINAL_STAGE);
  assert.match(v.reason, /closed/i);
});

test('3. a Closed Lost lead cannot ordinary-reactivate; recovery is a separate workflow', () => {
  const v = verdictFor({ id: 'L1', stage: 'closed_lost', outcome: 'ghosted', email: 'a@clinic.test' });
  assert.equal(v.canSchedule, false);
  assert.equal(v.ownerBlocked, BLOCKED_BY.TERMINAL_STAGE);
  // A recoverable loss does NOT quietly reopen the cold sequence. Reopening for
  // human work is offered; resuming Email 2 is not.
  assert.equal(v.canKeepManual, true);
});

test('4. a Pipeline-owned lead blocks ordinary reactivation', () => {
  // The property under test is that ordinary cold resume is refused, and that
  // is unchanged. The OWNER now depends on the stage rather than being HUMAN
  // for everything in the Pipeline, so the assertion checks the refusal and
  // that cold automation is not the owner -- not one particular enum.
  const v = verdictFor({ id: 'L1', stage: 'hot', email: 'a@clinic.test' });
  assert.equal(v.canSchedule, false);
  assert.notEqual(v.ownership.owner, OWNER.COLD_AUTOMATION);
  assert.ok(v.ownerBlocked, 'the refusal names a specific blocker');
  assert.notEqual(v.ownerBlocked, BLOCKED_BY.PROMOTED_TO_PIPELINE,
    'Pipeline membership alone is no longer the reason');
});

test('5. an active stage sequence blocks ordinary reactivation', () => {
  const v = verdictFor({ id: 'L1', stage: 'hot', email: 'a@clinic.test' },
    { sequenceState: { sequenceId: 'no_show_recovery', status: 'active' } });
  assert.equal(v.canSchedule, false);
  assert.equal(v.ownerBlocked, 'active_sequence');
  assert.match(v.reason, /must not run underneath/);
});

test('6. a prospect reply or a manual human response blocks reactivation', () => {
  const replied = verdictFor({ id: 'L1', stage: 'hot', email: 'a@clinic.test' },
    { row: { emailStatus: 'replied', notes: MANUAL_HOLD_TAG + ' [REPLY: Interested]' } });
  assert.equal(replied.canSchedule, false);

  // A manual Gmail reply the CRM has recorded still means a person is talking
  // to this prospect; ordinary cadence must not join the conversation.
  const manual = verdictFor({ id: 'L1', stage: 'hot', email: 'a@clinic.test' }, {
    activities: [{ eventType: 'human_response_sent', occurredAt: '2026-08-31T00:00:00.000Z',
      metadata: JSON.stringify({ direction: 'outbound', actor: 'human' }) }],
  });
  assert.equal(manual.canSchedule, false);
});

test('the hold cannot be its own justification, and an unknown verdict fails closed', () => {
  // Ownership is checked in precedence order and MANUAL_HOLD sits ahead of the
  // meeting and Pipeline rules. Accepting it would mean a Call Booked lead was
  // cleared by the very hold reactivation proposes to lift.
  assert.ok(!REACTIVATABLE_BLOCKERS.includes(BLOCKED_BY.MANUAL_HOLD),
    'a MANUAL_HOLD verdict must never authorise a resume');
  const holdAware = coldReactivationVerdict(twin(), {
    ownership: { owner: OWNER.NONE, blockedBy: BLOCKED_BY.MANUAL_HOLD, reason: 'hold' }, now: NOW,
  });
  assert.equal(holdAware.canSchedule, false);

  // No verdict at all is "we could not check", which must never read as "yes".
  const unknown = coldReactivationVerdict(twin(), { now: NOW });
  assert.equal(unknown.canSchedule, false);
  assert.equal(unknown.ownerBlocked, 'ownership_unknown');
});

test('a genuinely cold-owned lead can still reactivate', () => {
  // The guard has to refuse the unsafe cases without disabling the feature.
  const v = verdictFor(null);
  assert.equal(v.ownership.owner, OWNER.COLD_AUTOMATION);
  assert.equal(v.canSchedule, true);
  assert.equal(v.nextStep, 2);
});

test('both the preview and the mutation use the same verdict', () => {
  const get = serverSrc.slice(serverSrc.indexOf("app.get('/api/leads/:id/reactivation'"),
    serverSrc.indexOf("app.post('/api/leads/:id/reactivate'"));
  const post = serverSrc.slice(serverSrc.indexOf("app.post('/api/leads/:id/reactivate'"),
    serverSrc.indexOf("app.post('/api/leads/:id/human-response'"));
  for (const [name, block] of [['GET', get], ['POST', post]]) {
    assert.match(block, /buildReactivationOwnership\(/, `${name} derives canonical ownership`);
    assert.match(block, /ownershipFor: context\.ownershipFor/, `${name} passes it into the verdict`);
  }
  // resolveReactivationTarget composes the gate rather than the bare row check.
  const resolver = serverSrc.slice(serverSrc.indexOf('function resolveReactivationTarget'));
  assert.match(resolver.slice(0, resolver.indexOf('\n}\n')), /coldReactivationVerdict\(/);
});

// ── 7–10. Outcome and stage tell the truth ──────────────────────────────────

function callDetailsRoute() {
  const start = serverSrc.indexOf("app.patch('/api/leads/:id/call-details'");
  return serverSrc.slice(start, serverSrc.indexOf("app.post('/api/coldemail/queue'", start));
}

test('7. an outcome-only save no longer writes a false Closed Lost event', () => {
  const route = callDetailsRoute();
  assert.ok(!/eventType = LOSS_OUTCOME_IDS\.includes\(outcome\) \? 'closed_lost'/.test(route),
    'the loss-outcome-becomes-closed_lost mapping must be gone');
  assert.match(route, /eventType: 'sales_outcome_recorded'/);
  assert.match(route, /Sales outcome recorded/);
});

test('8. an outcome-only save leaves the stage alone and says so in history', () => {
  const route = callDetailsRoute();
  // The write range is U:W. Column M — the stage — is not in it.
  assert.match(route, /range: `\$\{SHEET_NAME\}!U\$\{rowNum\}:W\$\{rowNum\}`/);
  assert.ok(!/!M\$\{rowNum\}/.test(route), 'this endpoint must never write the stage');
  assert.match(route, /stageUnchanged: true/);
  assert.match(route, /stageAtRecord/);

  // And the timeline renders it as a record, not as a closure.
  const [entry] = buildActivityTimeline({
    lead: { id: 'L1' },
    activities: [{
      eventId: 'e1', leadId: 'L1', eventType: 'sales_outcome_recorded',
      occurredAt: '2026-09-01T00:00:00.000Z', subject: 'Sales outcome recorded — Ghosted',
      metadata: JSON.stringify({ outcome: 'ghosted', stageUnchanged: true, stageAtRecord: 'call_booked' }),
    }],
  });
  assert.match(entry.title, /Sales outcome recorded/);
  assert.ok(!/Closed Lost/.test(entry.title), 'recording an outcome is not closing a deal');
});

function closeRoute() {
  const start = serverSrc.indexOf("app.post('/api/leads/:id/close'");
  return serverSrc.slice(start, serverSrc.indexOf('function buildCloseEvent', start));
}

test('9. explicit Close Lost writes outcome and stage as one coherent action', () => {
  const route = closeRoute();
  // Both cells in a single batch: there is no interleaving that lands one
  // without the other.
  assert.match(route, /values\.batchUpdate/);
  assert.match(route, /range: `\$\{SHEET_NAME\}!M\$\{rowNum\}`, values: \[\[stage\]\]/);
  assert.match(route, /range: `\$\{SHEET_NAME\}!V\$\{rowNum\}`, values: \[\[outcome\]\]/);
  // A loss needs a reason, and the refusal names the field.
  assert.match(route, /Choose a loss reason before closing this opportunity/);
  assert.match(route, /field: 'outcome'/);
  assert.ok(LOSS_OUTCOME_IDS.includes('ghosted'));
});

test('10. explicit Close Won writes the terminal stage coherently', () => {
  const route = closeRoute();
  assert.match(route, /CLOSE_RESULTS\[result\]/);
  assert.match(serverSrc, /const CLOSE_RESULTS = Object\.freeze\(\{ won: 'closed_won', lost: 'closed_lost' \}\)/);
  // Winning has no loss reason to supply.
  assert.match(route, /result === 'lost'\s*\?\s*String\(req\.body\?\.outcome/);
});

test('selecting a loss outcome never closes anything on its own', () => {
  // The close route is reachable only from the explicit action; nothing in the
  // call-details path calls it, and the drawer requires a confirmation modal.
  assert.ok(!/\/close/.test(callDetailsRoute()), 'saving details cannot trigger a close');
  const save = browser.slice(browser.indexOf('async function saveCallDetails'),
    browser.indexOf('// Labels for the Close Lost picker'));
  assert.ok(!/\/close/.test(save));
  assert.match(save, /still open — use Close Lost to close it/);
  const open = browser.slice(browser.indexOf('function openCloseModal(result)'),
    browser.indexOf('async function submitClose'));
  assert.ok(!/fetch\(/.test(open), 'opening the close modal writes nothing');
});

// ── 11–12. Safety before state ──────────────────────────────────────────────

test('11. an unconfirmed manual hold prevents the human-owned stage transition', () => {
  const put = serverSrc.slice(serverSrc.indexOf("app.put('/api/leads/:id'"),
    serverSrc.indexOf('const previousNotes'));
  const holdAt = put.indexOf('ensureManualHoldDurable');
  const writeAt = put.indexOf('range:           `${SHEET_NAME}!A${rowNum}:Q${rowNum}`');
  assert.ok(holdAt !== -1 && writeAt !== -1);
  assert.ok(holdAt < writeAt, 'the hold must be confirmed BEFORE the stage is committed');
  // And a failure returns instead of falling through to the write.
  assert.match(put, /if \(!holdResult\.ok\) \{[\s\S]{0,400}return res\.status\(409\)/);
  assert.match(put, /Manual hold could not be confirmed, so the stage change was not applied/);
  assert.match(put, /code: 'hold_unconfirmed'/);

  // The close route uses the same ordering.
  const close = closeRoute();
  assert.ok(close.indexOf('ensureManualHoldDurable') < close.indexOf('values.batchUpdate'));
  assert.match(close, /so this opportunity was not closed/);
});

test('12. a committed stage transition guarantees a durable, verified stop', () => {
  const helper = serverSrc.slice(serverSrc.indexOf('async function ensureManualHoldDurable'),
    serverSrc.indexOf('function activityMatchesLead'));
  // Writing is not proof. The tag is read back off the sheet and every twin
  // must carry it before the caller is allowed to proceed.
  assert.match(helper, /findColdEmailTwins/, 'reads back after writing');
  assert.match(helper, /twins\.filter\(twin => !hasManualHold\(twin\.notes \|\| ''\)\)/);
  assert.match(helper, /confirmed: true/);
  assert.match(helper, /attempts = 2/, 'retries once before giving up');
  assert.match(helper, /return \{ ok: false/, 'and fails closed when it cannot confirm');
  // A lead with no cold twin has no automation to stop — a genuine pass.
  assert.match(helper, /no ColdEmail record is linked to this lead/);
});

// ── 13–17. Lifecycle stays coherent ─────────────────────────────────────────

const lifecycleOf = (lead, activities) => deriveCallLifecycle(lead, { activities, now: NOW });
const ev = (eventType, meetingAt, occurredAt) => ({ eventType, occurredAt,
  metadata: JSON.stringify({ meetingAt }) });

test('13. Mark completed records the meeting only — it never wins or loses the deal', () => {
  const lead = { stage: 'call_booked', meetingAt: PAST };
  const state = lifecycleOf(lead, [ev('call_booked', PAST, '2026-08-15T00:00:00Z'),
    ev('meeting_completed', PAST, '2026-08-21T00:00:00Z')]);
  assert.equal(state.status, CALL_STATUS.COMPLETED);
  assert.equal(state.salesOutcome, '', 'completing a call sets no sales outcome');
  assert.match(state.reason, /says nothing about whether the deal is won/);

  // The lifecycle route writes no outcome, and prompts for one instead.
  const route = serverSrc.slice(serverSrc.indexOf("app.post('/api/leads/:id/call-lifecycle'"),
    serverSrc.indexOf('// ── EXPLICIT CLOSE'));
  assert.match(route, /salesOutcomeUnchanged: true/);
  assert.match(route, /kind: 'choose_sales_result'/);
  assert.match(route, /this did not close the opportunity/);
});

test('14. Mark no show updates the lifecycle and leaves the opportunity open', () => {
  const state = lifecycleOf({ stage: 'call_booked', meetingAt: PAST },
    [ev('call_booked', PAST, '2026-08-15T00:00:00Z'), ev('meeting_no_show', PAST, '2026-08-21T00:00:00Z')]);
  assert.equal(state.status, CALL_STATUS.NO_SHOW);
  assert.equal(state.needsResolution, false, 'Outcome Pending is superseded');
  assert.match(state.reason, /recoverable/);
  const route = serverSrc.slice(serverSrc.indexOf("app.post('/api/leads/:id/call-lifecycle'"),
    serverSrc.indexOf('// ── EXPLICIT CLOSE'));
  assert.match(route, /The opportunity stays open and can be recovered/);
});

test('15. Cancel updates the lifecycle and does not close the opportunity', () => {
  const state = lifecycleOf({ stage: 'call_booked', meetingAt: FUTURE },
    [ev('call_booked', FUTURE, '2026-08-15T00:00:00Z'), ev('meeting_cancelled', FUTURE, '2026-08-21T00:00:00Z')]);
  assert.equal(state.status, CALL_STATUS.CANCELLED);
  assert.match(state.reason, /the opportunity is not closed by this/);
});

test('16. Reschedule supersedes the previous meeting state', () => {
  const later = '2026-09-25T17:00:00.000Z';
  // Cancelled, then rebooked: the stale cancellation must not stick to the new
  // occurrence, and the live booking is the one that stands.
  const state = lifecycleOf({ stage: 'call_booked', meetingAt: later }, [
    ev('call_booked', FUTURE, '2026-08-15T00:00:00Z'),
    ev('meeting_cancelled', FUTURE, '2026-08-21T00:00:00Z'),
    { eventType: 'meeting_rescheduled', occurredAt: '2026-08-22T00:00:00Z',
      metadata: JSON.stringify({ meetingAt: later, previousMeetingAt: FUTURE }) },
  ]);
  assert.equal(state.status, CALL_STATUS.RESCHEDULED);
  assert.equal(state.meetingAt, later);
  assert.equal(state.previousMeetingAt, FUTURE);
  assert.equal(state.needsResolution, false);
});

test('17. a terminal stage offers no meeting controls', () => {
  const src = browser.slice(browser.indexOf('function callAllowedActions(call, stage)'),
    browser.indexOf('const CALL_ACTION_LABEL'));
  const allowed = new Function('call', 'stage', src.slice(src.indexOf('{') + 1, src.lastIndexOf('}')));
  for (const stage of ['closed_won', 'closed_lost']) {
    const out = allowed({ status: 'outcome_pending', meetingAt: PAST }, stage);
    assert.deepEqual(Object.values(out).filter(Boolean), [], `${stage} offers nothing`);
  }
  // Still fully functional on a live opportunity.
  const live = allowed({ status: 'outcome_pending', meetingAt: PAST }, 'call_booked');
  assert.equal(live.complete, true);
  assert.equal(live.no_show, true);
  // And the drawer passes the stage in rather than ignoring it.
  assert.match(browser, /const allowed = callAllowedActions\(call, stage\);/);
  assert.match(browser, /This opportunity is \$\{stage === 'closed_won' \? 'Closed Won' : 'Closed Lost'\}/);
});

// ── 18–21. The UI reflects what happened, and says why when it did not ──────

test('18. Save call details refreshes the board, drawer, Next Action and timeline', () => {
  const refresh = browser.slice(browser.indexOf('async function refreshLeadEverywhere'),
    browser.indexOf('async function loadColdCallActivity'));
  for (const call of ['loadLeads()', 'loadNextActions()', 'renderBoard()',
    'openDetail(leadId)', 'loadColdCallActivity(leadId)', 'renderReactivationControls(leadId)']) {
    assert.ok(refresh.includes(call), `${call} is part of the shared refresh`);
  }
  const save = browser.slice(browser.indexOf('async function saveCallDetails'),
    browser.indexOf('// Labels for the Close Lost picker'));
  assert.match(save, /await refreshLeadEverywhere\(lead\.id\)/);
  assert.ok(!/await loadColdCallActivity\(lead\.id\);/.test(save),
    'the timeline-only refresh that left five surfaces stale must be gone');
});

test('19. Reactivate refreshes its own controls after a successful mutation', () => {
  const submit = browser.slice(browser.indexOf('async function submitReactivation'),
    browser.indexOf('function setMotion'));
  assert.match(submit, /await refreshLeadEverywhere\(leadId\)/);
  // Refused because ownership moved under the operator: re-ask rather than
  // leave a modal offering an option the server rejects.
  assert.match(submit, /not_cold_owned/);
});

test('20. backend validation messages reach the operator verbatim', () => {
  const helper = browser.slice(browser.indexOf('async function apiError'),
    browser.indexOf('async function refreshLeadEverywhere'));
  assert.match(helper, /data\.error/);
  assert.match(helper, /data\.detail/);
  // Every mutation path parses the body rather than printing the status code.
  for (const fn of ['saveCallDetails', 'submitReactivation', 'submitCallAction', 'submitClose']) {
    const start = browser.indexOf(`async function ${fn}`);
    const block = browser.slice(start, start + 2600);
    assert.match(block, /await apiError\(/, `${fn} surfaces the server's message`);
    assert.ok(!/HTTP \$\{res(p|ponse)\.status\}/.test(block), `${fn} no longer throws a bare status`);
  }
  // The stage-chip path too — including the new hold refusal.
  const sync = browser.slice(browser.indexOf('async function syncLead'), browser.indexOf('async function loadNextActions'));
  assert.match(sync, /await apiError\(/);
  assert.match(sync, /resp\.status === 422 \|\| resp\.status === 409/);
});

test('21. a failed Reactivate eligibility lookup is visible, not hidden', () => {
  const render = browser.slice(browser.indexOf('async function renderReactivationControls'),
    browser.indexOf('function closeReactivateModal'));
  assert.match(render, /Reactivation options unavailable/);
  assert.match(render, /onclick="renderReactivationControls\(detailId\)">Retry/);
  // The silent-blank paths are gone: a catch that erased the control, and an
  // early return on a non-ok response.
  assert.ok(!/catch \(_\) \{\s*host\.innerHTML = '';/.test(render), 'no silent catch');
  assert.ok(!/if \(!resp\.ok\) \{ host\.innerHTML = ''; return; \}/.test(render), 'no silent non-ok');
  assert.match(render, /ownership_unavailable/);
  // And the ownership refusal is stated in the row, not buried in a modal.
  assert.match(render, /Automated resume unavailable/);
});

// ── 22–23. Timeline persistence ─────────────────────────────────────────────

test('22. a close whose timeline write fails reports it and can be reconciled', () => {
  const route = closeRoute();
  assert.match(route, /timelineRecorded = false/);
  assert.match(route, /timelineEventId: closeEvent\.eventId/);
  // The business state is committed and correct; the response must not claim
  // the history is complete when it is not.
  assert.match(route, /did not save\. Use Retry timeline to reconcile it/);
  assert.ok(!/rollback|revert/i.test(route), 'authoritative data is not rolled back');
});

test('23. timeline reconciliation is idempotent and cannot duplicate or re-close', () => {
  const build = serverSrc.slice(serverSrc.indexOf('function buildCloseEvent'),
    serverSrc.indexOf("app.post('/api/leads/:id/reconcile-timeline'"));
  // Deterministic id from authoritative state — a retry recomputes the same one.
  assert.match(build, /stableActivityId\('close', \[leadId, stage, outcome \|\| ''\]\)/);

  const route = serverSrc.slice(serverSrc.indexOf("app.post('/api/leads/:id/reconcile-timeline'"));
  const body = route.slice(0, route.indexOf('\n});') + 4);
  assert.match(body, /all\.some\(activity => activity\.eventId === expected\.eventId\)/,
    'an existing row short-circuits');
  assert.match(body, /alreadyRecorded: true/);
  assert.match(body, /Nothing was written/);
  // It rebuilds the event from the sheet instead of trusting a client payload,
  // and it can only ever append an audit row — never move a stage.
  assert.match(body, /buildCloseEvent\(req\.params\.id/);
  assert.ok(!/values\.update|values\.batchUpdate/.test(body), 'reconciliation never writes lead state');
  assert.match(body, /Only a closed opportunity has a close event to reconcile/);

  // The lifecycle route has the same protection against a replayed action.
  const lifecycle = serverSrc.slice(serverSrc.indexOf("app.post('/api/leads/:id/call-lifecycle'"),
    serverSrc.indexOf('// ── EXPLICIT CLOSE'));
  assert.match(lifecycle, /if \(!allActivities\.some\(a => a\.eventId === eventId\)\)/);
});

// ── 24. Historical rows are described accurately, never rewritten ───────────

test('24. a legacy closed_lost row on an open lead reads as an outcome record', () => {
  // Production carries exactly this: Northbridge Dental sat at Call Booked with
  // a closed_lost event written by the old outcome-only save. The row is
  // history and stays untouched; what changes is that the timeline stops
  // claiming the deal was closed when the stage proves it never was.
  const legacy = {
    eventId: 'meeting-outcome:9e3e', leadId: 'L1', eventType: 'closed_lost',
    occurredAt: '2026-09-02T00:58:24.000Z',
    metadata: JSON.stringify({ outcome: 'ghosted', meetingAt: '2026-09-02T00:30:00.000Z' }),
  };
  const [open] = buildActivityTimeline({ lead: { id: 'L1', stage: 'call_booked' }, activities: [legacy] });
  assert.match(open.title, /Sales outcome recorded — Ghosted/);
  assert.match(open.summary, /the opportunity was not closed/);

  // A lead that really IS closed keeps the real label — no over-correction.
  const [closed] = buildActivityTimeline({ lead: { id: 'L1', stage: 'closed_lost' }, activities: [legacy] });
  assert.match(closed.title, /Closed Lost — Ghosted/);

  // And anything written by the explicit Close action is always a closure.
  const [byAction] = buildActivityTimeline({
    lead: { id: 'L1', stage: 'call_booked' },
    activities: [{ ...legacy, metadata: JSON.stringify({ outcome: 'ghosted', trigger: 'close_action' }) }],
  });
  assert.match(byAction.title, /Closed Lost — Ghosted/);
});

test('the no-show that followed it is the lifecycle that stands', () => {
  // The operator recorded the outcome first and marked No Show 3½ hours later
  // through the proper control. Newest valid event wins, so the lead reads as a
  // recoverable no-show rather than an unresolved Outcome Pending.
  const meeting = '2026-09-02T00:30:00.000Z';
  const state = deriveCallLifecycle(
    { stage: 'call_booked', meetingAt: meeting, outcome: 'ghosted' },
    { activities: [
      { eventType: 'call_booked', occurredAt: '2026-09-01T18:09:06.000Z', metadata: JSON.stringify({ meetingAt: meeting }) },
      { eventType: 'meeting_no_show', occurredAt: '2026-09-02T04:28:40.000Z', metadata: JSON.stringify({ meetingAt: meeting }) },
    ], now: new Date('2026-09-02T12:00:00.000Z') });
  assert.equal(state.status, CALL_STATUS.NO_SHOW);
  assert.equal(state.salesOutcome, 'ghosted', 'the recorded outcome is preserved, not erased');
  assert.equal(state.needsResolution, false);
});
