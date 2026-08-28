'use strict';
/**
 * reply-operations.js — what should we DO about what the prospect said? PURE.
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 2.1 answered "what did the prospect say". This answers "so what should
 * ScaleLab do next", and keeps the two deliberately apart:
 *
 *   reply classification  what did they say        (canonical-reply)
 *   operational action    what should we do        (here)
 *   automation ownership  who is allowed to act    (owner + automationAllowed)
 *
 * That separation is the point. A reply that is `needs_human` might need an
 * answer today, a diary note for next quarter, or nothing at all — and the
 * classification cannot tell them apart, because they are not facts about the
 * message. Encoding them as reply states instead would mean inventing a new
 * reply state every time operations changed, so this layer grows the ACTION
 * vocabulary and leaves the reply vocabulary small and stable.
 *
 * Nothing here sends, schedules, promotes or mutates. It returns a decision for
 * a human or a later phase to act on: Phase 2.2 defines the truth, Phase 2.3
 * makes automation obey it.
 */

const {
  REPLY_STATE, NEEDS_HUMAN_REASON, AUTOMATED_SUBTYPE, EVIDENCE_SOURCE,
  GENUINE_HUMAN_STATES, resolveReplyState, classifyReplyText,
} = require('./canonical-reply');

/**
 * Operational actions. These EXTEND the existing ACTION_TYPE vocabulary in
 * pipeline-state rather than replacing it — the Step 8/9 lifecycle actions
 * (sales call, record outcome, hot follow-up) still own their situations, and
 * these only describe what a REPLY implies when no lifecycle outranks it.
 */
const REPLY_ACTION = Object.freeze({
  RESPOND: 'respond_reply',                       // reuses the existing type
  CONTINUE_EVALUATION: 'continue_evaluation',     // positive intent, keep selling
  BOOK_CALL: 'book_call',                         // they want to meet, nothing booked
  REVISIT_LATER: 'revisit_later',                 // clear deferral
  DECISION_MAKER_FOLLOW_UP: 'decision_maker_follow_up',
  CONTACT_SUPPLIED: 'contact_supplied',           // they handed us an address
  CONTACT_CHANGE_REVIEW: 'contact_change_review', // mailbox migration, needs approval
  WAIT_UNTIL_RETURN: 'wait_until_return',         // closure/OOO with a known date
  WAIT: 'waiting_prospect',                       // reuses the existing type
  NO_ACTION_SUPPRESSED: 'no_action_suppressed',   // terminal / opted out
  INVESTIGATE: 'investigate',                     // unknown, malformed, conflicting
});

// Who is expected to move next. Mirrors pipeline-state's ACTION_OWNER values so
// the two vocabularies stay one vocabulary.
const ACTION_OWNER = Object.freeze({
  HUMAN: 'human', PROSPECT: 'prospect', CALENDAR: 'meeting',
  AUTOMATION: 'automation', NONE: 'none',
});

/**
 * Who we are waiting on. Extends Step 8's WAITING_ON (us / prospect / meeting /
 * unknown) with the two states reply operations genuinely need and Hot never
 * had a way to say. Step 8's own values are preserved exactly, so Hot behaviour
 * is unchanged.
 */
const WAITING_ON = Object.freeze({
  US: 'waiting_on_us',
  PROSPECT: 'waiting_on_prospect',
  MEETING: 'meeting_scheduled',
  DATE: 'waiting_until_date',            // a known return/revisit instant
  DECISION_MAKER: 'waiting_on_decision_maker',
  HUMAN_REVIEW: 'human_review_required',
  NONE: 'none',                          // terminal / suppressed
  UNKNOWN: 'unknown',
});

// Where a due date came from. Kept visible so nobody has to guess whether a
// date was stated by the prospect or derived by policy.
const DUE_SOURCE = Object.freeze({
  PROSPECT_STATED: 'prospect_stated_date',
  MANUAL_FOLLOW_UP: 'manual_follow_up_date',
  MEETING: 'scheduled_meeting',
  REPLY_RECEIVED: 'reply_received_at',
  NONE: 'none',
});

