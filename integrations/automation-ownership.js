'use strict';
/**
 * automation-ownership.js — who owns the next move, and may anything execute it? PURE.
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 2.2 answered "what should happen next". This answers the question that
 * actually protects prospects: given that, is any automation permitted to act?
 *
 * THE INVARIANT
 *
 *   At most one actor owns an executable next move.
 *
 * Before this existed, three systems decided independently. The cold sender
 * asked `selectFollowUps` + `suppressionReason`. The sequence engine asked
 * `evaluateStageSequence`. The CRM asked `deriveNextAction`. Nothing reconciled
 * them, and they disagreed in production: Sparkle Dental Spa sat at ColdEmail
 * stage `Promoted` with `emailStatus: 'emailed'` and no MANUAL HOLD, so the CRM
 * considered it a live sales opportunity while `selectFollowUps` — which filters
 * on emailStatus and never looks at stage — still counted it as an ordinary cold
 * lead awaiting step 2. One dropped tag was all that stood between a promoted
 * opportunity and an automated cold follow-up.
 *
 * So ownership is derived ONCE, here, from canonical state, and the sender asks
 * this module rather than re-deriving eligibility of its own.
 *
 * WHAT THIS DOES NOT DO
 *
 * It never sends, enrols, promotes, holds, suppresses or writes. It returns a
 * verdict. Feature flags remain the final gate on top of it: owning the next
 * move is not permission to execute when sending is globally disabled.
 */

const { classify: classifyLeadEmail } = require('../check-leads');
const { REPLY_ACTION, ACTION_OWNER: OP_OWNER, WAITING_ON, deriveOperationalAction } = require('./reply-operations');
const { malformedEmailReason } = require('./canonical-reply');
const { leadHasReply } = require('./reply-analytics');

/**
 * Who owns the next executable move. Deliberately small, and mapped onto the
 * existing ACTION_OWNER vocabulary rather than inventing a parallel one.
 */
const OWNER = Object.freeze({
  HUMAN: 'human',                       // a person must decide or respond
  COLD_AUTOMATION: 'cold_automation',   // the ordinary campaign cadence
  RECOVERY_SEQUENCE: 'recovery_sequence', // an explicitly enrolled stage journey
  MEETING: 'meeting',                   // a scheduled/unresolved call governs it
  WAITING: 'waiting',                   // nothing should act yet
  NONE: 'none',                         // terminal, suppressed, or unsafe
});

// Why nothing may execute. Reported rather than collapsed into a boolean, so an
// operator can see WHICH guard stopped a send.
const BLOCKED_BY = Object.freeze({
  INVALID_IDENTITY: 'invalid_identity',
  TERMINAL_STAGE: 'terminal_stage',
  SUPPRESSION: 'suppression',
  MANUAL_HOLD: 'manual_hold',
  CONTACT_CHANGE_REVIEW: 'contact_change_review',
  MEETING_LIFECYCLE: 'meeting_lifecycle',
  HUMAN_OWNED: 'human_owned',
  WAITING_UNTIL_DATE: 'waiting_until_date',
  PROMOTED_TO_PIPELINE: 'promoted_to_pipeline',
  UNRECORDED_HUMAN_TOUCH: 'unrecorded_human_touch',
  SENDING_DISABLED: 'sending_disabled',
  SEQUENCES_DISABLED: 'sequences_disabled',
  NOTHING_DUE: 'nothing_due',
});

// ColdEmail stages that mean the lead has left ordinary cold cadence. Sparkle's
// `Promoted` is the one that mattered; the rest are listed because they are the
// same class of mistake waiting to happen.
const NON_COLD_STAGES = Object.freeze([
  'promoted', 'hot', 'call_booked', 'closed_won', 'closed_lost', 'closed',
  'won', 'lost', 'unsubscribed', 'unsub', 'review', 'replied', 'done',
]);

// Operational actions that mean a PERSON owns the conversation. Taken from the
// Phase 2.2 vocabulary rather than re-listed by hand, so a new human action type
// cannot silently fall through to cold automation.
const HUMAN_OWNED_ACTIONS = Object.freeze([
  REPLY_ACTION.RESPOND, REPLY_ACTION.CONTINUE_EVALUATION, REPLY_ACTION.BOOK_CALL,
  REPLY_ACTION.CONTACT_SUPPLIED, REPLY_ACTION.CONTACT_CHANGE_REVIEW,
  REPLY_ACTION.DECISION_MAKER_FOLLOW_UP, REPLY_ACTION.INVESTIGATE,
]);

