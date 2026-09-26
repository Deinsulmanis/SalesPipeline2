'use strict';

const { isDeepStrictEqual } = require('node:util');
const { buildAgentV2Input } = require('./agent-v2-input');
const { guardCode, validateModelDecision } = require('./agent-v2-validation');
const { decisionIdFor } = require('./agent-v2-store');
const { PENDING_STATUS, pendingProofMatches } = require('./agent-v2-pending-decision');
const { ACTION_IDS, AUTHORITY, CATALOG_VERSION, EVENT_TYPE, INPUT_VERSION,
  OUTPUT_FIELDS, SCHEMA_VERSION, SLOT_IDS } = require('./agent-v2-contract');

const PERMISSION_VERSION = 'agent_v2_permission_v1';
const VERDICT = Object.freeze({ ALLOW: 'ALLOW', DENY: 'DENY', HANDOFF: 'HANDOFF' });
const QUALIFICATION_CLASSES = new Set(['INTERESTED', 'STAFFING_QUALIFICATION']);
const REPEAT_ASK_ACTIONS = new Set(['AUTO_STAFFING_QUALIFY_QUESTION', 'AUTO_STAFFING_SEND_INFO']);
const REPEAT_INFO_ACTIONS = new Set(['AUTO_STAFFING_SEND_INFO', 'AUTO_STAFFING_QUALIFIED']);

function result(verdict, reasonCode, record) {
  return Object.freeze({ version: PERMISSION_VERSION, verdict, reasonCode,
    actionId: ACTION_IDS.includes(record?.decision?.actionId) ? record.decision.actionId : null,
    leadId: typeof record?.leadId === 'string' ? record.leadId : null,
    messageId: typeof record?.messageId === 'string' ? record.messageId : null,
    // ALLOW means the advisory proposal may be reviewed, never executed.
    executionAuthorized: false, authority: AUTHORITY });
}

function stateComplete(state) {
  return Boolean(state && Array.isArray(state.turns)
    && typeof state.evidenceDigest === 'string' && state.evidenceDigest.length > 0
    && typeof state.asOf === 'string' && Number.isFinite(Date.parse(state.asOf))
    && state.terminalState && Object.hasOwn(state.terminalState, 'blockedBy')
    && state.ownership && typeof state.ownership.humanTakeover?.value === 'boolean'
    && typeof state.ownership.staffingAutomationHold?.applies === 'boolean'
    && state.responseState && ['yes', 'no', 'no_prospect_message'].includes(state.responseState.answered)
    && state.qualification && typeof state.qualification.status === 'string'
    && state.qualification.slots && Array.isArray(state.qualification.legacyTags)
    && state.booking && typeof state.booking.meetingIntent?.value === 'boolean'
    && typeof state.booking.call?.live === 'boolean'
    && typeof state.booking.linkSent?.status === 'string'
    && Array.isArray(state.thread?.threadIds)
    && Array.isArray(state.evidenceWarnings) && Array.isArray(state.ambiguities));
}

function hasPriorStaffingReply(state, actions) {
  return state.turns.some(turn => turn.direction === 'outbound'
    && turn.actor === 'automation' && actions.has(turn.actionType));
}

