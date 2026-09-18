'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createMemorySendReservationStore } = require('../integrations/send-reservation-memory');
const {
  setSendReservationStoreForTests, closeSendReservationStore,
  withOutboundReservation, confirmOutboundReservation, getOutboundReservation,
  isDefinitePreDeliveryFailure,
} = require('../integrations/send-lock');
const { sendAuthorization } = require('../integrations/send-authorization');
const { guardProviderSend } = require('../integrations/send-safety-revalidate');
const { ordinaryColdActionId, smartleadEnqueueActionId, warmReplyActionId } = require('../integrations/outbound-action-id');
const { STATUS } = require('../integrations/send-reservation-rules');

function authorizedEnv(extra = {}) {
  return {
    SENDING_ENABLED: 'true',
    RAILWAY_ENVIRONMENT: 'prod-sender',
    SEND_AUTHORIZED_ENV: 'prod-sender',
    SEND_AUTHORIZED_TOKEN: 'test-sender-token',
    SEND_WORKER_ROLE: 'outreach-sender',
    SEND_LOCK_ENABLED: 'true',
    ...extra,
  };
}

function lead(overrides = {}) {
  return { id: 'L1', email: 'owner@harbour.test', notes: '', stage: 'Queued', emailStatus: '', ...overrides };
}

async function guardedProviderSend({ action, current, suppressed = new Set(), env = authorizedEnv(), provider }) {
  const auth = sendAuthorization(env);
  if (!auth.allowed) return { sent: 0, code: auth.code, reason: auth.reason };
  const gate = await guardProviderSend(current || lead(), {
    env,
    loadFreshLead: async () => current || lead(),
    loadSuppressedEmails: async () => suppressed,
  }, { purpose: action.actionType === 'gmail_sequence_step' ? 'sequence' : 'cold' });
  if (!gate.allowed) return { sent: 0, code: gate.code, reason: gate.reason };
  try {
    const result = await withOutboundReservation(action, provider, env);
    return { sent: 1, result };
  } catch (error) {
    return { sent: 0, code: error.code, reason: error.message, error };
  }
}

test.afterEach(async () => {
  await closeSendReservationStore();
});

test('1. two concurrent workers: exactly one reservation and one provider call', async () => {
  setSendReservationStoreForTests(createMemorySendReservationStore());
  const action = { actionId: ordinaryColdActionId('L1', 1), leadId: 'L1', actionType: 'gmail_cold_step', provider: 'gmail' };
  let calls = 0;
  const provider = async () => { calls += 1; return { data: { id: 'm1', threadId: 't1' } }; };
  const [a, b] = await Promise.all([
    guardedProviderSend({ action, provider }),
    guardedProviderSend({ action, provider }),
  ]);
  const sent = a.sent + b.sent;
  assert.equal(sent, 1);
  assert.equal(calls, 1);
  const denied = a.sent ? b : a;
  assert.match(String(denied.code), /reservation_/);
});

test('2. rolling deploy overlap: worker B cannot send after A reserved', async () => {
  const store = createMemorySendReservationStore();
  setSendReservationStoreForTests(store);
  const action = { actionId: ordinaryColdActionId('L9', 1), leadId: 'L9', actionType: 'gmail_cold_step', provider: 'gmail' };
  await store.reserveOutboundAction(action, { leaseOwner: 'deploy-a', leaseSeconds: 120 });
  let calls = 0;
  const out = await guardedProviderSend({ action, provider: async () => { calls += 1; return { data: { id: 'm' } }; } });
  assert.equal(out.sent, 0);
  assert.equal(calls, 0);
});

test('3. crash after reserve before provider attempt: takeover only if attempt is null', async () => {
  let now = new Date('2026-09-17T12:00:00Z');
  const store = createMemorySendReservationStore({ now: () => now, leaseSeconds: 10 });
  setSendReservationStoreForTests(store);
  const action = { actionId: ordinaryColdActionId('L3', 1), leadId: 'L3', actionType: 'gmail_cold_step', provider: 'gmail' };
  assert.equal((await store.reserveOutboundAction(action, { leaseOwner: 'dead' })).ok, true);
  now = new Date('2026-09-17T12:00:11Z');
  let calls = 0;
  const out = await withOutboundReservation(action, async () => { calls += 1; return { data: { id: 'm3' } }; }, authorizedEnv());
  assert.equal(calls, 1);
  assert.equal(out.data.id, 'm3');
});

