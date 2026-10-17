'use strict';
// P0: stage-sequence sends must obey the same recipient-provider / sender-pool
// gate as ordinary cold. purpose === 'sequence' used to skip coldDeliveryGate.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PROVIDER, HOLD_REASON, isProspectingSend, coldDeliveryVerdict } = require('../integrations/cold-delivery-policy');
const { guardProviderSend, evaluateFreshSendSafety } = require('../integrations/send-safety-revalidate');
const { sendAuthorization } = require('../integrations/send-authorization');
const { createMemorySendReservationStore } = require('../integrations/send-reservation-memory');
const { ordinaryColdActionId, stageSequenceActionId } = require('../integrations/outbound-action-id');

const root = path.join(__dirname, '..');
const SEND_ENV = Object.freeze({
  SENDING_ENABLED: 'true', SEND_AUTHORIZED_ENV: 'test', RAILWAY_ENVIRONMENT: 'test',
  SEND_AUTHORIZED_TOKEN: 'token', SEND_WORKER_ROLE: 'outreach-sender', SEND_LOCK_ENABLED: 'true',
});
const PRIMARY = Object.freeze({ id: 'primary', status: 'active', sendEligible: true });
const PAUSED = Object.freeze({ id: 'primary', status: 'paused', sendEligible: false });
const GOOGLE = Object.freeze({ provider: PROVIDER.GOOGLE, domain: 'acme.com', reason: 'google_mx' });
const MICROSOFT = Object.freeze({ provider: PROVIDER.MICROSOFT, domain: 'corp.com', reason: 'microsoft_mx' });
const OTHER = Object.freeze({ provider: PROVIDER.OTHER, domain: 'zoho.biz', reason: 'other_provider_mx' });
const UNKNOWN = Object.freeze({ provider: PROVIDER.UNKNOWN, domain: 'odd.com', reason: 'unrecognized_mx' });

const lead = (over = {}) => ({
  id: 'L1', email: 'owner@acme.com', notes: '', stage: 'Queued', emailStatus: '',
  emailStep: '', campaign: 'Ontario List', ...over,
});

const gate = (current, {
  purpose = 'sequence', classification = GOOGLE, sender = PRIMARY, suppressed = new Set(), env = SEND_ENV,
} = {}) => guardProviderSend(current,
  { env, classifyRecipient: async () => classification, loadFreshState: async () => ({ current, suppressedEmails: suppressed }) },
  { purpose, ...(sender ? { coldSender: sender, senderInboxId: sender.id } : {}) });

test('1. stage-sequence + GOOGLE may proceed when every other gate passes', async () => {
  const verdict = await gate(lead(), { purpose: 'sequence', classification: GOOGLE, sender: PRIMARY });
  assert.equal(verdict.allowed, true);
  assert.equal(isProspectingSend('sequence'), true);
  assert.equal(coldDeliveryVerdict({ sender: PRIMARY, classification: GOOGLE, env: {} }).allowed, true);
});

test('2. stage-sequence + MICROSOFT is blocked', async () => {
  const verdict = await gate(lead({ email: 'pat@corp.com' }), { purpose: 'sequence', classification: MICROSOFT });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, HOLD_REASON.MICROSOFT);
});

test('3. stage-sequence + UNKNOWN is blocked', async () => {
  const verdict = await gate(lead({ email: 'x@odd.com' }), { purpose: 'sequence', classification: UNKNOWN });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, HOLD_REASON.UNKNOWN);
});

test('4. stage-sequence + OTHER is blocked', async () => {
  const verdict = await gate(lead({ email: 'x@zoho.biz' }), { purpose: 'sequence', classification: OTHER });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, HOLD_REASON.OTHER);
});

test('5. ordinary cold + Microsoft is still blocked', async () => {
  const verdict = await gate(lead({ email: 'pat@outlook.com' }), { purpose: 'cold', classification: MICROSOFT });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.code, HOLD_REASON.MICROSOFT);
});

test('6. warm / reply traffic is not blocked by the recipient-provider gate', async () => {
  const microsoftLead = lead({ email: 'pat@outlook.com' });
  const warmGate = await gate(microsoftLead, { purpose: 'warm', classification: MICROSOFT });
  assert.equal(warmGate.allowed, true, 'guardProviderSend(purpose=warm) skips the google_only gate');
  const replied = lead({ email: 'pat@outlook.com', stage: 'Replied', emailStatus: 'replied' });
  const warmSafety = evaluateFreshSendSafety(replied, replied, new Set(), { purpose: 'warm', env: SEND_ENV });
  assert.equal(warmSafety.allowed, true, 'evaluateFreshSendSafety(warm) still allows conversational replies');
  assert.equal(isProspectingSend('warm'), false);
  // Missing / unknown purpose stays fail-closed as prospecting.
  const missing = await gate(microsoftLead, { purpose: undefined, classification: MICROSOFT });
  assert.equal(missing.allowed, false);
  assert.equal(missing.code, HOLD_REASON.MICROSOFT);
});

