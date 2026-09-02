'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { oldestDueFirst, followUpSuccessTarget, simulateFairBatch } = require('../integrations/scheduler-fairness');
const ok = async () => true;
const leads = (p, n) => Array.from({ length: n }, (_, i) => ({ id: `${p}-${i + 1}` }));

test('five initials cannot starve overdue follow-ups; 100/100 allocates immediately', async () => {
  for (const n of [5, 100]) {
    const r = await simulateFairBatch({ initials: leads('i', n), followUps: leads('f', n), attemptInitial: ok, attemptFollowUp: ok });
    assert.deepEqual([r.followUpSent, r.initialSent], [4, 1]);
    assert.equal(r.events[0][0], 'follow-up');
  }
});
test('continuous imports cannot indefinitely starve follow-ups', async () => {
  let remaining = leads('f', 12);
  for (let run = 0; run < 3; run++) {
    const r = await simulateFairBatch({ initials: leads(`i${run}`, 100), followUps: remaining, attemptInitial: ok, attemptFollowUp: ok });
    const sent = new Set(r.events.filter(x => x[0] === 'follow-up').map(x => x[1]));
    remaining = remaining.filter(x => !sent.has(x.id));
  }
  assert.equal(remaining.length, 0);
});
test('oldest legitimate overdue follow-ups are selected first', () => {
  const ordered = oldestDueFirst([
    { id: 'later', emailStep: 1, lastEmailedAt: '2026-08-20Z' },
    { id: 'oldest', emailStep: 1, lastEmailedAt: '2026-08-10Z' },
    { id: 'middle', emailStep: 2, lastEmailedAt: '2026-08-12Z' },
  ], [{ delayDays: 3 }, { delayDays: 5 }]);
  assert.deepEqual(ordered.map(x => x.id), ['oldest', 'middle', 'later']);
});
test('blocked follow-ups do not consume positions', async () => {
  const r = await simulateFairBatch({ initials: leads('i', 1), followUps: leads('f', 8), attemptInitial: ok,
    attemptFollowUp: async x => !['f-1', 'f-2', 'f-4'].includes(x.id) });
  assert.deepEqual(r.events.map(x => x[1]), ['f-3', 'f-5', 'f-6', 'f-7', 'i-1']);
});
test('unused follow-up capacity falls to initials and unused initial capacity falls to follow-ups', async () => {
  const a = await simulateFairBatch({ initials: leads('i', 10), followUps: leads('f', 2), attemptInitial: ok, attemptFollowUp: ok });
  const b = await simulateFairBatch({ initials: [], followUps: leads('f', 10), attemptInitial: ok, attemptFollowUp: ok });
  assert.deepEqual([a.followUpSent, a.initialSent], [2, 3]);
  assert.deepEqual([b.followUpSent, b.initialSent], [5, 0]);
});
test('production retains cap 40, candidate refill, Gmail failure-closed gate and demo stop', () => {
  const agent = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');
  assert.equal(followUpSuccessTarget(5), 4);
  assert.match(agent, /DAILY_SEND_LIMIT\s*=\s*parseInt\(process\.env\.DAILY_SEND_LIMIT \|\| '40'/);
  assert.match(agent, /while \(followUpIndex < followBatch\.length && sent < effectiveCap && followUpSent < successTarget\)/);
  assert.match(agent, /resolveColdFollowUpThread/);
  assert.match(agent, /canonical Gmail thread could not be proven/);
  assert.match(agent, /NON_COLD_STAGES\.includes/);
});
