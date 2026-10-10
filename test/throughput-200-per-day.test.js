'use strict';

// 200 campaign sends a weekday: 60 + 60 + 40 + 20 + 20 per day, 6 + 6 + 5 + 2 + 2
// = 21 per window across the ten scheduled windows, under 200/day and 21/run
// ceilings. Every window here is built the way outreach-agent builds it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { configuredSenders, chooseSender } = require('../integrations/gmail-sender-routing');
const { capacityFromEnv, MAX_INBOX_PER_RUN_LIMIT, DEFAULT_INBOX_PER_RUN_LIMIT } = require('../integrations/gmail-sender-capacity');
const { activationBlockers, markWarmupReady } = require('../integrations/gmail-sender-lifecycle');
const { createSendingWindowQuota, sendingWindowRemainingBySender } = require('../integrations/sending-window-quota');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8').split('\r\n').join('\n');
const server = read('server.js');
const agent = read('outreach-agent.js');

const TRY = perRunLimit => JSON.stringify([{ id: 'tryscalelabai', email: 'deins@tryscalelabai.ca', status: 'active',
  tokenEnv: 'GMAIL_TRYSCALELABAI_TOKEN_JSON', dailyLimit: 60, ...(perRunLimit ? { perRunLimit } : {}) }]);
// Production after the daily-cap work, before this change's configuration steps.
const BEFORE = {
  FROM_EMAIL: 'deins@scalelabai.ca', GMAIL_TOKEN_JSON: '{}', GMAIL_PRIMARY_DAILY_LIMIT: '60',
  GMAIL_INBOX_REGISTRY_JSON: TRY(), GMAIL_TRYSCALELABAI_TOKEN_JSON: '{}', GMAIL_SCALELABAITEAM_TOKEN_JSON: '{}',
  GMAIL_DENIELS_TOKEN_JSON: '{}', GMAIL_DENIELS_TRYSCALELABAI_TOKEN_JSON: '{}',
  GMAIL_SENDER_RUNTIME_JSON: JSON.stringify(['scalelabaiteam', 'deniels', 'deniels_tryscalelabai'].map(id => ({ id, status: 'active' }))),
  GMAIL_GLOBAL_DAILY_CEILING: '120', GMAIL_GLOBAL_PER_RUN_CEILING: '15',
};
// The four configuration steps, in rollout order.
const STEP1 = { ...BEFORE, GMAIL_PRIMARY_PER_RUN_LIMIT: '6' };
const STEP2 = { ...STEP1, GMAIL_INBOX_REGISTRY_JSON: TRY(6) };
const STEP3 = { ...STEP2, GMAIL_GLOBAL_PER_RUN_CEILING: '21' };
const FINAL = { ...STEP3, GMAIL_GLOBAL_DAILY_CEILING: '200' };

// Mirrors outreach-agent: SENDER_PER_RUN_LIMITS, PER_INBOX_RUN_CAP from the
// scheduler, globalLimit = DAILY_CAP = capacity.globalPerRunLimit.
function windowFor(env, perInboxCap = MAX_INBOX_PER_RUN_LIMIT) {
  const senders = configuredSenders(env);
  const capacity = capacityFromEnv(senders, env);
  const quota = createSendingWindowQuota({
    senderIds: senders.filter(sender => sender.sendEligible).map(sender => sender.id),
    perSenderLimit: perInboxCap, globalLimit: capacity.globalPerRunLimit,
    perSenderLimits: new Map(senders.filter(s => Number.isInteger(s.perRunLimit) && s.perRunLimit >= 0).map(s => [s.id, s.perRunLimit])),
  });
  return { senders, capacity, buckets: Object.fromEntries(sendingWindowRemainingBySender(quota)), perSenderCap: quota.limitBySender };
}
const buckets = env => Object.fromEntries([...windowFor(env).perSenderCap]);

test('the scheduler ceiling is the shared maximum: 6, not unbounded', () => {
  assert.equal(MAX_INBOX_PER_RUN_LIMIT, 6);
  assert.equal(DEFAULT_INBOX_PER_RUN_LIMIT, 5, 'the default for an inbox without its own cap is unchanged');
  assert.match(server, /const SCHEDULED_SEND_PER_INBOX_CAP = MAX_INBOX_PER_RUN_LIMIT;/);
  assert.match(server, /PER_INBOX_RUN_CAP: String\(caps\.perInbox\)/);
  // A configured 7 is still bucketed at 6 by the scheduler ceiling.
  const seven = windowFor({ ...FINAL, GMAIL_PRIMARY_PER_RUN_LIMIT: '7' });
  assert.equal(seven.perSenderCap.get('primary'), 6);
});

