'use strict';

// Each test below maps to one of the 15 audited lead journeys. The point is not
// coverage for its own sake: these lock in the answers the audit established, so
// a later change to the pipeline that reopens a leak fails here first.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  AUTOMATION_STATES, MANUAL_HOLD_TAG, HUMAN_OWNED_STAGES,
  OUTCOMES, OUTCOME_IDS, LOSS_OUTCOME_IDS, RECOVERABLE_OUTCOME_IDS,
  deriveAutomationState, automationConflict, deriveNextAction,
  stageTransitionCheck, reopenEligibility,
} = require('../integrations/pipeline-state');

const root = path.join(__dirname, '..');
const agent = fs.readFileSync(path.join(root, 'outreach-agent.js'), 'utf8');
const browser = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

// ── 1. Cold email sent, no engagement ───────────────────────────────────────
test('scenario 1: Pipeline ownership suppresses the stale cold cadence display', () => {
  const twin = { emailStatus: 'emailed', emailStep: '1', lastEmailedAt: '2026-08-01T00:00:00Z' };
  assert.equal(deriveAutomationState(twin).state, AUTOMATION_STATES.ACTIVE);
  const next = deriveNextAction({ stage: 'follow_up' }, twin);
  assert.equal(next.action, 'Review Pipeline follow-up');
  assert.equal(next.dueAt, null);
  assert.equal(next.needsAttention, true);
});

test('scenario 1b: a lead past the last step remains an explicit Pipeline review', () => {
  // This is the documented leak: step 3 of 3 sent, nothing schedules anything else.
  const twin = { emailStatus: 'done', emailStep: '3', lastEmailedAt: '2026-08-01T00:00:00Z' };
  assert.equal(deriveAutomationState(twin).state, AUTOMATION_STATES.STOPPED);
  const next = deriveNextAction({ stage: 'follow_up' }, twin);
  assert.equal(next.action, 'Review Pipeline follow-up');
  assert.equal(next.needsAttention, true);
});

// ── 2 & 3. Demo played, once and repeatedly ─────────────────────────────────
test('scenario 2/3: the demo trigger is deduped durably by leadId|trigger, not by timestamp', () => {
  // Repeated plays must log but must never re-fire the booking-link email.
  assert.match(agent, /loadFiredIntents/);
  assert.match(agent, /\$\{row\[1\]\}\|\$\{row\[4\] \|\| 'both-audios'\}/);
  assert.match(agent, /if \(fired\.has\(`\$\{lead\.id\}\|both-audios`\)\) continue;/);
  // and the fire is recorded BEFORE any later step can throw
  assert.match(agent, /Record the fire BEFORE anything else can fail/);
});

test('scenario 3: repeated demo plays collapse to a pair test rather than a counter', () => {
  assert.match(agent, /if \(!p \|\| p\.intro < 1 \|\| p\.demo < 1\) continue;/);
});

// ── 4. Positive reply ───────────────────────────────────────────────────────
test('scenario 4: a replied lead stops automation and is excluded from every send selector', () => {
  const twin = { emailStatus: 'replied', emailStep: '1' };
  assert.equal(deriveAutomationState(twin).state, AUTOMATION_STATES.STOPPED);
  assert.match(agent, /function selectFollowUps[\s\S]{0,200}emailStatus !== 'emailed'/);
  // the intent (demo) trigger also refuses to mail a lead already in conversation
  assert.match(agent, /lead\.emailStatus === 'replied' \|\| lead\.stage === 'Replied'/);
});

test('scenario 4b: Hot with no follow-up date has no defined next step', () => {
  const next = deriveNextAction({ stage: 'hot' }, { emailStatus: 'replied' });
  assert.equal(next.needsAttention, true);
  assert.equal(next.dueAt, null);
  // a human-set date resolves it
  const dated = deriveNextAction({ stage: 'hot', followup: '2026-09-01' }, { emailStatus: 'replied' });
  assert.equal(dated.needsAttention, false);
  assert.equal(dated.source, 'followup-field');
});

// ── 5. Neutral / ambiguous reply ────────────────────────────────────────────
test('scenario 5: ambiguous replies still halt the sequence and fall back to NEEDS_HUMAN', () => {
  const { deterministicReplyCategory, CLASSIFY_FALLBACK } = require('../integrations/reply-classifier');
  assert.equal(CLASSIFY_FALLBACK, 'NEEDS_HUMAN');
  assert.equal(deterministicReplyCategory('Who is this?'), 'QUESTION');
  assert.equal(deterministicReplyCategory('What does it cost?'), 'QUESTION');
  // "Maybe later" matches no deterministic rule -> defers to the model/fallback
  assert.equal(deterministicReplyCategory('Maybe later'), '');
  // regardless of category, the reply pass marks the lead replied before routing
  assert.match(agent, /lead\.emailStatus = 'replied'; \/\/ exclude from follow-ups this run regardless of classification/);
});

