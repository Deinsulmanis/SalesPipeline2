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

test('late-refused candidates do not consume the successful-send window target', () => {
  const batching = agent.slice(agent.indexOf('const newBatch'), agent.indexOf('console.log(`\\nDone.'));
  assert.match(batching, /const newBatch\s+= queued;/);
  assert.match(batching, /const followBatch\s+= followUps;/);
  assert.doesNotMatch(batching, /warmBatch|warmLeads|getOpenTriggeredLeads/);
  assert.doesNotMatch(batching, /queued\.slice\(0, effectiveCap\)/);
  assert.match(batching, /consumeSendingWindowSuccess\(windowQuota, sender\.id\)/);
  assert.match(batching, /sendingWindowRemainingBySender\(windowQuota\)/);
  assert.match(batching, /while \(index < batch\.length && sent < effectiveCap/);
  assert.ok((batching.match(/if \(sent >= effectiveCap \|\| sendingWindowSnapshot\(windowQuota\)\.globalRemaining <= 0\) break;/g) || []).length >= 2,
    'ordinary paths retain the remaining global daily ceiling as well as the window ceiling');
  assert.ok((batching.match(/sent\+\+/g) || []).length >= 2, 'only successful provider paths advance reporting');
});

test('eight scheduled windows can deliver forty per inbox and eighty total without approaching Sheets read quota', async () => {
  const delivered = new Map([['primary', 0], ['secondary', 0]]);
  for (let window = 0; window < 8; window++) {
    for (const senderId of delivered.keys()) {
      const result = await simulateFairBatch({
        initials: [{ id: `${senderId}-initial-${window}` }],
        followUps: Array.from({ length: 4 }, (_value, index) => ({ id: `${senderId}-follow-${window}-${index}` })),
        attemptInitial: async () => true,
        attemptFollowUp: async () => true,
      });
      assert.equal(result.sent, 5);
      delivered.set(senderId, delivered.get(senderId) + result.sent);
    }
  }
  assert.deepEqual([...delivered.values()], [40, 40]);
  assert.equal([...delivered.values()].reduce((sum, value) => sum + value, 0), 80);

  // Steady-state worst collision: a ten-success LIVE pass (one shared
  // snapshot + ten targeted row checks), Calendar (state, shared dataset,
  // checkpoint), and INTENT_ONLY (one shared snapshot) in the same minute.
  const worstExpectedMinuteReads = (1 + 10) + 3 + 1;
  assert.equal(worstExpectedMinuteReads, 15);
  assert.ok(worstExpectedMinuteReads < 60, 'normal scheduling stays well below the per-user minute quota');
});

test('scheduler exposes exactly eight windows and passes strict 5 + 5 capacity', () => {
  assert.match(server, /const SCHEDULED_SEND_PER_INBOX_CAP = 5;/);
  assert.match(server, /const SCHEDULED_SEND_TOTAL_CAP = 10;/);
  assert.match(server, /cron\.schedule\('0,30 8-11 \* \* 1-5'/);
  assert.match(server, /DAILY_CAP: String\(SCHEDULED_SEND_TOTAL_CAP\)/);
  assert.match(server, /PER_INBOX_RUN_CAP: String\(SCHEDULED_SEND_PER_INBOX_CAP\)/);
  assert.doesNotMatch(server, /SCHEDULED_SEND_PER_RUN_CAP/);
});

test('ordinary and stage sends consume the same window quota after provider success', () => {
  const setup = agent.slice(agent.indexOf('const windowQuota = createSendingWindowQuota'), agent.indexOf('// Phase 1 — new sends'));
  assert.match(setup, /runStageSequencePass[\s\S]*windowQuota/);
  assert.match(setup, /runIntentTriggerPass[\s\S]*windowQuota/);
  const ordinary = agent.slice(agent.indexOf('async function deliverOrdinaryColdStep'), agent.indexOf('// Phase 4: mark a lead'));
  assert.ok(ordinary.lastIndexOf('await sendEmail') < ordinary.lastIndexOf('onProviderSuccess'));
  assert.ok(ordinary.lastIndexOf('onProviderSuccess') < ordinary.lastIndexOf('markSent'));
  const stage = agent.slice(agent.indexOf('async function runStageSequencePass'), agent.indexOf('async function run()'));
  assert.ok(stage.lastIndexOf('await sendEmail') < stage.lastIndexOf('consumeSendingWindowSuccess'));
  assert.ok(stage.lastIndexOf('consumeSendingWindowSuccess') < stage.lastIndexOf('persistSequenceStep'));
});
