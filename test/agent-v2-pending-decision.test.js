'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildConversationState } = require('../integrations/conversation-state');
const { buildAgentV2Input } = require('../integrations/agent-v2-input');
const { validateModelDecision } = require('../integrations/agent-v2-validation');
const { decisionIdFor } = require('../integrations/agent-v2-store');
const { responseActionId } = require('../integrations/prospect-reply-delivery');
const { persistActivityEvents } = require('../integrations/activity-ledger-batch');
const { recordExecution, finalizeReplyDecision, replyDecisionActivity,
  EXECUTION_STATUS } = require('../integrations/reply-decision');
const { evaluateAgentV2Permission } = require('../integrations/agent-v2-permission');
const { evaluateAgentV2Readiness } = require('../integrations/agent-v2-orchestration');
const { AUTHORITY, CATALOG_VERSION, EVENT_TYPE, INPUT_VERSION, SCHEMA_VERSION } = require('../integrations/agent-v2-contract');
const { PENDING_STATUS, PENDING_VERSION, pendingEventId, pendingDecisionActivity,
  pendingDecisionFor, pendingProofMatches, confirmedQualificationActivity } = require('../integrations/agent-v2-pending-decision');

const source = require('./fixtures/agent-v2-synthetic-pilot-second.json');
const LEAD = source.leads[0].id;
const MESSAGE = 'SYNTHETIC_AGENT_V2_PILOT_20260924_MESSAGE_002';
const THREAD = 'SYNTHETIC_AGENT_V2_PILOT_20260924_THREAD_002';
const RFC = '<synthetic-pilot-2@example.test>';

function setup() {
  const fixture = structuredClone(source);
  const inbound = fixture.activities[1];
  inbound.eventType = 'positive_reply';
  inbound.content = "I'm interested.";
  inbound.metadata = JSON.stringify({ ...JSON.parse(inbound.metadata), provider: 'gmail',
    rfcMessageId: RFC, genuineHuman: true, responsePending: true,
    recoveredDuringOutage: false, canonicalState: 'positive' });
  const message = { messageId: MESSAGE, threadId: THREAD, rfcMessageId: RFC,
    senderInboxId: 'primary' };
  const decision = { decisionId: `reply-decision:${LEAD}:${MESSAGE}`,
    leadId: LEAD, inboundMessageId: MESSAGE, finalClassification: 'INTERESTED',
    policyAction: 'AUTO_STAFFING_QUALIFY_QUESTION', policySend: true };
  fixture.activities.splice(2);
  const pending = pendingDecisionActivity({ lead: fixture.leads[0], message,
    decision, sourceRow: inbound });
  return { fixture, inbound, message, decision, pending };
}

function stateFor(fixture) {
  return buildConversationState({ lead: fixture.leads[0], activities: fixture.activities,
    suppressedEmails: new Set(), config: { sequencesEnabled: true, sendingEnabled: true },
    now: '2026-09-24T17:02:00.000Z' });
}

function recordFor(state) {
  const input = buildAgentV2Input(state, MESSAGE);
  const decision = validateModelDecision({ version: SCHEMA_VERSION,
    actionId: 'SUGGEST_QUALIFICATION', handoffCode: 'NONE', factIds: [],
    slotIds: ['roles'], objectionType: 'NONE', evidenceRefs: [input.targetRef],
    templateId: 'QUALIFY', reasonCode: 'QUALIFICATION_GAP', confidence: 0.8 }, input);
  return { decisionId: decisionIdFor(LEAD, MESSAGE), leadId: LEAD, messageId: MESSAGE,
    eventType: EVENT_TYPE, schemaVersion: SCHEMA_VERSION, inputVersion: INPUT_VERSION,
    catalogVersion: CATALOG_VERSION, stateDigest: input.stateDigest,
    inputDigest: input.inputDigest, stateAsOf: input.asOf,
    createdAt: '2026-09-24T17:02:20.000Z', modelStatus: 'ok', decision,
    authority: AUTHORITY };
}

