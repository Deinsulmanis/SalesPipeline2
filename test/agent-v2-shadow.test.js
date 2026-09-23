'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildConversationState } = require('../integrations/conversation-state');
const { buildAgentV2Input } = require('../integrations/agent-v2-input');
const { guardCode, validateModelDecision } = require('../integrations/agent-v2-validation');
const { runAgentV2Model } = require('../integrations/agent-v2-model');
const { evaluateAgentV2Shadow } = require('../integrations/agent-v2-shadow');
const { decisionIdFor } = require('../integrations/agent-v2-store');
const { createPgAgentV2Store } = require('../integrations/agent-v2-store');
const { replay, optionsFrom } = require('../scripts/agent-v2-replay');
const { SCHEMA_VERSION, INPUT_VERSION, CATALOG_VERSION, AUTHORITY, OFFER_FACTS } = require('../integrations/agent-v2-contract');

const NOW = '2026-09-23T18:00:00.000Z';
function stateFor(text, overrides = {}) {
  const turn = { turnId: 'turn:m1', index: 0, direction: 'inbound', actor: 'prospect',
    occurredAt: '2026-09-23T17:00:00.000Z', messageId: 'm1', threadId: 't1',
    sourceEventIds: ['gmail-reply:m1'], content: text, contentAvailable: Boolean(text),
    classification: { value: 'INTERESTED', source: 'reply_decision' },
    decision: { status: 'recorded', finalClassification: 'INTERESTED',
      policyAction: 'HUMAN_REVIEW', executionStatus: 'recorded' } };
  const base = {
    version: 'conversation_state_v1', asOf: NOW, evidenceDigest: 'phase1-evidence-digest',
    identity: { leadId: 'S1', family: 'industrial_staffing' },
    turns: [turn], thread: { threadIds: ['t1'] },
    terminalState: { blockedBy: null },
    ownership: { owner: 'human_review', humanTakeover: { value: false },
      staffingAutomationHold: { applies: false } },
    qualification: { status: 'not_started', slots: Object.fromEntries(
      ['roles', 'industries', 'employerTypes', 'geography', 'employerAcquisitionPriority']
        .map(slot => [slot, { status: 'unknown', value: null }])) },
    questions: [], objections: [], referral: { status: 'none' },
    booking: { linkSent: { status: 'not_observed' }, meetingIntent: { value: false },
      call: { status: 'none', live: false } },
    responseState: { answered: 'no', waitingOn: 'human' },
    evidenceWarnings: [], ambiguities: [],
  };
  return { ...base, ...overrides };
}
function proposal(input, overrides = {}) {
  return { version: SCHEMA_VERSION, actionId: 'SUGGEST_INFO', handoffCode: 'NONE',
    factIds: ['F_TARGET_AGENCIES', 'F_HANDLES_OUTREACH'], slotIds: [], objectionType: 'NONE',
    evidenceRefs: [input.targetRef], templateId: 'INFO_OVERVIEW',
    reasonCode: 'INFO_REQUEST', confidence: 0.9, ...overrides };
}
function memoryStore() {
  const rows = new Map();
  const active = new Set();
  return { rows, active, get: async id => rows.get(id)?.record || null,
    claim: async ({ decisionId, leadId, messageId }) => {
      if (active.has(decisionId)) return { status: 'busy' };
      const prior = rows.get(decisionId);
      if (prior?.record) return { status: 'complete', record: prior.record };
      if (prior && (prior.leadId !== leadId || prior.messageId !== messageId)) throw new Error('identity conflict');
      active.add(decisionId);
      rows.set(decisionId, { leadId, messageId, record: null,
        modelStarted: Boolean(prior?.modelStarted), attempts: (prior?.attempts || 0) + 1 });
      return { status: 'claimed', signal: new AbortController().signal,
        priorModelAttempt: Boolean(prior?.modelStarted),
        markModelStarted: async () => { rows.get(decisionId).modelStarted = true; },
        complete: async record => { rows.get(decisionId).record = record; return record; },
        release: async () => { active.delete(decisionId); } };
    } };
}

