'use strict';

const crypto = require('node:crypto');
const os = require('node:os');
const {
  sendLockEnabled, sendLockDatabaseUrl, sendLockLeaseSeconds, sendLockConfig,
  ENABLED_VAR, URL_VAR,
} = require('./send-lock-config');
const { createPgSendReservationStore } = require('./send-reservation-store');
const { isDefinitePreDeliveryFailure, providerIdsFromResult } = require('./provider-delivery-error');
const { STATUS } = require('./send-reservation-rules');
const { checkActionOwnership, resolveLeadClient } = require('./clients/ownership');
const { clientSendBlock } = require('./clients/send-policy');

const LEASE_OWNER = `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;

let injectedStore = null;
let pgStore = null;

function setSendReservationStoreForTests(store) {
  injectedStore = store;
}

function leaseOwnerId() {
  return LEASE_OWNER;
}

function logSendLock(event, fields = {}) {
  const payload = {
    event,
    action_id: fields.actionId || fields.action_id || null,
    lead_id: fields.leadId || fields.lead_id || null,
    provider: fields.provider || null,
    status: fields.status || null,
  };
  if (fields.code) payload.code = fields.code;
  if (fields.clientId) payload.client_id = fields.clientId;
  console.log(JSON.stringify(payload));
}

function redactErrorMessage(error) {
  return String(error?.message || error || 'unknown error')
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[redacted-db-url]')
    .replace(/SEND_LOCK_DATABASE_URL[^\s]*/g, URL_VAR)
    .slice(0, 500);
}

async function getStore(env = process.env) {
  if (injectedStore) return injectedStore;
  if (!sendLockEnabled(env)) return null;
  const url = sendLockDatabaseUrl(env);
  if (!url) {
    const error = new Error('SEND_LOCK_DATABASE_URL is not set');
    error.code = 'lock_database_unavailable';
    throw error;
  }
  if (!pgStore) pgStore = createPgSendReservationStore({ connectionString: url });
  return pgStore;
}

async function sendLockHealth(env = process.env) {
  if (!sendLockEnabled(env)) {
    return { ok: true, enabled: false, reason: 'SEND_LOCK_ENABLED is false' };
  }
  try {
    const store = await getStore(env);
    const health = await store.health();
    if (!health.ok) {
      logSendLock('lock_database_unavailable', { code: health.code });
    }
    return health;
  } catch (error) {
    const code = error.code === 'lock_schema_missing' ? 'lock_schema_missing' : 'lock_database_unavailable';
    logSendLock('lock_database_unavailable', { code });
    return { ok: false, enabled: true, code, reason: redactErrorMessage(error) };
  }
}

async function assertSendLockReady(env = process.env) {
  if (!sendLockEnabled(env)) return { enabled: false };
  const health = await sendLockHealth(env);
  if (!health.ok) {
    const error = new Error(health.reason || 'send lock database is unavailable');
    error.code = health.code || 'lock_database_unavailable';
    throw error;
  }
  return health;
}

// A reservation belongs to exactly one client. An action whose lead, sender,
// campaign and template disagree is refused before any row exists — on the
// locked and the pre-activation unlocked path alike. Actions without an
// ownership block (legacy callers) are unchanged.
function assertActionOwnership(action) {
  const owner = checkActionOwnership(action?.ownership);
  if (!owner.ok) {
    logSendLock('reservation_denied', {
      actionId: action?.actionId, leadId: action?.leadId, provider: action?.provider, code: owner.code,
    });
    const error = new Error(owner.reason);
    error.code = owner.code;
    throw error;
  }
  return owner.clientId || undefined;
}

async function withOutboundReservation(action, run, env = process.env) {
  const clientId = assertActionOwnership(action);
  if (!sendLockEnabled(env) && !injectedStore) return run();
  if (!action?.actionId) {
    const error = new Error('durable send reservation action_id is required');
    error.code = 'send_lock_action_required';
    throw error;
  }
  await assertSendLockReady(env);
  const store = await getStore(env);
  const reserved = await store.reserveOutboundAction(action, {
    leaseOwner: LEASE_OWNER,
    leaseSeconds: sendLockLeaseSeconds(env),
  });
  if (!reserved.ok) {
    logSendLock('reservation_denied', {
      actionId: action.actionId, leadId: action.leadId, provider: action.provider,
      status: reserved.existing?.status, code: reserved.code,
    });
    const error = new Error(reserved.reason);
    error.code = reserved.code;
    error.existing = reserved.existing;
    throw error;
  }
  logSendLock('reservation_acquired', {
    actionId: action.actionId, leadId: action.leadId, provider: action.provider,
    status: reserved.reservation.status, clientId,
  });
  const started = await store.markProviderAttemptStarted(action.actionId, LEASE_OWNER);
  if (!started.ok) {
    logSendLock('reservation_denied', {
      actionId: action.actionId, leadId: action.leadId, provider: action.provider,
      status: started.reservation?.status, code: started.code,
    });
    const error = new Error(started.reason);
    error.code = started.code;
    throw error;
  }
  logSendLock('provider_attempt_started', {
    actionId: action.actionId, leadId: action.leadId, provider: action.provider,
    status: STATUS.SENDING,
  });
  try {
    const result = await run();
    const ids = providerIdsFromResult(result);
    const recorded = await store.markProviderSucceeded(action.actionId, LEASE_OWNER, ids);
    if (!recorded.ok) {
      logSendLock('reconciliation_required', {
        actionId: action.actionId, leadId: action.leadId, provider: action.provider,
        status: STATUS.SENT_UNCONFIRMED, code: 'durable_checkpoint_failed',
      });
      console.error(JSON.stringify({
        event: 'PROVIDER_SUCCESS_BUT_DURABLE_SEND_STATE_COULD_NOT_BE_CHECKPOINTED',
        action_id: action.actionId,
        lead_id: action.leadId,
        provider: action.provider,
        code: recorded.code,
      }));
      const error = new Error('PROVIDER SUCCESS BUT DURABLE SEND STATE COULD NOT BE CHECKPOINTED');
      error.code = 'durable_checkpoint_failed';
      error.providerResult = result;
      throw error;
    }
    logSendLock('provider_success_recorded', {
      actionId: action.actionId, leadId: action.leadId, provider: action.provider,
      status: STATUS.SENT_UNCONFIRMED,
    });
    return result;
  } catch (error) {
    if (error.code === 'durable_checkpoint_failed') throw error;
    if (isDefinitePreDeliveryFailure(error)) {
      await store.markPreDeliveryFailed(action.actionId, LEASE_OWNER, redactErrorMessage(error)).catch(() => {});
    } else {
      await store.markReconciliationRequired(action.actionId, redactErrorMessage(error)).catch(() => {});
      logSendLock('reconciliation_required', {
        actionId: action.actionId, leadId: action.leadId, provider: action.provider,
        status: STATUS.RECONCILIATION_REQUIRED, code: error.code,
      });
    }
    throw error;
  }
}

// Defense in depth at the Gmail provider boundary: every final gate already
// enforces the client switch, but no path — present or future — may reach the
// provider for a lead whose client is not active, not enabled, or unowned.
function assertLeadClientMaySend(lead, sendAction, env) {
  if (!lead) return;
  const owner = resolveLeadClient(lead);
  const blocked = owner.ok ? clientSendBlock(owner.clientId, env) : { code: owner.code, reason: owner.reason };
  if (!blocked) return;
  logSendLock('reservation_denied', {
    actionId: sendAction?.actionId, leadId: lead.id, provider: 'gmail', code: blocked.code,
    clientId: owner.ok ? owner.clientId : undefined,
  });
  const error = new Error(blocked.reason);
  error.code = blocked.code;
  throw error;
}

// The last tenant check before Gmail, whatever routing, queue row or runtime
// overlay produced this pairing: the sending inbox must belong to the lead's
// client, a managed client's inbox must serve the lead's campaign, and the
// inbox must be delivery eligible with no policy blocker. Only the client of
// each side is compared, so ScaleLab's own sends are judged exactly as before.
function assertSenderServesLead(lead, sender, sendAction) {
  if (!lead) return;
  const refuse = (code, reason) => {
    logSendLock('reservation_denied', { actionId: sendAction?.actionId, leadId: lead.id, provider: 'gmail', code, senderInboxId: sender?.id });
    const error = new Error(reason);
    error.code = code;
    throw error;
  };
  const { resolveSenderClient } = require('./clients/ownership');
  const { getClient } = require('./clients/registry');
  const { senderServesCampaign } = require('./clients/sender-policy');
  const leadOwner = resolveLeadClient(lead);
  // A managed client's lead never reaches Gmail without the sending inbox
  // being judged here. ScaleLab callers keep their existing behaviour.
  if (!sender) {
    if (leadOwner.ok && !getClient(leadOwner.clientId).isDefault) refuse('sender_required', `lead ${lead.id} needs its sending inbox judged before delivery`);
    return;
  }
  const senderOwner = resolveSenderClient(sender);
  if (!leadOwner.ok || !senderOwner.ok) refuse('client_unresolved', (leadOwner.ok ? senderOwner : leadOwner).reason);
  if (leadOwner.clientId !== senderOwner.clientId) {
    refuse('client_ownership_conflict', `sender ${sender.id} belongs to ${senderOwner.clientId}, lead ${lead.id} to ${leadOwner.clientId}`);
  }
  if (sender.policyBlockers?.length) refuse('sender_policy_blocked', `sender ${sender.id}: ${sender.policyBlockers[0]}`);
  if (sender.sendEligible !== true) refuse('sender_not_eligible', `sender ${sender.id} is not delivery eligible`);
  if (!getClient(senderOwner.clientId).isDefault && !senderServesCampaign(sender, lead.intendedCampaignVersion || lead.campaign)) {
    refuse('sender_campaign_not_allowed', `sender ${sender.id} does not serve campaign ${lead.intendedCampaignVersion || lead.campaign || '(blank)'}`);
  }
}

async function withGmailProviderSend({ lead, sendAction, run, sender = null, env = process.env }) {
  assertActionOwnership(sendAction);
  assertLeadClientMaySend(lead, sendAction, env);
  assertSenderServesLead(lead, sender, sendAction);
  if (!sendLockEnabled(env) && !injectedStore) return run();
  const action = sendAction && sendAction.actionId ? sendAction : null;
  if (!action) {
    const error = new Error('durable send reservation action_id is required');
    error.code = 'send_lock_action_required';
    throw error;
  }
  if (!action.leadId && lead?.id) action.leadId = lead.id;
  if (!action.provider) action.provider = 'gmail';
  return withOutboundReservation(action, run, env);
}

async function confirmOutboundReservation(actionId, env = process.env) {
  if (!sendLockEnabled(env) && !injectedStore) return { ok: true, skipped: true };
  if (!actionId) return { ok: false, code: 'send_lock_action_required' };
  const store = await getStore(env);
  const result = await store.markConfirmed(actionId, LEASE_OWNER);
  if (result.ok) {
    logSendLock(result.alreadyConfirmed ? 'reservation_already_confirmed' : 'reservation_confirmed', {
      actionId, leadId: result.reservation?.leadId, provider: result.reservation?.provider,
      status: STATUS.CONFIRMED,
    });
  }
  return result;
}

async function confirmReconciledReservation(actionId, env = process.env) {
  if (!sendLockEnabled(env) && !injectedStore) return { ok: true, skipped: true };
  if (!actionId) return { ok: false, code: 'send_lock_action_required' };
  const store = await getStore(env);
  const result = await store.markConfirmed(actionId, null, { allowReconciliation: true });
  if (result.ok) {
    logSendLock(result.alreadyConfirmed ? 'reservation_already_confirmed' : 'reservation_confirmed', {
      actionId, leadId: result.reservation?.leadId, provider: result.reservation?.provider,
      status: STATUS.CONFIRMED,
    });
  }
  return result;
}

async function getOutboundReservation(actionId, env = process.env) {
  const store = await getStore(env);
  return store.getReservation(actionId);
}

async function markReservationReconciliationRequired(actionId, lastError, env = process.env) {
  if (!sendLockEnabled(env) && !injectedStore) return { ok: false, code: 'send_lock_required' };
  if (!actionId) return { ok: false, code: 'send_lock_action_required' };
  const store = await getStore(env);
  return store.markReconciliationRequired(actionId, lastError);
}

async function listUnresolvedReservations(env = process.env) {
  if (!sendLockEnabled(env) && !injectedStore) {
    return { enabled: false, sentUnconfirmed: [], reconciliationRequired: [], staleReserved: [], expiredSending: [] };
  }
  await assertSendLockReady(env);
  const store = await getStore(env);
  const listed = await store.listUnresolved();
  return {
    enabled: true,
    sentUnconfirmed: listed.sentUnconfirmed || [],
    reconciliationRequired: listed.reconciliationRequired || [],
    staleReserved: listed.staleReserved || [],
    expiredSending: listed.expiredSending || [],
  };
}

async function closeSendReservationStore() {
  if (injectedStore?.close) await injectedStore.close();
  injectedStore = null;
  if (pgStore) {
    await pgStore.close();
    pgStore = null;
  }
}

module.exports = {
  LEASE_OWNER, STATUS,
  setSendReservationStoreForTests, leaseOwnerId, logSendLock,
  sendLockHealth, assertSendLockReady, sendLockConfig, sendLockEnabled,
  withOutboundReservation, withGmailProviderSend, confirmOutboundReservation,
  confirmReconciledReservation,
  getOutboundReservation, markReservationReconciliationRequired,
  listUnresolvedReservations, closeSendReservationStore,
  isDefinitePreDeliveryFailure, providerIdsFromResult,
};
