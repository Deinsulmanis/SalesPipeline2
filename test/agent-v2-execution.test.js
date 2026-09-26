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
      reasonCode: 'QUALIFICATION_GAP', confidence: 0.8 }
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
  const safety = ({ leadId, messageId, decisionId, stateDigest, senderInboxId }) => ({
    allowed: true, leadId, messageId, decisionId, stateDigest, senderInboxId,
    providerThreadLatest: true, humanClear: true, repeatClear: true,
    suppressionClear: true, senderOwnershipProven: true, senderEligible: true,
    quotaAvailable: true, windowAvailable: true, currentSendAuthorized: true,
    noNewerInbound: true, noConflictingEvidence: true,
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
      assert.equal(inputDelivery.body, 'Which roles are you focused on filling?');
      reservation = { ...RESERVATION, status: STATUS.CONFIRMED,
        providerMessageId: 'synthetic-provider-message' };
      return { delivered: true, actionId: SEND_ID, result: { data: { id: 'synthetic-provider-message' } } }; },
    env: ENV };
  return { args, calls, row, state, safety, setReservation(value) { reservation = value; } };
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
