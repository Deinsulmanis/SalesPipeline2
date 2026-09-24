'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tls = require('node:tls');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { assertSupabaseSessionConnectionString, agentV2SupabasePgConfig,
  createPgAgentV2Store } = require('../integrations/agent-v2-store');
const { optionsFrom } = require('../scripts/agent-v2-replay');
const { verifyTls } = require('../scripts/agent-v2-supabase-preflight');

const projectUrl = 'https://lasyefxhuwysjebasdbf.supabase.co';
const sessionUrl = 'postgresql://agent_v2_shadow_worker.lasyefxhuwysjebasdbf:test-secret@aws-0-us-west-2.pooler.supabase.com:5432/postgres?sslmode=require';

test('Agent v2 permits only a restricted Supabase session-pooler connection', () => {
  assert.deepEqual(assertSupabaseSessionConnectionString(
    sessionUrl,
    projectUrl),
  { mode: 'session-pooler' });
  assert.deepEqual(assertSupabaseSessionConnectionString(
    sessionUrl.replace('sslmode=require', 'sslmode=verify-full'), projectUrl),
  { mode: 'session-pooler' });
  for (const url of [
    sessionUrl.replace(':5432/', ':6543/'),
    sessionUrl.replace('agent_v2_shadow_worker.lasyefxhuwysjebasdbf', 'postgres.lasyefxhuwysjebasdbf'),
    sessionUrl.replace('aws-0-us-west-2.pooler.supabase.com', 'db.lasyefxhuwysjebasdbf.supabase.co'),
    sessionUrl.replace('aws-0-us-west-2.pooler.supabase.com', 'postgres.railway.internal'),
    sessionUrl.replace('/postgres?', '/other?'),
    sessionUrl.replace('?sslmode=require', ''),
    sessionUrl.replace('sslmode=require', 'sslmode=disable'),
    sessionUrl.replace('sslmode=require', 'sslmode=no-verify'),
    `${sessionUrl}&sslmode=disable`,
    `${sessionUrl}&host=postgres.railway.internal`,
    `${sessionUrl}&port=6543`,
    `${sessionUrl}&user=postgres.lasyefxhuwysjebasdbf`,
    `${sessionUrl}&uselibpqcompat=true`,
    projectUrl,
  ]) assert.throws(() => assertSupabaseSessionConnectionString(url, projectUrl));
  assert.throws(() => assertSupabaseSessionConnectionString(
    sessionUrl.replace('agent_v2_shadow_worker.lasyefxhuwysjebasdbf', 'agent_v2_shadow_worker.otherproject'),
    projectUrl));
  assert.throws(() => assertSupabaseSessionConnectionString(sessionUrl,
    'https://otherproject.supabase.co'));
});

test('dormant Agent v2 needs no database credential; persistence fails closed without it', () => {
  const names = ['AGENT_V2_SHADOW_ENABLED', 'AGENT_V2_SUPABASE_DATABASE_URL',
    'AGENT_V2_SUPABASE_CA_CERT',
    'ANTHROPIC_AGENT_V2_KEY', 'SUPABASE_URL'];
  const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    assert.ok(optionsFrom(['--snapshot=fixture.json', '--now=2026-09-23T00:00:00Z']).snapshot);
    const persist = ['--live', '--model', '--persist', '--lead=L1', '--message=M1'];
    assert.throws(() => optionsFrom(persist), /AGENT_V2_SHADOW_ENABLED=true/);
    process.env.AGENT_V2_SHADOW_ENABLED = 'true';
    assert.throws(() => optionsFrom(persist), /database URL required/);
    process.env.ANTHROPIC_AGENT_V2_KEY = 'test-only';
    process.env.AGENT_V2_SUPABASE_DATABASE_URL = sessionUrl.replace('?sslmode=require', '');
    process.env.SUPABASE_URL = projectUrl;
    assert.throws(() => optionsFrom(persist), /sslmode/);
  } finally {
    for (const name of names) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  }
});

