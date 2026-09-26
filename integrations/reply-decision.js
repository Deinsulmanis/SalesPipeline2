'use strict';

/**
 * One authoritative production decision per inbound message.
 *
 * Before this module the reply pass carried loose variables through its
 * branches. The observer had already stored the rule classifier's canonical
 * state; routing followed the model or staffing-overlay category; the auto-send
 * score came from rule signals; and nothing recorded what was executed.
 * Analytics read the first answer, suppression and promotion followed the
 * last, and the shadow agent guessed production's action by re-running the
 * policy without its inputs.
 *
 * A decision keeps three things apart:
 *   interpretation  what the message means (each component, plus the final one)
 *   policy          what deterministic rules chose to do about it
 *   execution       what actually happened
 *
 * Pure: it never sends, writes or suppresses. outreach-agent executes the
 * decision and persists it. The deterministic safety spine (suppression, holds,
 * ownership, send gates) is untouched; this records what those gates did.
 */

const {
  REPLY_STATE, NEEDS_HUMAN_REASON, LEGACY_REPLY_EVENT_TYPES,
  hasExplicitUnsubscribePhrase, hasExplicitNegativePhrase,
} = require('./canonical-reply');
const { ACTION, POLICY_VERSION, POSITIVE_AUTOSEND_FLOOR } = require('./reply-response-policy');
const { overlayStaffingReplyClassification } = require('./staffing-reply-policy');
const { isStaffingCampaign } = require('./staffing-campaign');

const REPLY_DECISION_EVENT = 'reply_decision_recorded';
const REPLY_DECISION_VERSION = 'reply_decision_v1';

// Which component produced a classification. The first five are the reply
// classifier's (classifyReplyDetailed); the overlay is applied after it.
const CLASSIFICATION_SOURCE = Object.freeze({
  RULE: 'rule',
  FAIL_SAFE_PHRASE: 'fail_safe_phrase',
  MODEL: 'model',
  // The model was not used (no key, error, budget, unusable output) and the
  // fail-safe or NEEDS_HUMAN fallback stood in for it.
  MODEL_FALLBACK: 'model_fallback',
  PRIOR_EVALUATION: 'prior_evaluation',
  STAFFING_OVERLAY: 'staffing_overlay',
});

// Which deterministic step chose the policy action.
const POLICY_SOURCE = Object.freeze({
  REPLY_ROUTE: 'reply_route',               // the reply handler switch itself
  REPLY_RESPONSE_POLICY: 'reply_response_policy', // decideReplyResponse
  QUESTION_ANSWERER: 'question_answerer',   // answerQuestion confidence + vetoes
  STAFFING_GUARD: 'staffing_guard',         // unrouted / candidate-side block
});

const ROUTE = Object.freeze({
  UNSUBSCRIBE: 'unsubscribe',
  NOT_INTERESTED: 'not_interested',
  TIMING: 'timing',
  ALREADY_HANDLED: 'already_handled',
  WRONG_PERSON: 'wrong_person',
  OUT_OF_OFFICE: 'out_of_office',
  HISTORICAL_REVIEW: 'historical_review',
  HISTORICAL_NO_ACTION: 'historical_no_action',
  QUESTION: 'question',
  SEND_INFO: 'send_info',
  STAFFING_QUALIFICATION: 'staffing_qualification',
  INTERESTED: 'interested',
  MEETING_REQUEST: 'meeting_request',
  NEEDS_HUMAN: 'needs_human',
});

const EXECUTION_STATUS = Object.freeze({
  PENDING: 'pending',
  SENT: 'sent',
  ALREADY_SENT: 'already_sent',
  SUPPRESSED: 'suppressed',
  ROUTED_TO_HUMAN: 'routed_to_human',
  WAITING: 'waiting',
  RECONTACT_SCHEDULED: 'recontact_scheduled',
  // A deterministic gate refused an automated action before any provider call.
  BLOCKED: 'blocked',
  // The provider rejected the send, or its outcome is ambiguous.
  FAILED: 'failed',
  SKIPPED: 'skipped',
  // The handler returned without reporting. Treated as needing a human.
  UNREPORTED: 'unreported',
});

