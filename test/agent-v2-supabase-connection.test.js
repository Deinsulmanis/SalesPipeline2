'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertSupabaseSessionConnectionString } = require('../integrations/agent-v2-store');

test('Agent v2 permits only a restricted Supabase session-pooler connection', () => {
  assert.deepEqual(assertSupabaseSessionConnectionString(
    'postgresql://agent_v2_shadow_worker.projectref:secret@aws-0-us-west-2.pooler.supabase.com:5432/postgres',
    'https://projectref.supabase.co'),
  { mode: 'session-pooler' });
  for (const url of [
    'postgresql://agent_v2_shadow_worker.projectref:secret@aws-0-us-west-2.pooler.supabase.com:6543/postgres',
    'postgresql://postgres.projectref:secret@aws-0-us-west-2.pooler.supabase.com:5432/postgres',
    'postgresql://agent_v2_shadow_worker:secret@db.projectref.supabase.co:5432/postgres',
    'postgresql://agent_v2_shadow_worker:secret@postgres.railway.internal:5432/railway',
    'https://projectref.supabase.co',
  ]) assert.throws(() => assertSupabaseSessionConnectionString(url, 'https://projectref.supabase.co'));
  assert.throws(() => assertSupabaseSessionConnectionString(
    'postgresql://agent_v2_shadow_worker.otherproject:secret@aws-0-us-west-2.pooler.supabase.com:5432/postgres',
    'https://projectref.supabase.co'));
});
