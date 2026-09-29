'use strict';

/**
 * Client-aware reply policy.
 *
 * Every reply resolves   sender → client → campaign → lead → policy
 * and the chain must agree (resolveReplyClientContext). A reply whose inbox
 * belongs to one client and whose lead belongs to another is never applied.
 *
 * Two policy modes:
 *
 *   legacy   the default client. The existing reply pipeline runs unchanged;
 *            this module returns { mode: 'legacy' } and interprets nothing.
 *   managed  a managed client. The canonical classifier (the same prospect's-
 *            own-words classification ScaleLab uses) is mapped onto the
 *            client's workflow states. ScaleLab keeps the conversation through
 *            qualification and booking; a question only the client can answer
 *            becomes a clarification, never an improvised answer.
 *
 * Classification input must already be the prospect's own words
 * (ownReplyText / stripQuotedReply). This module does not strip quotes.
 */

const { classifyReplyText, REPLY_STATE, NEEDS_HUMAN_REASON } = require('../canonical-reply');
const { getClient } = require('./registry');
const { checkClientConsistency } = require('./ownership');

const WORKFLOW_STATE = Object.freeze({
  POSITIVE_INTEREST: 'positive_interest',
  ASKS_FOR_INFORMATION: 'asks_for_information',
  FUTURE_WORKFORCE_NEED: 'future_workforce_need',
  REFERRAL_TO_DECISION_MAKER: 'referral_to_decision_maker',
  QUALIFICATION_IN_PROGRESS: 'qualification_in_progress',
  AWAITING_CLIENT_CLARIFICATION: 'awaiting_client_clarification',
  MEETING_BOOKING: 'meeting_booking',
  NOT_INTERESTED: 'not_interested',
  UNSUBSCRIBE: 'unsubscribe',
  WRONG_CONTACT: 'wrong_contact',
  OUTSIDE_ICP: 'outside_icp',
  AUTOMATED: 'automated',
  NEEDS_REVIEW: 'needs_review',
});

// Opportunity conversation status each workflow state moves to. Automated
// replies change nothing.
const CONVERSATION_STATUS_FOR = Object.freeze({
  [WORKFLOW_STATE.POSITIVE_INTEREST]: 'qualification_in_progress',
  [WORKFLOW_STATE.ASKS_FOR_INFORMATION]: 'qualification_in_progress',
  [WORKFLOW_STATE.QUALIFICATION_IN_PROGRESS]: 'qualification_in_progress',
  [WORKFLOW_STATE.AWAITING_CLIENT_CLARIFICATION]: 'awaiting_client_clarification',
  [WORKFLOW_STATE.MEETING_BOOKING]: 'meeting_booking',
  [WORKFLOW_STATE.FUTURE_WORKFORCE_NEED]: 'future_need',
  [WORKFLOW_STATE.REFERRAL_TO_DECISION_MAKER]: 'referral_pending',
  [WORKFLOW_STATE.NOT_INTERESTED]: 'closed_not_interested',
  [WORKFLOW_STATE.UNSUBSCRIBE]: 'closed_unsubscribed',
  [WORKFLOW_STATE.WRONG_CONTACT]: 'wrong_contact',
  [WORKFLOW_STATE.OUTSIDE_ICP]: 'closed_outside_icp',
  [WORKFLOW_STATE.NEEDS_REVIEW]: 'needs_review',
});

const POSITIVE_STATES = new Set([
  WORKFLOW_STATE.POSITIVE_INTEREST, WORKFLOW_STATE.ASKS_FOR_INFORMATION,
  WORKFLOW_STATE.AWAITING_CLIENT_CLARIFICATION, WORKFLOW_STATE.MEETING_BOOKING,
  WORKFLOW_STATE.FUTURE_WORKFORCE_NEED, WORKFLOW_STATE.REFERRAL_TO_DECISION_MAKER,
]);
const NEGATIVE_STATES = new Set([
  WORKFLOW_STATE.NOT_INTERESTED, WORKFLOW_STATE.UNSUBSCRIBE, WORKFLOW_STATE.OUTSIDE_ICP,
]);

/** positive | neutral | negative | unsubscribe | automated — for reporting. */
function sentimentFor(workflowState) {
  if (workflowState === WORKFLOW_STATE.UNSUBSCRIBE) return 'unsubscribe';
  if (workflowState === WORKFLOW_STATE.AUTOMATED) return 'automated';
  if (NEGATIVE_STATES.has(workflowState)) return 'negative';
  if (POSITIVE_STATES.has(workflowState)) return 'positive';
  return 'neutral';
}

function questionSentences(text) {
  return String(text || '').split(/(?<=[?.!])\s+|\n+/).map(part => part.trim()).filter(Boolean)
    .filter(part => part.includes('?') || /^(what|how|do|does|can|could|are|is|which|who|when|where|will|would)\b/i.test(part));
}

function clarificationFor(policy, text) {
  const topics = (policy.clarificationTopics || []).filter(topic => topic.pattern.test(text)).map(topic => topic.id);
  if (!topics.length) return null;
  const questions = questionSentences(text);
  return {
    topics,
    // The exact words the operator must get answered, capped for storage.
    question: (questions.length ? questions.join(' ') : String(text || '').trim()).slice(0, 2000),
  };
}

/**
 * Classify a reply for a client. Legacy clients get { mode: 'legacy' } and are
 * handled by the existing pipeline.
 */
