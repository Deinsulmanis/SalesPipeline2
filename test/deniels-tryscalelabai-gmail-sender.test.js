'use strict';

/**
 * deniels@tryscalelabai.ca as a dormant Gmail sender, following the deniels
 * pattern. Fixtures are production-shaped: primary, tryscalelabai and deniels
 * active (deniels via the runtime overlay the Activate Sender button writes)
 * for 110/day and 12/run, with this mailbox registered but warming.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('dotenv');

const { parseRegistry, withDefaultInboxes, credentialsFor } = require('../integrations/gmail-inbox-registry');
const {
  configuredSenders, observableSenders, chooseSender, allowedForLead, senderCountsToday,
} = require('../integrations/gmail-sender-routing');
const { capacityFromEnv } = require('../integrations/gmail-sender-capacity');
const { markWarmupReady, activationBlockers, activateSender } = require('../integrations/gmail-sender-lifecycle');
const {
  createSendingWindowQuota, consumeSendingWindowSuccess, sendingWindowVerdict, sendingWindowRemainingBySender,
} = require('../integrations/sending-window-quota');
const { observerHealth } = require('../integrations/gmail-observer-health');
const { createMemorySendReservationStore } = require('../integrations/send-reservation-memory');
const { STATUS } = require('../integrations/send-reservation-rules');
const { ordinaryColdActionId } = require('../integrations/outbound-action-id');
const { reconcileGmailReservation } = require('../integrations/send-reconciliation');

const ID = 'deniels_tryscalelabai';
const EMAIL = 'deniels@tryscalelabai.ca';
const TOKEN_ENV = 'GMAIL_DENIELS_TRYSCALELABAI_TOKEN_JSON';
const root = path.join(__dirname, '..');

const base = { ...parse(fs.readFileSync(path.join(root, '.env.example'))), FROM_EMAIL: 'deins@scalelabai.ca' };
// Production today: the registry variable lists tryscalelabai only, deniels is
// active through the runtime overlay, ceiling 110.
const PRODUCTION = {
  ...base,
  GMAIL_INBOX_REGISTRY_JSON: JSON.stringify([
    { id: 'tryscalelabai', email: 'deins@tryscalelabai.ca', status: 'active', tokenEnv: 'GMAIL_TRYSCALELABAI_TOKEN_JSON', dailyLimit: 50, perRunLimit: 5 },
  ]),
  GMAIL_SENDER_RUNTIME_JSON: JSON.stringify([{ id: 'deniels', status: 'active' }]),
  GMAIL_GLOBAL_DAILY_CEILING: '110',
};
const activated = ceiling => ({
  ...PRODUCTION, GMAIL_GLOBAL_DAILY_CEILING: String(ceiling),
  GMAIL_SENDER_RUNTIME_JSON: JSON.stringify([{ id: 'deniels', status: 'active' }, { id: ID, status: 'active' }]),
});
const byId = (senders, id) => senders.find(sender => sender.id === id);
const sender = (env = PRODUCTION) => byId(configuredSenders(env), ID);
const capacity = env => capacityFromEnv(configuredSenders(env), env);
const sent = (leadId, senderInboxId) => ({
  eventId: `${leadId}-${senderInboxId}`, eventType: 'initial_email_sent', sourceLeadId: leadId,
  occurredAt: '2026-09-23T15:00:00Z', metadata: JSON.stringify({ senderInboxId }),
});
const healthyObserver = { senderInboxId: ID, health: 'healthy', cursorState: 'present', historyId: '1', quotaBackoff: false };
const healthyAuth = { authenticated: true, identityVerified: true };

test('registered with its own id, address and credential variable, even when the registry variable omits it', () => {
  const entry = byId(withDefaultInboxes(parseRegistry(PRODUCTION.GMAIL_INBOX_REGISTRY_JSON)), ID);
  assert.deepEqual(
    { email: entry.email, tokenEnv: entry.tokenEnv, status: entry.status, dailyLimit: entry.dailyLimit, perRunLimit: entry.perRunLimit, observerEnabled: entry.observerEnabled },
    { email: EMAIL, tokenEnv: TOKEN_ENV, status: 'warming', dailyLimit: 10, perRunLimit: 2, observerEnabled: true },
  );
  const senders = configuredSenders(PRODUCTION);
  for (const key of ['id', 'email', 'tokenEnv']) {
    assert.equal(new Set(senders.map(item => item[key])).size, senders.length, `${key} is unique`);
  }
  assert.notEqual(sender().id, 'deniels');
  assert.equal(TOKEN_ENV, `GMAIL_${ID.toUpperCase()}_TOKEN_JSON`, 'same id → variable convention as the other inboxes');
});

test('warming: never eligible, never routed to, and an explicit assignment is refused', () => {
  const inbox = sender();
  assert.equal(inbox.status, 'warming');
  assert.equal(inbox.sendEligible, false);
  assert.equal(allowedForLead(inbox, { tradeType: 'Dental' }), false);
  const idle = new Map([[ID, 0], ['primary', 49], ['tryscalelabai', 49], ['deniels', 9]]);
  assert.notEqual(chooseSender({ lead: { id: 'N', tradeType: 'Dental' }, senders: configuredSenders(PRODUCTION), sendsToday: idle }).sender?.id, ID);
  assert.throws(() => chooseSender({ lead: { id: 'N', tradeType: 'Dental', senderInboxId: ID }, senders: configuredSenders(PRODUCTION) }), /not delivery eligible/);
  // Even an activation row cannot make it send without its own credential.
  const { [TOKEN_ENV]: _omit, ...noCredential } = activated(120);
  assert.equal(sender(noCredential).sendEligible, false);
});

test('contributes 0 capacity while warming, including after the ceiling is raised to 120', () => {
  assert.deepEqual(
    (({ activeCount, dailySum, globalDailyLimit, globalPerRunLimit }) => ({ activeCount, dailySum, globalDailyLimit, globalPerRunLimit }))(capacity(PRODUCTION)),
    { activeCount: 3, dailySum: 110, globalDailyLimit: 110, globalPerRunLimit: 12 },
  );
  const ceilingRaised = { ...PRODUCTION, GMAIL_GLOBAL_DAILY_CEILING: '120' };
  assert.equal(capacity(ceilingRaised).globalDailyLimit, 110);
  assert.equal(capacity(ceilingRaised).globalPerRunLimit, 12);
});

test('after activation: 120/day and 14/run with the ceiling at 120; the 110 ceiling would absorb it', () => {
  const after = capacity(activated(120));
  assert.deepEqual(after.activeIds, ['primary', 'tryscalelabai', 'deniels', ID]);
  assert.equal(after.globalDailyLimit, 120);
  assert.equal(after.globalPerRunLimit, 14, '5 + 5 + 2 + 2, under the 15 per-run ceiling');
  assert.equal(capacity(activated(110)).globalDailyLimit, 110);
});

test('existing sender caps are unchanged by the new registration', () => {
  const shape = env => configuredSenders(env).filter(item => item.id !== ID)
    .map(({ id, status, dailyLimit, perRunLimit, sendEligible }) => ({ id, status, dailyLimit, perRunLimit, sendEligible }));
  assert.deepEqual(shape(activated(120)), shape(PRODUCTION));
  assert.deepEqual(shape(PRODUCTION).map(({ id, dailyLimit, perRunLimit }) => [id, dailyLimit, perRunLimit]), [
    ['primary', 50, 5], ['tryscalelabai', 50, 5], ['scalelabaiteam', 40, 5], ['deniels', 10, 2],
  ]);
});

test('its own 2-per-window bucket; ten windows reach 50 / 50 / 10 / 10 = 120 once active', () => {
  const env = activated(120);
  const senders = configuredSenders(env);
  const active = senders.filter(item => item.sendEligible);
  const cap = capacity(env);
  const quota = () => createSendingWindowQuota({
    senderIds: active.map(item => item.id), perSenderLimit: 5, globalLimit: cap.globalPerRunLimit,
    perSenderLimits: new Map(senders.map(item => [item.id, item.perRunLimit])),
  });
  assert.deepEqual([...sendingWindowRemainingBySender(quota())], [['primary', 5], ['tryscalelabai', 5], ['deniels', 2], [ID, 2]]);
  const daily = new Map();
  let total = 0;
  for (let window = 0; window < 10; window++) {
    const q = quota();
    for (const item of [...active].reverse()) { // new mailbox first: worst case for burst
      while (sendingWindowVerdict(q, item.id).allowed && (daily.get(item.id) || 0) < item.dailyLimit && total < cap.globalDailyLimit) {
        consumeSendingWindowSuccess(q, item.id);
        daily.set(item.id, (daily.get(item.id) || 0) + 1);
        total++;
      }
    }
    assert.ok((daily.get(ID) || 0) <= 2 * (window + 1), 'never more than 2 per window');
  }
  assert.deepEqual(Object.fromEntries(daily), { [ID]: 10, deniels: 10, tryscalelabai: 50, primary: 50 });
  assert.equal(total, 120);
});

test('observer and credential are isolated to this mailbox', () => {
  // Observed only once its own credential exists; the placeholder comes from .env.example.
  assert.ok(observableSenders(configuredSenders(PRODUCTION)).some(item => item.id === ID));
  const { [TOKEN_ENV]: _omit, ...noCredential } = PRODUCTION;
  assert.ok(!observableSenders(configuredSenders(noCredential)).some(item => item.id === ID));
  // The agent's credential lookup resolves its own variable and never another mailbox's.
  const entry = withDefaultInboxes(parseRegistry(PRODUCTION.GMAIL_INBOX_REGISTRY_JSON)).find(item => item.id === ID);
  assert.equal(entry.tokenEnv, TOKEN_ENV);
  const othersOnly = { GMAIL_DENIELS_TOKEN_JSON: '{"refresh_token":"d"}', GMAIL_TRYSCALELABAI_TOKEN_JSON: '{"refresh_token":"t"}' };
  assert.throws(() => credentialsFor(entry, othersOnly), new RegExp(`${TOKEN_ENV} is not configured`));
  assert.equal(credentialsFor(entry, { ...othersOnly, [TOKEN_ENV]: '{"refresh_token":"own"}' }).refresh_token, 'own');
  // Its checkpoint row is its own: a healthy deniels row says nothing about it.
  const now = new Date('2026-09-23T15:00:00Z');
  const fresh = new Date(now.getTime() - 60000).toISOString();
  const rows = [['senderInboxId', 'historyId', 'lastSuccessfulAt', 'lastAttemptAt', 'lastError', 'health'],
    ['deniels', '1919', fresh, fresh, '', 'healthy'], ['tryscalelabai', '103423', fresh, fresh, '', 'healthy']];
  const own = observerHealth(rows, { senderIds: [ID], now }).find(item => item.senderInboxId === ID);
  assert.equal(own.health, 'unavailable');
  assert.equal(own.cursorState, 'missing');
});

test('Activate Sender refuses until warmup is marked ready and auth, observer and cursor are healthy', () => {
  const senders = configuredSenders(PRODUCTION);
  assert.ok(activationBlockers(sender(), { auth: healthyAuth, observer: healthyObserver, senders }).includes('warmup is not ready'));
  const ready = markWarmupReady(sender());
  const blockers = context => activationBlockers(ready, { senders, ...context });
  assert.ok(blockers({ auth: healthyAuth, observer: null }).includes('gmail observer unhealthy'));
  assert.ok(blockers({ auth: healthyAuth, observer: { ...healthyObserver, cursorState: 'missing' } }).includes('history cursor missing'));
  assert.ok(blockers({ auth: { authenticated: false }, observer: healthyObserver }).includes('gmail auth unhealthy'));
  assert.deepEqual(blockers({ auth: healthyAuth, observer: healthyObserver }), []);
  assert.equal(activateSender(ready, { auth: healthyAuth, observer: healthyObserver, senders }).dailyLimit, 10);
});

test('existing conversations stay with their mailbox; its sends are charged to it alone', () => {
  const senders = configuredSenders(activated(120));
  for (const owner of ['primary', 'tryscalelabai', 'deniels']) {
    const lead = { id: `T-${owner}`, tradeType: 'Dental', senderInboxId: owner, emailStep: '1', emailStatus: 'emailed' };
    const choice = chooseSender({ lead, activities: [sent(lead.id, owner)], senders, sendsToday: new Map([[ID, 0]]), step: 2 });
    assert.equal(choice.sender.id, owner);
  }
  const counts = senderCountsToday([sent('A', ID), sent('A', ID), sent('B', 'tryscalelabai')], '2026-09-23');
  assert.equal(counts.get(ID), 1);
  assert.equal(counts.get('tryscalelabai'), 1, 'same domain, separate ledger');
});

test('a message sent from deins@tryscalelabai.ca cannot confirm this mailbox\'s reservation', async () => {
  const store = createMemorySendReservationStore();
  const action = { actionId: ordinaryColdActionId('R1', 1), leadId: 'R1', actionType: 'gmail_cold_step', provider: 'gmail' };
  await store.reserveOutboundAction(action, { leaseOwner: 'w', leaseSeconds: 60 });
  await store.markProviderAttemptStarted(action.actionId, 'w');
  await store.markProviderSucceeded(action.actionId, 'w', { providerMessageId: 'gm-r1', providerThreadId: 'thr' });
  const sends = { n: 0 };
  const message = {
    id: 'gm-r1', threadId: 'thr', internalDate: String(Date.parse('2026-09-23T15:00:00Z')), labelIds: ['SENT'],
    payload: { headers: [{ name: 'From', value: 'deins@tryscalelabai.ca' }, { name: 'To', value: 'owner@clinic.test' }, { name: 'Message-ID', value: '<gm-r1@mail.gmail.com>' }] },
  };
  const mailbox = { email: EMAIL, gmail: { users: { messages: {
    get: async () => ({ data: message }),
    send: async () => { sends.n++; throw new Error('reconciliation must never send'); },
  } } } };
  const result = await reconcileGmailReservation({
    reservation: await store.getReservation(action.actionId), mailbox, store,
    lead: { id: 'R1', email: 'owner@clinic.test', senderInboxId: ID },
  });
  assert.equal(result.confirmed, false);
  assert.equal(result.sends, 0);
  assert.equal(sends.n, 0);
  assert.equal((await store.getReservation(action.actionId)).status, STATUS.RECONCILIATION_REQUIRED);
});
