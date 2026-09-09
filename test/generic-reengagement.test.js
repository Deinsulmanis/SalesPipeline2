'use strict';
/**
 * generic_follow_up_v1 — the re-engagement journey for sequence-exhausted
 * prospects who never replied.
 *
 * The two properties worth stating plainly, because everything else follows:
 *
 *  1. Step 1 opens a FRESH Gmail thread and Step 2 pins to the thread Step 1
 *     created. The ambiguous historical thread is never used at either step.
 *  2. Deploying this code cannot mail the historical backlog. The rollout gate
 *     and the placeholder-copy refusal both fail closed independently.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const {
  GENERIC_SEQUENCE_ID, genericConfig, genericEligibility, genericJourneyThread,
  selectPilotCohort, genericEnrollmentEventId, renderGenericCopy, finalColdEmailAt,
} = require('../integrations/generic-reengagement');
const {
  SEQUENCES, buildSequenceEmail, deriveSequenceState, evaluateStageSequence,
  provenSequenceSenderId, sequenceStepEventId, sequenceStopReason,
} = require('../integrations/stage-sequences');
const { stageSendGate } = require('../integrations/pipeline-sequence-safety');
const { deriveAutomationOwnership } = require('../integrations/automation-ownership');

// Windows checkouts use core.autocrlf, so source slices normalise line endings.
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');

const NOW = Date.parse('2026-09-09T12:00:00.000Z');
const daysAgo = n => new Date(NOW - n * 86400000).toISOString();

// A rollout cutoff far in the past, so age rules are what these tests exercise.
// The cutoff itself is tested separately (Y).
const CFG = { ...genericConfig({ GENERIC_REENGAGEMENT_ENABLED: '1' }), autoEnrollAfter: '2000-01-01T00:00:00.000Z' };

const TEMPLATES = [
  { subjectFresh: 'Still worth a look, {{company}}?', subjectThread: 'Re: still worth a look, {{company}}?',
    body: ['{{salutation}}', '', 'Never heard either way — worth a look now?', '', 'Deins'].join('\n') },
  { subjectFresh: 'Closing the file on {{company}}', subjectThread: 'Re: closing the file on {{company}}',
    body: ['{{salutation}}', '', 'Last note from me.', '', 'Deins'].join('\n') },
];
const copyOpts = { campaignTemplates: TEMPLATES };

const twinOf = (over = {}) => ({
  id: 'L1', email: 'info@cityclinic.com', company: 'City Clinic', contactName: 'Dr Sarah Chen',
  stage: 'Done', emailStatus: 'done', emailStep: '3', notes: '',
  lastEmailedAt: daysAgo(40), senderInboxId: 'primary', campaign: 'toronto-medspa-jul', ...over,
});
const ev = (eventType, occurredAt, metadata = {}) => ({
  eventId: `${eventType}:${occurredAt}`, eventType, occurredAt, metadata: JSON.stringify(metadata),
});
// The reconciliation event every historical prospect now carries.
const senderEvidence = (over = {}) => ev('sender_evidence_reconciled', daysAgo(40),
  { senderInboxId: 'primary', gmailThreadId: '', ...over });

function decide(over = {}, activities = [senderEvidence()], config = CFG, extra = {}) {
  const twin = twinOf(over);
  return genericEligibility({
    twin, activities, now: NOW, config,
    senderProof: provenSequenceSenderId(twin, activities), ...extra,
  });
}

// ── ELIGIBILITY ─────────────────────────────────────────────────────────────

test('A. cold sequence complete + 30 days + clean state → eligible', () => {
  const verdict = decide();
  assert.equal(verdict.eligible, true, verdict.blockers.join('; '));
  assert.equal(verdict.sequenceId, GENERIC_SEQUENCE_ID);
  assert.equal(verdict.senderInboxId, 'primary', 'the historically proven sender is preserved');
  assert.equal(verdict.ageDays, 40);
  assert.deepEqual(verdict.blockers, []);
});

test('B. 29 days quiet → not eligible', () => {
  const verdict = decide({ lastEmailedAt: daysAgo(29) });
  assert.equal(verdict.eligible, false);
  assert.match(verdict.blockers.join(' '), /only 29d since the final cold email/);
});

test('C. 61+ days quiet → not automatically eligible (recycle case, not this journey)', () => {
  const verdict = decide({ lastEmailedAt: daysAgo(61) });
  assert.equal(verdict.eligible, false);
  assert.match(verdict.blockers.join(' '), /exceeds the 60d window/);
  // 60 exactly is still inside the window — the boundary is inclusive.
  assert.equal(decide({ lastEmailedAt: daysAgo(60) }).eligible, true);
  assert.equal(decide({ lastEmailedAt: daysAgo(30) }).eligible, true);
});

test('D. a positive reply → not eligible', () => {
  const verdict = decide({}, [senderEvidence(), ev('positive_reply', daysAgo(20))]);
  assert.equal(verdict.eligible, false);
  assert.ok(verdict.blockers.includes('the prospect replied'));
});

test('E. negative / not-interested → not eligible, by event AND by legacy notes tag', () => {
  assert.equal(decide({}, [senderEvidence(), ev('negative_reply', daysAgo(20))]).eligible, false);
  // The historical cohort predates the activity model: its ONLY reply evidence
  // is the notes tag, so that has to block too.
  const legacy = decide({ notes: '[REPLY: Not Interested]' });
  assert.equal(legacy.eligible, false);
  assert.ok(legacy.blockers.some(b => /negative reply or unsubscribe/.test(b)));
});

test('F. unsubscribe / suppression / bounce → not eligible', () => {
  assert.equal(decide({ stage: 'Unsubscribed' }).eligible, false);
  assert.equal(decide({ notes: '[BOUNCED]' }).eligible, false);
  assert.equal(decide({ notes: '[REPLY: Unsubscribed]' }).eligible, false);
  const listed = genericEligibility({
    twin: twinOf(), activities: [senderEvidence()], now: NOW, config: CFG,
    suppressedEmails: new Set(['info@cityclinic.com']),
    senderProof: provenSequenceSenderId(twinOf(), [senderEvidence()]),
  });
  assert.equal(listed.eligible, false);
  assert.ok(listed.blockers.includes('on the durable suppression list'));
});

test('G. a booked meeting → not eligible', () => {
  assert.equal(decide({}, [senderEvidence(), ev('call_booked', daysAgo(10))]).eligible, false);
  const scheduled = decide({}, [senderEvidence()], CFG, { callState: { status: 'scheduled' } });
  assert.equal(scheduled.eligible, false);
  assert.ok(scheduled.blockers.includes('a meeting is on the calendar'));
});

test('H. MANUAL HOLD → not eligible and not executable', () => {
  const verdict = decide({ notes: '[MANUAL HOLD]' });
  assert.equal(verdict.eligible, false);
  assert.ok(verdict.blockers.includes('MANUAL HOLD'));
  // And a hold still blocks an ALREADY enrolled generic journey: it is not one
  // of the explicit lifecycle journeys allowed to run underneath a hold.
  const stop = sequenceStopReason({
    twin: twinOf({ notes: '[MANUAL HOLD]' }), boardLead: {}, activities: [],
    enrolledAt: daysAgo(2), sequenceId: GENERIC_SEQUENCE_ID,
  });
  assert.match(stop, /manual hold/);
});

test('I. manual outbound by a human → not eligible', () => {
  const verdict = decide({}, [senderEvidence(), ev('human_response_sent', daysAgo(5))]);
  assert.equal(verdict.eligible, false);
  assert.ok(verdict.blockers.includes('a human took the conversation over'));
});

test('J/K. any other journey already owning the lead → generic cannot own it', () => {
  for (const other of ['demo_follow_up_v1', 'hot_stale_v1', 'no_show_recovery_v1', 'timing_recontact_v1']) {
    const activities = [senderEvidence(), ev('sequence_enrolled', daysAgo(3), { sequenceId: other })];
    const verdict = decide({}, activities);
    assert.equal(verdict.eligible, false, `${other} must exclude generic`);
    assert.ok(verdict.blockers.some(b => b.includes(other)), `${other} named in the blocker`);
  }
});

test('L. sender ownership not proven → blocked', () => {
  const twin = twinOf({ senderInboxId: '' });
  const verdict = genericEligibility({
    twin, activities: [], now: NOW, config: CFG,
    senderProof: provenSequenceSenderId(twin, []),
  });
  assert.equal(verdict.eligible, false);
  assert.ok(verdict.blockers.some(b => /sender ownership is not proven/.test(b)));
  // A conflict between two mailboxes is equally fatal.
  const conflicted = [senderEvidence(), ev('follow_up_sent', daysAgo(38), { senderInboxId: 'tryscalelabai' })];
  const twin2 = twinOf();
  const verdict2 = genericEligibility({
    twin: twin2, activities: conflicted, now: NOW, config: CFG,
    senderProof: provenSequenceSenderId(twin2, conflicted),
  });
  assert.equal(verdict2.eligible, false);
  assert.ok(verdict2.blockers.some(b => /conflict/.test(b)));
});

test('M. an unknown/ambiguous OLD thread is STILL eligible — that is the whole point', () => {
  // 327 of 329 historical prospects are in exactly this state.
  const verdict = decide({}, [senderEvidence({ gmailThreadId: '' })]);
  assert.equal(verdict.eligible, true, verdict.blockers.join('; '));
  const thread = genericJourneyThread([senderEvidence({ gmailThreadId: '' })], { step: 1 });
  assert.equal(thread.ok, true);
  assert.equal(thread.mode, 'fresh');
  assert.equal(thread.thread, null);
});

test('Z. opens never affect eligibility, ownership or stopping', () => {
  const plain = decide({ notes: '' });
  const opened = decide({ notes: 'open-triggered | open-triggered' });
  assert.equal(plain.eligible, opened.eligible);
  assert.equal(opened.eligible, true, opened.blockers.join('; '));
  // No open signal appears anywhere in the journey's decision surface.
  const source = readSource('integrations/generic-reengagement.js');
  assert.doesNotMatch(source, /open[-_ ]?(rate|triggered|count)/i,
    'open history must not be part of generic re-engagement logic');
});

// ── THREADING ───────────────────────────────────────────────────────────────

test('N. Step 1 opens a fresh thread and refuses any thread it is handed', () => {
  const built = buildSequenceEmail(GENERIC_SEQUENCE_ID, 1, twinOf(),
    { thread: { threadId: 'OLD', rfcMessageId: '<old@m>' }, ...copyOpts });
  assert.equal(built.replyToThread, false, 'never replies into a supplied thread');
  assert.equal(built.threadId, '');
  assert.equal(built.inReplyTo, '');
  assert.doesNotMatch(built.subject, /^Re:/, 'and never fakes Re: on a new conversation');
  assert.equal(SEQUENCES[GENERIC_SEQUENCE_ID].freshThreadStep1, true);
});

test('O. Step 2 pins to the NEW thread Step 1 created', () => {
  const step1 = ev('sequence_step_sent', daysAgo(8), {
    sequenceId: GENERIC_SEQUENCE_ID, step: 1, gmailThreadId: 'NEW',
    providerMessageId: 'gm-1', rfcMessageId: '<new@m>', senderInboxId: 'primary',
  });
  const resolved = genericJourneyThread([senderEvidence({ gmailThreadId: 'OLD' }), step1],
    { step: 2, senderInboxId: 'primary' });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.mode, 'pinned');
  assert.equal(resolved.thread.threadId, 'NEW');
  assert.equal(resolved.thread.rfcMessageId, '<new@m>');
  const built = buildSequenceEmail(GENERIC_SEQUENCE_ID, 2, twinOf(), { thread: resolved.thread, ...copyOpts });
  assert.equal(built.replyToThread, true);
  assert.equal(built.threadId, 'NEW');
  assert.match(built.subject, /^Re: /);
});

test('P. Step 2 can never fall back to the OLD historical thread', () => {
  const historical = [senderEvidence({ gmailThreadId: 'OLD' })];
  // No Step 1 record at all: fail closed rather than reuse the old thread.
  const missing = genericJourneyThread(historical, { step: 2, senderInboxId: 'primary' });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /Step 1 send record is missing/);

  // A Step 1 that never proved provider delivery is not a thread either.
  const unproven = ev('sequence_step_sent', daysAgo(8),
    { sequenceId: GENERIC_SEQUENCE_ID, step: 1, gmailThreadId: 'NEW', providerMessageId: '' });
  assert.equal(genericJourneyThread([...historical, unproven], { step: 2 }).ok, false);

  // A Step 1 with no thread id is not a thread either.
  const noThread = ev('sequence_step_sent', daysAgo(8),
    { sequenceId: GENERIC_SEQUENCE_ID, step: 1, gmailThreadId: '', providerMessageId: 'gm-1' });
  assert.match(genericJourneyThread([...historical, noThread], { step: 2 }).reason, /did not persist a Gmail thread/);

  // A Step 1 from a DIFFERENT mailbox may not be continued from this one.
  const wrongBox = ev('sequence_step_sent', daysAgo(8), {
    sequenceId: GENERIC_SEQUENCE_ID, step: 1, gmailThreadId: 'NEW',
    providerMessageId: 'gm-1', senderInboxId: 'tryscalelabai',
  });
  assert.match(genericJourneyThread([wrongBox], { step: 2, senderInboxId: 'primary' }).reason, /different mailbox/);

  // Another journey's step 1 is not this journey's step 1.
  const otherJourney = ev('sequence_step_sent', daysAgo(8),
    { sequenceId: 'demo_follow_up_v1', step: 1, gmailThreadId: 'DEMO', providerMessageId: 'gm-9' });
  assert.equal(genericJourneyThread([otherJourney], { step: 2 }).ok, false);
});

// ── SEND GATE ───────────────────────────────────────────────────────────────

const sender = { id: 'primary', email: 'deins@scalelabai.ca', sendEligible: true, dailyLimit: 40 };
const gateInput = (over = {}) => ({
  checkOnly: false, sendingEnabled: true, senderProof: { ok: true, senderInboxId: 'primary' },
  sender, thread: null, threadVerified: false, observationOk: true,
  senderCount: 0, globalCount: 0, globalLimit: 80, freshThreadAllowed: true, ...over,
});

test('Q. an unhealthy observer blocks the send', () => {
  const gate = stageSendGate(gateInput({ observationOk: false }));
  assert.equal(gate.allowed, false);
  assert.equal(gate.code, 'observation_failed');
});

test('U. quota exhaustion waits safely rather than sending', () => {
  assert.equal(stageSendGate(gateInput({ senderCount: 40 })).code, 'sender_quota');
  assert.equal(stageSendGate(gateInput({ globalCount: 80 })).code, 'global_quota');
  // Waiting is not failing: the same lead passes once quota frees up.
  assert.equal(stageSendGate(gateInput({ senderCount: 39, globalCount: 79 })).allowed, true);
});

test('the fresh-thread exception is opt-in and cannot leak to other journeys', () => {
  // Step 1 of the generic journey: no thread required.
  assert.equal(stageSendGate(gateInput()).allowed, true);
  assert.equal(stageSendGate(gateInput()).code, 'ready_fresh_thread');
  // Every other journey still REQUIRES a proven, verified thread.
  const strict = stageSendGate(gateInput({ freshThreadAllowed: false }));
  assert.equal(strict.allowed, false);
  assert.equal(strict.code, 'thread_unproven');
  assert.equal(stageSendGate(gateInput({
    freshThreadAllowed: false, thread: { threadId: 'T' }, threadVerified: false,
  })).code, 'thread_mismatch');
  // Asking for a fresh thread while supplying one is a contradiction, not a pass.
  assert.equal(stageSendGate(gateInput({ thread: { threadId: 'T' } })).code, 'fresh_thread_conflict');
  // Step 2 goes through the ordinary strict path.
  assert.equal(stageSendGate(gateInput({
    freshThreadAllowed: false, thread: { threadId: 'NEW' }, threadVerified: true,
  })).allowed, true);
});

test('CHECK_ONLY and the kill switch both refuse before anything else is considered', () => {
  assert.equal(stageSendGate(gateInput({ checkOnly: true })).code, 'check_only');
  assert.equal(stageSendGate(gateInput({ sendingEnabled: false })).code, 'sending_disabled');
  assert.equal(stageSendGate(gateInput({ senderProof: { ok: false, reason: 'x' } })).code, 'sender_unproven');
});

// ── STOP CONDITIONS AFTER STEP 1 ────────────────────────────────────────────

const enrolledActivities = (extra = []) => ([
  senderEvidence(),
  ev('sequence_enrolled', daysAgo(9), { sequenceId: GENERIC_SEQUENCE_ID, senderInboxId: 'primary' }),
  ev('sequence_step_sent', daysAgo(8), {
    sequenceId: GENERIC_SEQUENCE_ID, step: 1, gmailThreadId: 'NEW',
    providerMessageId: 'gm-1', rfcMessageId: '<new@m>', senderInboxId: 'primary',
  }),
  ...extra,
]);

const evaluate = (extra = [], twinOver = {}) => evaluateStageSequence({
  boardLead: {}, twin: twinOf(twinOver), activities: enrolledActivities(extra),
  now: NOW, featureEnabled: true,
});

test('R. a reply after Step 1 cancels Step 2', () => {
  const verdict = evaluate([ev('positive_reply', daysAgo(2))]);
  assert.equal(verdict.eligible, false);
  assert.match(verdict.stopReason, /the prospect replied/);
});

test('S. a meeting after Step 1 cancels Step 2', () => {
  const verdict = evaluate([ev('call_booked', daysAgo(2))]);
  assert.equal(verdict.eligible, false);
  assert.match(verdict.stopReason, /a meeting was booked/);
});

test('T. a human reply after Step 1 cancels Step 2, even though Step 2 was scheduled first', () => {
  const verdict = evaluate([ev('human_response_sent', daysAgo(1))]);
  assert.equal(verdict.eligible, false);
  assert.match(verdict.stopReason, /a human took the conversation over/);
});

test('W. Closed Won and Closed Lost both stop the journey', () => {
  for (const stage of ['closed_won', 'closed_lost']) {
    const verdict = evaluateStageSequence({
      boardLead: { stage }, twin: twinOf(), activities: enrolledActivities(),
      now: NOW, featureEnabled: true,
    });
    assert.equal(verdict.eligible, false);
    assert.match(verdict.stopReason, /closed/);
  }
  assert.equal(decide({ stage: 'closed_lost' }).eligible, false);
});

test('with nothing in the way, Step 2 becomes due 8 business days after Step 1', () => {
  const verdict = evaluate();
  assert.equal(verdict.sequenceId, GENERIC_SEQUENCE_ID);
  assert.equal(verdict.status, 'active');
  assert.equal(verdict.step, 1);
  assert.equal(verdict.maxSteps, 2);
  assert.equal(SEQUENCES[GENERIC_SEQUENCE_ID].delays[1], 8);
  assert.ok(verdict.nextDueAt, 'a due date is derived from the Step 1 send');
});

test('the journey is bounded at two steps and then completes', () => {
  const both = enrolledActivities([
    ev('sequence_step_sent', daysAgo(1), { sequenceId: GENERIC_SEQUENCE_ID, step: 2, providerMessageId: 'gm-2' }),
  ]);
  const verdict = evaluateStageSequence({
    boardLead: {}, twin: twinOf(), activities: both, now: NOW, featureEnabled: true,
  });
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.status, 'complete');
  assert.match(verdict.reason, /every step of this sequence has been sent/);
});

// ── OWNERSHIP ───────────────────────────────────────────────────────────────

test('an enrolled generic journey owns the lead, and never coexists with another owner', () => {
  const activities = enrolledActivities();
  const sequenceState = evaluateStageSequence({
    boardLead: {}, twin: twinOf(), activities, now: NOW, featureEnabled: true,
  });
  const ownership = deriveAutomationOwnership(twinOf({ stage: '' }), {
    activities, sequenceState, sequencesEnabled: true, now: new Date(NOW),
  });
  assert.equal(ownership.owner, 'recovery_sequence');
  assert.equal(ownership.evidence.sequenceId, GENERIC_SEQUENCE_ID);
  // Cold cadence can never also own it.
  assert.notEqual(ownership.owner, 'cold_automation');
  assert.equal(ownership.sendAllowed, false, 'cold send is never allowed for a journey-owned lead');

  // A manual hold outranks the enrolled journey.
  const held = deriveAutomationOwnership(twinOf({ stage: '' }), {
    activities, sequenceState, sequencesEnabled: true, now: new Date(NOW),
    suppressionReason: () => '[MANUAL HOLD]',
  });
  assert.equal(held.blockedBy, 'manual_hold');
  assert.equal(held.sequenceAllowed, false, 'generic is not an explicit lifecycle journey');
});

// ── ROLLOUT CONTROL ─────────────────────────────────────────────────────────

test('X. the pilot cohort is deterministic, oldest-first and hard-capped at 50', () => {
  const candidates = Array.from({ length: 120 }, (_, i) => ({
    leadId: `L${String(i).padStart(3, '0')}`, eligible: true,
    finalColdEmailAt: daysAgo(59 - (i % 30)),
  }));
  const cohort = selectPilotCohort(candidates, { config: CFG });
  assert.equal(cohort.selected.length, 50);
  assert.equal(cohort.eligibleCount, 120);
  assert.equal(cohort.deferred, 70);
  // Oldest first.
  for (let i = 1; i < cohort.selected.length; i++) {
    assert.ok(cohort.selected[i - 1].finalColdEmailAt <= cohort.selected[i].finalColdEmailAt);
  }
  // Deterministic: same input, same cohort, same order.
  assert.deepEqual(selectPilotCohort(candidates, { config: CFG }).selected.map(c => c.leadId),
    cohort.selected.map(c => c.leadId));
  // The cap cannot be argued upward past the configured ceiling.
  assert.equal(selectPilotCohort(candidates, { limit: 5000, config: CFG }).selected.length, 50);
  assert.equal(selectPilotCohort(candidates, { limit: 10, config: CFG }).selected.length, 10);
  // Ineligible candidates are never selected, whatever their age.
  const mixed = [{ leadId: 'X', eligible: false, finalColdEmailAt: daysAgo(59) }, ...candidates];
  assert.ok(!selectPilotCohort(mixed, { config: CFG }).selected.some(c => c.leadId === 'X'));
});

test('Y. deploying this code cannot auto-enrol the historical backlog', () => {
  const shipped = genericConfig({});
  // 1. The journey is OFF unless explicitly switched on.
  assert.equal(shipped.enabled, false, 'the master switch ships off');
  // 2. Even switched on, the rollout cutoff excludes every historical lead:
  //    their final cold email predates it by construction.
  const live = genericConfig({ GENERIC_REENGAGEMENT_ENABLED: '1' });
  assert.ok(live.autoEnrollAfter, 'a rollout cutoff is always configured');
  const historical = decide({ lastEmailedAt: daysAgo(45) }, [senderEvidence()], live);
  assert.equal(historical.eligible, false);
  assert.equal(historical.backfillBlocked, true);
  assert.ok(historical.blockers.some(b => /historical backfill gate/.test(b)));
  // 3. A FUTURE lead, quiet 30 days from now, is unaffected by the gate.
  const future = genericEligibility({
    twin: twinOf({ lastEmailedAt: live.autoEnrollAfter }),
    activities: [senderEvidence()], config: live,
    now: Date.parse(live.autoEnrollAfter) + 31 * 86400000,
    senderProof: { ok: true, senderInboxId: 'primary' },
  });
  assert.equal(future.eligible, true, future.blockers.join('; '));
  // 4. The pilot path is the ONLY way a historical lead becomes eligible, and
  //    it is explicit rather than automatic.
  const pilot = decide({ lastEmailedAt: daysAgo(45) }, [senderEvidence()], live, { forPilot: true });
  assert.equal(pilot.eligible, true, pilot.blockers.join('; '));
});

test('V. step and enrolment ids are deterministic, so nothing can send or enrol twice', () => {
  assert.equal(sequenceStepEventId('CE-L1', GENERIC_SEQUENCE_ID, 1),
    sequenceStepEventId('CE-L1', GENERIC_SEQUENCE_ID, 1));
  assert.notEqual(sequenceStepEventId('CE-L1', GENERIC_SEQUENCE_ID, 1),
    sequenceStepEventId('CE-L1', GENERIC_SEQUENCE_ID, 2));
  // Enrolment is anchored to the final cold email, not to "now", so re-running
  // the pass on the same lead yields the same id and cannot enrol twice.
  const anchor = finalColdEmailAt(twinOf(), []);
  assert.equal(genericEnrollmentEventId('CE-L1', anchor), genericEnrollmentEventId('CE-L1', anchor));
  assert.match(genericEnrollmentEventId('CE-L1', anchor), /^seq-enroll:CE-L1:generic_follow_up_v1:/);

  // The runner keeps its duplicate-send guards for this journey: a recorded
  // step is skipped, and an unresolved reservation blocks a second attempt.
  const runner = readSource('outreach-agent.js');
  assert.match(runner, /if \(activities\.some\(row => row\.eventId === eventId\)\) continue;/);
  assert.match(runner, /a durable delivery reservation exists and Gmail has not confirmed it yet/);
});

test('the generic journey reuses the canonical engine rather than a parallel one', () => {
  const runner = readSource('outreach-agent.js');
  // One send path, one reservation ledger, one quota ledger.
  assert.equal(runner.split('await sendEmail({').length - 1 >= 1, true);
  assert.match(runner, /freshThreadAllowed/);
  // Generic candidates are appended AFTER board leads, which is the priority rule.
  const targetsAt = runner.indexOf('const targets = boardLeads.map');
  const genericAt = runner.indexOf('if (genericCfg.enabled) {');
  assert.ok(targetsAt > 0 && genericAt > targetsAt, 'board leads are queued before generic candidates');
});

test('copy is configuration-supplied, and placeholder copy is never sent', () => {
  const rendered = renderGenericCopy(1, twinOf(), copyOpts);
  assert.equal(rendered.isPlaceholder, false);
  assert.match(rendered.body, /Hi Sarah,/);
  assert.match(rendered.subjectFresh, /City Clinic/);
  assert.doesNotMatch(rendered.body, /\{\{/);
  // The shipped default refuses to build at all.
  assert.equal(renderGenericCopy(1, twinOf()).isPlaceholder, true);
  assert.match(buildSequenceEmail(GENERIC_SEQUENCE_ID, 1, twinOf()).error, /still the placeholder/);
  // Malformed template configuration falls back to the placeholder — which
  // refuses to send — rather than throwing inside the sending agent.
  const broken = renderGenericCopy(1, twinOf(), { env: { GENERIC_REENGAGEMENT_TEMPLATES: '{not json' } });
  assert.equal(broken.isPlaceholder, true);
});

// ── ANALYTICS ───────────────────────────────────────────────────────────────

const { genericReengagementAnalytics } = require('../integrations/generic-reengagement-analytics');

const send = (lead, step, at, over = {}) => ({
  eventId: `${lead}:s${step}`, sourceLeadId: lead, email: `${lead}@x.com`,
  eventType: 'sequence_step_sent', occurredAt: at,
  metadata: JSON.stringify({ sequenceId: GENERIC_SEQUENCE_ID, step, providerMessageId: `gm-${lead}-${step}`, ...over }),
});
const reply = (lead, type, at) => ({
  eventId: `${lead}:${type}:${at}`, sourceLeadId: lead, email: `${lead}@x.com`,
  eventType: type, occurredAt: at, metadata: '{}',
});

test('analytics report the metrics the business actually judges cold email on', () => {
  const activities = [
    // A: both steps, replied positively after step 2, then booked.
    send('A', 1, daysAgo(30)), send('A', 2, daysAgo(20)),
    reply('A', 'positive_reply', daysAgo(19)),
    { ...reply('A', 'call_booked', daysAgo(18)), metadata: '{}' },
    // B: step 1 only, negative reply — step 2 correctly never went out.
    send('B', 1, daysAgo(30)), reply('B', 'negative_reply', daysAgo(29)),
    // C: step 1 only, meeting booked before step 2.
    send('C', 1, daysAgo(30)), reply('C', 'call_booked', daysAgo(28)),
    // D: both steps, silence.
    send('D', 1, daysAgo(30)), send('D', 2, daysAgo(20)),
    // E: another journey entirely — must not be counted.
    { eventId: 'E:1', sourceLeadId: 'E', email: 'E@x.com', eventType: 'sequence_step_sent',
      occurredAt: daysAgo(30), metadata: JSON.stringify({ sequenceId: 'demo_follow_up_v1', step: 1 }) },
    { ...reply('E', 'positive_reply', daysAgo(25)) },
  ];
  const stats = genericReengagementAnalytics({ activities, leads: [{ id: 'A', email: 'A@x.com', notes: 'open-triggered' }] });

  assert.equal(stats.sequenceId, GENERIC_SEQUENCE_ID);
  assert.equal(stats.delivered, 6, 'four step-1 sends plus two step-2 sends');
  assert.equal(stats.step1Delivered, 4);
  assert.equal(stats.step2Delivered, 2);
  assert.equal(stats.replies, 2, 'A and B replied; the demo journey lead is not ours');
  assert.equal(stats.positiveReplies, 1);
  assert.equal(stats.negativeReplies, 1);
  assert.equal(stats.bookedMeetings, 2);
  assert.equal(stats.step1Replies, 1, 'B replied while only step 1 had landed');
  assert.equal(stats.step2Replies, 1, 'A replied after step 2');
  assert.equal(stats.meetingBeforeStep2, 1, 'C');
  assert.equal(stats.blockedBeforeStep2, 1, 'B');

  assert.equal(stats.rates.replyRate, 33.3);
  assert.equal(stats.rates.positiveReplyRate, 16.7);
  assert.equal(stats.rates.bookedMeetingRate, 33.3);
  // Opens are reported and clearly marked, but are not a decision input.
  assert.equal(stats.openedDisplayOnly, 1);
  assert.ok('openRateDisplayOnly' in stats.rates);
});

test('analytics are empty and safe before the journey has ever run', () => {
  const stats = genericReengagementAnalytics({ activities: [], leads: [] });
  assert.equal(stats.delivered, 0);
  assert.equal(stats.replies, 0);
  assert.equal(stats.rates.replyRate, null, 'no denominator means no rate, not a zero');
});

// ── NEXT ACTION UX ──────────────────────────────────────────────────────────

const { deriveNextAction } = require('../integrations/pipeline-state');

const board = { id: 'CE-L1', email: 'info@cityclinic.com', company: 'City Clinic', stage: 'Follow Up' };
const enrolledOnly = [
  senderEvidence(),
  ev('sequence_enrolled', daysAgo(9), { sequenceId: GENERIC_SEQUENCE_ID, senderInboxId: 'primary' }),
];
const nextAction = (activities, twin = twinOf(), context = {}) => deriveNextAction(board, twin, {
  activities, now: new Date(NOW), sequencesEnabled: true, ...context,
});

test('Next Action names the journey truthfully in every state', () => {
  // Scheduled, due, and observer-blocked all read as automation-owned work.
  const scheduled = nextAction(enrolledActivities());
  assert.match(scheduled.label, /^Automated re-engagement #2 — automated follow-up scheduled$/);
  assert.equal(scheduled.owner, 'automation');

  const due = nextAction(enrolledOnly);
  assert.match(due.label, /^Automated re-engagement #1 — automated follow-up due$/);
  assert.equal(due.owner, 'automation');

  const blocked = nextAction(enrolledActivities(), twinOf(), {
    observer: { senderInboxId: 'primary', health: 'stale' },
  });
  assert.match(blocked.label, /blocked — Gmail observer unavailable$/);
  assert.equal(blocked.status, 'blocked');

  const held = nextAction(enrolledActivities(), twinOf({ notes: '[MANUAL HOLD]' }));
  assert.equal(held.label, 'Blocked by manual hold');
  assert.equal(held.owner, 'human');

  // A reply hands the lead back to a person rather than leaving it with the journey.
  const replied = nextAction(enrolledActivities([ev('positive_reply', daysAgo(1))]));
  assert.equal(replied.owner, 'human');
  assert.match(replied.label, /Automated re-engagement stopped/);

  // The failure this UX requirement exists to prevent: a legitimately
  // automation-owned journey must never be described as manual Pipeline work.
  for (const action of [scheduled, due, blocked, replied]) {
    assert.notEqual(action.label, 'Review Pipeline follow-up');
  }
});
