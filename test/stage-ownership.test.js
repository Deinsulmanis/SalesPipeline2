'use strict';

// Stage-aware automation ownership.
//
// THE RULE THAT WAS REMOVED
//
//   const promoted = NON_COLD_STAGES.includes(stage) || Boolean(boardLead);
//   if (promoted) return verdict({ owner: HUMAN, blockedBy: PROMOTED_TO_PIPELINE,
//     reason: 'the lead is in the Sales Pipeline; ordinary cold cadence no
//              longer owns it' });
//
// It sat AHEAD of the enrolled-sequence rule, so a Pipeline lead could never
// reach it. In production, a lead with a live demo_follow_up_v1 enrolment
// reported `human / promoted_to_pipeline` and its journey could never run.
//
// THE RULE THAT REPLACED IT
//
//   an enrolled journey owns the lead (whatever the stage), otherwise the
//   Pipeline STAGE selects the journey, and a stage with nothing eligible says
//   so truthfully.
//
// What must NOT change: a Pipeline lead is still never eligible for ordinary
// cold Email 2/3, and at most one actor may hold an executable move.
//
// Nothing here touches Google, Gmail or the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  OWNER, BLOCKED_BY, STAGE_JOURNEY, NON_COLD_STAGES,
  deriveAutomationOwnership, mayColdSend, maySequenceSend,
  executableOwners, ownershipSummary,
} = require('../integrations/automation-ownership');
const { sendSuppressionReason, MANUAL_HOLD_TAG } = require('../integrations/pipeline-state');

const root = path.join(__dirname, '..');
// core.autocrlf is on for this repo, so a fresh checkout yields CRLF source.
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
const ownershipSrc = readSource(path.join(root, 'integrations', 'automation-ownership.js'));
// The doc comments deliberately quote the rule that was removed, so assertions
// about what the CODE does have to read past them.
const stripComments = source => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(line => line.replace(/\/\/.*$/, '')).join('\n');
const ownershipCode = stripComments(ownershipSrc);
const browser = readSource(path.join(root, 'public', 'index.html'));
const serverSrc = readSource(path.join(root, 'server.js'));

// A perfectly ordinary cold-eligible lead: mid-sequence, no hold, clean address.
// Every refusal below therefore comes from STAGE, never from the row.
const COLD = Object.freeze({
  id: 'L1', email: 'a@clinic.test', company: 'A Dental',
  emailStatus: 'emailed', emailStep: '1', notes: '', stage: 'Contacted',
});

const own = (over = {}) => deriveAutomationOwnership(COLD, {
  activities: [], suppressionReason: () => null,
  sendingEnabled: true, sequencesEnabled: true, coldCadenceDue: true,
  ...over,
});
const inStage = (stage, extra = {}) => own({ boardLead: { stage, email: COLD.email }, ...extra });
const offering = journey => ({ offer: journey, offers: [journey], status: 'none' });
const enrolled = journey => ({ sequenceId: journey, status: 'active', eligible: true });

// ── 1. The headline change ──────────────────────────────────────────────────

test('1. Pipeline membership alone does not block automation', () => {
  // The removed rule, gone from source rather than merely unreachable.
  assert.ok(!/NON_COLD_STAGES\.includes\(stage\) \|\| Boolean\(boardLead\)/.test(ownershipCode),
    'the blanket promoted-to-pipeline rule must be gone from the code');
  assert.ok(!/the lead is in the Sales Pipeline; ordinary cold cadence no longer owns it/.test(ownershipCode),
    'the misleading reason string must be gone from the code');

  // A Follow Up lead with a qualifying journey is OWNED, not blocked.
  const withJourney = inStage('follow_up', { sequenceState: offering('demo_follow_up_v1') });
  assert.equal(withJourney.owner, OWNER.RECOVERY_SEQUENCE);
  assert.equal(withJourney.source, 'pipeline_stage');
  assert.notEqual(withJourney.blockedBy, BLOCKED_BY.PROMOTED_TO_PIPELINE);

  // No Pipeline stage reports Pipeline membership as its blocker any more.
  for (const stage of ['follow_up', 'hot', 'call_booked', 'closed_won', 'closed_lost']) {
    assert.notEqual(inStage(stage).blockedBy, BLOCKED_BY.PROMOTED_TO_PIPELINE, stage);
  }

  // The ColdEmail-stage guard survives untouched for leads with NO board row —
  // that is the Sparkle protection and it is a different rule.
  const coldPromoted = own({ ...{}, boardLead: null });
  assert.equal(coldPromoted.owner, OWNER.COLD_AUTOMATION, 'a plain cold lead is unaffected');
  const sparkle = deriveAutomationOwnership({ ...COLD, stage: 'Promoted' }, {
    activities: [], suppressionReason: () => null, sendingEnabled: true, coldCadenceDue: true,
  });
  assert.equal(sparkle.blockedBy, BLOCKED_BY.PROMOTED_TO_PIPELINE);
  assert.equal(mayColdSend(sparkle).allowed, false);
  assert.ok(NON_COLD_STAGES.includes('promoted'));
});

