'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildConversationState } = require('../integrations/conversation-state');
const { buildAgentV2Input } = require('../integrations/agent-v2-input');
const { validateModelDecision } = require('../integrations/agent-v2-validation');
const { decisionIdFor } = require('../integrations/agent-v2-store');
const { evaluateAgentV2Permission } = require('../integrations/agent-v2-permission');
const { renderAgentV2Wording, WORDING_VERSION } = require('../integrations/agent-v2-wording');
const { AUTHORITY, CATALOG_VERSION, EVENT_TYPE, FACT_IDS, INPUT_VERSION, SCHEMA_VERSION } = require('../integrations/agent-v2-contract');

const fixture = require('./fixtures/agent-v2-synthetic-pilot-second.json');
const MESSAGE = 'SYNTHETIC_AGENT_V2_PILOT_20260924_MESSAGE_002';

function phase1() {
  return buildConversationState({ lead: fixture.leads[0], activities: fixture.activities,
    suppressedEmails: new Set(fixture.suppressedEmails),
    config: { sequencesEnabled: true, sendingEnabled: true },
    now: '2026-09-24T17:02:00.000Z' });
}

function recordFor(state, overrides = {}) {
  const input = buildAgentV2Input(state, MESSAGE);
  const raw = { version: SCHEMA_VERSION, actionId: 'SUGGEST_INFO', handoffCode: 'NONE',
    factIds: ['F_30_DAY_PILOT', 'F_HANDLES_PROSPECTING', 'F_HANDLES_OUTREACH',
      'F_HANDLES_QUALIFICATION'], slotIds: [], objectionType: 'NONE',
    evidenceRefs: [input.targetRef], templateId: 'INFO_OVERVIEW',
    reasonCode: 'INFO_REQUEST', confidence: 0.8, ...overrides };
  return { eventType: EVENT_TYPE, schemaVersion: SCHEMA_VERSION,
    inputVersion: INPUT_VERSION, catalogVersion: CATALOG_VERSION,
    leadId: input.leadId, messageId: input.messageId,
    decisionId: decisionIdFor(input.leadId, input.messageId),
    stateDigest: input.stateDigest, inputDigest: input.inputDigest,
    modelStatus: 'ok', decision: validateModelDecision(raw, input), authority: AUTHORITY };
}

function setup(state = phase1(), overrides = {}) {
  const record = recordFor(state, overrides);
  const permission = evaluateAgentV2Permission(state, record);
  return { state, record, permission };
}

test('information request renders short natural copy using only selected approved facts', () => {
  const context = setup();
  assert.equal(context.permission.verdict, 'ALLOW');
  const rendered = renderAgentV2Wording(context);
  assert.deepEqual(rendered, { version: WORDING_VERSION, status: 'RENDERED',
    reasonCode: 'APPROVED_WORDING', decisionId: context.record.decisionId,
    actionId: 'SUGGEST_INFO', catalogVersion: CATALOG_VERSION,
    wording: 'Sure — the employer acquisition pilot lasts 30 days. We handle employer prospecting, employer outreach, and qualification.',
    executionAuthorized: false, authority: AUTHORITY });
  assert.equal(rendered.wording.includes('calendar'), false, 'unselected calendar fact stays out');
  assert.equal(rendered.wording.includes('fees'), false, 'unselected fee fact stays out');
  assert.deepEqual(renderAgentV2Wording(context), rendered);
});

test('qualification copy asks only the permitted unknown slot', () => {
  const state = phase1();
  const inbound = state.turns.find(turn => turn.messageId === MESSAGE);
  inbound.decision.finalClassification = 'INTERESTED';
  inbound.classification.value = 'INTERESTED';
  const context = setup(state, { actionId: 'SUGGEST_QUALIFICATION', factIds: [],
    slotIds: ['roles'], templateId: 'QUALIFY', reasonCode: 'QUALIFICATION_GAP' });
  assert.equal(context.permission.verdict, 'ALLOW');
  const rendered = renderAgentV2Wording(context);
  assert.equal(rendered.wording, 'Which roles are you focused on filling?');
  assert.equal(renderAgentV2Wording({ ...context,
    candidate: { wording: 'Which roles and salaries are you focused on?' } }).status, 'HANDOFF');
});

test('approved fact answer stays inside its selected facts', () => {
  const context = setup(phase1(), { actionId: 'SUGGEST_FACT_ANSWER',
    factIds: ['F_PERFORMANCE_BASED'], templateId: 'FACTS_ONLY',
    reasonCode: 'APPROVED_FACT_MATCH' });
  assert.equal(context.permission.verdict, 'ALLOW');
  const result = renderAgentV2Wording(context);
  assert.equal(result.wording, 'Sure — the pilot is performance-based.');
  assert.equal(renderAgentV2Wording({ ...context,
    candidate: { wording: 'Sure — the pilot is performance-based. There are no meeting fees.' } }).reasonCode,
  'WORDING_OUTSIDE_APPROVED_RENDERING');
});

test('every existing approved fact can render alone without dropping its selection', () => {
  for (const id of FACT_IDS) {
    const context = setup(phase1(), { factIds: [id] });
    const result = renderAgentV2Wording(context);
    assert.equal(result.status, 'RENDERED', id);
    assert.ok(result.wording.length > 10, id);
  }
});

