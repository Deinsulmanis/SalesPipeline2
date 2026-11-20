'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertSendQuotaIdle } = require('../integrations/send-quota-inspection');
const idle = extra => ({ readOnly: true, activeRuns: [], laneOwners: [], unresolved: [], ...extra });
test('between-run refill refuses live or unreadable quota state', () => {
  for (const state of [null, {}, idle({ activeRuns: [{}] }), idle({ laneOwners: [{}] }),
    idle({ unresolved: [{ status: 'reserved' }] }), idle({ unresolved: [{ status: 'sending' }] }),
    idle({ unresolved: [{ status: 'unknown' }] })]) {
    assert.throws(() => assertSendQuotaIdle(state));
  }
  assert.doesNotThrow(() => assertSendQuotaIdle(idle()));
  assert.doesNotThrow(() => assertSendQuotaIdle(idle({ unresolved: [{ status: 'ambiguous' }] })),
    'an old ambiguous action stays reserved and is independently excluded by lead id');
});
