#!/usr/bin/env node
'use strict';

// Read-only Supabase connection/privilege audit plus transient session locks.
// Run --session-only after creating the restricted role, before the migration.
// Run without that flag after migration/grants, before any model invocation.
require('dotenv').config({ quiet: true });
const { Client } = require('pg');
const { assertSupabaseSessionConnectionString, createPgAgentV2Store } = require('../integrations/agent-v2-store');

async function verifyTls(client) {
  const result = await client.query('SELECT ssl AS active FROM pg_stat_ssl WHERE pid = pg_backend_pid()');
  if (result.rows.length !== 1 || result.rows[0].active !== true)
    throw new Error('Agent v2 Supabase connection is not using TLS');
  return true;
}

let failureStage = 'connection-url';

async function main() {
  const sessionOnly = process.argv.length === 3 && process.argv[2] === '--session-only';
  if (!sessionOnly && process.argv.length !== 2) throw new Error('unexpected preflight option');
  const connectionString = process.env.AGENT_V2_SUPABASE_DATABASE_URL;
  const { mode } = assertSupabaseSessionConnectionString(connectionString, process.env.SUPABASE_URL);
  const store = createPgAgentV2Store({ connectionString });
  const client = new Client({ connectionString });
  try {
    failureStage = 'role-restrictions';
    await store.verifyRoleRestrictions();
    failureStage = 'session-lock';
    const lock = await store.verifySessionLock();
    failureStage = 'client-connect';
    await client.connect();
    failureStage = 'tls';
    await verifyTls(client);
    failureStage = 'identity';
    const identity = await client.query(`SELECT current_user AS role, session_user AS login_role,
      to_regclass('public.agent_v2_shadow_decisions') IS NOT NULL AS table_exists`);
    const row = identity.rows[0];
    if (row.role !== 'agent_v2_shadow_worker' || row.login_role !== row.role)
      throw new Error('restricted role identity check failed');
    if (sessionOnly) {
      process.stdout.write(`${JSON.stringify({ mode, roleVerified: true,
        projectSuffixVerified: true, port5432Verified: true, tlsActive: true,
        loginRoleMatchesCurrentRole: true, backendPidStable: lock.backendPidStable,
        firstLockAcquired: lock.firstLockAcquired,
        competingLockBlocked: lock.competingLockBlocked,
        lockReacquiredAfterRelease: lock.reacquiredAfterRelease,
        elevatedSetRoleCapabilityDenied: true, schemaCreateDenied: true,
        unrelatedTableAccessDenied: true, tableExists: row.table_exists,
        roleRestrictionsVerified: true })}\n`);
      return;
    }
    if (!row.table_exists) throw new Error('Agent v2 shadow table is absent');
    failureStage = 'schema';
    await store.ensureSchema();
    failureStage = 'privileges';
    await store.verifyPrivileges();
    process.stdout.write(`${JSON.stringify({ mode, roleVerified: true,
      tlsActive: true, sessionLockVerified: true,
      lockReacquiredAfterRelease: lock.reacquiredAfterRelease,
      tableExists: true, schemaVerified: true,
      privilegesVerified: true, roleRestrictionsVerified: true })}\n`);
  } finally {
    await client.end().catch(() => {});
    await store.close().catch(() => { failureStage = 'cleanup'; throw new Error('preflight cleanup failed'); });
  }
}

if (require.main === module) main().catch(error => {
  // Driver errors can contain a connection string; never print them here.
  const safeRoleErrors = new Set([
    'Agent v2 shadow role attributes or memberships are not restricted as required',
    'Agent v2 shadow role can create in a schema',
    'Agent v2 shadow role can access unrelated tables',
  ]);
  const detail = safeRoleErrors.has(error?.message) ? error.message
    : /^[A-Z0-9_]{2,32}$/.test(error?.code || '') ? `driver code ${error.code}`
      : /timeout/i.test(error?.message || '') ? 'connection timeout' : 'driver error';
  console.error(`Agent v2 Supabase preflight failed at ${failureStage}: ${detail}.`);
  process.exitCode = 1;
});

module.exports = { verifyTls };
