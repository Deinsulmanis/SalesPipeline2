'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('dotenv');
const {
  configuredSenders, chooseSender, senderCountsToday, successfulSendCountToday,
} = require('../integrations/gmail-sender-routing');
const { capacityFromEnv } = require('../integrations/gmail-sender-capacity');
const { stageSendGate } = require('../integrations/pipeline-sequence-safety');
const { normalizeEvent } = require('../integrations/smartlead-events');

// Read the checked-in deployment settings, never local credentials or live APIs.
const env = {
  ...parse(fs.readFileSync(path.join(__dirname, '..', '.env.example'))),
  FROM_EMAIL: 'deins@scalelabai.ca',
};
const senders = configuredSenders(env);
const primary = senders.find(sender => sender.id === 'primary');
const secondary = senders.find(sender => sender.id === 'tryscalelabai');
const capacity = capacityFromEnv(senders, env);

function gate(sender, senderCount, globalCount, globalLimit = capacity.globalDailyLimit) {
  return stageSendGate({
    sendingEnabled: true, senderProof: { ok: true }, sender,
    thread: { threadId: 'test-thread' }, threadVerified: true, observationOk: true,
    senderCount, globalCount, globalLimit,
  });
}

test('deployment settings resolve to 50 per established sender / 100 total with other mailbox caps unchanged', () => {
  // The 110 ceiling makes room for deniels; until it is activated the live
  // limit is still the active sum of 100.
  assert.equal(primary.email, 'deins@scalelabai.ca');
  assert.equal(primary.dailyLimit, 50);
  assert.equal(secondary.email, 'deins@tryscalelabai.ca');
  assert.equal(secondary.dailyLimit, 50);
  assert.equal(capacity.dailyCeiling, 110);
  assert.equal(capacity.dailySum, 100);
  assert.equal(capacity.globalDailyLimit, 100);
  assert.equal(capacity.globalPerRunLimit, 10);
  assert.deepEqual(senders.filter(sender => sender.id !== 'primary').map(sender => ({
    email: sender.email, dailyLimit: sender.dailyLimit, perRunLimit: sender.perRunLimit,
    status: sender.status,
  })), [
    { email: 'deins@tryscalelabai.ca', dailyLimit: 50, perRunLimit: 5, status: 'active' },
    { email: 'deins@scalelabaiteam.com', dailyLimit: 40, perRunLimit: 5, status: 'warming' },
    { email: 'deniels@scalelabai.ca', dailyLimit: 10, perRunLimit: 2, status: 'warming' },
    { email: 'deniels@tryscalelabai.ca', dailyLimit: 10, perRunLimit: 2, status: 'warming' },
  ]);
});

for (const sender of [primary, secondary]) {
  test(`${sender.email}: initial and pinned follow-up routing permit send 50 and reject send 51`, () => {
    for (const step of [1, 2]) {
      const lead = {
        id: 'boundary', tradeType: 'Dental', senderInboxId: sender.id,
        emailStep: step - 1, emailStatus: step === 2 ? 'emailed' : '',
      };
      const route = count => chooseSender({ lead, step, senders, sendsToday: new Map([[sender.id, count]]) });
      assert.equal(route(49).sender.id, sender.id);
      for (const count of [50, 51, 100]) {
        assert.equal(route(count).sender, null);
        assert.match(route(count).reason, /daily limit reached/);
      }
    }
  });
}

test('sender and global gates independently refuse authorization at their boundaries', () => {
  for (const sender of [primary, secondary]) {
    assert.equal(gate(sender, 49, 99).allowed, true);
    assert.equal(gate(sender, 50, 50).code, 'sender_quota');
    assert.equal(gate(sender, 51, 51).code, 'sender_quota');
    assert.equal(gate(sender, 30, 100).code, 'global_quota');
    assert.equal(gate(sender, 30, 101).code, 'global_quota');
  }
});

