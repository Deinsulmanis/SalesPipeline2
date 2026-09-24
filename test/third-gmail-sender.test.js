'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseRegistry, withDefaultInboxes, assertDormant, publicRegistry } = require('../integrations/gmail-inbox-registry');
const { configuredSenders, observableSenders, chooseSender, allowedForLead } = require('../integrations/gmail-sender-routing');
const { senderCapacity } = require('../integrations/gmail-sender-capacity');
const {
  markWarmupReady, activationBlockers, activateSender, pauseSender,
  overlayDoesNotTouchObserverState,
} = require('../integrations/gmail-sender-lifecycle');
const { createSendingWindowQuota, sendingWindowVerdict, consumeSendingWindowSuccess } = require('../integrations/sending-window-quota');
const { observerHealth } = require('../integrations/gmail-observer-health');
const { attributionBreakdown, buildAnalyticsIntegrity } = require('../integrations/analytics-integrity');
const { canonicalSendRows } = require('../integrations/canonical-sends');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').split('\r\n').join('\n');

const TWO_ACTIVE = {
  FROM_EMAIL: 'deins@scalelabai.ca', GMAIL_TOKEN_JSON: '{}', GMAIL_PRIMARY_DAILY_LIMIT: '40',
  GMAIL_INBOX_REGISTRY_JSON: JSON.stringify([
    { id: 'tryscalelabai', email: 'deins@tryscalelabai.ca', status: 'active', tokenEnv: 'GMAIL_TRYSCALELABAI_TOKEN_JSON', dailyLimit: 40, perRunLimit: 5 },
  ]),
  GMAIL_TRYSCALELABAI_TOKEN_JSON: '{}',
  GMAIL_SCALELABAITEAM_TOKEN_JSON: '{}',
  GMAIL_GLOBAL_DAILY_CEILING: '120',
  GMAIL_GLOBAL_PER_RUN_CEILING: '15',
};

function senders(env = TWO_ACTIVE) {
  return configuredSenders(env);
}

function third(env = TWO_ACTIVE) {
  return senders(env).find(item => item.id === 'scalelabaiteam' || item.email === 'deins@scalelabaiteam.com');
}

const healthyObserver = {
  senderInboxId: 'scalelabaiteam', health: 'healthy', cursorState: 'present',
  historyId: '123', quotaBackoff: false,
};
const healthyAuth = { authenticated: true, identityVerified: true };

test('1. warming sender cannot cold-send', () => {
  const inbox = third();
  assert.ok(inbox);
  assert.equal(inbox.status, 'warming');
  assert.equal(inbox.sendEligible, false);
  assert.equal(assertDormant(inbox), true);
  assert.equal(allowedForLead(inbox, { tradeType: 'Dental' }), false);
  assert.equal(chooseSender({ lead: { id: 'L', tradeType: 'Dental' }, senders: senders() }).sender?.id !== 'scalelabaiteam', true);
});

test('2. inactive sender is excluded from allocation', () => {
  const roster = senders();
  const inactive = roster.find(item => item.id === 'scalelabaiteam');
  const choice = chooseSender({
    lead: { id: 'L', tradeType: 'Dental' }, senders: roster,
    sendsToday: new Map([['primary', 40], ['tryscalelabai', 40]]),
  });
  assert.equal(inactive.sendEligible, false);
  assert.equal(choice.sender, null);
});

test('3. inactive sender observer can remain healthy', () => {
  const inbox = third();
  assert.equal(inbox.observerEnabled, true);
  assert.ok(observableSenders(senders()).some(item => item.id === 'scalelabaiteam'));
  const rows = [['senderInboxId', 'historyId', 'lastSuccessfulAt', 'lastAttemptAt', 'lastError', 'health'],
    ['scalelabaiteam', '99', new Date().toISOString(), new Date().toISOString(), '', 'healthy']];
  const [observer] = observerHealth(rows, { senderIds: ['scalelabaiteam'] });
  assert.equal(observer.health, 'healthy');
  assert.equal(observer.cursorState, 'present');
});

