'use strict';

// Client-level send capacity: GLOBAL → CLIENT → (campaign → sender → window).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createClientCapacityState, clientCapacityVerdict, consumeClientCapacity, recordClientSend,
  clientSendCountsToday, clientCapacitySnapshot,
} = require('../integrations/clients/capacity');
const { getClient, buildRegistry } = require('../integrations/clients/registry');
const { chooseSender } = require('../integrations/gmail-sender-routing');
const { createSendingWindowQuota, sendingWindowVerdict, consumeSendingWindowSuccess } = require('../integrations/sending-window-quota');

// Hypothetical launch numbers, injected for the test only. Production config
// keeps Jole at 0/0 with sending disabled; `joleEnabled` models the day it is
// switched on without touching the registry.
const { clientSendBlock } = require('../integrations/clients/send-policy');
const AUTHORIZED = {};
const enabledJole = (id, env) => (id === 'jole' ? null : clientSendBlock(id, env));
const joleEnabled = () => ({ restore() {} });
let SEND_BLOCK = clientSendBlock;

function state({ sent = {}, caps = {}, globalDaily = 200, globalWindow = 21, env = AUTHORIZED, sendBlock = SEND_BLOCK } = {}) {
  return createClientCapacityState({
    globalDailyLimit: globalDaily, globalWindowLimit: globalWindow,
    sentTodayByClient: new Map(Object.entries(sent)),
    configs: new Map(Object.entries(caps)), env, sendBlock,
  });
}

test('config: ScaleLab has no client cap (shared global capacity unchanged); Jole ships at zero', () => {
  assert.deepEqual(getClient('scalelab').capacity, { dailyCap: null, windowCap: null, reservedDaily: 0, reservedWindow: 0 });
  assert.deepEqual(getClient('jole').capacity, { dailyCap: 0, windowCap: 0, reservedDaily: 0, reservedWindow: 0 });
});

test('config: a managed client must have explicit caps; a reservation cannot exceed its cap', () => {
  const scalelab = getClient('scalelab');
  const jole = getClient('jole');
  assert.throws(() => buildRegistry([scalelab, { ...jole, capacity: { ...jole.capacity, dailyCap: null } }]), /explicit daily and window caps/);
  assert.throws(() => buildRegistry([scalelab, { ...jole, capacity: { dailyCap: 5, windowCap: 2, reservedDaily: 6, reservedWindow: 0 } }]), /reservedDaily exceeds/);
});

test('JOLE INACTIVE / SENDING DISABLED overrides every capacity calculation', () => {
  const s = state({ caps: { jole: { dailyCap: 500, windowCap: 50, reservedDaily: 100, reservedWindow: 10 } } });
  const verdict = clientCapacityVerdict(s, 'jole');
  assert.equal(verdict.allowed, false);
  // Active since 2026-10-05, but its sending is disabled: no capacity at all.
  assert.equal(verdict.code, 'client_sending_disabled');
  assert.throws(() => consumeClientCapacity(s, 'jole'), error => error.code === 'client_sending_disabled');
  const restore = require('../test-support/client-lifecycle').pendingJoleForTest();
  try {
    assert.equal(clientCapacityVerdict(s, 'jole').code, 'client_inactive');
  } finally { restore(); }
  // A disabled client's reservation holds nothing back from ScaleLab.
  assert.equal(clientCapacityVerdict(s, 'scalelab').remaining, 21);
});

test('ScaleLab with no managed client sending: exactly the global numbers, nothing more restrictive', () => {
  const s = state({ sent: { scalelab: 150 }, env: {} });
  const verdict = clientCapacityVerdict(s, 'scalelab');
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.remaining, 21, 'the window ceiling binds, as it does today');
  const late = state({ sent: { scalelab: 195 }, env: {} });
  assert.equal(clientCapacityVerdict(late, 'scalelab').remaining, 5, 'the daily ceiling binds, as it does today');
  const full = state({ sent: { scalelab: 200 }, env: {} });
  assert.equal(clientCapacityVerdict(full, 'scalelab').code, 'global_daily_cap');
});

test('Jole cannot consume ScaleLab\'s reserved client capacity', () => {
  const enabled = joleEnabled();
  SEND_BLOCK = enabledJole;
  try {
    const s = state({
      sent: { scalelab: 20, jole: 0 },
      caps: { scalelab: { reservedDaily: 150, reservedWindow: 15 }, jole: { dailyCap: 100, windowCap: 10, reservedDaily: 0, reservedWindow: 0 } },
    });
    // Global day 200 − 20 used = 180; ScaleLab still has 130 of its 150 reserved → Jole may take 50.
    // Window 21 with ScaleLab reserving 15 → Jole may take 6 even though its own window cap is 10.
    const verdict = clientCapacityVerdict(s, 'jole');
    assert.equal(verdict.remaining, 6);
    for (let i = 0; i < 6; i += 1) consumeClientCapacity(s, 'jole');
    const blocked = clientCapacityVerdict(s, 'jole');
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.code, 'reserved_for_other_clients');
    // ScaleLab's reserved window capacity is intact.
    assert.equal(clientCapacityVerdict(s, 'scalelab').remaining, 15);
  } finally { enabled.restore(); SEND_BLOCK = clientSendBlock; }
});

