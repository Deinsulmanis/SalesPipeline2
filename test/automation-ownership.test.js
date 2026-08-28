'use strict';

// Phase 2.3 — automation ownership.
//
// The invariant under test throughout: AT MOST ONE ACTOR owns an executable
// next move. Most of these tests are about refusal, because the failure mode
// that matters is two systems both deciding they may contact a prospect.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  OWNER, BLOCKED_BY, NON_COLD_STAGES,
  deriveAutomationOwnership, mayColdSend, maySequenceSend, executableOwners,
} = require('../integrations/automation-ownership');
const { REPLY_STATE, NEEDS_HUMAN_REASON } = require('../integrations/canonical-reply');
const { REPLY_ACTION } = require('../integrations/reply-operations');
const { sendSuppressionReason, MANUAL_HOLD_TAG } = require('../integrations/pipeline-state');

const root = path.join(__dirname, '..');
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
const agent = readSource(path.join(root, 'outreach-agent.js'));

const COLD = { id: 'L', company: 'Test Clinic', email: 'a@clinic.test', stage: 'Contacted', emailStatus: 'emailed', emailStep: '1', notes: '' };
const evt = (state, meta = {}, at = '2026-08-10T10:00:00.000Z') => ({
  eventId: 'gmail-reply:m1', sourceLeadId: 'L', leadId: 'CE-L', eventType: 'positive_reply',
  occurredAt: at, metadata: JSON.stringify({ canonicalState: state, gmailMessageId: 'm1', ...meta }),
});
const own = (lead, ctx = {}) => deriveAutomationOwnership(lead, {
  suppressionReason: () => null, sendingEnabled: true, coldCadenceDue: true, ...ctx,
});

// ── 1–3. Cold cadence and the Sparkle fix ───────────────────────────────────

test('1. an untouched cold lead is owned by cold automation and may send', () => {
  const o = own(COLD);
  assert.equal(o.owner, OWNER.COLD_AUTOMATION);
  assert.equal(o.sendAllowed, true);
  assert.equal(mayColdSend(o).allowed, true);
});

test('2/3. a promoted lead is never cold-eligible, with or without MANUAL HOLD', () => {
  // THE Sparkle case: stage Promoted, emailStatus emailed, step 1, NO hold.
  const sparkle = { ...COLD, company: 'Sparkle Dental Spa', stage: 'Promoted' };
  const o = own(sparkle);
  assert.equal(o.sendAllowed, false);
  assert.equal(o.blockedBy, BLOCKED_BY.PROMOTED_TO_PIPELINE);
  assert.equal(mayColdSend(o).allowed, false);
  assert.equal(o.evidence.manualHoldPresent, false, 'and it is blocked WITHOUT relying on a hold');

  // Being in the Sales Pipeline blocks it too, whatever the ColdEmail stage says.
  const inPipeline = own(COLD, { boardLead: { stage: 'follow_up' } });
  assert.equal(inPipeline.blockedBy, BLOCKED_BY.PROMOTED_TO_PIPELINE);

  // And the sender itself refuses, not just the model.
  const selector = agent.slice(agent.indexOf('function selectFollowUps'), agent.indexOf('function countTodaySends'));
  assert.match(selector, /NON_COLD_STAGES\.includes/);
  assert.ok(NON_COLD_STAGES.includes('promoted'));
});

// ── 4–7. Human ownership ────────────────────────────────────────────────────

test('4/5. a human reply or positive evaluation takes ownership from cold automation', () => {
  for (const [state, meta] of [
    [REPLY_STATE.NEEDS_HUMAN, { reason: NEEDS_HUMAN_REASON.QUESTION_OR_OBJECTION }],
    [REPLY_STATE.POSITIVE, { reason: 'explicit_evaluation_intent', evidenceSignals: ['pricing'] }],
  ]) {
    const o = own(COLD, { activities: [evt(state, meta)] });
    assert.equal(o.owner, OWNER.HUMAN, state);
    assert.equal(o.sendAllowed, false);
    assert.equal(o.blockedBy, BLOCKED_BY.HUMAN_OWNED);
  }
});

