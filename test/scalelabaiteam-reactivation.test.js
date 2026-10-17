'use strict';

// scalelabaiteam reactivation at 15/day (2026-10-17). No runtime code change:
// the inbox returns through the existing Activate Sender path (runtime overlay
// paused → active) and three existing Railway controls carry the capacity.
//
//   COLD_INBOX_DAILY_CAPS        the Jole launch caps plus scalelabaiteam:15
//                                (a ceiling below its registry 30; never raises)
//   GMAIL_GLOBAL_DAILY_CEILING   170 → 185: ScaleLab's ceiling was exactly the
//                                four active inboxes (50+30+45+45) and did not
//                                include scalelabaiteam, so it grows by its 15
//   GMAIL_GLOBAL_PER_RUN_CEILING 22 → 27: likewise exactly the four inboxes'
//                                window buckets (6+6+5+5); scalelabaiteam's 5
//                                is added so the shared window cap cannot
//                                starve it
//
// COLD_SENDER_HOLDS, COLD_SENDER_POOL, COLD_INBOX_DAILY_CAP,
// RECIPIENT_PROVIDER_POLICY and CLIENT_SENDING_AUTHORIZED are unchanged. Jole
// stays at 4 × 15 = 60/day with the industrial pair held at 0/day.

const test = require('node:test');
const assert = require('node:assert/strict');

const { configuredSenders, chooseSender } = require('../integrations/gmail-sender-routing');
const { capacityFromEnv } = require('../integrations/gmail-sender-capacity');
const {
  coldSenderVerdict, coldSenderHolds, coldDeliveryVerdict, coldInboxDailyCaps, describeColdDeliveryPolicy,
  HOLD_REASON, PROVIDER,
} = require('../integrations/cold-delivery-policy');
const { activationBlockers, activateSender } = require('../integrations/gmail-sender-lifecycle');
const { guardProviderSend } = require('../integrations/send-safety-revalidate');

// Live values on 2026-10-17 (prod 181f786), read from the runtime_overlay boot
// log and /api/ops/send-quota.
const LIVE_HOLDS = 'jole_industrial_jorge:warmup_incomplete,jole_industrial_jguerrero:warmup_incomplete';
const LIVE_CAPS = 'jole_group_jorge:15,jole_group_jguerrero:15,jole_team_jorge:15,jole_team_jguerrero:15,'
  + 'jole_industrial_jorge:0,jole_industrial_jguerrero:0';
// The exact Railway values after the reactivation.
const NEW_CAPS = `${LIVE_CAPS},scalelabaiteam:15`;
const NEW_DAILY_CEILING = '185';
const NEW_PER_RUN_CEILING = '27';

const SCALELAB_ACTIVE = ['primary', 'tryscalelabai', 'deniels', 'deniels_tryscalelabai'];
const SCALELAB_IDS = ['primary', 'tryscalelabai', 'scalelabaiteam', 'deniels', 'deniels_tryscalelabai'];
const JOLE_READY = ['jole_group_jorge', 'jole_group_jguerrero', 'jole_team_jorge', 'jole_team_jguerrero'];
const JOLE_INDUSTRIAL = ['jole_industrial_jorge', 'jole_industrial_jguerrero'];
const JOLE = [...JOLE_READY, ...JOLE_INDUSTRIAL];

const overlay = scalelabaiteamStatus => JSON.stringify([
  ...SCALELAB_ACTIVE.map(id => ({ id, status: 'active' })),
  { id: 'scalelabaiteam', status: scalelabaiteamStatus },
  ...JOLE.map(id => ({ id, status: 'active' })),
]);