test('booking coordination introduces neither availability nor a link', () => {
  const state = phase1();
  state.booking.meetingIntent.value = true;
  const context = setup(state, { actionId: 'SUGGEST_BOOKING_COORDINATION',
    factIds: [], templateId: 'BOOKING_COORDINATION', reasonCode: 'MEETING_INTENT' });
  assert.equal(context.permission.verdict, 'ALLOW');
  const rendered = renderAgentV2Wording(context);
  assert.equal(rendered.wording, 'Happy to coordinate the next step with you.');
  assert.equal(rendered.wording.includes('http'), false);
  const link = renderAgentV2Wording({ ...context,
    candidate: { wording: 'Book a time here: https://calendar.example.test' } });
  assert.equal(link.status, 'HANDOFF');
  assert.equal(link.reasonCode, 'UNAPPROVED_BOOKING_LINK');
  assert.equal(link.wording, null);
  assert.equal(renderAgentV2Wording({ ...context,
    candidate: { wording: 'We have appointments available tomorrow.' } }).wording, null);
});

test('Phase 3 DENY or HANDOFF yields no prospect-facing wording', () => {
  const denied = phase1();
  denied.terminalState.blockedBy = 'unsubscribed';
  const denyContext = setup(denied);
  assert.equal(denyContext.permission.verdict, 'DENY');
  assert.deepEqual([renderAgentV2Wording(denyContext).status,
    renderAgentV2Wording(denyContext).wording], ['NO_WORDING', null]);
  const held = phase1();
  held.ownership.humanTakeover.value = true;
  const handoffContext = setup(held);
  assert.equal(handoffContext.permission.verdict, 'HANDOFF');
  assert.deepEqual([renderAgentV2Wording(handoffContext).status,
    renderAgentV2Wording(handoffContext).wording], ['NO_WORDING', null]);
  assert.equal(renderAgentV2Wording({ ...setup(), permission: denyContext.permission }).reasonCode,
    'PERMISSION_MISMATCH');
});

test('malformed, empty, or extra-field wording fails closed without changing the decision', () => {
  const context = setup();
  const original = structuredClone(context.record);
  for (const candidate of [null, {}, { wording: '' }, { wording: '  ' },
    { wording: 3 }, { wording: 'Valid text\nwith a newline' },
    { wording: 'Copy', actionId: 'SEND' },
    { wording: 'Copy', templateId: 'OTHER' },
    { wording: 'Copy', factIds: ['F_NO_MEETINGS_NO_FEES'] },
    { wording: 'Copy', slotIds: ['geography'] }]) {
    const result = renderAgentV2Wording({ ...context, candidate });
    assert.equal(result.status, 'HANDOFF');
    assert.equal(result.reasonCode, 'MALFORMED_WORDING');
    assert.equal(result.wording, null);
  }
  assert.deepEqual(context.record, original);
});

test('unsupported price, proof, results, and changed commercial claims fail closed', () => {
  const context = setup();
  for (const [wording, code] of [
    ['The pilot costs $500.', 'UNSUPPORTED_PRICE'],
    ['Our case studies prove it works.', 'UNSUPPORTED_PROOF_OR_RESULTS'],
    ['We generated 50 meetings for a client.', 'UNSUPPORTED_PROOF_OR_RESULTS'],
    ['We guarantee 50 meetings and refunds.', 'WORDING_OUTSIDE_APPROVED_RENDERING'],
    ['We handle candidate sourcing.', 'WORDING_OUTSIDE_APPROVED_RENDERING'],
  ]) {
    const result = renderAgentV2Wording({ ...context, candidate: { wording } });
    assert.equal(result.status, 'HANDOFF', wording);
    assert.equal(result.reasonCode, code, wording);
    assert.equal(result.wording, null);
  }
});

test('non-renderable actions and stale permissions cannot yield copy', () => {
  const state = phase1();
  const noAction = setup(state, { actionId: 'NO_ACTION', factIds: [],
    templateId: 'NONE', reasonCode: 'NO_ACTION_REQUIRED' });
  assert.equal(noAction.permission.verdict, 'DENY');
  assert.equal(renderAgentV2Wording(noAction).wording, null);
  const handoff = setup(state, { actionId: 'HANDOFF', handoffCode: 'UNCLEAR_INTENT',
    factIds: [], templateId: 'NONE', reasonCode: 'HUMAN_REVIEW_REQUIRED' });
  assert.equal(renderAgentV2Wording(handoff).wording, null);
  const objectionState = phase1();
  objectionState.objections.push({ type: 'existing_provider', evidenceMessageId: MESSAGE, status: 'open' });
  const objection = setup(objectionState, { actionId: 'SUGGEST_OBJECTION_RESPONSE',
    factIds: ['F_HANDLES_OUTREACH'], objectionType: 'EXISTING_PROVIDER',
    templateId: 'OBJECTION_ACK', reasonCode: 'OBJECTION_EVIDENCE' });
  assert.equal(objection.permission.verdict, 'HANDOFF');
  assert.equal(renderAgentV2Wording(objection).wording, null);
  const referralState = phase1();
  referralState.referral.status = 'referred';
  const referral = setup(referralState, { actionId: 'SUGGEST_REFERRAL_ACK',
    factIds: [], templateId: 'REFERRAL_ACK', reasonCode: 'REFERRAL_EVIDENCE' });
  assert.equal(referral.permission.verdict, 'HANDOFF');
  assert.equal(renderAgentV2Wording(referral).wording, null);
  const allowed = setup();
  allowed.state.evidenceDigest = 'later-evidence';
  assert.equal(renderAgentV2Wording(allowed).reasonCode, 'PERMISSION_MISMATCH');
});

test('wording module is standalone, with no model, Gmail, or production import', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'integrations', 'agent-v2-wording.js'), 'utf8');
  assert.doesNotMatch(source, /@anthropic-ai\/sdk|googleapis|gmail|sendEmail|queueDraft|supabase|\.query\(/i);
  for (const file of ['server.js', 'outreach-agent.js', 'scripts/agent-v2-replay.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), /agent-v2-wording/);
  }
});