test('the Phase 2 input is compact, deterministic, and derived from Phase 1 state', () => {
  const state = stateFor('Please send information.');
  const first = buildAgentV2Input(state, 'm1');
  const second = buildAgentV2Input(structuredClone(state), 'm1');
  assert.deepEqual(first, second);
  assert.equal(first.version, INPUT_VERSION);
  assert.equal(first.catalogVersion, CATALOG_VERSION);
  assert.deepEqual(first.allowedEvidenceRefs, ['turn:m1']);
  assert.equal(first.currentState.productionDecision.classification, 'INTERESTED');
  assert.equal(first.approvedFacts.F_NO_MEETINGS_NO_FEES, OFFER_FACTS.F_NO_MEETINGS_NO_FEES);
  assert.equal(first.turns[0].content, 'Please send information.');
  assert.throws(() => buildAgentV2Input({ ...state, version: 'invented' }, 'm1'), /Phase 1/);
  assert.throws(() => buildAgentV2Input(state, 'missing'), /absent/);
});

test('requested conversation scenarios are coded, safe and evidence-backed', () => {
  const cases = [
    ['interested', stateFor('Interested in learning more.'), { actionId: 'SUGGEST_QUALIFICATION',
      slotIds: ['roles'], factIds: [], templateId: 'QUALIFY' }, 'SUGGEST_QUALIFICATION', 'NONE'],
    ['send-info', stateFor('Please send information.'), {}, 'SUGGEST_INFO', 'NONE'],
    ['qualification', stateFor('We place welders in manufacturing.', { qualification: { status: 'answered',
      slots: { roles: { status: 'filled', value: ['welders'] }, industries: { status: 'unknown', value: null } } } }),
    { actionId: 'SUGGEST_QUALIFICATION', slotIds: ['industries'], factIds: [], templateId: 'QUALIFY' }, 'SUGGEST_QUALIFICATION', 'NONE'],
    ['general pricing facts', stateFor('Is the pilot performance-based?'), { actionId: 'SUGGEST_FACT_ANSWER',
      factIds: ['F_PERFORMANCE_BASED', 'F_PAYMENT_TIED_MEETINGS'], templateId: 'FACTS_ONLY' }, 'SUGGEST_FACT_ANSWER', 'NONE'],
    ['pricing amount', stateFor('How much does it cost?'), {}, 'HANDOFF', 'PRICING_UNSUPPORTED'],
    ['how it works', stateFor('How does your process work?'), { actionId: 'SUGGEST_FACT_ANSWER',
      factIds: ['F_HANDLES_PROSPECTING', 'F_HANDLES_OUTREACH', 'F_HANDLES_QUALIFICATION'], templateId: 'FACTS_ONLY' }, 'SUGGEST_FACT_ANSWER', 'NONE'],
    ['proof', stateFor('Do you have case studies?'), {}, 'HANDOFF', 'PROOF_UNSUPPORTED'],
    ['results', stateFor('What results have you achieved?'), {}, 'HANDOFF', 'RESULTS_UNSUPPORTED'],
    ['existing provider objection', stateFor('We already have internal BD.', { objections: [
      { type: 'existing_provider', status: 'open', evidenceMessageId: 'm1' }] }),
    { actionId: 'SUGGEST_OBJECTION_RESPONSE', objectionType: 'EXISTING_PROVIDER',
      factIds: ['F_HANDLES_OUTREACH'], templateId: 'OBJECTION_ACK' }, 'SUGGEST_OBJECTION_RESPONSE', 'NONE'],
    ['wrong person/referral', stateFor('Please contact my colleague instead.', { referral: { status: 'referred' } }),
    { actionId: 'SUGGEST_REFERRAL_ACK', factIds: [], templateId: 'REFERRAL_ACK' }, 'SUGGEST_REFERRAL_ACK', 'NONE'],
    ['candidate-side confusion', stateFor('I am looking for a job.', { objections: [
      { type: 'candidate_side_confusion', status: 'open', evidenceMessageId: 'm1' }] }), {}, 'HANDOFF', 'CANDIDATE_SIDE'],
    ['unclear', stateFor('Maybe later or something.'), { actionId: 'HANDOFF', handoffCode: 'UNCLEAR_INTENT',
      factIds: [], templateId: 'NONE' }, 'HANDOFF', 'UNCLEAR_INTENT'],
    ['unsubscribe', stateFor('Remove me.', { terminalState: { blockedBy: 'unsubscribed' } }), {}, 'NO_ACTION', 'UNSUBSCRIBE'],
    ['not interested', stateFor('No thanks.', { terminalState: { blockedBy: 'not_interested' } }), {}, 'NO_ACTION', 'NOT_INTERESTED'],
    ['out of office', stateFor('I am away.', { terminalState: { blockedBy: 'out_of_office' } }), {}, 'NO_ACTION', 'OUT_OF_OFFICE'],
    ['human takeover', stateFor('Following up.', { ownership: { owner: 'human',
      humanTakeover: { value: true }, staffingAutomationHold: { applies: true } } }), {}, 'HANDOFF', 'HUMAN_TAKEOVER'],
    ['booking request', stateFor('Can we meet?', { booking: { meetingIntent: { value: true },
      linkSent: { status: 'not_observed' }, call: { status: 'none', live: false } } }),
    { actionId: 'SUGGEST_BOOKING_COORDINATION', factIds: [], templateId: 'BOOKING_COORDINATION' }, 'SUGGEST_BOOKING_COORDINATION', 'NONE'],
    ['reschedule', stateFor('Please reschedule our meeting.'), {}, 'HANDOFF', 'BOOKING_OR_RESCHEDULE'],
    ['conflicting evidence', stateFor('Interested.', { evidenceWarnings: [{ code: 'sender_mismatch' }] }), {}, 'HANDOFF', 'CONFLICTING_EVIDENCE'],
    ['multiple threads', stateFor('Interested.', { thread: { threadIds: ['t1', 't2'] } }), {}, 'HANDOFF', 'MULTIPLE_THREADS'],
    ['unsupported commercial request', stateFor('Can you guarantee 50 meetings and give a discount?'), {}, 'HANDOFF', 'COMMERCIAL_UNSUPPORTED'],
    ['complaint', stateFor('This is a spam complaint.'), {}, 'HANDOFF', 'COMPLAINT'],
  ];
  for (const [name, state, overrides, action, code] of cases) {
    const input = buildAgentV2Input(state, 'm1');
    const result = validateModelDecision(proposal(input, overrides), input);
    assert.equal(result.actionId, action, name);
    assert.equal(result.handoffCode, code, name);
    assert.equal(result.evidenceRefs[0], 'turn:m1', name);
    assert.equal(result.suggestedWording.includes('$'), false, name);
  }
});

