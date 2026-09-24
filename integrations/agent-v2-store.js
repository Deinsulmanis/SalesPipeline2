'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');

const PROJECT_REF = 'lasyefxhuwysjebasdbf';

const MIGRATION = path.join(__dirname, '..', 'supabase', 'migrations',
  '20260923000000_agent_v2_shadow_decisions.sql');

// Session advisory locks cannot survive Supavisor transaction pooling. Require
// Supabase's session-mode endpoint on port 5432. This also
// prevents the old Railway send-lock URL or the PostgREST service key from
// accidentally becoming the worker's connection.
function assertSupabaseSessionConnectionString(connectionString, expectedSupabaseUrl) {
  let url;
  try { url = new URL(connectionString); } catch { throw new Error('invalid Agent v2 Supabase Postgres URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw new Error('Agent v2 requires a PostgreSQL connection URL');
  const host = url.hostname.toLowerCase();
  const sessionPooler = /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(host);
  if (!sessionPooler)
    throw new Error('Agent v2 requires a Supabase session-pooler host');
  if (url.port !== '5432')
    throw new Error('Agent v2 requires Supabase port 5432; transaction pooling is unsafe for session locks');
  if (url.pathname !== '/postgres')
    throw new Error('Agent v2 requires the Supabase postgres database');
  const parameters = [...url.searchParams];
  if (parameters.length !== 1 || parameters[0][0] !== 'sslmode'
    || !['require', 'verify-full'].includes(parameters[0][1]))
    throw new Error('Agent v2 requires only sslmode=require or sslmode=verify-full in the database URL');
  const user = decodeURIComponent(url.username);
  if (!/^agent_v2_shadow_worker\.[a-z0-9-]+$/.test(user))
    throw new Error('Agent v2 requires the dedicated shadow worker database role');
  if (!url.password) throw new Error('Agent v2 shadow worker database password is required');
  let expectedHost;
  try { expectedHost = new URL(expectedSupabaseUrl).hostname.toLowerCase(); }
  catch { throw new Error('SUPABASE_URL is required to verify the Agent v2 project'); }
  const project = /^([a-z0-9-]+)\.supabase\.co$/.exec(expectedHost)?.[1];
  if (project !== PROJECT_REF || user !== `agent_v2_shadow_worker.${PROJECT_REF}`)
    throw new Error('Agent v2 database role does not match the configured Supabase project');
  return { mode: 'session-pooler' };
}

function agentV2SupabasePgConfig(connectionString, expectedSupabaseUrl, caCert) {
  assertSupabaseSessionConnectionString(connectionString, expectedSupabaseUrl);
  const ca = String(caCert || '').trim().replace(/\\n/g, '\n');
  if (!ca || !/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----$/.test(ca))
    throw new Error('Agent v2 Supabase CA certificate is required in PEM format');
  try { tls.createSecureContext({ ca }); }
  catch { throw new Error('Agent v2 Supabase CA certificate is malformed'); }
  const url = new URL(connectionString);
  let user;
  let password;
  try {
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch { throw new Error('invalid Agent v2 Supabase Postgres credentials'); }
  return {
    host: url.hostname.toLowerCase(), port: 5432, database: 'postgres', user, password,
    ssl: { ca, rejectUnauthorized: true, servername: url.hostname.toLowerCase() },
  };
}

function decisionIdFor(leadId, messageId) {
  const lead = String(leadId || '').trim();
  const message = String(messageId || '').trim();
  if (!lead || !message) throw new Error('leadId and messageId required for shadow decision id');
  const digest = crypto.createHash('sha256').update(`${lead}\0${message}`).digest('hex');
  return `agent-v2:${digest}`;
}

// A session lock stays held while the model runs. A crashed process loses the
// lock immediately, so the next worker can take over its durable claim.
function lockKeyFor(decisionId) {
  const hex = crypto.createHash('sha256').update(decisionId).digest('hex').slice(0, 16);
  return BigInt.asIntN(64, BigInt(`0x${hex}`)).toString();
}

function createPgAgentV2Store({ connectionString, expectedSupabaseUrl, caCert, pool: existingPool } = {}) {
  if (!connectionString && !existingPool) throw new Error('shadow database connection required');
  const connectionConfig = existingPool ? null
    : agentV2SupabasePgConfig(connectionString, expectedSupabaseUrl, caCert);
  const Pool = existingPool ? null : require('pg').Pool;
  const pool = existingPool || new Pool({ ...connectionConfig, max: 2,
    idleTimeoutMillis: 10000, connectionTimeoutMillis: 4000 });
  let schemaReady = null;
  async function verifySessionLock() {
    const first = await pool.connect();
    let second;
    const key = lockKeyFor(`session-check:${crypto.randomUUID()}`);
    let firstLocked = false;
    let secondLocked = false;
    try {
      second = await pool.connect();
      const before = await first.query(`SELECT pg_backend_pid() AS pid, current_user AS role,
        session_user AS login_role, pg_try_advisory_lock($1::bigint) AS acquired`, [key]);
      firstLocked = before.rows[0]?.acquired === true;
      if (!firstLocked) throw new Error('Agent v2 session lock could not be acquired');
      const expected = before.rows[0];
      if (expected.role !== 'agent_v2_shadow_worker' || expected.login_role !== expected.role)
        throw new Error('Agent v2 advisory lock session has the wrong database identity');
      async function assertFirstSession() {
        const actual = (await first.query('SELECT pg_backend_pid() AS pid, current_user AS role, session_user AS login_role')).rows[0];
        if (actual.pid !== expected.pid || actual.role !== expected.role || actual.login_role !== expected.login_role)
          throw new Error('Agent v2 database session identity changed while the advisory lock was held');
      }
      await assertFirstSession();
      const competing = await second.query(`SELECT pg_backend_pid() AS pid, current_user AS role,
        session_user AS login_role, pg_try_advisory_lock($1::bigint) AS acquired`, [key]);
      secondLocked = competing.rows[0]?.acquired === true;
      if (competing.rows[0]?.pid === expected.pid || competing.rows[0]?.role !== expected.role
        || competing.rows[0]?.login_role !== expected.login_role)
        throw new Error('Agent v2 competing lock session has the wrong database identity');
      if (secondLocked) throw new Error('Agent v2 advisory lock was not exclusive across sessions');
      await assertFirstSession();
      const released = await first.query(`SELECT pg_backend_pid() AS pid,
        pg_advisory_unlock($1::bigint) AS released`, [key]);
      if (released.rows[0]?.pid !== expected.pid || released.rows[0]?.released !== true)
        throw new Error('Agent v2 first session did not release its advisory lock');
      firstLocked = false;
      const reacquired = await second.query(`SELECT pg_backend_pid() AS pid, current_user AS role,
        session_user AS login_role, pg_try_advisory_lock($1::bigint) AS acquired`, [key]);
      secondLocked = reacquired.rows[0]?.acquired === true;
      if (!secondLocked || reacquired.rows[0]?.pid !== competing.rows[0].pid
        || reacquired.rows[0]?.role !== expected.role
        || reacquired.rows[0]?.login_role !== expected.login_role)
        throw new Error('Agent v2 competing session could not reacquire the released advisory lock');
      return { ok: true, backendPid: expected.pid, backendPidStable: true,
        firstLockAcquired: true, competingLockBlocked: true, reacquiredAfterRelease: true };
    } finally {
      if (secondLocked) await second.query('SELECT pg_advisory_unlock($1::bigint)', [key]).catch(() => {});
      if (firstLocked) await first.query('SELECT pg_advisory_unlock($1::bigint)', [key]).catch(() => {});
      second?.release();
      first.release();
    }
  }
  async function applyMigration() {
    await pool.query(fs.readFileSync(MIGRATION, 'utf8'));
    schemaReady = null;
  }
  async function ensureSchema() {
    if (!schemaReady) schemaReady = pool.query(`SELECT decision_id, lead_id, message_id,
      claimed_at, claim_token, claim_attempts, model_started_at,
      completed_at, created_at, action_id, record
      FROM public.agent_v2_shadow_decisions LIMIT 0`)
      .catch(error => { schemaReady = null; throw error; });
    await schemaReady;
  }
  async function verifyRoleRestrictions() {
    const result = await pool.query(`SELECT current_user AS role, session_user AS login_role,
      r.rolcanlogin AS can_login, r.rolinherit AS inherits,
      r.rolcreatedb AS can_create_db, r.rolcreaterole AS can_create_role,
      r.rolreplication AS can_replicate, r.rolbypassrls AS bypasses_rls,
      r.rolsuper AS is_superuser,
      EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid) AS has_memberships,
      EXISTS (SELECT 1 FROM pg_roles elevated
        WHERE elevated.rolname IN ('service_role', 'authenticated', 'anon',
          'authenticator', 'postgres', 'supabase_admin', 'pg_database_owner',
          'supabase_auth_admin', 'supabase_storage_admin', 'pg_monitor',
          'pg_read_all_data', 'pg_write_all_data')
          AND pg_has_role(r.oid, elevated.oid, 'MEMBER')) AS can_assume_elevated,
      has_schema_privilege(current_user, 'public', 'USAGE') AS schema_usage,
      has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create
      FROM pg_roles r WHERE r.rolname = current_user`);
    const role = result.rows[0];
    if (!role || role.role !== 'agent_v2_shadow_worker' || role.login_role !== role.role
      || !role.can_login || role.inherits || role.can_create_db || role.can_create_role
      || role.can_replicate || role.bypasses_rls || role.is_superuser
      || role.has_memberships || role.can_assume_elevated
      || !role.schema_usage || role.schema_create)
      throw new Error('Agent v2 shadow role attributes or memberships are not restricted as required');
    const creatableSchemas = await pool.query(`SELECT nspname FROM pg_namespace
      WHERE nspname NOT IN ('pg_catalog', 'information_schema')
        AND nspname NOT LIKE 'pg_toast%'
        AND nspname NOT LIKE 'pg_temp_%'
        AND has_schema_privilege(current_user, oid, 'CREATE')`);
    if (creatableSchemas.rows.length) throw new Error('Agent v2 shadow role can create in a schema');
    const unrelated = await pool.query(`SELECT schemaname, tablename FROM pg_tables
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
        AND (schemaname, tablename) <> ('public', 'agent_v2_shadow_decisions')
        AND (has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'SELECT')
          OR has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'INSERT')
          OR has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'UPDATE')
          OR has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'DELETE')
          OR has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'TRUNCATE')
          OR has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'REFERENCES')
          OR has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'TRIGGER'))`);
    if (unrelated.rows.length) throw new Error('Agent v2 shadow role can access unrelated tables');
    return { ok: true };
  }
  async function verifyPrivileges() {
    await verifyRoleRestrictions();
    const result = await pool.query(`SELECT current_user AS role,
      has_table_privilege(current_user, 'public.agent_v2_shadow_decisions', 'SELECT') AS can_read,
      has_table_privilege(current_user, 'public.agent_v2_shadow_decisions', 'INSERT') AS can_insert,
      has_table_privilege(current_user, 'public.agent_v2_shadow_decisions', 'UPDATE') AS can_update,
      has_table_privilege(current_user, 'public.agent_v2_shadow_decisions', 'DELETE') AS can_delete,
      has_table_privilege(current_user, 'public.agent_v2_shadow_decisions', 'TRUNCATE') AS can_truncate,
      has_table_privilege(current_user, 'public.agent_v2_shadow_decisions', 'REFERENCES') AS can_reference,
      has_table_privilege(current_user, 'public.agent_v2_shadow_decisions', 'TRIGGER') AS can_trigger,
      (SELECT relrowsecurity FROM pg_class
        WHERE oid = 'public.agent_v2_shadow_decisions'::regclass) AS rls_enabled`);
    const role = result.rows[0];
    if (role.role !== 'agent_v2_shadow_worker' || !role.can_read || !role.can_insert
      || !role.can_update || role.can_delete || role.can_truncate || role.can_reference
      || role.can_trigger || !role.rls_enabled)
      throw new Error('Agent v2 shadow role privileges are not restricted as required');
    return { ok: true };
  }
  async function get(decisionId) {
    await ensureSchema();
    const rows = await pool.query('SELECT record FROM public.agent_v2_shadow_decisions WHERE decision_id = $1', [decisionId]);
    return rows.rows[0]?.record || null;
  }
  async function claim({ decisionId, leadId, messageId }) {
    await ensureSchema();
    const client = await pool.connect();
    const lockKey = lockKeyFor(decisionId);
    let locked = false;
    let backendPid = null;
    let released = false;
    const controller = new AbortController();
    const lost = () => controller.abort();
    client.on?.('error', lost);
    client.on?.('end', lost);
    async function assertClaimSession() {
      const session = await client.query('SELECT pg_backend_pid() AS pid');
      if (session.rows[0]?.pid !== backendPid)
        throw new Error('Agent v2 database session changed while claim was held');
    }
    async function release() {
      if (released) return;
      released = true;
      client.off?.('error', lost);
      client.off?.('end', lost);
      try {
        if (locked) {
          const unlocked = await client.query(`SELECT pg_backend_pid() AS pid,
            pg_advisory_unlock($1::bigint) AS released`, [lockKey]);
          if (unlocked.rows[0]?.pid !== backendPid || unlocked.rows[0]?.released !== true)
            throw new Error('Agent v2 advisory lock was lost before release');
        }
        client.release();
      } catch (error) {
        client.release(true);
        throw error;
      }
    }
    try {
      const lock = await client.query(`SELECT pg_backend_pid() AS pid,
        pg_try_advisory_lock($1::bigint) AS acquired`, [lockKey]);
      if (!lock.rows[0]?.acquired) {
        await release();
        return { status: 'busy' };
      }
      locked = true;
      backendPid = lock.rows[0].pid;
      await assertClaimSession();
      const token = crypto.randomUUID();
      const result = await client.query(`INSERT INTO public.agent_v2_shadow_decisions
        (decision_id, lead_id, message_id, claimed_at, claim_token, claim_attempts)
        VALUES ($1, $2, $3, now(), $4, 1)
        ON CONFLICT (decision_id) DO UPDATE SET
          claimed_at = excluded.claimed_at,
          claim_token = excluded.claim_token,
          claim_attempts = agent_v2_shadow_decisions.claim_attempts + 1
        WHERE agent_v2_shadow_decisions.record IS NULL
        RETURNING decision_id, lead_id, message_id, model_started_at, record`,
      [decisionId, leadId, messageId, token]);
      if (!result.rows.length) {
        const prior = await client.query(`SELECT decision_id, lead_id, message_id, record
          FROM public.agent_v2_shadow_decisions WHERE decision_id = $1`, [decisionId]);
        const row = prior.rows[0];
        if (!row || row.lead_id !== leadId || row.message_id !== messageId || !row.record)
          throw new Error('shadow decision identity conflict');
        await release();
        return { status: 'complete', record: row.record };
      }
      const row = result.rows[0];
      if (row.lead_id !== leadId || row.message_id !== messageId)
        throw new Error('shadow decision identity conflict');
      return {
        status: 'claimed', backendPid, signal: controller.signal, release,
        priorModelAttempt: Boolean(row.model_started_at),
        async markModelStarted() {
          if (released || controller.signal.aborted) throw new Error('shadow claim lost');
          await assertClaimSession();
          const marked = await client.query(`UPDATE public.agent_v2_shadow_decisions
            SET model_started_at = now()
            WHERE decision_id = $1 AND claim_token = $2
              AND record IS NULL AND model_started_at IS NULL
            RETURNING model_started_at`, [decisionId, token]);
          if (marked.rows.length !== 1) throw new Error('shadow model attempt not confirmed');
        },
        async complete(record) {
          if (released || controller.signal.aborted) throw new Error('shadow claim lost');
          await assertClaimSession();
          const saved = await client.query(`UPDATE public.agent_v2_shadow_decisions
            SET record = $3::jsonb, action_id = $4, created_at = $5,
                completed_at = now()
            WHERE decision_id = $1 AND claim_token = $2 AND record IS NULL
            RETURNING record`,
          [decisionId, token, JSON.stringify(record), record.decision.actionId, record.createdAt]);
          if (saved.rows.length !== 1) throw new Error('shadow claim completion not confirmed');
          return saved.rows[0].record;
        },
      };
    } catch (error) {
      await release();
      throw error;
    }
  }
  return { applyMigration, ensureSchema, verifySessionLock, verifyRoleRestrictions, verifyPrivileges, get, claim,
    close: () => existingPool ? Promise.resolve() : pool.end() };
}

module.exports = { decisionIdFor, lockKeyFor, assertSupabaseSessionConnectionString,
  agentV2SupabasePgConfig, createPgAgentV2Store };