test('code deploy alone changes nothing: 5/5/5/2/2 and the old 15/120 ceilings still bind', () => {
  assert.deepEqual(buckets(BEFORE), { primary: 5, tryscalelabai: 5, scalelabaiteam: 5, deniels: 2, deniels_tryscalelabai: 2 });
  const { capacity } = windowFor(BEFORE);
  assert.equal(capacity.globalPerRunLimit, 15);
  assert.equal(capacity.globalDailyLimit, 120);
  // Same result the old 5-per-inbox ceiling gave for this configuration.
  assert.deepEqual(Object.fromEntries([...windowFor(BEFORE, 5).perSenderCap]), buckets(BEFORE));
});

test('rollout steps: each sender change is visible alone while the 15 ceiling still binds', () => {
  assert.deepEqual(buckets(STEP1), { primary: 6, tryscalelabai: 5, scalelabaiteam: 5, deniels: 2, deniels_tryscalelabai: 2 });
  assert.equal(windowFor(STEP1).capacity.perRunSum, 20);
  assert.equal(windowFor(STEP1).capacity.globalPerRunLimit, 15);
  assert.deepEqual(buckets(STEP2), { primary: 6, tryscalelabai: 6, scalelabaiteam: 5, deniels: 2, deniels_tryscalelabai: 2 });
  assert.equal(windowFor(STEP2).capacity.perRunSum, 21);
  assert.equal(windowFor(STEP2).capacity.globalPerRunLimit, 15);
  assert.equal(windowFor(STEP3).capacity.globalPerRunLimit, 21);
  assert.equal(windowFor(STEP3).capacity.globalDailyLimit, 120, 'daily ceiling still binds until the last step');
});

test('final configuration: 21 per window, 200 per day, daily caps sum to exactly 200', () => {
  const { senders, capacity, buckets: open } = windowFor(FINAL);
  assert.deepEqual(senders.map(s => [s.id, s.sendEligible, s.dailyLimit, s.perRunLimit]), [
    ['primary', true, 60, 6], ['tryscalelabai', true, 60, 6], ['scalelabaiteam', true, 40, 5],
    ['deniels', true, 20, 2], ['deniels_tryscalelabai', true, 20, 2],
  ]);
  assert.deepEqual(open, { primary: 6, tryscalelabai: 6, scalelabaiteam: 5, deniels: 2, deniels_tryscalelabai: 2 });
  assert.equal(capacity.perRunSum, 21);
  assert.equal(capacity.globalPerRunLimit, 21);
  assert.equal(capacity.dailySum, 200);
  assert.equal(capacity.globalDailyLimit, 200);
  // Ten windows × 21 = 210 slots; the 200 ceiling is the hard stop, and every
  // inbox can reach its own day inside ten windows.
  const slots = (server.match(/cron\.schedule\('0,30 7-11 \* \* 1-5'/) ? 10 : 0);
  assert.equal(slots, 10);
  for (const sender of senders) assert.ok(sender.perRunLimit * slots >= sender.dailyLimit, sender.id);
});

test('the other inboxes keep their own lower caps under the raised ceiling', () => {
  for (const env of [BEFORE, STEP1, STEP2, STEP3, FINAL]) {
    const caps = buckets(env);
    assert.equal(caps.scalelabaiteam, 5);
    assert.equal(caps.deniels, 2);
    assert.equal(caps.deniels_tryscalelabai, 2);
  }
});

test('Activate Sender accepts exactly 1–6 per window', () => {
  const ready = markWarmupReady({ ...configuredSenders(FINAL).find(s => s.id === 'deniels'), status: 'warming' });
  const ctx = { auth: { authenticated: true, identityVerified: true }, observer: { health: 'healthy', cursorState: 'present' }, senders: [] };
  const perRun = n => activationBlockers({ ...ready, perRunLimit: n }, ctx).filter(item => /perRunLimit/.test(item));
  for (const n of [1, 2, 5, 6]) assert.deepEqual(perRun(n), [], String(n));
  for (const n of [7, 10, 21, 1.5, -1]) assert.deepEqual(perRun(n), ['perRunLimit must be between 1 and 6'], String(n));
  // The daily bound is untouched.
  assert.ok(activationBlockers({ ...ready, dailyLimit: 41 }, ctx).includes('dailyLimit must be between 1 and 40'));
});

// Pacing. Measured production gap between sends on 2026-09-24 was 88.9 s at
// 45–120 s jitter, i.e. 6.4 s of provider/record time per send; ~18 s from the
// cron tick to the first send. A pass still running at the next :00/:30 tick
// makes that tick skip (no catch-up), so a pass must end inside 30 minutes.
const delay = name => Number((agent.match(new RegExp(`const ${name} = (\\d+) \\* 1000;`)) || [])[1]);
const SEND_OVERHEAD = 6.4;
const SETUP = 18.4;
function seeded(seed) { return () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }; }
function simulateDays({ min, max, perWindow, days, ceiling = 200 }) {
  const rnd = seeded(20260925);
  let skipped = 0; let total = 0; let longest = 0;
  for (let d = 0; d < days; d++) {
    let busyUntil = -1; let sent = 0;
    for (let k = 0; k < 10; k++) {
      const tick = k * 1800;
      if (tick < busyUntil) { skipped++; continue; }
      const n = Math.min(perWindow, ceiling - sent);
      if (n <= 0) break;
      let pass = SETUP;
      for (let i = 1; i < n; i++) pass += min + rnd() * (max - min) + SEND_OVERHEAD;
      busyUntil = tick + pass; sent += n; longest = Math.max(longest, pass);
    }
    total += sent;
  }
  return { skipped, average: total / days, longest };
}

