'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { wrapCreateMessage, FEATURES, TOKEN_BUDGET_EXCEEDED } = require('./anthropic-usage');
const { stripText } = require('./smartlead-safety');
const { classifyReplyText, REPLY_STATE, NEEDS_HUMAN_REASON,
  hasExplicitUnsubscribePhrase, hasExplicitNegativePhrase } = require('./canonical-reply');
// Which component produced the category; recorded on the reply decision.
const { CLASSIFICATION_SOURCE } = require('./reply-decision');

const REPLY_CATEGORIES = new Set(['QUESTION','INTERESTED','MEETING_REQUEST','NOT_INTERESTED','UNSUBSCRIBE','OUT_OF_OFFICE','WRONG_PERSON','NEEDS_HUMAN','ALREADY_HANDLED','SEND_INFO']);
const CLASSIFY_FALLBACK = 'NEEDS_HUMAN';

// Canonical state -> the legacy category vocabulary the send path and the
// [REPLY: ...] tags already speak. One classifier, two vocabularies.
const CANONICAL_TO_LEGACY = {
  [REPLY_STATE.POSITIVE]: 'INTERESTED',
  [REPLY_STATE.NEGATIVE]: 'NOT_INTERESTED',
  [REPLY_STATE.AUTOMATED_REPLY]: 'OUT_OF_OFFICE',
  [REPLY_STATE.CONTACT_CHANGE_REVIEW]: 'WRONG_PERSON',
  [REPLY_STATE.NEEDS_HUMAN]: 'NEEDS_HUMAN',
};

/**
 * Deterministic first pass, delegated to the canonical classifier so tagging
 * and analytics can never drift apart.
 *
 * The previous implementation tested for "not interested" BEFORE it looked for
 * any buying signal, so a prospect who criticised AI at length and then asked
 * for pricing and a trial was tagged Not Interested and dropped. Ordering is
 * now: machine before human, opt-out before intent, intent before sentiment.
 */
function deterministicReplyCategory(text, options = {}) {
  const value = stripText(text, 5000);
  if (!value) return '';
  const resolved = classifyReplyText(value, options);
  if (resolved.state === REPLY_STATE.UNKNOWN) return '';
  // "Unclear intent" is the canonical way of saying we did not recognise
  // anything. Returning a category here would be a deterministic guess, so we
  // decline and let the model (or the NEEDS_HUMAN fallback) decide.
  if (resolved.confidence === 'low') return '';
  // An unsubscribe keeps its own category: it drives suppression, which is a
  // stronger action than an ordinary negative.
  if (resolved.reason === 'unsubscribe_request') return 'UNSUBSCRIBE';
  if (resolved.state === REPLY_STATE.NEEDS_HUMAN
    && resolved.reason === NEEDS_HUMAN_REASON.ALREADY_HANDLED) return 'ALREADY_HANDLED';
  if (resolved.state === REPLY_STATE.NEEDS_HUMAN
    && (resolved.reason === NEEDS_HUMAN_REASON.FORWARDED_TO_DECISION_MAKER
      || resolved.reason === NEEDS_HUMAN_REASON.DECISION_MAKER_CONTACT_SUPPLIED)) {
    return 'WRONG_PERSON';
  }
  if (resolved.state === REPLY_STATE.NEEDS_HUMAN
    && resolved.reason === NEEDS_HUMAN_REASON.DEFERRED_TIMING) return 'NEEDS_HUMAN';
  if (resolved.state === REPLY_STATE.NEEDS_HUMAN
    && resolved.reason === NEEDS_HUMAN_REASON.QUESTION_OR_OBJECTION) return 'QUESTION';
  // A request to meet is a stronger, separately-actioned signal than general
  // interest, so it keeps its own legacy category.
  if (resolved.state === REPLY_STATE.POSITIVE
    && (resolved.signals || []).includes('meeting')) return 'MEETING_REQUEST';
  // A purely informational question ("what does it cost?", "how does it work?")
  // is evaluation intent CANONICALLY — analytics counts it as positive, which
  // is the point of this pass. But the legacy INTERESTED category also triggers
  // automatic promotion into the sales pipeline, and a question is not yet an
  // opportunity. So the action path keeps routing these to a human via QUESTION
  // while the analytics path records the intent. Anything stronger — a trial
  // request, a meeting, an explicit statement of interest — still promotes.
  const INFORMATIONAL = ['pricing', 'how_it_works', 'send_info'];
  const signals = resolved.signals || [];
  if (resolved.state === REPLY_STATE.POSITIVE
    && signals.length && signals.every(signal => INFORMATIONAL.includes(signal))) return 'QUESTION';
  return CANONICAL_TO_LEGACY[resolved.state] || 'NEEDS_HUMAN';
}

function failSafeReplyCategory(text, options = {}) {
  if (hasExplicitUnsubscribePhrase(text, options)) return 'UNSUBSCRIBE';
  if (hasExplicitNegativePhrase(text, options)) return 'NOT_INTERESTED';
  return '';
}

