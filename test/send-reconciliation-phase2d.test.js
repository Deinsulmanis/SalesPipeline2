'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createMemorySendReservationStore } = require('../integrations/send-reservation-memory');
const { STATUS } = require('../integrations/send-reservation-rules');
const { ordinaryColdActionId, parseOutboundActionId } = require('../integrations/outbound-action-id');
const { sendAuthorization } = require('../integrations/send-authorization');
const {
  reconcileGmailReservation, classifyLegacySheetsReservation, listLegacySheetsReservations,
  operatorRow, plannedCheckpointRepair, SMARTLEAD_LIMITATION,
} = require('../integrations/send-reconciliation');
const { verifyGmailSentMessage } = require('../integrations/gmail-provider-verify');
const { SEQUENCE_EVENTS } = require('../integrations/stage-sequences');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

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
  return {
    id: 'L1', email: 'owner@harbour.test', company: 'Harbour',
    senderInboxId: 'primary', emailStep: '', lastEmailedAt: '',
    ...overrides,
  };
}

function gmailMessage({
  id = 'gm-1', threadId = 'thr-1', from = 'sender@scalelabai.ca',
  to = 'owner@harbour.test', sent = true, occurredAt = '2026-09-16T18:00:00.000Z',
} = {}) {
  return {
    id, threadId, internalDate: String(Date.parse(occurredAt)),
    labelIds: sent ? ['SENT'] : ['INBOX'],
    payload: {
      headers: [
        { name: 'From', value: from },
        { name: 'To', value: to },
        { name: 'Subject', value: 'Demo' },
        { name: 'Message-ID', value: `<${id}@mail.gmail.com>` },
      ],
    },
  };
}

function gmailStub(messages = {}, { errorFor } = {}) {
  const sends = { n: 0 };
  const lists = { n: 0 };
  return {
    sends, lists,
    email: 'sender@scalelabai.ca',
    gmail: {
      users: {
        messages: {
          get: async ({ id }) => {
            if (errorFor) {
              const err = errorFor(id);
              if (err) throw err;
            }
            const found = messages[id];
            if (!found) {
              const missing = new Error('Requested entity was not found.');
              missing.response = { status: 404 };
              throw missing;
            }
            return { data: found };
          },
          send: async () => {
            sends.n += 1;
            throw new Error('reconciliation must never send');
          },
          list: async () => {
            lists.n += 1;
            return { data: { messages: [] } };
          },
        },
      },
    },
  };
}

async function seedSucceeded(store, { actionId = ordinaryColdActionId('L1', 1), providerMessageId = 'gm-1' } = {}) {
  const action = { actionId, leadId: 'L1', actionType: 'gmail_cold_step', provider: 'gmail' };
  assert.equal((await store.reserveOutboundAction(action, { leaseOwner: 'w1', leaseSeconds: 60 })).ok, true);
  assert.equal((await store.markProviderAttemptStarted(actionId, 'w1')).ok, true);
  assert.equal((await store.markProviderSucceeded(actionId, 'w1', { providerMessageId, providerThreadId: 'thr-1' })).ok, true);
  return store.getReservation(actionId);
}

test('Phase 2D source has no send or Smartlead mutation path', () => {
  const recon = read('integrations/send-reconciliation.js');
  const verify = read('integrations/gmail-provider-verify.js');
  const server = read('server.js');
  for (const source of [recon, verify]) {
    assert.doesNotMatch(source, /messages\.send|sendEmail|addLeads|spawnAgent/);
  }
  const route = server.slice(
    server.indexOf("app.post('/api/ops/send-reconciliation'"),
    server.indexOf("app.get('/api/outreach/routing-options'"),
  );
  assert.match(route, /requireAuth/);
  assert.doesNotMatch(route, /messages\.send|sendEmail|addLeads|spawnAgent/);
  assert.match(read('integrations/gmail-stage-sequence.js'), /A null result must never be read as "not sent"/);
});