test('7. paused / ineligible sender remains blocked regardless of provider', async () => {
  for (const purpose of ['cold', 'sequence']) {
    const verdict = await gate(lead(), { purpose, classification: GOOGLE, sender: PAUSED });
    assert.equal(verdict.allowed, false, purpose);
    assert.equal(verdict.code, 'sender_not_send_eligible', purpose);
  }
});

test('8. suppression / DNC / unsubscribe still win over a Google stage-sequence send', async () => {
  const google = { purpose: 'sequence', classification: GOOGLE, sender: PRIMARY };
  assert.equal((await gate(lead({ notes: '[REPLY: Unsubscribed]' }), google)).code, 'unsubscribed');
  assert.equal((await gate(lead({ notes: '[REPLY: Not Interested]' }), google)).allowed, false);
  assert.equal((await gate(lead(), { ...google, suppressed: new Set(['owner@acme.com']) })).code, 'suppressed');
  assert.equal((await gate(lead({ notes: '[MANUAL HOLD]' }), google)).code, 'manual_hold');
  assert.equal((await gate(lead({ notes: '[BOUNCED]' }), google)).code, 'bounced');
});

test('9. durable reservation and send-authorization protections remain intact', async () => {
  assert.equal(sendAuthorization({}).allowed, false);
  assert.equal((await gate(lead(), { env: {} })).allowed, false);

  const store = createMemorySendReservationStore({ now: () => new Date('2026-10-07T16:00:00Z') });
  const coldAction = { actionId: ordinaryColdActionId('L1', 1), leadId: 'L1', actionType: 'gmail_cold_step', provider: 'gmail' };
  assert.equal((await store.reserveOutboundAction(coldAction, { leaseOwner: 'a' })).ok, true);
  await store.markProviderAttemptStarted(coldAction.actionId, 'a');
  await store.markProviderSucceeded(coldAction.actionId, 'a', { providerMessageId: 'G1' });
  await store.markConfirmed(coldAction.actionId, 'a');
  assert.equal((await store.reserveOutboundAction(coldAction, { leaseOwner: 'b' })).code, 'reservation_confirmed');

  const seqAction = { actionId: stageSequenceActionId('CE-L1', 'hot_stale_v1', 1), leadId: 'L1', actionType: 'gmail_sequence_step', provider: 'gmail' };
  assert.equal((await store.reserveOutboundAction(seqAction, { leaseOwner: 'a' })).ok, true);
  await store.markProviderAttemptStarted(seqAction.actionId, 'a');
  assert.equal((await store.reserveOutboundAction(seqAction, { leaseOwner: 'b' })).ok, false);
});

test('the sequence call site classifies before reserve and peeks at the final gate', () => {
  const agent = fs.readFileSync(path.join(root, 'outreach-agent.js'), 'utf8').split('\r\n').join('\n');
  const pass = agent.slice(agent.indexOf('async function runStageSequencePass'), agent.indexOf('async function run()'));
  const at = needle => { const i = pass.indexOf(needle); assert.ok(i >= 0, needle); return i; };
  assert.ok(at('recipientProviderClassifier.classify(boardLead.email)') < at('eventType: SEQUENCE_EVENTS.SEND_RESERVED'));
  assert.ok(at('coldDeliveryVerdict({ sender, classification: recipientProvider })') < at('const reservationEventId'));
  assert.ok(at('if (!coldVerdict.allowed)') < at('await recordColdCallActivityStrict(reservation)'));
  assert.ok(at('await recordColdCallActivityStrict(reservation)') < at('guardProviderSend(safetyLead'));
  assert.ok(at('guardProviderSend(safetyLead') < at('result = await sendEmail('));
  assert.match(pass, /purpose: 'sequence', senderInboxId: sender\.id, coldSender: sender/);
  const guard = fs.readFileSync(path.join(root, 'integrations/send-safety-revalidate.js'), 'utf8');
  assert.match(guard, /isProspectingSend\(options\.purpose\)/);
  assert.doesNotMatch(guard, /options\.purpose !== 'cold'/);
});