test('4. crash after provider attempt began: expired lease is not sendable', async () => {
  let now = new Date('2026-09-17T12:00:00Z');
  const store = createMemorySendReservationStore({ now: () => now, leaseSeconds: 10 });
  setSendReservationStoreForTests(store);
  const action = { actionId: ordinaryColdActionId('L4', 1), leadId: 'L4', actionType: 'gmail_cold_step', provider: 'gmail' };
  await store.reserveOutboundAction(action, { leaseOwner: 'dead' });
  await store.markProviderAttemptStarted(action.actionId, 'dead');
  now = new Date('2026-09-17T12:00:11Z');
  let calls = 0;
  await assert.rejects(
    withOutboundReservation(action, async () => { calls += 1; return { data: { id: 'nope' } }; }, authorizedEnv()),
    /reconcil|sending|not automatically sendable/i,
  );
  assert.equal(calls, 0);
  const row = await store.getReservation(action.actionId);
  assert.equal(row.status, STATUS.RECONCILIATION_REQUIRED);
});

test('5. Gmail success then crash before Sheets checkpoint blocks resend', async () => {
  const store = createMemorySendReservationStore();
  setSendReservationStoreForTests(store);
  const action = { actionId: ordinaryColdActionId('L5', 1), leadId: 'L5', actionType: 'gmail_cold_step', provider: 'gmail' };
  const result = await withOutboundReservation(action, async () => ({ data: { id: 'gmail-9', threadId: 'thr-9' } }), authorizedEnv());
  assert.equal(result.data.id, 'gmail-9');
  const row = await getOutboundReservation(action.actionId, authorizedEnv());
  assert.equal(row.status, STATUS.SENT_UNCONFIRMED);
  assert.equal(row.providerMessageId, 'gmail-9');
  let calls = 0;
  await assert.rejects(withOutboundReservation(action, async () => { calls += 1; }, authorizedEnv()));
  assert.equal(calls, 0);
});

test('6. Gmail success + Sheets checkpoint failure still keeps provider id', async () => {
  const store = createMemorySendReservationStore();
  setSendReservationStoreForTests(store);
  const action = { actionId: ordinaryColdActionId('L6', 1), leadId: 'L6', actionType: 'gmail_cold_step', provider: 'gmail' };
  await withOutboundReservation(action, async () => ({ data: { id: 'gmail-6', threadId: 't6' } }), authorizedEnv());
  const sheetsOk = false;
  if (sheetsOk) await confirmOutboundReservation(action.actionId, authorizedEnv());
  const row = await getOutboundReservation(action.actionId, authorizedEnv());
  assert.equal(row.status, STATUS.SENT_UNCONFIRMED);
  assert.equal(row.providerMessageId, 'gmail-6');
  let calls = 0;
  await assert.rejects(withOutboundReservation(action, async () => { calls += 1; }, authorizedEnv()));
  assert.equal(calls, 0);
});

test('7. ambiguous Gmail timeout is not automatically retryable', async () => {
  const store = createMemorySendReservationStore();
  setSendReservationStoreForTests(store);
  const action = { actionId: ordinaryColdActionId('L7', 1), leadId: 'L7', actionType: 'gmail_cold_step', provider: 'gmail' };
  const timeout = new Error('socket hang up');
  timeout.response = { status: 504 };
  await assert.rejects(withOutboundReservation(action, async () => { throw timeout; }, authorizedEnv()));
  const row = await store.getReservation(action.actionId);
  assert.equal(row.status, STATUS.RECONCILIATION_REQUIRED);
  let calls = 0;
  await assert.rejects(withOutboundReservation(action, async () => { calls += 1; }, authorizedEnv()));
  assert.equal(calls, 0);
  assert.equal(isDefinitePreDeliveryFailure(timeout), false);
});

test('8. definite pre-delivery 4xx can be retried after failed_pre_delivery', async () => {
  const store = createMemorySendReservationStore();
  setSendReservationStoreForTests(store);
  const action = { actionId: ordinaryColdActionId('L8', 1), leadId: 'L8', actionType: 'gmail_cold_step', provider: 'gmail' };
  const rejected = new Error('invalid to');
  rejected.response = { status: 400 };
  await assert.rejects(withOutboundReservation(action, async () => { throw rejected; }, authorizedEnv()));
  assert.equal((await store.getReservation(action.actionId)).status, STATUS.FAILED_PRE_DELIVERY);
  let calls = 0;
  const retry = await withOutboundReservation(action, async () => { calls += 1; return { data: { id: 'm8' } }; }, authorizedEnv());
  assert.equal(calls, 1);
  assert.equal(retry.data.id, 'm8');
});

