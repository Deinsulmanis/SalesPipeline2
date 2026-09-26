'use strict';

/**
 * The intent backstop and the scheduled send window share agentState.running.
 * While the backstop ran on '*\/3' it fired at 0,3,…,57 — including :00 and
 * :30, the exact minutes the send cron fires. An intent pass still holding the
 * mutex at that instant made the send window log
 *
 *   [cron] Agent already running — skipping this send window; no catch-up
 *   burst will be queued
 *
 * and that window's ten sends were lost outright. Three lost windows a day is
 * the difference between the observed ~50 and the configured 80.
 *
 * These tests pin the collision itself, not a string: the fire minutes are
 * derived from node-cron's own parser, so a future edit to either expression
 * that reintroduces an overlap fails here.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

const INTENT_CRON = '1-59/3 * * * *';
const SEND_CRON = '0,30 7-11 * * 1-5';

/** The minutes an expression actually fires on, per node-cron itself. */
function fireMinutes(expr, samples = 240) {
  const task = cron.createTask(expr, () => {}, { scheduled: false, timezone: 'America/Vancouver' });
  return [...new Set(task.getNextRuns(samples).map(d => d.getMinutes()))].sort((a, b) => a - b);
}

test('the production intent backstop uses the offset expression', () => {
  assert.match(server, /cron\.schedule\('1-59\/3 \* \* \* \*'/,
    'the intent backstop must not return to a schedule that lands on :00/:30');
  assert.doesNotMatch(server, /cron\.schedule\('\*\/3 \* \* \* \*'/,
    "'*/3' fires at :00 and :30 and collides with the send window");
});

test('1. the intent cron never fires at minute 00', () => {
  assert.ok(!fireMinutes(INTENT_CRON).includes(0), 'minute 0 must be free for the send window');
});

test('2. the intent cron never fires at minute 30', () => {
  assert.ok(!fireMinutes(INTENT_CRON).includes(30), 'minute 30 must be free for the send window');
});

test('3. the scheduled send cron still fires at :00 and :30', () => {
  const minutes = fireMinutes(SEND_CRON);
  assert.deepEqual(minutes, [0, 30], 'the send window schedule is unchanged');
  assert.match(server, /cron\.schedule\('0,30 7-11 \* \* 1-5'/);
});

test('4. there are still 20 intent-backstop opportunities per hour', () => {
  assert.equal(fireMinutes(INTENT_CRON).length, 20, 'cadence frequency is preserved');
});

test('5. the offset cadence remains effectively every 3 minutes', () => {
  const task = cron.createTask(INTENT_CRON, () => {}, { scheduled: false, timezone: 'America/Vancouver' });
  const runs = task.getNextRuns(40);
  const gaps = runs.slice(1).map((d, i) => (d - runs[i]) / 60000);
  assert.deepEqual([...new Set(gaps)], [3],
    'every interval is exactly 3 minutes, including across the hour boundary (:58 → :01)');
  assert.deepEqual(fireMinutes(INTENT_CRON),
    [1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34, 37, 40, 43, 46, 49, 52, 55, 58]);
});

test('the two schedules can no longer collide on any minute', () => {
  const intent = new Set(fireMinutes(INTENT_CRON));
  const overlap = fireMinutes(SEND_CRON).filter(m => intent.has(m));
  assert.deepEqual(overlap, [],
    'no minute is shared, so an intent pass can never hold the mutex as a send window opens');
});

test('6. no production send limit changed', () => {
  // The repair is a schedule offset. The per-inbox window ceiling is the shared
  // MAX_INBOX_PER_RUN_LIMIT (6); the
  // combined run/day ceilings are derived from ACTIVE inboxes, not hardcoded
  // to a two-inbox total.
  assert.match(server, /const SCHEDULED_SEND_PER_INBOX_CAP = MAX_INBOX_PER_RUN_LIMIT;/);
  assert.equal(require('../integrations/gmail-sender-capacity').MAX_INBOX_PER_RUN_LIMIT, 6);
  assert.match(server, /function scheduledSendCaps/);
  assert.match(server, /PER_INBOX_RUN_CAP: String\(caps\.perInbox\)/);
  assert.match(server, /DAILY_CAP: String\(caps\.total\)/);
  assert.doesNotMatch(server, /const SCHEDULED_SEND_TOTAL_CAP = 10;/);
  const agent = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');
  assert.match(agent, /const DAILY_SEND_LIMIT = SENDER_CAPACITY\.globalDailyLimit;/);
  const routing = fs.readFileSync(path.join(__dirname, '..', 'integrations', 'gmail-sender-routing.js'), 'utf8');
  assert.match(routing, /dailyLimit: Number\(env\.GMAIL_PRIMARY_DAILY_LIMIT \|\| DEFAULT_INBOX_DAILY_LIMIT\)/);
  const fairness = fs.readFileSync(path.join(__dirname, '..', 'integrations', 'scheduler-fairness.js'), 'utf8');
  assert.match(fairness, /return Math\.min\(4, Math\.max\(0, Number\(cap\) - 1\)\);/,
    'the 4-follow-up/1-initial policy is untouched');
});

test('the skip-without-catch-up behaviour itself is unchanged', () => {
  // The repair removes the collision; it does not add replay. A genuinely busy
  // agent must still drop the window rather than burst later.
  assert.match(server, /skipping this send window; no catch-up burst will be queued/);
  assert.doesNotMatch(server, /pendingScheduledSendRuns|MAX_PENDING_SCHEDULED_SEND_RUNS/);
  assert.match(server, /if \(agentState\.running \|\| automationLaunchReserved\) \{/,
    'the shared mutex guard remains');
});
