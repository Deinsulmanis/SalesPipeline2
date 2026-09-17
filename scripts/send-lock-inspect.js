#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { listUnresolvedReservations, closeSendReservationStore } = require('../integrations/send-lock');
const { sendLockEnabled } = require('../integrations/send-lock-config');
const { operatorRow, listLegacySheetsReservations } = require('../integrations/send-reconciliation');

function summarize(row) {
  return operatorRow(row);
}

async function main() {
  if (!sendLockEnabled()) {
    console.log(JSON.stringify({ enabled: false, note: 'SEND_LOCK_ENABLED is false' }));
    return;
  }
  const listed = await listUnresolvedReservations();
  const payload = {
    enabled: true,
    note: 'Read-only. There is no retry-send action.',
    sent_unconfirmed: (listed.sentUnconfirmed || []).map(summarize),
    reconciliation_required: (listed.reconciliationRequired || []).map(summarize),
    stale_reserved: (listed.staleReserved || []).map(summarize),
    expired_sending: (listed.expiredSending || []).map(summarize),
  };
  if (process.argv.includes('--legacy-help')) {
    payload.legacy_note = 'Pass activities JSON to classifyLegacySheetsReservations; never automatically resend.';
    payload.legacy_example = listLegacySheetsReservations([]);
  }
  console.log(JSON.stringify(payload, null, 2));
}

main()
  .catch(error => {
    console.error(String(error.message || error).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[redacted-db-url]'));
    process.exitCode = 1;
  })
  .finally(() => closeSendReservationStore());