test('one client hitting its cap does not block another client while system capacity remains', () => {
  const enabled = joleEnabled();
  SEND_BLOCK = enabledJole;
  try {
    const s = state({ sent: { scalelab: 10, jole: 25 }, caps: { jole: { dailyCap: 25, windowCap: 5, reservedDaily: 0, reservedWindow: 0 } } });
    assert.equal(clientCapacityVerdict(s, 'jole').code, 'client_daily_cap');
    const scalelab = clientCapacityVerdict(s, 'scalelab');
    assert.equal(scalelab.allowed, true);
    assert.equal(scalelab.remaining, 21);
    // Window cap on Jole, same story.
    const w = state({ caps: { jole: { dailyCap: 100, windowCap: 2, reservedDaily: 0, reservedWindow: 0 } } });
    consumeClientCapacity(w, 'jole'); consumeClientCapacity(w, 'jole');
    assert.equal(clientCapacityVerdict(w, 'jole').code, 'client_window_cap');
    assert.equal(clientCapacityVerdict(w, 'scalelab').remaining, 19);
  } finally { enabled.restore(); SEND_BLOCK = clientSendBlock; }
});

test('the global cap still protects the entire service', () => {
  const enabled = joleEnabled();
  SEND_BLOCK = enabledJole;
  try {
    const s = state({ sent: { scalelab: 180, jole: 20 }, caps: { jole: { dailyCap: 100, windowCap: 10, reservedDaily: 0, reservedWindow: 0 } } });
    assert.equal(clientCapacityVerdict(s, 'scalelab').code, 'global_daily_cap');
    assert.equal(clientCapacityVerdict(s, 'jole').code, 'global_daily_cap');
    const w = state({ globalWindow: 3, caps: { jole: { dailyCap: 100, windowCap: 10, reservedDaily: 0, reservedWindow: 0 } } });
    consumeClientCapacity(w, 'scalelab'); consumeClientCapacity(w, 'jole'); consumeClientCapacity(w, 'scalelab');
    assert.equal(clientCapacityVerdict(w, 'jole').code, 'global_window_cap');
    assert.equal(clientCapacityVerdict(w, 'scalelab').code, 'global_window_cap');
  } finally { enabled.restore(); SEND_BLOCK = clientSendBlock; }
});

test('campaign, sender and window limits still apply beneath the client layer', () => {
  // Client layer allows ScaleLab; the sender's own daily limit still refuses.
  const s = state({ env: {} });
  assert.equal(clientCapacityVerdict(s, 'scalelab').allowed, true);
  const sender = { id: 'deniels', email: 'deniels@scalelabai.ca', status: 'active', sendEligible: true, dailyLimit: 20 };
  const lead = { id: 'd', leadNiche: 'dental', senderInboxId: 'deniels', routingRequired: 'true' };
  assert.equal(chooseSender({ lead, senders: [sender], sendsToday: new Map([['deniels', 20]]) }).reason, 'assigned sender daily limit reached');
  // Window quota per sender still refuses independently.
  const quota = createSendingWindowQuota({ senderIds: ['deniels'], perSenderLimit: 2, globalLimit: 21 });
  consumeSendingWindowSuccess(quota, 'deniels'); consumeSendingWindowSuccess(quota, 'deniels');
  assert.equal(sendingWindowVerdict(quota, 'deniels').reason, 'sender scheduled-window limit reached');
});

test('accounting: a delivered send is always recorded, never thrown; unowned sends count against ScaleLab', () => {
  const s = state({ env: {} });
  recordClientSend(s, 'jole');              // disabled client: still recorded (the send happened)
  recordClientSend(s, '');                  // unowned: counted against the default client
  assert.equal(s.dailyUsed.get('jole'), 1);
  assert.equal(s.dailyUsed.get('scalelab'), 1);
  assert.equal(s.dailyTotal, 2);
  const counts = clientSendCountsToday([
    { eventId: 'a', eventType: 'initial_email_sent', occurredAt: '2026-10-01T16:00:00Z', sourceLeadId: 'j1' },
    { eventId: 'b', eventType: 'follow_up_sent', occurredAt: '2026-10-01T16:05:00Z', sourceLeadId: 's1' },
    { eventId: 'c', eventType: 'initial_email_sent', occurredAt: '2026-10-01T16:06:00Z', sourceLeadId: 'unknown' },
    { eventId: 'c', eventType: 'initial_email_sent', occurredAt: '2026-10-01T16:06:00Z', sourceLeadId: 'unknown' },
    { eventId: 'd', eventType: 'ordinary_send_reserved', occurredAt: '2026-10-01T16:07:00Z', sourceLeadId: 's1' },
  ], { dayKey: '2026-10-01', leadsById: new Map([['j1', { id: 'j1', clientId: 'jole' }], ['s1', { id: 's1', clientId: 'scalelab' }]]) });
  assert.deepEqual(Object.fromEntries(counts), { jole: 1, scalelab: 2 });
  assert.equal(clientCapacitySnapshot(state({ env: {} })).jole.blockedBy, 'client_sending_disabled');
});
