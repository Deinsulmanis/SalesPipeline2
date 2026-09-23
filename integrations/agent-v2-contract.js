'use strict';

// Agent v2 is an advisory vocabulary. None of these ids maps to an executor.
const SCHEMA_VERSION = 'agent_v2_decision_v1';
const INPUT_VERSION = 'agent_v2_input_v1';
const CATALOG_VERSION = 'industrial_staffing_offer_v1';
const MODEL = 'claude-haiku-4-5-20251001';
const EVENT_TYPE = 'agent_v2_shadow_decision';
const AUTHORITY = Object.freeze({ send: false, reserve: false, crm: false, ownership: false,
  suppression: false, holds: false, booking: false, calendar: false, sequences: false,
  senderAssignment: false, policy: false });

const ACTION_IDS = Object.freeze([
  'NO_ACTION', 'SUGGEST_QUALIFICATION', 'SUGGEST_INFO', 'SUGGEST_FACT_ANSWER',
  'SUGGEST_OBJECTION_RESPONSE', 'SUGGEST_REFERRAL_ACK',
  'SUGGEST_BOOKING_COORDINATION', 'HANDOFF',
]);
const HANDOFF_CODES = Object.freeze([
  'NONE', 'UNSUBSCRIBE', 'NOT_INTERESTED', 'OUT_OF_OFFICE', 'HUMAN_TAKEOVER',
  'BOOKING_OR_RESCHEDULE', 'WRONG_PERSON_REFERRAL', 'CANDIDATE_SIDE',
  'PRICING_UNSUPPORTED', 'PROOF_UNSUPPORTED', 'RESULTS_UNSUPPORTED',
  'COMMERCIAL_UNSUPPORTED', 'COMPLAINT', 'CONFLICTING_EVIDENCE',
  'MULTIPLE_THREADS', 'UNCLEAR_INTENT', 'MODEL_ERROR',
  'STATE_UNAVAILABLE', 'PRODUCTION_DECISION_MISSING',
]);
const SLOT_IDS = Object.freeze(['roles', 'industries', 'employerTypes', 'geography', 'employerAcquisitionPriority']);
const OBJECTION_TYPES = Object.freeze(['NONE', 'EXISTING_PROVIDER', 'TIMING', 'CANDIDATE_SIDE_CONFUSION', 'OTHER']);
const TEMPLATE_IDS = Object.freeze([
  'NONE', 'QUALIFY', 'INFO_OVERVIEW', 'FACTS_ONLY', 'OBJECTION_ACK',
  'REFERRAL_ACK', 'BOOKING_COORDINATION',
]);
const REASON_CODES = Object.freeze([
  'INTEREST_SIGNAL', 'INFO_REQUEST', 'QUALIFICATION_GAP', 'APPROVED_FACT_MATCH',
  'OBJECTION_EVIDENCE', 'REFERRAL_EVIDENCE', 'MEETING_INTENT',
  'NO_ACTION_REQUIRED', 'HUMAN_REVIEW_REQUIRED', 'GUARD', 'VALIDATION_FAILED',
]);

// Each sentence is approved offer wording, not an inferred customer result.
const OFFER_FACTS = Object.freeze({
  F_TARGET_AGENCIES: 'ScaleLab works with industrial and skilled-trades staffing agencies.',
  F_QUALIFIED_EMPLOYER_MEETINGS: 'The goal is qualified employer meetings.',
  F_HANDLES_PROSPECTING: 'ScaleLab handles employer prospecting.',
  F_HANDLES_OUTREACH: 'ScaleLab handles employer outreach.',
  F_HANDLES_QUALIFICATION: 'ScaleLab handles qualification.',
  F_CALENDAR_PLACEMENT: 'Interested employers are placed on the agency calendar.',
  F_30_DAY_PILOT: 'The employer acquisition pilot lasts 30 days.',
  F_PERFORMANCE_BASED: 'The pilot is performance-based.',
  F_PAYMENT_TIED_MEETINGS: 'Payment is tied to qualified employer meetings.',
  F_NO_MEETINGS_NO_FEES: 'No qualified meetings means no meeting fees.',
});
const FACT_IDS = Object.freeze(Object.keys(OFFER_FACTS));

const OUTPUT_FIELDS = Object.freeze([
  'version', 'actionId', 'handoffCode', 'factIds', 'slotIds', 'objectionType',
  'evidenceRefs', 'templateId', 'reasonCode', 'confidence',
]);
const TOOL_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  required: OUTPUT_FIELDS,
  properties: {
    version: { type: 'string', enum: [SCHEMA_VERSION] },
    actionId: { type: 'string', enum: ACTION_IDS },
    handoffCode: { type: 'string', enum: HANDOFF_CODES },
    factIds: { type: 'array', items: { type: 'string', enum: FACT_IDS }, maxItems: FACT_IDS.length, uniqueItems: true },
    slotIds: { type: 'array', items: { type: 'string', enum: SLOT_IDS }, maxItems: SLOT_IDS.length, uniqueItems: true },
    objectionType: { type: 'string', enum: OBJECTION_TYPES },
    evidenceRefs: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 12, uniqueItems: true },
    templateId: { type: 'string', enum: TEMPLATE_IDS },
    reasonCode: { type: 'string', enum: REASON_CODES },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
});

module.exports = { SCHEMA_VERSION, INPUT_VERSION, CATALOG_VERSION, MODEL, EVENT_TYPE,
  AUTHORITY, ACTION_IDS, HANDOFF_CODES, SLOT_IDS, OBJECTION_TYPES, TEMPLATE_IDS, REASON_CODES,
  OFFER_FACTS, FACT_IDS, OUTPUT_FIELDS, TOOL_SCHEMA };