// ── 2–3. Follow Up ──────────────────────────────────────────────────────────

test('2. Follow Up with verified-demo evidence is owned by demo_follow_up_v1', () => {
  assert.equal(STAGE_JOURNEY.follow_up, 'demo_follow_up_v1');
  const offered = inStage('follow_up', { sequenceState: offering('demo_follow_up_v1') });
  assert.equal(offered.owner, OWNER.RECOVERY_SEQUENCE);
  assert.equal(offered.evidence.offer, 'demo_follow_up_v1');
  // Offered is not enrolled: a person consents before automation runs.
  assert.equal(offered.sequenceAllowed, false);
  assert.equal(offered.blockedBy, BLOCKED_BY.AWAITING_ENROLLMENT);

  // Once enrolled it genuinely owns and may execute — the case that was
  // impossible before, because the Pipeline rule fired first.
  const live = inStage('follow_up', { sequenceState: enrolled('demo_follow_up_v1') });
  assert.equal(live.owner, OWNER.RECOVERY_SEQUENCE);
  assert.equal(live.sequenceAllowed, true);
  assert.equal(maySequenceSend(live).allowed, true);
});

test('3. generic Follow Up without a qualifying journey does not resume Email 2/3', () => {
  const generic = inStage('follow_up', { sequenceState: offering(null) });
  assert.equal(mayColdSend(generic).allowed, false, 'ordinary cold cadence must NOT resume');
  assert.notEqual(generic.owner, OWNER.COLD_AUTOMATION);
  assert.equal(generic.blockedBy, BLOCKED_BY.NO_ELIGIBLE_JOURNEY);
  // And it says so truthfully rather than blaming Pipeline membership.
  assert.match(generic.reason, /no automatic Follow Up journey is currently eligible/i);
  assert.equal(ownershipSummary(generic, 'follow_up').headline,
    'No automatic Follow Up journey is currently eligible');
});

// ── 4–7. Hot ────────────────────────────────────────────────────────────────

test('4. Hot waiting on the prospect and due can be owned by hot_stale_v1', () => {
  assert.equal(STAGE_JOURNEY.hot, 'hot_stale_v1');
  const offered = inStage('hot', { sequenceState: offering('hot_stale_v1') });
  assert.equal(offered.owner, OWNER.RECOVERY_SEQUENCE);
  assert.equal(offered.evidence.offer, 'hot_stale_v1');
  const live = inStage('hot', { sequenceState: enrolled('hot_stale_v1') });
  assert.equal(maySequenceSend(live).allowed, true);
  assert.equal(mayColdSend(live).allowed, false, 'never ordinary cold cadence');
});

test('5. Hot waiting on us does not send', () => {
  // evaluateStageSequence only offers hot_stale_v1 while waiting_on_prospect,
  // so "waiting on us" reaches ownership with nothing offered.
  const waitingOnUs = inStage('hot', { sequenceState: offering(null) });
  assert.equal(waitingOnUs.sequenceAllowed, false);
  assert.equal(waitingOnUs.sendAllowed, false);
  assert.equal(executableOwners(waitingOnUs).length, 0);
});

test('6. a newer prospect reply takes Hot away from automation', () => {
  const replied = inStage('hot', {
    sequenceState: offering('hot_stale_v1'),
    activities: [{ eventType: 'positive_reply', occurredAt: '2026-09-03T10:00:00.000Z',
      metadata: JSON.stringify({ canonicalState: 'positive' }) }],
  });
  assert.equal(replied.owner, OWNER.HUMAN, 'a live reply is a person\'s conversation');
  assert.equal(replied.sequenceAllowed, false);
  assert.equal(replied.sendAllowed, false);
});