test('6/7. contact-change review blocks, and the proposed address is never a target', () => {
  const o = own(COLD, { activities: [evt(REPLY_STATE.CONTACT_CHANGE_REVIEW, { proposedEmail: 'new@x.test' })] });
  assert.equal(o.owner, OWNER.HUMAN);
  assert.equal(o.blockedBy, BLOCKED_BY.CONTACT_CHANGE_REVIEW);
  assert.equal(o.evidence.identityMutationAllowed, false);
  assert.equal(o.evidence.proposedEmail, 'new@x.test');
  // The verdict carries no instruction that could redirect a send.
  assert.equal(o.sendAllowed, false);
  assert.ok(!JSON.stringify(o).includes('sendTo'));
});

// ── 8–11. Terminal, suppressed, invalid ─────────────────────────────────────

test('8/9. terminal Won and Lost own nothing', () => {
  for (const stage of ['closed_won', 'closed_lost', 'lost']) {
    const o = own(COLD, { boardLead: { stage } });
    assert.equal(o.owner, OWNER.NONE, stage);
    assert.equal(o.blockedBy, BLOCKED_BY.TERMINAL_STAGE);
    assert.equal(o.sendAllowed, false);
  }
});

test('10. a suppressed lead owns nothing and can never send', () => {
  const o = own(COLD, { suppressionReason: () => '[REPLY: Unsubscribed]' });
  assert.equal(o.owner, OWNER.NONE);
  assert.equal(o.blockedBy, BLOCKED_BY.SUPPRESSION);
  assert.equal(o.sendAllowed, false);
  assert.equal(o.sequenceAllowed, false);
});

test('11. an invalid identity blocks everything, before any other judgement', () => {
  const o = own({ ...COLD, email: '-687-1887silverspringsspa@gmail.com' });
  assert.equal(o.owner, OWNER.NONE);
  assert.equal(o.blockedBy, BLOCKED_BY.INVALID_IDENTITY);
  // Even if it would otherwise look like an ordinary cold lead.
  assert.equal(o.sendAllowed, false);
});

// ── 12–13. Meetings ─────────────────────────────────────────────────────────

test('12. a future meeting owns the lead and stops competing automation', () => {
  const o = own(COLD, { callState: { status: 'scheduled', meetingAt: '2026-09-01T17:00:00.000Z' } });
  assert.equal(o.owner, OWNER.MEETING);
  assert.equal(o.blockedBy, BLOCKED_BY.MEETING_LIFECYCLE);
  assert.equal(o.sendAllowed, false);
  assert.equal(o.resumeAt, '2026-09-01T17:00:00.000Z');
});

test('13. an unresolved past call is human-owned until an outcome is recorded', () => {
  const o = own(COLD, { callState: { status: 'outcome_pending', meetingAt: '2026-08-01T17:00:00.000Z' } });
  assert.equal(o.owner, OWNER.HUMAN);
  assert.equal(o.resumeCondition, 'record the call outcome');
  assert.equal(o.sendAllowed, false);
});

// ── 14–17. Sequences ────────────────────────────────────────────────────────

const enrolled = { status: 'active', eligible: true, sequenceId: 'hot_stale_v1', nextDueAt: '2026-09-01T00:00:00.000Z' };

test('14. an enrolled valid sequence owns the next automated action', () => {
  const o = own(COLD, { sequenceState: enrolled, sequencesEnabled: true });
  assert.equal(o.owner, OWNER.RECOVERY_SEQUENCE);
  assert.equal(o.sequenceAllowed, true);
  assert.equal(maySequenceSend(o).allowed, true);
  assert.equal(o.sendAllowed, false, 'a sequence owning the lead does not authorise a COLD send');
});

test('15. a new human reply beats an enrolled sequence', () => {
  const o = own(COLD, {
    sequenceState: enrolled, sequencesEnabled: true,
    activities: [evt(REPLY_STATE.NEEDS_HUMAN, { reason: NEEDS_HUMAN_REASON.QUESTION_OR_OBJECTION })],
  });
  assert.equal(o.owner, OWNER.HUMAN);
  assert.equal(o.sequenceAllowed, false, 'the sequence must not run while a person owns the conversation');
});

test('16. a booking beats an enrolled sequence', () => {
  const o = own(COLD, {
    sequenceState: enrolled, sequencesEnabled: true,
    callState: { status: 'scheduled', meetingAt: '2026-09-01T17:00:00.000Z' },
  });
  assert.equal(o.owner, OWNER.MEETING);
  assert.equal(o.sequenceAllowed, false);
});

