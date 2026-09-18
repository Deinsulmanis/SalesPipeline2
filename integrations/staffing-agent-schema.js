'use strict';

/**
 * Staffing Conversation Agent — Phase 1 schema.
 *
 * Recommendations only. Nothing in this file maps an action to a send, CRM
 * write, suppression, queue, campaign, or booking function.
 */

const AGENT_VERSION = 'staffing_conversation_agent_v1';
const PROMPT_VERSION = 'staffing_conversation_agent_prompt_v1';
const OPERATION = 'staffing_conversation_agent_shadow';
const EVENT_TYPE = 'staffing_agent_shadow';
const MODEL = 'claude-haiku-4-5';
const STAFFING_AGENT_KEY_ENV = 'ANTHROPIC_STAFFING_CONVERSATION_AGENT_KEY';

const ZERO_AUTHORITY = Object.freeze({
  send: false,
  crm: false,
  suppression: false,
  queue: false,
  campaign: false,
  booking: false,
});

const RECOMMENDED_ACTIONS = Object.freeze([
  'ASK_QUALIFICATION',
  'SEND_INFO',
  'SEND_BOOKING',
  'HOLD_FOR_LATER',
  'MARK_NOT_INTERESTED',
  'UNSUBSCRIBE',
  'STORE_REFERRAL',
  'ALREADY_HANDLED',
  'ESCALATE_HUMAN',
  'NO_ACTION',
]);
const RECOMMENDED_ACTION_SET = new Set(RECOMMENDED_ACTIONS);

const INTENTS = Object.freeze([
  'INTERESTED',
  'NOT_INTERESTED',
  'QUESTION',
  'UNSUBSCRIBE',
  'TIMING',
  'REFERRAL',
  'EXISTING_PROVIDER',
  'AMBIGUOUS',
  'OTHER',
]);
const INTENT_SET = new Set(INTENTS);

const FITS = Object.freeze(['FIT', 'UNCLEAR', 'MISMATCH', 'UNKNOWN']);
const FIT_SET = new Set(FITS);

const REQUIRED_OUTPUT_FIELDS = Object.freeze([
  'intent', 'confidence', 'fit', 'recommendedAction', 'reason', 'replyDraft',
]);

function shadowEventId(messageId) {
  const id = String(messageId || '').trim();
  return id ? `${EVENT_TYPE}:${id}` : '';
}

function staffingAgentApiKey(env = process.env) {
  const value = env[STAFFING_AGENT_KEY_ENV];
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function staffingConversationAgentConfig(env = process.env) {
  const enabledFlag = env.STAFFING_CONVERSATION_AGENT_ENABLED === 'true';
  const requestedMode = String(env.STAFFING_CONVERSATION_AGENT_MODE || '').trim().toLowerCase();
  const modeSupported = requestedMode === 'shadow';
  const enabled = enabledFlag && modeSupported;
  return Object.freeze({
    enabled,
    mode: enabled ? 'shadow' : 'disabled',
    requestedMode,
    enabledFlag,
    keyConfigured: Boolean(staffingAgentApiKey(env)),
  });
}

function normalizeConfidence(value) {
  if (typeof value === 'string' && value.trim()) value = Number(value.trim());
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value > 1 && value <= 100) value = value / 100;
  if (value < 0 || value > 1) return null;
  return Math.round(value * 1000) / 1000;
}

function failClosedResult(reason, extras = {}) {
  return Object.freeze({
    ok: false,
    status: extras.status || 'agent_error',
    intent: 'AMBIGUOUS',
    confidence: 0,
    fit: 'UNKNOWN',
    recommendedAction: 'ESCALATE_HUMAN',
    reason: String(reason || 'staffing conversation agent failed closed').slice(0, 500),
    replyDraft: '',
    authority: ZERO_AUTHORITY,
    model: extras.model || MODEL,
    agentVersion: AGENT_VERSION,
    promptVersion: PROMPT_VERSION,
    operation: OPERATION,
    usage: extras.usage || { inputTokens: 0, outputTokens: 0 },
    ...extras.extra,
  });
}

