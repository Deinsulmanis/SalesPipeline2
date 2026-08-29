'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const agent = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');

test('a busy safe pass queues rather than discards a scheduled send window', () => {
  assert.match(server, /pendingScheduledSendRuns = Math\.min\(MAX_PENDING_SCHEDULED_SEND_RUNS, pendingScheduledSendRuns \+ 1\)/);
  assert.match(server, /if \(pendingScheduledSendRuns > 0\)[\s\S]{0,350}spawnAgent\(false, \{ DAILY_CAP: String\(SCHEDULED_SEND_PER_RUN_CAP\) \}\)/);
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
