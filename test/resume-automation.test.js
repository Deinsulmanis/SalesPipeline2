'use strict';

// Resume automation — releasing an operator's own manual hold.
//
// THE GAP THIS CLOSES
//
// A MANUAL HOLD is a pause a person applied, and there was no way for that
// person to lift it. The drawer said "manual hold — human owns this lead" and
// offered no control; the only hold writer in the codebase applied one.
//
// WHY IT WAS LEFT THAT WAY, AND WHY IT IS NOW SAFE
//
// pipeline-state.js says plainly that removing the tag by hand is dangerous:
// selectFollowUps() asks only whether the step delay has elapsed since
// lastEmailedAt, so a lead held for two weeks is ALREADY overdue the instant
// the tag goes and would send on the very next pass.
//
// That hazard is real and unchanged for COLD leads. What makes the operator
// control safe is that it is restricted to leads in the Sales Pipeline, and
// since ownership became stage-aware every branch for a board lead returns a
// non-cold owner. mayColdSend() requires owner === COLD_AUTOMATION, so it can
// never be true for one. Releasing a hold hands the lead to its STAGE, never
// to Email 2/3 — which these tests assert rather than assume.
//
// Nothing here touches Google, Gmail or the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  releaseHoldFromNotes, applyHoldToNotes, applyResumeToNotes, hasManualHold,
  resumeAtFromNotes, sendSuppressionReason, MANUAL_HOLD_TAG,
} = require('../integrations/pipeline-state');
const {
  OWNER, BLOCKED_BY, deriveAutomationOwnership, mayColdSend, maySequenceSend, executableOwners,
} = require('../integrations/automation-ownership');
const { buildActivityTimeline } = require('../integrations/activity-timeline');

const root = path.join(__dirname, '..');
// core.autocrlf is on for this repo, so a fresh checkout yields CRLF source.
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
const serverSrc = readSource(path.join(root, 'server.js'));
const browser = readSource(path.join(root, 'public', 'index.html'));

const ROUTE = serverSrc.slice(
  serverSrc.indexOf("app.post('/api/leads/:id/resume-automation'"),
  serverSrc.indexOf("app.post('/api/leads/:id/human-response'"));

// A held lead that is otherwise perfectly ordinary: mid-sequence, clean
// address. Every refusal below therefore comes from a real gate.
const HELD = Object.freeze({
  id: 'L1', email: 'a@clinic.test', company: 'A Dental',
  emailStatus: 'emailed', emailStep: '1', notes: MANUAL_HOLD_TAG, stage: 'Contacted',
});
const RELEASED = Object.freeze({ ...HELD, notes: '' });

const reader = suppressed => lead => sendSuppressionReason(lead, { suppressedEmails: new Set(suppressed || []) });
const own = (lead, over = {}) => deriveAutomationOwnership(lead, {
  activities: [], suppressionReason: reader(), sendingEnabled: true,
  sequencesEnabled: true, coldCadenceDue: true, ...over,
});
const inStage = (lead, stage, over = {}) => own(lead, { boardLead: { stage, email: lead.email }, ...over });
const offering = journey => ({ offer: journey, offers: [journey], status: 'none' });
const enrolledIn = journey => ({ sequenceId: journey, status: 'active', eligible: true });

// ── 1–4. When the control appears ───────────────────────────────────────────

test('1/2. Resume automation is offered only while a hold is actually active', () => {
  const render = browser.slice(browser.indexOf('function renderPipelineState'),
    browser.indexOf('const ownershipRow'));
  assert.match(render, /const heldNow =/);
  assert.match(render, /manual hold/i, 'visibility keys off the real hold state');
  assert.match(render, /!\(heldNow && !terminalNow\) \? '' :/, 'no hold means no button');
  assert.match(browser, /onclick="openResumeAutomationModal\(\)">Resume automation</);
});

test('3/4. it is hidden for Closed Won and Closed Lost, and refused server-side', () => {
  const render = browser.slice(browser.indexOf('function renderPipelineState'),
    browser.indexOf('const ownershipRow'));
  assert.match(render, /const terminalNow = \['closed_won', 'closed_lost'\]\.includes\(currentStage\)/);
  // Hiding a button is presentation. The route refuses independently, so a
  // stale drawer or a direct call cannot resume a closed opportunity.
  assert.match(ROUTE, /\['closed_won', 'closed_lost'\]\.includes\(stage\)/);
  assert.match(ROUTE, /code: 'terminal_stage'/);
  assert.match(ROUTE, /there is no automation to resume/);
});

