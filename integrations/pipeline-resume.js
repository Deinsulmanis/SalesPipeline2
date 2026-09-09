'use strict';

// Human-authorized Pipeline handoff. The only injected write capabilities are
// notes and canonical activities. No sender, scheduler or reservation API.
const crypto = require('node:crypto');
const { displayStageFor } = require('./cold-call-pipeline');
const { hasManualHold, releaseHoldFromNotes, deriveCallLifecycle,
  deriveHotState, deriveNextAction, sendSuppressionReason } = require('./pipeline-state');
const { evaluateStageSequence, deriveSequenceState, provenSequenceSenderId,
  resolveSequenceThread, automaticEnrollmentDecision, SEQUENCES, SEQUENCE_EVENTS } = require('./stage-sequences');
const { deriveAutomationOwnership, ownershipSummary, executableOwners } = require('./automation-ownership');
const { latestHumanOutboundAt } = require('./human-outbound');

const meta = row => { try { return JSON.parse(row.metadata || '{}'); } catch (_) { return {}; } };
const norm = value => String(value || '').trim().toLowerCase();
const fail = (code, detail) => Object.assign(new Error(`Cannot resume automation — ${detail}`), { code });
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function stateVersion(s) {
  const { _row, _matchedBy, ...twin } = s.twins[0] || {};
  twin.notes = releaseHoldFromNotes(twin.notes || '');
  return digest({ boardLead: s.boardLead, twin, identityConflict: s.identityConflict,
    activities: s.activities.map(({ _row, ...row }) => row).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    suppressed: s.suppressedEmails.has(norm(twin.email)) });
}

function canonicalResult(s, activities = s.activities, twin = s.twins[0], now = new Date()) {
  const callState = deriveCallLifecycle(s.boardLead, { activities, now });
  const sequenceState = evaluateStageSequence({ boardLead: s.boardLead, twin, activities, callState,
    hotState: deriveHotState(s.boardLead, { activities, now }), now,
    suppressedEmails: s.suppressedEmails, identityConflict: s.identityConflict, featureEnabled: s.sequencesEnabled });
  const ownership = deriveAutomationOwnership(twin, { boardLead: s.boardLead, activities, callState, sequenceState,
    now, humanTouchAt: latestHumanOutboundAt(activities), sequencesEnabled: s.sequencesEnabled,
    suppressionReason: lead => sendSuppressionReason(lead, { suppressedEmails: s.suppressedEmails }) });
  const nextAction = deriveNextAction(s.boardLead, twin, { activities, sequenceState, now,
    sequencesEnabled: s.sequencesEnabled, suppressedEmails: s.suppressedEmails, observers: s.observers });
  return { owner: ownership.owner, blockedBy: ownership.blockedBy,
    ...ownershipSummary(ownership, displayStageFor(s.boardLead.stage)), ownership, sequenceState,
    journey: sequenceState.sequenceId || sequenceState.offer, nextAction,
    manualHold: hasManualHold(twin.notes), sendTriggered: false };
}