function evaluateAgentV2Permission(state, record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || !stateComplete(state) || typeof record.messageId !== 'string')
    return result(VERDICT.DENY, 'STATE_OR_RECORD_UNAVAILABLE', record);

  let input;
  try { input = buildAgentV2Input(state, record.messageId); }
  catch { return result(VERDICT.DENY, 'STATE_UNAVAILABLE', record); }
  if (record.eventType !== EVENT_TYPE || record.schemaVersion !== SCHEMA_VERSION
    || record.inputVersion !== INPUT_VERSION || record.catalogVersion !== CATALOG_VERSION
    || record.leadId !== input.leadId || record.messageId !== input.messageId
    || record.decisionId !== decisionIdFor(input.leadId, input.messageId)
    || !isDeepStrictEqual(record.authority, AUTHORITY))
    return result(VERDICT.DENY, 'DECISION_IDENTITY_MISMATCH', record);
  if (input.historical) return result(VERDICT.DENY, 'STALE_INBOUND', record);
  const target = state.turns.find(turn => turn.direction === 'inbound'
    && turn.messageId === input.messageId);
  if (!target || !target.contentAvailable || !String(target.content || '').trim())
    return result(VERDICT.HANDOFF, 'UNCLEAR_INTENT', record);
  if (target.automatedReply || target.genuineHuman === false)
    return result(VERDICT.DENY, 'NON_HUMAN_INBOUND', record);
  if (target.genuineHuman !== true)
    return result(VERDICT.HANDOFF, 'HUMAN_INBOUND_UNPROVEN', record);
  if (target.decision?.status === PENDING_STATUS && !pendingProofMatches(state, target))
    return result(VERDICT.DENY, 'PENDING_PROVIDER_PROOF_INVALID', record);

  const forced = guardCode(input);
  if (forced) return result(['UNSUBSCRIBE', 'NOT_INTERESTED', 'STATE_UNAVAILABLE'].includes(forced)
    ? VERDICT.DENY : VERDICT.HANDOFF, forced, record);
  if (state.turns.some(turn => turn.direction === 'outbound' && turn.actor === 'human'))
    return result(VERDICT.HANDOFF, 'HUMAN_TAKEOVER', record);
  if (state.responseState.answered === 'yes'
    || state.turns.some(turn => turn.direction === 'outbound'
      && turn.inReplyToMessageId === input.messageId)
    || target.decision?.executionStatus === 'sent')
    return result(VERDICT.DENY, 'ALREADY_HANDLED', record);
  if (state.responseState.answered !== 'no')
    return result(VERDICT.HANDOFF, 'RESPONSE_STATE_UNAVAILABLE', record);
  if (!['recorded', PENDING_STATUS].includes(target.decision?.status) || target.decision.exists !== true
    || !target.decision.finalClassification || !target.decision.policyAction)
    return result(VERDICT.HANDOFF, 'PRODUCTION_DECISION_MISSING', record);
  if (target.decision.finalClassification === 'ALREADY_HANDLED'
    || target.decision.finalClassification === 'NEEDS_HUMAN')
    return result(VERDICT.HANDOFF, 'HUMAN_REVIEW_REQUIRED', record);
  if (target.decision.finalClassification === 'WRONG_PERSON')
    return result(VERDICT.HANDOFF, 'WRONG_PERSON_REFERRAL', record);
  if (!((target.decision.status === 'recorded' && target.decision.executionStatus === 'recorded')
    || (target.decision.status === PENDING_STATUS
      && target.decision.executionStatus === PENDING_STATUS)))
    return result(VERDICT.HANDOFF, 'PRODUCTION_ALREADY_HANDLED', record);
  if (!state.ownership.owner || state.ownership.owner === 'unknown'
    || state.thread.ownershipStatus !== 'proven')
    return result(VERDICT.HANDOFF, 'OWNERSHIP_UNPROVEN', record);
  if (state.evidenceWarnings.length) return result(VERDICT.HANDOFF, 'EVIDENCE_WARNING', record);
  if (state.ambiguities.some(item => !item.messageId || item.messageId === input.messageId))
    return result(VERDICT.HANDOFF, 'UNCLEAR_INTENT', record);
  if (state.objections?.some(item => item.type === 'candidate_side_confusion'
    && item.evidenceMessageId === input.messageId))
    return result(VERDICT.HANDOFF, 'CANDIDATE_SIDE', record);

  if (record.stateDigest !== input.stateDigest || record.inputDigest !== input.inputDigest)
    return result(VERDICT.HANDOFF, 'STATE_CHANGED', record);
  const decision = record.decision;
  if (input.riskFlags.includes('pricing_request')
    && decision?.handoffCode === 'PRICING_UNSUPPORTED')
    return result(VERDICT.HANDOFF, 'PRICING_UNSUPPORTED', record);
  if (record.modelStatus !== 'ok' || !decision || decision.status !== 'valid'
    || !isDeepStrictEqual(Object.keys(decision).sort(),
      [...OUTPUT_FIELDS, 'status', 'suggestedWording'].sort()))
    return result(VERDICT.DENY, 'INVALID_DECISION', record);
  const raw = Object.fromEntries(OUTPUT_FIELDS.map(field => [field, decision[field]]));
  const checked = validateModelDecision(raw, input);
  if (checked.handoffCode === 'PRICING_UNSUPPORTED')
    return result(VERDICT.HANDOFF, 'PRICING_UNSUPPORTED', record);
  if (checked.status !== 'valid' || !isDeepStrictEqual(checked, decision))
    return result(VERDICT.DENY, 'INVALID_DECISION', record);

  if (decision.actionId === 'NO_ACTION') return result(VERDICT.DENY, 'NO_ACTION_REQUIRED', record);
  if (decision.actionId === 'HANDOFF') return result(VERDICT.HANDOFF, decision.handoffCode, record);

  if (input.currentState.booking.meetingIntent && decision.actionId !== 'SUGGEST_BOOKING_COORDINATION')
    return result(VERDICT.HANDOFF, 'BOOKING_INTENT_ACTION_MISMATCH', record);
  if (decision.actionId === 'SUGGEST_BOOKING_COORDINATION') {
    if (state.booking.linkSent.status !== 'not_observed')
      return result(VERDICT.HANDOFF, 'BOOKING_LINK_ALREADY_SENT_OR_UNKNOWN', record);
    return result(VERDICT.ALLOW, 'BOOKING_COORDINATION_ADVISORY', record);
  }

  if (decision.actionId === 'SUGGEST_QUALIFICATION') {
    if (!QUALIFICATION_CLASSES.has(target.decision.finalClassification)
      || !['not_started', 'answered'].includes(state.qualification.status)
      || state.qualification.legacyTags.includes('asked')
      || state.qualification.legacyTags.includes('qualified')
      || hasPriorStaffingReply(state, REPEAT_ASK_ACTIONS)
      || decision.slotIds.some(id => !SLOT_IDS.includes(id)
        || state.qualification.slots[id]?.status !== 'unknown'))
      return result(VERDICT.HANDOFF, 'QUALIFICATION_NOT_APPROPRIATE', record);
    return result(VERDICT.ALLOW, 'OPEN_QUALIFICATION_SLOT', record);
  }
  if (decision.actionId === 'SUGGEST_INFO') {
    if (state.qualification.legacyTags.some(tag => ['infoSent', 'qualified'].includes(tag))
      || hasPriorStaffingReply(state, REPEAT_INFO_ACTIONS))
      return result(VERDICT.HANDOFF, 'STAFFING_INFO_ALREADY_SENT', record);
    return result(VERDICT.ALLOW, 'INFORMATION_ADVISORY', record);
  }
  if (decision.actionId === 'SUGGEST_FACT_ANSWER')
    return result(VERDICT.ALLOW, 'APPROVED_FACT_ADVISORY', record);
  if (decision.actionId === 'SUGGEST_OBJECTION_RESPONSE')
    return result(VERDICT.HANDOFF, 'OBJECTION_REQUIRES_HUMAN', record);
  if (decision.actionId === 'SUGGEST_REFERRAL_ACK')
    return result(VERDICT.HANDOFF, 'REFERRAL_REQUIRES_HUMAN', record);
  return result(VERDICT.DENY, 'UNSUPPORTED_ACTION', record);
}

module.exports = { PERMISSION_VERSION, VERDICT, evaluateAgentV2Permission };