const EFFECT = Object.freeze({
  PROMOTED_HOT: 'promoted_hot',
  SUPPRESSION_ADDED: 'suppression_added',
  DRAFT_QUEUED: 'draft_queued',
  HOLD_APPLIED: 'hold_applied',
});

// The category production acts on, in canonical-state terms.
const CATEGORY_STATE = Object.freeze({
  INTERESTED: REPLY_STATE.POSITIVE, MEETING_REQUEST: REPLY_STATE.POSITIVE, SEND_INFO: REPLY_STATE.POSITIVE,
  NOT_INTERESTED: REPLY_STATE.NEGATIVE, UNSUBSCRIBE: REPLY_STATE.NEGATIVE,
  QUESTION: REPLY_STATE.NEEDS_HUMAN, NEEDS_HUMAN: REPLY_STATE.NEEDS_HUMAN,
  WRONG_PERSON: REPLY_STATE.NEEDS_HUMAN, ALREADY_HANDLED: REPLY_STATE.NEEDS_HUMAN,
  OUT_OF_OFFICE: REPLY_STATE.AUTOMATED_REPLY,
});

const DELIVERY_FAILURE_CODES = new Set(['provider_rejected', 'provider_ambiguous']);
const HISTORICAL_SKIP_CODE = 'historical_or_check_only';

const text = (value, max = 300) => (value === undefined || value === null ? null : String(value).slice(0, max));
const upper = value => String(value || '').trim().toUpperCase();
const finiteOrNull = value => (value === '' || value === null || value === undefined
  || !Number.isFinite(Number(value)) ? null : Number(value));

function ruleSummary(canonical = {}) {
  return {
    state: canonical.state || null,
    reason: canonical.reason || null,
    subtype: canonical.subtype || null,
    confidence: canonical.confidence || null,
    signals: Array.isArray(canonical.signals) ? [...canonical.signals] : [],
    revisitDate: canonical.revisitDate || null,
    returnDate: canonical.returnDate || null,
    classifierVersion: canonical.classifierVersion || null,
  };
}

/**
 * The canonical state of what production acted on. When the rule classifier
 * produced the final category its richer state is kept (an informational
 * pricing question is canonically positive but routes as QUESTION). When the
 * model or the staffing overlay changed the category, the state follows it.
 */
function finalCanonicalState({ classification, source, rule = {}, overlayCanonical = null }) {
  const kind = upper(classification);
  if (source === CLASSIFICATION_SOURCE.STAFFING_OVERLAY) {
    // A blocked overlay (candidate-side, referral, existing provider) is a
    // review case whatever the rule classifier thought of the wording.
    if (kind === 'WRONG_PERSON' || kind === 'ALREADY_HANDLED') return REPLY_STATE.NEEDS_HUMAN;
    return (overlayCanonical && overlayCanonical.state) || CATEGORY_STATE[kind] || rule.state || null;
  }
  if (source === CLASSIFICATION_SOURCE.RULE) return rule.state || CATEGORY_STATE[kind] || null;
  return CATEGORY_STATE[kind] || rule.state || null;
}

function replyDecisionEventId(leadId, messageId) {
  const lead = String(leadId || '').replace(/^CE-/, '').trim();
  const message = String(messageId || '').trim();
  return lead && message ? `reply-decision:${lead}:${message}` : '';
}

/**
 * Interpretation. Records every component classification and names the one
 * production acts on.
 *
 * `terminal` is the explicit unsubscribe / rejection short-circuit the reply
 * pass applies before any classifier call. `classifier` is the result of
 * classifyReplyDetailed. `overlay` is overlayStaffingReplyClassification's
 * result, applied exactly as the reply pass applies it.
 */
