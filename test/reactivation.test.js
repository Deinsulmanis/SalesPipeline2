'use strict';

// Reactivation safety. Nothing here touches Google, a provider or the network,
// and no message can be sent: the real function bodies are lifted out of source
// and evaluated against mocks, the same way manual-hold.test.js does it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  MANUAL_HOLD_TAG, REACTIVATION_MODES,
  reactivationEligibility, resumeAtFromNotes, manualHoldReleased,
  applyResumeToNotes, clearResumeFromNotes,
  deriveAutomationState, deriveNextAction, hasManualHold,
  ACTION_TYPE, ACTION_OWNER, ACTION_STATUS, AUTOMATION_STATES,
} = require('../integrations/pipeline-state');

const root = path.join(__dirname, '..');
// core.autocrlf is on for this repo, so a fresh checkout yields CRLF source.
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
const agentSrc = readSource(path.join(root, 'outreach-agent.js'));
const stateSrc = readSource(path.join(root, 'integrations', 'pipeline-state.js'));
const serverSrc = readSource(path.join(root, 'server.js'));
const browser = readSource(path.join(root, 'public', 'index.html'));

const NOW = new Date('2026-08-26T12:00:00.000Z');
const FUTURE = '2026-09-05T17:00:00.000Z';
const PAST = '2026-08-20T17:00:00.000Z';

function twin(over = {}) {
  return {
    id: 'CE1', _row: 7, email: 'a@example.test', company: 'A Dental',
    emailStatus: 'emailed', emailStep: '1', lastEmailedAt: '2026-08-10T00:00:00.000Z',
    notes: MANUAL_HOLD_TAG + ' promoted from reply', ...over,
  };
}
const held = o => twin(o);
const scheduled = (at = FUTURE, o = {}) => twin({ notes: applyResumeToNotes(MANUAL_HOLD_TAG, at), ...o });

// Lift the real suppressionReason out of the agent, wired to the real gate.
function agentGate({ suppressedEmails = [] } = {}) {
  // The agent delegates to the shared rule in pipeline-state, so this returns
  // the real production guard directly instead of eval-ing a source slice.
  const { sendSuppressionReason } = require('../integrations/pipeline-state');
  const SUPPRESSED = new Set(suppressedEmails.map(e => e.toLowerCase().trim()));
  return lead => sendSuppressionReason(lead, { suppressedEmails: SUPPRESSED });
}

// ── 1–4. Who may reactivate ─────────────────────────────────────────────────

test('1. a manually held, mid-sequence lead is reactivatable', () => {
  const e = reactivationEligibility(held(), { now: NOW });
  assert.equal(e.eligible, true);
  assert.equal(e.canKeepManual, true);
  assert.equal(e.canSchedule, true);
  assert.equal(e.nextStep, 2);
});

test('2/3. an unsubscribed lead can never be reactivated', () => {
  const e = reactivationEligibility(held({ notes: MANUAL_HOLD_TAG + ' [REPLY: Unsubscribed]' }), { now: NOW });
  assert.equal(e.eligible, false);
  assert.equal(e.blocked, 'suppressed');
  assert.equal(e.canSchedule, false);
  assert.equal(e.canKeepManual, false);
});

test('4. a bounced lead cannot be reactivated', () => {
  const e = reactivationEligibility(held({ notes: MANUAL_HOLD_TAG + ' [BOUNCED 2026-08-01]' }), { now: NOW });
  assert.equal(e.blocked, 'suppressed');
});

test('the durable suppression list blocks reactivation even with clean notes', () => {
  const e = reactivationEligibility(held(), { now: NOW, suppressedEmails: new Set(['a@example.test']) });
  assert.equal(e.blocked, 'suppressed');
  assert.match(e.reason, /durable suppression list/);
});

test('a lead that is not held has nothing to reactivate', () => {
  const e = reactivationEligibility(held({ notes: 'ordinary note' }), { now: NOW });
  assert.equal(e.blocked, 'not_held');
});

// ── 5–6. Keep Manual / stage movement ───────────────────────────────────────

test('5. Keep Manual writes nothing to ColdEmail, so the hold survives', () => {
  const handler = serverSrc.slice(serverSrc.indexOf("if (mode === REACTIVATION_MODES.KEEP_MANUAL)"));
  const body = handler.slice(0, handler.indexOf('// ── Option C'));
  assert.ok(!/writeColdEmailNotes|values\.update/.test(body), 'keep_manual performs no ColdEmail write');
  assert.match(body, /automationResumed: false/);
});

