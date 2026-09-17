'use strict';

const {
  STATUS, rowView, denialForExisting, canTakeOver, shouldMarkReconciliation,
} = require('./send-reservation-rules');

function createMemorySendReservationStore({ now = () => new Date(), leaseSeconds = 300 } = {}) {
  const rows = new Map();
  let tail = Promise.resolve();
  const exclusive = fn => {
    const run = tail.then(fn, fn);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };

  const current = () => new Date(now());

  function read(actionId) {
    const row = rows.get(actionId);
    return row ? rowView({ ...row }) : null;
  }

  function write(row) {
    rows.set(row.action_id, row);
    return rowView({ ...row });
  }

  return {
    kind: 'memory',
    async getReservation(actionId) {
      return exclusive(async () => read(actionId));
    },
    async reserveOutboundAction(action, { leaseOwner, leaseSeconds: seconds } = {}) {
      return exclusive(async () => {
        const at = current();
        const existing = read(action.actionId);
        if (existing && !canTakeOver(existing, at)) {
          if (shouldMarkReconciliation(existing, at)) {
            const row = rows.get(action.actionId);
            row.status = STATUS.RECONCILIATION_REQUIRED;
            row.lease_owner = null;
            row.updated_at = at;
            row.last_error = 'lease expired after provider attempt started';
            return {
              ...denialForExisting(read(action.actionId)),
              markedReconciliation: true,
            };
          }
          return denialForExisting(existing);
        }
        const ttl = Number(seconds || leaseSeconds);
        const expires = new Date(at.getTime() + ttl * 1000);
        const previous = rows.get(action.actionId);
        const row = {
          action_id: action.actionId,
          lead_id: action.leadId,
          action_type: action.actionType,
          provider: action.provider,
          status: STATUS.RESERVED,
          lease_owner: leaseOwner,
          lease_expires_at: expires,
          reserved_at: at,
          provider_attempt_started_at: null,
          provider_message_id: null,
          provider_thread_id: null,
          provider_succeeded_at: null,
          confirmed_at: null,
          failed_at: null,
          last_error: null,
          created_at: previous?.created_at || at,
          updated_at: at,
        };
        return { ok: true, code: existing ? 'reservation_taken_over' : 'reservation_acquired', reservation: write(row) };
      });
    },
    async markProviderAttemptStarted(actionId, leaseOwner) {
      return exclusive(async () => {
        const at = current();
        const row = rows.get(actionId);
        if (!row) return { ok: false, code: 'reservation_missing', reason: 'reservation not found' };
        if (row.lease_owner !== leaseOwner) {
          return { ok: false, code: 'reservation_not_owned', reason: 'lease owner does not match' };
        }
        if (row.status !== STATUS.RESERVED || row.provider_attempt_started_at) {
          return { ok: false, code: 'reservation_not_startable', reason: 'reservation is not in a startable reserved state' };
        }
        if (row.lease_expires_at && row.lease_expires_at.getTime() < at.getTime()) {
          return { ok: false, code: 'reservation_lease_expired', reason: 'reserved lease expired before provider attempt' };
        }
        row.status = STATUS.SENDING;
        row.provider_attempt_started_at = at;
        row.updated_at = at;
        return { ok: true, reservation: write(row) };
      });
    },
    async markProviderSucceeded(actionId, leaseOwner, ids = {}) {
      return exclusive(async () => {
        const at = current();
        const row = rows.get(actionId);
        if (!row) return { ok: false, code: 'reservation_missing', reason: 'reservation not found' };
        if (row.lease_owner !== leaseOwner) {
          return { ok: false, code: 'reservation_not_owned', reason: 'lease owner does not match' };
        }
        if (row.status !== STATUS.SENDING || !row.provider_attempt_started_at) {
          return { ok: false, code: 'reservation_not_sending', reason: 'provider success can only be recorded from sending' };
        }
        row.status = STATUS.SENT_UNCONFIRMED;
        row.provider_message_id = ids.providerMessageId || null;
        row.provider_thread_id = ids.providerThreadId || null;
        row.provider_succeeded_at = at;
        row.updated_at = at;
        return { ok: true, reservation: write(row) };
      });
    },
    async markConfirmed(actionId, leaseOwner, { allowReconciliation = false } = {}) {
      return exclusive(async () => {
        const at = current();
        const row = rows.get(actionId);
        if (!row) return { ok: false, code: 'reservation_missing', reason: 'reservation not found' };
        if (leaseOwner && row.lease_owner && row.lease_owner !== leaseOwner) {
          return { ok: false, code: 'reservation_not_owned', reason: 'lease owner does not match' };
        }
        if (row.status === STATUS.CONFIRMED) {
          return { ok: true, alreadyConfirmed: true, reservation: read(actionId) };
        }
        const fromUnconfirmed = row.status === STATUS.SENT_UNCONFIRMED;
        const fromReconciled = allowReconciliation
          && row.status === STATUS.RECONCILIATION_REQUIRED
          && Boolean(row.provider_message_id);
        if (!fromUnconfirmed && !fromReconciled) {
          return { ok: false, code: 'reservation_not_confirmable', reason: 'only verified sent_unconfirmed rows can be confirmed' };
        }
        row.status = STATUS.CONFIRMED;
        row.confirmed_at = at;
        row.updated_at = at;
        row.last_error = null;
        return { ok: true, reservation: write(row) };
      });
    },
    async markPreDeliveryFailed(actionId, leaseOwner, lastError) {
      return exclusive(async () => {
        const at = current();
        const row = rows.get(actionId);
        if (!row) return { ok: false, code: 'reservation_missing', reason: 'reservation not found' };
        if (row.lease_owner !== leaseOwner) {
          return { ok: false, code: 'reservation_not_owned', reason: 'lease owner does not match' };
        }
        if (row.status !== STATUS.SENDING || row.provider_succeeded_at) {
          return { ok: false, code: 'reservation_not_pre_delivery', reason: 'pre-delivery failure requires an in-flight send with no provider success' };
        }
        row.status = STATUS.FAILED_PRE_DELIVERY;
        row.failed_at = at;
        row.last_error = String(lastError || '').slice(0, 500);
        row.updated_at = at;
        return { ok: true, reservation: write(row) };
      });
    },
    async markReconciliationRequired(actionId, lastError) {
      return exclusive(async () => {
        const at = current();
        const row = rows.get(actionId);
        if (!row) return { ok: false, code: 'reservation_missing', reason: 'reservation not found' };
        if (row.status === STATUS.CONFIRMED || row.status === STATUS.FAILED_PRE_DELIVERY) {
          return { ok: false, code: 'reservation_terminal', reason: 'terminal rows are not moved to reconciliation_required' };
        }
        row.status = STATUS.RECONCILIATION_REQUIRED;
        row.last_error = String(lastError || '').slice(0, 500);
        row.updated_at = at;
        return { ok: true, reservation: write(row) };
      });
    },
    async listUnresolved() {
      return exclusive(async () => {
        const at = current();
        const all = [...rows.values()].map(row => rowView({ ...row }));
        const expired = row => row.leaseExpiresAt && new Date(row.leaseExpiresAt).getTime() < at.getTime();
        return {
          sentUnconfirmed: all.filter(row => row.status === STATUS.SENT_UNCONFIRMED),
          reconciliationRequired: all.filter(row => row.status === STATUS.RECONCILIATION_REQUIRED),
          staleReserved: all.filter(row => row.status === STATUS.RESERVED && expired(row)),
          expiredSending: all.filter(row => row.status === STATUS.SENDING && expired(row)),
        };
      });
    },
    async health() {
      return { ok: true, enabled: true, kind: 'memory', table: 'outbound_send_reservations' };
    },
    async close() { rows.clear(); },
  };
}

module.exports = { createMemorySendReservationStore };