function createReplyDecision({
  lead = {}, message = {}, ruleCanonical = {}, ruleClassification = '',
  terminal = null, classifier = null, overlay = null, now = new Date(),
} = {}) {
  let classification = '';
  let source = null;
  if (terminal && terminal.classification) {
    classification = upper(terminal.classification);
    source = terminal.source || CLASSIFICATION_SOURCE.RULE;
  } else if (classifier && classifier.classification) {
    classification = upper(classifier.classification);
    source = classifier.source || null;
  }
  const upstreamClassification = classification;
  const overlayApplied = Boolean(overlay && overlay.overlay && overlay.classification);
  if (overlayApplied) {
    classification = upper(overlay.classification);
    source = CLASSIFICATION_SOURCE.STAFFING_OVERLAY;
  }
  const rule = ruleSummary(ruleCanonical);
  const leadId = String(lead.id || '').trim();
  const messageId = String(message.messageId || message.id || '').trim();
  return {
    decisionVersion: REPLY_DECISION_VERSION,
    decisionId: replyDecisionEventId(leadId, messageId),
    leadId,
    inboundMessageId: messageId,
    inboundThreadId: String(message.threadId || '').trim() || null,
    email: String(lead.email || '').trim(),
    receivedAt: message.occurredAt || null,
    decidedAt: new Date(now).toISOString(),

    // ── A. interpretation ────────────────────────────────────────────────
    ruleClassification: upper(ruleClassification) || null,
    ruleCanonical: rule,
    modelClassification: classifier && classifier.modelClassification ? upper(classifier.modelClassification) : null,
    modelStatus: (classifier && classifier.modelStatus) || 'not_called',
    classifierModel: (classifier && classifier.model) || null,
    // The category the terminal check or classifier produced, before the overlay.
    upstreamClassification: upstreamClassification || null,
    overlayClassification: overlayApplied ? upper(overlay.classification) : null,
    overlay: overlayApplied ? {
      classification: upper(overlay.classification),
      fit: overlay.fit || null,
      intent: overlay.intent || null,
      blocked: Boolean(overlay.blocked),
      reason: text(overlay.reason),
    } : null,
    finalClassification: classification || null,
    finalClassificationSource: source,
    canonicalState: finalCanonicalState({
      classification, source, rule, overlayCanonical: overlayApplied ? overlay.canonical : null,
    }),
    // The confidence of the component that produced finalClassification. Only
    // the rule classifier reports one; the model returns a bare label.
    classificationConfidence: source === CLASSIFICATION_SOURCE.RULE ? rule.confidence : null,
    classificationConfidenceSource: source === CLASSIFICATION_SOURCE.RULE ? 'rule_canonical' : null,
    qualificationState: overlayApplied && overlay.fit ? overlay.fit : null,

    // ── B. policy ────────────────────────────────────────────────────────
    route: null,
    policyAction: null,
    policySend: null,
    policyReason: null,
    policySource: null,
    policyDeferredTo: null,
    // The numeric score compared with the auto-send floor, and where it came from.
    policyConfidence: null,
    policyConfidenceSource: null,
    policyConfidenceFloor: null,

    // ── C. execution ─────────────────────────────────────────────────────
    executedAction: null,
    executionStatus: EXECUTION_STATUS.PENDING,
    executionCode: null,
    executionReason: null,
    fallbackAction: null,
    effects: [],
    executedAt: null,
    requiresHumanAttention: null,

    classifierVersion: rule.classifierVersion,
    policyVersion: POLICY_VERSION,
  };
}

function recordPolicy(decision, {
  action, send = false, reason = '', source = POLICY_SOURCE.REPLY_ROUTE,
  confidence = null, confidenceSource = null, floor = null, classification = '',
} = {}) {
  if (!decision) return decision;
  decision.policyAction = action || null;
  decision.policySend = Boolean(send);
  decision.policyReason = text(reason);
  decision.policySource = source;
  decision.policyDeferredTo = null;
  decision.policyConfidence = finiteOrNull(confidence);
  decision.policyConfidenceSource = decision.policyConfidence === null ? null : (confidenceSource || null);
  decision.policyConfidenceFloor = decision.policyConfidence === null ? null : finiteOrNull(floor);
  // Only recorded when a handler evaluated policy on a different category than
  // the final one. It should never happen; if it does, it is visible.
  const kind = upper(classification);
  if (kind && kind !== decision.finalClassification) decision.policyClassification = kind;
  return decision;
}

/**
 * Policy for everything the reply switch decides by itself, and the route for
 * the rest. Mirrors the reply pass's dispatch order exactly: opt-out and
 * rejection first, then the rule classifier's timing evidence, then the
 * category. QUESTION and the positive categories are decided later by the
 * question answerer and decideReplyResponse, which record their own policy.
 */