test('1. provider_message_id exists and Gmail confirms SENT → checkpoint repaired, confirmed, 0 sends', async () => {
  const store = createMemorySendReservationStore();
  await seedSucceeded(store);
  const mailbox = gmailStub({ 'gm-1': gmailMessage() });
  const writes = [];
  const result = await reconcileGmailReservation({
    reservation: await store.getReservation(ordinaryColdActionId('L1', 1)),
    mailbox, lead: lead(), activities: [], store,
    applyCheckpoint: async plan => {
      writes.push(plan);
      return { repaired: true };
    },
  });
  assert.equal(mailbox.sends.n, 0);
  assert.equal(result.sends, 0);
  assert.equal(result.verified, true);
  assert.equal(result.confirmed, true);
  assert.equal(result.repaired, true);
  assert.equal((await store.getReservation(ordinaryColdActionId('L1', 1))).status, STATUS.CONFIRMED);
  assert.equal(writes[0].activity.eventType, 'initial_email_sent');
  assert.equal(writes[0].leadFields.lastEmailedAt, '2026-09-16T18:00:00.000Z');
  assert.equal(writes[0].leadFields.emailStep, '1');
});

test('2. Gmail id missing → reconciliation_required and 0 sends', async () => {
  const store = createMemorySendReservationStore();
  const action = { actionId: ordinaryColdActionId('L1', 1), leadId: 'L1', actionType: 'gmail_cold_step', provider: 'gmail' };
  await store.reserveOutboundAction(action, { leaseOwner: 'w1', leaseSeconds: 60 });
  await store.markProviderAttemptStarted(action.actionId, 'w1');
  await store.markReconciliationRequired(action.actionId, 'timeout');
  const mailbox = gmailStub({});
  const result = await reconcileGmailReservation({
    reservation: await store.getReservation(action.actionId),
    mailbox, lead: lead(), store,
    applyCheckpoint: async () => { throw new Error('must not repair'); },
  });
  assert.equal(mailbox.sends.n, 0);
  assert.equal(result.sends, 0);
  assert.equal(result.confirmed, false);
  assert.equal(result.code, 'provider_id_missing');
  assert.equal((await store.getReservation(action.actionId)).status, STATUS.RECONCILIATION_REQUIRED);
});

test('3. Gmail lookup returns no message → remains unresolved, 0 sends', async () => {
  const store = createMemorySendReservationStore();
  await seedSucceeded(store);
  const mailbox = gmailStub({});
  const result = await reconcileGmailReservation({
    reservation: await store.getReservation(ordinaryColdActionId('L1', 1)),
    mailbox, lead: lead(), store,
    applyCheckpoint: async () => { throw new Error('must not repair'); },
  });
  assert.equal(mailbox.sends.n, 0);
  assert.equal(result.code, 'gmail_message_not_found');
  assert.equal(result.confirmed, false);
  assert.equal((await store.getReservation(ordinaryColdActionId('L1', 1))).status, STATUS.RECONCILIATION_REQUIRED);
});

test('4. Gmail recipient mismatch → remains unresolved, 0 sends', async () => {
  const store = createMemorySendReservationStore();
  await seedSucceeded(store);
  const mailbox = gmailStub({ 'gm-1': gmailMessage({ to: 'other@example.com' }) });
  const result = await reconcileGmailReservation({
    reservation: await store.getReservation(ordinaryColdActionId('L1', 1)),
    mailbox, lead: lead(), store,
  });
  assert.equal(mailbox.sends.n, 0);
  assert.equal(result.code, 'gmail_recipient_mismatch');
  assert.equal(result.confirmed, false);
  assert.equal((await store.getReservation(ordinaryColdActionId('L1', 1))).status, STATUS.RECONCILIATION_REQUIRED);
});

test('5. Gmail sender mismatch → remains unresolved, 0 sends', async () => {
  const store = createMemorySendReservationStore();
  await seedSucceeded(store);
  const mailbox = gmailStub({ 'gm-1': gmailMessage({ from: 'other@scalelabai.ca' }) });
  const result = await reconcileGmailReservation({
    reservation: await store.getReservation(ordinaryColdActionId('L1', 1)),
    mailbox, lead: lead(), store,
  });
  assert.equal(mailbox.sends.n, 0);
  assert.equal(result.code, 'gmail_sender_mismatch');
  assert.equal((await store.getReservation(ordinaryColdActionId('L1', 1))).status, STATUS.RECONCILIATION_REQUIRED);
});

