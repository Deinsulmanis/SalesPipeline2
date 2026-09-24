'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertSupabaseSessionConnectionString, createPgAgentV2Store } = require('../integrations/agent-v2-store');
const { optionsFrom } = require('../scripts/agent-v2-replay');
const { verifyTls } = require('../scripts/agent-v2-supabase-preflight');

const sessionUrl = 'postgresql://agent_v2_shadow_worker.projectref:secret@aws-0-us-west-2.pooler.supabase.com:5432/postgres?sslmode=require';

test('Agent v2 permits only a restricted Supabase session-pooler connection', () => {
  assert.deepEqual(assertSupabaseSessionConnectionString(
    sessionUrl,
    'https://projectref.supabase.co'),
  { mode: 'session-pooler' });
  assert.deepEqual(assertSupabaseSessionConnectionString(
    sessionUrl.replace('sslmode=require', 'sslmode=verify-full'), 'https://projectref.supabase.co'),
  { mode: 'session-pooler' });
  for (const url of [
    sessionUrl.replace(':5432/', ':6543/'),
    sessionUrl.replace('agent_v2_shadow_worker.projectref', 'postgres.projectref'),
    sessionUrl.replace('aws-0-us-west-2.pooler.supabase.com', 'db.projectref.supabase.co'),
    sessionUrl.replace('aws-0-us-west-2.pooler.supabase.com', 'postgres.railway.internal'),
    sessionUrl.replace('/postgres?', '/other?'),
    sessionUrl.replace('?sslmode=require', ''),
    sessionUrl.replace('sslmode=require', 'sslmode=disable'),
    `${sessionUrl}&sslmode=disable`,
    `${sessionUrl}&host=postgres.railway.internal`,
    `${sessionUrl}&port=6543`,
    `${sessionUrl}&user=postgres.projectref`,
    `${sessionUrl}&uselibpqcompat=true`,
    'https://projectref.supabase.co',
  ]) assert.throws(() => assertSupabaseSessionConnectionString(url, 'https://projectref.supabase.co'));
  assert.throws(() => assertSupabaseSessionConnectionString(
    sessionUrl.replace('agent_v2_shadow_worker.projectref', 'agent_v2_shadow_worker.otherproject'),
    'https://projectref.supabase.co'));
});

test('dormant Agent v2 needs no database credential; persistence fails closed without it', () => {
  const names = ['AGENT_V2_SHADOW_ENABLED', 'AGENT_V2_SUPABASE_DATABASE_URL',
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
    process.env.SUPABASE_URL = 'https://projectref.supabase.co';
    assert.throws(() => optionsFrom(persist), /sslmode/);
  } finally {
    for (const name of names) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
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