test('7. a manual Gmail response stops Hot automation', () => {
  const manual = inStage('hot', {
    sequenceState: offering('hot_stale_v1'), unrecordedHumanTouch: true,
  });
  assert.equal(manual.blockedBy, BLOCKED_BY.UNRECORDED_HUMAN_TOUCH);
  assert.equal(executableOwners(manual).length, 0);
});

// ── 8–10. Meeting and terminal stages ───────────────────────────────────────

test('8. Call Booked blocks ordinary cold cadence and is not a follow-up stage', () => {
  const booked = inStage('call_booked', {
    callState: { status: 'scheduled', meetingAt: '2026-09-20T17:00:00.000Z' },
  });
  assert.equal(mayColdSend(booked).allowed, false);
  assert.equal(booked.owner, OWNER.MEETING);
  assert.equal(ownershipSummary(booked, 'call_booked').headline, 'Meeting workflow owns this lead');

  // A resolved meeting offers a recovery journey but never auto-runs it.
  const resolved = inStage('call_booked', {
    callState: { status: 'no_show' }, sequenceState: offering('no_show_recovery_v1'),
  });
  assert.equal(resolved.sequenceAllowed, false);
  assert.equal(resolved.blockedBy, BLOCKED_BY.AWAITING_ENROLLMENT);
  assert.equal(mayColdSend(resolved).allowed, false);
  assert.equal(STAGE_JOURNEY.call_booked, undefined, 'Call Booked has no generic follow-up journey');
});

test('9/10. Closed Won and Closed Lost stop automation deterministically', () => {
  for (const [stage, label] of [['closed_won', 'Closed Won'], ['closed_lost', 'Closed Lost']]) {
    // Even with a journey offered AND an active enrolment, terminal wins: the
    // terminal rule runs before both.
    for (const sequenceState of [null, offering('hot_stale_v1'), enrolled('timing_recontact_v1')]) {
      const verdict = inStage(stage, { sequenceState });
      assert.equal(verdict.owner, OWNER.NONE, stage);
      assert.equal(verdict.blockedBy, BLOCKED_BY.TERMINAL_STAGE, stage);
      assert.equal(executableOwners(verdict).length, 0, stage);
      assert.equal(mayColdSend(verdict).allowed, false);
      assert.equal(maySequenceSend(verdict).allowed, false);
    }
    assert.equal(ownershipSummary(inStage(stage), stage).headline, `Automation stopped — ${label}`);
  }
});

// ── 11–12. The one-owner invariant ──────────────────────────────────────────

test('11/12. at most one executable owner, and cold + sequence never both', () => {
  const worlds = [];
  for (const stage of ['follow_up', 'hot', 'call_booked', 'closed_won', 'closed_lost', 'review']) {
    for (const sequenceState of [null, offering('demo_follow_up_v1'), offering('hot_stale_v1'),
      enrolled('demo_follow_up_v1'), enrolled('hot_stale_v1'), enrolled('no_show_recovery_v1')]) {
      for (const callState of [null, { status: 'scheduled', meetingAt: '2026-09-20T17:00:00.000Z' },
        { status: 'no_show' }, { status: 'outcome_pending' }]) {
        worlds.push(inStage(stage, { sequenceState, callState }));
      }
    }
  }
  // Plus the non-Pipeline cases, so the invariant is checked either side of the
  // boundary this change moved.
  worlds.push(own(), own({ coldCadenceDue: false }), own({ sendingEnabled: false }));

  for (const verdict of worlds) {
    const executable = executableOwners(verdict);
    assert.ok(executable.length <= 1, `two owners could execute: ${executable.join(' + ')}`);
    assert.ok(!(verdict.sendAllowed && verdict.sequenceAllowed),
      'ordinary cold cadence and a stage sequence must never both be permitted');
    if (mayColdSend(verdict).allowed) assert.equal(maySequenceSend(verdict).allowed, false);
    if (maySequenceSend(verdict).allowed) assert.equal(mayColdSend(verdict).allowed, false);
  }

  // No Pipeline lead is ever cold-executable, in any of those worlds.
  const pipelineWorlds = worlds.filter(v => v.evidence && v.evidence.inPipeline);
  assert.ok(pipelineWorlds.length > 0);
  for (const verdict of pipelineWorlds) assert.equal(mayColdSend(verdict).allowed, false);
});