test('6. checkpoint repair succeeds → confirmation recorded once', async () => {
  const store = createMemorySendReservationStore();
  await seedSucceeded(store);
  const mailbox = gmailStub({ 'gm-1': gmailMessage() });
  let confirms = 0;
  const wrapped = {
    markConfirmed: async (...args) => {
      confirms += 1;
      return store.markConfirmed(...args);
    },
    markReconciliationRequired: (...args) => store.markReconciliationRequired(...args),
  };
  const result = await reconcileGmailReservation({
    reservation: await store.getReservation(ordinaryColdActionId('L1', 1)),
    mailbox, lead: lead(), store: wrapped,
    applyCheckpoint: async () => ({ repaired: true }),
  });
  assert.equal(result.confirmed, true);
  assert.equal(confirms, 1);
  assert.equal(mailbox.sends.n, 0);
});

test('7. repeated reconciliation is idempotent', async () => {
  const store = createMemorySendReservationStore();
  await seedSucceeded(store);
  const mailbox = gmailStub({ 'gm-1': gmailMessage() });
  const activities = [];
  const apply = async plan => {
    if (plan.activity) activities.push(plan.activity);
    return { repaired: Boolean(plan.activity) };
  };
  const first = await reconcileGmailReservation({
    reservation: await store.getReservation(ordinaryColdActionId('L1', 1)),
    mailbox, lead: lead(), activities: [], store, applyCheckpoint: apply,
  });
  const second = await reconcileGmailReservation({
    reservation: await store.getReservation(ordinaryColdActionId('L1', 1)),
    mailbox, lead: lead({ emailStep: '1', lastEmailedAt: '2026-09-16T18:00:00.000Z' }),
    activities, store, applyCheckpoint: apply,
  });
  assert.equal(first.confirmed, true);
  assert.equal(second.confirmed, true);
  assert.equal(second.alreadyConfirmed || second.code === 'already_confirmed', true);
  assert.equal(activities.length, 1);
  assert.equal(mailbox.sends.n, 0);
});

test('8. ambiguous timeout never retries', async () => {
  const store = createMemorySendReservationStore();
  await seedSucceeded(store);
  const timeout = new Error('socket hang up');
  timeout.response = { status: 504 };
  const mailbox = gmailStub({}, { errorFor: () => timeout });
  const result = await reconcileGmailReservation({
    reservation: await store.getReservation(ordinaryColdActionId('L1', 1)),
    mailbox, lead: lead(), store,
  });
  assert.equal(result.code, 'gmail_lookup_ambiguous');
  assert.equal(result.retryableSend, false);
  assert.equal(result.confirmed, false);
  assert.equal(mailbox.sends.n, 0);
  assert.equal((await store.getReservation(ordinaryColdActionId('L1', 1))).status, STATUS.RECONCILIATION_REQUIRED);
  const again = await store.reserveOutboundAction({
    actionId: ordinaryColdActionId('L1', 1), leadId: 'L1', actionType: 'gmail_cold_step', provider: 'gmail',
  }, { leaseOwner: 'w2', leaseSeconds: 60 });
  assert.equal(again.ok, false);
});

test('9. expired sending reservation never retries', async () => {
  let now = new Date('2026-09-17T12:00:00Z');
  const store = createMemorySendReservationStore({ now: () => now, leaseSeconds: 10 });
  const action = { actionId: ordinaryColdActionId('L9', 1), leadId: 'L9', actionType: 'gmail_cold_step', provider: 'gmail' };
  await store.reserveOutboundAction(action, { leaseOwner: 'dead' });
  await store.markProviderAttemptStarted(action.actionId, 'dead');
  now = new Date('2026-09-17T12:00:11Z');
  const reservation = await store.getReservation(action.actionId);
  const rec = operatorRow(reservation, now);
  assert.equal(rec.retryableSend, false);
  const mailbox = gmailStub({ 'gm-1': gmailMessage() });
  const result = await reconcileGmailReservation({
    reservation, mailbox, lead: lead({ id: 'L9' }), store, now,
  });
  assert.equal(result.retryableSend, false);
  assert.equal(result.confirmed, false);
  const again = await store.reserveOutboundAction(action, { leaseOwner: 'live' });
  assert.equal(again.ok, false);
  assert.equal(mailbox.sends.n, 0);
});