test('provider-backed human interested inbound creates a distinct pending execution event', () => {
  const { fixture, pending } = setup();
  assert.equal(pending.eventId, pendingEventId(LEAD, MESSAGE));
  const metadata = JSON.parse(pending.metadata);
  assert.equal(metadata.version, PENDING_VERSION);
  assert.equal(metadata.executionStatus, PENDING_STATUS);
  assert.equal(metadata.providerProof.genuineHuman, true);
  assert.equal(metadata.providerProof.sourceEventId, `gmail-reply:${MESSAGE}`);
  fixture.activities.push(pending);
  assert.ok(pendingDecisionFor(fixture.activities, MESSAGE, LEAD));
  const forged = structuredClone(fixture.activities);
  const forgedPending = forged.at(-1);
  forgedPending.metadata = JSON.stringify({ ...JSON.parse(forgedPending.metadata),
    providerProof: { ...JSON.parse(forgedPending.metadata).providerProof,
      rfcMessageId: '<different@example.test>' } });
  assert.equal(pendingDecisionFor(forged, MESSAGE, LEAD), null);
  const state = stateFor(fixture);
  const target = state.turns.find(turn => turn.messageId === MESSAGE);
  assert.equal(target.decision.status, PENDING_STATUS);
  assert.equal(pendingProofMatches(state, target), true);
  assert.equal(target.genuineHuman, true);
  const record = recordFor(state);
  assert.equal(record.decision.status, 'valid');
  assert.equal(evaluateAgentV2Permission(state, record).verdict, 'ALLOW');
});

test('pending event is deterministic and duplicate or malformed proof fails closed', () => {
  const { fixture, inbound, message, decision, pending } = setup();
  const again = pendingDecisionActivity({ lead: fixture.leads[0], message, decision, sourceRow: inbound });
  assert.equal(again.eventId, pending.eventId);
  const changed = structuredClone(inbound);
  changed.metadata = JSON.stringify({ ...JSON.parse(changed.metadata), genuineHuman: false });
  assert.equal(pendingDecisionActivity({ lead: fixture.leads[0], message,
    decision, sourceRow: changed }), null);
  const missingProvider = structuredClone(inbound);
  missingProvider.metadata = JSON.stringify({ ...JSON.parse(missingProvider.metadata), provider: '' });
  assert.equal(pendingDecisionActivity({ lead: fixture.leads[0], message,
    decision, sourceRow: missingProvider }), null);
  fixture.activities.push(pending);
  const state = stateFor(fixture);
  const record = recordFor(state);
  state.turns.find(turn => turn.messageId === MESSAGE).decision.providerProof.rfcMessageId = '';
  assert.equal(evaluateAgentV2Permission(state, record).reasonCode, 'PENDING_PROVIDER_PROOF_INVALID');
});

test('automated or out-of-office inbound cannot create eligible pending human state', () => {
  const { fixture, inbound, message, decision } = setup();
  for (const update of [
    row => { row.eventType = 'out_of_office_reply'; },
    row => { row.metadata = JSON.stringify({ ...JSON.parse(row.metadata), genuineHuman: false }); },
    row => { row.metadata = JSON.stringify({ ...JSON.parse(row.metadata), responsePending: false }); },
  ]) {
    const row = structuredClone(inbound);
    update(row);
    assert.equal(pendingDecisionActivity({ lead: fixture.leads[0], message,
      decision, sourceRow: row }), null);
  }
});

test('final sent production outcome replaces pending state without changing the pending row', () => {
  const { fixture, pending } = setup();
  fixture.activities.push(pending);
  const final = { decisionId: `reply-decision:${LEAD}:${MESSAGE}`, leadId: LEAD,
    inboundMessageId: MESSAGE, email: fixture.leads[0].email,
    finalClassification: 'INTERESTED', policyAction: 'AUTO_STAFFING_QUALIFY_QUESTION',
    effects: [], decidedAt: '2026-09-24T17:02:00.000Z' };
  recordExecution(final, { executedAction: 'AUTO_STAFFING_QUALIFY_QUESTION',
    status: EXECUTION_STATUS.SENT });
  finalizeReplyDecision(final);
  assert.equal(final.requiresHumanAttention, false);
  fixture.activities.push(replyDecisionActivity(final));
  const state = stateFor(fixture);
  const target = state.turns.find(turn => turn.messageId === MESSAGE);
  assert.equal(target.decision.status, 'recorded');
  assert.equal(target.decision.executionStatus, 'sent');
  assert.equal(pendingProofMatches(state, target), false);
  assert.notEqual(evaluateAgentV2Permission(state, recordFor(state)).verdict, 'ALLOW');
  assert.equal(fixture.activities.find(row => row.eventId === pending.eventId), pending);
});