test('successful campaign sends stop at 50 per sender and 100 combined across repeated passes', () => {
  const counts = new Map();
  let total = 0;
  for (let pass = 0; pass < 100; pass++) {
    for (const sender of senders.filter(item => item.sendEligible)) {
      const count = counts.get(sender.id) || 0;
      if (!gate(sender, count, total).allowed) continue;
      // The existing serialized send loop consumes quota on provider success.
      counts.set(sender.id, count + 1);
      total++;
    }
  }
  assert.equal(counts.get('primary'), 50);
  assert.equal(counts.get('tryscalelabai'), 50);
  assert.equal(total, 100);
});

test('global cap still stops at 110 when active sender capacity totals 140', () => {
  // Hypothetical activation in this fixture only; no live sender status changes.
  const expanded = configuredSenders({
    ...env, GMAIL_SENDER_RUNTIME_JSON: JSON.stringify([{ id: 'scalelabaiteam', status: 'active' }]),
  });
  const expandedCapacity = capacityFromEnv(expanded, env);
  assert.equal(expandedCapacity.dailySum, 140);
  assert.equal(expandedCapacity.globalDailyLimit, 110);
  const counts = new Map();
  let total = 0;
  for (let pass = 0; pass < 100; pass++) {
    for (const sender of expanded.filter(item => item.sendEligible)) {
      const count = counts.get(sender.id) || 0;
      if (!gate(sender, count, total, expandedCapacity.globalDailyLimit).allowed) continue;
      counts.set(sender.id, count + 1);
      total++;
    }
  }
  assert.equal(total, 110);
  assert.deepEqual([...counts.values()], [37, 37, 36]);
  for (const sender of expanded.filter(item => item.sendEligible)) {
    assert.ok(counts.get(sender.id) < sender.dailyLimit);
    assert.equal(gate(sender, counts.get(sender.id), total).code, 'global_quota');
  }
});

test('campaign counters exclude warm-up activity, deduplicate successes and use Vancouver days', () => {
  const sent = {
    eventId: 'campaign-1', eventType: 'initial_email_sent',
    occurredAt: '2026-09-22T06:59:00Z', metadata: JSON.stringify({ senderInboxId: 'primary' }),
  };
  const events = [sent, { ...sent },
    { ...sent, eventId: 'next-day', occurredAt: '2026-09-22T07:00:00Z' },
    ...['warmup_sent', 'smartlead_warmup_sent', 'WARMUP_EMAIL_SENT'].map(eventType => ({
      ...sent, eventId: eventType, eventType,
    })),
  ];
  assert.equal(successfulSendCountToday(events, '2026-09-21'), 1);
  assert.equal(senderCountsToday(events, '2026-09-21').get('primary'), 1);
  assert.equal(successfulSendCountToday(events, '2026-09-22'), 1);
  assert.equal(normalizeEvent({ event_type: 'WARMUP_EMAIL_SENT' }).status, 'Ignored');
});

test('existing daily accounting counts successes rather than outstanding authorizations', () => {
  const events = ['ordinary_send_reserved', 'prospect_reply_reserved', 'sequence_send_reserved'].map(eventType => ({
    eventId: eventType, eventType, occurredAt: '2026-09-21T18:00:00Z',
    metadata: JSON.stringify({ senderInboxId: 'tryscalelabai' }),
  }));
  assert.equal(successfulSendCountToday(events, '2026-09-21'), 0);
  assert.equal(senderCountsToday(events, '2026-09-21').size, 0);
  events.push({
    eventId: 'delivered', eventType: 'initial_email_sent', occurredAt: '2026-09-21T18:01:00Z',
    metadata: JSON.stringify({ senderInboxId: 'tryscalelabai' }),
  });
  assert.equal(successfulSendCountToday(events, '2026-09-21'), 1);
  assert.equal(senderCountsToday(events, '2026-09-21').get('tryscalelabai'), 1);
});