test('6. stage movement alone still never removes the hold', () => {
  // The only hold writer applies it; nothing in the stage path clears it.
  assert.match(serverSrc, /async function applyManualHold/);
  assert.ok(!/clearHoldFromNotes|removeManualHold/.test(serverSrc));
  const stagePath = serverSrc.slice(serverSrc.indexOf('if (stageRequiresHold(nextStage))'), serverSrc.indexOf('eventType: \'stage_changed\''));
  assert.ok(!/clearResumeFromNotes|applyResumeToNotes/.test(stagePath), 'stage changes do not touch resume state');
});

// ── 7–9. Scheduling and the agent gate ──────────────────────────────────────

test('7. scheduling stores a future resume beside an intact hold', () => {
  const notes = applyResumeToNotes(MANUAL_HOLD_TAG + ' promoted', FUTURE);
  assert.ok(notes.includes(MANUAL_HOLD_TAG), 'the hold tag is never removed');
  assert.equal(resumeAtFromNotes(notes), new Date(FUTURE).getTime());
  const e = reactivationEligibility(twin({ notes }), { now: NOW });
  assert.equal(e.state, 'scheduled');
  assert.equal(e.resumeAt, FUTURE);
  assert.equal(e.canCancel, true);
});

test('8. a scheduled lead is still suppressed before its resume time', () => {
  const suppressionReason = agentGate();
  assert.equal(suppressionReason(scheduled(FUTURE)), MANUAL_HOLD_TAG, 'must remain held before resumeAt');
  assert.equal(manualHoldReleased(scheduled(FUTURE).notes, NOW), false);
});

test('9. reaching resumeAt releases only the hold — every other check still applies', () => {
  const suppressionReason = agentGate();
  assert.equal(suppressionReason(scheduled(PAST)), null, 'hold released once the time passes');
  // But an opted-out or bounced lead stays blocked no matter the resume time.
  assert.equal(suppressionReason(scheduled(PAST, { notes: applyResumeToNotes(MANUAL_HOLD_TAG + ' [REPLY: Unsubscribed]', PAST) })), '[REPLY: Unsubscribed]');
  assert.equal(suppressionReason(scheduled(PAST, { notes: applyResumeToNotes(MANUAL_HOLD_TAG + ' [BOUNCED x]', PAST) })), '[BOUNCED');
  // And the durable list still wins.
  const listed = agentGate({ suppressedEmails: ['a@example.test'] });
  assert.equal(listed(scheduled(PAST)), 'suppression-list');
});

test('28. the gate lives in suppressionReason, which every send loop calls', () => {
  const guards = agentSrc.match(/const suppressed = suppressionReason\(lead\);/g) || [];
  assert.ok(guards.length >= 4, 'expected the shared guard on every send loop');
  // The release rule moved into pipeline-state with the rest of the guard; the
  // assertion follows it, and still fails if the rule is ever weakened.
  assert.match(stateSrc, /if \(tag === MANUAL_HOLD_TAG && manualHoldReleased\(notes\)\) continue;/);
  // ...and the agent must still route through that shared rule.
  assert.match(agentSrc, /return sendSuppressionReason\(lead, \{ suppressedEmails: SUPPRESSED_EMAILS \}\);/);
  // The gate is imported from the shared model, not re-implemented in the
  // agent. Matched loosely: other names may be destructured alongside it.
  assert.match(agentSrc, /const \{[^}]*\bmanualHoldReleased\b[^}]*\} = require\('\.\/integrations\/pipeline-state'\)/);
  assert.ok(!/function manualHoldReleased/.test(agentSrc), 'no second copy of the gate');
});

