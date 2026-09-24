'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildConversationState } = require('../integrations/conversation-state');
const { buildAgentV2Input } = require('../integrations/agent-v2-input');
const { decisionIdFor, createPgAgentV2Store } = require('../integrations/agent-v2-store');
const { validateModelDecision } = require('../integrations/agent-v2-validation');
const { AUTHORITY, CATALOG_VERSION, EVENT_TYPE, INPUT_VERSION,
  SCHEMA_VERSION } = require('../integrations/agent-v2-contract');
const { ORCHESTRATION_VERSION, evaluateAgentV2Readiness,
  runAgentV2OneShotReadiness } = require('../integrations/agent-v2-orchestration');

const fixture = require('./fixtures/agent-v2-synthetic-pilot-second.json');
const LEAD = fixture.leads[0].id;
const MESSAGE = 'SYNTHETIC_AGENT_V2_PILOT_20260924_MESSAGE_002';
const DECISION = decisionIdFor(LEAD, MESSAGE);
const CREATED = '2026-09-24T17:02:20.000Z';
const COMPLETED = '2026-09-24T17:02:21.000Z';

function phase1() {
  return buildConversationState({ lead: fixture.leads[0], activities: fixture.activities,
    suppressedEmails: new Set(fixture.suppressedEmails),
    config: { sequencesEnabled: true, sendingEnabled: true },
    now: '2026-09-24T17:02:00.000Z' });
}
function target(state) { return state.turns.find(turn => turn.messageId === MESSAGE); }
function rawFor(state, overrides = {}) {
  const input = buildAgentV2Input(state, MESSAGE);
  return { version: SCHEMA_VERSION, actionId: 'SUGGEST_INFO', handoffCode: 'NONE',
    factIds: ['F_30_DAY_PILOT'], slotIds: [], objectionType: 'NONE',
    evidenceRefs: [input.targetRef], templateId: 'INFO_OVERVIEW',
    reasonCode: 'INFO_REQUEST', confidence: 0.8, ...overrides };
}
function rowFor(state, overrides = {}, rowOverrides = {}) {
  const input = buildAgentV2Input(state, MESSAGE);
  const record = { decisionId: DECISION, leadId: LEAD, messageId: MESSAGE,
    eventType: EVENT_TYPE, schemaVersion: SCHEMA_VERSION, inputVersion: INPUT_VERSION,
    catalogVersion: CATALOG_VERSION, stateDigest: input.stateDigest,
    inputDigest: input.inputDigest, stateAsOf: input.asOf,
    createdAt: CREATED, modelStatus: 'ok',
    decision: validateModelDecision(rawFor(state, overrides), input), authority: AUTHORITY };
  return { decision_id: DECISION, lead_id: LEAD, message_id: MESSAGE,
    claimed_at: new Date('2026-09-24T17:02:05.000Z'), claim_token: 'test-claim-token',
    claim_attempts: 1, model_started_at: new Date('2026-09-24T17:02:10.000Z'),
    completed_at: new Date(COMPLETED), created_at: new Date(CREATED),
    action_id: record.decision.actionId, record, ...rowOverrides };
}
function context(row, loadCurrentState = async () => phase1(), checkPhase0 = async ({ state }) => ({
  leadId: LEAD, messageId: MESSAGE, stateDigest: state.evidenceDigest,
  observedAt: '2026-09-24T17:03:00.000Z', outboundObservationOk: true,
  alreadyHandled: false, humanTouchBlock: null, repeatReason: '', suppressionReason: '',
})) {
  let reads = 0;
  return { leadId: LEAD, messageId: MESSAGE,
    store: { async getDecisionRow() { reads++; return row; } },
    loadCurrentState, checkPhase0, reads: () => reads };
}

test('completed info decision reads the durable row, then permits and renders with zero authority', async () => {
  const state = phase1();
  const args = context(rowFor(state));
  const result = await evaluateAgentV2Readiness(args);
  assert.deepEqual(result, { version: ORCHESTRATION_VERSION, decisionId: DECISION,
    leadId: LEAD, messageId: MESSAGE, decisionStatus: 'COMPLETE',
    permissionVerdict: 'ALLOW', permissionReasonCode: 'INFORMATION_ADVISORY',
    wordingStatus: 'RENDERED', wording: 'Sure — the employer acquisition pilot lasts 30 days.',
    reasonCode: 'READY', executionReady: true, executionAuthorized: false,
    authority: AUTHORITY });
  assert.equal(args.reads(), 1);
  assert.ok(Object.values(result.authority).every(value => value === false));
  assert.deepEqual(await evaluateAgentV2Readiness(args), result);
});