const PRIORITY = Object.freeze({ URGENT: 1, HIGH: 2, NORMAL: 3, LOW: 4, NONE: 9 });

function operation({
  action, reason, owner, waitingOn, priority = PRIORITY.NORMAL,
  dueAt = null, dueAtSource = DUE_SOURCE.NONE, automationAllowed = false,
  requiresHumanReview = false, evidence = {},
}) {
  return {
    action, reason, owner, waitingOn, priority,
    dueAt, dueAtSource,
    // Phase 2.2 never turns automation ON. This says whether an action is the
    // KIND a machine could take; Phase 2.3 decides whether it actually does.
    automationAllowed,
    requiresHumanReview,
    evidence,
  };
}

const isoOrNull = value => {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

/**
 * Derive the operational action implied by a lead's reply state.
 *
 * This is the REPLY layer only. It does not know about meetings, terminal
 * stages or sequences — the caller applies those first, because a booked call
 * outranks anything a two-week-old email said.
 */
function deriveReplyOperation(lead = {}, {
  activities = [], manualOverride = null, manualFollowUpDate = '',
} = {}) {
  const resolved = resolveReplyState(lead, { activities, manualOverride });
  const evidence = {
    canonicalState: resolved.state,
    canonicalReason: resolved.reason || null,
    subtype: resolved.subtype || null,
    evidenceSource: resolved.source,
    genuineHuman: Boolean(resolved.genuineHuman),
    providerMessageId: resolved.providerMessageId || null,
    occurredAt: resolved.occurredAt || null,
    identityIssue: resolved.identityIssue || null,
    overrideId: resolved.overrideId || null,
    overriddenBy: resolved.overriddenBy || null,
    overriddenAt: resolved.overriddenAt || null,
  };

  const manualDue = isoOrNull(manualFollowUpDate);
  const withManualDate = base => (manualDue && !base.dueAt
    ? { ...base, dueAt: manualDue, dueAtSource: DUE_SOURCE.MANUAL_FOLLOW_UP }
    : base);

  // ── Nothing to trust ─────────────────────────────────────────────────────
  // Unknown state or a malformed identity is an operational dead end, not a
  // sales situation. Inventing a follow-up here would mean acting on evidence
  // we have already said we do not have.
  if (resolved.state === REPLY_STATE.UNKNOWN) {
    return operation({
      action: REPLY_ACTION.INVESTIGATE,
      reason: resolved.identityIssue
        ? 'the lead identity is malformed, so no reply evidence can be trusted'
        : 'no trustworthy reply evidence exists for this lead',
      owner: ACTION_OWNER.HUMAN, waitingOn: WAITING_ON.HUMAN_REVIEW,
      priority: PRIORITY.LOW, requiresHumanReview: true, evidence,
    });
  }

  // ── A machine answered ───────────────────────────────────────────────────
  if (resolved.state === REPLY_STATE.AUTOMATED_REPLY) {
    const returnDate = isoOrNull(resolved.returnDate);
    if (returnDate) {
      return operation({
        action: REPLY_ACTION.WAIT_UNTIL_RETURN,
        reason: `${resolved.subtype || 'automated reply'} with a stated return date`,
        owner: ACTION_OWNER.NONE, waitingOn: WAITING_ON.DATE,
        priority: PRIORITY.LOW,
        dueAt: returnDate, dueAtSource: DUE_SOURCE.PROSPECT_STATED,
        evidence,
      });
    }
    // No date was stated, so none is invented. There is simply nothing to do
    // yet, and pretending otherwise would create fake human work.
    return operation({
      action: REPLY_ACTION.WAIT,
      reason: `${resolved.subtype || 'automated reply'} with no stated return date`,
      owner: ACTION_OWNER.NONE, waitingOn: WAITING_ON.PROSPECT,
      priority: PRIORITY.LOW, evidence,
    });
  }

  // ── They want us to write to someone else ────────────────────────────────
  if (resolved.state === REPLY_STATE.CONTACT_CHANGE_REVIEW) {
    return operation({
      action: REPLY_ACTION.CONTACT_CHANGE_REVIEW,
      reason: 'a new mailbox was proposed and needs human approval before use',
      owner: ACTION_OWNER.HUMAN, waitingOn: WAITING_ON.HUMAN_REVIEW,
      priority: PRIORITY.NORMAL, requiresHumanReview: true,
      evidence: { ...evidence, proposedEmail: resolved.proposedEmail || null,
        identityMutationAllowed: false },
    });
  }

  // ── They said no ─────────────────────────────────────────────────────────
  if (resolved.state === REPLY_STATE.NEGATIVE) {
    return operation({
      action: REPLY_ACTION.NO_ACTION_SUPPRESSED,
      reason: resolved.reason === 'unsubscribe_request'
        ? 'the prospect opted out' : 'the prospect declined',
      owner: ACTION_OWNER.NONE, waitingOn: WAITING_ON.NONE,
      priority: PRIORITY.NONE, evidence,
    });
  }

  // ── They are interested ──────────────────────────────────────────────────
  if (resolved.state === REPLY_STATE.POSITIVE) {
    const signals = (resolved.evidenceSignals || resolved.signals || []);
    // A meeting request is a different job from general evaluation: there is a
    // concrete thing to do, and it belongs to the calendar.
    if (signals.includes('meeting')) {
      return withManualDate(operation({
        action: REPLY_ACTION.BOOK_CALL,
        reason: 'the prospect asked to meet and no future booking exists',
        owner: ACTION_OWNER.HUMAN, waitingOn: WAITING_ON.US,
        priority: PRIORITY.URGENT,
        dueAt: isoOrNull(resolved.occurredAt), dueAtSource: DUE_SOURCE.REPLY_RECEIVED,
        evidence,
      }));
    }
    return withManualDate(operation({
      action: REPLY_ACTION.CONTINUE_EVALUATION,
      reason: 'explicit evaluation intent — continue the sales conversation',
      owner: ACTION_OWNER.HUMAN, waitingOn: WAITING_ON.US,
      priority: PRIORITY.URGENT,
      dueAt: isoOrNull(resolved.occurredAt), dueAtSource: DUE_SOURCE.REPLY_RECEIVED,
      evidence,
    }));
  }

  // ── A human wrote, and what to do depends on WHY ─────────────────────────
  // This is the heart of Phase 2.2: needs_human stops being one bucket.
  switch (resolved.reason) {
    case NEEDS_HUMAN_REASON.DEFERRED_TIMING: {
      // A stated revisit date is used; a vague "later" leaves dueAt null rather
      // than manufacturing a commitment the prospect never made.
      const revisit = isoOrNull(resolved.revisitDate);
      return withManualDate(operation({
        action: REPLY_ACTION.REVISIT_LATER,
        reason: revisit
          ? 'the prospect deferred and named a time'
          : 'the prospect deferred without naming a time — a human should set one',
        owner: revisit ? ACTION_OWNER.NONE : ACTION_OWNER.HUMAN,
        waitingOn: revisit ? WAITING_ON.DATE : WAITING_ON.HUMAN_REVIEW,
        priority: PRIORITY.LOW,
        dueAt: revisit, dueAtSource: revisit ? DUE_SOURCE.PROSPECT_STATED : DUE_SOURCE.NONE,
        requiresHumanReview: !revisit,
        evidence,
      }));
    }
    case NEEDS_HUMAN_REASON.DECISION_MAKER_CONTACT_SUPPLIED:
      return withManualDate(operation({
        action: REPLY_ACTION.CONTACT_SUPPLIED,
        reason: 'a decision-maker address was supplied and needs a human decision',
        owner: ACTION_OWNER.HUMAN, waitingOn: WAITING_ON.US,
        priority: PRIORITY.HIGH,
        dueAt: isoOrNull(resolved.occurredAt), dueAtSource: DUE_SOURCE.REPLY_RECEIVED,
        requiresHumanReview: true,
        // Explicit: the supplied address is evidence. Nothing may mail it, and
        // it is NOT a replacement for the prospect's canonical identity.
        evidence: { ...evidence, suppliedContact: resolved.suppliedContact || null,
          identityMutationAllowed: false, autoSendAllowed: false },
      }));
    case NEEDS_HUMAN_REASON.FORWARDED_TO_DECISION_MAKER:
      return withManualDate(operation({
        action: REPLY_ACTION.DECISION_MAKER_FOLLOW_UP,
        reason: 'the message was passed to a decision maker; follow up on the outcome',
        owner: ACTION_OWNER.HUMAN, waitingOn: WAITING_ON.DECISION_MAKER,
        priority: PRIORITY.NORMAL,
        dueAt: isoOrNull(resolved.occurredAt), dueAtSource: DUE_SOURCE.REPLY_RECEIVED,
        evidence,
      }));
    case NEEDS_HUMAN_REASON.QUESTION_OR_OBJECTION:
    case NEEDS_HUMAN_REASON.ADMINISTRATIVE_RESPONSE:
      return withManualDate(operation({
        action: REPLY_ACTION.RESPOND,
        reason: 'a person asked something and is waiting on an answer',
        owner: ACTION_OWNER.HUMAN, waitingOn: WAITING_ON.US,
        priority: PRIORITY.HIGH,
        dueAt: isoOrNull(resolved.occurredAt), dueAtSource: DUE_SOURCE.REPLY_RECEIVED,
        evidence,
      }));
    default:
      return withManualDate(operation({
        action: REPLY_ACTION.RESPOND,
        reason: 'a human replied and the intent is unclear — read it',
        owner: ACTION_OWNER.HUMAN, waitingOn: WAITING_ON.US,
        priority: PRIORITY.NORMAL,
        dueAt: isoOrNull(resolved.occurredAt), dueAtSource: DUE_SOURCE.REPLY_RECEIVED,
        requiresHumanReview: true, evidence,
      }));
  }
}

/**
 * Has a human already answered this reply? If so the ball is with the prospect,
 * whatever the reply originally asked for — this is what stops a two-week-old
 * "Respond to positive reply" hanging around after we responded.
 */
function answeredAfter(replyAt, humanTouchAt) {
  const reply = Date.parse(replyAt || '');
  const touch = Date.parse(humanTouchAt || '');
  return Number.isFinite(reply) && Number.isFinite(touch) && touch > reply;
}

module.exports = {
  REPLY_ACTION, ACTION_OWNER, WAITING_ON, DUE_SOURCE, PRIORITY,
  deriveReplyOperation, answeredAfter, operation,
};

// ── CONVERSATION-AWARE PRECEDENCE ───────────────────────────────────────────

/**
 * The operational truth for a lead, given EVERYTHING we know — not just the
 * classification of one historical message.
 *
 * CRM-wide precedence belongs to pipeline-state. This helper deliberately
 * answers only the reply/conversation part: an explicit action override,
 * whether we already answered, and what the canonical reply implies. Terminal,
 * meeting, Hot, sequence and suppression precedence are applied once by
 * deriveNextAction() before this helper is called.
 */
function deriveOperationalAction(lead = {}, {
  activities = [], boardLead = null,
  manualOverride = null, manualActionOverride = null, manualFollowUpDate = '',
  humanTouchAt = null,
} = {}) {
  // A human decision about what to DO outranks everything derived — but it is
  // stored separately from the reply classification, so acting on a lead later
  // never requires pretending the prospect said something they did not.
  if (manualActionOverride && manualActionOverride.action) {
    return {
      ...operation({
        action: manualActionOverride.action,
        reason: manualActionOverride.reason || 'a human set this action explicitly',
        owner: manualActionOverride.owner || ACTION_OWNER.HUMAN,
        waitingOn: manualActionOverride.waitingOn || WAITING_ON.US,
        priority: manualActionOverride.priority || PRIORITY.NORMAL,
        dueAt: isoOrNull(manualActionOverride.dueAt),
        dueAtSource: manualActionOverride.dueAt ? DUE_SOURCE.MANUAL_FOLLOW_UP : DUE_SOURCE.NONE,
        requiresHumanReview: false,
        evidence: { overrideId: manualActionOverride.overrideId || null,
          overriddenBy: manualActionOverride.by || null, overriddenAt: manualActionOverride.at || null },
      }),
      source: 'manual_action_override',
    };
  }

  // What the conversation implies.
  const derived = deriveReplyOperation(lead, { activities, manualOverride, manualFollowUpDate });

  // Historical canonical events intentionally remain immutable. When an old
  // low-confidence `unclear_intent` event is accompanied by a human-authored
  // CRM conversation note that now maps to a *narrow* operational reason, use
  // that note for the job only. This does not alter resolved.state/reason and
  // therefore cannot move reply analytics. Only deferral/contact-supplied are
  // allowed here; broad sentiment reclassification is deliberately excluded.
  if (!manualOverride && derived.evidence.canonicalState === REPLY_STATE.NEEDS_HUMAN
    && derived.evidence.canonicalReason === NEEDS_HUMAN_REASON.UNCLEAR_INTENT) {
    const crmContext = String((boardLead && (boardLead.conversationContext || boardLead.notes)) || '').trim();
    if (crmContext) {
      const interpreted = classifyReplyText(crmContext, { currentEmail: lead.email });
      if ([NEEDS_HUMAN_REASON.DEFERRED_TIMING, NEEDS_HUMAN_REASON.DECISION_MAKER_CONTACT_SUPPLIED]
        .includes(interpreted.reason)) {
        const contextual = deriveReplyOperation(lead, { activities, manualOverride: {
          state: REPLY_STATE.NEEDS_HUMAN, reason: interpreted.reason,
          at: null, by: 'crm_conversation_context',
          revisitDate: interpreted.revisitDate || null,
          suppliedContact: interpreted.suppliedContact || null,
        }, manualFollowUpDate });
        return { ...contextual, source: 'crm_context_interpretation', evidence: {
          ...contextual.evidence, canonicalState: derived.evidence.canonicalState,
          canonicalReason: derived.evidence.canonicalReason,
          operationalReason: interpreted.reason,
          evidenceSource: derived.evidence.evidenceSource,
          contextSource: boardLead.conversationContext ? 'conversation_context' : 'crm_notes',
        } };
      }
    }
  }

  // Unless we already answered it. Checked here rather than earlier
  // because it only makes sense against a reply we actually found.
  const repliedAt = derived.evidence.occurredAt;
  if (repliedAt && answeredAfter(repliedAt, humanTouchAt)
    && derived.owner === ACTION_OWNER.HUMAN
    && derived.action !== REPLY_ACTION.CONTACT_CHANGE_REVIEW) {
    return { ...operation({
      action: REPLY_ACTION.WAIT,
      reason: 'we replied after their last message; the ball is with the prospect',
      owner: ACTION_OWNER.PROSPECT, waitingOn: WAITING_ON.PROSPECT, priority: PRIORITY.LOW,
      evidence: { ...derived.evidence, answeredAt: humanTouchAt },
    }), source: 'already_answered' };
  }

  return { ...derived, source: 'reply_evidence' };
}

module.exports.deriveOperationalAction = deriveOperationalAction;