// ── 6. Negative reply / opt-out ─────────────────────────────────────────────
test('scenario 6: opt-out is durable, email-keyed, and survives row deletion', () => {
  const twin = { emailStatus: 'emailed', emailStep: '1', notes: '[REPLY: Unsubscribed] earlier note' };
  assert.equal(deriveAutomationState(twin).state, AUTOMATION_STATES.STOPPED);
  const bounced = { emailStatus: 'emailed', emailStep: '1', notes: '[BOUNCED 2026-08-01]' };
  assert.equal(deriveAutomationState(bounced).state, AUTOMATION_STATES.STOPPED);
  // suppression is enforced at send in every loop, not only at selection
  const guards = agent.match(/const suppressed = suppressionReason\(lead\);/g) || [];
  assert.ok(guards.length >= 4, 'expected a suppression guard in every send loop, found ' + guards.length);
});

test('scenario 6b: a suppressed lead can never be reopened automatically', () => {
  const r = reopenEligibility({ stage: 'closed_lost', outcome: 'ghosted' }, { notes: '[REPLY: Unsubscribed]' });
  assert.equal(r.reopenable, false);
  assert.equal(r.blocked, 'suppression');
});

// ── 7. Manual intervention ──────────────────────────────────────────────────
test('scenario 7: THE LEAK — a human-owned board stage does not stop the sending agent', () => {
  const twin = { emailStatus: 'emailed', emailStep: '1', lastEmailedAt: '2026-08-01T00:00:00Z' };
  for (const stage of HUMAN_OWNED_STAGES) {
    const conflict = automationConflict({ stage }, twin);
    assert.ok(conflict, 'expected a conflict for board stage ' + stage);
    assert.equal(conflict.state, AUTOMATION_STATES.ACTIVE);
  }
  // no conflict once the sequence is genuinely stopped
  assert.equal(automationConflict({ stage: 'hot' }, { emailStatus: 'replied' }), null);
  // follow_up is not human-owned, so it is not a conflict
  assert.equal(automationConflict({ stage: 'follow_up' }, twin), null);
});

test('scenario 7b: the manual-hold tag stops automation and clears the conflict', () => {
  const twin = { emailStatus: 'emailed', emailStep: '1', notes: MANUAL_HOLD_TAG };
  const held = deriveAutomationState(twin);
  assert.equal(held.state, AUTOMATION_STATES.STOPPED);
  assert.match(held.reason, /manual hold/);
  // the red banner must clear because the DATA changed, not because it is hidden
  for (const stage of HUMAN_OWNED_STAGES) {
    assert.equal(automationConflict({ stage }, twin), null, 'conflict should clear for ' + stage);
  }
});

test('a manual hold does not disqualify a lead from being reopened', () => {
  // unlike unsubscribe/bounce, which must never be reversed
  const r = reopenEligibility({ stage: 'closed_lost', outcome: 'ghosted' }, { notes: MANUAL_HOLD_TAG });
  assert.equal(r.reopenable, true);
  assert.match(r.caution, /MANUAL HOLD/);
});

// ── 8. Call booked ──────────────────────────────────────────────────────────
test('scenario 8: Call Booked requires a meeting time and yields a dated next action', () => {
  assert.equal(stageTransitionCheck('call_booked', {}).ok, false);
  assert.equal(stageTransitionCheck('call_booked', { meetingAt: '2026-09-01T17:00:00Z' }).ok, true);
  // Renamed to the canonical 'Sales call' when this became the shared Next
  // Action engine; the meeting still supplies the date and now the ownership.
  const next = deriveNextAction({ stage: 'call_booked', meetingAt: '2026-09-01T17:00:00Z' },
    null, { now: new Date('2026-08-26T00:00:00Z') });
  assert.equal(next.action, 'Sales call');
  assert.equal(next.dueAt, '2026-09-01T17:00:00Z');
  assert.equal(next.owner, 'meeting');
});

test('scenario 8b: booked lead with the meeting time cleared surfaces as needing attention', () => {
  const next = deriveNextAction({ stage: 'call_booked' }, null);
  assert.equal(next.action, 'Confirm meeting time');
  assert.equal(next.needsAttention, true);
});

// ── 9 & 10. Cancelled / rescheduled / no-show ───────────────────────────────
test('scenario 9/10: no-show and timing are recoverable losses, not permanent ones', () => {
  assert.ok(RECOVERABLE_OUTCOME_IDS.includes('no_show'));
  assert.ok(RECOVERABLE_OUTCOME_IDS.includes('timing'));
  assert.ok(RECOVERABLE_OUTCOME_IDS.includes('ghosted'));
  assert.ok(!RECOVERABLE_OUTCOME_IDS.includes('not_interested'));
  assert.ok(!RECOVERABLE_OUTCOME_IDS.includes('not_fit'));
  // a no-show can be reopened; a bad fit cannot
  assert.equal(reopenEligibility({ stage: 'closed_lost', outcome: 'no_show' }, null).reopenable, true);
  assert.equal(reopenEligibility({ stage: 'closed_lost', outcome: 'not_fit' }, null).reopenable, false);
});