const REPLY_CLASSIFIER_MODEL = 'claude-haiku-4-5';

/**
 * classifyReply, plus the provenance of its answer. The category returned is
 * exactly what classifyReply returns; nothing here changes which one wins.
 */
async function classifyReplyDetailed({ provider = 'gmail', lead = {}, campaign = {}, subject = '', plainTextReply = '', conversationContext = '', apiKey = process.env.ANTHROPIC_API_KEY, createMessage, messageId = '', threadId = '', alreadyEvaluated = false, priorClassification = '' } = {}) {
  const reply = stripText(plainTextReply, 5000);
  const options = { subject, currentEmail: lead.email };
  const deterministic = deterministicReplyCategory(reply, options);
  const detail = (classification, source, model = {}) => ({
    classification, source, ruleClassification: deterministic || '',
    modelClassification: model.classification || '', modelStatus: model.status || 'not_called',
    model: model.status && model.status !== 'no_api_key' ? REPLY_CLASSIFIER_MODEL : '',
  });
  if (deterministic) return detail(deterministic, CLASSIFICATION_SOURCE.RULE);
  // Even if the canonical pass declined (low confidence / empty body edge), an
  // explicit opt-out or rejection must never wait on a model call.
  const failSafe = failSafeReplyCategory(reply, options);
  if (failSafe) return detail(failSafe, CLASSIFICATION_SOURCE.FAIL_SAFE_PHRASE);
  if (alreadyEvaluated) {
    return priorClassification
      ? detail(priorClassification, CLASSIFICATION_SOURCE.PRIOR_EVALUATION)
      : detail(CLASSIFY_FALLBACK, CLASSIFICATION_SOURCE.MODEL_FALLBACK);
  }
  if (!apiKey && !createMessage) {
    return detail(failSafeReplyCategory(reply, options) || CLASSIFY_FALLBACK,
      CLASSIFICATION_SOURCE.MODEL_FALLBACK, { status: 'no_api_key' });
  }
  try {
    const send = wrapCreateMessage(
      createMessage || (payload => new Anthropic({ apiKey, maxRetries: 0 }).messages.create(payload)),
      {
        feature: FEATURES.reply_classification,
        operation: 'classify',
        campaign: campaign.name || campaign.id || '',
        leadId: lead.id || lead.email || '',
        messageId,
        threadId,
      },
    );
    const msg = await send({
      model: REPLY_CLASSIFIER_MODEL, max_tokens: 20,
      system: 'Classify a cold-outreach reply as exactly one of: QUESTION, INTERESTED, MEETING_REQUEST, NOT_INTERESTED, UNSUBSCRIBE, OUT_OF_OFFICE, WRONG_PERSON, NEEDS_HUMAN. Prefer NEEDS_HUMAN when unclear. Never infer interest merely because a reply exists.',
      messages: [{ role: 'user', content: `Provider: ${provider}\nCompany: ${lead.company || ''}\nCampaign: ${campaign.name || ''}\nSubject: ${subject}\nReply: ${reply}\nContext: ${stripText(conversationContext, 3000)}` }],
    });
    const raw = String(msg.content?.[0]?.text || '').trim().toUpperCase();
    if (REPLY_CATEGORIES.has(raw)) return detail(raw, CLASSIFICATION_SOURCE.MODEL, { classification: raw, status: 'ok' });
    return detail(failSafeReplyCategory(reply, options) || CLASSIFY_FALLBACK,
      CLASSIFICATION_SOURCE.MODEL_FALLBACK, { status: 'invalid_output' });
  } catch (error) {
    if (error && error.code === TOKEN_BUDGET_EXCEEDED) {
      return detail(failSafeReplyCategory(reply, options) || CLASSIFY_FALLBACK,
        CLASSIFICATION_SOURCE.MODEL_FALLBACK, { status: 'budget_exceeded' });
    }
    return detail(failSafeReplyCategory(reply, options) || CLASSIFY_FALLBACK,
      CLASSIFICATION_SOURCE.MODEL_FALLBACK, { status: 'error' });
  }
}

async function classifyReply(input = {}) {
  return (await classifyReplyDetailed(input)).classification;
}

const CLASSIFICATION_TO_STATUS = { QUESTION: 'Question', INTERESTED: 'Interested', MEETING_REQUEST: 'Meeting requested', NOT_INTERESTED: 'Not interested', UNSUBSCRIBE: 'Unsubscribed', OUT_OF_OFFICE: 'Out of office', WRONG_PERSON: 'Replied', NEEDS_HUMAN: 'Replied', ALREADY_HANDLED: 'Replied', SEND_INFO: 'Replied' };

module.exports = {
  classifyReply, classifyReplyDetailed, deterministicReplyCategory, failSafeReplyCategory,
  CLASSIFICATION_TO_STATUS, REPLY_CATEGORIES, CLASSIFY_FALLBACK, CLASSIFICATION_SOURCE, REPLY_CLASSIFIER_MODEL,
};
