'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildConversationState } = require('../integrations/conversation-state');
const { buildAgentV2Input } = require('../integrations/agent-v2-input');
const { validateModelDecision } = require('../integrations/agent-v2-validation');
const { decisionIdFor } = require('../integrations/agent-v2-store');
const { responseActionId } = require('../integrations/prospect-reply-delivery');
const { STATUS } = require('../integrations/send-reservation-rules');
const { createMemorySendReservationStore } = require('../integrations/send-reservation-memory');
const { setSendReservationStoreForTests, closeSendReservationStore,
  withGmailProviderSend, confirmOutboundReservation,
  getOutboundReservation } = require('../integrations/send-lock');
const { AUTHORITY, CATALOG_VERSION, EVENT_TYPE, INPUT_VERSION,
  SCHEMA_VERSION } = require('../integrations/agent-v2-contract');
const { pendingDecisionActivity, QUALIFY_ACTION } = require('../integrations/agent-v2-pending-decision');
const { executeAgentV2Qualification, liveSafetyPasses } = require('../integrations/agent-v2-execution');

const fixture = require('./fixtures/agent-v2-synthetic-pilot-second.json');
const LEAD = fixture.leads[0].id;
const MESSAGE = 'SYNTHETIC_AGENT_V2_PILOT_20260924_MESSAGE_002';
const DECISION = decisionIdFor(LEAD, MESSAGE);
const SEND_ID = responseActionId(LEAD, MESSAGE, QUALIFY_ACTION);
const RESERVATION = { actionId: SEND_ID, leadId: LEAD,
  actionType: 'gmail_warm_reply', provider: 'gmail' };
const ENV = { AGENT_V2_EXECUTION_ENABLED: 'true', SENDING_ENABLED: 'true',
  SEND_AUTHORIZED_ENV: 'test', RAILWAY_ENVIRONMENT: 'test', SEND_AUTHORIZED_TOKEN: 'test',
  SEND_WORKER_ROLE: 'outreach-sender', SEND_LOCK_ENABLED: 'true' };

test.afterEach(async () => { await closeSendReservationStore(); });