function planReplyRoute(decision, { maySend = true } = {}) {
  const kind = decision.finalClassification || '';
  const rule = decision.ruleCanonical || {};
  const set = (route, action, reason) => {
    decision.route = route;
    recordPolicy(decision, { action, send: false, reason, source: POLICY_SOURCE.REPLY_ROUTE });
    return decision;
  };
  const defer = (route, to) => {
    decision.route = route;
    decision.policyDeferredTo = to;
    return decision;
  };
  if (kind === 'UNSUBSCRIBE') return set(ROUTE.UNSUBSCRIBE, ACTION.SUPPRESS, 'explicit opt-out');
  if (kind === 'NOT_INTERESTED') return set(ROUTE.NOT_INTERESTED, ACTION.AUTO_NEGATIVE_CLOSE, 'explicit negative');
  if (rule.reason === NEEDS_HUMAN_REASON.DEFERRED_TIMING || rule.revisitDate) {
    return rule.revisitDate
      ? set(ROUTE.TIMING, ACTION.AUTO_TIMING_RECONTACT, 'prospect stated a recontact date')
      : set(ROUTE.TIMING, ACTION.HUMAN_REVIEW, 'undated deferral held for human review');
  }
  if (kind === 'ALREADY_HANDLED') {
    return set(ROUTE.ALREADY_HANDLED, ACTION.HUMAN_REVIEW, 'existing provider or internal team requires review');
  }
  if (kind === 'WRONG_PERSON') return set(ROUTE.WRONG_PERSON, ACTION.HUMAN_REVIEW, 'wrong person or referral requires review');
  if (kind === 'OUT_OF_OFFICE') return set(ROUTE.OUT_OF_OFFICE, ACTION.WAIT_OUT_OF_OFFICE, 'automated reply');
  if (!maySend) {
    return kind === 'QUESTION' || kind === 'NEEDS_HUMAN'
      ? set(ROUTE.HISTORICAL_REVIEW, ACTION.HUMAN_REVIEW, 'historical or check-only reply routed to review')
      : set(ROUTE.HISTORICAL_NO_ACTION, ACTION.NO_ACTION, 'historical or check-only reply: send-capable handling skipped');
  }
  switch (kind) {
    case 'QUESTION': return defer(ROUTE.QUESTION, POLICY_SOURCE.QUESTION_ANSWERER);
    case 'SEND_INFO': return defer(ROUTE.SEND_INFO, POLICY_SOURCE.REPLY_RESPONSE_POLICY);
    case 'STAFFING_QUALIFICATION': return defer(ROUTE.STAFFING_QUALIFICATION, POLICY_SOURCE.REPLY_RESPONSE_POLICY);
    case 'INTERESTED': return defer(ROUTE.INTERESTED, POLICY_SOURCE.REPLY_RESPONSE_POLICY);
    case 'MEETING_REQUEST': return defer(ROUTE.MEETING_REQUEST, POLICY_SOURCE.REPLY_RESPONSE_POLICY);
    default: return set(ROUTE.NEEDS_HUMAN, ACTION.HUMAN_REVIEW, 'meaning requires review');
  }
}

/**
 * The reply pass's interpretation step, end to end: explicit opt-out and
 * rejection first (no classifier call), otherwise the classifier, then the
 * staffing overlay for staffing leads, then the decision and its route.
 *
 * The classifier is injected (`classify` returns classifyReplyDetailed's
 * shape; `ruleCategory` is deterministicReplyCategory) so this module stays
 * free of provider IO. Returns the overlay too: handlers reuse it instead of
 * classifying the message a second time.
 */