// ── 13–18. Safety rules that must be untouched ──────────────────────────────

test('13. MANUAL HOLD semantics are unchanged', () => {
  const held = { ...COLD, notes: MANUAL_HOLD_TAG };
  const reader = lead => sendSuppressionReason(lead, { suppressedEmails: new Set() });
  const verdict = deriveAutomationOwnership(held, {
    boardLead: { stage: 'hot', email: COLD.email }, activities: [],
    suppressionReason: reader, sendingEnabled: true, sequencesEnabled: true, coldCadenceDue: true,
    sequenceState: offering('hot_stale_v1'),
  });
  assert.equal(verdict.blockedBy, BLOCKED_BY.MANUAL_HOLD);
  assert.equal(mayColdSend(verdict).allowed, false);
  assert.equal(verdict.sequenceAllowed, false, 'a hold blocks an unenrolled journey');
  assert.equal(ownershipSummary(verdict, 'hot').headline, 'Automation blocked — manual hold');

  // The carve-out is NARROW, and stays narrow. An enrolled Hot or Demo journey
  // may NOT override a human's hold -- only explicit lifecycle recovery may,
  // because a no-show or cancellation is a recorded event a person created.
  const hotUnderHold = deriveAutomationOwnership(held, {
    boardLead: { stage: 'hot', email: COLD.email }, activities: [],
    suppressionReason: reader, sendingEnabled: true, sequencesEnabled: true,
    sequenceState: enrolled('hot_stale_v1'),
  });
  assert.equal(hotUnderHold.sequenceAllowed, false, 'Hot must not override a manual hold');
  assert.equal(hotUnderHold.sendAllowed, false);

  const recoveryUnderHold = deriveAutomationOwnership(held, {
    boardLead: { stage: 'call_booked', email: COLD.email }, activities: [],
    suppressionReason: reader, sendingEnabled: true, sequencesEnabled: true,
    sequenceState: enrolled('no_show_recovery_v1'),
  });
  assert.equal(recoveryUnderHold.sequenceAllowed, true, 'explicit lifecycle recovery still may');
  assert.equal(recoveryUnderHold.sendAllowed, false, 'but never a cold send');
  // The hold itself is never removed by any of this.
  assert.equal(held.notes, MANUAL_HOLD_TAG);
});

test('14/15/16. recovery stays explicit-event and human-authorized', () => {
  // A resolved meeting only OFFERS its journey; it never enrols itself.
  for (const [status, journey] of [['no_show', 'no_show_recovery_v1'], ['cancelled', 'cancelled_rebook_v1']]) {
    const verdict = inStage('call_booked', { callState: { status }, sequenceState: offering(journey) });
    assert.equal(verdict.sequenceAllowed, false, `${status} must not auto-run ${journey}`);
    assert.equal(verdict.blockedBy, BLOCKED_BY.AWAITING_ENROLLMENT);
  }
  // Elapsed time alone implies nothing: an unresolved past meeting is human work.
  const pending = inStage('call_booked', { callState: { status: 'outcome_pending' } });
  assert.equal(pending.owner, OWNER.HUMAN);
  assert.equal(executableOwners(pending).length, 0);
  // Timing re-contact fires on a date a human chose, so it arrives enrolled.
  const timing = inStage('follow_up', { sequenceState: enrolled('timing_recontact_v1') });
  assert.equal(timing.owner, OWNER.RECOVERY_SEQUENCE);
  assert.equal(timing.evidence.sequenceId, 'timing_recontact_v1');
});

