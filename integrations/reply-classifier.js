'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { stripText } = require('./smartlead-safety');
const { classifyReplyText, REPLY_STATE, NEEDS_HUMAN_REASON } = require('./canonical-reply');

const REPLY_CATEGORIES = new Set(['QUESTION','INTERESTED','MEETING_REQUEST','NOT_INTERESTED','UNSUBSCRIBE','OUT_OF_OFFICE','WRONG_PERSON','NEEDS_HUMAN']);
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
    && signals.length && signals.every(signal => INFORMATIONAL.includes(signal))
    && /\?/.test(value)) return 'QUESTION';
  return CANONICAL_TO_LEGACY[resolved.state] || 'NEEDS_HUMAN';
}

async function classifyReply({ provider = 'gmail', lead = {}, campaign = {}, subject = '', plainTextReply = '', conversationContext = '', apiKey = process.env.ANTHROPIC_API_KEY, createMessage } = {}) {
  const reply = stripText(plainTextReply, 5000);
  const deterministic = deterministicReplyCategory(reply);
  if (deterministic) return deterministic;
  if (!apiKey && !createMessage) return CLASSIFY_FALLBACK;
  try {
    const send = createMessage || (payload => new Anthropic({ apiKey }).messages.create(payload));
    const msg = await send({
      model: 'claude-haiku-4-5', max_tokens: 20,
      system: 'Classify a cold-outreach reply as exactly one of: QUESTION, INTERESTED, MEETING_REQUEST, NOT_INTERESTED, UNSUBSCRIBE, OUT_OF_OFFICE, WRONG_PERSON, NEEDS_HUMAN. Prefer NEEDS_HUMAN when unclear. Never infer interest merely because a reply exists.',
      messages: [{ role: 'user', content: `Provider: ${provider}\nCompany: ${lead.company || ''}\nCampaign: ${campaign.name || ''}\nSubject: ${subject}\nReply: ${reply}\nContext: ${stripText(conversationContext, 3000)}` }],
    });
    const raw = String(msg.content?.[0]?.text || '').trim().toUpperCase();
    return REPLY_CATEGORIES.has(raw) ? raw : CLASSIFY_FALLBACK;
  } catch (_) { return CLASSIFY_FALLBACK; }
}

const CLASSIFICATION_TO_STATUS = { QUESTION: 'Question', INTERESTED: 'Interested', MEETING_REQUEST: 'Meeting requested', NOT_INTERESTED: 'Not interested', UNSUBSCRIBE: 'Unsubscribed', OUT_OF_OFFICE: 'Out of office', WRONG_PERSON: 'Replied', NEEDS_HUMAN: 'Replied' };

module.exports = { classifyReply, deterministicReplyCategory, CLASSIFICATION_TO_STATUS, REPLY_CATEGORIES, CLASSIFY_FALLBACK };