function scenario(proposal = 'SUGGEST_QUALIFICATION') {
  const source = structuredClone(fixture);
  source.leads[0].clientId = 'scalelab';
  const inbound = source.activities[1];
  inbound.eventType = 'positive_reply';
  inbound.content = "I'm interested.";
  inbound.metadata = JSON.stringify({ ...JSON.parse(inbound.metadata), provider: 'gmail',
    rfcMessageId: '<synthetic@example.test>', genuineHuman: true,
    responsePending: true, recoveredDuringOutage: false, canonicalState: 'positive' });
  source.activities.splice(2);
  const message = { messageId: MESSAGE, threadId: 'SYNTHETIC_AGENT_V2_PILOT_20260924_THREAD_002',
    rfcMessageId: '<synthetic@example.test>', senderInboxId: 'primary' };
  const production = { decisionId: `reply-decision:${LEAD}:${MESSAGE}`, leadId: LEAD,
    inboundMessageId: MESSAGE, finalClassification: 'INTERESTED',
    policyAction: QUALIFY_ACTION, policySend: true };
  source.activities.push(pendingDecisionActivity({ lead: source.leads[0], message,
    decision: production, sourceRow: inbound }));
  const state = buildConversationState({ lead: source.leads[0], activities: source.activities,
    suppressedEmails: new Set(), config: { sequencesEnabled: true, sendingEnabled: true },
    now: '2026-09-24T17:02:00.000Z' });
  const input = buildAgentV2Input(state, MESSAGE);
  const raw = proposal === 'SUGGEST_QUALIFICATION'
    ? { version: SCHEMA_VERSION, actionId: proposal, handoffCode: 'NONE',
      factIds: [], slotIds: ['roles'], objectionType: 'NONE',
      evidenceRefs: [input.targetRef], templateId: 'QUALIFY',
      reasonCode: 'QUALIFICATION_GAP', confidence: 0.95 }
    : { version: SCHEMA_VERSION, actionId: proposal, handoffCode: 'NONE',
      factIds: ['F_30_DAY_PILOT'], slotIds: [], objectionType: 'NONE',
      evidenceRefs: [input.targetRef], templateId: 'INFO_OVERVIEW',
      reasonCode: 'INFO_REQUEST', confidence: 0.8 };
  const record = { decisionId: DECISION, leadId: LEAD, messageId: MESSAGE,
    eventType: EVENT_TYPE, schemaVersion: SCHEMA_VERSION, inputVersion: INPUT_VERSION,
    catalogVersion: CATALOG_VERSION, stateDigest: input.stateDigest,
    inputDigest: input.inputDigest, stateAsOf: input.asOf,
    createdAt: '2026-09-24T17:02:20.000Z', modelStatus: 'ok',
    decision: validateModelDecision(raw, input), authority: AUTHORITY };
  assert.equal(record.decision.status, 'valid');
  const row = { decision_id: DECISION, lead_id: LEAD, message_id: MESSAGE,
    claimed_at: new Date('2026-09-24T17:02:05.000Z'), claim_token: 'claim', claim_attempts: 1,
    model_started_at: new Date('2026-09-24T17:02:10.000Z'),
    completed_at: new Date('2026-09-24T17:02:21.000Z'),
    created_at: new Date(record.createdAt), action_id: proposal, record };
  const calls = { deliver: 0, safety: 0, phase0: 0, reservations: 0 };
  let reservation = null;
  let killSwitchState = { readable: true, armed: true, code: 'kill_switch_armed' };
  const safety = ({ leadId, messageId, decisionId, stateDigest, senderInboxId }) => ({
    allowed: true, leadId, messageId, decisionId, stateDigest, senderInboxId,
    providerThreadLatest: true, humanClear: true, repeatClear: true,
    suppressionClear: true, senderOwnershipProven: true, senderEligible: true,
    quotaAvailable: true, windowAvailable: true, currentSendAuthorized: true,
    noNewerInbound: true, noConflictingEvidence: true,
    killSwitchArmed: true, canaryCapAvailable: true,
  });
  const args = { leadId: LEAD, messageId: MESSAGE,
    store: { async getDecisionRow() { return { ...row, completed_at: new Date(row.completed_at) }; } },
    loadCurrentState: async () => state,
    checkPhase0: async () => { calls.phase0++; return { leadId: LEAD, messageId: MESSAGE,
      stateDigest: state.evidenceDigest, observedAt: '2026-09-24T17:03:00.000Z',
      outboundObservationOk: true, alreadyHandled: false, humanTouchBlock: null,
      repeatReason: '', suppressionReason: '' }; },
    liveSafety: async inputSafety => { calls.safety++; return safety(inputSafety); },
    reservationLookup: async id => { calls.reservations++; assert.equal(id, SEND_ID); return reservation; },
    deliver: async inputDelivery => { calls.deliver++;
      assert.equal(inputDelivery.actionId, SEND_ID);
      assert.equal(inputDelivery.body, "Got it. To make sure we'd target the right employer accounts for you, what roles or trades do you place most often?");
      reservation = { ...RESERVATION, status: STATUS.CONFIRMED,
        providerMessageId: 'synthetic-provider-message' };
      return { delivered: true, actionId: SEND_ID, result: { data: { id: 'synthetic-provider-message' } } }; },
    killSwitch: async () => { calls.killSwitch = (calls.killSwitch || 0) + 1; return killSwitchState; },
    env: ENV };
  return { args, calls, row, state, safety, setReservation(value) { reservation = value; },
    setKillSwitch(value) { killSwitchState = value; } };
}

test('flag OFF leaves the Phase 6 executor inert, with no database or provider reads', async () => {
  const setup = scenario();
  const disabled = await executeAgentV2Qualification({ ...setup.args,
    env: { ...ENV, AGENT_V2_EXECUTION_ENABLED: 'false' } });
  assert.equal(disabled.executionReasonCode, 'EXECUTION_DISABLED');
  assert.deepEqual(setup.calls, { deliver: 0, safety: 0, phase0: 0, reservations: 0 });
});