function enrollmentPlan(s, now = new Date()) {
  if (!s.boardLead) throw fail('not_found', 'Pipeline lead not found');
  if (['closed_won', 'closed_lost'].includes(displayStageFor(s.boardLead.stage))) {
    throw fail('terminal_stage', 'this opportunity is closed; there is no automation to resume');
  }
  if (s.twins.length !== 1 || s.identityConflict
    || norm(s.boardLead.email) !== norm(s.twins[0]?.email)) {
    throw fail('identity_conflict', 'a unique matching Pipeline and ColdEmail identity is required');
  }
  const twin = { ...s.twins[0], notes: releaseHoldFromNotes(s.twins[0].notes || '') };
  const suppression = sendSuppressionReason(twin, { suppressedEmails: s.suppressedEmails });
  if (suppression) throw fail('suppression', suppression);
  const current = canonicalResult(s, s.activities, twin, now);
  if (['invalid_identity', 'contact_change_review'].includes(current.blockedBy)) {
    throw fail(current.blockedBy, current.ownership.reason);
  }
  const callState = deriveCallLifecycle(s.boardLead, { activities: s.activities, now });
  if (['scheduled', 'rescheduled', 'outcome_pending'].includes(callState.status)) {
    throw fail('meeting_ownership', 'the meeting workflow requires ownership');
  }
  if (current.owner === 'human' && current.blockedBy !== 'awaiting_enrollment') {
    throw fail('human_ownership', current.ownership.reason);
  }
  if (!s.sequencesEnabled) throw fail('sequences_disabled', 'stage automation is disabled');
  const senderProof = provenSequenceSenderId(twin, s.activities);
  if (!senderProof.ok) throw fail('sender_unproven', senderProof.reason);
  if (!s.senders.some(sender => sender.id === senderProof.senderInboxId && sender.sendEligible)) {
    throw fail('sender_unavailable', 'the proven sending inbox is unavailable');
  }
  if (s.observers.find(o => o.senderInboxId === senderProof.senderInboxId)?.health !== 'healthy') {
    throw fail('observer_unavailable', 'Gmail observer unavailable');
  }
  const existing = deriveSequenceState(s.activities);
  const offers = current.sequenceState.offers;
  if (offers.length > 1) throw fail('ambiguous_journey', 'multiple automation journeys are eligible');
  if (!offers.length) throw fail('no_journey', 'no stage journey is currently available');
  const journey = offers[0];
  // The scheduler may have recorded the hold as a canonical stop. Releasing
  // that specific stop preserves completed steps; other stops need review.
  const stoppedByHold = existing.status === 'stopped'
    && existing.stopReason === 'manual hold — human owns this lead';
  const continuing = (existing.status === 'active' || stoppedByHold) && existing.sequenceId === journey;
  if (existing.status !== 'none' && !continuing) {
    throw fail('existing_journey', 'a different or inactive journey must be reviewed before this handoff');
  }
  if (current.sequenceState.stopReason && !stoppedByHold) throw fail('journey_blocked', current.sequenceState.stopReason);
  // This route consumes the stage engine's offers. It never adds generic
  // re-engagement candidates or invents a timing-recontact date.
  const thread = resolveSequenceThread(s.activities, { senderInboxId: senderProof.senderInboxId });
  if (!SEQUENCES[journey]?.freshThreadStep1 && !thread?.threadId) {
    if (s.activities.some(a => meta(a).senderInboxId === senderProof.senderInboxId
      && Array.isArray(meta(a).candidateThreadIds) && meta(a).candidateThreadIds.length > 1)) {
      throw fail('thread_ambiguous', 'multiple historical threads remain unresolved; a unique recovery conversation must be proven');
    }
    throw fail('thread_unproven', 'the required conversation thread is not proven for this inbox');
  }
  const decision = continuing ? { enroll: true } : automaticEnrollmentDecision({ twin, activities: s.activities, verdict: current.sequenceState,
    senderProof, thread, callState, hotState: deriveHotState(s.boardLead, { activities: s.activities, now }), now });
  if (!decision.enroll) throw fail('journey_blocked', decision.reason);
  const enrolledAt = new Date(now).toISOString();
  const key = `resume:${s.boardLead.id}:${digest({ version: stateVersion(s), journey }).slice(0, 24)}`;
  const common = { leadId: s.boardLead.id, sourceLeadId: twin.id, email: twin.email,
    company: s.boardLead.company || '', content: '' };
  const enrollment = { ...common, eventId: `${key}:${continuing ? 'resumed' : 'enrolled'}`,
    eventType: continuing ? SEQUENCE_EVENTS.RESUMED : SEQUENCE_EVENTS.ENROLLED,
    occurredAt: enrolledAt, subject: `${SEQUENCES[journey].label} ${continuing ? 'resumed' : 'enrolled'}`,
    metadata: JSON.stringify({ sequenceId: journey, enrollmentMode: 'human-authorized',
      authorization: 'human_resume_automation', trigger: 'crm_resume_automation',
      senderInboxId: senderProof.senderInboxId, gmailThreadId: thread?.threadId || '', handoffId: key }) };
  const result = canonicalResult(s, [...s.activities, enrollment], twin, now);
  if (result.owner !== 'recovery_sequence' || result.blockedBy || result.sequenceState.stopReason
    || !result.nextAction.dueAt || result.nextAction.owner !== 'automation'
    || executableOwners(result.ownership).length > 1) {
    throw fail('ownership_blocked', result.ownership.reason || 'the journey cannot safely own the next action');
  }
  const release = { ...common, eventId: `${key}:released`, eventType: 'automation_hold_released',
    occurredAt: enrolledAt, subject: 'Manual hold released',
    metadata: JSON.stringify({ trigger: 'crm_resume_automation', actor: 'human', previousHold: true,
      stage: displayStageFor(s.boardLead.stage), resultingOwner: result.owner, resultingBlocker: null,
      automationResumed: true, sendTriggered: false, handoffId: key, sequenceId: journey }) };
  return { key, journey, continuing, senderProof, thread, version: stateVersion(s), events: [release, enrollment], result };
}

