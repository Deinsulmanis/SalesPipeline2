'use strict';

const {
  SCHEMA_VERSION, ACTION_IDS, HANDOFF_CODES, SLOT_IDS, OBJECTION_TYPES,
  TEMPLATE_IDS, REASON_CODES, FACT_IDS, OFFER_FACTS, OUTPUT_FIELDS,
} = require('./agent-v2-contract');

const ACTION_TEMPLATE = Object.freeze({
  NO_ACTION: 'NONE', HANDOFF: 'NONE', SUGGEST_QUALIFICATION: 'QUALIFY',
  SUGGEST_INFO: 'INFO_OVERVIEW', SUGGEST_FACT_ANSWER: 'FACTS_ONLY',
  SUGGEST_OBJECTION_RESPONSE: 'OBJECTION_ACK',
  SUGGEST_REFERRAL_ACK: 'REFERRAL_ACK',
  SUGGEST_BOOKING_COORDINATION: 'BOOKING_COORDINATION',
});
const PRICING_FACTS = new Set([
  'F_PERFORMANCE_BASED', 'F_PAYMENT_TIED_MEETINGS', 'F_NO_MEETINGS_NO_FEES',
]);
const SLOT_QUESTIONS = Object.freeze({
  roles: 'Which roles are you focused on filling?',
  industries: 'Which industries do you serve?',
  employerTypes: 'What types of employers are you targeting?',
  geography: 'Which locations do you cover?',
  employerAcquisitionPriority: 'What is your main employer acquisition priority right now?',
});

function guarded(input, code, status = 'guarded') {
  return Object.freeze({
    version: SCHEMA_VERSION, actionId: code === 'UNSUBSCRIBE' || code === 'NOT_INTERESTED'
      || code === 'OUT_OF_OFFICE' ? 'NO_ACTION' : 'HANDOFF',
    handoffCode: code, factIds: [], slotIds: [], objectionType: 'NONE',
    evidenceRefs: [input.targetRef], templateId: 'NONE',
    reasonCode: 'GUARD', confidence: 0,
    suggestedWording: '', status,
  });
}

function guardCode(input) {
  if (input.historical || !input.currentState) return 'STATE_UNAVAILABLE';
  const state = input.currentState;
  const classification = state.productionDecision?.classification;
  if (classification === 'UNSUBSCRIBE') return 'UNSUBSCRIBE';
  if (classification === 'NOT_INTERESTED') return 'NOT_INTERESTED';
  if (classification === 'OUT_OF_OFFICE') return 'OUT_OF_OFFICE';
  const terminal = state.terminal;
  if (terminal === 'unsubscribed') return 'UNSUBSCRIBE';
  if (terminal === 'not_interested') return 'NOT_INTERESTED';
  if (terminal === 'out_of_office') return 'OUT_OF_OFFICE';
  if (terminal) return 'HUMAN_TAKEOVER';
  if (state.humanTakeover || state.staffingAutomationHold) return 'HUMAN_TAKEOVER';
  if (state.productionDecision?.status === 'evaluated_decision_missing'
    || state.productionDecision?.status === 'not_evaluated') return 'PRODUCTION_DECISION_MISSING';
  if (!input.turns.find(turn => turn.ref === input.targetRef)?.content) return 'UNCLEAR_INTENT';
  const risks = new Set(input.riskFlags);
  if (risks.has('conflicting_evidence')) return 'CONFLICTING_EVIDENCE';
  if (risks.has('multiple_threads')) return 'MULTIPLE_THREADS';
  if (risks.has('complaint')) return 'COMPLAINT';
  if (risks.has('reschedule_request') || state.booking?.callLive) return 'BOOKING_OR_RESCHEDULE';
  if (risks.has('proof_request')) return 'PROOF_UNSUPPORTED';
  if (risks.has('results_request')) return 'RESULTS_UNSUPPORTED';
  if (risks.has('unsupported_commercial_request')) return 'COMMERCIAL_UNSUPPORTED';
  if (risks.has('amount_request')) return 'PRICING_UNSUPPORTED';
  if ((state.objections || []).some(item => item.type === 'candidate_side_confusion')) return 'CANDIDATE_SIDE';
  return null;
}

function suggestedWording(output) {
  if (output.templateId === 'NONE') return '';
  if (output.templateId === 'QUALIFY') return output.slotIds.map(id => SLOT_QUESTIONS[id]).join(' ');
  if (output.templateId === 'REFERRAL_ACK') return 'Thank you for pointing us in the right direction. A person on our team can review the referral.';
  if (output.templateId === 'BOOKING_COORDINATION') return 'A person on our team can help coordinate the next step.';
  if (output.templateId === 'OBJECTION_ACK') {
    return `I understand. ${output.factIds.map(id => OFFER_FACTS[id]).join(' ')}`.trim();
  }
  return output.factIds.map(id => OFFER_FACTS[id]).join(' ');
}