test('4. warmup ready alone does not activate sender', () => {
  const ready = markWarmupReady(third());
  assert.equal(ready.status, 'ready');
  assert.equal(ready.sendEligible, false);
  const env = { ...TWO_ACTIVE, GMAIL_SENDER_RUNTIME_JSON: JSON.stringify([{ id: 'scalelabaiteam', status: 'ready' }]) };
  const inbox = third(env);
  assert.equal(inbox.status, 'ready');
  assert.equal(inbox.sendEligible, false);
  assert.equal(senderCapacity(senders(env)).activeCount, 2);
});

test('5. Activate Sender requires healthy auth/observer', () => {
  const ready = markWarmupReady(third());
  assert.deepEqual(activationBlockers(ready, { auth: { authenticated: false }, observer: healthyObserver, senders: senders() }).some(item => /auth/i.test(item)), true);
  assert.deepEqual(activationBlockers(ready, { auth: healthyAuth, observer: { ...healthyObserver, health: 'unavailable' }, senders: senders() }).some(item => /observer/i.test(item)), true);
  assert.throws(() => activateSender(ready, { auth: healthyAuth, observer: { ...healthyObserver, cursorState: 'missing' }, senders: senders() }), /history cursor/);
  assert.throws(() => activateSender(third(), { auth: healthyAuth, observer: healthyObserver, senders: senders() }), /warmup is not ready/);
});

test('6. active sender joins allocation for staffing leads only', () => {
  const ready = markWarmupReady(third());
  const active = activateSender(ready, { auth: healthyAuth, observer: healthyObserver, senders: senders() });
  assert.equal(active.status, 'active');
  assert.equal(active.sendEligible, true);
  const env = { ...TWO_ACTIVE, GMAIL_SENDER_RUNTIME_JSON: JSON.stringify([{ id: 'scalelabaiteam', status: 'active' }]) };
  const roster = senders(env);
  assert.equal(roster.find(item => item.id === 'scalelabaiteam').sendEligible, true);
  const sendsToday = new Map([['primary', 10], ['tryscalelabai', 10], ['scalelabaiteam', 0]]);
  const staffing = chooseSender({
    lead: { id: 'S', leadNiche: 'industrial_staffing', senderInboxId: 'scalelabaiteam' }, senders: roster, sendsToday,
  });
  assert.equal(staffing.sender.id, 'scalelabaiteam');
  // Least-used would otherwise pick the idle inbox; scalelabaiteam is staffing-only.
  const dental = chooseSender({ lead: { id: 'L', tradeType: 'Dental' }, senders: roster, sendsToday });
  assert.notEqual(dental.sender.id, 'scalelabaiteam');
});

test('7. 2 active inboxes = 80/day', () => {
  assert.equal(senderCapacity(senders()).globalDailyLimit, 80);
  assert.equal(senderCapacity(senders()).activeCount, 2);
});

test('8. 3 active inboxes = 120/day', () => {
  const env = { ...TWO_ACTIVE, GMAIL_SENDER_RUNTIME_JSON: JSON.stringify([{ id: 'scalelabaiteam', status: 'active' }]) };
  assert.equal(senderCapacity(senders(env)).globalDailyLimit, 120);
});

test('9. 2 active inboxes = 10/run', () => {
  assert.equal(senderCapacity(senders()).globalPerRunLimit, 10);
});

test('10. 3 active inboxes = 15/run', () => {
  const env = { ...TWO_ACTIVE, GMAIL_SENDER_RUNTIME_JSON: JSON.stringify([{ id: 'scalelabaiteam', status: 'active' }]) };
  assert.equal(senderCapacity(senders(env)).globalPerRunLimit, 15);
});

test('11. each inbox remains capped at 40/day', () => {
  const env = { ...TWO_ACTIVE, GMAIL_SENDER_RUNTIME_JSON: JSON.stringify([{ id: 'scalelabaiteam', status: 'active' }]) };
  const roster = senders(env);
  for (const sender of roster.filter(item => item.sendEligible)) {
    assert.equal(sender.dailyLimit, 40);
    const niche = sender.id === 'scalelabaiteam' ? { leadNiche: 'industrial_staffing' } : { tradeType: 'Dental' };
    assert.equal(chooseSender({
      lead: { id: 'L', ...niche, senderInboxId: sender.id },
      senders: roster, sendsToday: new Map([[sender.id, 40]]),
    }).sender, null);
  }
});