test('10. no reactivation code path can send', () => {
  const start = serverSrc.indexOf("app.post('/api/leads/:id/reactivate'");
  const block = serverSrc.slice(start, serverSrc.indexOf("app.post('/api/leads/:id/human-response'"));
  assert.ok(!/sendEmail|nodemailer|transporter|gmail\(/i.test(block), 'no send path in reactivation');
  const uiStart = browser.indexOf('// ── REACTIVATION ─');
  const ui = browser.slice(uiStart, browser.indexOf('function closeReactivateModal'));
  assert.ok(!/sendEmail/i.test(ui));
  assert.ok(!/Send now/i.test(browser), 'no immediate-send control was added');
});

// ── 11–15. Sequence state is preserved ──────────────────────────────────────

// The slice ends at the next route deliberately: these assertions are about the
// reactivation endpoints only, and a neighbouring route's writes are not theirs.
test('11/12/13. the step and send history are never rewritten', () => {
  const start = serverSrc.indexOf("app.post('/api/leads/:id/reactivate'");
  const block = serverSrc.slice(start, serverSrc.indexOf("app.post('/api/leads/:id/human-response'"));
  // The only cell reactivation writes is the notes column — step and timestamp
  // are read for display and audit, and no write targets them.
  assert.match(serverSrc, /range: `\$\{CE_SHEET_NAME\}!L\$\{twin\._row\}`/);
  assert.match(block, /writeColdEmailNotes\(twin,/);
  // The route delegates its only state write to the narrow notes helper; no
  // direct sheet mutation can expand that write to send-history columns.
  const updates = block.match(/values\.(update|append|batchUpdate|clear)\(\{[\s\S]{0,200}?range: `[^`]+`/g) || [];
  assert.equal(updates.length, 0, 'reactivation route delegates to the one-cell notes writer');
  assert.ok(!/emailStep:\s*[^,\n}]*(\+|=)/.test(block), 'emailStep is never recomputed into a write');
  // Resuming reads the step; it does not reset it.
  const e = reactivationEligibility(held({ emailStep: '2' }), { now: NOW });
  assert.equal(e.nextStep, 3, 'resumes after the step that actually sent');
  assert.notEqual(e.nextStep, 1);
});

test('14. resume is offered only when a step genuinely completed', () => {
  assert.equal(reactivationEligibility(held({ emailStatus: '', emailStep: '' }), { now: NOW }).canSchedule, false);
  assert.equal(reactivationEligibility(held({ emailStatus: 'emailed', emailStep: '0' }), { now: NOW }).canSchedule, false);
  assert.equal(reactivationEligibility(held({ emailStatus: 'emailed', emailStep: '1' }), { now: NOW }).canSchedule, true);
});

test('15. a sequence-complete lead cannot resume a step that does not exist', () => {
  const e = reactivationEligibility(held({ emailStep: '3', emailStatus: 'emailed' }), { now: NOW, stepCount: 2 });
  assert.equal(e.canSchedule, false);
  assert.equal(e.nextStep, null);
  assert.equal(e.canKeepManual, true, 'human reopen stays available');
  assert.match(e.reason, /recovery sequence that does not exist yet/);
  // A 'done' lead likewise offers no automated resume.
  assert.equal(reactivationEligibility(held({ emailStatus: 'done', emailStep: '3' }), { now: NOW }).canSchedule, false);
});

// ── 16–17. Duplicate twins ──────────────────────────────────────────────────

function resolveTarget() {
  const src = serverSrc.slice(serverSrc.indexOf('function resolveReactivationTarget'));
  const body = src.slice(0, src.indexOf('\n}\n') + 2);
  return new Function('reactivationEligibility', `${body}; return resolveReactivationTarget;`)(reactivationEligibility);
}

test('16. two mid-sequence duplicates block automated reactivation', () => {
  const resolve = resolveTarget();
  const out = resolve([held({ id: 'CE1' }), held({ id: 'CE2' })], { now: NOW });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'ambiguous_twins');
  assert.equal(out.candidates.length, 2);
});

test('17. one resumable row beside an exhausted duplicate resolves safely', () => {
  const resolve = resolveTarget();
  const out = resolve([held({ id: 'CE-old', emailStatus: 'done', emailStep: '3' }), held({ id: 'CE-live' })], { now: NOW });
  assert.equal(out.ok, true);
  assert.equal(out.twin.id, 'CE-live', 'the mid-sequence row is the one that resumes');
});

test('one suppressed duplicate poisons the whole address', () => {
  const resolve = resolveTarget();
  const out = resolve([held({ id: 'CE1' }), held({ id: 'CE2', notes: MANUAL_HOLD_TAG + ' [REPLY: Unsubscribed]' })], { now: NOW });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'suppressed');
});

// ── 18–20. Replies, losses, suppression precedence ──────────────────────────

test('18. a late positive reply does not auto-reactivate anything', () => {
  const lateReplied = held({ notes: MANUAL_HOLD_TAG + ' [LATE REPLY: Interested — needs review] [REPLY: Interested]' });
  assert.equal(hasManualHold(lateReplied.notes), true, 'the hold survives a late reply');
  assert.equal(resumeAtFromNotes(lateReplied.notes), null, 'no resume is scheduled automatically');
  assert.equal(deriveAutomationState(lateReplied, NOW).state, AUTOMATION_STATES.STOPPED);
  // It only becomes *eligible* for a human to reactivate.
  assert.equal(reactivationEligibility(lateReplied, { now: NOW }).eligible, true);
  // And the late-reply module never writes a resume tag.
  const lateSrc = readSource(path.join(root, 'integrations', 'late-reply.js'));
  assert.ok(!/RESUME|reactivat/i.test(lateSrc));
});

test('19/20. a recoverable loss may reactivate; hard suppression still overrides', () => {
  const { reopenEligibility, RECOVERABLE_OUTCOME_IDS } = require('../integrations/pipeline-state');
  assert.ok(RECOVERABLE_OUTCOME_IDS.includes('no_show'));
  assert.ok(RECOVERABLE_OUTCOME_IDS.includes('timing'));
  assert.equal(reopenEligibility({ stage: 'closed_lost', outcome: 'no_show' }, held()).reopenable, true);
  assert.equal(reopenEligibility({ stage: 'closed_lost', outcome: 'not_interested' }, held()).reopenable, false);
  // Suppression beats a recoverable outcome, in both models.
  const suppressed = held({ notes: MANUAL_HOLD_TAG + ' [REPLY: Unsubscribed]' });
  assert.equal(reopenEligibility({ stage: 'closed_lost', outcome: 'no_show' }, suppressed).reopenable, false);
  assert.equal(reactivationEligibility(suppressed, { now: NOW }).blocked, 'suppressed');
});

// ── 21–23. Next Action + cancellation ───────────────────────────────────────

test('21. a scheduled reactivation is an automation-owned, upcoming next action', () => {
  const action = deriveNextAction({ stage: 'follow_up' }, scheduled(FUTURE), { now: NOW });
  assert.equal(action.type, ACTION_TYPE.AUTOMATION_RESUMES);
  assert.equal(action.owner, ACTION_OWNER.AUTOMATION);
  assert.equal(action.status, ACTION_STATUS.UPCOMING, 'never overdue while legitimately held');
  assert.equal(action.dueAt, FUTURE);
  assert.match(action.label, /step 2/);
  // Indefinite hold stays the blocked case it was.
  assert.equal(deriveNextAction({ stage: 'follow_up' }, held(), { now: NOW }).type, ACTION_TYPE.BLOCKED_BY_HOLD);
});

test('a released reactivation hands back to the ordinary automation action', () => {
  const action = deriveNextAction({ stage: 'follow_up' }, scheduled(PAST), { now: NOW });
  assert.equal(action.type, ACTION_TYPE.AUTOMATED_FOLLOW_UP);
  assert.equal(action.owner, ACTION_OWNER.AUTOMATION);
  assert.equal(deriveAutomationState(scheduled(PAST), NOW).state, AUTOMATION_STATES.ACTIVE);
  assert.equal(deriveAutomationState(scheduled(FUTURE), NOW).state, AUTOMATION_STATES.SCHEDULED);
});

test('22/23. cancelling restores an indefinite hold and touches no send history', () => {
  const before = applyResumeToNotes(MANUAL_HOLD_TAG + ' promoted from reply', FUTURE);
  const after = clearResumeFromNotes(before);
  assert.ok(after.includes(MANUAL_HOLD_TAG), 'still held');
  assert.equal(resumeAtFromNotes(after), null, 'no schedule remains');
  assert.match(after, /promoted from reply/, 'unrelated notes preserved');
  const suppressionReason = agentGate();
  assert.equal(suppressionReason({ email: 'a@example.test', notes: after }), MANUAL_HOLD_TAG);
  // Cancelling only ever reduces eligibility.
  const cancelPath = serverSrc.slice(serverSrc.indexOf('if (mode === REACTIVATION_MODES.CANCEL)'));
  assert.match(cancelPath.slice(0, 900), /clearResumeFromNotes/);
  assert.ok(!/applyResumeToNotes/.test(cancelPath.slice(0, 900)));
});

// ── 24–27. Audit trail, validation, fail-closed ─────────────────────────────

test('24/25. the activity id is derived, so a repeated decision cannot stack rows', () => {
  assert.match(serverSrc, /const fingerprint = \[boardLeadId, twin\.id, eventType, metadata\.mode/);
  assert.match(serverSrc, /eventId: 'reactivation:' \+ crypto\.createHash\('sha1'\)/);
  for (const type of ['reactivation_scheduled', 'reactivation_cancelled']) {
    assert.ok(serverSrc.includes(`eventType: '${type}'`), `${type} recorded`);
  }
  // Rescheduling the same lead to the same instant is idempotent in the notes too.
  const once = applyResumeToNotes(MANUAL_HOLD_TAG, FUTURE);
  assert.equal(applyResumeToNotes(once, FUTURE), once);
  // Rescheduling to a different instant replaces rather than appends.
  const moved = applyResumeToNotes(once, '2026-10-01T00:00:00.000Z');
  assert.equal((moved.match(/\[RESUME:/g) || []).length, 1);
});

test('26. an invalid request is refused with a 4xx and changes nothing', () => {
  const handler = serverSrc.slice(serverSrc.indexOf("app.post('/api/leads/:id/reactivate'"));
  const body = handler.slice(0, handler.indexOf('\n});'));
  assert.match(body, /res\.status\(400\)\.json\(\{ error: `Unknown reactivation mode/);
  assert.match(body, /res\.status\(400\)\.json\(\{ error: 'A valid resume date\/time is required\.'/);
  assert.match(body, /res\.status\(409\)/);
  assert.match(body, /is not the next step for this lead/);
  // Every refusal returns before the write.
  const writeAt = body.indexOf('await writeColdEmailNotes(twin, scheduled)');
  assert.ok(writeAt > body.lastIndexOf('res.status(400)'), 'validation precedes the write');
});

test('27. partial failure is impossible: reactivation is a single additive write', () => {
  const handler = serverSrc.slice(serverSrc.indexOf("app.post('/api/leads/:id/reactivate'"));
  const body = handler.slice(0, handler.indexOf('\n});'));
  const writes = (body.match(/await writeColdEmailNotes\(/g) || []).length;
  assert.equal(writes, 2, 'one write for schedule, one for cancel — never both in a request');
  // Crucially there is no "remove the hold" write to race against.
  assert.ok(!/applyHoldToNotes|removeHold|clearHold/.test(body));
  // The written notes still carry the hold, so a half-applied schedule is held.
  const written = applyResumeToNotes(MANUAL_HOLD_TAG + ' x', FUTURE);
  assert.ok(written.includes(MANUAL_HOLD_TAG));
  const gate = agentGate();
  assert.equal(gate({ email: 'a@example.test', notes: written }), MANUAL_HOLD_TAG);
});

test('an unreadable suppression list refuses reactivation rather than allowing it', () => {
  assert.match(serverSrc, /code: 'suppression_unavailable'/);
  assert.match(serverSrc, /The suppression list could not be read, so reactivation is refused\./);
  assert.match(serverSrc, /async function loadSuppressionEmails\(\)/);
  // The strict reader must not swallow errors the way the lenient one does.
  const strict = serverSrc.slice(serverSrc.indexOf('async function loadSuppressionEmails'), serverSrc.indexOf('// Writes the notes cell'));
  assert.ok(!/catch/.test(strict), 'the strict reader propagates failure');
});

test('an unparseable resume tag reads as still held', () => {
  const gate = agentGate();
  const junk = { email: 'a@example.test', notes: MANUAL_HOLD_TAG + ' [RESUME: not-a-date]' };
  assert.equal(resumeAtFromNotes(junk.notes), null);
  assert.equal(gate(junk), MANUAL_HOLD_TAG);
});

// ── UI ──────────────────────────────────────────────────────────────────────

test('the drawer offers Reactivate only when the server says it is eligible', () => {
  assert.match(browser, /async function renderReactivationControls\(leadId\)/);
  assert.match(browser, /fetch\(`\/api\/leads\/\$\{encodeURIComponent\(leadId\)\}\/reactivation`\)/);
  assert.match(browser, /if \(data\.code === 'suppressed'\)/);
  assert.match(browser, /Cannot be reactivated/);
  assert.match(browser, /if \(e\.canCancel\)/);
  assert.match(browser, /Cancel reactivation/);
  assert.match(browser, /automation-pill\[data-s="scheduled"\]/);
});

test('the confirmation modal states the facts and the reassurance', () => {
  assert.match(browser, /Last email sent/);
  assert.match(browser, /Would resume with/);
  assert.match(browser, /No email is sent by this action/);
  assert.match(browser, /Keep automation paused/);
  assert.match(browser, /This is the safe default/);
  assert.match(browser, /min-height:44px/);   // mobile touch target
});

// ── No historical backfill ──────────────────────────────────────────────────

test('nothing reactivates existing leads automatically', () => {
  // No migration, no bulk write, no startup sweep.
  assert.ok(!/backfillReactivation|bulkReactivate|migrateHolds/.test(serverSrc));
  const agentWrites = agentSrc.match(/applyResumeToNotes|clearResumeFromNotes/g) || [];
  assert.equal(agentWrites.length, 0, 'the agent never writes reactivation state');
});