test('17. suppression beats an enrolled sequence', () => {
  const o = own(COLD, {
    sequenceState: enrolled, sequencesEnabled: true,
    suppressionReason: () => '[REPLY: Unsubscribed]',
  });
  assert.equal(o.owner, OWNER.NONE);
  assert.equal(o.sequenceAllowed, false);
});

// ── 18–19. MANUAL HOLD ──────────────────────────────────────────────────────

test('18/19. MANUAL HOLD blocks cold automation but not an explicitly enrolled sequence', () => {
  const held = { ...COLD, notes: MANUAL_HOLD_TAG };
  const real = row => sendSuppressionReason(row, { suppressedEmails: new Set() });

  const coldOnly = own(held, { suppressionReason: real });
  assert.equal(coldOnly.blockedBy, BLOCKED_BY.MANUAL_HOLD);
  assert.equal(coldOnly.sendAllowed, false, 'the hold stops cold cadence');
  assert.equal(coldOnly.sequenceAllowed, false, 'and stops sequences that were never enrolled');

  // Step 10's deliberate carve-out, preserved exactly: an EXPLICITLY enrolled
  // stage journey may still run on a held lead. The hold is about the cold
  // campaign, not about a recovery journey a human started on purpose.
  const withSequence = own(held, { suppressionReason: real, sequenceState: enrolled, sequencesEnabled: true });
  assert.equal(withSequence.sequenceAllowed, true);
  assert.equal(withSequence.sendAllowed, false, 'but never a cold send');

  // And the hold is never removed by any of this.
  assert.equal(held.notes, MANUAL_HOLD_TAG);
});

// ── 20–24. Autoresponders, closures, revisit ────────────────────────────────

test('20. a generic autoresponder creates no human ownership', () => {
  const o = own(COLD, { activities: [evt(REPLY_STATE.AUTOMATED_REPLY, { subtype: 'autoresponder' })] });
  assert.notEqual(o.owner, OWNER.HUMAN, 'a machine reply is not a conversation');
  assert.equal(o.owner, OWNER.WAITING);
  assert.equal(o.sendAllowed, false);
});

test('21/22. a temporary closure blocks until a STATED date, and invents nothing otherwise', () => {
  const dated = own(COLD, {
    activities: [evt(REPLY_STATE.AUTOMATED_REPLY, { subtype: 'temporary_closure', returnDate: '2026-12-01' })],
    now: new Date('2026-08-28T00:00:00.000Z'),
  });
  assert.equal(dated.owner, OWNER.WAITING);
  assert.equal(dated.blockedBy, BLOCKED_BY.WAITING_UNTIL_DATE);
  assert.equal(dated.resumeAt.slice(0, 10), '2026-12-01');

  // Past the date, the block lifts on its own.
  const after = own(COLD, {
    activities: [evt(REPLY_STATE.AUTOMATED_REPLY, { subtype: 'temporary_closure', returnDate: '2026-08-01' })],
    now: new Date('2026-08-28T00:00:00.000Z'),
  });
  assert.notEqual(after.blockedBy, BLOCKED_BY.WAITING_UNTIL_DATE);

  // No stated date -> no invented resume instant.
  const undated = own(COLD, { activities: [evt(REPLY_STATE.AUTOMATED_REPLY, { subtype: 'temporary_closure' })] });
  assert.equal(undated.resumeAt, null);
  assert.equal(undated.sendAllowed, false);
});

test('23/24. revisit-later blocks until a stated date and fabricates nothing without one', () => {
  const dated = own(COLD, {
    activities: [evt(REPLY_STATE.NEEDS_HUMAN, { reason: NEEDS_HUMAN_REASON.DEFERRED_TIMING, revisitDate: '2026-11-01' })],
    now: new Date('2026-08-28T00:00:00.000Z'),
  });
  assert.equal(dated.blockedBy, BLOCKED_BY.WAITING_UNTIL_DATE);
  assert.equal(dated.resumeAt.slice(0, 10), '2026-11-01');

  const undated = own(COLD, {
    activities: [evt(REPLY_STATE.NEEDS_HUMAN, { reason: NEEDS_HUMAN_REASON.DEFERRED_TIMING })],
  });
  assert.equal(undated.resumeAt, null, 'ambiguous timing never becomes a date');
  assert.equal(undated.sendAllowed, false);
});

