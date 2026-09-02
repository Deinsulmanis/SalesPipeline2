'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { oldestDueFirst, followUpSuccessTarget, simulateFairBatch } = require('../integrations/scheduler-fairness');

const ok = async () => true;
const leads = (prefix, count) => Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i + 1}` }));

test('five eligible initials cannot starve overdue follow-ups', async () => {
  const result = await simulateFairBatch({ initials: leads('i', 5), followUps: leads('f', 5), attemptInitial: ok, attemptFollowUp: ok });
  assert.deepEqual(result.events.map(x => x[0]), ['follow-up', 'follow-up', 'follow-up', 'follow-up', 'initial']);
});

test('100 initials and 100 overdue follow-ups gives follow-ups immediate capacity', async () => {
  const result = await simulateFairBatch({ initials: leads('i', 100), followUps: leads('f', 100), attemptInitial: ok, attemptFollowUp: ok });
  assert.equal(result.followUpSent, 4);
  assert.equal(result.initialSent, 1);
});

test('continuous initial imports cannot indefinitely starve follow-ups', async () => {
  let followUps = leads('f', 12);
  for (let run = 0; run < 3; run++) {
    const result = await simulateFairBatch({ initials: leads(`i${run}`, 100), followUps, attemptInitial: ok, attemptFollowUp: ok });
    const sentIds = new Set(result.events.filter(x => x[0] === 'follow-up').map(x => x[1]));
    followUps = followUps.filter(x => !sentIds.has(x.id));
  }
  assert.equal(followUps.length, 0);
});

test('oldest legitimate overdue follow-ups are selected first', () => {
  const sequence = [{ delayDays: 3 }, { delayDays: 5 }];
  const ordered = oldestDueFirst([
    { id: 'later', emailStep: '1', lastEmailedAt: '2026-08-20T00:00:00Z' },
    { id: 'oldest', emailStep: '1', lastEmailedAt: '2026-08-10T00:00:00Z' },
    { id: 'middle', emailStep: '2', lastEmailedAt: '2026-08-12T00:00:00Z' },
  ], sequence);
  assert.deepEqual(ordered.map(x => x.id), ['oldest', 'middle', 'later']);
});

test('blocked follow-ups do not consume successful-send positions', async () => {
  const result = await simulateFairBatch({
    initials: leads('i', 1), followUps: leads('f', 8), attemptInitial: ok,
    attemptFollowUp: async lead => !['f-1', 'f-2', 'f-4'].includes(lead.id),
  });
  assert.deepEqual(result.events.map(x => x[1]), ['f-3', 'f-5', 'f-6', 'f-7', 'i-1']);
});

test('unused follow-up capacity falls back to initials', async () => {
  const result = await simulateFairBatch({ initials: leads('i', 10), followUps: leads('f', 2), attemptInitial: ok, attemptFollowUp: ok });
  assert.deepEqual([result.followUpSent, result.initialSent], [2, 3]);
});

test('unused initial capacity can be used by follow-ups', async () => {
  const result = await simulateFairBatch({ initials: [], followUps: leads('f', 10), attemptInitial: ok, attemptFollowUp: ok });
  assert.deepEqual([result.followUpSent, result.initialSent], [5, 0]);
});

test('production policy retains daily cap, refill, thread gate and demo stop', () => {
  const agent = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(agent, /DAILY_SEND_LIMIT\s*=\s*parseInt\(process\.env\.DAILY_SEND_LIMIT \|\| '40'/);
  assert.equal(followUpSuccessTarget(5), 4);
  assert.match(agent, /while \(followUpIndex < followBatch\.length && sent < effectiveCap && followUpSent < successTarget\)/);
  assert.match(agent, /resolveColdFollowUpThread/);
  assert.match(agent, /canonical Gmail thread could not be proven/);
  assert.match(agent, /NON_COLD_STAGES\.includes/);
  assert.match(server, /DAILY_SEND_LIMIT/);
});