test('malformed or unsupported output fails closed, and confidence never grants authority', () => {
  const input = buildAgentV2Input(stateFor('Please send information.'), 'm1');
  for (const raw of [null, {}, { ...proposal(input), actionId: 'SEND' },
    { ...proposal(input), factIds: ['INVENTED_PRICE'] },
    { ...proposal(input), evidenceRefs: ['turn:other'] },
    { ...proposal(input), extra: true },
    { ...proposal(input), confidence: 1.1 },
    { ...proposal(input), templateId: 'FACTS_ONLY' }]) {
    const result = validateModelDecision(raw, input);
    assert.equal(result.actionId, 'HANDOFF');
    assert.equal(result.handoffCode, 'MODEL_ERROR');
    assert.equal(result.suggestedWording, '');
  }
  assert.ok(Object.values(AUTHORITY).every(value => value === false));
  assert.equal(validateModelDecision(proposal(input, { confidence: 1 }), input).actionId, 'SUGGEST_INFO');
});

test('pricing text can render only catalog pricing facts; unsupported slots and objections fail', () => {
  const input = buildAgentV2Input(stateFor('Is this performance-based pricing?'), 'm1');
  assert.equal(guardCode(input), null);
  const valid = validateModelDecision(proposal(input, { actionId: 'SUGGEST_FACT_ANSWER',
    factIds: ['F_PERFORMANCE_BASED', 'F_NO_MEETINGS_NO_FEES'], templateId: 'FACTS_ONLY' }), input);
  assert.equal(valid.status, 'valid');
  assert.equal(valid.suggestedWording, `${OFFER_FACTS.F_PERFORMANCE_BASED} ${OFFER_FACTS.F_NO_MEETINGS_NO_FEES}`);
  assert.equal(validateModelDecision(proposal(input), input).handoffCode, 'PRICING_UNSUPPORTED');
  const filled = buildAgentV2Input(stateFor('Interested.', { qualification: { status: 'answered',
    slots: { roles: { status: 'filled', value: ['welders'] } } } }), 'm1');
  assert.equal(validateModelDecision(proposal(filled, { actionId: 'SUGGEST_QUALIFICATION',
    slotIds: ['roles'], factIds: [], templateId: 'QUALIFY' }), filled).status, 'invalid_model_output');
  assert.equal(validateModelDecision(proposal(input, { actionId: 'SUGGEST_OBJECTION_RESPONSE',
    objectionType: 'EXISTING_PROVIDER', templateId: 'OBJECTION_ACK' }), input).status, 'invalid_model_output');
});

