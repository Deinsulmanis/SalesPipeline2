'use strict';

const STATUS = Object.freeze({
  RESERVED: 'reserved',
  SENDING: 'sending',
  SENT_UNCONFIRMED: 'sent_unconfirmed',
  CONFIRMED: 'confirmed',
  FAILED_PRE_DELIVERY: 'failed_pre_delivery',
  RECONCILIATION_REQUIRED: 'reconciliation_required',
});

const TAKEOVER_ELIGIBLE = new Set([STATUS.FAILED_PRE_DELIVERY]);

function iso(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function rowView(row) {
  if (!row) return null;
  return {
    actionId: row.action_id,
    leadId: row.lead_id,
    actionType: row.action_type,
    provider: row.provider,
    status: row.status,
    leaseOwner: row.lease_owner || null,
    leaseExpiresAt: iso(row.lease_expires_at),
    reservedAt: iso(row.reserved_at),
    providerAttemptStartedAt: iso(row.provider_attempt_started_at),
    providerMessageId: row.provider_message_id || null,
    providerThreadId: row.provider_thread_id || null,
    providerSucceededAt: iso(row.provider_succeeded_at),
    confirmedAt: iso(row.confirmed_at),
    failedAt: iso(row.failed_at),
    lastError: row.last_error || null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function denialForExisting(existing) {
  const status = existing?.status;
  if (status === STATUS.CONFIRMED) {
    return { ok: false, code: 'reservation_confirmed', reason: 'action is already confirmed', existing };
  }
  if (status === STATUS.SENT_UNCONFIRMED) {
    return { ok: false, code: 'reservation_sent_unconfirmed', reason: 'provider success is already recorded; send is not retryable', existing };
  }
  if (status === STATUS.RECONCILIATION_REQUIRED) {
    return { ok: false, code: 'reservation_reconciliation_required', reason: 'action requires reconciliation and is not automatically sendable', existing };
  }
  if (status === STATUS.SENDING) {
    return { ok: false, code: 'reservation_sending', reason: 'a provider attempt is already in progress or crashed mid-send', existing };
  }
  if (status === STATUS.RESERVED && existing.providerAttemptStartedAt) {
    return { ok: false, code: 'reservation_reconciliation_required', reason: 'provider attempt started on a reserved row; automatic resend is forbidden', existing };
  }
  if (status === STATUS.RESERVED) {
    return { ok: false, code: 'reservation_leased', reason: 'action is held by a live lease', existing };
  }
  return { ok: false, code: 'reservation_denied', reason: 'action is not acquireable', existing };
}

function canTakeOver(existing, now) {
  if (!existing) return true;
  if (existing.status === STATUS.FAILED_PRE_DELIVERY) return true;
  if (existing.status !== STATUS.RESERVED) return false;
  if (existing.providerAttemptStartedAt) return false;
  if (!existing.leaseExpiresAt) return false;
  return new Date(existing.leaseExpiresAt).getTime() < now.getTime();
}

function shouldMarkReconciliation(existing, now) {
  if (!existing) return false;
  if (existing.status === STATUS.RECONCILIATION_REQUIRED || existing.status === STATUS.CONFIRMED) return false;
  if (existing.status === STATUS.SENT_UNCONFIRMED) return false;
  const expired = existing.leaseExpiresAt && new Date(existing.leaseExpiresAt).getTime() < now.getTime();
  if (existing.status === STATUS.SENDING && expired) return true;
  if (existing.status === STATUS.RESERVED && existing.providerAttemptStartedAt) return true;
  return false;
}

module.exports = {
  STATUS, TAKEOVER_ELIGIBLE, iso, rowView, denialForExisting, canTakeOver, shouldMarkReconciliation,
};
