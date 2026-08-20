'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { stripText } = require('./smartlead-safety');

const REPLY_CATEGORIES = new Set(['QUESTION','INTERESTED','MEETING_REQUEST','NOT_INTERESTED','UNSUBSCRIBE','OUT_OF_OFFICE','WRONG_PERSON','NEEDS_HUMAN']);
const CLASSIFY_FALLBACK = 'NEEDS_HUMAN';

function deterministicReplyCategory(text) {
  const value = stripText(text, 5000).toLowerCase();
  if (/\b(unsubscribe|remove me|stop email|do not contact|don'?t contact)\b/.test(value)) return 'UNSUBSCRIBE';
  if (/\b(out of (the )?office|on vacation|automatic reply|away until)\b/.test(value)) return 'OUT_OF_OFFICE';
  if (/\b(not interested|no thanks|not a fit|pass on this)\b/.test(value)) return 'NOT_INTERESTED';
  if (/\b(book|schedule|calendar|meeting|call)\b/.test(value) && /\b(yes|sure|let'?s|available|works|interested)\b/.test(value)) return 'MEETING_REQUEST';
  if (/\?/.test(value)) return 'QUESTION';
  if (/\b(interested|tell me more|sounds good|yes please)\b/.test(value)) return 'INTERESTED';
  return '';
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