test('9. suppression after selection prevents reservation and send', async () => {
  setSendReservationStoreForTests(createMemorySendReservationStore());
  const action = { actionId: ordinaryColdActionId('L1', 1), leadId: 'L1', actionType: 'gmail_cold_step', provider: 'gmail' };
  let calls = 0;
  const out = await guardedProviderSend({
    action,
    current: lead(),
    suppressed: new Set(['owner@harbour.test']),
    provider: async () => { calls += 1; return { data: { id: 'x' } }; },
  });
  assert.equal(out.sent, 0);
  assert.equal(calls, 0);
  assert.equal(out.code, 'suppressed');
});

test('10. manual hold after snapshot yields 0 provider sends', async () => {
  setSendReservationStoreForTests(createMemorySendReservationStore());
  const action = { actionId: ordinaryColdActionId('L1', 1), leadId: 'L1', actionType: 'gmail_cold_step', provider: 'gmail' };
  let calls = 0;
  const out = await guardedProviderSend({
    action,
    current: lead({ notes: '[MANUAL HOLD] operator paused' }),
    provider: async () => { calls += 1; return { data: { id: 'x' } }; },
  });
  assert.equal(out.sent, 0);
  assert.equal(calls, 0);
  assert.equal(out.code, 'manual_hold');
});

test('11. unauthorized process makes 0 provider calls and acquires no reservation', async () => {
  const store = createMemorySendReservationStore();
  setSendReservationStoreForTests(store);
  const action = { actionId: ordinaryColdActionId('L1', 1), leadId: 'L1', actionType: 'gmail_cold_step', provider: 'gmail' };
  let calls = 0;
  const out = await guardedProviderSend({
    action,
    env: { SENDING_ENABLED: 'true', RAILWAY_ENVIRONMENT: 'preview' },
    provider: async () => { calls += 1; return { data: { id: 'x' } }; },
  });
  assert.equal(out.sent, 0);
  assert.equal(calls, 0);
  assert.equal(await store.getReservation(action.actionId), null);
});

test('12. lock database unavailable with locking required: 0 provider calls', async () => {
  setSendReservationStoreForTests({
    async health() { return { ok: false, code: 'lock_database_unavailable', reason: 'send lock database is unreachable' }; },
  });
  const action = { actionId: ordinaryColdActionId('L12', 1), leadId: 'L12', actionType: 'gmail_cold_step', provider: 'gmail' };
  let calls = 0;
  const out = await guardedProviderSend({
    action,
    provider: async () => { calls += 1; return { data: { id: 'x' } }; },
  });
  assert.equal(out.sent, 0);
  assert.equal(calls, 0);
  assert.equal(out.code, 'lock_database_unavailable');
});

test('13. lock schema missing: 0 provider calls', async () => {
  setSendReservationStoreForTests({
    async health() { return { ok: false, code: 'lock_schema_missing', reason: 'outbound_send_reservations table is missing' }; },
  });
  const action = { actionId: ordinaryColdActionId('L13', 1), leadId: 'L13', actionType: 'gmail_cold_step', provider: 'gmail' };
  let calls = 0;
  const out = await guardedProviderSend({
    action,
    provider: async () => { calls += 1; },
  });
  assert.equal(out.sent, 0);
  assert.equal(calls, 0);
  assert.equal(out.code, 'lock_schema_missing');
});

test('14. earlier confirmed action: 0 provider calls', async () => {
  const store = createMemorySendReservationStore();
  setSendReservationStoreForTests(store);
  const action = { actionId: ordinaryColdActionId('L14', 1), leadId: 'L14', actionType: 'gmail_cold_step', provider: 'gmail' };
  await withOutboundReservation(action, async () => ({ data: { id: 'old' } }), authorizedEnv());
  await confirmOutboundReservation(action.actionId, authorizedEnv());
  let calls = 0;
  await assert.rejects(withOutboundReservation(action, async () => { calls += 1; }, authorizedEnv()));
  assert.equal(calls, 0);
});