// ── 25–28. Overrides and approvals ──────────────────────────────────────────

test('25/26/27. an action override cannot defeat suppression, terminal state or a meeting', () => {
  const forceSend = { action: REPLY_ACTION.CONTINUE_EVALUATION, reason: 'operator wants contact', by: 'deins' };
  const suppressed = own(COLD, { manualActionOverride: forceSend, suppressionReason: () => '[REPLY: Unsubscribed]' });
  assert.equal(suppressed.owner, OWNER.NONE);
  assert.equal(suppressed.sendAllowed, false);

  const terminal = own(COLD, { manualActionOverride: forceSend, boardLead: { stage: 'closed_won' } });
  assert.equal(terminal.owner, OWNER.NONE);

  const meeting = own(COLD, { manualActionOverride: forceSend, callState: { status: 'scheduled', meetingAt: '2026-09-01T17:00:00.000Z' } });
  assert.equal(meeting.owner, OWNER.MEETING);
  assert.equal(meeting.sendAllowed, false);

  // And there is no generic force-automation escape hatch anywhere.
  const src = readSource(path.join(root, 'integrations', 'automation-ownership.js'));
  for (const hatch of ['forceSend', 'forceAutomation', 'bypassSuppression', 'ignoreHold']) {
    assert.ok(!src.includes(hatch), `no ${hatch} escape hatch may exist`);
  }
});

test('28. approving a contact change does not itself resume automation', () => {
  const { buildContactChangeDecision, evaluateContactChange, CONTACT_DECISION } = require('../integrations/reply-overrides');
  const evaluation = evaluateContactChange({
    leadId: 'L', currentEmail: 'a@clinic.test', proposedEmail: 'new@clinic.test',
    leads: [{ id: 'L', email: 'a@clinic.test' }], providerEvidence: { gmailMessageId: 'm1' },
  });
  const decision = buildContactChangeDecision({
    leadId: 'L', decision: CONTACT_DECISION.APPROVED, currentEmail: 'a@clinic.test',
    proposedEmail: 'new@clinic.test', evaluation, by: 'deins',
  });
  assert.equal(decision.record.automationResumeAllowed, false);
  // Ownership is still derived independently afterwards.
  const o = own({ ...COLD, notes: MANUAL_HOLD_TAG }, {
    suppressionReason: row => sendSuppressionReason(row, { suppressedEmails: new Set() }),
  });
  assert.equal(o.sendAllowed, false, 'an approval never lifts a hold');
});

// ── 29–33. Flags, invariant, sender wiring, analytics ───────────────────────

test('29. SENDING_ENABLED=false prevents execution even when cold automation owns the lead', () => {
  const o = own(COLD, { sendingEnabled: false });
  assert.equal(o.owner, OWNER.COLD_AUTOMATION, 'ownership is unchanged...');
  assert.equal(o.sendAllowed, false, '...but nothing may execute');
  assert.equal(o.blockedBy, BLOCKED_BY.SENDING_DISABLED);
  assert.equal(mayColdSend(o).allowed, false);
});

test('30. STAGE_SEQUENCES_ENABLED=false prevents sequence execution', () => {
  const o = own(COLD, { sequenceState: enrolled, sequencesEnabled: false });
  assert.equal(o.owner, OWNER.RECOVERY_SEQUENCE);
  assert.equal(o.sequenceAllowed, false);
  assert.equal(o.blockedBy, BLOCKED_BY.SEQUENCES_DISABLED);
  assert.equal(maySequenceSend(o).allowed, false);
});

test('31. no lead ever has two executable automation owners', () => {
  const scenarios = [
    {}, { sequenceState: enrolled, sequencesEnabled: true },
    { boardLead: { stage: 'hot' } }, { callState: { status: 'scheduled', meetingAt: '2026-09-01T00:00:00Z' } },
    { activities: [evt(REPLY_STATE.POSITIVE, { reason: 'explicit_evaluation_intent' })] },
    { suppressionReason: () => '[MANUAL HOLD]', sequenceState: enrolled, sequencesEnabled: true },
    { activities: [evt(REPLY_STATE.AUTOMATED_REPLY, { subtype: 'temporary_closure', returnDate: '2026-12-01' })] },
  ];
  for (const ctx of scenarios) {
    const o = own(COLD, ctx);
    assert.ok(executableOwners(o).length <= 1,
      `two executable owners for ${JSON.stringify(ctx).slice(0, 60)}: ${executableOwners(o)}`);
  }
});