test('proved qualification passes Phase 0–5 and fresh safety, then uses the existing send identity', async () => {
  const setup = scenario();
  const outcome = await executeAgentV2Qualification(setup.args);
  assert.equal(outcome.executionVerdict, 'AUTHORIZED');
  assert.equal(outcome.executionAuthorized, true);
  assert.equal(outcome.executionStatus, 'SENT');
  assert.equal(outcome.providerMessageId, 'synthetic-provider-message');
  assert.equal(setup.calls.deliver, 1);
  assert.equal(setup.calls.safety, 1);
  assert.ok(setup.calls.phase0 > 0);
});

test('non-allowlisted action and missing or stale Phase 5 evidence never reach delivery', async () => {
  const info = scenario('SUGGEST_INFO');
  assert.equal((await executeAgentV2Qualification(info.args)).executionReasonCode,
    'ACTION_NOT_ALLOWLISTED');
  assert.equal(info.calls.deliver, 0);
  const missing = scenario();
  missing.args.store.getDecisionRow = async () => null;
  assert.equal((await executeAgentV2Qualification(missing.args)).executionReasonCode,
    'DECISION_UNAVAILABLE');
  const stale = scenario();
  stale.args.loadCurrentState = async () => ({ ...stale.state, evidenceDigest: 'changed' });
  assert.equal((await executeAgentV2Qualification(stale.args)).executionAuthorized, false);
  assert.equal(stale.calls.deliver, 0);
});

test('every live safety gate blocks independently, regardless of model confidence', async () => {
  const flags = ['providerThreadLatest', 'humanClear', 'repeatClear', 'suppressionClear',
    'senderOwnershipProven', 'senderEligible', 'quotaAvailable', 'windowAvailable',
    'currentSendAuthorized', 'noNewerInbound', 'noConflictingEvidence'];
  for (const flag of flags) {
    const setup = scenario();
    setup.args.liveSafety = async input => ({ ...setup.safety(input), [flag]: false });
    const outcome = await executeAgentV2Qualification(setup.args);
    assert.equal(outcome.executionAuthorized, false, flag);
    assert.equal(setup.calls.deliver, 0, flag);
  }
  assert.equal(liveSafetyPasses({ ...scenario().safety({ leadId: LEAD,
    messageId: MESSAGE, decisionId: DECISION, stateDigest: 'x', senderInboxId: 'primary' }),
  allowed: true }, { leadId: LEAD, messageId: MESSAGE,
    decisionId: DECISION, stateDigest: 'different', senderInboxId: 'primary' }), false);
});

test('confirmed reservation is reused even after Phase 1 now says answered; uncertain send fails closed', async () => {
  const confirmed = scenario();
  confirmed.setReservation({ ...RESERVATION, status: STATUS.CONFIRMED,
    providerMessageId: 'prior-provider-message' });
  confirmed.args.loadCurrentState = async () => { throw Error('final state already answered'); };
  const replay = await executeAgentV2Qualification(confirmed.args);
  assert.equal(replay.executionVerdict, 'REUSED');
  assert.equal(replay.executionAuthorized, false);
  assert.equal(replay.providerMessageId, 'prior-provider-message');
  assert.equal(confirmed.calls.deliver, 0);
  const missingProviderId = scenario();
  missingProviderId.setReservation({ ...RESERVATION, status: STATUS.CONFIRMED });
  const malformedReplay = await executeAgentV2Qualification(missingProviderId.args);
  assert.equal(malformedReplay.executionReasonCode, 'CONFIRMED_PROVIDER_ID_MISSING');
  assert.equal(malformedReplay.executionStatus, 'RECONCILIATION_REQUIRED');
  assert.equal(missingProviderId.calls.deliver, 0);
  const uncertain = scenario();
  uncertain.setReservation({ ...RESERVATION, status: STATUS.RECONCILIATION_REQUIRED });
  const blocked = await executeAgentV2Qualification(uncertain.args);
  assert.equal(blocked.executionStatus, 'RECONCILIATION_REQUIRED');
  assert.equal(blocked.executionAuthorized, false);
  assert.equal(uncertain.calls.deliver, 0);
  const conflict = scenario();
  conflict.setReservation({ ...RESERVATION, leadId: 'other-lead', status: STATUS.CONFIRMED });
  assert.equal((await executeAgentV2Qualification(conflict.args)).executionReasonCode,
    'RESERVATION_IDENTITY_MISMATCH');
  assert.equal(conflict.calls.deliver, 0);
});

