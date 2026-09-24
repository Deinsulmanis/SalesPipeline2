'use strict';

const { buildAgentV2Input } = require('./agent-v2-input');
const { evaluateAgentV2Shadow } = require('./agent-v2-shadow');
const { decisionIdFor } = require('./agent-v2-store');
const { evaluateAgentV2Permission, VERDICT } = require('./agent-v2-permission');
const { renderAgentV2Wording } = require('./agent-v2-wording');
const { AUTHORITY } = require('./agent-v2-contract');

const ORCHESTRATION_VERSION = 'agent_v2_readiness_v1';

function readiness(decisionId, leadId, messageId, decisionStatus, reasonCode,
  permission = null, wording = null) {
  return Object.freeze({
    version: ORCHESTRATION_VERSION, decisionId, leadId, messageId,
    decisionStatus, permissionVerdict: permission?.verdict || null,
    permissionReasonCode: permission?.reasonCode || null,
    wordingStatus: wording?.status || 'NOT_RUN', wording: wording?.wording || null,
    reasonCode, executionReady: reasonCode === 'READY', executionAuthorized: false,
    authority: AUTHORITY,
  });
}

function timestamp(value) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validCompletedRow(row, decisionId, leadId, messageId) {
  if (!row) return 'LEDGER_MISSING';
  if (row.decision_id !== decisionId || row.lead_id !== leadId || row.message_id !== messageId)
    return 'LEDGER_IDENTITY_MISMATCH';
  if (!row.record || !row.completed_at) return 'LEDGER_INCOMPLETE';
  const record = row.record;
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || record.decisionId !== decisionId || record.leadId !== leadId
    || record.messageId !== messageId || row.action_id !== record.decision?.actionId
    || !timestamp(row.claimed_at) || !timestamp(row.created_at)
    || !timestamp(row.completed_at) || !timestamp(record.createdAt)
    || !timestamp(record.stateAsOf)
    || timestamp(row.created_at) !== timestamp(record.createdAt)
    || !Number.isInteger(row.claim_attempts) || row.claim_attempts < 1
    || typeof row.claim_token !== 'string' || !row.claim_token)
    return 'LEDGER_INVALID';
  if (record.modelStatus === 'ok'
    && (!timestamp(row.model_started_at)
      || timestamp(row.model_started_at) > timestamp(row.completed_at)))
    return 'LEDGER_INVALID';
  return null;
}

function verifiedInbound(state, leadId, messageId) {
  let input;
  try { input = buildAgentV2Input(state, messageId); }
  catch { return false; }
  const target = state.turns.find(turn => turn.direction === 'inbound'
    && turn.messageId === messageId);
  return Boolean(input.leadId === leadId && !input.historical && input.stateDigest
    && target?.genuineHuman === true && !target.automatedReply
    && target.contentAvailable && String(target.content || '').trim()
    && target.decision?.status === 'recorded' && target.decision?.exists === true
    && target.decision.finalClassification && target.decision.policyAction
    && target.decision.executionStatus === 'recorded');
}

function phase0Passes(observation, state, row, leadId, messageId) {
  const observedAt = timestamp(observation?.observedAt);
  return Boolean(observation && observation.leadId === leadId
    && observation.messageId === messageId
    && observation.stateDigest === state.evidenceDigest
    && observedAt && observedAt >= timestamp(row.completed_at)
    && observedAt >= timestamp(state.asOf)
    && observation.outboundObservationOk === true
    && observation.alreadyHandled === false
    && observation.humanTouchBlock === null
    && observation.repeatReason === ''
    && observation.suppressionReason === '');
}