test('Postgres store reads completion metadata and record by deterministic decision ID', async () => {
  const expected = rowFor(phase1());
  const queries = [];
  const store = createPgAgentV2Store({ pool: { async query(sql, params) {
    queries.push([sql, params]);
    return { rows: params ? [expected] : [] };
  } } });
  assert.deepEqual(await store.getDecisionRow(DECISION), expected);
  assert.equal(queries.length, 2);
  assert.match(queries[1][0], /SELECT decision_id, lead_id, message_id,[\s\S]*completed_at,[\s\S]*record/);
  assert.match(queries[1][0], /WHERE decision_id = \$1/);
  assert.deepEqual(queries[1][1], [DECISION]);
});

test('qualification, fact answer and booking coordination each require valid permission and wording', async () => {
  for (const [mutate, proposal, expectedReason] of [
    [s => { target(s).decision.finalClassification = 'INTERESTED';
      target(s).classification.value = 'INTERESTED'; },
    { actionId: 'SUGGEST_QUALIFICATION', factIds: [], slotIds: ['roles'],
      templateId: 'QUALIFY', reasonCode: 'QUALIFICATION_GAP' }, 'OPEN_QUALIFICATION_SLOT'],
    [() => {}, { actionId: 'SUGGEST_FACT_ANSWER', templateId: 'FACTS_ONLY',
      reasonCode: 'APPROVED_FACT_MATCH' }, 'APPROVED_FACT_ADVISORY'],
    [s => { s.booking.meetingIntent.value = true; },
    { actionId: 'SUGGEST_BOOKING_COORDINATION', factIds: [],
      templateId: 'BOOKING_COORDINATION', reasonCode: 'MEETING_INTENT' },
    'BOOKING_COORDINATION_ADVISORY'],
  ]) {
    const state = phase1(); mutate(state);
    const result = await evaluateAgentV2Readiness(context(rowFor(state, proposal),
      async () => state));
    assert.equal(result.permissionReasonCode, expectedReason);
    assert.equal(result.wordingStatus, 'RENDERED');
    assert.equal(result.executionReady, true);
    assert.equal(result.executionAuthorized, false);
    assert.ok(Object.values(result.authority).every(value => value === false));
  }
});

test('missing, partial and malformed ledger rows cannot reach permission or wording', async () => {
  const state = phase1();
  const completed = rowFor(state);
  const cases = [
    [null, 'MISSING', 'LEDGER_MISSING'],
    [{ ...completed, record: null, completed_at: null }, 'INCOMPLETE', 'LEDGER_INCOMPLETE'],
    [{ ...completed, completed_at: null }, 'INCOMPLETE', 'LEDGER_INCOMPLETE'],
    [{ ...completed, record: { ...completed.record, decision: null } }, 'INVALID', 'LEDGER_INVALID'],
    [{ ...completed, model_started_at: null }, 'INVALID', 'LEDGER_INVALID'],
    [{ ...completed, record: { ...completed.record, stateAsOf: null } }, 'INVALID', 'LEDGER_INVALID'],
    [{ ...completed, lead_id: 'other' }, 'INVALID', 'LEDGER_IDENTITY_MISMATCH'],
    [{ ...completed, message_id: 'other' }, 'INVALID', 'LEDGER_IDENTITY_MISMATCH'],
    [{ ...completed, decision_id: 'other' }, 'INVALID', 'LEDGER_IDENTITY_MISMATCH'],
    [{ ...completed, record: { ...completed.record, messageId: 'other' } }, 'INVALID', 'LEDGER_INVALID'],
  ];
  for (const [row, status, reason] of cases) {
    let stateLoads = 0; let phase0Calls = 0;
    const args = context(row, async () => { stateLoads++; return state; },
      async () => { phase0Calls++; return null; });
    const result = await evaluateAgentV2Readiness(args);
    assert.equal(result.decisionStatus, status, reason);
    assert.equal(result.reasonCode, reason);
    assert.equal(result.executionReady, false);
    assert.equal(result.wordingStatus, 'NOT_RUN');
    assert.equal(stateLoads, 0);
    assert.equal(phase0Calls, 0);
  }
});