const norm = value => String(value || '').trim().toLowerCase();
const isoOrNull = value => {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

function verdict({
  owner, reason, blockedBy = null, automationAllowed = false,
  sendAllowed = false, sequenceAllowed = false, resumeCondition = null,
  resumeAt = null, evidence = {}, source,
}) {
  return {
    owner, reason, blockedBy,
    // "Could a machine act here at all?" — distinct from whether it may send
    // right now, which feature flags and cadence still gate.
    automationAllowed,
    sendAllowed, sequenceAllowed,
    resumeCondition, resumeAt,
    evidence, source,
  };
}

/**
 * Derive automation ownership for one lead.
 *
 * PRECEDENCE — strongest first. Each rule answers "does something outrank what
 * the cadence wants to do?", and the order is deliberately the same shape as
 * deriveNextAction's, so ownership and Next Action cannot disagree:
 *
 *   1. invalid identity        cannot safely mail it at all
 *   2. terminal stage          a closed opportunity has no next move
 *   3. suppression             durable opt-out outranks everything
 *   4. unrecorded human touch  a person acted and the CRM cannot see it
 *   5. contact-change review   identity itself is in question
 *   6. meeting lifecycle       the calendar owns it
 *   7. human-owned reply       a person must move next
 *   8. waiting until a date    a real date was stated
 *   9. promoted to pipeline    left cold cadence, whatever the tag says
 *  10. enrolled recovery seq   explicitly handed to a journey
 *  11. cold automation         the ordinary cadence
 *  12. nothing due
 *
 * Identity comes first rather than terminal state because a malformed address
 * makes every later judgement meaningless — we would be reasoning about a
 * prospect we cannot actually reach.
 */
function deriveAutomationOwnership(lead = {}, {
  boardLead = null, activities = [], callState = null, sequenceState = null,
  suppressionReason = null, manualActionOverride = null, manualOverride = null,
  humanTouchAt = null, unrecordedHumanTouch = false,
  sendingEnabled = false, sequencesEnabled = false,
  now = new Date(), coldCadenceDue = false,
} = {}) {
  const stage = norm(lead.stage);
  const boardStage = norm(boardLead && boardLead.stage);

  // ── 1. Identity ──────────────────────────────────────────────────────────
  const identityIssue = malformedEmailReason(lead.email)
    || (classifyLeadEmail(lead.email) !== 'CLEAN' ? `address classified ${classifyLeadEmail(lead.email)}` : '');
  if (identityIssue) {
    return verdict({
      owner: OWNER.NONE, source: 'identity',
      reason: `the address cannot be trusted (${identityIssue}), so nothing may be sent to it`,
      blockedBy: BLOCKED_BY.INVALID_IDENTITY, evidence: { identityIssue },
    });
  }

  // ── 2. Terminal ──────────────────────────────────────────────────────────
  const terminal = ['closed_won', 'closed_lost', 'closed', 'won', 'lost'];
  if (terminal.includes(boardStage) || terminal.includes(stage)) {
    return verdict({
      owner: OWNER.NONE, source: 'terminal',
      reason: `the opportunity is ${boardStage || stage}; no automated follow-up applies`,
      blockedBy: BLOCKED_BY.TERMINAL_STAGE, evidence: { stage: boardStage || stage },
    });
  }

  // ── 3. Suppression — the sender's OWN rule, never a copy of it ───────────
  const suppressed = typeof suppressionReason === 'function' ? suppressionReason(lead) : null;
  if (suppressed) {
    const isHold = String(suppressed).includes('[MANUAL HOLD]');
    return verdict({
      owner: OWNER.NONE, source: 'suppression',
      reason: isHold
        ? 'a MANUAL HOLD blocks cold automation on this lead'
        : `suppressed (${suppressed}); no automated send may occur`,
      blockedBy: isHold ? BLOCKED_BY.MANUAL_HOLD : BLOCKED_BY.SUPPRESSION,
      // A hold blocks generic demo/Hot automation too. Only an explicit
      // lifecycle authorization (no-show, cancellation, selected timing date)
      // may run a recovery journey while the cold hold remains in place.
      sequenceAllowed: isHold && sequencesEnabled && Boolean(sequenceState
        && sequenceState.status === 'active'
        && ['no_show_recovery_v1', 'cancelled_rebook_v1', 'timing_recontact_v1']
          .includes(String(sequenceState.sequenceId || ''))),
      evidence: { suppressionReason: suppressed },
    });
  }

  // ── 4. A human acted and the CRM cannot see it ───────────────────────────
  // Fail closed. If someone emailed this prospect by hand and no canonical
  // evidence exists, automation is reasoning from an incomplete picture and
  // must not act until the record catches up.
  if (unrecordedHumanTouch) {
    return verdict({
      owner: OWNER.HUMAN, source: 'unrecorded_human_touch',
      reason: 'a manual outbound message exists with no canonical CRM record; automation is held until the timeline is complete',
      blockedBy: BLOCKED_BY.UNRECORDED_HUMAN_TOUCH,
      resumeCondition: 'record the manual touch in the canonical timeline',
      evidence: { humanTouchAt: isoOrNull(humanTouchAt) },
    });
  }

  // The Phase 2.2 operational truth, consumed rather than re-derived.
  const operation = deriveOperationalAction(lead, {
    activities, boardLead, callState, now,
    manualOverride, manualActionOverride, humanTouchAt,
    manualFollowUpDate: boardLead ? boardLead.followup : '',
    suppressionReason,
  });

  // ── 5. Contact change ────────────────────────────────────────────────────
  if (operation.action === REPLY_ACTION.CONTACT_CHANGE_REVIEW) {
    return verdict({
      owner: OWNER.HUMAN, source: 'contact_change',
      reason: 'a proposed address is awaiting human approval; the canonical identity is in question',
      blockedBy: BLOCKED_BY.CONTACT_CHANGE_REVIEW,
      resumeCondition: 'approve or reject the proposed address',
      evidence: { proposedEmail: operation.evidence.proposedEmail || null, identityMutationAllowed: false },
    });
  }

  // ── 6. Meeting lifecycle ─────────────────────────────────────────────────
  if (callState && ['scheduled', 'rescheduled'].includes(callState.status)) {
    return verdict({
      owner: OWNER.MEETING, source: 'call_lifecycle',
      reason: 'a meeting is scheduled; nothing else may contact this prospect first',
      blockedBy: BLOCKED_BY.MEETING_LIFECYCLE,
      resumeCondition: 'the meeting completes, cancels, or no-shows',
      resumeAt: isoOrNull(callState.meetingAt),
      evidence: { callStatus: callState.status },
    });
  }
  if (callState && callState.status === 'outcome_pending') {
    return verdict({
      owner: OWNER.HUMAN, source: 'call_lifecycle',
      reason: 'a past meeting has no recorded outcome; a person must say what happened',
      blockedBy: BLOCKED_BY.MEETING_LIFECYCLE,
      resumeCondition: 'record the call outcome',
      evidence: { callStatus: callState.status },
    });
  }

  // ── 7. A person owns the conversation ────────────────────────────────────
  //
  // `investigate` needs care. Phase 2.2 returns it whenever there is no
  // trustworthy reply evidence — which is the NORMAL state of a cold lead who
  // simply has not written back. Treating that as human-owned would have made
  // every untouched prospect a human task and stopped the campaign dead. So it
  // only counts as human work when the lead actually LOOKS like it replied,
  // using the canonical definition rather than a second opinion.
  const appearsToHaveReplied = leadHasReply(lead);
  const investigateIsRealWork = operation.action === REPLY_ACTION.INVESTIGATE && appearsToHaveReplied;
  const humanOwns = investigateIsRealWork
    || (operation.action !== REPLY_ACTION.INVESTIGATE
      && (HUMAN_OWNED_ACTIONS.includes(operation.action) || operation.owner === OP_OWNER.HUMAN));
  if (humanOwns) {
    return verdict({
      owner: OWNER.HUMAN, source: operation.source || 'reply_operation',
      reason: `a person owns the next move (${operation.action})`,
      blockedBy: BLOCKED_BY.HUMAN_OWNED,
      resumeCondition: 'a human responds, or explicitly hands the lead to a sequence',
      evidence: { action: operation.action, canonicalState: operation.evidence.canonicalState,
        waitingOn: operation.waitingOn },
    });
  }

  // ── 8. Waiting for a real, stated date ───────────────────────────────────
  // Only an actual date blocks. Ambiguous timing never becomes a schedule.
  if (operation.waitingOn === WAITING_ON.DATE && operation.dueAt) {
    const resumeAt = isoOrNull(operation.dueAt);
    const reached = resumeAt && new Date(now).getTime() >= Date.parse(resumeAt);
    if (!reached) {
      return verdict({
        owner: OWNER.WAITING, source: 'waiting_until_date',
        reason: `the prospect stated a return/revisit date; nothing sends before ${resumeAt}`,
        blockedBy: BLOCKED_BY.WAITING_UNTIL_DATE,
        resumeCondition: 'the stated date is reached', resumeAt,
        evidence: { action: operation.action, dueAtSource: operation.dueAtSource },
      });
    }
  }
  if ([WAITING_ON.PROSPECT, WAITING_ON.DECISION_MAKER].includes(operation.waitingOn)
    && operation.action === REPLY_ACTION.WAIT) {
    // An autoresponder with no date, or a genuine "ball in their court". No
    // human work, but nothing for cold cadence to do either — and crucially, an
    // automated reply must never look like a live conversation.
    return verdict({
      owner: OWNER.WAITING, source: 'waiting',
      reason: operation.reason || 'waiting on the prospect',
      blockedBy: BLOCKED_BY.NOTHING_DUE,
      evidence: { action: operation.action, waitingOn: operation.waitingOn,
        canonicalState: operation.evidence.canonicalState },
    });
  }

  // ── 9. Already promoted out of cold cadence ──────────────────────────────
  // THE SPARKLE FIX. Structural, not a patch: a lead that has left cold stages
  // is no longer cold-eligible regardless of whether anyone remembered to add
  // a MANUAL HOLD. The hold stays as an additional, independent safety tag.
  const promoted = NON_COLD_STAGES.includes(stage) || Boolean(boardLead);
  if (promoted) {
    return verdict({
      owner: OWNER.HUMAN, source: 'promoted',
      reason: boardLead
        ? 'the lead is in the Sales Pipeline; ordinary cold cadence no longer owns it'
        : `ColdEmail stage "${lead.stage}" is outside cold cadence`,
      blockedBy: BLOCKED_BY.PROMOTED_TO_PIPELINE,
      resumeCondition: 'a human returns the lead to a cold stage, or enrols a sequence',
      evidence: { coldStage: lead.stage || null, inPipeline: Boolean(boardLead),
        manualHoldPresent: String(lead.notes || '').includes('[MANUAL HOLD]') },
    });
  }

  // ── 10. An explicitly enrolled recovery sequence ─────────────────────────
  if (sequenceState && sequenceState.status === 'active') {
    return verdict({
      owner: OWNER.RECOVERY_SEQUENCE, source: 'stage_sequence',
      reason: `an enrolled ${sequenceState.sequenceId || 'stage'} sequence owns the next automated action`,
      automationAllowed: true,
      sequenceAllowed: Boolean(sequencesEnabled && sequenceState.eligible),
      blockedBy: sequencesEnabled ? null : BLOCKED_BY.SEQUENCES_DISABLED,
      resumeAt: isoOrNull(sequenceState.nextDueAt),
      evidence: { sequenceId: sequenceState.sequenceId, status: sequenceState.status,
        eligible: Boolean(sequenceState.eligible), featureEnabled: Boolean(sequencesEnabled) },
    });
  }

  // ── 11. Ordinary cold cadence ────────────────────────────────────────────
  return verdict({
    owner: OWNER.COLD_AUTOMATION, source: 'cold_cadence',
    reason: 'no human, meeting, sequence or waiting state owns this lead',
    automationAllowed: true,
    // Owning the move is not permission to execute it. The feature flag and the
    // cadence's own timing remain the final gates.
    sendAllowed: Boolean(sendingEnabled && coldCadenceDue),
    blockedBy: !sendingEnabled ? BLOCKED_BY.SENDING_DISABLED
      : (!coldCadenceDue ? BLOCKED_BY.NOTHING_DUE : null),
    evidence: { sendingEnabled: Boolean(sendingEnabled), cadenceDue: Boolean(coldCadenceDue),
      coldStage: lead.stage || null, emailStatus: lead.emailStatus || null },
  });
}

/**
 * The single question the sender asks before a provider call.
 *
 * Fails CLOSED: anything it does not positively recognise as a permitted cold
 * send is refused. The sender must not have a second opinion.
 */
function mayColdSend(ownership) {
  if (!ownership) return { allowed: false, reason: 'no ownership verdict was derived' };
  if (ownership.owner !== OWNER.COLD_AUTOMATION) {
    return { allowed: false, reason: `cold automation does not own this lead (${ownership.owner}: ${ownership.blockedBy || ownership.reason})` };
  }
  if (!ownership.sendAllowed) {
    return { allowed: false, reason: ownership.blockedBy || 'cold send is not permitted right now' };
  }
  return { allowed: true, reason: ownership.reason };
}

/** The equivalent gate for an enrolled stage sequence. */
function maySequenceSend(ownership) {
  if (!ownership) return { allowed: false, reason: 'no ownership verdict was derived' };
  if (ownership.owner !== OWNER.RECOVERY_SEQUENCE) {
    return { allowed: false, reason: `a sequence does not own this lead (${ownership.owner})` };
  }
  if (!ownership.sequenceAllowed) {
    return { allowed: false, reason: ownership.blockedBy || 'sequence execution is not permitted right now' };
  }
  return { allowed: true, reason: ownership.reason };
}

/** Exactly one actor may hold an executable move. Used by health and tests. */
function executableOwners(ownership) {
  if (!ownership) return [];
  const owners = [];
  if (ownership.sendAllowed) owners.push(OWNER.COLD_AUTOMATION);
  if (ownership.sequenceAllowed) owners.push(OWNER.RECOVERY_SEQUENCE);
  return owners;
}

module.exports = {
  OWNER, BLOCKED_BY, NON_COLD_STAGES, HUMAN_OWNED_ACTIONS,
  deriveAutomationOwnership, mayColdSend, maySequenceSend, executableOwners,
};