test('a fixed decision id and unique insert persist one record per inbound message', async () => {
  const state = stateFor('Please send information.');
  const store = memoryStore();
  let calls = 0;
  const model = async input => { calls++; return { raw: proposal(input), status: 'ok',
    usage: { inputTokens: 100, outputTokens: 40 } }; };
  const first = await evaluateAgentV2Shadow({ state, messageId: 'm1', store, model, now: new Date(NOW) });
  const replayed = await evaluateAgentV2Shadow({ state, messageId: 'm1', store, model, now: new Date(NOW) });
  assert.equal(first.persisted, true);
  assert.equal(first.reused, false);
  assert.equal(replayed.reused, true);
  assert.equal(calls, 1);
  assert.equal(store.rows.size, 1);
  assert.equal(first.record.decisionId, decisionIdFor('S1', 'm1'));
  assert.equal(first.record.eventType, 'agent_v2_shadow_decision');
  assert.equal(first.record.decision.suggestedWording, `${OFFER_FACTS.F_TARGET_AGENCIES} ${OFFER_FACTS.F_HANDLES_OUTREACH}`);
  assert.deepEqual(first.record.authority, AUTHORITY);
  assert.equal(first.record.usage.inputTokens, 100);
});

test('simultaneous workers claim before the model and spend tokens once', async () => {
  const store = memoryStore();
  const state = stateFor('Interested.');
  let calls = 0;
  let finish;
  const model = async input => { calls++; await new Promise(resolve => { finish = resolve; });
    return { raw: proposal(input), status: 'ok', usage: { inputTokens: 2, outputTokens: 1 } }; };
  const first = evaluateAgentV2Shadow({ state, messageId: 'm1', store, model });
  await new Promise(resolve => setImmediate(resolve));
  const competing = await evaluateAgentV2Shadow({ state, messageId: 'm1', store, model });
  assert.equal(competing.busy, true);
  assert.equal(calls, 1);
  finish();
  await first;
  const results = await Promise.all([1, 2].map(() => evaluateAgentV2Shadow({ state, messageId: 'm1', store, model })));
  assert.equal(store.rows.size, 1);
  assert.equal(results.filter(r => r.reused).length, 2);
  assert.equal(calls, 1);
});

test('an incomplete claim is recoverable while a completed decision is immutable', async () => {
  const store = memoryStore();
  const id = decisionIdFor('S1', 'm1');
  const crashed = await store.claim({ decisionId: id, leadId: 'S1', messageId: 'm1' });
  await crashed.release();
  const state = stateFor('Please send information.');
  let calls = 0;
  const model = async input => { calls++; return { raw: proposal(input), status: 'ok',
    usage: { inputTokens: 1, outputTokens: 1 } }; };
  const recovered = await evaluateAgentV2Shadow({ state, messageId: 'm1', store, model });
  const replayed = await evaluateAgentV2Shadow({ state, messageId: 'm1', store, model });
  assert.equal(store.rows.get(id).attempts, 2);
  assert.equal(recovered.persisted, true);
  assert.equal(replayed.reused, true);
  assert.equal(calls, 1);
});

test('a crash after starting the model fails closed without a second model call', async () => {
  const store = memoryStore();
  const id = decisionIdFor('S1', 'm1');
  const crashed = await store.claim({ decisionId: id, leadId: 'S1', messageId: 'm1' });
  await crashed.markModelStarted();
  await crashed.release();
  const recovered = await evaluateAgentV2Shadow({ state: stateFor('Please send information.'),
    messageId: 'm1', store, model: async () => { throw new Error('model must not be called again'); } });
  assert.equal(recovered.calledModel, false);
  assert.equal(recovered.record.modelStatus, 'previous_model_attempt_unresolved');
  assert.equal(recovered.record.decision.handoffCode, 'MODEL_ERROR');
  assert.equal(recovered.record.decision.suggestedWording, '');
});