test('concurrent Phase 6 workers share the durable send reservation; only one provider call is authorized', async () => {
  const setup = scenario();
  setSendReservationStoreForTests(createMemorySendReservationStore());
  let providerCalls = 0;
  setup.args.reservationLookup = getOutboundReservation;
  setup.args.deliver = async input => {
    setup.calls.deliver++;
    try {
      const response = await withGmailProviderSend({ lead: { id: LEAD },
        sendAction: { ...RESERVATION }, env: ENV,
        run: async () => { providerCalls++;
          await new Promise(resolve => setTimeout(resolve, 15));
          return { data: { id: 'synthetic-provider-message', threadId: 'synthetic-thread' } }; } });
      await confirmOutboundReservation(input.actionId, ENV);
      return { delivered: true, actionId: input.actionId, result: response };
    } catch (error) { return { delivered: false, code: error.code }; }
  };
  const [first, second] = await Promise.all([
    executeAgentV2Qualification(setup.args), executeAgentV2Qualification(setup.args),
  ]);
  assert.equal(providerCalls, 1);
  assert.equal(Number(first.executionAuthorized) + Number(second.executionAuthorized), 1);
  assert.equal((await getOutboundReservation(SEND_ID, ENV)).status, STATUS.CONFIRMED);
});

test('provider ambiguity and identity mismatch require reconciliation, never a claimed success', async () => {
  const ambiguous = scenario();
  ambiguous.args.deliver = async () => { ambiguous.calls.deliver++;
    throw Error('unknown provider outcome'); };
  const uncertain = await executeAgentV2Qualification(ambiguous.args);
  assert.equal(uncertain.executionStatus, 'RECONCILIATION_REQUIRED');
  assert.equal(uncertain.executionAuthorized, false);
  const mismatch = scenario();
  mismatch.args.deliver = async () => ({ delivered: true, actionId: 'wrong-action' });
  const wrongIdentity = await executeAgentV2Qualification(mismatch.args);
  assert.equal(wrongIdentity.executionStatus, 'RECONCILIATION_REQUIRED');
  assert.equal(wrongIdentity.executionAuthorized, false);
  const providerUncertain = scenario();
  providerUncertain.args.deliver = async () => ({ delivered: false, code: 'provider_ambiguous' });
  assert.equal((await executeAgentV2Qualification(providerUncertain.args)).executionStatus,
    'RECONCILIATION_REQUIRED');
  const gateBlocked = scenario();
  gateBlocked.args.deliver = async () => ({ delivered: false, code: 'thread_mismatch' });
  const refusal = await executeAgentV2Qualification(gateBlocked.args);
  assert.equal(refusal.executionStatus, 'BLOCKED');
  assert.equal(refusal.executionAuthorized, false);
  const missingConfirmation = scenario();
  missingConfirmation.args.deliver = async input => ({ delivered: true,
    actionId: input.actionId, result: { data: { id: 'provider-reported-success' } } });
  const unconfirmed = await executeAgentV2Qualification(missingConfirmation.args);
  assert.equal(unconfirmed.executionStatus, 'RECONCILIATION_REQUIRED');
  assert.equal(unconfirmed.executionReasonCode, 'SEND_CONFIRMATION_UNVERIFIED');
  assert.equal(unconfirmed.executionAuthorized, false);
});

