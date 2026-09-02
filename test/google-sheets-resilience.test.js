'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isReadQuotaError, retrySheetsRead, wrapSheetsReadClient,
} = require('../integrations/google-sheets-resilience');

test('recognizes Google per-user read quota errors', () => {
  assert.equal(isReadQuotaError({ response: { status: 429 } }), true);
  assert.equal(isReadQuotaError({ message: 'Quota exceeded for quota metric Read requests per minute per user' }), true);
  assert.equal(isReadQuotaError({ response: { status: 500 }, message: 'backend error' }), false);
});

test('read retry is bounded and waits across the quota window', async () => {
  const waits = [];
  let calls = 0;
  const result = await retrySheetsRead(async () => {
    calls += 1;
    if (calls < 4) throw Object.assign(new Error('read quota'), { code: 429 });
    return 'ok';
  }, { delaysMs: [5000, 15000, 40000], sleep: async ms => waits.push(ms), logger: { warn() {} } });
  assert.equal(result, 'ok');
  assert.equal(calls, 4);
  assert.deepEqual(waits, [5000, 15000, 40000]);
});

test('only read methods are retried by the client wrapper', async () => {
  let reads = 0;
  let appends = 0;
  const client = { spreadsheets: { values: {
    get: async () => { reads += 1; if (reads === 1) throw Object.assign(new Error('quota'), { code: 429 }); return { data: {} }; },
    batchGet: async () => ({ data: {} }),
    append: async () => { appends += 1; throw Object.assign(new Error('quota'), { code: 429 }); },
  }, get: async () => ({ data: {} }) } };
  wrapSheetsReadClient(client, { delaysMs: [1], sleep: async () => {}, logger: { warn() {} } });
  await client.spreadsheets.values.get({});
  assert.equal(reads, 2);
  await assert.rejects(() => client.spreadsheets.values.append({}));
  assert.equal(appends, 1, 'non-idempotent append must never be retried automatically');
});
