#!/usr/bin/env node
'use strict';

// Read-only Supabase connection/privilege audit plus transient session locks.
// Run --session-only after creating the restricted role, before the migration.
// Run without that flag after migration/grants, before any model invocation.
require('dotenv').config({ quiet: true });
const { Client } = require('pg');
const { assertSupabaseSessionConnectionString, createPgAgentV2Store } = require('../integrations/agent-v2-store');

async function main() {
  const sessionOnly = process.argv.length === 3 && process.argv[2] === '--session-only';
  if (!sessionOnly && process.argv.length !== 2) throw new Error('unexpected preflight option');
  const connectionString = process.env.AGENT_V2_SUPABASE_DATABASE_URL;
  const { mode } = assertSupabaseSessionConnectionString(connectionString, process.env.SUPABASE_URL);
  const store = createPgAgentV2Store({ connectionString });
  const client = new Client({ connectionString });
  try {
    await store.verifyRoleRestrictions();
    await store.verifySessionLock();
    await client.connect();
    const identity = await client.query(`SELECT current_user AS role, session_user AS login_role,
      to_regclass('public.agent_v2_shadow_decisions') IS NOT NULL AS table_exists`);
    const row = identity.rows[0];
    if (row.role !== 'agent_v2_shadow_worker' || row.login_role !== row.role)
      throw new Error('restricted role identity check failed');
    if (sessionOnly) {
      process.stdout.write(`${JSON.stringify({ mode, roleVerified: true,
        sessionLockVerified: true, tableExists: row.table_exists,
        roleRestrictionsVerified: true })}\n`);
      return;
    }
    if (!row.table_exists) throw new Error('Agent v2 shadow table is absent');
    await store.ensureSchema();
    await store.verifyPrivileges();
    process.stdout.write(`${JSON.stringify({ mode, roleVerified: true,
      sessionLockVerified: true, tableExists: true, schemaVerified: true,
      privilegesVerified: true, roleRestrictionsVerified: true })}\n`);
  } finally {
    await client.end().catch(() => {});
    await store.close();
  }
}

main().catch(() => {
  // Driver errors can contain a connection string; never print them here.
  console.error('Agent v2 Supabase preflight failed; inspect connection mode, schema and role grants.');
  process.exitCode = 1;
});
