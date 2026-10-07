'use strict';
// 2026-10-07 deliverability policy, end to end through the real gates:
// Google-only recipients, .com (scalelabaiteam) pooled at a static 30/day,
// SURBL-listed and Gmail-Spam senders held, salvage = next normal touch only,
// the 19 failed-Touch-1 leads and the 42 presumed-delivered leads untouched.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PROVIDER, HOLD_REASON, coldDeliveryVerdict, admitByRecipientProvider, createProviderClassifier,
  senderDailyCeiling } = require('../integrations/cold-delivery-policy');
const { guardProviderSend } = require('../integrations/send-safety-revalidate');
const { configuredSenders } = require('../integrations/gmail-sender-routing');
const { isFollowUpDue, nextFollowUp } = require('../integrations/sequence-timing');
const { planSameTouchRecovery, unrecoveredTouchBlock, recoveryActionId } = require('../integrations/same-touch-recovery');
const { sendSuppressionReason, releaseHoldFromNotes } = require('../integrations/pipeline-state');
const { createMemorySendReservationStore } = require('../integrations/send-reservation-memory');
const { ordinaryColdActionId } = require('../integrations/outbound-action-id');
const { activationBlockers, activateSender } = require('../integrations/gmail-sender-lifecycle');

const SEND_ENV = Object.freeze({
  SENDING_ENABLED: 'true', SEND_AUTHORIZED_ENV: 'test', RAILWAY_ENVIRONMENT: 'test',
  SEND_AUTHORIZED_TOKEN: 'token', SEND_WORKER_ROLE: 'outreach-sender', SEND_LOCK_ENABLED: 'true',
});
const GOOGLE = Object.freeze({ provider: PROVIDER.GOOGLE, domain: 'acme.com', reason: 'google_mx' });
const MICROSOFT = Object.freeze({ provider: PROVIDER.MICROSOFT, domain: 'corp.com', reason: 'microsoft_mx' });
const COM = Object.freeze({ id: 'scalelabaiteam', status: 'active', sendEligible: true });
const NOW = Date.parse('2026-10-20T16:00:00Z');
const T1_AT = '2026-10-01T15:00:00.000Z';

const lead = (over = {}) => ({ id: 'S1', email: 'owner@acme.com', company: 'Acme Staffing', stage: 'Contacted',
  emailStatus: 'emailed', emailStep: '1', lastEmailedAt: T1_AT, senderInboxId: 'scalelabaiteam', notes: '', ...over });
const gate = (current, { classification = GOOGLE, sender = COM, suppressed = new Set() } = {}) => guardProviderSend(current,
  { env: SEND_ENV, classifyRecipient: async () => classification, loadFreshState: async () => ({ current, suppressedEmails: suppressed }) },
  { purpose: 'cold', coldSender: sender, senderInboxId: sender.id });
const row = (eventType, metadata, over = {}) => ({ eventId: `${eventType}:${over.eventId || Math.random()}`, leadId: 'CE-S1', sourceLeadId: 'S1',
  email: 'owner@acme.com', eventType, occurredAt: over.occurredAt || T1_AT, subject: '', content: '', metadata: JSON.stringify(metadata) });
const sentT1 = (id = 'G1') => row('initial_email_sent', { step: 1, gmailMessageId: id, gmailThreadId: id, senderInboxId: 'scalelabaiteam' }, { eventId: id });

// ── Sender restrictions (34–38) ──────────────────────────────────────────────

test('34/35. SURBL-listed and Gmail-Spam senders cannot cold-send to a Google recipient, even active', async () => {
  for (const id of ['tryscalelabai', 'deniels_tryscalelabai', 'deniels']) {
    const sender = { id, status: 'active', sendEligible: true };
    const verdict = await gate(lead({ senderInboxId: id }), { sender });
    assert.equal(verdict.allowed, false, id);
    assert.equal(verdict.code, 'sender_cold_hold', id);
  }
});