test('invalid model output is saved once as a coded, empty handoff', async () => {
  const store = memoryStore();
  let calls = 0;
  const model = async () => { calls++; return { raw: { invented: 'SEND' }, status: 'ok',
    model: 'claude-haiku-4-5-20251001', latencyMs: 14,
    usage: { inputTokens: 90, outputTokens: 20 }, estimatedCostUsd: 0.00019 }; };
  const state = stateFor('Please send information.');
  const first = await evaluateAgentV2Shadow({ state, messageId: 'm1', store, model });
  const again = await evaluateAgentV2Shadow({ state, messageId: 'm1', store, model });
  assert.equal(first.record.decision.status, 'invalid_model_output');
  assert.equal(first.record.decision.handoffCode, 'MODEL_ERROR');
  assert.equal(first.record.decision.suggestedWording, '');
  assert.equal(first.record.model, 'claude-haiku-4-5-20251001');
  assert.equal(first.record.latencyMs, 14);
  assert.equal(first.record.estimatedCostUsd, 0.00019);
  assert.equal(again.reused, true);
  assert.equal(calls, 1);
});

test('persistence failure is visible, and earlier inbound turns do not see future state', async () => {
  const state = stateFor('Interested.');
  const later = { ...state.turns[0], turnId: 'turn:m2', index: 1, messageId: 'm2',
    occurredAt: '2026-09-23T17:10:00.000Z', content: 'Another message.' };
  state.turns.push(later);
  const historical = buildAgentV2Input(state, 'm1');
  assert.equal(historical.historical, true);
  assert.equal(historical.turns.some(turn => turn.messageId === 'm2'), false);
  assert.equal(historical.currentState, null);
  assert.equal(guardCode(historical), 'STATE_UNAVAILABLE');
  const store = { claim: async () => { throw new Error('database unavailable'); } };
  await assert.rejects(evaluateAgentV2Shadow({ state, messageId: 'm1', store,
    model: async () => { throw new Error('model should not be called'); } }), /database unavailable/);
});

test('model tool output must be exactly one structured JSON tool call', async () => {
  const input = buildAgentV2Input(stateFor('Send information.'), 'm1');
  let request;
  const valid = await runAgentV2Model(input, { createMessage: async payload => {
    request = payload;
    return { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'record_shadow_decision',
      input: proposal(input) }], usage: { input_tokens: 25, output_tokens: 12 } };
  } });
  assert.equal(valid.status, 'ok');
  assert.equal(valid.raw.version, SCHEMA_VERSION);
  assert.equal(valid.usage.inputTokens, 25);
  assert.equal(valid.estimatedCostUsd, 0.000085);
  assert.ok(valid.latencyMs >= 0);
  assert.equal(request.tool_choice.name, 'record_shadow_decision');
  assert.equal(request.tools[0].input_schema.additionalProperties, false);
  const invalid = await runAgentV2Model(input, { createMessage: async () => ({
    stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(proposal(input)) }] }) });
  assert.equal(invalid.status, 'invalid_response');
  assert.equal(invalid.raw, null);
  assert.equal(invalid.status, 'invalid_response');
});

test('configured SDK path pins model version and passes claim abort signal', async () => {
  const input = buildAgentV2Input(stateFor('Send information.'), 'm1');
  const controller = new AbortController();
  let requested;
  let requestOptions;
  class AnthropicStub {
    constructor(options) {
      assert.equal(options.apiKey, 'test-only');
      this.messages = { create: async (payload, optionsForCall) => {
        requested = payload;
        requestOptions = optionsForCall;
        return { model: 'claude-haiku-4-5-20251001', stop_reason: 'tool_use',
          content: [{ type: 'tool_use', name: 'record_shadow_decision', input: proposal(input) }],
          usage: { input_tokens: 100, output_tokens: 20 } };
      } };
    }
  }
  const result = await runAgentV2Model(input, { apiKey: 'test-only', AnthropicImpl: AnthropicStub,
    signal: controller.signal });
  assert.equal(requested.model, 'claude-haiku-4-5-20251001');
  assert.equal(requestOptions.signal, controller.signal);
  assert.equal(result.model, requested.model);
  assert.equal(result.estimatedCostUsd, 0.0002);
  assert.equal(result.status, 'ok');
  const mismatched = await runAgentV2Model(input, { createMessage: async () => ({
    model: 'claude-haiku-4-5-other', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', name: 'record_shadow_decision', input: proposal(input) }],
    usage: { input_tokens: 1, output_tokens: 1 } }) });
  assert.equal(mismatched.status, 'model_mismatch');
  assert.equal(mismatched.raw, null);
});