async function interpretInboundReply({
  lead = {}, message = {}, replyText = '', ruleCanonical = {}, maySend = true,
  classify, ruleCategory, now = new Date(),
} = {}) {
  const subject = message.subject || '';
  let terminal = null;
  let classifier = null;
  if (ruleCanonical.reason === 'unsubscribe_request' || hasExplicitUnsubscribePhrase(replyText, { subject })) {
    terminal = { classification: 'UNSUBSCRIBE', source: ruleCanonical.reason === 'unsubscribe_request'
      ? CLASSIFICATION_SOURCE.RULE : CLASSIFICATION_SOURCE.FAIL_SAFE_PHRASE };
  } else if (ruleCanonical.reason === 'explicit_rejection' || hasExplicitNegativePhrase(replyText, { subject })) {
    terminal = { classification: 'NOT_INTERESTED', source: ruleCanonical.reason === 'explicit_rejection'
      ? CLASSIFICATION_SOURCE.RULE : CLASSIFICATION_SOURCE.FAIL_SAFE_PHRASE };
  } else {
    classifier = await classify();
  }
  const upstream = terminal ? terminal.classification : upper(classifier && classifier.classification);
  // Opt-out and rejection are never relabelled.
  const overlay = isStaffingCampaign(lead) && upstream !== 'UNSUBSCRIBE' && upstream !== 'NOT_INTERESTED'
    ? overlayStaffingReplyClassification({ text: replyText, lead, classification: upstream, canonical: ruleCanonical })
    : null;
  const decision = createReplyDecision({
    lead, message, ruleCanonical,
    ruleClassification: classifier
      ? classifier.ruleClassification
      : (typeof ruleCategory === 'function' ? ruleCategory(replyText, { subject, currentEmail: lead.email }) : ''),
    terminal, classifier, overlay, now,
  });
  planReplyRoute(decision, { maySend });
  return { decision, overlay };
}

function addEffect(decision, effect) {
  if (decision && effect && !decision.effects.includes(effect)) decision.effects.push(effect);
  return decision;
}

function recordExecution(decision, {
  executedAction = null, status, code = null, reason = null, fallbackAction = null, effects = [], now = new Date(),
} = {}) {
  if (!decision) return decision;
  decision.executedAction = executedAction || null;
  decision.executionStatus = status || EXECUTION_STATUS.UNREPORTED;
  decision.executionCode = code ? String(code) : null;
  decision.executionReason = text(reason);
  decision.fallbackAction = fallbackAction || null;
  for (const effect of effects) addEffect(decision, effect);
  decision.executedAt = new Date(now).toISOString();
  return decision;
}

/** Execution outcome of a route the reply switch handles directly. */
function executionForRoute(route, handlerResult) {
  if (handlerResult && handlerResult.skipped) {
    return { executedAction: null, status: EXECUTION_STATUS.SKIPPED, code: String(handlerResult.skipped) };
  }
  switch (route) {
    case ROUTE.UNSUBSCRIBE:
      return { executedAction: ACTION.SUPPRESS, status: EXECUTION_STATUS.SUPPRESSED, effects: [EFFECT.SUPPRESSION_ADDED] };
    case ROUTE.NOT_INTERESTED:
      return { executedAction: ACTION.AUTO_NEGATIVE_CLOSE, status: EXECUTION_STATUS.SUPPRESSED, effects: [EFFECT.SUPPRESSION_ADDED] };
    case ROUTE.TIMING:
      return handlerResult && handlerResult.scheduled
        ? { executedAction: ACTION.AUTO_TIMING_RECONTACT, status: EXECUTION_STATUS.RECONTACT_SCHEDULED, effects: [EFFECT.HOLD_APPLIED] }
        : { executedAction: ACTION.HUMAN_REVIEW, status: EXECUTION_STATUS.ROUTED_TO_HUMAN, effects: [EFFECT.HOLD_APPLIED] };
    case ROUTE.OUT_OF_OFFICE:
      return { executedAction: ACTION.WAIT_OUT_OF_OFFICE, status: EXECUTION_STATUS.WAITING, effects: [EFFECT.HOLD_APPLIED] };
    case ROUTE.HISTORICAL_NO_ACTION:
      return { executedAction: ACTION.NO_ACTION, status: EXECUTION_STATUS.SKIPPED, code: HISTORICAL_SKIP_CODE };
    default:
      return { executedAction: ACTION.HUMAN_REVIEW, status: EXECUTION_STATUS.ROUTED_TO_HUMAN };
  }
}

/**
 * Execution outcome of a hardened warm-reply delivery. A refused or failed
 * send keeps the policy action visible and records that it did not happen.
 */
