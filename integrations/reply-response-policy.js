'use strict';

const ACTION = Object.freeze({
  AUTO_BOOKING_RESPONSE: 'AUTO_BOOKING_RESPONSE', AUTO_MEETING_RESPONSE: 'AUTO_MEETING_RESPONSE',
  AUTO_QUESTION_RESPONSE: 'AUTO_QUESTION_RESPONSE', AUTO_PRICING_RESPONSE: 'AUTO_PRICING_RESPONSE',
  AUTO_STAFFING_QUALIFY_QUESTION: 'AUTO_STAFFING_QUALIFY_QUESTION',
  AUTO_STAFFING_SEND_INFO: 'AUTO_STAFFING_SEND_INFO',
  AUTO_STAFFING_QUALIFIED: 'AUTO_STAFFING_QUALIFIED',
  AUTO_TIMING_RECONTACT: 'AUTO_TIMING_RECONTACT', AUTO_NEGATIVE_CLOSE: 'AUTO_NEGATIVE_CLOSE',
  SUPPRESS: 'SUPPRESS', WAIT_OUT_OF_OFFICE: 'WAIT_OUT_OF_OFFICE', HUMAN_REVIEW: 'HUMAN_REVIEW', NO_ACTION: 'NO_ACTION',
});

const STAFFING_OFFER_ID = 'industrial_staffing_employer_acquisition_v1';

function isStaffingReplyContext({ family = '', offer = {} } = {}) {
  return family === 'industrial_staffing' || offer.id === STAFFING_OFFER_ID;
}

// Stamped on every reply decision. Bump it when a rule below changes, so an
// evaluator can tell which policy produced a recorded action.
const POLICY_VERSION = 'reply_response_policy_v1';

const POSITIVE_AUTOSEND_FLOOR = 85;
const QUESTION_AUTOSEND_FLOOR = 85;

const CONFIDENCE_SCORE = Object.freeze({
  high: 90, medium: 70, low: 40, none: 0,
});

function numericConfidence({ classification = '', canonical = {}, confidence } = {}) {
  if (Number.isFinite(Number(confidence)) && Number(confidence) > 0) return Number(confidence);
  const signals = canonical.signals || [];
  if (String(classification).toUpperCase() === 'MEETING_REQUEST' && signals.includes('meeting')) return 95;
  if (canonical.confidence === 'high' && canonical.state === 'positive'
    && (signals.includes('expressed_interest') || signals.includes('willing_to_evaluate')
      || signals.includes('next_steps') || signals.includes('meeting'))) return 90;
  return CONFIDENCE_SCORE[canonical.confidence] || 0;
}

function decideReplyResponse({
  classification, canonical = {}, confidence = 0, offer = {}, text = '', family = '',
  qualificationFit = '',
} = {}) {
  const kind = String(classification || '').toUpperCase();
  const score = numericConfidence({ classification, canonical, confidence });
  if (kind === 'UNSUBSCRIBE') return { action: ACTION.SUPPRESS, send: false, reason: 'explicit opt-out', confidence: score };
  if (kind === 'NOT_INTERESTED') return { action: ACTION.AUTO_NEGATIVE_CLOSE, send: false, reason: 'explicit negative', confidence: score };
  if (kind === 'ALREADY_HANDLED') {
    return { action: ACTION.HUMAN_REVIEW, send: false, reason: 'existing provider or internal team requires review', confidence: score };
  }
  if (canonical.revisitDate || canonical.returnDate) {
    return { action: ACTION.AUTO_TIMING_RECONTACT, send: false, reason: 'explicit future date',
      dueAt: canonical.revisitDate || canonical.returnDate, confidence: score };
  }
  if (kind === 'OUT_OF_OFFICE') return { action: ACTION.WAIT_OUT_OF_OFFICE, send: false, reason: 'automated reply', confidence: score };
  if (kind === 'WRONG_PERSON' || kind === 'NEEDS_HUMAN') {
    return { action: ACTION.HUMAN_REVIEW, send: false, reason: 'identity or meaning requires review', confidence: score };
  }
  if (kind === 'MEETING_REQUEST') {
    if (score >= POSITIVE_AUTOSEND_FLOOR) {
      return { action: ACTION.AUTO_MEETING_RESPONSE, send: true, reason: 'explicit scheduling intent above confidence floor', confidence: score };
    }
    return { action: ACTION.HUMAN_REVIEW, send: false, reason: 'meeting request confidence below auto-send floor', confidence: score };
  }
  if (kind === 'SEND_INFO') {
    if (isStaffingReplyContext({ family, offer }) && score >= POSITIVE_AUTOSEND_FLOOR) {
      return { action: ACTION.AUTO_STAFFING_SEND_INFO, send: true, reason: 'staffing information request sends landing page', confidence: score };
    }
    return { action: ACTION.HUMAN_REVIEW, send: false, reason: 'send-info is not auto-sent outside staffing', confidence: score };
  }
  if (kind === 'STAFFING_QUALIFICATION') {
    if (!isStaffingReplyContext({ family, offer })) {
      return { action: ACTION.HUMAN_REVIEW, send: false, reason: 'staffing qualification is staffing-only', confidence: score };
    }
    if (qualificationFit === 'clear' && score >= POSITIVE_AUTOSEND_FLOOR) {
      return { action: ACTION.AUTO_STAFFING_QUALIFIED, send: true, reason: 'staffing qualification fits the employer-acquisition offer', confidence: score };
    }
    return {
      action: ACTION.HUMAN_REVIEW, send: false, confidence: score,
      reason: qualificationFit === 'unclear'
        ? 'staffing qualification answer is unclear'
        : 'unrelated reply while staffing qualification is pending',
    };
  }
  if (kind === 'INTERESTED') {
    if (score >= POSITIVE_AUTOSEND_FLOOR) {
      if (isStaffingReplyContext({ family, offer })) {
        return { action: ACTION.AUTO_STAFFING_QUALIFY_QUESTION, send: true, reason: 'staffing interest asks qualification before booking', confidence: score };
      }
      return { action: ACTION.AUTO_BOOKING_RESPONSE, send: true, reason: 'high-confidence positive intent', confidence: score };
    }
    return { action: ACTION.HUMAN_REVIEW, send: false, reason: 'positive classification below auto-send confidence floor', confidence: score };
  }
  if (kind === 'QUESTION') {
    const pricing = /\b(pric|cost|fee|charge|how much|\$|rate|monthly|per month)\b/i.test(text);
    if (pricing) return offer.pricing?.approvedWording
      ? { action: ACTION.AUTO_PRICING_RESPONSE, send: true, reason: 'approved campaign pricing configured', confidence: score }
      : { action: ACTION.HUMAN_REVIEW, send: false, reason: 'pricing is not configured for this campaign', confidence: 0 };
    return score >= QUESTION_AUTOSEND_FLOOR
      ? { action: ACTION.AUTO_QUESTION_RESPONSE, send: true, reason: 'grounded answer above confidence threshold', confidence: score }
      : { action: ACTION.HUMAN_REVIEW, send: false, reason: 'answer confidence below threshold', confidence: score };
  }
  return { action: ACTION.HUMAN_REVIEW, send: false, reason: 'unsupported classification', confidence: score, family };
}

module.exports = {
  ACTION, decideReplyResponse, numericConfidence, isStaffingReplyContext,
  POSITIVE_AUTOSEND_FLOOR, QUESTION_AUTOSEND_FLOOR, POLICY_VERSION,
};