test('12. each inbox remains capped at 5/run', () => {
  const quota = createSendingWindowQuota({
    senderIds: ['primary', 'tryscalelabai', 'scalelabaiteam'], perSenderLimit: 5, globalLimit: 15,
  });
  for (const id of ['primary', 'tryscalelabai', 'scalelabaiteam']) {
    for (let i = 0; i < 5; i++) consumeSendingWindowSuccess(quota, id);
    assert.equal(sendingWindowVerdict(quota, id).allowed, false);
  }
  assert.equal(quota.globalSuccesses, 15);
});

test('13. unhealthy inbox excluded without affecting healthy inboxes', () => {
  const env = { ...TWO_ACTIVE, GMAIL_SENDER_RUNTIME_JSON: JSON.stringify([{ id: 'scalelabaiteam', status: 'active' }]) };
  const roster = senders(env).map(item => item.id === 'scalelabaiteam' ? { ...item, sendEligible: false } : item);
  const choice = chooseSender({
    lead: { id: 'L', tradeType: 'Dental' }, senders: roster,
    sendsToday: new Map([['primary', 2], ['tryscalelabai', 1], ['scalelabaiteam', 0]]),
  });
  assert.equal(choice.sender.id, 'tryscalelabai');
  assert.equal(senderCapacity(roster).globalDailyLimit, 80);
});

test('14. paused sender stops receiving new assignments', () => {
  const paused = pauseSender(activateSender(markWarmupReady(third()), { auth: healthyAuth, observer: healthyObserver, senders: senders() }));
  assert.equal(paused.status, 'paused');
  assert.equal(paused.sendEligible, false);
  const env = { ...TWO_ACTIVE, GMAIL_SENDER_RUNTIME_JSON: JSON.stringify([{ id: 'scalelabaiteam', status: 'paused' }]) };
  assert.equal(senders(env).find(item => item.id === 'scalelabaiteam').sendEligible, false);
  assert.equal(senderCapacity(senders(env)).activeCount, 2);
});

test('15. pause does not delete Gmail history cursor', () => {
  const before = { historyId: '888', lastSuccessfulAt: '2026-09-17T12:00:00Z' };
  const paused = pauseSender(third());
  assert.equal(paused.observerEnabled, true);
  assert.equal(overlayDoesNotTouchObserverState(before, before), true);
  const agent = read('outreach-agent.js');
  const pauseRoute = read('server.js');
  const start = pauseRoute.indexOf("app.post('/api/integrations/gmail-inboxes/:id/pause'");
  const body = pauseRoute.slice(start, pauseRoute.indexOf("app.get('/api/ops/send-quota'"));
  assert.doesNotMatch(body, /GmailObservationState|historyId.*=\s*''|persistGmailObservationState/);
  assert.match(agent, /observableSenders\(GMAIL_SENDERS\)/);
});

test('16. analytics accept third inbox', () => {
  const rows = [
    { eventType: 'initial_email_sent', occurredAt: '2026-09-17T18:00:00Z', sourceLeadId: 'a', metadata: JSON.stringify({ senderInboxId: 'scalelabaiteam', gmailMessageId: 'm1', campaignVersion: 'dental_v3_pay_per_booking' }) },
    { eventType: 'initial_email_sent', occurredAt: '2026-09-17T18:01:00Z', sourceLeadId: 'b', metadata: JSON.stringify({ senderInboxId: 'primary', gmailMessageId: 'm2', campaignVersion: 'dental_v3_pay_per_booking' }) },
    { eventType: 'initial_email_sent', occurredAt: '2026-09-17T18:02:00Z', sourceLeadId: 'c', metadata: JSON.stringify({ senderInboxId: 'tryscalelabai', gmailMessageId: 'm3', campaignVersion: 'dental_v3_pay_per_booking' }) },
  ];
  const breakdown = attributionBreakdown(rows);
  assert.equal(breakdown.byInbox.scalelabaiteam, 1);
  assert.equal(breakdown.byInbox.primary, 1);
  assert.equal(breakdown.byInbox.tryscalelabai, 1);
  assert.equal(canonicalSendRows(rows).confirmed.length, 3);
});

test('17. send locks remain required', () => {
  const agent = read('outreach-agent.js');
  const lock = read('integrations/send-lock.js');
  const server = read('server.js');
  assert.match(lock, /assertSendLockReady/);
  assert.match(server, /sendLockHealth/);
  assert.match(server, /\/api\/send-lock\/health/);
  assert.match(agent, /withOutboundReservation|assertSendLockReady|send-lock/);
});