test('fresh Phase 1 state changes, conflicts, and missing state fail closed', async () => {
  const original = phase1();
  const row = rowFor(original);
  const changed = phase1(); changed.evidenceDigest = 'later-evidence';
  for (const [loader, reason] of [
    [async () => changed, 'STATE_CHANGED'],
    [async () => { const s = phase1(); s.asOf = '2026-09-24T17:04:00.000Z'; return s; },
      'STATE_CLOCK_MISMATCH'],
    [async () => { const s = phase1(); s.evidenceWarnings.push({ code: 'conflict' }); return s; }, 'EVIDENCE_WARNING'],
    [async () => null, 'PHASE1_UNAVAILABLE'],
    [async () => { throw Error('source unavailable'); }, 'PHASE1_UNAVAILABLE'],
  ]) {
    const result = await evaluateAgentV2Readiness(context(row, loader));
    assert.equal(result.reasonCode, reason);
    assert.equal(result.executionReady, false);
    assert.equal(result.wording, null);
  }
});

test('Phase 3 DENY and HANDOFF never call Phase 0 or Phase 4', async () => {
  for (const [mutate, verdict] of [
    [s => { s.terminalState.blockedBy = 'unsubscribed'; }, 'DENY'],
    [s => { s.ownership.humanTakeover.value = true; }, 'HANDOFF'],
  ]) {
    const state = phase1();
    const row = rowFor(state);
    mutate(state);
    let phase0Calls = 0;
    const result = await evaluateAgentV2Readiness(context(row, async () => state,
      async () => { phase0Calls++; throw Error('not needed'); }));
    assert.equal(result.permissionVerdict, verdict);
    assert.equal(result.wordingStatus, 'NOT_RUN');
    assert.equal(result.executionReady, false);
    assert.equal(phase0Calls, 0);
  }
});

test('structurally malformed completed proposal is rejected by Phase 3 without wording', async () => {
  const state = phase1();
  const row = rowFor(state);
  row.record.decision = { ...row.record.decision, factIds: ['F_NOT_APPROVED'] };
  const result = await evaluateAgentV2Readiness(context(row, async () => state));
  assert.equal(result.permissionVerdict, 'DENY');
  assert.equal(result.permissionReasonCode, 'INVALID_DECISION');
  assert.equal(result.wordingStatus, 'NOT_RUN');
  assert.equal(result.executionReady, false);
});

test('live Phase 0 observation is mandatory, current, identity bound and clear', async () => {
  const state = phase1();
  const row = rowFor(state);
  const base = (await context(row).checkPhase0({ state }));
  const cases = [
    [null, 'PHASE0_UNAVAILABLE'],
    [async () => { throw Error('mailbox failed'); }, 'PHASE0_UNAVAILABLE'],
    [async () => ({ ...base, observedAt: '2026-09-24T17:02:00.000Z' }), 'PHASE0_BLOCKED'],
    [async () => ({ ...base, messageId: 'other' }), 'PHASE0_BLOCKED'],
    [async () => ({ ...base, outboundObservationOk: false }), 'PHASE0_BLOCKED'],
    [async () => ({ ...base, alreadyHandled: true }), 'PHASE0_BLOCKED'],
    [async () => ({ ...base, humanTouchBlock: { code: 'human' } }), 'PHASE0_BLOCKED'],
    [async () => ({ ...base, repeatReason: 'already sent' }), 'PHASE0_BLOCKED'],
    [async () => ({ ...base, suppressionReason: 'suppressed' }), 'PHASE0_BLOCKED'],
  ];
  for (const [checkPhase0, reason] of cases) {
    const result = await evaluateAgentV2Readiness(context(row, async () => state, checkPhase0));
    assert.equal(result.reasonCode, reason);
    assert.equal(result.wordingStatus, 'NOT_RUN');
    assert.equal(result.executionReady, false);
  }
});