function executionForDelivery(action, delivered = {}) {
  if (delivered && delivered.delivered) {
    const already = Boolean(delivered.alreadyCheckpointed || delivered.recovered);
    return {
      executedAction: action,
      status: already ? EXECUTION_STATUS.ALREADY_SENT : EXECUTION_STATUS.SENT,
      code: delivered.checkpointFailed ? 'checkpoint_failed' : null,
    };
  }
  const code = String((delivered && delivered.code) || 'not_delivered');
  return {
    executedAction: null,
    status: DELIVERY_FAILURE_CODES.has(code) ? EXECUTION_STATUS.FAILED : EXECUTION_STATUS.BLOCKED,
    code,
    reason: delivered && delivered.reason,
    fallbackAction: ACTION.HUMAN_REVIEW,
  };
}

function finalizeReplyDecision(decision) {
  if (!decision) return decision;
  if (decision.executionStatus === EXECUTION_STATUS.PENDING) decision.executionStatus = EXECUTION_STATUS.UNREPORTED;
  const status = decision.executionStatus;
  decision.requiresHumanAttention = decision.executedAction === ACTION.HUMAN_REVIEW
    || decision.fallbackAction === ACTION.HUMAN_REVIEW
    || [EXECUTION_STATUS.ROUTED_TO_HUMAN, EXECUTION_STATUS.BLOCKED, EXECUTION_STATUS.FAILED,
      EXECUTION_STATUS.UNREPORTED].includes(status)
    || (status === EXECUTION_STATUS.SKIPPED && decision.executionCode !== HISTORICAL_SKIP_CODE);
  return decision;
}

function replyDecisionActivity(decision, { company = '' } = {}) {
  if (!decision || !decision.decisionId) return null;
  return {
    eventId: decision.decisionId,
    leadId: `CE-${decision.leadId}`,
    sourceLeadId: decision.leadId,
    email: decision.email,
    company: String(company || ''),
    eventType: REPLY_DECISION_EVENT,
    occurredAt: decision.executedAt || decision.decidedAt,
    subject: `Reply decision: ${decision.finalClassification || 'UNKNOWN'} → ${decision.policyAction || 'none'}`,
    content: String(decision.policyReason || '').slice(0, 240),
    metadata: JSON.stringify({ ...decision, provider: 'gmail', gmailMessageId: decision.inboundMessageId }),
  };
}

function parseMetadata(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '{}')) || {}; } catch (_) { return {}; }
}

const leadKey = value => String(value || '').replace(/^CE-/, '').trim();

function parseReplyDecision(row = {}) {
  if (!row || String(row.eventType || '') !== REPLY_DECISION_EVENT) return null;
  const meta = parseMetadata(row.metadata);
  const messageId = String(meta.inboundMessageId || meta.gmailMessageId || '').trim();
  if (!messageId) return null;
  return { ...meta, inboundMessageId: messageId, leadId: leadKey(meta.leadId || row.sourceLeadId || row.leadId) };
}

/**
 * lead:message → decision. The ledger is append-only and the writer is
 * idempotent, so there is normally one per key; if a duplicate ever exists the
 * earliest wins, because it is the one production acted on.
 */
function replyDecisionsByKey(activities = []) {
  const byKey = new Map();
  const rows = [...(activities || [])]
    .filter(row => row && String(row.eventType || '') === REPLY_DECISION_EVENT)
    .sort((a, b) => String(a.occurredAt || '').localeCompare(String(b.occurredAt || '')));
  for (const row of rows) {
    const decision = parseReplyDecision(row);
    if (!decision) continue;
    const key = `${decision.leadId}:${decision.inboundMessageId}`;
    if (!byKey.has(key)) byKey.set(key, decision);
  }
  return byKey;
}

function replyDecisionFor(activities = [], messageId = '', leadId = '') {
  const id = String(messageId || '').trim();
  if (!id) return null;
  const lead = leadKey(leadId);
  for (const [key, decision] of replyDecisionsByKey(activities)) {
    if (decision.inboundMessageId !== id) continue;
    if (!lead || key === `${lead}:${id}`) return decision;
  }
  return null;
}

/**
 * Reply evidence as production decided it. A reply event whose message has a
 * decision record carries the final canonical state and category; the rule
 * classifier's state stays on the row as ruleCanonicalState. Rows without a
 * decision (every reply before this record existed) are returned unchanged.
 */