test('Agent v2 builds explicit verified-TLS pg options from the validated URI and CA', () => {
  const ca = tls.rootCertificates[0];
  const config = agentV2SupabasePgConfig(sessionUrl, projectUrl, ca);
  assert.equal(Object.hasOwn(config, 'connectionString'), false);
  assert.equal(config.host, 'aws-0-us-west-2.pooler.supabase.com');
  assert.equal(config.port, 5432);
  assert.equal(config.database, 'postgres');
  assert.equal(config.user, 'agent_v2_shadow_worker.lasyefxhuwysjebasdbf');
  assert.equal(config.ssl.rejectUnauthorized, true);
  assert.equal(config.ssl.servername, config.host);
  assert.ok(config.ssl.ca.startsWith('-----BEGIN CERTIFICATE-----'));
  assert.throws(() => agentV2SupabasePgConfig(sessionUrl, projectUrl, ''), /CA certificate/);
  assert.throws(() => agentV2SupabasePgConfig(sessionUrl, projectUrl, 'invalid-ca-marker'), /CA certificate/);
  assert.throws(() => createPgAgentV2Store({ connectionString: sessionUrl,
    expectedSupabaseUrl: projectUrl, caCert: '' }), /CA certificate/);
  for (const url of [sessionUrl.replace('sslmode=require', 'sslmode=no-verify'),
    `${sessionUrl}&uselibpqcompat=true`, `${sessionUrl}&ssl=false`]) {
    assert.throws(() => agentV2SupabasePgConfig(url, projectUrl, ca));
  }
});

test('preflight diagnostics never print a password, URI, or CA contents', () => {
  const env = { ...process.env, AGENT_V2_SUPABASE_DATABASE_URL: sessionUrl,
    SUPABASE_URL: projectUrl, AGENT_V2_SUPABASE_CA_CERT: 'invalid-ca-marker',
    AGENT_V2_SHADOW_ENABLED: 'true', ANTHROPIC_AGENT_V2_KEY: 'test-model-key' };
  for (const args of [
    ['agent-v2-supabase-preflight.js', '--session-only'],
    ['agent-v2-replay.js', '--live', '--model', '--persist', '--lead=L1', '--message=M1'],
  ]) {
    const result = spawnSync(process.execPath,
      [path.join(__dirname, '..', 'scripts', args[0]), ...args.slice(1)],
      { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1);
    const output = `${result.stdout}${result.stderr}`;
    for (const secret of ['test-secret', sessionUrl, 'invalid-ca-marker', 'test-model-key'])
      assert.equal(output.includes(secret), false);
  }
});

test('session preflight proves lock exclusion and reacquisition after release', async () => {
  const steps = [];
  let owner = null;
  const clients = [101, 202].map(pid => ({
    async query(sql) {
      if (sql.includes('pg_try_advisory_lock')) {
        const acquired = owner === null || owner === pid;
        if (acquired) owner = pid;
        steps.push(`${pid}:lock:${acquired}`);
        return { rows: [{ pid, role: 'agent_v2_shadow_worker',
          login_role: 'agent_v2_shadow_worker', acquired }] };
      }
      if (sql.includes('pg_advisory_unlock')) {
        const released = owner === pid;
        if (released) owner = null;
        steps.push(`${pid}:unlock:${released}`);
        return { rows: [{ pid, released }] };
      }
      return { rows: [{ pid, role: 'agent_v2_shadow_worker',
        login_role: 'agent_v2_shadow_worker' }] };
    },
    release() { steps.push(`${pid}:release`); },
  }));
  const pool = { async connect() { return clients.shift(); } };
  const result = await createPgAgentV2Store({ pool }).verifySessionLock();
  assert.equal(result.backendPidStable, true);
  assert.equal(result.firstLockAcquired, true);
  assert.equal(result.competingLockBlocked, true);
  assert.equal(result.reacquiredAfterRelease, true);
  assert.deepEqual(steps, ['101:lock:true', '202:lock:false', '101:unlock:true',
    '202:lock:true', '202:unlock:true', '202:release', '101:release']);
});

test('session preflight fails closed when PostgreSQL reports no TLS', async () => {
  assert.equal(await verifyTls({ query: async () => ({ rows: [{ active: true }] }) }), true);
  for (const rows of [[], [{ active: false }]]) {
    await assert.rejects(verifyTls({ query: async () => ({ rows }) }), /not using TLS/);
  }
});
