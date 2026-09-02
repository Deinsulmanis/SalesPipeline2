'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { configuredSenders, chooseSender, pinnedSenderId, senderCountsToday } = require('../integrations/gmail-sender-routing');

const env = {
  FROM_EMAIL: 'a@example.com', GMAIL_TOKEN_JSON: '{}', GMAIL_PRIMARY_DAILY_LIMIT: '20',
  GMAIL_INBOX_REGISTRY_JSON: JSON.stringify([{ id: 'b', email: 'b@example.com', status: 'active', tokenEnv: 'GMAIL_B_TOKEN_JSON', dailyLimit: 20 }]),
  GMAIL_B_TOKEN_JSON: '{}',
};
const dental = { id: 'L', tradeType: 'Dental' };
const activity = (senderInboxId, type = 'initial_email_sent') => ({ eventType: type, sourceLeadId: 'L', occurredAt: '2026-09-01T17:00:00Z', metadata: JSON.stringify({ senderInboxId }) });

test('both independently credentialed active senders are eligible for dental', () => assert.deepEqual(configuredSenders(env).map(s => [s.id,s.sendEligible]), [['primary',true],['b',true]]));
test('least-used policy deterministically distributes new dental leads', () => assert.equal(chooseSender({ lead:dental,senders:configuredSenders(env),sendsToday:new Map([['primary',2],['b',1]]) }).sender.id, 'b'));
test('first successful sender evidence pins all follow-ups', () => assert.equal(chooseSender({ lead:dental,activities:[activity('b')],senders:configuredSenders(env),step:2 }).sender.id, 'b'));
test('follow-up cannot migrate when its sender is exhausted', () => assert.equal(chooseSender({ lead:dental,activities:[activity('b')],senders:configuredSenders(env),sendsToday:new Map([['b',20]]),step:2 }).sender, null));
test('missing follow-up sender fails closed', () => assert.throws(() => chooseSender({ lead:dental,senders:configuredSenders(env),step:2 }), /no proven sender/));
test('cross-sender ownership evidence is a hard conflict', () => assert.throws(() => pinnedSenderId(dental,[activity('primary'),activity('b','follow_up_sent')]), /conflict/));
test('successful-send accounting is independent per inbox', () => assert.deepEqual([...senderCountsToday([activity('primary'),activity('b')],'2026-09-01')], [['primary',1],['b',1]]));
test('non-dental routes remain primary-only', () => assert.equal(chooseSender({ lead:{id:'R',tradeType:'Roofing'},senders:configuredSenders(env) }).sender.id,'primary'));