function applyReplyDecisionsToReplyEvidence(activities = []) {
  const decisions = replyDecisionsByKey(activities);
  if (!decisions.size) return activities;
  return activities.map((row) => {
    if (!row || !LEGACY_REPLY_EVENT_TYPES.includes(String(row.eventType || ''))) return row;
    const meta = parseMetadata(row.metadata);
    const messageId = String(meta.gmailMessageId || '').trim();
    const decision = messageId && decisions.get(`${leadKey(row.sourceLeadId || row.leadId)}:${messageId}`);
    if (!decision || !decision.canonicalState) return row;
    const next = {
      ...meta,
      canonicalState: decision.canonicalState,
      classification: decision.finalClassification || meta.classification || '',
      ruleCanonicalState: meta.canonicalState || null,
      canonicalStateSource: 'reply_decision',
      replyDecisionId: decision.decisionId || null,
    };
    return { ...row, metadata: typeof row.metadata === 'object' && row.metadata ? next : JSON.stringify(next) };
  });
}

// ── Operational read layer ──────────────────────────────────────────────────
//
// Analytics asks "what did production classify?" and takes the final state as
// is (applyReplyDecisionsToReplyEvidence above). Operational consumers (Inbox,
// Next Action, ownership, CRM Health) ask "what is the job now?", and there a
// decision is accepted only where it cannot make a lead LESS human-owned than
// the rule reading without production having executed the stricter outcome.
// The decision is interpretation and policy evidence. It never stands in for
// the suppression list, holds, meetings or send gates, which are checked
// separately and first.

// Canonical reasons that correspond exactly to a final category. Used only
// when the decision changed the state, so the row's reason is not left
// describing the rule classifier's reading of a different state.
const CATEGORY_REASON = Object.freeze({
  UNSUBSCRIBE: 'unsubscribe_request',
  QUESTION: NEEDS_HUMAN_REASON.QUESTION_OR_OBJECTION,
  ALREADY_HANDLED: NEEDS_HUMAN_REASON.ALREADY_HANDLED,
});

// Rule states that carry a safety fact (an opt-out, a proposed identity). A
// later interpretation never replaces them operationally.
const RULE_SAFETY_STATES = new Set([REPLY_STATE.NEGATIVE, REPLY_STATE.CONTACT_CHANGE_REVIEW]);

/**
 * Whether an operational consumer may use this decision's final state instead
 * of the rule classifier's. Returns { accepted, reason }.
 */
function operationalAcceptance(decision, ruleState) {
  if (!decision || !decision.canonicalState) return { accepted: false, reason: 'no_decision' };
  const finalState = decision.canonicalState;
  if (!ruleState || finalState === ruleState) return { accepted: true, reason: 'agrees_with_rule' };
  if (RULE_SAFETY_STATES.has(ruleState)) return { accepted: false, reason: 'rule_safety_state' };
  // Closing a conversation, or parking it behind an autoresponder, removes
  // human ownership. Accept it only when production really did it.
  if (finalState === REPLY_STATE.NEGATIVE) {
    return decision.executionStatus === EXECUTION_STATUS.SUPPRESSED
      ? { accepted: true, reason: 'suppression_executed' }
      : { accepted: false, reason: 'negative_not_executed' };
  }
  if (finalState === REPLY_STATE.AUTOMATED_REPLY) {
    return decision.executionStatus === EXECUTION_STATUS.WAITING
      ? { accepted: true, reason: 'hold_executed' }
      : { accepted: false, reason: 'automated_reply_not_executed' };
  }
  if (finalState === REPLY_STATE.POSITIVE || finalState === REPLY_STATE.NEEDS_HUMAN) {
    return { accepted: true, reason: 'human_owned_either_way' };
  }
  return { accepted: false, reason: 'unsupported_final_state' };
}

// The decision facts an operator or evaluator needs beside a reply.
function decisionSummary(decision, acceptance) {
  if (!decision) return null;
  return {
    decisionId: decision.decisionId || null,
    finalClassification: decision.finalClassification || null,
    finalClassificationSource: decision.finalClassificationSource || null,
    canonicalState: decision.canonicalState || null,
    policyAction: decision.policyAction || null,
    policySend: decision.policySend === true,
    executedAction: decision.executedAction || null,
    executionStatus: decision.executionStatus || null,
    executionCode: decision.executionCode || null,
    fallbackAction: decision.fallbackAction || null,
    requiresHumanAttention: decision.requiresHumanAttention === true,
    operationallyAccepted: Boolean(acceptance && acceptance.accepted),
    acceptanceReason: (acceptance && acceptance.reason) || null,
  };
}

