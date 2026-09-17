#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { sendLockEnabled, sendLockDatabaseUrl, URL_VAR, ENABLED_VAR } = require('../integrations/send-lock-config');
const { createPgSendReservationStore } = require('../integrations/send-reservation-store');

async function main() {
  if (!sendLockEnabled() && !sendLockDatabaseUrl()) {
    console.error(`${ENABLED_VAR} is false and ${URL_VAR} is empty. Refusing to guess a database.`);
    process.exitCode = 2;
    return;
  }
  const url = sendLockDatabaseUrl();
  if (!url) {
    console.error(`${URL_VAR} is not set`);
    process.exitCode = 2;
    return;
  }
  const store = createPgSendReservationStore({ connectionString: url });
  try {
    const result = await store.applyMigration();
    console.log(`applied ${result.file}`);
    const verified = await store.verifySchema();
    if (!verified.ok) {
      console.error('schema verification failed', verified.missing);
      process.exitCode = 1;
      return;
    }
    console.log('schema ok');
  } finally {
    await store.close();
  }
}

main().catch(error => {
  console.error(String(error.message || error).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[redacted-db-url]'));
  process.exitCode = 1;
});