// Readiness always starts from a completed database row. Callers must supply
// fresh, read-only Phase 1 and Phase 0 observers; missing observers fail closed.
async function evaluateAgentV2Readiness({ leadId, messageId, store, loadCurrentState,
  checkPhase0, wordingCandidate } = {}) {
  const id = String(leadId || '').trim();
  const message = String(messageId || '').trim();
  if (!id || !message) return readiness(null, id || null, message || null,
    'UNAVAILABLE', 'INBOUND_IDENTITY_MISSING');
  const decisionId = decisionIdFor(id, message);
  if (typeof store?.getDecisionRow !== 'function')
    return readiness(decisionId, id, message, 'UNAVAILABLE', 'LEDGER_UNAVAILABLE');
  let row;
  try { row = await store.getDecisionRow(decisionId); }
  catch { return readiness(decisionId, id, message, 'UNAVAILABLE', 'LEDGER_UNAVAILABLE'); }
  const rowError = validCompletedRow(row, decisionId, id, message);
  if (rowError) return readiness(decisionId, id, message,
    rowError === 'LEDGER_MISSING' ? 'MISSING' : rowError === 'LEDGER_INCOMPLETE'
      ? 'INCOMPLETE' : 'INVALID', rowError);
  if (typeof loadCurrentState !== 'function')
    return readiness(decisionId, id, message, 'COMPLETE', 'PHASE1_UNAVAILABLE');
  let state;
  try { state = await loadCurrentState({ leadId: id, messageId: message,
    asOf: row.record.stateAsOf }); }
  catch { return readiness(decisionId, id, message, 'COMPLETE', 'PHASE1_UNAVAILABLE'); }
  if (!state) return readiness(decisionId, id, message, 'COMPLETE', 'PHASE1_UNAVAILABLE');
  if (state.asOf !== row.record.stateAsOf)
    return readiness(decisionId, id, message, 'COMPLETE', 'STATE_CLOCK_MISMATCH');
  let permission;
  try { permission = evaluateAgentV2Permission(state, row.record); }
  catch { return readiness(decisionId, id, message, 'COMPLETE', 'PHASE3_UNAVAILABLE'); }
  if (permission.verdict !== VERDICT.ALLOW)
    return readiness(decisionId, id, message, 'COMPLETE', permission.reasonCode, permission);

  // These are the existing Phase 0 live checks' read-only observations, not an
  // execution token. Phase 6 must still repeat them immediately before acting.
  if (typeof checkPhase0 !== 'function')
    return readiness(decisionId, id, message, 'COMPLETE', 'PHASE0_UNAVAILABLE', permission);
  let observation;
  try { observation = await checkPhase0({ state, leadId: id, messageId: message,
    completedAt: row.completed_at }); }
  catch { return readiness(decisionId, id, message, 'COMPLETE', 'PHASE0_UNAVAILABLE', permission); }
  if (!phase0Passes(observation, state, row, id, message))
    return readiness(decisionId, id, message, 'COMPLETE', 'PHASE0_BLOCKED', permission);

  let wording;
  try { wording = renderAgentV2Wording({ state, record: row.record,
    permission, candidate: wordingCandidate }); }
  catch { return readiness(decisionId, id, message, 'COMPLETE',
    'PHASE4_UNAVAILABLE', permission); }
  if (wording.status !== 'RENDERED' || !wording.wording
    || wording.executionAuthorized !== false || wording.decisionId !== decisionId)
    return readiness(decisionId, id, message, 'COMPLETE', wording.reasonCode,
      permission, wording);
  return readiness(decisionId, id, message, 'COMPLETE', 'READY', permission, wording);
}

// Explicit one-shot entrypoint. It reuses Phase 2's durable claim and model
// sequence; neither its in-memory result nor raw model output reaches Phase 3.
async function runAgentV2OneShotReadiness({ leadId, messageId, store, loadCurrentState,
  checkPhase0, model, apiKey, createMessage, now, wordingCandidate } = {}) {
  const id = String(leadId || '').trim();
  const message = String(messageId || '').trim();
  const decisionId = id && message ? decisionIdFor(id, message) : null;
  if (!decisionId || typeof loadCurrentState !== 'function'
    || typeof store?.claim !== 'function' || typeof store?.getDecisionRow !== 'function')
    return { readiness: readiness(decisionId, id || null, message || null,
      'UNAVAILABLE', 'ONE_SHOT_INPUT_UNAVAILABLE'), calledModel: false, reused: false };
  let state;
  try { state = await loadCurrentState({ leadId: id, messageId: message }); }
  catch { /* fail closed below */ }
  if (!verifiedInbound(state, id, message))
    return { readiness: readiness(decisionId, id, message, 'UNAVAILABLE',
      'INBOUND_EVIDENCE_UNVERIFIED'), calledModel: false, reused: false };
  const shadow = await evaluateAgentV2Shadow({ state, messageId: message, store,
    model, apiKey, createMessage, now });
  if (shadow.busy)
    return { readiness: readiness(decisionId, id, message, 'INCOMPLETE',
      'DECISION_BUSY'), calledModel: false, reused: false };
  return { readiness: await evaluateAgentV2Readiness({ leadId: id, messageId: message,
    store, loadCurrentState, checkPhase0, wordingCandidate }),
  calledModel: shadow.calledModel, reused: shadow.reused };
}

module.exports = { ORCHESTRATION_VERSION, evaluateAgentV2Readiness,
  runAgentV2OneShotReadiness };
