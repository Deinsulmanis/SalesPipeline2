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

async function withOutboundReservation(action, run, env = process.env) {
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
    status: reserved.reservation.status,
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

async function withGmailProviderSend({ lead, sendAction, run, env = process.env }) {
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
    logSendLock('reservation_confirmed', {
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

async function listUnresolvedReservations(env = process.env) {
  if (!sendLockEnabled(env) && !injectedStore) {
    return { enabled: false, sentUnconfirmed: [], reconciliationRequired: [], staleReserved: [] };
  }
  await assertSendLockReady(env);
  const store = await getStore(env);
  const listed = await store.listUnresolved();
  return { enabled: true, ...listed };
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
  getOutboundReservation, listUnresolvedReservations, closeSendReservationStore,
  isDefinitePreDeliveryFailure, providerIdsFromResult,
};