function alreadyResumed(s, now) {
  if (!s.boardLead || s.twins.length !== 1 || hasManualHold(s.twins[0].notes)) return null;
  const state = deriveSequenceState(s.activities);
  const enrollment = s.activities.slice().reverse().find(a =>
    [SEQUENCE_EVENTS.ENROLLED, SEQUENCE_EVENTS.RESUMED].includes(a.eventType)
    && a.occurredAt >= state.enrolledAt && meta(a).sequenceId === state.sequenceId
    && meta(a).trigger === 'crm_resume_automation');
  if (!enrollment || !s.activities.some(a => a.eventId === `${meta(enrollment).handoffId}:released`)) return null;
  const result = canonicalResult(s, s.activities, s.twins[0], now);
  return { ok: true, alreadyResumed: true, automationResumed: state.status === 'active'
      && result.owner === 'recovery_sequence' && !result.sequenceState.stopReason,
    ...result,
    message: 'This Resume was already recorded. Current automation state refreshed.' };
}

async function resumePipeline({ read, writeNotes, restoreHold, appendEvents, verifyProof, now = () => new Date(), checkOnly = false }) {
  const before = await read();
  const duplicate = alreadyResumed(before, now());
  if (duplicate) return duplicate;
  const plan = enrollmentPlan(before, now());
  if (!hasManualHold(before.twins[0].notes)) throw fail('not_held', 'this lead is not on manual hold');
  const proof = await verifyProof(before, plan);
  if (!proof.ok) throw fail('proof_unavailable', proof.reason);
  if (checkOnly) return { ok: true, checkOnly: true, wouldEnroll: plan.journey,
    ...plan.result, automationResumed: false, message: 'Preview only. No changes made.' };
  // Re-read immediately before the first write, including notes and identity.
  const confirmed = await read();
  if (!hasManualHold(confirmed.twins[0]?.notes) || stateVersion(confirmed) !== plan.version) {
    throw fail('state_changed', 'the lead changed during validation; review its current state');
  }
  let enrollmentAttempted = false;
  try {
    await writeNotes(confirmed.twins[0], releaseHoldFromNotes(confirmed.twins[0].notes));
    const after = await read();
    if (after.twins.length !== 1 || hasManualHold(after.twins[0].notes)) {
      throw fail('release_unconfirmed', 'manual hold removal could not be confirmed');
    }
    const nextPlan = enrollmentPlan(after, new Date(plan.events[1].occurredAt));
    if (stateVersion(after) !== plan.version || nextPlan.journey !== plan.journey) {
      throw fail('state_changed', 'the lead changed after hold removal');
    }
    const freshProof = await verifyProof(after, nextPlan);
    if (!freshProof.ok || freshProof.version !== proof.version) {
      throw fail('proof_changed', freshProof.reason || 'mailbox evidence changed during the handoff');
    }
    const finalCheck = await read();
    enrollmentPlan(finalCheck, new Date(plan.events[1].occurredAt));
    if (hasManualHold(finalCheck.twins[0]?.notes) || stateVersion(finalCheck) !== plan.version) {
      throw fail('state_changed', 'the lead changed before enrollment');
    }
    enrollmentAttempted = true;
    // Both events are persisted in one batch. On an uncertain receipt, read
    // before deciding whether to compensate; never blindly retry an append.
    try { await appendEvents(plan.events); }
    catch (error) {
      const receipt = await read();
      if (!plan.events.every(e => receipt.activities.some(a => a.eventId === e.eventId))) throw error;
    }
    const saved = await read();
    if (!plan.events.every(e => saved.activities.some(a => a.eventId === e.eventId))) {
      throw fail('enrollment_unconfirmed', 'journey enrollment could not be confirmed');
    }
    // No unrelated evidence may have appeared while the event batch persisted.
    const withoutOwnEvents = { ...saved, activities: saved.activities.filter(a => !plan.events.some(e => e.eventId === a.eventId)) };
    if (stateVersion(withoutOwnEvents) !== plan.version || hasManualHold(saved.twins[0]?.notes)) {
      throw fail('state_changed', 'the lead changed while enrollment was saved');
    }
    const result = canonicalResult(saved, saved.activities, saved.twins[0], now());
    const committedProof = await verifyProof(saved, plan);
    if (!committedProof.ok || committedProof.version !== proof.version) {
      throw fail('proof_changed', committedProof.reason || 'mailbox evidence changed while enrollment was saved');
    }
    if (result.owner !== 'recovery_sequence' || result.sequenceState.stopReason) {
      throw fail('ownership_changed', 'the journey no longer owns the next action');
    }
    return { ok: true, automationResumed: true, ...result,
      message: `${SEQUENCES[plan.journey].label} active. Nothing was sent.` };
  } catch (error) {
    // Restore against a fresh notes read, preserving concurrent operator text.
    // Hold restoration is independent of the full activity/observer read.
    try {
      await restoreHold(before.twins[0]);
    } catch (rollbackError) {
      throw Object.assign(fail('rollback_unconfirmed', 'hold restoration could not be verified; automation remains locked pending recovery'),
        { rollbackUnconfirmed: true, cause: error, rollbackError });
    }
    const at = now().toISOString();
    const audit = { ...plan.events[0], eventId: `${plan.key}:rollback`, eventType: 'automation_held',
      occurredAt: at, subject: 'Manual hold restored after unsuccessful Resume',
      metadata: JSON.stringify({ trigger: 'crm_resume_rollback', handoffId: plan.key,
        reason: error.code || 'persistence_failed', sendTriggered: false }) };
    try {
      const saved = await read();
      const ownEnrollment = saved.activities.some(a => a.eventId === plan.events[1].eventId);
      const rows = [];
      if (enrollmentAttempted && ownEnrollment && !plan.continuing) {
        rows.push({ ...plan.events[1], eventId: `${plan.key}:cancelled`, eventType: SEQUENCE_EVENTS.CANCELLED,
          occurredAt: at, metadata: JSON.stringify({ sequenceId: plan.journey, trigger: 'crm_resume_rollback',
            reason: 'Resume failed; manual hold restored', handoffId: plan.key }) });
      }
      rows.push(audit);
      await appendEvents(rows.filter(row => !saved.activities.some(a => a.eventId === row.eventId)));
    } catch (auditError) {
      throw Object.assign(fail('rollback_audit_unconfirmed', 'manual hold restored, but rollback audit could not be confirmed'),
        { holdRestored: true, cause: error, auditError });
    }
    throw Object.assign(error.code ? error : fail('persistence_failed', 'the handoff could not be saved'), { holdRestored: true });
  }
}

module.exports = { enrollmentPlan, canonicalResult, stateVersion, resumePipeline, fail };
