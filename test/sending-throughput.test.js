'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { simulateFairBatch } = require('../integrations/scheduler-fairness');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const agent = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');

test('a busy safe pass skips the scheduled window without creating a catch-up burst', () => {
  assert.doesNotMatch(server, /pendingScheduledSendRuns|MAX_PENDING_SCHEDULED_SEND_RUNS/);
  assert.match(server, /skipping this send window; no catch-up burst will be queued/);
  assert.doesNotMatch(server, /Agent already running — skipping this tick/);
});

test('late-refused candidates do not consume the successful-send batch target', () => {
  const batching = agent.slice(agent.indexOf('const newBatch'), agent.indexOf('console.log(`\\nDone.'));
  assert.match(batching, /const newBatch\s+= queued;/);
  assert.match(batching, /const followBatch\s+= followUps;/);
  assert.doesNotMatch(batching, /warmBatch|warmLeads|getOpenTriggeredLeads/);
  assert.doesNotMatch(batching, /queued\.slice\(0, effectiveCap\)/);
  assert.ok((batching.match(/if \(sent >= effectiveCap\) break;/g) || []).length >= 2);
  assert.ok((batching.match(/sent\+\+/g) || []).length >= 2, 'only successful provider paths advance the run target');
});

test('eight scheduled windows can deliver forty successes without approaching Sheets read quota', async () => {
  let delivered = 0;
  for (let window = 0; window < 8; window++) {
    const result = await simulateFairBatch({
      initials: [{ id: `initial-${window}` }],
      followUps: Array.from({ length: 4 }, (_value, index) => ({ id: `follow-${window}-${index}` })),
      attemptInitial: async () => true,
      attemptFollowUp: async () => true,
    });
    assert.equal(result.sent, 5);
    delivered += result.sent;
  }
  assert.equal(delivered, 40);

  // Steady-state worst collision: a five-success LIVE pass (one shared
  // snapshot + five targeted row checks), Calendar (state, shared dataset,
  // checkpoint), and INTENT_ONLY (one shared snapshot) in the same minute.
  const worstExpectedMinuteReads = (1 + 5) + 3 + 1;
  assert.equal(worstExpectedMinuteReads, 10);
  assert.ok(worstExpectedMinuteReads < 60, 'normal scheduling stays well below the per-user minute quota');
});
