'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createPgSendQuotaStore } = require('../integrations/send-quota-store');

const url = process.env.SEND_LOCK_TEST_DATABASE_URL || '';
const suffix = crypto.randomUUID();
const dayKey = new Date(Date.UTC(2100, 0, 1) +
  (Number.parseInt(suffix.slice(0, 8), 16) % 100000) * 86400000).toISOString().slice(0, 10);
const senderA = `quota-test-a-${suffix}`;
const senderB = `quota-test-b-${suffix}`;
const plan = { globalDailyLimit: 1, globalRunLimit: 1,
  clientLimits: { scalelab: { daily: 1, perRun: 1 } },
  lanes: [senderA, senderB].map(senderId => ({ senderId, clientId: 'scalelab',
    budget: 1, dailyLimit: 1, runLimit: 1 })), totalPlanned: 2 };
const baselines = { global: 0, clients: new Map(), senders: new Map() };

test('Postgres quota transaction races two independent connections for one global slot',
  { skip: !url }, async () => {
    const first = createPgSendQuotaStore({ connectionString: url });
    const second = createPgSendQuotaStore({ connectionString: url });
    const runId = `quota-test-${suffix}`;
    try {
      await first.applyMigration();
      await first.beginRun({ runId, dayKey, plan, baselines });
      const outcomes = await Promise.allSettled([
        first.reserve({ actionId: `${runId}-a`, runId, dayKey, clientId: 'scalelab', senderId: senderA }),
        second.reserve({ actionId: `${runId}-b`, runId, dayKey, clientId: 'scalelab', senderId: senderB }),
      ]);
      assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
      assert.equal(outcomes.filter(item => item.status === 'rejected').length, 1);
      assert.equal(outcomes.find(item => item.status === 'rejected').reason.code, 'quota_exhausted');
      const winner = outcomes[0].status === 'fulfilled' ? `${runId}-a` : `${runId}-b`;
      await first.markSending(winner);
      await first.markAmbiguous(winner);
      await assert.rejects(first.reserve({ actionId: winner, runId, dayKey,
        clientId: 'scalelab', senderId: winner.endsWith('-a') ? senderA : senderB }),
      error => error.code === 'quota_action_held');
      await first.finishRun(runId);
    } finally { await Promise.all([first.close(), second.close()]); }
  });