function normalizeAgentOutput(raw, extras = {}) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return failClosedResult('malformed JSON', extras);
  }
  for (const field of REQUIRED_OUTPUT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(raw, field)) {
      return failClosedResult(`missing required field: ${field}`, extras);
    }
  }
  const intent = String(raw.intent || '').trim().toUpperCase();
  const fit = String(raw.fit || '').trim().toUpperCase();
  const recommendedAction = String(raw.recommendedAction || '').trim().toUpperCase();
  const confidence = normalizeConfidence(raw.confidence);
  if (!INTENT_SET.has(intent)) return failClosedResult('unknown intent', extras);
  if (!FIT_SET.has(fit)) return failClosedResult('unknown fit', extras);
  if (!RECOMMENDED_ACTION_SET.has(recommendedAction)) return failClosedResult('unknown action', extras);
  if (confidence == null) return failClosedResult('invalid confidence', extras);
  if (typeof raw.reason !== 'string' || !raw.reason.trim()) return failClosedResult('missing reason', extras);
  if (typeof raw.replyDraft !== 'string') return failClosedResult('missing replyDraft', extras);
  return Object.freeze({
    ok: true,
    status: 'ok',
    intent,
    confidence,
    fit,
    recommendedAction,
    reason: raw.reason.trim().slice(0, 500),
    replyDraft: raw.replyDraft.slice(0, 1500),
    authority: ZERO_AUTHORITY,
    model: extras.model || MODEL,
    agentVersion: AGENT_VERSION,
    promptVersion: PROMPT_VERSION,
    operation: OPERATION,
    usage: extras.usage || { inputTokens: 0, outputTokens: 0 },
  });
}

const CLASSIFICATION_ACTION_AGREEMENT = Object.freeze({
  INTERESTED: Object.freeze(['ASK_QUALIFICATION', 'SEND_INFO', 'SEND_BOOKING', 'ALREADY_HANDLED']),
  MEETING_REQUEST: Object.freeze(['SEND_BOOKING', 'ASK_QUALIFICATION', 'SEND_INFO']),
  QUESTION: Object.freeze(['SEND_INFO', 'ASK_QUALIFICATION', 'ESCALATE_HUMAN']),
  SEND_INFO: Object.freeze(['SEND_INFO', 'ASK_QUALIFICATION']),
  STAFFING_QUALIFICATION: Object.freeze(['SEND_BOOKING', 'ESCALATE_HUMAN', 'NO_ACTION']),
  NOT_INTERESTED: Object.freeze(['MARK_NOT_INTERESTED', 'NO_ACTION']),
  UNSUBSCRIBE: Object.freeze(['UNSUBSCRIBE', 'NO_ACTION']),
  OUT_OF_OFFICE: Object.freeze(['HOLD_FOR_LATER', 'NO_ACTION', 'ALREADY_HANDLED']),
  WRONG_PERSON: Object.freeze(['STORE_REFERRAL', 'ESCALATE_HUMAN']),
  ALREADY_HANDLED: Object.freeze(['ALREADY_HANDLED', 'ESCALATE_HUMAN', 'NO_ACTION']),
  NEEDS_HUMAN: Object.freeze(['ESCALATE_HUMAN', 'NO_ACTION', 'STORE_REFERRAL', 'HOLD_FOR_LATER', 'ALREADY_HANDLED']),
});

function broadlyAgree(productionClassification, recommendedAction) {
  const allowed = CLASSIFICATION_ACTION_AGREEMENT[String(productionClassification || '').trim().toUpperCase()];
  return Boolean(allowed && allowed.includes(String(recommendedAction || '').trim().toUpperCase()));
}

module.exports = {
  AGENT_VERSION, PROMPT_VERSION, OPERATION, EVENT_TYPE, MODEL, STAFFING_AGENT_KEY_ENV,
  ZERO_AUTHORITY, RECOMMENDED_ACTIONS, RECOMMENDED_ACTION_SET, INTENTS, FITS,
  REQUIRED_OUTPUT_FIELDS, shadowEventId, staffingAgentApiKey, staffingConversationAgentConfig,
  normalizeConfidence, failClosedResult, normalizeAgentOutput, broadlyAgree,
  CLASSIFICATION_ACTION_AGREEMENT,
};
