#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { sendLockHealth } = require('../integrations/send-lock');
const { sendLockEnabled, sendLockDatabaseUrl, ENABLED_VAR, URL_VAR } = require('../integrations/send-lock-config');
const { createPgSendReservationStore } = require('../integrations/send-reservation-store');

async function main() {
  console.log(`${ENABLED_VAR}=${sendLockEnabled() ? 'true' : 'false'}`);
  console.log(`${URL_VAR}=${sendLockDatabaseUrl() ? 'present' : 'absent'}`);
  if (!sendLockEnabled() && sendLockDatabaseUrl()) {
    const store = createPgSendReservationStore({ connectionString: sendLockDatabaseUrl() });
    try {
      const health = await store.health();
      console.log(JSON.stringify({
        ok: health.ok,
        enabled: false,
        probed: true,
        code: health.code || null,
        reason: health.reason || 'connectivity ok (locking still disabled)',
        table: health.table || null,
        kind: health.kind || null,
      }));
      process.exitCode = health.ok ? 0 : 1;
    } finally {
      await store.close();
    }
    return;
  }
  const health = await sendLockHealth();
  console.log(JSON.stringify({
    ok: health.ok,
    enabled: health.enabled !== false,
    code: health.code || null,
    reason: health.reason || null,
    table: health.table || null,
    kind: health.kind || null,
  }));
  process.exitCode = health.ok ? 0 : 1;
}

main().catch(error => {
  console.error(String(error.message || error).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[redacted-db-url]'));
  process.exitCode = 1;
});
