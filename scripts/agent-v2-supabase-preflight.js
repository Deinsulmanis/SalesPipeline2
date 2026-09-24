#!/usr/bin/env node
'use strict';

// Read-only Supabase connection/privilege audit plus transient session locks.
// Run --session-only after creating the restricted role, before the migration.
// Run without that flag after migration/grants, before any model invocation.
require('dotenv').config({ quiet: true });
const { Client } = require('pg');
const { agentV2SupabasePgConfig, createPgAgentV2Store } = require('../integrations/agent-v2-store');

async function verifyTls(client) {
  const result = await client.query('SELECT ssl AS active FROM pg_stat_ssl WHERE pid = pg_backend_pid()');
  if (result.rows.length !== 1 || result.rows[0].active !== true)
    throw new Error('Agent v2 Supabase connection is not using TLS');
  return true;
}

async function verifyElevatedRoleDenied(client) {
  let assumed = false;
  try {
    await client.query('SET ROLE service_role');
    assumed = true;
  } catch (error) {
    if (error?.code !== '42501') throw new Error('Agent v2 elevated SET ROLE denial could not be verified');
  } finally {
    if (assumed) await client.query('RESET ROLE').catch(() => {});
  }
  if (assumed) throw new Error('Agent v2 worker can assume service_role');
  const identity = (await client.query('SELECT current_user AS role, session_user AS login_role')).rows[0];
  if (identity?.role !== 'agent_v2_shadow_worker' || identity?.login_role !== identity.role)
    throw new Error('Agent v2 role identity changed after SET ROLE check');
  return true;
}

async function verifyNamedTableDenials(client) {
  for (const table of ['crm_events', 'outreach_leads', 'research_icp_runs']) {
    const result = await client.query(`SELECT to_regclass($1) IS NOT NULL AS present,
      COALESCE(has_table_privilege(current_user, to_regclass($1), 'SELECT'), false) AS can_select,
      COALESCE(has_table_privilege(current_user, to_regclass($1), 'INSERT'), false) AS can_insert,
      COALESCE(has_table_privilege(current_user, to_regclass($1), 'UPDATE'), false) AS can_update,
      COALESCE(has_table_privilege(current_user, to_regclass($1), 'DELETE'), false) AS can_delete,
      COALESCE(has_table_privilege(current_user, to_regclass($1), 'TRUNCATE'), false) AS can_truncate,
      COALESCE(has_table_privilege(current_user, to_regclass($1), 'REFERENCES'), false) AS can_reference,
      COALESCE(has_table_privilege(current_user, to_regclass($1), 'TRIGGER'), false) AS can_trigger`,
    [`public.${table}`]);
    const row = result.rows[0];
    if (!row?.present || Object.entries(row).some(([key, value]) => key !== 'present' && value !== false))
      throw new Error('Agent v2 worker has access to a protected application table');
  }
  return true;
}

let failureStage = 'connection-url';

async function main() {
  const sessionOnly = process.argv.length === 3 && process.argv[2] === '--session-only';
  if (!sessionOnly && process.argv.length !== 2) throw new Error('unexpected preflight option');
  const connectionString = process.env.AGENT_V2_SUPABASE_DATABASE_URL;
  const connectionConfig = agentV2SupabasePgConfig(connectionString,
    process.env.SUPABASE_URL, process.env.AGENT_V2_SUPABASE_CA_CERT);
  const mode = 'session-pooler';
  const store = createPgAgentV2Store({ connectionString, expectedSupabaseUrl: process.env.SUPABASE_URL,
    caCert: process.env.AGENT_V2_SUPABASE_CA_CERT });
  const client = new Client(connectionConfig);
  try {
    failureStage = 'role-restrictions';
    await store.verifyRoleRestrictions();
    failureStage = 'session-lock';
    const lock = await store.verifySessionLock();
    failureStage = 'client-connect';
    await client.connect();
    failureStage = 'tls';
    await verifyTls(client);
    failureStage = 'elevated-role';
    await verifyElevatedRoleDenied(client);
    failureStage = 'named-table-denials';
    await verifyNamedTableDenials(client);
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
    'Agent v2 Supabase CA certificate is required in PEM format',
    'Agent v2 Supabase CA certificate is malformed',
    'Agent v2 worker has access to a protected application table',
    'Agent v2 worker can assume service_role',
  ]);
  const detail = safeRoleErrors.has(error?.message) ? error.message
    : /^[A-Z0-9_]{2,32}$/.test(error?.code || '') ? `driver code ${error.code}`
      : /timeout/i.test(error?.message || '') ? 'connection timeout' : 'driver error';
  console.error(`Agent v2 Supabase preflight failed at ${failureStage}: ${detail}.`);
  process.exitCode = 1;
});

module.exports = { verifyTls };
