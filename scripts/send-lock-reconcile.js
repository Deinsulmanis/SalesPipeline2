#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { listUnresolvedReservations, closeSendReservationStore, getOutboundReservation } = require('../integrations/send-lock');
const { sendLockEnabled } = require('../integrations/send-lock-config');
const { operatorRow } = require('../integrations/send-reconciliation');

function usage() {
  console.log(JSON.stringify({
    usage: 'node scripts/send-lock-reconcile.js [--list] [--repair ACTION_ID]',
    note: 'Repair verifies Gmail SENT evidence and repairs local checkpoints only. It never sends or retries.',
  }));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.length === 0) {
    usage();
    return;
  }
  if (!sendLockEnabled()) {
    console.log(JSON.stringify({ enabled: false, note: 'SEND_LOCK_ENABLED is false' }));
    return;
  }
  if (args.includes('--list') || !args.includes('--repair')) {
    const listed = await listUnresolvedReservations();
    console.log(JSON.stringify({
      enabled: true,
      retryableSend: false,
      sent_unconfirmed: (listed.sentUnconfirmed || []).map(row => operatorRow(row)),
      reconciliation_required: (listed.reconciliationRequired || []).map(row => operatorRow(row)),
      stale_reserved: (listed.staleReserved || []).map(row => operatorRow(row)),
      expired_sending: (listed.expiredSending || []).map(row => operatorRow(row)),
    }, null, 2));
  }
  const repairIdx = args.indexOf('--repair');
  if (repairIdx !== -1) {
    const actionId = args[repairIdx + 1];
    if (!actionId) {
      console.error(' --repair requires an action_id');
      process.exitCode = 2;
      return;
    }
    const reservation = await getOutboundReservation(actionId);
    if (!reservation) {
      console.log(JSON.stringify({ ok: false, code: 'reservation_missing', actionId, sends: 0 }));
      process.exitCode = 1;
      return;
    }
    // Production repair of local checkpoints runs through POST /api/ops/send-reconciliation
    // where Gmail and Sheets adapters exist. The CLI refuses to send and refuses to
    // invent a mailbox; it only reports the recommended operator action.
    console.log(JSON.stringify({
      ok: true,
      actionId,
      sends: 0,
      retryableSend: false,
      reservation: operatorRow(reservation),
      note: 'CLI repair is listing-only without a Gmail mailbox adapter. Use POST /api/ops/send-reconciliation to verify SENT evidence and repair checkpoints. Never retry send.',
    }, null, 2));
  }
}

main()
  .catch(error => {
    console.error(String(error.message || error).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[redacted-db-url]'));
    process.exitCode = 1;
  })
  .finally(() => closeSendReservationStore());