test('scheduled pacing is 30–90 s between sends', () => {
  assert.equal(delay('MIN_DELAY'), 30);
  assert.equal(delay('MAX_DELAY'), 90);
  assert.match(agent, /const jitter = \(\) => MIN_DELAY \+ Math\.floor\(Math\.random\(\) \* \(MAX_DELAY - MIN_DELAY\)\);/);
});

test('a 21-send window ends well inside 30 minutes, so no scheduled pass overlaps the next', () => {
  const min = delay('MIN_DELAY'); const max = delay('MAX_DELAY');
  const mean = SETUP + 20 * ((min + max) / 2 + SEND_OVERHEAD);
  const sd = Math.sqrt(20) * ((max - min) / Math.sqrt(12));
  assert.ok(mean < 23 * 60, `mean 21-send pass ${(mean / 60).toFixed(1)} min`);
  assert.ok((1800 - mean) / sd > 5.5, 'a 30-minute overrun is more than 5.5 standard deviations away');
  const run = simulateDays({ min, max, perWindow: 21, days: 5000 });
  assert.equal(run.skipped, 0);
  assert.equal(run.average, 200);
  assert.ok(run.longest < 1800, `longest simulated pass ${(run.longest / 60).toFixed(1)} min`);
});

test('the previous 45–120 s pacing could not have carried 21 per window', () => {
  const old = simulateDays({ min: 45, max: 120, perWindow: 21, days: 2000 });
  assert.ok(old.skipped > 1000, 'most days would lose windows to overlap');
  assert.ok(old.average < 160);
});

test('no catch-up burst: a busy agent still skips the window, schedule unchanged', () => {
  assert.match(server, /cron\.schedule\('0,30 7-11 \* \* 1-5', async \(\) => \{/);
  const tick = server.slice(server.indexOf("cron.schedule('0,30 7-11 * * 1-5'"), server.indexOf("const bootCaps = scheduledSendCaps();"));
  assert.match(tick, /if \(agentState\.running \|\| automationLaunchReserved\) \{/);
  assert.match(tick, /skipping this send window; no catch-up burst will be queued/);
  assert.match(tick, /PER_INBOX_RUN_CAP: String\(caps\.perInbox\)/);
});

test('scalelabaiteam stays staffing-only at the new caps', () => {
  const senders = configuredSenders(FINAL);
  const idle = new Map([['primary', 59], ['tryscalelabai', 59], ['deniels', 19], ['deniels_tryscalelabai', 19], ['scalelabaiteam', 0]]);
  assert.notEqual(chooseSender({ lead: { id: 'D', tradeType: 'Dental' }, senders, sendsToday: idle }).sender?.id, 'scalelabaiteam');
  assert.equal(chooseSender({ lead: { id: 'S', leadNiche: 'industrial_staffing', senderInboxId: 'scalelabaiteam' }, senders }).sender.id, 'scalelabaiteam');
});
