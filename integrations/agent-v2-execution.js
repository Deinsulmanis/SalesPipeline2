'use strict';

const { evaluateAgentV2Readiness } = require('./agent-v2-orchestration');
const { pendingProofMatches, QUALIFY_ACTION } = require('./agent-v2-pending-decision');
const { responseActionId } = require('./prospect-reply-delivery');
const { sendAuthorization } = require('./send-authorization');
const { sendLockEnabled, getOutboundReservation, STATUS } = require('./send-lock');
const { decisionIdFor } = require('./agent-v2-store');
const { buildAgentV2Input } = require('./agent-v2-input');
const { canaryDecisionGate } = require('./agent-v2-canary');

const EXECUTION_VERSION = 'agent_v2_execution_v1';
const FLAG = 'AGENT_V2_EXECUTION_ENABLED';

function result({ decisionId = null, leadId = null, messageId = null,
  actionId = null, executionVerdict = 'DENY', executionReasonCode,
  executionAuthorized = false, executionStatus = 'NOT_ATTEMPTED',
  senderInboxId = null, providerMessageId = null } = {}) {
  return Object.freeze({ version: EXECUTION_VERSION, decisionId, leadId, messageId,
    actionId, executionVerdict, executionReasonCode, executionAuthorized,
    executionStatus, senderInboxId, providerMessageId });
}

function liveSafetyPasses(safety, { leadId, messageId, decisionId, stateDigest, senderInboxId }) {
  return Boolean(safety?.allowed === true && safety.leadId === leadId
    && safety.messageId === messageId && safety.decisionId === decisionId
    && safety.stateDigest === stateDigest && safety.senderInboxId === senderInboxId
    && safety.providerThreadLatest === true && safety.humanClear === true
    && safety.repeatClear === true && safety.suppressionClear === true
    && safety.senderOwnershipProven === true && safety.senderEligible === true
    && safety.quotaAvailable === true && safety.windowAvailable === true
    && safety.currentSendAuthorized === true && safety.noNewerInbound === true
    && safety.noConflictingEvidence === true
    && safety.killSwitchArmed === true && safety.canaryCapAvailable === true);
}