function classifyClientReply({ clientId, campaignId = '', text = '', subject = '', currentEmail = '', now = null } = {}) {
  const client = getClient(clientId);
  const policy = client.replyPolicy;
  if (policy.mode === 'legacy') return { mode: 'legacy', clientId: client.id };
  const canonical = classifyReplyText(text, { subject, currentEmail, now });
  const signals = canonical.signals || [];
  const result = (workflowState, extra = {}) => {
    const suppressionScope = workflowState === WORKFLOW_STATE.UNSUBSCRIBE ? 'global'
      : (workflowState === WORKFLOW_STATE.NOT_INTERESTED || workflowState === WORKFLOW_STATE.OUTSIDE_ICP)
        ? policy.negativeReplySuppressionScope : null;
    return {
      mode: 'managed', clientId: client.id, campaignId, workflowState,
      conversationStatus: CONVERSATION_STATUS_FOR[workflowState] || null,
      sentiment: sentimentFor(workflowState),
      suppressionScope,
      // A person replied: cold automation stops for every state but automated.
      stopsColdSequence: workflowState !== WORKFLOW_STATE.AUTOMATED,
      canonical: { state: canonical.state, reason: canonical.reason || null, signals, confidence: canonical.confidence || null },
      ...extra,
    };
  };

  // Machine before human, opt-out before intent, intent before sentiment —
  // the same ordering the canonical classifier uses.
  if (canonical.reason === 'unsubscribe_request') return result(WORKFLOW_STATE.UNSUBSCRIBE);
  if (canonical.state === REPLY_STATE.AUTOMATED_REPLY) return result(WORKFLOW_STATE.AUTOMATED);
  if ((policy.outsideIcpPatterns || []).some(pattern => pattern.test(text))) return result(WORKFLOW_STATE.OUTSIDE_ICP);
  if (canonical.state === REPLY_STATE.NEGATIVE) return result(WORKFLOW_STATE.NOT_INTERESTED);
  if (canonical.state === REPLY_STATE.CONTACT_CHANGE_REVIEW) return result(WORKFLOW_STATE.WRONG_CONTACT);
  if (canonical.state === REPLY_STATE.NEEDS_HUMAN) {
    if (canonical.reason === NEEDS_HUMAN_REASON.DECISION_MAKER_CONTACT_SUPPLIED || signals.includes('named_referral')) {
      return result(WORKFLOW_STATE.REFERRAL_TO_DECISION_MAKER, { suppliedContact: canonical.suppliedContact || null });
    }
    if (canonical.reason === NEEDS_HUMAN_REASON.FORWARDED_TO_DECISION_MAKER) return result(WORKFLOW_STATE.WRONG_CONTACT);
  }
  if (canonical.reason === NEEDS_HUMAN_REASON.DEFERRED_TIMING
    || (canonical.state !== REPLY_STATE.POSITIVE && (policy.futureNeedPatterns || []).some(pattern => pattern.test(text)))) {
    return result(WORKFLOW_STATE.FUTURE_WORKFORCE_NEED);
  }
  if (canonical.state === REPLY_STATE.POSITIVE && signals.includes('meeting')) return result(WORKFLOW_STATE.MEETING_BOOKING);
  const clarification = clarificationFor(policy, text);
  if (clarification && (canonical.state === REPLY_STATE.POSITIVE
    || canonical.reason === NEEDS_HUMAN_REASON.QUESTION_OR_OBJECTION || questionSentences(text).length)) {
    return result(WORKFLOW_STATE.AWAITING_CLIENT_CLARIFICATION, { clarification });
  }
  if (canonical.state === REPLY_STATE.POSITIVE) {
    const INFORMATIONAL = ['pricing', 'how_it_works', 'send_info'];
    if (signals.length && signals.every(signal => INFORMATIONAL.includes(signal))) return result(WORKFLOW_STATE.ASKS_FOR_INFORMATION);
    return result(WORKFLOW_STATE.POSITIVE_INTEREST);
  }
  if (canonical.reason === NEEDS_HUMAN_REASON.QUESTION_OR_OBJECTION) return result(WORKFLOW_STATE.ASKS_FOR_INFORMATION);
  return result(WORKFLOW_STATE.NEEDS_REVIEW);
}

/**
 * sender → client → campaign → lead. All must agree, or the reply is not
 * applied to that lead. Returns { ok, clientId, campaignId, policyMode } or a
 * refusal carrying the mismatch.
 */
function resolveReplyClientContext({ senderInboxId, lead, senders } = {}) {
  if (!lead) return { ok: false, code: 'reply_lead_missing', reason: 'reply has no lead' };
  if (!String(senderInboxId || '').trim()) return { ok: false, code: 'reply_sender_missing', reason: 'reply has no receiving inbox' };
  const verdict = checkClientConsistency({ lead, senderInboxId, senders });
  if (!verdict.ok) return { ok: false, code: verdict.code, reason: `reply isolation: ${verdict.reason}`, parts: verdict.parts };
  const client = getClient(verdict.clientId);
  return {
    ok: true, clientId: client.id, campaignId: String(lead.intendedCampaignVersion || lead.campaign || '').trim(),
    policyMode: client.replyPolicy.mode,
  };
}

module.exports = {
  WORKFLOW_STATE, CONVERSATION_STATUS_FOR, sentimentFor,
  classifyClientReply, resolveReplyClientContext, clarificationFor,
};