test('18. Gmail observer quota safety remains intact', () => {
  const guard = read('integrations/gmail-api-guard.js');
  const observer = read('integrations/gmail-mailbox-observer.js');
  assert.match(guard, /signalMailboxBackoff/);
  assert.match(guard, /backoffByMailbox/);
  assert.match(observer, /quotaBackoff|isRateLimited/);
  assert.match(read('outreach-agent.js'), /getMailboxBackoff\(sender\.id\)/);
});

test('fourth inbox cannot accidentally raise the global ceiling', () => {
  const extra = {
    ...TWO_ACTIVE,
    GMAIL_INBOX_REGISTRY_JSON: JSON.stringify([
      { id: 'tryscalelabai', email: 'deins@tryscalelabai.ca', status: 'active', tokenEnv: 'GMAIL_TRYSCALELABAI_TOKEN_JSON', dailyLimit: 40, perRunLimit: 5 },
      { id: 'fourth', email: 'fourth@example.com', status: 'active', tokenEnv: 'GMAIL_FOURTH_TOKEN_JSON', dailyLimit: 40, perRunLimit: 5 },
    ]),
    GMAIL_FOURTH_TOKEN_JSON: '{}',
    GMAIL_SENDER_RUNTIME_JSON: JSON.stringify([{ id: 'scalelabaiteam', status: 'active' }]),
  };
  const capacity = senderCapacity(senders(extra));
  assert.equal(capacity.activeCount, 4);
  assert.equal(capacity.dailySum, 160);
  assert.equal(capacity.globalDailyLimit, 120);
  assert.equal(capacity.globalPerRunLimit, 15);
});

test('default third inbox is configured with intended caps while warming', () => {
  const inbox = third();
  assert.equal(inbox.email, 'deins@scalelabaiteam.com');
  assert.equal(inbox.provider, 'gmail');
  assert.equal(inbox.dailyLimit, 40);
  assert.equal(inbox.perRunLimit, 5);
  assert.equal(inbox.status, 'warming');
  assert.equal(inbox.sendEligible, false);
  const parsed = withDefaultInboxes(parseRegistry('[]'));
  assert.equal(parsed[0].email, 'deins@scalelabaiteam.com');
});

test('activation and pause endpoints exist and do not trigger outreach', () => {
  const server = read('server.js');
  const html = read('public/index.html');
  assert.match(server, /app.post\('\/api\/integrations\/gmail-inboxes\/:id\/mark-ready', requireAuth/);
  assert.match(server, /app.post\('\/api\/integrations\/gmail-inboxes\/:id\/activate', requireAuth/);
  assert.match(server, /app.post\('\/api\/integrations\/gmail-inboxes\/:id\/pause', requireAuth/);
  assert.match(server, /app.get\('\/api\/ops\/send-quota', requireAuth/);
  assert.match(server, /triggeredOutreach: false/);
  assert.doesNotMatch(server.slice(server.indexOf("app.post('/api/integrations/gmail-inboxes/:id/activate'"), server.indexOf("app.post('/api/integrations/gmail-inboxes/:id/pause'")), /spawnAgent|sendEmail|cron\.schedule/);
  assert.match(html, /Activate Sender/);
  assert.match(html, /Mark Warmup Ready/);
  assert.match(html, /Pause Sender/);
  assert.match(html, /deins@scalelabaiteam.com|warmupLabel|Cold sending/);
});

test('scheduled caps are derived from active inboxes rather than hardcoded 2-inbox totals', () => {
  const server = read('server.js');
  assert.match(server, /const SCHEDULED_SEND_PER_INBOX_CAP = 5;/);
  assert.match(server, /function scheduledSendCaps/);
  assert.match(server, /DAILY_CAP: String\(caps\.total\)/);
  assert.doesNotMatch(server, /const SCHEDULED_SEND_TOTAL_CAP = 10;/);
  const agent = read('outreach-agent.js');
  assert.match(agent, /SENDER_CAPACITY = capacityFromEnv/);
  assert.match(agent, /DAILY_CAP        = SENDER_CAPACITY\.globalPerRunLimit/);
  assert.match(agent, /DAILY_SEND_LIMIT = SENDER_CAPACITY\.globalDailyLimit/);
});