// ── runtime kill switch (2026-10-01) ────────────────────────────────────────
test('kill switch: execution needs the configured flag AND the live switch armed; any doubt denies', async () => {
  const off = scenario();
  off.setKillSwitch({ readable: true, armed: false, code: 'kill_switch_disarmed' });
  assert.equal((await executeAgentV2Qualification(off.args)).executionReasonCode, 'KILL_SWITCH_DISARMED');
  assert.equal(off.calls.deliver, 0);
  const unreadable = scenario();
  unreadable.setKillSwitch({ readable: false, armed: false, code: 'kill_switch_unreachable' });
  assert.equal((await executeAgentV2Qualification(unreadable.args)).executionReasonCode, 'KILL_SWITCH_UNREADABLE');
  assert.equal(unreadable.calls.deliver, 0);
  const throwing = scenario();
  throwing.args.killSwitch = async () => { throw new Error('network'); };
  assert.equal((await executeAgentV2Qualification(throwing.args)).executionReasonCode, 'KILL_SWITCH_UNREADABLE');
  const missing = scenario();
  delete missing.args.killSwitch;
  assert.equal((await executeAgentV2Qualification(missing.args)).executionReasonCode, 'EXECUTION_INPUT_UNAVAILABLE');
  assert.equal(missing.calls.deliver, 0);
  const flagOff = scenario();
  assert.equal((await executeAgentV2Qualification({ ...flagOff.args,
    env: { ...ENV, AGENT_V2_EXECUTION_ENABLED: 'false' } })).executionReasonCode, 'EXECUTION_DISABLED');
  assert.equal(flagOff.calls.killSwitch || 0, 0);
  const on = scenario();
  const sent = await executeAgentV2Qualification(on.args);
  assert.equal(sent.executionStatus, 'SENT');
  assert.equal(on.calls.killSwitch, 2); // before readiness and immediately before delivery
  // Disarmed between readiness and the send: the second read stops it.
  const late = scenario();
  let reads = 0;
  late.args.killSwitch = async () => (++reads === 1 ? { readable: true, armed: true }
    : { readable: true, armed: false, code: 'kill_switch_disarmed' });
  assert.equal((await executeAgentV2Qualification(late.args)).executionReasonCode, 'KILL_SWITCH_DISARMED');
  assert.equal(late.calls.deliver, 0);
});

test('canary gate: a valid decision below 0.90 or outside the canary never reaches delivery', async () => {
  const low = scenario();
  const lowRow = { ...low.row, record: { ...low.row.record, decision: { ...low.row.record.decision, confidence: 0.89 } } };
  low.args.store = { async getDecisionRow() { return { ...lowRow, completed_at: new Date(lowRow.completed_at) }; } };
  const outcome = await executeAgentV2Qualification(low.args);
  assert.equal(outcome.executionAuthorized, false);
  assert.equal(low.calls.deliver, 0);
  const capFull = scenario();
  capFull.args.liveSafety = async input => ({ ...capFull.safety(input), canaryCapAvailable: false });
  assert.equal((await executeAgentV2Qualification(capFull.args)).executionAuthorized, false);
  assert.equal(capFull.calls.deliver, 0);
});

// ── provider-native send recovery (2026-10-01) ──────────────────────────────
const { locateAgentV2Send, reconcileAgentV2Send, ACTION_HEADER } = require('../integrations/agent-v2-send-recovery');
const { confirmReconciledReservation, markReservationReconciliationRequired } = require('../integrations/send-lock');
const THREAD = 'SYNTHETIC_AGENT_V2_PILOT_20260924_THREAD_002';

function fakeGmail({ messages = {}, thread = [] } = {}) {
  return { users: {
    messages: { get: async ({ id }) => { if (!messages[id]) { const e = new Error('Not Found'); e.status = 404; throw e; }
      return { data: messages[id] }; } },
    threads: { get: async () => ({ data: { messages: thread } }) },
  } };
}
const sentMessage = (id, over = {}) => ({ id, threadId: THREAD, labelIds: ['SENT'],
  internalDate: String(Date.parse('2026-09-24T17:05:00Z')), payload: { headers: [
    { name: 'From', value: 'ScaleLab <deins@scalelabai.ca>' }, { name: 'To', value: 'synthetic@example.test' },
    { name: ACTION_HEADER, value: SEND_ID }] }, ...over });