// ── 11. Ghosted after a positive conversation ───────────────────────────────
test('scenario 11: a ghosted Hot lead is still flagged, now as needing review', () => {
  // Step 8 replaced the generic "no date set" gap with a Hot-specific review
  // action. The invariant this scenario protects is unchanged: a quiet Hot
  // lead must never sit silently — it still demands attention.
  const next = deriveNextAction({ stage: 'hot' }, { emailStatus: 'replied' });
  assert.equal(next.needsAttention, true);
  assert.match(next.action, /Review Hot lead/);
  assert.equal(next.hotState.staleness, 'unknown');
  assert.equal(next.hotState.hasConversationEvidence, false);
});

// ── 12. Closed Won vs Closed Lost ───────────────────────────────────────────
test('scenario 12: Closed Won is its own stage and is no longer a loss outcome', () => {
  assert.ok(!OUTCOME_IDS.includes('closed_won'), 'closed_won must not remain an outcome now that it is a stage');
  assert.ok(!LOSS_OUTCOME_IDS.includes('closed_won'));
  // and it must not satisfy the Closed / Lost gate
  assert.equal(stageTransitionCheck('closed_lost', { outcome: 'closed_won' }).ok, false);
  const won = deriveNextAction({ stage: 'closed_won' }, { emailStatus: 'done' });
  assert.equal(won.needsAttention, false);
});

// ── 13. Loss reasons ────────────────────────────────────────────────────────
test('scenario 13: the loss taxonomy covers every reason the audit called for', () => {
  for (const id of ['ghosted', 'not_interested', 'not_fit', 'timing', 'no_show', 'other']) {
    assert.ok(LOSS_OUTCOME_IDS.includes(id), 'missing loss reason: ' + id);
  }
  assert.equal(stageTransitionCheck('closed_lost', {}).ok, false);
  assert.equal(stageTransitionCheck('closed_lost', { outcome: 'timing' }).ok, true);
  // every outcome the UI offers must exist in the model
  for (const o of OUTCOMES) assert.equal(typeof o.label, 'string');
});

// ── 14 & 15. Reply or booking after being marked lost ───────────────────────
test('scenario 14/15: reopening is allowed but must never re-enter the cold sequence', () => {
  const r = reopenEligibility({ stage: 'closed_lost', outcome: 'ghosted' }, { emailStatus: 'done', emailStep: '3' });
  assert.equal(r.reopenable, true);
  assert.match(r.caution, /do NOT clear emailStatus/);
  // a lead that is not closed/lost is not a reopen candidate
  assert.equal(reopenEligibility({ stage: 'hot' }, null).reopenable, false);
});

test('scenario 14b: active reply polling stays isolated from the bounded terminal watcher', () => {
  // Active polling keeps its original selector. Terminal polling is a separate,
  // once-daily path and therefore cannot re-enter the active automation flow.
  assert.match(agent, /const candidates = leads\.filter\(l => l\.emailStatus === 'emailed' && isValidEmail\(l\.email\)\);/);
  assert.match(agent, /await runLateReplyCheckPass\(all\);/);
});

// ── Cross-cutting invariants ────────────────────────────────────────────────
test('board-only leads report unknown automation rather than pretending to be safe', () => {
  const d = deriveAutomationState(null);
  assert.equal(d.state, AUTOMATION_STATES.UNKNOWN);
  assert.equal(automationConflict({ stage: 'hot' }, null), null);
});

test('a queued-but-unsent lead counts as active automation', () => {
  assert.equal(deriveAutomationState({ emailStatus: '', stage: 'Queued' }).state, AUTOMATION_STATES.ACTIVE);
  assert.equal(deriveAutomationState({ emailStatus: '', stage: 'Import' }).state, AUTOMATION_STATES.NEVER);
});

test('the dashboard renders automation state and next action', () => {
  assert.match(browser, /Automation/);
  assert.match(browser, /Next action/i);
  assert.match(browser, /automation-conflict/);
});

test('the dashboard outcome picker matches the shared outcome model exactly', () => {
  const select = browser.match(/<select id="d-outcome">([\s\S]*?)<\/select>/);
  assert.ok(select, 'outcome select not found');
  const ids = [...select[1].matchAll(/value="([^"]*)"/g)].map(m => m[1]).filter(Boolean);
  assert.deepEqual(ids, OUTCOME_IDS, 'UI outcome list has drifted from pipeline-state.js');
});