test('held senders cannot be activated even when paused and otherwise healthy', () => {
  const healthy = {
    auth: { authenticated: true, identityVerified: true },
    observer: { senderInboxId: 'tryscalelabai', health: 'healthy', cursorState: 'present', quotaBackoff: false },
    senders: [],
  };
  for (const id of ['tryscalelabai', 'deniels_tryscalelabai', 'deniels']) {
    const sender = { id, email: `${id}@x.test`, status: 'paused', sendEligible: false, provider: 'gmail',
      dailyLimit: 20, perRunLimit: 2, credentialConfigured: true };
    const blockers = activationBlockers(sender, healthy);
    assert.ok(blockers.some(item => /cold hold/.test(item)), id);
    assert.throws(() => activateSender(sender, healthy), /cold hold/);
  }
  const com = { id: 'scalelabaiteam', email: 'deins@scalelabaiteam.com', status: 'paused', sendEligible: false,
    provider: 'gmail', dailyLimit: 30, perRunLimit: 5, credentialConfigured: true };
  assert.deepEqual(activationBlockers(com, { ...healthy, observer: { ...healthy.observer, senderInboxId: 'scalelabaiteam' } }).filter(item => /cold hold/.test(item)), []);
});

test('36. a .com Google recipient passes every gate when the sender is active and authorized', async () => {
  const verdict = await gate(lead());
  assert.equal(verdict.allowed, true);
  assert.equal(coldDeliveryVerdict({ sender: COM, classification: GOOGLE, env: {} }).allowed, true);
  // …but not while .com is paused, whatever the recipient.
  const paused = await gate(lead(), { sender: { id: 'scalelabaiteam', status: 'paused', sendEligible: false } });
  assert.equal(paused.code, 'sender_not_send_eligible');
});

test('37. a .com Microsoft, OTHER or UNKNOWN recipient is blocked at the final gate', async () => {
  for (const [classification, code] of [[MICROSOFT, HOLD_REASON.MICROSOFT],
    [{ provider: PROVIDER.OTHER, domain: 'x.com' }, HOLD_REASON.OTHER], [{ provider: PROVIDER.UNKNOWN, domain: 'y.com' }, HOLD_REASON.UNKNOWN],
    [null, HOLD_REASON.UNKNOWN]]) {
    const verdict = await gate(lead(), { classification });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.code, code);
  }
});

test('38. .com is capped at 30/day as a static ceiling; other inboxes keep their configured caps', () => {
  const registry = [
    { id: 'tryscalelabai', email: 'deins@tryscalelabai.ca', status: 'paused', tokenEnv: 'GMAIL_TRYSCALELABAI_TOKEN_JSON', dailyLimit: 60, perRunLimit: 6 },
    { id: 'scalelabaiteam', email: 'deins@scalelabaiteam.com', status: 'paused', tokenEnv: 'GMAIL_SCALELABAITEAM_TOKEN_JSON', dailyLimit: 40, perRunLimit: 5 },
  ];
  const base = { FROM_EMAIL: 'deins@scalelabai.ca', GMAIL_TOKEN_JSON: '{}', GMAIL_PRIMARY_DAILY_LIMIT: '60', GMAIL_INBOX_REGISTRY_JSON: JSON.stringify(registry),
    COLD_INBOX_DAILY_CAPS: 'scalelabaiteam:30' };
  // Without the setting nothing changes: there is no hidden default ceiling.
  const { COLD_INBOX_DAILY_CAPS: _unset, ...plain } = base;
  assert.equal(Object.fromEntries(configuredSenders(plain).map(s => [s.id, s])).scalelabaiteam.dailyLimit, 40);
  // No global ceiling set: only .com changes.
  let byId = Object.fromEntries(configuredSenders(base).map(s => [s.id, s]));
  assert.equal(byId.scalelabaiteam.dailyLimit, 30);
  assert.equal(byId.scalelabaiteam.configuredDailyLimit, 40);
  assert.equal(byId.scalelabaiteam.status, 'paused');
  assert.equal(byId.primary.dailyLimit, 60);
  assert.equal(byId.tryscalelabai.dailyLimit, 60);
  // A global ceiling still applies to everyone; the lower of the two wins.
  byId = Object.fromEntries(configuredSenders({ ...base, COLD_INBOX_DAILY_CAP: '25' }).map(s => [s.id, s]));
  assert.equal(byId.scalelabaiteam.dailyLimit, 25);
  assert.equal(byId.primary.dailyLimit, 25);
  byId = Object.fromEntries(configuredSenders({ ...base, COLD_INBOX_DAILY_CAP: '50' }).map(s => [s.id, s]));
  assert.equal(byId.scalelabaiteam.dailyLimit, 30);
  // A ceiling never raises: a lower configured .com cap stays lower. No ramp.
  const lower = registry.map(e => (e.id === 'scalelabaiteam' ? { ...e, dailyLimit: 12 } : e));
  byId = Object.fromEntries(configuredSenders({ ...base, GMAIL_INBOX_REGISTRY_JSON: JSON.stringify(lower) }).map(s => [s.id, s]));
  assert.equal(byId.scalelabaiteam.dailyLimit, 12);
  assert.equal(senderDailyCeiling('scalelabaiteam', { COLD_INBOX_DAILY_CAPS: 'scalelabaiteam:30' }), 30);
  assert.equal(senderDailyCeiling('primary', { COLD_INBOX_DAILY_CAPS: 'scalelabaiteam:30' }), null);
  assert.equal(senderDailyCeiling('scalelabaiteam', { COLD_INBOX_DAILY_CAPS: 'scalelabaiteam:thirty' }), null);
});