test('crash after a successful send: the retry proves it from Gmail and reconciles, with no second email', async () => {
  setSendReservationStoreForTests(createMemorySendReservationStore());
  const ledger = [];
  let providerCalls = 0;
  const first = scenario();
  first.args.reservationLookup = getOutboundReservation;
  first.args.deliver = async () => {
    first.calls.deliver++;
    await withGmailProviderSend({ lead: { id: LEAD }, sendAction: { ...RESERVATION }, env: ENV,
      run: async () => { providerCalls++; return { data: { id: 'gmail-sent-1', threadId: THREAD } }; } });
    throw new Error('process crashed before the ledger write and the confirmation');
  };
  const crashed = await executeAgentV2Qualification(first.args);
  assert.equal(crashed.executionStatus, 'RECONCILIATION_REQUIRED');
  assert.equal((await getOutboundReservation(SEND_ID, ENV)).status, STATUS.SENT_UNCONFIRMED);

  const retry = scenario();
  retry.args.reservationLookup = getOutboundReservation;
  retry.args.recoverSend = ({ reservation, actionId }) => reconcileAgentV2Send({ reservation, deps: {
    locate: () => locateAgentV2Send({ gmail: fakeGmail({ messages: { 'gmail-sent-1': sentMessage('gmail-sent-1') } }),
      actionId, reservation, threadId: THREAD,
      senderEmail: 'deins@scalelabai.ca', recipientEmail: 'synthetic@example.test', afterInternalDate: 0 }),
    hasDelivered: async () => ledger.some(row => row.eventId === actionId),
    writeDelivered: async ({ providerMessageId }) => { ledger.push({ eventId: actionId, eventType: 'booking_link_sent', providerMessageId }); },
    confirm: () => confirmReconciledReservation(actionId, ENV),
    markReconciliation: reason => markReservationReconciliationRequired(actionId, reason, ENV),
  } });
  retry.args.deliver = async () => { retry.calls.deliver++; providerCalls++; return { delivered: true, actionId: SEND_ID }; };
  const recovered = await executeAgentV2Qualification(retry.args);
  assert.equal(recovered.executionStatus, 'ALREADY_SENT');
  assert.equal(recovered.executionReasonCode, 'PRIOR_PROVIDER_SEND_RECOVERED');
  assert.equal(recovered.providerMessageId, 'gmail-sent-1');
  assert.equal(retry.calls.deliver, 0);
  assert.equal(providerCalls, 1);
  assert.equal(ledger.length, 1);
  assert.equal((await getOutboundReservation(SEND_ID, ENV)).status, STATUS.CONFIRMED);
  const third = scenario();
  third.args.reservationLookup = getOutboundReservation;
  assert.equal((await executeAgentV2Qualification(third.args)).executionVerdict, 'REUSED');
  assert.equal(third.calls.deliver, 0);
});