// ── 5–6. What the action does ───────────────────────────────────────────────

test('5. releasing removes the hold, and the resume gate with it', () => {
  assert.equal(hasManualHold(releaseHoldFromNotes(MANUAL_HOLD_TAG)), false);
  assert.equal(releaseHoldFromNotes(applyHoldToNotes('promoted from reply')), 'promoted from reply');
  // A [RESUME:] gate without a hold is meaningless residue.
  const scheduled = applyResumeToNotes(MANUAL_HOLD_TAG + ' note', '2027-01-01T00:00:00.000Z');
  const released = releaseHoldFromNotes(scheduled);
  assert.equal(hasManualHold(released), false);
  assert.equal(resumeAtFromNotes(released), null);
  assert.equal(released, 'note');
  // Idempotent, and it never invents content.
  assert.equal(releaseHoldFromNotes(released), released);
  assert.equal(releaseHoldFromNotes('plain note'), 'plain note');
});

test('5b. permanent suppression tags survive a hold release', () => {
  // The hold is reversible; an opt-out and a bounce are not. Releasing one must
  // never quietly drop the others.
  const notes = MANUAL_HOLD_TAG + ' [REPLY: Unsubscribed] [BOUNCED 2026-08-01]';
  const released = releaseHoldFromNotes(notes);
  assert.match(released, /\[REPLY: Unsubscribed\]/);
  assert.match(released, /\[BOUNCED 2026-08-01\]/);
  assert.equal(hasManualHold(released), false);
  // And the lead stays suppressed afterwards.
  assert.equal(sendSuppressionReason({ email: 'a@clinic.test', notes: released }, { suppressedEmails: new Set() }),
    '[REPLY: Unsubscribed]');
});