// Production before the change: Jole armed, scalelabaiteam paused at runtime.
const BEFORE_ENV = Object.freeze({
  FROM_EMAIL: 'deins@scalelabai.ca', GMAIL_TOKEN_JSON: '{}', GMAIL_PRIMARY_DAILY_LIMIT: '50', GMAIL_PRIMARY_PER_RUN_LIMIT: '6',
  GMAIL_GLOBAL_DAILY_CEILING: '170', GMAIL_GLOBAL_PER_RUN_CEILING: '22',
  RECIPIENT_PROVIDER_POLICY: 'off', COLD_SENDER_POOL: 'all', COLD_INBOX_DAILY_CAP: '50',
  COLD_SENDER_HOLDS: LIVE_HOLDS, COLD_INBOX_DAILY_CAPS: LIVE_CAPS, CLIENT_SENDING_AUTHORIZED: 'jole',
  GMAIL_INBOX_REGISTRY_JSON: JSON.stringify([
    { id: 'tryscalelabai', email: 'deins@tryscalelabai.ca', status: 'active', tokenEnv: 'GMAIL_TRYSCALELABAI_TOKEN_JSON', dailyLimit: 30, perRunLimit: 6 },
    { id: 'scalelabaiteam', email: 'deins@scalelabaiteam.com', status: 'paused', tokenEnv: 'GMAIL_SCALELABAITEAM_TOKEN_JSON', dailyLimit: 30, perRunLimit: 5, staffingOnly: true },
    { id: 'deniels', email: 'deniels@scalelabai.ca', status: 'active', tokenEnv: 'GMAIL_DENIELS_TOKEN_JSON', dailyLimit: 45, perRunLimit: 5 },
    { id: 'deniels_tryscalelabai', email: 'deniels@tryscalelabai.ca', status: 'active', tokenEnv: 'GMAIL_DENIELS_TRYSCALELABAI_TOKEN_JSON', dailyLimit: 45, perRunLimit: 5 },
  ]),
  GMAIL_TRYSCALELABAI_TOKEN_JSON: '{}', GMAIL_SCALELABAITEAM_TOKEN_JSON: '{}',
  GMAIL_DENIELS_TOKEN_JSON: '{}', GMAIL_DENIELS_TRYSCALELABAI_TOKEN_JSON: '{}',
  ...Object.fromEntries(JOLE.map(id => [`GMAIL_${id.toUpperCase()}_TOKEN_JSON`, '{"refresh_token":"r"}'])),
  GMAIL_SENDER_RUNTIME_JSON: overlay('paused'),
});
// After: three variables changed and the runtime overlay set to active.
const AFTER_ENV = Object.freeze({
  ...BEFORE_ENV,
  COLD_INBOX_DAILY_CAPS: NEW_CAPS,
  GMAIL_GLOBAL_DAILY_CEILING: NEW_DAILY_CEILING,
  GMAIL_GLOBAL_PER_RUN_CEILING: NEW_PER_RUN_CEILING,
  GMAIL_SENDER_RUNTIME_JSON: overlay('active'),
});

const senderOf = (env, id) => configuredSenders(env).find(sender => sender.id === id);
const limitsOf = (env, ids) => Object.fromEntries(ids.map(id => {
  const s = senderOf(env, id);
  return [id, { status: s.status, sendEligible: s.sendEligible, dailyLimit: s.dailyLimit, perRunLimit: s.perRunLimit }];
}));
const capacity = env => capacityFromEnv(configuredSenders(env), env);
const staffingLead = (n = 1, extra = {}) => ({
  id: `SL${n}`, company: `Acme Staffing ${n}`, email: `ops@acmestaffing${n}.com`, tradeType: 'Industrial Staffing',
  stage: 'Queued', emailStatus: '', emailStep: '', notes: '', senderInboxId: 'scalelabaiteam', ...extra,
});
const HEALTHY = { auth: { authenticated: true, identityVerified: true }, observer: { health: 'healthy', cursorState: 'present' } };

test('baseline: the BEFORE env reproduces live production (ScaleLab 170/22, Jole 60/12, global 230/34)', () => {
  const live = capacity(BEFORE_ENV);
  assert.deepEqual(live.clientLimits, { scalelab: { daily: 170, perRun: 22 }, jole: { daily: 60, perRun: 12 } });
  assert.equal(live.globalDailyLimit, 230);
  assert.equal(live.globalPerRunLimit, 34);
  assert.equal(live.dailyCeiling, 170);
  assert.equal(live.perRunCeiling, 22);
  const team = senderOf(BEFORE_ENV, 'scalelabaiteam');
  assert.equal(team.status, 'paused');
  assert.equal(team.sendEligible, false);
  assert.equal(team.dailyLimit, 30);
  assert.equal(coldSenderHolds(BEFORE_ENV).has('scalelabaiteam'), false, 'paused at runtime, not held');
  // The ScaleLab ceiling is exactly the four active inboxes: scalelabaiteam is not in it.
  const activeSum = SCALELAB_ACTIVE.reduce((sum, id) => sum + senderOf(BEFORE_ENV, id).dailyLimit, 0);
  assert.equal(activeSum, 170);
  assert.equal(SCALELAB_ACTIVE.reduce((sum, id) => sum + senderOf(BEFORE_ENV, id).perRunLimit, 0), 22);
});

