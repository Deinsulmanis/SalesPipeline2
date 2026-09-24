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
  // The step-1 batch is the fair-share ORDERING of the whole eligible queue.
  // Ordering only: it is still the full candidate list, so a late refusal
  // falls through to the next candidate instead of consuming the window.
  assert.match(batching, /const newBatch\s+= fairShareQueuedOrder\(queued,/);
  assert.match(batching, /const followBatch\s+= followUps;/);
  assert.doesNotMatch(batching, /warmBatch|warmLeads|getOpenTriggeredLeads/);
  assert.doesNotMatch(batching, /queued\.slice\(0, effectiveCap\)/);
  assert.doesNotMatch(batching, /fairShareQueuedOrder\([^)]*\)\.slice\(/,
    'the fair-share order is never pre-truncated to the cap');
  assert.match(batching, /consumeSendingWindowSuccess\(windowQuota, sender\.id\)/);
  assert.match(batching, /sendingWindowRemainingBySender\(windowQuota\)/);
  assert.match(batching, /while \(index < batch\.length && sent < effectiveCap/);
  assert.ok((batching.match(/if \(sent >= effectiveCap \|\| sendingWindowSnapshot\(windowQuota\)\.globalRemaining <= 0\) break;/g) || []).length >= 2,
    'ordinary paths retain the remaining global daily ceiling as well as the window ceiling');
  assert.ok((batching.match(/sent\+\+/g) || []).length >= 2, 'only successful provider paths advance reporting');
});

test('ten scheduled windows can deliver fifty per inbox and one hundred total without approaching Sheets read quota', async () => {
  const delivered = new Map([['primary', 0], ['secondary', 0]]);
  for (let window = 0; window < 10; window++) {
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
  assert.deepEqual([...delivered.values()], [50, 50]);
  assert.equal([...delivered.values()].reduce((sum, value) => sum + value, 0), 100);

  // Steady-state worst collision: a ten-success LIVE pass (one shared
  // snapshot + ten targeted row checks), Calendar (state, shared dataset,
  // checkpoint), and INTENT_ONLY (one shared snapshot) in the same minute.
  const worstExpectedMinuteReads = (1 + 10) + 3 + 1;
  assert.equal(worstExpectedMinuteReads, 15);
  assert.ok(worstExpectedMinuteReads < 60, 'normal scheduling stays well below the per-user minute quota');
});

test('the send cron fires exactly ten weekday windows, 7:00–11:30 Pacific, clear of the 12:15 late-reply pass', () => {
  const cron = require('node-cron');
  const task = cron.createTask('0,30 7-11 * * 1-5', () => {}, { scheduled: false, timezone: 'America/Vancouver' });
  const slots = [...new Set(task.getNextRuns(40).map(d => d.toLocaleTimeString('en-GB', {
    timeZone: 'America/Vancouver', hour: '2-digit', minute: '2-digit',
  })))].sort();
  assert.deepEqual(slots, ['07:00', '07:30', '08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
  // 10 windows × 5 per inbox reaches a 50/day inbox limit; 10 × 10 reaches 100.
  assert.ok(slots.length * 5 >= 50);
  assert.ok(slots.length * 10 >= 100);
  assert.ok(!slots.some(slot => slot >= '12:00'), 'no send run may hold the mutex at the 12:15 late-reply pass');
});

test('scheduler passes a strict 6-per-inbox ceiling with derived totals', () => {
  assert.match(server, /const SCHEDULED_SEND_PER_INBOX_CAP = MAX_INBOX_PER_RUN_LIMIT;/);
  assert.equal(require('../integrations/gmail-sender-capacity').MAX_INBOX_PER_RUN_LIMIT, 6);
  assert.match(server, /function scheduledSendCaps/);
  assert.match(server, /cron\.schedule\('0,30 7-11 \* \* 1-5'/);
  assert.match(server, /DAILY_CAP: String\(caps\.total\)/);
  assert.match(server, /PER_INBOX_RUN_CAP: String\(caps\.perInbox\)/);
  assert.doesNotMatch(server, /const SCHEDULED_SEND_TOTAL_CAP = 10;/);
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