test('6. ownership is re-derived after the release and reported back', () => {
  assert.match(ROUTE, /deriveAutomationOwnership\(twin, \{/);
  assert.match(ROUTE, /ownershipSummary\(ownership, stage\)/);
  for (const field of ['owner:', 'blockedBy:', 'headline:', 'journey:']) {
    assert.ok(ROUTE.includes(field), `the response reports ${field}`);
  }
  // Read back before anything downstream trusts the release.
  assert.match(ROUTE, /const stillHeld = after\.filter\(twin => hasManualHold/);
  assert.match(ROUTE, /code: 'release_unconfirmed'/);
});

// ── 7–9. Stage-aware behaviour after release ────────────────────────────────

test('7. a released Follow Up lead can be owned by demo_follow_up_v1', () => {
  const before = inStage(HELD, 'follow_up', { sequenceState: offering('demo_follow_up_v1') });
  assert.equal(before.blockedBy, BLOCKED_BY.MANUAL_HOLD);

  const after = inStage(RELEASED, 'follow_up', { sequenceState: offering('demo_follow_up_v1') });
  assert.equal(after.owner, OWNER.RECOVERY_SEQUENCE);
  assert.equal(after.evidence.offer, 'demo_follow_up_v1');
  // Offered, not enrolled: releasing a hold does not enrol anything.
  assert.equal(after.sequenceAllowed, false);
  assert.equal(after.blockedBy, BLOCKED_BY.AWAITING_ENROLLMENT);
  // And with no qualifying journey it says so rather than resuming cold.
  const barren = inStage(RELEASED, 'follow_up', { sequenceState: offering(null) });
  assert.equal(barren.blockedBy, BLOCKED_BY.NO_ELIGIBLE_JOURNEY);
  assert.equal(mayColdSend(barren).allowed, false);
});

test('8. a released Hot lead can be owned by hot_stale_v1 when eligible', () => {
  const after = inStage(RELEASED, 'hot', { sequenceState: offering('hot_stale_v1') });
  assert.equal(after.owner, OWNER.RECOVERY_SEQUENCE);
  assert.equal(after.evidence.offer, 'hot_stale_v1');
  const live = inStage(RELEASED, 'hot', { sequenceState: enrolledIn('hot_stale_v1') });
  assert.equal(maySequenceSend(live).allowed, true);
  assert.equal(mayColdSend(live).allowed, false);
  // Not due / waiting on us still waits.
  assert.equal(inStage(RELEASED, 'hot', { sequenceState: offering(null) }).blockedBy,
    BLOCKED_BY.NO_ELIGIBLE_JOURNEY);
});

test('9. a released Call Booked lead stays owned by the meeting workflow', () => {
  const after = inStage(RELEASED, 'call_booked', {
    callState: { status: 'scheduled', meetingAt: '2027-01-01T17:00:00.000Z' },
  });
  assert.equal(after.owner, OWNER.MEETING);
  assert.equal(mayColdSend(after).allowed, false, 'never generic cold');
  assert.equal(executableOwners(after).length, 0);
});

// ── 10–15. Every other gate still applies ───────────────────────────────────

test('10/11. sender and thread proof still fail closed after a release', () => {
  // Ownership never asserts sender/thread proof itself — the sequence engine
  // does, and the release path does not touch it.
  const sequences = readSource(path.join(root, 'integrations', 'stage-sequences.js'));
  assert.match(sequences, /provenSequenceSenderId/);
  assert.match(sequences, /resolveSequenceThread/);
  assert.ok(!/releaseHoldFromNotes|resume-automation/.test(sequences),
    'the release path cannot reach into sender or thread proof');
  // And an unproven legacy sender is never defaulted to primary by this action.
  assert.ok(!/senderInboxId\s*(\|\||\?\?)\s*'primary'/.test(ROUTE),
    'the route must not infer a sender');
});

test('12. suppression still blocks after the hold is gone', () => {
  const unsub = { ...RELEASED, notes: '[REPLY: Unsubscribed]' };
  const verdict = inStage(unsub, 'hot', { sequenceState: enrolledIn('hot_stale_v1'),
    suppressionReason: reader() });
  assert.equal(verdict.blockedBy, BLOCKED_BY.SUPPRESSION);
  assert.equal(executableOwners(verdict).length, 0);

  // The durable list blocks too, even with spotless notes.
  const listed = inStage(RELEASED, 'hot', { sequenceState: enrolledIn('hot_stale_v1'),
    suppressionReason: reader(['a@clinic.test']) });
  assert.equal(listed.blockedBy, BLOCKED_BY.SUPPRESSION);
});

test('13/14. a newer reply or a manual Gmail response still blocks', () => {
  const replied = inStage(RELEASED, 'hot', {
    sequenceState: offering('hot_stale_v1'),
    activities: [{ eventType: 'positive_reply', occurredAt: '2026-09-06T10:00:00.000Z',
      metadata: JSON.stringify({ canonicalState: 'positive' }) }],
  });
  assert.equal(replied.owner, OWNER.HUMAN);
  assert.equal(executableOwners(replied).length, 0);

  const manual = inStage(RELEASED, 'hot', {
    sequenceState: offering('hot_stale_v1'), unrecordedHumanTouch: true,
  });
  assert.equal(manual.blockedBy, BLOCKED_BY.UNRECORDED_HUMAN_TOUCH);
  assert.equal(executableOwners(manual).length, 0);
});

test('15. identity, meeting and quota gates are untouched by the release', () => {
  const badIdentity = inStage({ ...RELEASED, email: 'not-an-address' }, 'follow_up',
    { sequenceState: enrolledIn('demo_follow_up_v1') });
  assert.equal(badIdentity.blockedBy, BLOCKED_BY.INVALID_IDENTITY);

  const booked = inStage(RELEASED, 'hot', {
    callState: { status: 'scheduled', meetingAt: '2027-01-01T17:00:00.000Z' },
    sequenceState: offering('hot_stale_v1'),
  });
  assert.equal(booked.owner, OWNER.MEETING);

  // The route reads no quota and grants no exemption from one.
  assert.ok(!/dailyLimit|sendsToday|senderCountsToday/.test(ROUTE),
    'resume must not touch quota accounting');
});

// ── 16–18. It cannot send, enrol, or create a second owner ──────────────────

test('16. the action itself sends nothing and enrols nothing', () => {
  for (const forbidden of ['sendEmail', 'sendGmail', 'messages.send', 'runOutreach',
    'attemptInitial', 'attemptFollowUp', 'enrollSequence', 'applyResumeToNotes']) {
    assert.ok(!ROUTE.includes(forbidden), `resume-automation must not call ${forbidden}`);
  }
  // It writes exactly one kind of lead state — the notes cell — plus an audit
  // row. No stage, no outcome, no sequence enrolment.
  assert.match(ROUTE, /writeColdEmailNotes\(twin, releaseHoldFromNotes/);
  assert.ok(!/!M\$\{rowNum\}|!V\$\{rowNum\}|!U\$\{rowNum\}/.test(ROUTE),
    'the route must not write stage, outcome or meeting cells');
  // And it says so in the response, so no caller can read it as a send.
  assert.match(ROUTE, /automationResumed: false, sendTriggered: false/);
  // The browser action posts and refreshes; it never sends.
  const submit = browser.slice(browser.indexOf('async function submitResumeAutomation'),
    browser.indexOf('// ── EXPLICIT CLOSE'));
  assert.match(submit, /\/resume-automation`, \{ method: 'POST' \}/);
  assert.match(submit, /await refreshLeadEverywhere\(leadId\)/);
});

test('17. a remaining blocker is surfaced, not silently swallowed', () => {
  const submit = browser.slice(browser.indexOf('async function submitResumeAutomation'),
    browser.indexOf('// ── EXPLICIT CLOSE'));
  assert.match(submit, /Automation still blocked —/);
  assert.match(submit, /data\.blockedBy/);
  // Rendered as prose, never a raw enum.
  assert.match(submit, /replace\(\/_\/g, ' '\)/);
  // The confirmation states what will and will not happen.
  const modal = browser.slice(browser.indexOf('function openResumeAutomationModal'),
    browser.indexOf('async function submitResumeAutomation'));
  assert.match(modal, /Remove manual hold and let the system re-evaluate this lead for stage-based automation\?/);
  assert.match(modal, /sends no email and enrols nothing/);
  assert.ok(!/fetch\(/.test(modal), 'opening the confirmation writes nothing');
});

test('18. the one-owner invariant survives a release in every stage', () => {
  for (const stage of ['follow_up', 'hot', 'call_booked', 'closed_won', 'closed_lost']) {
    for (const sequenceState of [null, offering('demo_follow_up_v1'), offering('hot_stale_v1'),
      enrolledIn('demo_follow_up_v1'), enrolledIn('hot_stale_v1')]) {
      for (const lead of [HELD, RELEASED]) {
        const verdict = inStage(lead, stage, { sequenceState });
        assert.ok(executableOwners(verdict).length <= 1, `${stage}: two owners could execute`);
        assert.ok(!(verdict.sendAllowed && verdict.sequenceAllowed));
        // The whole safety argument: a Pipeline lead is never cold-executable,
        // held or released.
        assert.equal(mayColdSend(verdict).allowed, false, `${stage} must never allow ordinary cold send`);
      }
    }
  }
});

// ── 19–20. Audit trail, and Resume is not Reactivate ────────────────────────

test('19. releasing a hold records a canonical audit event', () => {
  assert.match(ROUTE, /eventType: 'automation_hold_released'/);
  // Deterministic id, so a retry reconciles instead of stacking rows.
  assert.match(ROUTE, /stableActivityId\('hold-released'/);
  for (const field of ['trigger:', 'actor:', 'previousHold: true', 'stage,', 'resultingOwner', 'resultingBlocker']) {
    assert.ok(ROUTE.includes(field), `the audit row records ${field}`);
  }
  // It renders as its own event, and reports the consequence.
  const [entry] = buildActivityTimeline({
    lead: { id: 'L1', stage: 'hot' },
    activities: [{ eventId: 'e1', leadId: 'L1', eventType: 'automation_hold_released',
      occurredAt: '2026-09-06T10:00:00.000Z',
      metadata: JSON.stringify({ resultingOwner: 'recovery_sequence', resultingBlocker: 'awaiting_enrollment' }) }],
  });
  assert.equal(entry.title, 'Manual hold released');
  assert.match(entry.summary, /still blocked/i);
  assert.ok(!/_/.test(entry.summary), 'the summary shows no raw enum');
});

test('20. Resume automation and Reactivate stay separate concepts', () => {
  const reactivate = serverSrc.slice(serverSrc.indexOf("app.post('/api/leads/:id/reactivate'"),
    serverSrc.indexOf("app.post('/api/leads/:id/resume-automation'") > 0
      ? serverSrc.indexOf("app.post('/api/leads/:id/resume-automation'")
      : serverSrc.length);
  // Reactivate still never removes a hold — that was its defining property.
  assert.ok(!/releaseHoldFromNotes/.test(reactivate),
    'Reactivate must not gain the power to remove a hold');
  // Resume does not schedule cold cadence, which is Reactivate's job.
  assert.ok(!/REACTIVATION_MODES|resumeStep|resumeAt/.test(ROUTE),
    'Resume must not schedule ordinary cold cadence');
  // Two distinct routes, two distinct controls.
  assert.match(serverSrc, /app\.post\('\/api\/leads\/:id\/reactivate'/);
  assert.match(serverSrc, /app\.post\('\/api\/leads\/:id\/resume-automation'/);
  assert.match(browser, /openReactivateModal\(/);
  assert.match(browser, /openResumeAutomationModal\(/);
});