function invalid(input, reason) {
  const fallback = guarded(input, 'MODEL_ERROR', 'invalid_model_output');
  return Object.freeze({ ...fallback, validationError: reason });
}

function validateModelDecision(raw, input) {
  const forced = guardCode(input);
  if (forced) return guarded(input, forced);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid(input, 'object required');
  const keys = Object.keys(raw).sort();
  if (keys.join('|') !== [...OUTPUT_FIELDS].sort().join('|')) return invalid(input, 'exact output fields required');
  const listed = (name, values) => typeof raw[name] === 'string' && values.includes(raw[name]);
  if (raw.version !== SCHEMA_VERSION || !listed('actionId', ACTION_IDS)
    || !listed('handoffCode', HANDOFF_CODES) || !listed('objectionType', OBJECTION_TYPES)
    || !listed('templateId', TEMPLATE_IDS) || !listed('reasonCode', REASON_CODES))
    return invalid(input, 'unknown version or enum');
  for (const [key, ids, max] of [['factIds', FACT_IDS, FACT_IDS.length],
    ['slotIds', SLOT_IDS, SLOT_IDS.length], ['evidenceRefs', input.allowedEvidenceRefs, 12]]) {
    if (!Array.isArray(raw[key]) || raw[key].length > max
      || raw[key].some(id => typeof id !== 'string' || !ids.includes(id))
      || new Set(raw[key]).size !== raw[key].length) return invalid(input, `invalid ${key}`);
  }
  if (!raw.evidenceRefs.includes(input.targetRef)) return invalid(input, 'target evidence reference required');
  if (typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence)
    || raw.confidence < 0 || raw.confidence > 1) return invalid(input, 'invalid confidence');
  if (raw.templateId !== ACTION_TEMPLATE[raw.actionId]) return invalid(input, 'template/action mismatch');
  if (['GUARD', 'VALIDATION_FAILED'].includes(raw.reasonCode)) return invalid(input, 'internal reason code');
  if (raw.actionId === 'HANDOFF' && raw.handoffCode === 'NONE') return invalid(input, 'handoff code required');
  if (raw.actionId !== 'HANDOFF' && raw.actionId !== 'NO_ACTION' && raw.handoffCode !== 'NONE')
    return invalid(input, 'handoff code on suggestion');
  if (raw.actionId === 'NO_ACTION' && raw.handoffCode !== 'NONE')
    return invalid(input, 'invalid no-action code');
  if (raw.actionId !== 'SUGGEST_QUALIFICATION' && raw.slotIds.length) return invalid(input, 'unexpected slot IDs');
  if (raw.actionId === 'SUGGEST_QUALIFICATION' && (!raw.slotIds.length
    || raw.slotIds.some(id => input.currentState.qualification.slots[id]?.status === 'filled')))
    return invalid(input, 'no open qualification slot');
  if (!['SUGGEST_INFO', 'SUGGEST_FACT_ANSWER', 'SUGGEST_OBJECTION_RESPONSE'].includes(raw.actionId)
    && raw.factIds.length) return invalid(input, 'unexpected fact IDs');
  if (['SUGGEST_INFO', 'SUGGEST_FACT_ANSWER'].includes(raw.actionId) && !raw.factIds.length)
    return invalid(input, 'approved fact IDs required');
  if (raw.actionId !== 'SUGGEST_OBJECTION_RESPONSE' && raw.objectionType !== 'NONE')
    return invalid(input, 'unexpected objection type');
  if (raw.actionId === 'SUGGEST_OBJECTION_RESPONSE') {
    const allowed = (input.currentState.objections || []).map(o => String(o.type || '').toUpperCase());
    if (raw.objectionType === 'NONE' || !allowed.includes(raw.objectionType))
      return invalid(input, 'objection absent from Phase 1 state');
  }
  if (input.riskFlags.includes('pricing_request')) {
    if (raw.actionId !== 'SUGGEST_FACT_ANSWER' || !raw.factIds.length
      || raw.factIds.some(id => !PRICING_FACTS.has(id))) return guarded(input, 'PRICING_UNSUPPORTED');
  }
  if (raw.actionId === 'SUGGEST_REFERRAL_ACK' && input.currentState.referral !== 'referred')
    return invalid(input, 'referral absent from Phase 1 state');
  if (raw.actionId === 'SUGGEST_BOOKING_COORDINATION' && !input.currentState.booking.meetingIntent)
    return invalid(input, 'meeting intent absent from Phase 1 state');
  return Object.freeze({ ...raw,
    suggestedWording: suggestedWording(raw), status: 'valid' });
}

module.exports = { guardCode, guarded, validateModelDecision, suggestedWording };