test('32. canonical ownership reaches the actual provider send gate', () => {
  // The sender must ASK the shared model, not keep a second opinion.
  assert.match(agent, /const \{ NON_COLD_STAGES, deriveAutomationOwnership, mayColdSend \} = require\('\.\/integrations\/automation-ownership'\)/);
  assert.match(agent, /function coldSendGate\(lead, context = null\)/);
  // The gate must see BOARD and ACTIVITY context, not just the ColdEmail row —
  // otherwise the audit can say "blocked, this lead is promoted" while the
  // runtime sender has no pipeline to look at.
  assert.match(agent, /const \[ownershipBoard, ownershipActivities\] = await Promise\.all\(/);
  assert.match(agent, /buildOwnershipContext\(\{/);
  assert.match(agent, /coldSendGate\(lead, ownershipContext\)/);
  // A failed board read fails CLOSED rather than silently weakening the check.
  assert.match(agent, /pipeline context unavailable this pass — failing closed/);
  // Context is built from ONE read each, never per candidate.
  const sendPass = agent.slice(agent.indexOf('const all = await withAuth(readLeads)'), agent.indexOf('// ── New sends (step 1)'));
  assert.ok(!/for\s*\([^)]*\)\s*\{[^}]*await[^}]*spreadsheets/.test(sendPass), 'no per-candidate sheet read');
  assert.match(agent, /return \{ ownership, verdict: mayColdSend\(ownership\) \};/);
  // Every send loop consults it and refuses on a negative verdict.
  const gates = agent.match(/if \(!gate\.verdict\.allowed\) \{/g) || [];
  assert.ok(gates.length >= 3, `expected >=3 gated send loops, found ${gates.length}`);
  assert.match(agent, /\[OWNERSHIP\] refusing/);
});

test('33. ownership changes no reply classification or analytics', () => {
  const activities = [evt(REPLY_STATE.POSITIVE, { reason: 'explicit_evaluation_intent' })];
  const before = JSON.stringify({ COLD, activities });
  const o = own(COLD, { activities });
  assert.equal(JSON.stringify({ COLD, activities }), before, 'inputs untouched');
  assert.equal(o.evidence.canonicalState, REPLY_STATE.POSITIVE, 'classification is read, never rewritten');
  // The module cannot write anything at all.
  const src = readSource(path.join(root, 'integrations', 'automation-ownership.js'));
  for (const forbidden of ['values.update', 'values.append', 'batchUpdate', 'sendEmail', 'googleapis', 'fetch(']) {
    assert.ok(!src.includes(forbidden), `ownership must not reference ${forbidden}`);
  }
});

// ── Fail-closed on an unrecorded human touch ────────────────────────────────

test('a manual outbound touch the CRM never recorded holds automation closed', () => {
  // Found in production: six manual emails to real leads with no canonical
  // record. Automation must not reason from a timeline it knows is incomplete.
  const o = own(COLD, { unrecordedHumanTouch: true, humanTouchAt: '2026-08-27T21:07:00.000Z' });
  assert.equal(o.owner, OWNER.HUMAN);
  assert.equal(o.blockedBy, BLOCKED_BY.UNRECORDED_HUMAN_TOUCH);
  assert.equal(o.sendAllowed, false);
  assert.match(o.resumeCondition, /record the manual touch/);
});

test('an unrecognised or empty state fails closed rather than defaulting to send', () => {
  assert.equal(deriveAutomationOwnership({}, {}).sendAllowed, false);
  assert.equal(deriveAutomationOwnership({ id: 'x' }, {}).blockedBy, BLOCKED_BY.INVALID_IDENTITY);
  assert.equal(mayColdSend(null).allowed, false);
  assert.equal(maySequenceSend(undefined).allowed, false);
  // Sending disabled is the default when no flag is supplied.
  assert.equal(deriveAutomationOwnership(COLD, { suppressionReason: () => null, coldCadenceDue: true }).sendAllowed, false);
});