// ── Suppression always wins (16–19) ─────────────────────────────────────────

test('16–19. replied, DNC, unsubscribed and hard-failed leads cannot send to a Google recipient', async () => {
  assert.equal((await gate(lead({ emailStatus: 'replied' }))).code, 'terminal_state');
  assert.equal((await gate(lead({ notes: '[REPLY: Not Interested]' }))).allowed, false);
  assert.equal((await gate(lead(), { suppressed: new Set(['owner@acme.com']) })).code, 'suppressed');
  assert.equal((await gate(lead({ notes: '[REPLY: Unsubscribed]' }))).code, 'unsubscribed');
  assert.equal((await gate(lead({ notes: '[BOUNCED]' }))).code, 'bounced');
});

// ── Salvage: next normal touch only (20–23) ─────────────────────────────────

test('20/21. a salvage lead is offered only its NEXT touch; the previous touch is never re-offered or re-reserved', async () => {
  const salvage = lead();
  const next = nextFollowUp(salvage, { activities: [sentT1()] });
  assert.equal(next.currentStep, 1);
  assert.equal(next.nextStep, 2);
  assert.equal(isFollowUpDue(salvage, NOW, { activities: [sentT1()] }), true);
  // Touch 2 already delivered → not offered again.
  const t2 = row('follow_up_sent', { step: 2, gmailMessageId: 'G2', gmailThreadId: 'G1', senderInboxId: 'scalelabaiteam' }, { occurredAt: '2026-10-04T15:00:00Z' });
  assert.equal(isFollowUpDue(salvage, NOW, { activities: [sentT1(), t2] }), false);
  // The durable reservation for the touch already sent refuses a second send.
  const store = createMemorySendReservationStore({ now: () => new Date(NOW) });
  const action = { actionId: ordinaryColdActionId('S1', 1), leadId: 'S1', actionType: 'gmail_cold_step', provider: 'gmail' };
  await store.reserveOutboundAction(action, { leaseOwner: 'w' });
  await store.markProviderAttemptStarted(action.actionId, 'w');
  await store.markProviderSucceeded(action.actionId, 'w', { providerMessageId: 'G1' });
  await store.markConfirmed(action.actionId, 'w');
  assert.equal((await store.reserveOutboundAction(action, { leaseOwner: 'x' })).code, 'reservation_confirmed');
});

test('22/23. a provider hold leaves sequence position untouched and is never a suppression or failure', async () => {
  const held = Object.freeze(lead({ email: 'pat@outlook.com', emailStep: '2' }));
  const before = JSON.stringify(held);
  const classifier = createProviderClassifier({ resolveMx: async () => [], logger: { log() {} }, env: {} });
  const admission = await admitByRecipientProvider([held], classifier, {});
  assert.equal(admission.allowed.size, 0);
  assert.equal(admission.held[0].holdReason, HOLD_REASON.MICROSOFT);
  assert.equal(JSON.stringify(held), before);
  assert.equal(nextFollowUp(held).nextStep, 3);
  assert.equal(sendSuppressionReason(held), null);
  assert.ok(Object.values(HOLD_REASON).every(code => code.startsWith('recipient_provider_')));
});

