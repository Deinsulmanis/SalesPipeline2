'use strict';

const ACTION = Object.freeze({
  AUTO_BOOKING_RESPONSE: 'AUTO_BOOKING_RESPONSE', AUTO_MEETING_RESPONSE: 'AUTO_MEETING_RESPONSE',
  AUTO_QUESTION_RESPONSE: 'AUTO_QUESTION_RESPONSE', AUTO_PRICING_RESPONSE: 'AUTO_PRICING_RESPONSE',
  AUTO_TIMING_RECONTACT: 'AUTO_TIMING_RECONTACT', AUTO_NEGATIVE_CLOSE: 'AUTO_NEGATIVE_CLOSE',
  SUPPRESS: 'SUPPRESS', WAIT_OUT_OF_OFFICE: 'WAIT_OUT_OF_OFFICE', HUMAN_REVIEW: 'HUMAN_REVIEW', NO_ACTION: 'NO_ACTION',
});

function decideReplyResponse({ classification, canonical = {}, confidence = 0, offer = {}, text = '' }) {
  const kind = String(classification || '').toUpperCase();
  if (kind === 'UNSUBSCRIBE') return { action: ACTION.SUPPRESS, send: false, reason: 'explicit opt-out' };
  if (kind === 'NOT_INTERESTED') return { action: ACTION.AUTO_NEGATIVE_CLOSE, send: false, reason: 'explicit negative' };
  if (canonical.revisitDate || canonical.returnDate) {
    return { action: ACTION.AUTO_TIMING_RECONTACT, send: false, reason: 'explicit future date',
      dueAt: canonical.revisitDate || canonical.returnDate };
  }
  if (kind === 'OUT_OF_OFFICE') return { action: ACTION.WAIT_OUT_OF_OFFICE, send: false, reason: 'automated reply' };
  if (kind === 'WRONG_PERSON' || kind === 'NEEDS_HUMAN') return { action: ACTION.HUMAN_REVIEW, send: false, reason: 'identity or meaning requires review' };
  if (kind === 'MEETING_REQUEST') return { action: ACTION.AUTO_MEETING_RESPONSE, send: true, reason: 'explicit scheduling intent' };
  if (kind === 'INTERESTED') return { action: ACTION.AUTO_BOOKING_RESPONSE, send: true, reason: 'high-confidence positive intent' };
  if (kind === 'QUESTION') {
    const pricing = /\b(pric|cost|fee|charge|how much|\$|rate|monthly|per month)\b/i.test(text);
    if (pricing) return offer.pricing?.approvedWording
      ? { action: ACTION.AUTO_PRICING_RESPONSE, send: true, reason: 'approved campaign pricing configured' }
      : { action: ACTION.HUMAN_REVIEW, send: false, reason: 'pricing is not configured for this campaign' };
    return Number(confidence) >= 85
      ? { action: ACTION.AUTO_QUESTION_RESPONSE, send: true, reason: 'grounded answer above confidence threshold' }
      : { action: ACTION.HUMAN_REVIEW, send: false, reason: 'answer confidence below threshold' };
  }
  return { action: ACTION.HUMAN_REVIEW, send: false, reason: 'unsupported classification' };
}

module.exports = { ACTION, decideReplyResponse };
