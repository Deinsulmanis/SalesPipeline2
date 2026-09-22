'use strict';

/**
 * deniels@scalelabai.ca as a first-class Gmail sender. Every gate exercised is
 * the production one; the fixtures are the checked-in deployment settings plus
 * the two operator actions this mailbox needs (credential + activation).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('dotenv');

const { parseRegistry, withDefaultInboxes, assertDormant } = require('../integrations/gmail-inbox-registry');
const {
  configuredSenders, observableSenders, chooseSender, allowedForLead, senderCountsToday, successfulSendCountToday,
} = require('../integrations/gmail-sender-routing');
const { capacityFromEnv } = require('../integrations/gmail-sender-capacity');
const { markWarmupReady, activationBlockers, activateSender } = require('../integrations/gmail-sender-lifecycle');
const {
  createSendingWindowQuota, consumeSendingWindowSuccess, sendingWindowVerdict, sendingWindowRemainingBySender,
} = require('../integrations/sending-window-quota');
const { observerHealth } = require('../integrations/gmail-observer-health');
const { observerFollowUpVerdict, observerIsFresh } = require('../integrations/gmail-followup-safety');
const { stageSendGate } = require('../integrations/pipeline-sequence-safety');
const { matchMailboxMessages } = require('../integrations/gmail-mailbox-observer');
const { evaluateFreshSendSafety } = require('../integrations/send-safety-revalidate');
const { createMemorySendReservationStore } = require('../integrations/send-reservation-memory');
const { STATUS } = require('../integrations/send-reservation-rules');
const { ordinaryColdActionId } = require('../integrations/outbound-action-id');
const { reconcileGmailReservation } = require('../integrations/send-reconciliation');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').split('\r\n').join('\n');

// Deployment settings as checked in: deniels is registered but still warming.
const DEPLOYED = { ...parse(fs.readFileSync(path.join(root, '.env.example'))), FROM_EMAIL: 'deins@scalelabai.ca' };
// After the operator adds GMAIL_DENIELS_TOKEN_JSON and presses Activate Sender,
// which persists this runtime overlay row.
const ACTIVATED = { ...DEPLOYED, GMAIL_SENDER_RUNTIME_JSON: JSON.stringify([{ id: 'deniels', status: 'active' }]) };
// The live registry predates deniels: the code default must still register it.
const LIVE_REGISTRY_WITHOUT_DENIELS = {
  ...ACTIVATED,
  GMAIL_INBOX_REGISTRY_JSON: JSON.stringify([
    { id: 'tryscalelabai', email: 'deins@tryscalelabai.ca', status: 'active', tokenEnv: 'GMAIL_TRYSCALELABAI_TOKEN_JSON', dailyLimit: 50, perRunLimit: 5 },
  ]),
};

const byId = (senders, id) => senders.find(sender => sender.id === id);
const deniels = (env = ACTIVATED) => byId(configuredSenders(env), 'deniels');
const sent = (leadId, senderInboxId, extra = {}) => ({
  eventId: `${leadId}-${senderInboxId}-${extra.eventType || 'initial_email_sent'}-${extra.n || 0}`,
  eventType: 'initial_email_sent', sourceLeadId: leadId, leadId: `CE-${leadId}`,
  occurredAt: '2026-09-22T17:00:00Z',
  metadata: JSON.stringify({ senderInboxId, gmailThreadId: extra.threadId || '' }),
  ...extra,
});
// The per-run caps outreach-agent.js hands the window quota (SENDER_PER_RUN_LIMITS).
const perRunLimits = senders => new Map(senders.map(sender => [sender.id, sender.perRunLimit]));
const healthyObserver = { senderInboxId: 'deniels', health: 'healthy', cursorState: 'present', historyId: '1', quotaBackoff: false };
const healthyAuth = { authenticated: true, identityVerified: true };

// ── A. registration ────────────────────────────────────────────────────────

test('A. deniels is a registered Gmail sender with its own id, address and credential variable', () => {
  const entry = byId(withDefaultInboxes(parseRegistry('[]')), 'deniels');
  assert.deepEqual(
    { email: entry.email, tokenEnv: entry.tokenEnv, provider: entry.provider, observerEnabled: entry.observerEnabled },
    { email: 'deniels@scalelabai.ca', tokenEnv: 'GMAIL_DENIELS_TOKEN_JSON', provider: 'gmail', observerEnabled: true },
  );
  for (const env of [DEPLOYED, ACTIVATED, LIVE_REGISTRY_WITHOUT_DENIELS]) {
    const senders = configuredSenders(env);
    assert.ok(byId(senders, 'deniels'), 'registered even when the registry variable omits it');
    assert.equal(new Set(senders.map(sender => sender.id)).size, senders.length);
    assert.equal(new Set(senders.map(sender => sender.tokenEnv)).size, senders.length, 'no shared credential variable');
    assert.equal(new Set(senders.map(sender => sender.email)).size, senders.length);
  }
  // Same domain as primary, different mailbox: never confused with it.
  assert.equal(byId(configuredSenders(ACTIVATED), 'primary').email, 'deins@scalelabai.ca');
  assert.equal(deniels().oauthClient, 'secondary');
});

test('A. the agent authenticates every configured sender from the same roster, including code defaults', () => {
  // Production's registry variable does not list deniels: the auth lookup must
  // not be narrower than the roster that schedules its observer.
  const agent = read('outreach-agent.js');
  const auth = agent.slice(agent.indexOf('function authForSender('), agent.indexOf('const gmailForSender'));
  assert.match(auth, /withDefaultGmailInboxes\(parseGmailRegistry\(\)\)\.find\(item => item\.id === sender\.id\)/);
  const liveRoster = withDefaultInboxes(parseRegistry(LIVE_REGISTRY_WITHOUT_DENIELS.GMAIL_INBOX_REGISTRY_JSON));
  for (const sender of configuredSenders(LIVE_REGISTRY_WITHOUT_DENIELS).filter(item => item.id !== 'primary')) {
    assert.ok(liveRoster.some(entry => entry.id === sender.id && entry.tokenEnv === sender.tokenEnv), `${sender.id} can authenticate`);
  }
});

test('A. deniels ships dormant: warming cannot send, and no credential means no observer and no send', () => {
  const warming = deniels(DEPLOYED);
  assert.equal(warming.status, 'warming');
  assert.equal(warming.sendEligible, false);
  assert.equal(assertDormant(warming), true);
  assert.equal(allowedForLead(warming, { tradeType: 'Dental' }), false);

  const { GMAIL_DENIELS_TOKEN_JSON: _omit, ...noCredential } = ACTIVATED;
  const uncredentialed = deniels(noCredential);
  assert.equal(uncredentialed.credentialConfigured, false);
  assert.equal(uncredentialed.sendEligible, false, 'activation without a credential cannot send');
  assert.ok(!observableSenders(configuredSenders(noCredential)).some(sender => sender.id === 'deniels'));
  // With a credential it is observed while still warming, so the history
  // cursor exists before the first campaign send.
  assert.ok(observableSenders(configuredSenders(DEPLOYED)).some(sender => sender.id === 'deniels'));
});

// ── B / C. caps ────────────────────────────────────────────────────────────

test('B. deniels daily limit is 10: send 10 allowed, send 11 refused by routing and by the send gate', () => {
  const sender = deniels();
  assert.equal(sender.dailyLimit, 10);
  assert.equal(sender.perRunLimit, 2);
  assert.equal(sender.sendEligible, true);
  const lead = { id: 'N1', tradeType: 'Dental', senderInboxId: 'deniels' };
  const route = count => chooseSender({ lead, senders: configuredSenders(ACTIVATED), sendsToday: new Map([['deniels', count]]) });
  assert.equal(route(9).sender.id, 'deniels');
  for (const count of [10, 11]) {
    assert.equal(route(count).sender, null);
    assert.match(route(count).reason, /daily limit reached/);
  }
  const gate = count => stageSendGate({
    sendingEnabled: true, senderProof: { ok: true }, sender, thread: { threadId: 't' }, threadVerified: true,
    observationOk: true, senderCount: count, globalCount: 0, globalLimit: 110,
  });
  assert.equal(gate(9).allowed, true);
  assert.equal(gate(10).code, 'sender_quota');
});

test('C. existing sender caps are identical before and after deniels is added and activated', () => {
  const shape = env => configuredSenders(env).filter(sender => sender.id !== 'deniels').map(sender => ({
    id: sender.id, email: sender.email, status: sender.status, dailyLimit: sender.dailyLimit,
    perRunLimit: sender.perRunLimit, sendEligible: sender.sendEligible,
  }));
  assert.deepEqual(shape(ACTIVATED), shape(DEPLOYED));
  assert.deepEqual(shape(ACTIVATED).map(({ id, dailyLimit, perRunLimit }) => [id, dailyLimit, perRunLimit]), [
    ['primary', 50, 5], ['tryscalelabai', 50, 5], ['scalelabaiteam', 40, 5], ['deniels_tryscalelabai', 10, 2],
  ]);
});

// ── D. global capacity ─────────────────────────────────────────────────────

test('D. global capacity is 100 until deniels is active, then exactly 110 (+10)', () => {
  const before = capacityFromEnv(configuredSenders(DEPLOYED), DEPLOYED);
  assert.equal(before.globalDailyLimit, 100, 'raising the ceiling alone adds no live capacity');
  assert.equal(before.globalPerRunLimit, 10);
  const after = capacityFromEnv(configuredSenders(ACTIVATED), ACTIVATED);
  assert.deepEqual(after.activeIds, ['primary', 'tryscalelabai', 'deniels']);
  assert.equal(after.dailySum, 110);
  assert.equal(after.globalDailyLimit, 110);
  assert.equal(after.globalDailyLimit - before.globalDailyLimit, 10);
  // Per-run: 5 + 5 + 2. The 15 safety ceiling is not the binding term.
  assert.equal(after.globalPerRunLimit, 12);
  // The previous ceiling would have silently swallowed deniels' capacity.
  assert.equal(capacityFromEnv(configuredSenders(ACTIVATED), { ...ACTIVATED, GMAIL_GLOBAL_DAILY_CEILING: '100' }).globalDailyLimit, 100);
});

// ── E. per-mailbox window throughput ───────────────────────────────────────

function windowQuota(senders = configuredSenders(ACTIVATED)) {
  const active = senders.filter(sender => sender.sendEligible);
  return createSendingWindowQuota({
    senderIds: active.map(sender => sender.id), perSenderLimit: 5,
    globalLimit: capacityFromEnv(senders, ACTIVATED).globalPerRunLimit, perSenderLimits: perRunLimits(senders),
  });
}

test('E. deniels has its own window bucket of 2; exhausting it never reduces the other mailboxes', () => {
  const quota = windowQuota();
  assert.deepEqual([...sendingWindowRemainingBySender(quota)], [['primary', 5], ['tryscalelabai', 5], ['deniels', 2]]);
  consumeSendingWindowSuccess(quota, 'deniels');
  consumeSendingWindowSuccess(quota, 'deniels');
  assert.equal(sendingWindowVerdict(quota, 'deniels').allowed, false);
  assert.match(sendingWindowVerdict(quota, 'deniels').reason, /sender scheduled-window limit/);
  for (const id of ['primary', 'tryscalelabai']) {
    for (let i = 0; i < 5; i++) consumeSendingWindowSuccess(quota, id);
  }
  assert.equal(quota.globalSuccesses, 12, 'the shared per-run limit equals the sum of buckets, so it never binds first');

  const reverse = windowQuota();
  for (const id of ['primary', 'tryscalelabai']) for (let i = 0; i < 5; i++) consumeSendingWindowSuccess(reverse, id);
  assert.equal(sendingWindowVerdict(reverse, 'deniels').allowed, true, 'full primary and tryscalelabai buckets leave deniels free');
});

test('E. ten scheduled windows reach 50 / 50 / 10 = 110 with deniels spread at 2 per window', () => {
  const senders = configuredSenders(ACTIVATED);
  const capacity = capacityFromEnv(senders, ACTIVATED);
  const daily = new Map();
  let total = 0;
  const deniesByWindow = [];
  for (let window = 0; window < 10; window++) {
    const quota = windowQuota(senders);
    // deniels first: the worst case for burst, since candidate order varies.
    for (const sender of senders.filter(item => item.sendEligible).reverse()) {
      while (sendingWindowVerdict(quota, sender.id).allowed
        && (daily.get(sender.id) || 0) < sender.dailyLimit && total < capacity.globalDailyLimit) {
        consumeSendingWindowSuccess(quota, sender.id);
        daily.set(sender.id, (daily.get(sender.id) || 0) + 1);
        total++;
      }
    }
    deniesByWindow.push(daily.get('deniels') || 0);
  }
  assert.deepEqual(Object.fromEntries(daily), { primary: 50, tryscalelabai: 50, deniels: 10 });
  assert.equal(total, 110);
  assert.deepEqual(deniesByWindow, [2, 4, 6, 8, 10, 10, 10, 10, 10, 10], 'never more than 2 per window');
});

test('E. existing quota callers and default-cap senders keep the uniform bucket', () => {
  const legacy = createSendingWindowQuota({ senderIds: ['primary', 'second'], perSenderLimit: 5, globalLimit: 10 });
  assert.deepEqual([...sendingWindowRemainingBySender(legacy)], [['primary', 5], ['second', 5]]);
  // A per-sender cap can only lower a bucket, never raise it above the ceiling.
  const raised = createSendingWindowQuota({ senderIds: ['primary'], perSenderLimit: 5, globalLimit: 10, perSenderLimits: { primary: 9 } });
  assert.equal(sendingWindowRemainingBySender(raised).get('primary'), 5);
  const agent = read('outreach-agent.js');
  assert.equal((agent.match(/perSenderLimits: SENDER_PER_RUN_LIMITS/g) || []).length, 2, 'main and intent passes both use sender caps');
  assert.match(agent, /const SENDER_PER_RUN_LIMITS = new Map\(GMAIL_SENDERS/);
});

// ── F / K / L. reservations, accounting, reconciliation ────────────────────

const coldAction = leadId => ({ actionId: ordinaryColdActionId(leadId, 1), leadId, actionType: 'gmail_cold_step', provider: 'gmail' });

test('F. a deniels send takes the same durable reservation: one owner, no duplicate, no resend after success', async () => {
  const store = createMemorySendReservationStore();
  const action = coldAction('D1');
  assert.equal(action.actionId, ordinaryColdActionId('D1', 1), 'the action id is per lead+step, not per mailbox');
  assert.equal((await store.reserveOutboundAction(action, { leaseOwner: 'deniels-worker', leaseSeconds: 60 })).ok, true);
  const rival = await store.reserveOutboundAction(action, { leaseOwner: 'primary-worker', leaseSeconds: 60 });
  assert.equal(rival.ok, false);
  assert.equal(rival.code, 'reservation_leased');
  assert.equal((await store.markProviderAttemptStarted(action.actionId, 'deniels-worker')).ok, true);
  assert.equal((await store.markProviderSucceeded(action.actionId, 'deniels-worker', { providerMessageId: 'gm-d1', providerThreadId: 'thr-d1' })).ok, true);
  const again = await store.reserveOutboundAction(action, { leaseOwner: 'deniels-worker', leaseSeconds: 60 });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'reservation_sent_unconfirmed');
});

test('F. a crash mid-send from deniels becomes reconciliation_required, never an automatic retry', async () => {
  let clock = Date.parse('2026-09-22T17:00:00Z');
  const store = createMemorySendReservationStore({ now: () => new Date(clock) });
  const action = coldAction('D2');
  await store.reserveOutboundAction(action, { leaseOwner: 'deniels-worker', leaseSeconds: 60 });
  await store.markProviderAttemptStarted(action.actionId, 'deniels-worker');
  clock += 10 * 60 * 1000;
  const retry = await store.reserveOutboundAction(action, { leaseOwner: 'deniels-worker-2', leaseSeconds: 60 });
  assert.equal(retry.ok, false);
  assert.equal((await store.getReservation(action.actionId)).status, STATUS.RECONCILIATION_REQUIRED);
});

test('K. successful deniels sends consume deniels quota exactly once and nothing else does', () => {
  const day = '2026-09-22';
  const one = sent('K1', 'deniels');
  const events = [
    one, { ...one }, // the same success read twice
    { ...one, eventId: 'reserved', eventType: 'ordinary_send_reserved' },
    { ...one, eventId: 'warmup', eventType: 'smartlead_warmup_sent' },
    sent('K2', 'primary'),
  ];
  const counts = senderCountsToday(events, day);
  assert.equal(counts.get('deniels'), 1);
  assert.equal(counts.get('primary'), 1, 'deniels sends are not charged to the primary mailbox on the same domain');
  assert.equal(successfulSendCountToday(events, day), 2);

  const ten = Array.from({ length: 10 }, (_v, n) => sent(`K${n + 10}`, 'deniels'));
  const tenCounts = senderCountsToday(ten, day);
  assert.equal(tenCounts.get('deniels'), 10);
  const route = chooseSender({ lead: { id: 'NEW', tradeType: 'Dental', senderInboxId: 'deniels' }, senders: configuredSenders(ACTIVATED), sendsToday: tenCounts });
  assert.equal(route.sender, null);
});

function gmailMessage({ id, threadId, from, to, sentLabel = true, occurredAt = '2026-09-22T17:00:00.000Z' }) {
  return {
    id, threadId, internalDate: String(Date.parse(occurredAt)),
    labelIds: sentLabel ? ['SENT'] : ['INBOX'],
    payload: { headers: [
      { name: 'From', value: from }, { name: 'To', value: to },
      { name: 'Subject', value: 'Quick question' }, { name: 'Message-ID', value: `<${id}@mail.gmail.com>` },
    ] },
  };
}

function denielsMailbox(messages) {
  const sends = { n: 0 };
  return {
    sends, email: 'deniels@scalelabai.ca',
    gmail: { users: { messages: {
      get: async ({ id }) => {
        if (messages[id]) return { data: messages[id] };
        const missing = new Error('Requested entity was not found.');
        missing.response = { status: 404 };
        throw missing;
      },
      send: async () => { sends.n++; throw new Error('reconciliation must never send'); },
      list: async () => ({ data: { messages: [] } }),
    } } },
  };
}

async function succeededReservation(store, leadId, providerMessageId) {
  const action = coldAction(leadId);
  await store.reserveOutboundAction(action, { leaseOwner: 'w', leaseSeconds: 60 });
  await store.markProviderAttemptStarted(action.actionId, 'w');
  await store.markProviderSucceeded(action.actionId, 'w', { providerMessageId, providerThreadId: 'thr' });
  return store.getReservation(action.actionId);
}

test('L. Gmail reconciliation of a deniels send confirms from its own SENT mail with zero sends, then blocks resend', async () => {
  const store = createMemorySendReservationStore();
  const lead = { id: 'L1', email: 'owner@clinic.test', senderInboxId: 'deniels', emailStep: '', lastEmailedAt: '' };
  const mailbox = denielsMailbox({ 'gm-l1': gmailMessage({ id: 'gm-l1', threadId: 'thr-l1', from: 'deniels@scalelabai.ca', to: lead.email }) });
  const result = await reconcileGmailReservation({
    reservation: await succeededReservation(store, 'L1', 'gm-l1'), mailbox, lead, store,
    attribution: { senderInboxId: 'deniels' },
  });
  assert.equal(result.confirmed, true);
  assert.equal(result.sends, 0);
  assert.equal(mailbox.sends.n, 0);
  const resend = await store.reserveOutboundAction(coldAction('L1'), { leaseOwner: 'w2', leaseSeconds: 60 });
  assert.equal(resend.ok, false);
  assert.equal(resend.code, 'reservation_confirmed');
});

test('L. a message sent from another mailbox cannot confirm a deniels reservation, and it stays unsendable', async () => {
  const store = createMemorySendReservationStore();
  const lead = { id: 'L2', email: 'owner@clinic.test', senderInboxId: 'deniels', emailStep: '', lastEmailedAt: '' };
  // Same domain, different mailbox: the primary's message is not deniels' proof.
  const mailbox = denielsMailbox({ 'gm-l2': gmailMessage({ id: 'gm-l2', threadId: 'thr-l2', from: 'deins@scalelabai.ca', to: lead.email }) });
  const result = await reconcileGmailReservation({
    reservation: await succeededReservation(store, 'L2', 'gm-l2'), mailbox, lead, store,
  });
  assert.equal(result.confirmed, false);
  assert.equal(result.sends, 0);
  assert.equal(result.retryableSend, false);
  assert.equal(mailbox.sends.n, 0);
  assert.equal((await store.getReservation(ordinaryColdActionId('L2', 1))).status, STATUS.RECONCILIATION_REQUIRED);
  assert.equal((await store.reserveOutboundAction(coldAction('L2'), { leaseOwner: 'w2', leaseSeconds: 60 })).ok, false);
});

// ── G. observer health fails closed ────────────────────────────────────────

test('G. an unhealthy, stale or missing deniels observer blocks its sends and does not touch other mailboxes', () => {
  const now = new Date('2026-09-22T18:00:00Z');
  const fresh = new Date(now.getTime() - 5 * 60000).toISOString();
  const stale = new Date(now.getTime() - 60 * 60000).toISOString();
  const header = ['senderInboxId', 'historyId', 'lastSuccessfulAt', 'lastAttemptAt', 'lastError', 'health'];
  const observers = rows => observerHealth([header, ...rows], { senderIds: ['primary', 'deniels'], now });
  const lead = { id: 'G1', tradeType: 'Dental', emailStep: '1', emailStatus: 'emailed' };

  for (const row of [
    ['deniels', '77', fresh, fresh, 'quota', 'unhealthy_quota'],
    ['deniels', '77', stale, stale, '', 'healthy'],
    null, // no checkpoint row at all: never observed
  ]) {
    const all = observers([['primary', '900', fresh, fresh, '', 'healthy'], ...(row ? [row] : [])]);
    const observer = id => all.find(item => item.senderInboxId === id);
    assert.equal(observerIsFresh(observer('deniels')), false);
    assert.equal(observerFollowUpVerdict({ lead, observer: observer('deniels'), senderResolved: true }).allowed, false);
    assert.equal(observerIsFresh(observer('primary')), true, 'the primary observer is read from its own row');
  }
  assert.equal(observers([]).find(item => item.senderInboxId === 'deniels').cursorState, 'missing');

  const gate = stageSendGate({
    sendingEnabled: true, senderProof: { ok: true }, sender: deniels(), thread: { threadId: 't' },
    threadVerified: true, observationOk: false, senderCount: 0, globalCount: 0, globalLimit: 110,
  });
  assert.equal(gate.code, 'observation_failed');
  // Ordinary sends: a mailbox with no successful observation this run is false.
  assert.match(read('outreach-agent.js'), /observationBySender\.set\(sender\.id,\s*\n\s*Boolean\(outboundSender\?\.ok\) && !replyObservation\.failedSenderIds\.has\(sender\.id\)\)/);
});

test('G. Activate Sender refuses deniels until auth, observer and history cursor are healthy, and accepts its 10/day cap', () => {
  const senders = configuredSenders(DEPLOYED);
  const ready = markWarmupReady(byId(senders, 'deniels'));
  const blockers = context => activationBlockers(ready, { senders, ...context });
  assert.ok(blockers({ auth: healthyAuth, observer: null }).includes('gmail observer unhealthy'));
  assert.ok(blockers({ auth: healthyAuth, observer: { ...healthyObserver, health: 'unavailable' } }).includes('gmail observer unhealthy'));
  assert.ok(blockers({ auth: healthyAuth, observer: { ...healthyObserver, cursorState: 'missing' } }).includes('history cursor missing'));
  assert.ok(blockers({ auth: healthyAuth, observer: { ...healthyObserver, health: 'backoff', quotaBackoff: true } }).includes('gmail backoff'));
  assert.ok(blockers({ auth: { authenticated: false }, observer: healthyObserver }).includes('gmail auth unhealthy'));
  assert.deepEqual(blockers({ auth: healthyAuth, observer: healthyObserver }), []);
  const active = activateSender(ready, { auth: healthyAuth, observer: healthyObserver, senders });
  assert.equal(active.status, 'active');
  assert.equal(active.dailyLimit, 10);
  // Lower caps pass the gate; caps above the standard inbox default still do not.
  assert.ok(activationBlockers({ ...ready, dailyLimit: 41 }, { auth: healthyAuth, observer: healthyObserver, senders })
    .includes('dailyLimit must be between 1 and 40'));
  assert.ok(activationBlockers({ ...ready, perRunLimit: 6 }, { auth: healthyAuth, observer: healthyObserver, senders })
    .includes('perRunLimit must be between 1 and 5'));
  assert.ok(activationBlockers({ ...ready, dailyLimit: 0 }, { auth: healthyAuth, observer: healthyObserver, senders })
    .includes('dailyLimit must be between 1 and 40'));
});

// ── H. reply attribution ───────────────────────────────────────────────────

test('H. replies in the deniels mailbox attach to the lead deniels sent to, never to another mailbox\'s thread', () => {
  const leads = [
    { id: 'H1', email: 'owner@one.test', lastEmailedAt: '2026-09-22T16:00:00Z' },
    { id: 'H2', email: 'owner@two.test', lastEmailedAt: '2026-09-22T16:00:00Z' },
  ];
  const activities = [sent('H1', 'deniels', { threadId: 'thr-deniels' }), sent('H2', 'primary', { threadId: 'thr-primary' })];
  const inbound = (id, threadId, from) => gmailMessage({ id, threadId, from, to: 'deniels@scalelabai.ca', sentLabel: false, occurredAt: '2026-09-22T18:00:00Z' });
  const match = messages => matchMailboxMessages(messages, { leads, activities, senderInboxId: 'deniels', senderEmail: 'deniels@scalelabai.ca' });

  // A colleague answering in deniels' thread is attributed by thread.
  assert.equal(match([inbound('r1', 'thr-deniels', 'frontdesk@one.test')]).replies.get('H1')?.id, 'r1');
  // The primary mailbox's thread id is not deniels' evidence.
  assert.equal(match([inbound('r2', 'thr-primary', 'frontdesk@two.test')]).replies.size, 0);
  // deniels' own outgoing mail is never a reply.
  assert.equal(match([gmailMessage({ id: 's1', threadId: 'thr-deniels', from: 'deniels@scalelabai.ca', to: 'owner@one.test', sentLabel: false, occurredAt: '2026-09-22T18:00:00Z' })]).replies.size, 0);

  // Same observer, planner and commit path as every mailbox; no second classifier.
  const agent = read('outreach-agent.js');
  assert.match(agent, /for \(const sender of observableSenders\(GMAIL_SENDERS\)\.filter\(item =>/);
  assert.match(agent, /senderInboxId: sender\.id,\s*\n\s*senderEmail: sender\.email, historyId: gmailObservationHistoryBySender\.get\(sender\.id\)/);
  assert.match(agent, /persistGmailObservationState\(\s*\n\s*sender\.id,/);
});

// ── I. suppression ─────────────────────────────────────────────────────────

test('I. suppression, holds and opt-outs block a deniels send exactly as for every other mailbox', () => {
  const base = { id: 'I1', email: 'Blocked@Clinic.test', stage: 'Queued', emailStatus: '', notes: '' };
  const cases = [
    [{}, new Set(['blocked@clinic.test']), 'suppressed'],
    [{ notes: '[MANUAL HOLD]' }, new Set(), 'manual_hold'],
    [{ notes: '[REPLY: Unsubscribed]' }, new Set(), 'unsubscribed'],
  ];
  for (const [patch, suppressedEmails, code] of cases) {
    const results = ['deniels', 'primary', 'tryscalelabai'].map(senderInboxId => {
      const lead = { ...base, ...patch, senderInboxId };
      return evaluateFreshSendSafety(lead, lead, suppressedEmails, { env: {} });
    });
    for (const result of results) {
      assert.equal(result.allowed, false);
      assert.equal(result.code, code);
    }
  }
  // The single Gmail send path refuses any sender that is not delivery eligible.
  assert.match(read('outreach-agent.js'), /assertSendAuthorized\(\);\n  assertStaffingSendAllowed\(lead\);\n  if \(!sender\?\.sendEligible\) throw/);
});

// ── J. thread ownership ────────────────────────────────────────────────────

test('J. existing conversations stay with their mailbox even when deniels has spare capacity', () => {
  const senders = configuredSenders(ACTIVATED);
  const idle = new Map([['deniels', 0]]);
  for (const owner of ['primary', 'tryscalelabai']) {
    const lead = { id: `J-${owner}`, tradeType: 'Dental', senderInboxId: owner, emailStep: '1', emailStatus: 'emailed' };
    const activities = [sent(lead.id, owner)];
    assert.equal(chooseSender({ lead, activities, senders, sendsToday: idle, step: 2 }).sender.id, owner);
    const exhausted = chooseSender({ lead, activities, senders, sendsToday: new Map([[owner, 50], ['deniels', 0]]), step: 2 });
    assert.equal(exhausted.sender, null, 'an exhausted owner defers; it never migrates to deniels');
    assert.equal(exhausted.pinned, true);
    // Rewriting the row to deniels cannot override delivered-message evidence.
    assert.throws(() => chooseSender({ lead: { ...lead, senderInboxId: 'deniels' }, activities, senders, step: 2 }), /ownership conflict/);
  }
  // A follow-up with no proven owner is refused rather than handed to deniels.
  assert.throws(() => chooseSender({ lead: { id: 'J-none', tradeType: 'Dental' }, senders, sendsToday: idle, step: 2 }), /no proven sender ownership/);
});

test('J. deniels takes new dental outreach through the existing least-used rule; non-dental stays on primary', () => {
  const senders = configuredSenders(ACTIVATED);
  const choice = chooseSender({
    lead: { id: 'NEW', tradeType: 'Dental' }, senders,
    sendsToday: new Map([['primary', 20], ['tryscalelabai', 20], ['deniels', 3]]),
  });
  assert.equal(choice.sender.id, 'deniels');
  assert.equal(choice.pinned, false);
  const roofing = chooseSender({ lead: { id: 'R', tradeType: 'Roofing' }, senders, sendsToday: new Map([['primary', 20]]) });
  assert.equal(roofing.sender.id, 'primary');
});