test('10. legacy Sheets unresolved reservation is never automatically resent', () => {
  const reserved = {
    eventId: 'cold-reserve:L1:step1:attempt1',
    eventType: 'ordinary_send_reserved',
    sourceLeadId: 'L1',
    metadata: JSON.stringify({ leadId: 'L1', step: 1 }),
  };
  const unclassified = classifyLegacySheetsReservation(reserved, [reserved]);
  assert.equal(unclassified.classification, 'unresolved_manual_review');
  assert.equal(unclassified.retryableSend, false);
  const failed = classifyLegacySheetsReservation(reserved, [
    reserved,
    { eventType: 'ordinary_send_failed', metadata: JSON.stringify({ reservationEventId: reserved.eventId }) },
  ]);
  assert.equal(failed.classification, 'provably_failed_pre_delivery');
  const sent = classifyLegacySheetsReservation(reserved, [
    reserved,
    { eventType: 'initial_email_sent', sourceLeadId: 'L1', metadata: JSON.stringify({ leadId: 'L1', step: 1 }) },
  ]);
  assert.equal(sent.classification, 'provably_sent');
  const listed = listLegacySheetsReservations([reserved]);
  assert.equal(listed[0].retryableSend, false);
  assert.doesNotMatch(read('integrations/send-reconciliation.js'), /automatically resend|retry send|messages\.send/);
});

test('11. unauthorized environment can reconcile reads but cannot send', async () => {
  const env = authorizedEnv({ SENDING_ENABLED: 'false' });
  const verdict = sendAuthorization(env);
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, 'sending_disabled');
  const store = createMemorySendReservationStore();
  await seedSucceeded(store);
  const mailbox = gmailStub({ 'gm-1': gmailMessage() });
  const result = await reconcileGmailReservation({
    reservation: await store.getReservation(ordinaryColdActionId('L1', 1)),
    mailbox, lead: lead(), store,
    applyCheckpoint: async () => ({ repaired: true }),
  });
  assert.equal(result.confirmed, true);
  assert.equal(result.sends, 0);
  assert.equal(mailbox.sends.n, 0);
  assert.equal(sendAuthorization(env).allowed, false);
});

test('operator rows expose age, provider id presence, and never recommend retry', async () => {
  const store = createMemorySendReservationStore();
  await seedSucceeded(store);
  const row = operatorRow(await store.getReservation(ordinaryColdActionId('L1', 1)));
  assert.equal(row.providerMessageIdPresent, true);
  assert.equal(row.retryableSend, false);
  assert.equal(row.recommendedAction, 'verify_gmail_and_confirm_checkpoint');
  const smartlead = operatorRow({
    actionId: 'smartlead-enqueue:L1:99', leadId: 'L1', provider: 'smartlead',
    status: STATUS.SENT_UNCONFIRMED, providerMessageId: 'lead-1', reservedAt: new Date().toISOString(),
  });
  assert.equal(smartlead.recommendedAction, 'manual_review_smartlead');
  assert.match(SMARTLEAD_LIMITATION, /manual-only/);
});

test('Gmail verification uses the real provider id and does not treat rfc lookup miss as not sent', async () => {
  const mailbox = gmailStub({ 'gm-1': gmailMessage() });
  const proof = await verifyGmailSentMessage({
    gmail: mailbox.gmail, providerMessageId: 'gm-1',
    expectedSenderEmail: 'sender@scalelabai.ca', expectedRecipientEmail: 'owner@harbour.test',
  });
  assert.equal(proof.ok, true);
  assert.equal(mailbox.lists.n, 0);
  assert.equal(parseOutboundActionId(ordinaryColdActionId('L1', 2)).step, 2);
  const sequencePlan = plannedCheckpointRepair({
    reservation: { actionId: 'seq:CE-L1:hot_stale_v1:1' },
    proof: { providerMessageId: 'gm-9', threadId: 't', occurredAt: '2026-09-16T18:00:00.000Z', subject: 'Hi' },
    lead: lead(), activities: [],
  });
  assert.equal(sequencePlan.activity.eventType, SEQUENCE_EVENTS.STEP_SENT);
  assert.equal(sequencePlan.leadFields, null);
});