test('inconclusive recovery, timeout and duplicate reservation all hand off without resending', async () => {
  setSendReservationStoreForTests(createMemorySendReservationStore());
  await withGmailProviderSend({ lead: { id: LEAD }, sendAction: { ...RESERVATION }, env: ENV,
    run: async () => ({ data: { id: 'gmail-sent-2' } }) });
  const setup = scenario();
  setup.args.reservationLookup = getOutboundReservation;
  setup.args.recoverSend = ({ reservation, actionId }) => reconcileAgentV2Send({ reservation, deps: {
    locate: () => locateAgentV2Send({ gmail: fakeGmail(), actionId, reservation, threadId: 't', senderEmail: 'deins@scalelabai.ca',
      recipientEmail: 'synthetic@example.test' }),
    hasDelivered: async () => false, writeDelivered: async () => { throw new Error('must not write'); },
    confirm: async () => { throw new Error('must not confirm'); },
    markReconciliation: reason => markReservationReconciliationRequired(actionId, reason, ENV),
  } });
  const outcome = await executeAgentV2Qualification(setup.args);
  assert.equal(outcome.executionStatus, 'RECONCILIATION_REQUIRED');
  assert.match(outcome.executionReasonCode, /^RECONCILIATION_PROVIDER_LOOKUP_FAILED/);
  assert.equal(setup.calls.deliver, 0);
  assert.equal((await getOutboundReservation(SEND_ID, ENV)).status, STATUS.RECONCILIATION_REQUIRED);

  const base = { actionId: SEND_ID, threadId: 'th', senderEmail: 'deins@scalelabai.ca', recipientEmail: 'synthetic@example.test' };
  assert.equal((await locateAgentV2Send({ ...base, gmail: fakeGmail() })).reason, 'no_send_found');
  const unlabelled = sentMessage('u1', { threadId: 'th', payload: { headers: [{ name: 'From', value: 'deins@scalelabai.ca' },
    { name: 'To', value: 'synthetic@example.test' }] } });
  const located = await locateAgentV2Send({ ...base, gmail: fakeGmail({ thread: [unlabelled] }) });
  assert.equal(located.status, 'INCONCLUSIVE');
  assert.equal(located.reason, 'unlabelled_send_after_inbound');
  const byHeader = await locateAgentV2Send({ ...base, gmail: fakeGmail({ thread: [sentMessage('h1', { threadId: 'th' })] }) });
  assert.deepEqual([byHeader.status, byHeader.evidence, byHeader.providerMessageId], ['SENT', 'action_header', 'h1']);
  const wrongRecipient = sentMessage('w1', { threadId: 'th', payload: { headers: [{ name: 'From', value: 'deins@scalelabai.ca' },
    { name: 'To', value: 'someone-else@example.test' }, { name: ACTION_HEADER, value: SEND_ID }] } });
  assert.equal((await locateAgentV2Send({ ...base, gmail: fakeGmail({ thread: [wrongRecipient] }) })).status, 'INCONCLUSIVE');
  assert.equal((await locateAgentV2Send({ ...base, gmail: fakeGmail(), reservation: { providerMessageId: 'gone' } })).reason,
    'provider_lookup_failed_404');
  const mismatched = await reconcileAgentV2Send({ reservation: { providerMessageId: 'other' }, deps: {
    locate: async () => ({ status: 'SENT', providerMessageId: 'h1', threadId: 'th' }),
    hasDelivered: async () => false, writeDelivered: async () => { throw new Error('no'); }, confirm: async () => { throw new Error('no'); },
    markReconciliation: async () => {} } });
  assert.equal(mismatched.code, 'sent_but_reservation_unconfirmable');

  const { deliverProspectReply } = require('../integrations/prospect-reply-delivery');
  let sends = 0;
  const deps = { existingDelivery: async () => false, findDelivered: async () => null,
    existingReservation: async () => ({ unresolved: false, attempts: 0 }), finalRevalidate: async () => ({ allowed: true }),
    verifyThread: async () => ({ ok: true }), persistReservation: async () => ({}), persistDelivered: async () => {},
    persistFailure: async () => {}, sendProvider: async () => { sends++; const e = new Error('Request timed out'); e.code = 'ETIMEDOUT'; throw e; } };
  const input = { lead: { id: LEAD, email: 'synthetic@example.test' }, sender: { id: 'primary', email: 'deins@scalelabai.ca', sendEligible: true },
    thread: { threadId: 'th' }, inboundMessage: { messageId: MESSAGE, rfcMessageId: '<m@x>' }, action: QUALIFY_ACTION, subject: 'Re', body: 'b' };
  assert.equal((await deliverProspectReply(input, deps)).code, 'provider_ambiguous');
  const again = await deliverProspectReply(input, { ...deps, existingReservation: async () => ({ unresolved: true, attempts: 1 }) });
  assert.equal(again.code, 'reservation_unresolved');
  await assert.rejects(deliverProspectReply(input, { ...deps, findDelivered: async () => {
    const e = new Error('inconclusive'); e.code = 'reconciliation_required'; throw e; } }), /inconclusive/);
  assert.equal(sends, 1);
});