/**
 * The shared read helper: production's decision for one inbound message, and
 * whether operational consumers may use its final state. `source` is
 * 'reply_decision' when a decision exists and 'legacy' otherwise (every reply
 * before decision records existed), in which case callers keep their
 * existing derivation.
 */
function effectiveReplyDecision({ activities = [], messageId = '', leadId = '', ruleState = null } = {}) {
  const decision = replyDecisionFor(activities, messageId, leadId);
  if (!decision) return { source: 'legacy', decision: null, accepted: false, summary: null };
  const acceptance = operationalAcceptance(decision, ruleState);
  return { source: 'reply_decision', decision, accepted: acceptance.accepted, summary: decisionSummary(decision, acceptance) };
}

/**
 * Reply evidence for operational consumers. Like the analytics view, but a
 * decision only replaces the rule state where operationalAcceptance allows,
 * and the decision facts ride along on the row either way. A final
 * MEETING_REQUEST carries the meeting signal so it reads as book-a-call.
 */
function operationalReplyEvidence(activities = []) {
  const decisions = replyDecisionsByKey(activities);
  if (!decisions.size) return activities;
  return activities.map((row) => {
    if (!row || !LEGACY_REPLY_EVENT_TYPES.includes(String(row.eventType || ''))) return row;
    const meta = parseMetadata(row.metadata);
    const messageId = String(meta.gmailMessageId || '').trim();
    const decision = messageId && decisions.get(`${leadKey(row.sourceLeadId || row.leadId)}:${messageId}`);
    if (!decision) return row;
    const ruleState = meta.canonicalState || null;
    const acceptance = operationalAcceptance(decision, ruleState);
    const next = { ...meta, replyDecision: decisionSummary(decision, acceptance) };
    if (acceptance.accepted) {
      const changed = decision.canonicalState !== ruleState;
      next.canonicalState = decision.canonicalState;
      next.ruleCanonicalState = ruleState;
      next.canonicalStateSource = 'reply_decision';
      next.classification = decision.finalClassification || meta.classification || '';
      if (changed) next.reason = CATEGORY_REASON[decision.finalClassification] || null;
      if (decision.finalClassification === 'MEETING_REQUEST') {
        const signals = Array.isArray(meta.evidenceSignals) ? meta.evidenceSignals : [];
        next.evidenceSignals = signals.includes('meeting') ? signals : [...signals, 'meeting'];
      }
    }
    return { ...row, metadata: typeof row.metadata === 'object' && row.metadata ? next : JSON.stringify(next) };
  });
}

/** What the shadow agent compares against: production's recorded decision. */
function productionFactsFromDecision(decision) {
  if (!decision) return null;
  return {
    source: 'reply_decision',
    decisionId: decision.decisionId || null,
    classification: decision.finalClassification || '',
    classificationSource: decision.finalClassificationSource || null,
    canonicalState: decision.canonicalState || null,
    policyAction: decision.policyAction || '',
    executedAction: decision.executedAction || '',
    executionStatus: decision.executionStatus || '',
  };
}

module.exports = {
  REPLY_DECISION_EVENT, REPLY_DECISION_VERSION, CLASSIFICATION_SOURCE, POLICY_SOURCE, ROUTE,
  EXECUTION_STATUS, EFFECT, CATEGORY_STATE, POSITIVE_AUTOSEND_FLOOR,
  createReplyDecision, interpretInboundReply, planReplyRoute, recordPolicy, recordExecution, addEffect,
  executionForRoute, executionForDelivery, finalizeReplyDecision, finalCanonicalState,
  replyDecisionEventId, replyDecisionActivity, parseReplyDecision, replyDecisionsByKey,
  replyDecisionFor, applyReplyDecisionsToReplyEvidence, productionFactsFromDecision,
  operationalAcceptance, effectiveReplyDecision, operationalReplyEvidence,
};