test('1. scalelabaiteam is eligible to cold-send after activation', () => {
  // The supported Activate Sender path accepts the paused inbox with healthy auth and observer.
  const paused = senderOf(AFTER_ENV, 'scalelabaiteam');
  assert.deepEqual(activationBlockers({ ...paused, status: 'paused' }, { ...HEALTHY, env: AFTER_ENV }), []);
  assert.equal(activateSender({ ...senderOf(BEFORE_ENV, 'scalelabaiteam'), credentialConfigured: true }, { ...HEALTHY, env: AFTER_ENV }).status, 'active');
  const sender = senderOf(AFTER_ENV, 'scalelabaiteam');
  assert.equal(sender.status, 'active');
  assert.equal(sender.sendEligible, true);
  assert.deepEqual(coldSenderVerdict(sender, AFTER_ENV), { allowed: true, code: '' });
  assert.equal(coldDeliveryVerdict({ sender, classification: { provider: PROVIDER.GOOGLE }, env: AFTER_ENV }).allowed, true);
});

test('2. its effective daily cold cap is exactly 15', () => {
  const sender = senderOf(AFTER_ENV, 'scalelabaiteam');
  assert.equal(sender.dailyLimit, 15);
  assert.equal(sender.configuredDailyLimit, 30, 'the registry 30 is clamped, not rewritten');
  assert.equal(sender.perRunLimit, 5);
  assert.equal(coldInboxDailyCaps(AFTER_ENV).get('scalelabaiteam'), 15);
  // 15 is the lowest of registry 30, COLD_INBOX_DAILY_CAP 50 and the per-inbox 15.
  assert.equal(senderOf({ ...AFTER_ENV, COLD_INBOX_DAILY_CAPS: LIVE_CAPS }, 'scalelabaiteam').dailyLimit, 30);
});

test('3. it cannot send a 16th cold email in the same day', () => {
  const senders = configuredSenders(AFTER_ENV);
  const lead = staffingLead(1);
  const at = count => chooseSender({ lead, senders, sendsToday: new Map([['scalelabaiteam', count]]), step: 1 });
  assert.equal(at(14).sender?.id, 'scalelabaiteam', 'the 15th is allowed');
  for (const count of [15, 16]) {
    const full = at(count);
    assert.equal(full.sender, null);
    assert.match(full.reason, /daily limit reached/);
  }
  // Follow-ups draw on the same 15.
  const followUp = chooseSender({ lead: { ...lead, emailStatus: 'emailed', emailStep: '1' }, senders,
    activities: [{ eventType: 'initial_email_sent', sourceLeadId: lead.id, metadata: JSON.stringify({ senderInboxId: 'scalelabaiteam' }) }],
    sendsToday: new Map([['scalelabaiteam', 15]]), step: 2 });
  assert.equal(followUp.sender, null);
});

test('4. the other ScaleLab sender limits are unchanged', () => {
  const expected = {
    primary: { status: 'active', sendEligible: true, dailyLimit: 50, perRunLimit: 6 },
    tryscalelabai: { status: 'active', sendEligible: true, dailyLimit: 30, perRunLimit: 6 },
    deniels: { status: 'active', sendEligible: true, dailyLimit: 45, perRunLimit: 5 },
    deniels_tryscalelabai: { status: 'active', sendEligible: true, dailyLimit: 45, perRunLimit: 5 },
  };
  assert.deepEqual(limitsOf(BEFORE_ENV, SCALELAB_ACTIVE), expected);
  assert.deepEqual(limitsOf(AFTER_ENV, SCALELAB_ACTIVE), expected);
});

test('5–6. Jole active inboxes stay 15/day; the industrial pair stays held at 0/day', () => {
  assert.deepEqual(limitsOf(AFTER_ENV, JOLE), limitsOf(BEFORE_ENV, JOLE));
  for (const id of JOLE_READY) {
    const sender = senderOf(AFTER_ENV, id);
    assert.equal(sender.dailyLimit, 15, id);
    assert.equal(sender.sendEligible, true, id);
    assert.deepEqual(coldSenderVerdict(sender, AFTER_ENV), { allowed: true, code: '' });
  }
  for (const id of JOLE_INDUSTRIAL) {
    const sender = senderOf(AFTER_ENV, id);
    assert.equal(sender.dailyLimit, 0, id);
    const verdict = coldSenderVerdict(sender, AFTER_ENV);
    assert.equal(verdict.code, 'sender_cold_hold');
    assert.equal(verdict.holdReason, 'warmup_incomplete');
  }
  assert.equal(AFTER_ENV.COLD_SENDER_HOLDS, LIVE_HOLDS, 'the hold variable is not touched');
  assert.equal(AFTER_ENV.CLIENT_SENDING_AUTHORIZED, 'jole');
});

test('7. Jole effective capacity remains 60/day (12/window)', () => {
  assert.deepEqual(capacity(BEFORE_ENV).clientLimits.jole, { daily: 60, perRun: 12 });
  assert.deepEqual(capacity(AFTER_ENV).clientLimits.jole, { daily: 60, perRun: 12 });
});