test('wording validation failure and missing wording remain not ready', async () => {
  const state = phase1();
  for (const candidate of [{ wording: 'The pilot costs $500.' }, { wording: '' }]) {
    const result = await evaluateAgentV2Readiness({ ...context(rowFor(state), async () => state),
      wordingCandidate: candidate });
    assert.equal(result.wordingStatus, 'HANDOFF');
    assert.equal(result.wording, null);
    assert.equal(result.executionReady, false);
    assert.equal(result.executionAuthorized, false);
  }
});

test('one-shot uses claim before model start, reads the durable row, and replay calls no model', async () => {
  const state = phase1();
  const events = [];
  let row = null; let calls = 0; let claims = 0;
  const store = {
    async getDecisionRow(id) { events.push('read'); assert.equal(id, DECISION); return row; },
    async claim({ decisionId, leadId, messageId }) {
      events.push('claim'); claims++;
      assert.deepEqual([decisionId, leadId, messageId], [DECISION, LEAD, MESSAGE]);
      if (row?.record) return { status: 'complete', record: row.record };
      row = { ...rowFor(state), record: null, completed_at: null,
        model_started_at: null, action_id: null };
      return { status: 'claimed', priorModelAttempt: false, signal: new AbortController().signal,
        async markModelStarted() { events.push('model_started'); row.model_started_at = new Date('2026-09-24T17:02:10.000Z'); },
        async complete(record) { events.push('complete'); row.record = record;
          row.action_id = record.decision.actionId;
          row.created_at = new Date(record.createdAt);
          row.completed_at = new Date(COMPLETED); return record; },
        async release() { events.push('release'); },
      };
    },
  };
  const model = async () => { events.push('model'); calls++;
    return { status: 'ok', raw: rawFor(state), usage: { inputTokens: 1, outputTokens: 1 } }; };
  const args = { leadId: LEAD, messageId: MESSAGE, store,
    loadCurrentState: async () => phase1(), checkPhase0: context(null).checkPhase0,
    model, now: new Date(CREATED) };
  const first = await runAgentV2OneShotReadiness(args);
  assert.equal(first.calledModel, true);
  assert.equal(first.reused, false);
  assert.equal(first.readiness.executionReady, true);
  assert.deepEqual(events.slice(0, 4), ['claim', 'model_started', 'model', 'complete']);
  assert.ok(events.indexOf('read') > events.indexOf('complete'));
  assert.equal(calls, 1);
  const replay = await runAgentV2OneShotReadiness(args);
  assert.equal(replay.calledModel, false);
  assert.equal(replay.reused, true);
  assert.equal(calls, 1);
  assert.equal(claims, 2);
  assert.equal(row.claim_attempts, 1, 'completed reuse does not start a new lifecycle');
  assert.deepEqual(replay.readiness, first.readiness);
  assert.equal(row.decision_id, DECISION);
});

test('one-shot refuses unverified inbound before claim and contains no executor imports', async () => {
  let claims = 0;
  const store = { claim: async () => { claims++; throw Error('must not claim'); },
    getDecisionRow: async () => null };
  const result = await runAgentV2OneShotReadiness({ leadId: LEAD, messageId: MESSAGE,
    store, loadCurrentState: async () => { const state = phase1();
      target(state).genuineHuman = false; return state; } });
  assert.equal(result.readiness.reasonCode, 'INBOUND_EVIDENCE_UNVERIFIED');
  assert.equal(result.calledModel, false);
  assert.equal(claims, 0);
  const missingDecision = await runAgentV2OneShotReadiness({ leadId: LEAD, messageId: MESSAGE,
    store, loadCurrentState: async () => { const state = phase1();
      target(state).decision.status = 'missing'; return state; } });
  assert.equal(missingDecision.readiness.reasonCode, 'INBOUND_EVIDENCE_UNVERIFIED');
  assert.equal(claims, 0);
  const source = fs.readFileSync(path.join(__dirname, '..', 'integrations',
    'agent-v2-orchestration.js'), 'utf8');
  assert.doesNotMatch(source, /googleapis|gmail|sendEmail|queueDraft|calendar|applyLeadChange|senderReservation/i);
  for (const file of ['server.js', 'outreach-agent.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'),
      /agent-v2-orchestration/);
  }
});
