#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { listUnresolvedReservations, closeSendReservationStore } = require('../integrations/send-lock');
const { sendLockEnabled } = require('../integrations/send-lock-config');

function summarize(row) {
  return {
    action_id: row.actionId,
    lead_id: row.leadId,
    provider: row.provider,
    status: row.status,
    reserved_at: row.reservedAt,
    provider_attempt_started_at: row.providerAttemptStartedAt,
    provider_succeeded_at: row.providerSucceededAt,
    lease_expires_at: row.leaseExpiresAt,
    last_error: row.lastError,
  };
}

async function main() {
  if (!sendLockEnabled()) {
    console.log(JSON.stringify({ enabled: false, note: 'SEND_LOCK_ENABLED is false' }));
    return;
  }
  const listed = await listUnresolvedReservations();
  console.log(JSON.stringify({
    enabled: true,
    sent_unconfirmed: listed.sentUnconfirmed.map(summarize),
    reconciliation_required: listed.reconciliationRequired.map(summarize),
    stale_reserved: listed.staleReserved.map(summarize),
  }, null, 2));
}

main()
  .catch(error => {
    console.error(String(error.message || error).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[redacted-db-url]'));
    process.exitCode = 1;
  })
  .finally(() => closeSendReservationStore());