test('real Phase 1 builder feeds the replay harness; no production module imports Agent v2', async () => {
  const lead = { id: 'S1', email: 'owner@example.test', company: 'Test Staffing',
    campaign: 'Industrial Staffing', leadNiche: 'industrial_staffing', stage: 'Replied',
    emailStatus: 'replied', emailStep: '1', notes: '', senderInboxId: 'primary' };
  const activities = [{ eventId: 'gmail-reply:m1', leadId: 'CE-S1', sourceLeadId: 'S1', email: lead.email,
    company: lead.company, eventType: 'positive_reply', occurredAt: '2026-09-23T17:00:00.000Z',
    subject: 'Re: employer meetings', content: 'Please send information.',
    metadata: JSON.stringify({ gmailMessageId: 'm1', gmailThreadId: 't1', senderInboxId: 'primary',
      classification: 'SEND_INFO', from: lead.email, genuineHuman: true }) },
  { eventId: 'gmail-evaluated:primary:m1', leadId: 'CE-S1', sourceLeadId: 'S1', email: lead.email,
    company: lead.company, eventType: 'gmail_reply_evaluated', occurredAt: '2026-09-23T17:01:00.000Z',
    subject: '', content: '', metadata: JSON.stringify({ gmailMessageId: 'm1', classification: 'SEND_INFO' }) },
  { eventId: 'reply-decision:S1:m1', leadId: 'CE-S1', sourceLeadId: 'S1', email: lead.email,
    company: lead.company, eventType: 'reply_decision_recorded', occurredAt: '2026-09-23T17:01:00.000Z',
    subject: '', content: '', metadata: JSON.stringify({ inboundMessageId: 'm1', leadId: 'S1',
      decisionId: 'reply-decision:S1:m1', finalClassification: 'SEND_INFO', policyAction: 'HUMAN_REVIEW',
      executionStatus: 'recorded' }) }];
  const snapshot = { leads: [lead], boardLeads: [], activities, suppressedEmails: [] };
  const state = buildConversationState({ lead, activities, now: NOW,
    config: { sequencesEnabled: true, sendingEnabled: true } });
  assert.equal(state.turns[0].direction, 'inbound');
  const input = buildAgentV2Input(state, 'm1');
  assert.equal(input.currentState.productionDecision.classification, 'SEND_INFO');
  const counts = await replay({ snapshot, now: new Date(NOW) });
  assert.equal(counts.conversations, 1);
  assert.equal(counts.inbound, 1);
  assert.equal(counts.inputsBuilt, 1);
  assert.equal(counts.modelNotCalled, 1);
  assert.equal(counts.evaluated, 0);
  assert.equal(counts.modelCalls, 0);
  assert.equal(counts.persisted, 0);
  assert.equal(counts.errors, 0);
  const store = memoryStore();
  let calls = 0;
  const callModel = async actual => { calls++; return { raw: proposal(actual), status: 'ok',
    model: 'claude-haiku-4-5-20251001', usage: { inputTokens: 200, outputTokens: 30 },
    latencyMs: 125, estimatedCostUsd: 0.00035 }; };
  const first = await replay({ snapshot, now: new Date(NOW), leadId: 'S1', messageId: 'm1',
    persist: true, store, callModel });
  const second = await replay({ snapshot, now: new Date(NOW), leadId: 'S1', messageId: 'm1',
    persist: true, store, callModel });
  assert.equal(first.attempted, 1);
  assert.equal(first.completed, 1);
  assert.equal(first.modelCalls, 1);
  assert.equal(first.latencyMs, 125);
  assert.equal(first.estimatedCostUsd, 0.00035);
  assert.equal(first.productionComparison['HUMAN_REVIEW:SUGGEST_INFO'], 1);
  assert.equal(second.reused, 1);
  assert.equal(second.completed, 0);
  assert.equal(calls, 1);
  await assert.rejects(replay({ snapshot, now: new Date(NOW), leadId: 'S1', messageId: 'unknown',
    persist: true, store, callModel }), /latest inbound/);
  assert.throws(() => optionsFrom(['--live', '--persist']), /requires --live --model/);
  for (const file of ['outreach-agent.js', 'server.js', 'integrations/reply-response-policy.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), /agent-v2-(?:shadow|model|validation)/);
  }
});
