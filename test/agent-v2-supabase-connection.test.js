'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertSupabaseSessionConnectionString } = require('../integrations/agent-v2-store');
const { optionsFrom } = require('../scripts/agent-v2-replay');

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
