#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { sendLockDatabaseUrl, URL_VAR } = require('../integrations/send-lock-config');
const { createPgSendReservationStore } = require('../integrations/send-reservation-store');

async function main() {
  const url = sendLockDatabaseUrl();
  if (!url) {
    console.error(`${URL_VAR} is not set`);
    process.exitCode = 2;
    return;
  }
  const store = createPgSendReservationStore({ connectionString: url });
  try {
    const verified = await store.verifySchema();
    if (!verified.ok) {
      console.error('SCHEMA MISSING OR INCOMPLETE');
      if (verified.reason) console.error(verified.reason);
      if (verified.missing?.length) console.error(`missing columns: ${verified.missing.join(', ')}`);
      process.exitCode = 1;
      return;
    }
    console.log('SCHEMA OK');
    console.log(`table=${verified.table}`);
    console.log(`primary_key=${verified.primaryKey.join(',')}`);
  } finally {
    await store.close();
  }
}

main().catch(error => {
  console.error(String(error.message || error).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[redacted-db-url]'));
  process.exitCode = 1;
});