test('8. aggregate capacity grows by exactly 15/day (and 5/window) with no double count', () => {
  const before = capacity(BEFORE_ENV);
  const after = capacity(AFTER_ENV);
  assert.deepEqual(after.clientLimits.scalelab, { daily: 185, perRun: 27 });
  assert.equal(after.globalDailyLimit, before.globalDailyLimit + 15);
  assert.equal(after.globalDailyLimit, 245);
  assert.equal(after.globalPerRunLimit, before.globalPerRunLimit + 5);
  assert.equal(after.globalPerRunLimit, 39);
  // The ceiling equals the eligible sum exactly: nothing spare, nothing blocked.
  assert.equal(after.dailySum - after.clientLimits.jole.daily, 185);
  // Without the ceiling raise the new inbox would be blocked by the old 170.
  assert.equal(capacity({ ...AFTER_ENV, GMAIL_GLOBAL_DAILY_CEILING: '170' }).clientLimits.scalelab.daily, 170);
  // Without the 15/day cap the raised ceiling still bounds ScaleLab at 185, never 200.
  assert.equal(capacity({ ...AFTER_ENV, COLD_INBOX_DAILY_CAPS: LIVE_CAPS }).clientLimits.scalelab.daily, 185);
});

test('9. suppression and recipient-provider gates still apply to scalelabaiteam', async () => {
  const sender = senderOf(AFTER_ENV, 'scalelabaiteam');
  const SEND_ENV = { ...AFTER_ENV, SENDING_ENABLED: 'true', SEND_AUTHORIZED_ENV: 'test', RAILWAY_ENVIRONMENT: 'test',
    SEND_AUTHORIZED_TOKEN: 'token', SEND_WORKER_ROLE: 'outreach-sender', SEND_LOCK_ENABLED: 'true',
    STAFFING_LAUNCH_ACTIVATED_AT: '2026-09-22T14:00:00.000Z' };
  const gate = (current, { suppressed = new Set(), env = SEND_ENV, provider = PROVIDER.GOOGLE } = {}) => guardProviderSend(current,
    { env, classifyRecipient: async email => ({ provider, domain: email.split('@')[1] }),
      loadFreshState: async () => ({ current, suppressedEmails: suppressed }) },
    { purpose: 'cold', coldSender: sender, senderInboxId: sender.id });
  const ok = await gate(staffingLead(2)); assert.equal(ok.allowed, true, JSON.stringify(ok));
  const unsub = await gate(staffingLead(3, { notes: '[REPLY: Unsubscribed]' }));
  assert.equal(unsub.allowed, false);
  assert.equal(unsub.code, 'unsubscribed');
  const suppressed = await gate(staffingLead(4), { suppressed: new Set(['ops@acmestaffing4.com']) });
  assert.equal(suppressed.allowed, false);
  // The provider policy is unchanged (off); were it google_only, a Microsoft recipient is held.
  assert.equal(AFTER_ENV.RECIPIENT_PROVIDER_POLICY, 'off');
  const held = await gate(staffingLead(5), { env: { ...SEND_ENV, RECIPIENT_PROVIDER_POLICY: 'google_only' }, provider: PROVIDER.MICROSOFT });
  assert.equal(held.allowed, false);
  assert.equal(held.code, HOLD_REASON.MICROSOFT);
});

test('10. no sender other than scalelabaiteam changes eligibility, and holds are identical', () => {
  const eligible = env => configuredSenders(env).filter(s => s.sendEligible).map(s => s.id).sort();
  const added = eligible(AFTER_ENV).filter(id => !eligible(BEFORE_ENV).includes(id));
  const removed = eligible(BEFORE_ENV).filter(id => !eligible(AFTER_ENV).includes(id));
  assert.deepEqual(added, ['scalelabaiteam']);
  assert.deepEqual(removed, []);
  assert.deepEqual(describeColdDeliveryPolicy(configuredSenders(AFTER_ENV), AFTER_ENV).coldSenderHolds,
    { jole_industrial_jorge: 'warmup_incomplete', jole_industrial_jguerrero: 'warmup_incomplete' });
  // Every other sender's limits are byte-identical.
  const others = configuredSenders(BEFORE_ENV).map(s => s.id).filter(id => id !== 'scalelabaiteam');
  assert.deepEqual(limitsOf(AFTER_ENV, others), limitsOf(BEFORE_ENV, others));
  // The new caps value only adds one pair; the Jole pairs parse identically.
  const caps = coldInboxDailyCaps(AFTER_ENV);
  assert.equal(caps.size, 7);
  for (const [id, cap] of coldInboxDailyCaps(BEFORE_ENV)) assert.equal(caps.get(id), cap, id);
  assert.ok(SCALELAB_IDS.every(id => id === 'scalelabaiteam' || !caps.has(id)), 'no other ScaleLab inbox gains a cap');
});