// This module never calls Gmail itself. The sole delivery callback is the
// existing hardened warm-reply path, whose finalRevalidate and durable send
// reservation run again immediately before its provider call.
async function executeAgentV2Qualification({ leadId, messageId, store, loadCurrentState,
  checkPhase0, liveSafety, deliver, env = process.env,
  reservationLookup = getOutboundReservation, killSwitch, canaryGate = canaryDecisionGate,
  recoverSend = null } = {}) {
  const id = String(leadId || '').trim();
  const message = String(messageId || '').trim();
  const decisionId = id && message ? decisionIdFor(id, message) : null;
  const base = { decisionId, leadId: id || null, messageId: message || null };
  if (env[FLAG] !== 'true') return result({ ...base, executionReasonCode: 'EXECUTION_DISABLED' });
  if (!decisionId || typeof store?.getDecisionRow !== 'function'
    || typeof loadCurrentState !== 'function' || typeof checkPhase0 !== 'function'
    || typeof liveSafety !== 'function' || typeof deliver !== 'function'
    || typeof killSwitch !== 'function' || typeof canaryGate !== 'function')
    return result({ ...base, executionReasonCode: 'EXECUTION_INPUT_UNAVAILABLE' });
  // Runtime kill switch: read live, fail closed. Recovery and reuse reporting
  // below still run while disarmed; only a NEW send needs it armed.
  const runtimeArmed = async () => {
    try { const state = await killSwitch(); return state?.readable === true && state.armed === true
      ? null : (state?.readable ? 'KILL_SWITCH_DISARMED' : 'KILL_SWITCH_UNREADABLE'); }
    catch { return 'KILL_SWITCH_UNREADABLE'; }
  };
  // An unresolved reservation is reconciled from Gmail before anything else;
  // a lost acknowledgment is never resent.
  const reconcile = async (reservation, scoped) => {
    if (typeof recoverSend !== 'function') return null;
    let recovered;
    try { recovered = await recoverSend({ reservation, actionId: sendId }); } catch { recovered = null; }
    if (recovered?.recovered === true && recovered.providerMessageId)
      return result({ ...scoped, providerMessageId: recovered.providerMessageId,
        executionVerdict: 'REUSED', executionReasonCode: 'PRIOR_PROVIDER_SEND_RECOVERED',
        executionStatus: 'ALREADY_SENT' });
    return result({ ...scoped, executionVerdict: 'HANDOFF',
      executionReasonCode: `RECONCILIATION_${String(recovered?.code || 'UNAVAILABLE').toUpperCase()}`,
      executionStatus: 'RECONCILIATION_REQUIRED' });
  };

  // A confirmed response is an immutable idempotency result. Check it before
  // Phase 5: after a real send, fresh Phase 1 will correctly say "answered"
  // and refuse a new authorization, but replay still needs to report reuse.
  let priorRow; let priorReservation;
  const sendId = responseActionId(id, message, QUALIFY_ACTION);
  try {
    priorRow = await store.getDecisionRow(decisionId);
    priorReservation = await reservationLookup(sendId, env);
  } catch { return result({ ...base, executionReasonCode: 'LEDGER_OR_RESERVATION_UNAVAILABLE' }); }
  if (!priorRow?.completed_at || priorRow.decision_id !== decisionId
    || priorRow.lead_id !== id || priorRow.message_id !== message
    || priorRow.record?.decisionId !== decisionId
    || priorRow.record?.leadId !== id || priorRow.record?.messageId !== message
    || priorRow.record?.modelStatus !== 'ok'
    || priorRow.record?.decision?.status !== 'valid'
    || priorRow.action_id !== priorRow.record?.decision?.actionId)
    return result({ ...base, executionReasonCode: 'DECISION_UNAVAILABLE' });
  if (priorReservation && (priorReservation.actionId !== sendId
    || priorReservation.leadId !== id || priorReservation.actionType !== 'gmail_warm_reply'
    || priorReservation.provider !== 'gmail'))
    return result({ ...base, executionReasonCode: 'RESERVATION_IDENTITY_MISMATCH' });
  const priorAction = priorRow.record?.decision?.actionId || null;
  if (priorAction !== 'SUGGEST_QUALIFICATION')
    return result({ ...base, actionId: priorAction, executionReasonCode: 'ACTION_NOT_ALLOWLISTED' });
  if (priorReservation?.status === STATUS.CONFIRMED
    && !priorReservation.providerMessageId)
    return result({ ...base, actionId: priorAction,
      executionReasonCode: 'CONFIRMED_PROVIDER_ID_MISSING',
      executionStatus: 'RECONCILIATION_REQUIRED' });
  if (priorReservation?.status === STATUS.CONFIRMED)
    return result({ ...base, actionId: priorAction,
      providerMessageId: priorReservation.providerMessageId || null,
      executionVerdict: 'REUSED', executionReasonCode: 'PRIOR_SEND_CONFIRMED',
      executionStatus: 'ALREADY_SENT' });
  if (priorReservation && priorReservation.status !== STATUS.FAILED_PRE_DELIVERY) {
    const reconciled = await reconcile(priorReservation, { ...base, actionId: priorAction });
    if (reconciled) return reconciled;
    return result({ ...base, actionId: priorAction,
      executionReasonCode: `RESERVATION_${String(priorReservation.status || 'UNKNOWN').toUpperCase()}`,
      executionStatus: 'RECONCILIATION_REQUIRED' });
  }
  const disarmedBeforeReadiness = await runtimeArmed();
  if (disarmedBeforeReadiness) return result({ ...base, actionId: priorAction, executionReasonCode: disarmedBeforeReadiness });

  const readiness = await evaluateAgentV2Readiness({ leadId: id, messageId: message,
    store, loadCurrentState, checkPhase0 });
  if (!readiness.executionReady || readiness.executionAuthorized !== false
    || readiness.decisionId !== decisionId || readiness.decisionStatus !== 'COMPLETE')
    return result({ ...base, executionReasonCode: `READINESS_${readiness.reasonCode}` });

  let row; let state;
  try {
    row = await store.getDecisionRow(decisionId);
    state = await loadCurrentState({ leadId: id, messageId: message, asOf: row?.record?.stateAsOf });
  } catch { return result({ ...base, executionReasonCode: 'FRESH_STATE_UNAVAILABLE' }); }
  if (!row?.completed_at || row.decision_id !== decisionId
    || row.lead_id !== id || row.message_id !== message
    || row.record?.decisionId !== decisionId
    || Date.parse(row.completed_at) !== Date.parse(priorRow.completed_at)
    || row.record?.stateDigest !== state?.evidenceDigest
    || state?.asOf !== row.record?.stateAsOf)
    return result({ ...base, executionReasonCode: 'DECISION_OR_STATE_CHANGED' });
  const actionId = row.record?.decision?.actionId || null;
  const scoped = { ...base, actionId };
  if (actionId !== 'SUGGEST_QUALIFICATION')
    return result({ ...scoped, executionReasonCode: 'ACTION_NOT_ALLOWLISTED' });
  let canary;
  try { canary = canaryGate({ record: row.record, state, input: buildAgentV2Input(state, message) }); }
  catch { canary = { allowed: false, code: 'canary_policy_unavailable' }; }
  if (canary?.allowed !== true)
    return result({ ...scoped, executionReasonCode: `CANARY_${String(canary?.code || 'DENIED').toUpperCase()}` });
  const target = state.turns?.find(turn => turn.direction === 'inbound' && turn.messageId === message);
  if (!pendingProofMatches(state, target) || state.latest?.inbound?.messageId !== message)
    return result({ ...scoped, executionReasonCode: 'PENDING_PROOF_OR_LATEST_INBOUND_INVALID' });
  const senderInboxId = target.decision.providerProof.senderInboxId;
  const auth = sendAuthorization(env);
  if (!auth.allowed || !sendLockEnabled(env))
    return result({ ...scoped, senderInboxId, executionReasonCode: auth.code || 'SEND_LOCK_REQUIRED' });
  let safety;
  try { safety = await liveSafety({ leadId: id, messageId: message, decisionId,
    stateDigest: state.evidenceDigest, senderInboxId, completedAt: row.completed_at,
    phase1State: state }); }
  catch { return result({ ...scoped, senderInboxId, executionReasonCode: 'LIVE_SAFETY_UNAVAILABLE' }); }
  if (!liveSafetyPasses(safety, { leadId: id, messageId: message,
    decisionId, stateDigest: state.evidenceDigest, senderInboxId }))
    return result({ ...scoped, senderInboxId,
      executionReasonCode: safety?.code || 'LIVE_SAFETY_BLOCKED' });

  let reservation;
  try { reservation = await reservationLookup(sendId, env); }
  catch { return result({ ...scoped, senderInboxId, executionReasonCode: 'RESERVATION_UNAVAILABLE' }); }
  if (reservation && (reservation.actionId !== sendId || reservation.leadId !== id
    || reservation.actionType !== 'gmail_warm_reply' || reservation.provider !== 'gmail'))
    return result({ ...scoped, senderInboxId, executionReasonCode: 'RESERVATION_IDENTITY_MISMATCH' });
  if (reservation?.status === STATUS.CONFIRMED && !reservation.providerMessageId)
    return result({ ...scoped, senderInboxId,
      executionReasonCode: 'CONFIRMED_PROVIDER_ID_MISSING',
      executionStatus: 'RECONCILIATION_REQUIRED' });
  if (reservation?.status === STATUS.CONFIRMED)
    return result({ ...scoped, senderInboxId, providerMessageId: reservation.providerMessageId,
      executionVerdict: 'REUSED', executionReasonCode: 'PRIOR_SEND_CONFIRMED',
      executionStatus: 'ALREADY_SENT' });
  if (reservation && reservation.status !== STATUS.FAILED_PRE_DELIVERY) {
    const reconciled = await reconcile(reservation, { ...scoped, senderInboxId });
    if (reconciled) return reconciled;
    return result({ ...scoped, senderInboxId,
      executionReasonCode: `RESERVATION_${String(reservation.status || 'UNKNOWN').toUpperCase()}`,
      executionStatus: 'RECONCILIATION_REQUIRED' });
  }
  // Immediately before the delivery primitive: the switch is read again.
  const disarmedBeforeSend = await runtimeArmed();
  if (disarmedBeforeSend) return result({ ...scoped, senderInboxId, executionReasonCode: disarmedBeforeSend });

  // The approved Phase 4 wording is the only prospect-facing proposal passed
  // to the existing delivery primitive. Its own final gate and reservation
  // still decide whether a provider attempt may start.
  let delivered;
  try { delivered = await deliver({ leadId: id, messageId: message, decisionId,
    action: QUALIFY_ACTION, body: readiness.wording, senderInboxId, actionId: sendId,
    stateDigest: state.evidenceDigest, stateAsOf: state.asOf }); }
  catch { return result({ ...scoped, senderInboxId, executionVerdict: 'HANDOFF',
    executionReasonCode: 'DELIVERY_EXCEPTION',
    executionStatus: 'RECONCILIATION_REQUIRED' }); }
  const providerMessageId = delivered?.result?.data?.id || delivered?.result?.providerMessageId
    || delivered?.providerMessageId || null;
  if (!delivered?.delivered) {
    const uncertain = ['provider_ambiguous', 'reservation_unresolved'].includes(delivered?.code);
    return result({ ...scoped, senderInboxId,
      executionVerdict: uncertain ? 'HANDOFF' : 'DENY',
      executionReasonCode: delivered?.code || 'DELIVERY_BLOCKED',
      executionStatus: uncertain ? 'RECONCILIATION_REQUIRED' : 'BLOCKED' });
  }
  if (delivered.actionId !== sendId)
    return result({ ...scoped, senderInboxId, executionVerdict: 'HANDOFF',
      executionReasonCode: 'DELIVERY_IDENTITY_MISMATCH',
      executionStatus: 'RECONCILIATION_REQUIRED' });
  if (delivered.checkpointFailed || (!providerMessageId && !delivered.alreadyCheckpointed))
    return result({ ...scoped, senderInboxId, executionVerdict: 'HANDOFF',
      executionReasonCode: delivered.checkpointFailed ? 'CHECKPOINT_FAILED' : 'PROVIDER_ID_UNAVAILABLE',
      executionStatus: 'RECONCILIATION_REQUIRED' });
  let confirmed;
  try { confirmed = await reservationLookup(sendId, env); }
  catch { /* an unverified reservation cannot be reported as a confirmed send */ }
  if (confirmed?.status !== STATUS.CONFIRMED || !confirmed.providerMessageId
    || confirmed.actionId !== sendId
    || confirmed.leadId !== id || confirmed.actionType !== 'gmail_warm_reply'
    || confirmed.provider !== 'gmail'
    || (providerMessageId && confirmed.providerMessageId !== providerMessageId))
    return result({ ...scoped, senderInboxId, executionVerdict: 'HANDOFF',
      executionReasonCode: 'SEND_CONFIRMATION_UNVERIFIED',
      executionStatus: 'RECONCILIATION_REQUIRED' });
  return result({ ...scoped, senderInboxId, providerMessageId,
    executionVerdict: 'AUTHORIZED', executionAuthorized: true,
    executionReasonCode: delivered.recovered ? 'PRIOR_PROVIDER_SEND_RECOVERED' : 'SENT',
    executionStatus: delivered.recovered || delivered.alreadyCheckpointed ? 'ALREADY_SENT' : 'SENT' });
}

module.exports = { EXECUTION_VERSION, FLAG, executeAgentV2Qualification, liveSafetyPasses };