test('a blocked or uncertain execution persists a final human-attention outcome', () => {
  for (const status of [EXECUTION_STATUS.BLOCKED, EXECUTION_STATUS.FAILED]) {
    const { fixture, pending } = setup();
    fixture.activities.push(pending);
    const final = { decisionId: `reply-decision:${LEAD}:${MESSAGE}`, leadId: LEAD,
      inboundMessageId: MESSAGE, email: fixture.leads[0].email,
      finalClassification: 'INTERESTED', policyAction: 'AUTO_STAFFING_QUALIFY_QUESTION',
      effects: [], decidedAt: '2026-09-24T17:02:00.000Z' };
    recordExecution(final, { status, code: 'provider_ambiguous', fallbackAction: 'HUMAN_REVIEW' });
    finalizeReplyDecision(final);
    fixture.activities.push(replyDecisionActivity(final));
    const state = stateFor(fixture);
    const target = state.turns.find(turn => turn.messageId === MESSAGE);
    assert.equal(target.decision.status, 'recorded');
    assert.equal(target.decision.executionStatus, status);
    assert.equal(target.decision.requiresHumanAttention, true);
  }
});

test('a repeated pending observation appends one event ID to the existing activity ledger', async () => {
  const { pending } = setup();
  const header = ['eventId', 'leadId', 'sourceLeadId', 'email', 'company',
    'eventType', 'occurredAt', 'subject', 'content', 'metadata'];
  const rows = [header];
  const values = { async get() { return { data: { values: rows } }; },
    async append({ requestBody }) { rows.push(...requestBody.values); } };
  const args = { values, spreadsheetId: 'test', sheetName: 'ColdCallActivity',
    header, ensureSheet: async () => {} };
  assert.equal((await persistActivityEvents({ ...args, events: [pending, pending] })).persisted, 1);
  assert.equal((await persistActivityEvents({ ...args, events: [pending] })).persisted, 0);
  assert.equal(rows.length, 2);
});

test('Phase 5 accepts only proved pending state and fails closed when proof is missing', async () => {
  const { fixture, pending } = setup();
  fixture.activities.push(pending);
  const state = stateFor(fixture);
  const record = recordFor(state);
  const row = { decision_id: record.decisionId, lead_id: LEAD, message_id: MESSAGE,
    claimed_at: new Date('2026-09-24T17:02:05.000Z'), claim_token: 'test', claim_attempts: 1,
    model_started_at: new Date('2026-09-24T17:02:10.000Z'),
    completed_at: new Date('2026-09-24T17:02:21.000Z'),
    created_at: new Date(record.createdAt), action_id: record.decision.actionId, record };
  const args = { leadId: LEAD, messageId: MESSAGE,
    store: { getDecisionRow: async () => row }, loadCurrentState: async () => state,
    checkPhase0: async () => ({ leadId: LEAD, messageId: MESSAGE,
      stateDigest: state.evidenceDigest, observedAt: '2026-09-24T17:03:00.000Z',
      outboundObservationOk: true, alreadyHandled: false, humanTouchBlock: null,
      repeatReason: '', suppressionReason: '' }) };
  assert.equal((await evaluateAgentV2Readiness(args)).executionReady, true);
  state.turns.find(turn => turn.messageId === MESSAGE).decision.providerProof.genuineHuman = false;
  const blocked = await evaluateAgentV2Readiness(args);
  assert.equal(blocked.executionReady, false);
  assert.equal(blocked.reasonCode, 'PENDING_PROVIDER_PROOF_INVALID');
});

test('only the exact delivered qualification activity can complete a pending lifecycle on retry', () => {
  const action = 'AUTO_STAFFING_QUALIFY_QUESTION';
  const id = responseActionId(LEAD, MESSAGE, action);
  const row = { eventId: id, eventType: 'booking_link_sent', sourceLeadId: LEAD,
    metadata: JSON.stringify({ actionId: id, action, inboundMessageId: MESSAGE,
      senderInboxId: 'primary', gmailMessageId: 'SYNTHETIC_DELIVERED_MESSAGE' }) };
  assert.equal(confirmedQualificationActivity([row], LEAD, MESSAGE, 'primary'), row);
  for (const changed of [
    { ...row, eventType: 'prospect_reply_reserved' },
    { ...row, eventId: 'other-id' },
    { ...row, sourceLeadId: 'other-lead' },
    { ...row, metadata: JSON.stringify({ ...JSON.parse(row.metadata), action: 'AUTO_STAFFING_SEND_INFO' }) },
    { ...row, metadata: JSON.stringify({ ...JSON.parse(row.metadata), gmailMessageId: '' }) },
  ]) assert.equal(confirmedQualificationActivity([changed], LEAD, MESSAGE, 'primary'), null);
  assert.equal(confirmedQualificationActivity([row, row], LEAD, MESSAGE, 'primary'), null);
});