test('17. suppression and identity still fail closed, ahead of any stage rule', () => {
  const suppressed = deriveAutomationOwnership(COLD, {
    boardLead: { stage: 'hot', email: COLD.email }, activities: [],
    suppressionReason: () => '[REPLY: Unsubscribed]',
    sendingEnabled: true, sequencesEnabled: true, sequenceState: enrolled('hot_stale_v1'),
  });
  assert.equal(suppressed.blockedBy, BLOCKED_BY.SUPPRESSION);
  assert.equal(executableOwners(suppressed).length, 0);

  const badIdentity = deriveAutomationOwnership({ ...COLD, email: 'not-an-address' }, {
    boardLead: { stage: 'follow_up' }, activities: [], suppressionReason: () => null,
    sendingEnabled: true, sequencesEnabled: true, sequenceState: enrolled('demo_follow_up_v1'),
  });
  assert.equal(badIdentity.blockedBy, BLOCKED_BY.INVALID_IDENTITY);
  assert.equal(executableOwners(badIdentity).length, 0);
});

test('18. quotas remain 40 per inbox and 80 globally', () => {
  // Ownership does not touch quota, and must not have acquired an opinion.
  assert.ok(!/dailyLimit|sendsToday|40|80/.test(
    ownershipSrc.slice(ownershipSrc.indexOf('function pipelineStageOwnership'),
      ownershipSrc.indexOf('function deriveAutomationOwnership'))),
  'stage ownership must not read or imply a quota');
  const registry = readSource(path.join(root, 'integrations', 'gmail-inbox-registry.js'));
  assert.match(registry, /dailyLimit/);
  assert.match(serverSrc, /GMAIL_PRIMARY_DAILY_LIMIT \|\| process\.env\.DAILY_SEND_LIMIT/);
});

// ── 19–20. Reactivate and UI copy ───────────────────────────────────────────

test('19. Reactivate cannot bypass stage ownership', () => {
  const state = readSource(path.join(root, 'integrations', 'pipeline-state.js'));
  // The gate still consumes the canonical verdict rather than a second opinion.
  assert.match(state, /function coldReactivationVerdict/);
  assert.match(state, /if \(!ownership\) \{[\s\S]{0,320}ownership_unknown/, 'no verdict fails closed');
  // MANUAL_HOLD is still not a licence to resume.
  assert.match(state, /REACTIVATABLE_BLOCKERS = Object\.freeze\(\[\s*\n?\s*BLOCKED_BY\.WAITING_UNTIL_DATE/);
  // The new stage blockers are refusals, not omissions — an unlisted blocker
  // refuses by default, so a Pipeline lead cannot schedule ordinary cold resume.
  assert.match(state, /\[BLOCKED_BY\.NO_ELIGIBLE_JOURNEY\]/);
  assert.match(state, /\[BLOCKED_BY\.AWAITING_ENROLLMENT\]/);
  for (const blocker of ['NO_ELIGIBLE_JOURNEY', 'AWAITING_ENROLLMENT', 'MEETING_LIFECYCLE', 'TERMINAL_STAGE']) {
    assert.ok(!new RegExp(`REACTIVATABLE_BLOCKERS[\\s\\S]{0,200}BLOCKED_BY\\.${blocker}\\b`).test(state),
      `${blocker} must never authorise an ordinary cold resume`);
  }
});

test('20. no surface reports Pipeline membership alone as the blocker', () => {
  for (const [name, source] of [['ownership', ownershipSrc], ['browser', browser],
    ['pipeline-state', readSource(path.join(root, 'integrations', 'pipeline-state.js'))]]) {
    assert.ok(!/in the Sales Pipeline, so ordinary cold cadence no longer owns it/.test(source),
      `${name} still carries the misleading copy`);
  }
  // The drawer renders shared operator copy, and no raw enum.
  assert.match(serverSrc, /ownershipSummary\(verdict, displayStageFor\(lead\.stage\)\)/);
  assert.match(browser, /<span class="pipeline-row-label">Automation owner<\/span>/);
  assert.match(browser, /esc\(own\.headline\)/);
  assert.ok(!/own\.owner|own\.blockedBy/.test(
    browser.slice(browser.indexOf('const ownershipRow'), browser.indexOf('host.innerHTML = `${conflict}'))),
  'the drawer must not render a raw enum');
  // And every headline the model can produce is prose.
  for (const stage of ['follow_up', 'hot', 'call_booked', 'closed_won', 'closed_lost']) {
    const headline = ownershipSummary(inStage(stage), stage).headline;
    assert.ok(!/_/.test(headline), `"${headline}" leaks an enum`);
    assert.ok(headline.length > 0);
  }
});