// ── The 19 failed-Touch-1 leads (24–29) ─────────────────────────────────────

const failedT1Ledger = () => [sentT1('F1'),
  row('sender_auth_delivery_failure', { gmailMessageId: 'D1', senderInboxId: 'scalelabaiteam', deliveryClass: 'sender_auth_failure', dsnAction: 'failed', dsnStatus: '4.7.26', finalFailure: true }),
  row('sender_auth_failed_touch_reconciled', { step: 1, gmailMessageId: 'D1', senderInboxId: 'scalelabaiteam', originalGmailMessageId: 'F1',
    originalGmailThreadId: 'F1', originalSendAt: T1_AT, deliveryClass: 'sender_auth_failure', dsnAction: 'failed', dsnStatus: '4.7.26', finalFailure: true, deliverySucceeded: false })];
const failedLead = (over = {}) => lead({ stage: 'Review', notes: '[MANUAL HOLD] [SENDER-AUTH: SAME-TOUCH RECOVERY REQUIRED: T1]', ...over });

test('24–26. with .com Google-eligible, a failed-T1 lead still never gets Touch 2 or 3, even with hold and Review removed', async () => {
  const unheld = failedLead({ notes: '', stage: 'Contacted' });
  assert.equal(isFollowUpDue(unheld, NOW, { activities: failedT1Ledger() }), false);
  assert.ok(unrecoveredTouchBlock(unheld, failedT1Ledger(), 2));
  assert.ok(unrecoveredTouchBlock(unheld, failedT1Ledger(), 3));
  assert.equal(isFollowUpDue({ ...unheld, emailStep: '2' }, NOW, { activities: failedT1Ledger() }), false);
  // While held, the final gate refuses too.
  assert.equal((await gate(failedLead())).code, 'manual_hold');
});

test('27–29. replacement Touch 1 stays disabled, and a duplicate or retried recovery is refused', async () => {
  const plan = planSameTouchRecovery({ lead: failedLead(), activities: failedT1Ledger(), senders: [COM],
    observers: [{ senderInboxId: 'scalelabaiteam', health: 'healthy' }], env: { SAME_TOUCH_RECOVERY_SENDERS: 'scalelabaiteam' },
    now: new Date(NOW), sendSuppressionReason, releaseHoldFromNotes });
  assert.equal(plan.allowed, false);
  assert.ok(plan.refusals.some(r => r.code === 'authorization_required'));
  const store = createMemorySendReservationStore({ now: () => new Date(NOW) });
  const action = { actionId: recoveryActionId('S1', 1, 'F1'), leadId: 'S1', actionType: 'gmail_touch_recovery', provider: 'gmail' };
  assert.equal((await store.reserveOutboundAction(action, { leaseOwner: 'a' })).ok, true);
  await store.markProviderAttemptStarted(action.actionId, 'a');
  assert.equal((await store.reserveOutboundAction(action, { leaseOwner: 'b' })).ok, false);
});

// ── The 42 presumed-delivered leads (30–31) ─────────────────────────────────

test('30/31. a presumed-delivered T1 is never resent and never becomes a same-T1 recovery', async () => {
  const ledger = [sentT1('P1'),
    row('sender_auth_incident_reconciled', { classification: 'PRESUMED_DELIVERED_AFTER_DELAY', touch: 1, originalGmailMessageId: 'P1' })];
  const presumed = lead({ notes: '[MANUAL HOLD] [SENDER-AUTH: T1 presumed delivered after delay; NO same-touch resend]' });
  assert.equal(unrecoveredTouchBlock(presumed, ledger, 2), null, 'not converted into a failed touch');
  assert.equal(nextFollowUp(presumed, { activities: ledger }).nextStep, 2, 'Touch 1 is never re-offered');
  const plan = planSameTouchRecovery({ lead: { ...presumed, stage: 'Review' }, activities: ledger, sendSuppressionReason, releaseHoldFromNotes, now: new Date(NOW) });
  assert.ok(plan.refusals.some(r => r.code === 'no_proven_failure'));
  assert.ok(plan.refusals.some(r => r.code === 'delivery_presumed'));
  assert.equal((await gate(presumed)).code, 'manual_hold', 'still held: no automatic Touch 2');
});