test('15. Smartlead duplicate enqueue race: exactly one addLeads call', async () => {
  setSendReservationStoreForTests(createMemorySendReservationStore());
  const action = { actionId: smartleadEnqueueActionId('L15', 'camp-1'), leadId: 'L15', actionType: 'smartlead_enqueue', provider: 'smartlead' };
  let calls = 0;
  const addLeads = async () => { calls += 1; return { added_count: 1, lead_ids: ['ext-1'] }; };
  const results = await Promise.allSettled([
    withOutboundReservation(action, addLeads, authorizedEnv()),
    withOutboundReservation(action, addLeads, authorizedEnv()),
  ]);
  assert.equal(calls, 1);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.filter(item => item.status === 'rejected').length, 1);
});

test('16. warm reply duplicate race: exactly one Gmail send', async () => {
  setSendReservationStoreForTests(createMemorySendReservationStore());
  const action = {
    actionId: warmReplyActionId('L16', 'inbound-9', 'AUTO_BOOKING_RESPONSE'),
    leadId: 'L16', actionType: 'gmail_warm_reply', provider: 'gmail',
  };
  let calls = 0;
  const send = async () => { calls += 1; return { data: { id: 'wm', threadId: 'wt' } }; };
  await Promise.allSettled([
    withOutboundReservation(action, send, authorizedEnv()),
    withOutboundReservation(action, send, authorizedEnv()),
  ]);
  assert.equal(calls, 1);
});

test('17. different leads proceed independently', async () => {
  setSendReservationStoreForTests(createMemorySendReservationStore());
  let calls = 0;
  const send = id => withOutboundReservation(
    { actionId: ordinaryColdActionId(id, 1), leadId: id, actionType: 'gmail_cold_step', provider: 'gmail' },
    async () => { calls += 1; return { data: { id } }; },
    authorizedEnv(),
  );
  await Promise.all([send('A'), send('B'), send('C')]);
  assert.equal(calls, 3);
});

test('18. lease owner cannot mutate another live owner reservation', async () => {
  const store = createMemorySendReservationStore();
  setSendReservationStoreForTests(store);
  const action = { actionId: ordinaryColdActionId('L18', 1), leadId: 'L18', actionType: 'gmail_cold_step', provider: 'gmail' };
  await store.reserveOutboundAction(action, { leaseOwner: 'owner-a', leaseSeconds: 120 });
  const started = await store.markProviderAttemptStarted(action.actionId, 'owner-b');
  assert.equal(started.ok, false);
  assert.equal(started.code, 'reservation_not_owned');
});

test('19. expired lease with provider_attempt_started_at never becomes sendable', async () => {
  let now = new Date('2026-09-17T12:00:00Z');
  const store = createMemorySendReservationStore({ now: () => now, leaseSeconds: 5 });
  setSendReservationStoreForTests(store);
  const action = { actionId: ordinaryColdActionId('L19', 1), leadId: 'L19', actionType: 'gmail_cold_step', provider: 'gmail' };
  await store.reserveOutboundAction(action, { leaseOwner: 'w1' });
  await store.markProviderAttemptStarted(action.actionId, 'w1');
  now = new Date('2026-09-17T12:01:00Z');
  let calls = 0;
  await assert.rejects(withOutboundReservation(action, async () => { calls += 1; }, authorizedEnv()));
  assert.equal(calls, 0);
});

test('provider paths pass a durable action id at every real send boundary', () => {
  const agent = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(agent, /withGmailProviderSend\(/);
  assert.match(agent, /ordinaryColdActionId\(lead\.id, step\)/);
  assert.match(agent, /stageSequenceActionId\(boardLead\.id, verdict\.sequenceId, step\)/);
  assert.match(agent, /smartleadEnqueueActionId\(lead\.id, mapping\.externalCampaignId\)/);
  assert.match(agent, /actionType: 'gmail_warm_reply'/);
  assert.match(server, /smartleadEnqueueActionId\(found\.lead\.id, mapping\.externalCampaignId\)/);
  assert.match(server, /withOutboundReservation\(sendAction/);
  const gmailSeq = fs.readFileSync(path.join(__dirname, '..', 'integrations', 'gmail-stage-sequence.js'), 'utf8');
  assert.match(gmailSeq, /async function findSuccessfulSequenceSend\(\{ gmail, rfcMessageId \}\)/);
});
