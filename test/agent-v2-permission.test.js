'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildConversationState } = require('../integrations/conversation-state');
const { buildAgentV2Input } = require('../integrations/agent-v2-input');
const { validateModelDecision } = require('../integrations/agent-v2-validation');
const { decisionIdFor } = require('../integrations/agent-v2-store');
const { AUTHORITY, CATALOG_VERSION, EVENT_TYPE, INPUT_VERSION, SCHEMA_VERSION } = require('../integrations/agent-v2-contract');
const { evaluateAgentV2Permission, PERMISSION_VERSION, VERDICT } = require('../integrations/agent-v2-permission');

const fixture = require('./fixtures/agent-v2-synthetic-pilot-second.json');
const MESSAGE = 'SYNTHETIC_AGENT_V2_PILOT_20260924_MESSAGE_002';
const root = path.join(__dirname, '..');

function phase1() {
  return buildConversationState({ lead: fixture.leads[0], activities: fixture.activities,
    suppressedEmails: new Set(fixture.suppressedEmails),
    config: { sequencesEnabled: true, sendingEnabled: true },
    now: '2026-09-24T17:02:00.000Z' });
}

function target(state) { return state.turns.find(turn => turn.messageId === MESSAGE); }

function recordFor(state, overrides = {}) {
  const input = buildAgentV2Input(state, MESSAGE);
  const raw = { version: SCHEMA_VERSION, actionId: 'SUGGEST_INFO', handoffCode: 'NONE',
    factIds: ['F_30_DAY_PILOT'], slotIds: [], objectionType: 'NONE',
    evidenceRefs: [input.targetRef], templateId: 'INFO_OVERVIEW',
    reasonCode: 'INFO_REQUEST', confidence: 0.95, ...overrides };
  return { eventType: EVENT_TYPE, schemaVersion: SCHEMA_VERSION,
    inputVersion: INPUT_VERSION, catalogVersion: CATALOG_VERSION,
    leadId: input.leadId, messageId: input.messageId,
    decisionId: decisionIdFor(input.leadId, input.messageId),
    stateDigest: input.stateDigest, inputDigest: input.inputDigest,
    modelStatus: 'ok', decision: validateModelDecision(raw, input), authority: AUTHORITY };
}

function check(state, record = recordFor(state)) {
  return evaluateAgentV2Permission(state, record);
}

test('safe Phase 1 informational and approved-fact proposals are advisory ALLOW only', () => {
  const state = phase1();
  const info = check(state);
  assert.deepEqual(info, { version: PERMISSION_VERSION, verdict: VERDICT.ALLOW,
    reasonCode: 'INFORMATION_ADVISORY', actionId: 'SUGGEST_INFO',
    leadId: state.identity.leadId, messageId: MESSAGE,
    executionAuthorized: false, authority: AUTHORITY });
  assert.ok(Object.values(info.authority).every(value => value === false));
  const facts = check(state, recordFor(state, { actionId: 'SUGGEST_FACT_ANSWER',
    templateId: 'FACTS_ONLY', reasonCode: 'APPROVED_FACT_MATCH' }));
  assert.equal(facts.verdict, VERDICT.ALLOW);
  assert.equal(facts.reasonCode, 'APPROVED_FACT_ADVISORY');
  assert.equal(Object.hasOwn(facts, 'send'), false);
  assert.deepEqual(check(state), info, 'the evaluator is pure and deterministic');
});

test('qualification requires an interest classification, unasked unknown slots, and no repeated Phase 0 question', () => {
  const state = phase1();
  target(state).decision.finalClassification = 'INTERESTED';
  target(state).classification.value = 'INTERESTED';
  const qualify = { actionId: 'SUGGEST_QUALIFICATION', factIds: [], slotIds: ['roles'],
    templateId: 'QUALIFY', reasonCode: 'QUALIFICATION_GAP' };
  assert.deepEqual([check(state, recordFor(state, qualify)).verdict,
    check(state, recordFor(state, qualify)).reasonCode],
  [VERDICT.ALLOW, 'OPEN_QUALIFICATION_SLOT']);
  state.qualification.legacyTags.push('asked');
  assert.equal(check(state, recordFor(state, qualify)).reasonCode, 'QUALIFICATION_NOT_APPROPRIATE');
  state.qualification.legacyTags.length = 0;
  state.qualification.status = 'qualified';
  assert.equal(check(state, recordFor(state, qualify)).reasonCode, 'QUALIFICATION_NOT_APPROPRIATE');
  state.qualification.status = 'not_started';
  state.qualification.slots.roles.status = 'mentioned';
  assert.equal(check(state, recordFor(state, qualify)).reasonCode, 'QUALIFICATION_NOT_APPROPRIATE');
  state.qualification.slots.roles.status = 'unknown';
  state.turns.push({ direction: 'outbound', actor: 'automation', actionType: 'AUTO_STAFFING_QUALIFY_QUESTION' });
  assert.equal(check(state, recordFor(state, qualify)).reasonCode, 'QUALIFICATION_NOT_APPROPRIATE');
  state.turns.pop();
  target(state).decision.finalClassification = 'QUESTION';
  assert.equal(check(state, recordFor(state, qualify)).reasonCode, 'QUALIFICATION_NOT_APPROPRIATE');
});

test('unsubscribe, rejection, OOO, human takeover, and human response override even maximum confidence', () => {
  for (const [mutate, verdict, reason] of [
    [s => { s.terminalState.blockedBy = 'unsubscribed'; }, VERDICT.DENY, 'UNSUBSCRIBE'],
    [s => { s.terminalState.blockedBy = 'not_interested'; }, VERDICT.DENY, 'NOT_INTERESTED'],
    [s => { s.terminalState.blockedBy = 'out_of_office'; }, VERDICT.HANDOFF, 'OUT_OF_OFFICE'],
    [s => { s.ownership.humanTakeover.value = true; }, VERDICT.HANDOFF, 'HUMAN_TAKEOVER'],
    [s => { s.ownership.staffingAutomationHold.applies = true; }, VERDICT.HANDOFF, 'HUMAN_TAKEOVER'],
    [s => { s.turns.push({ direction: 'outbound', actor: 'human' }); }, VERDICT.HANDOFF, 'HUMAN_TAKEOVER'],
    [s => { s.responseState.answered = 'yes'; }, VERDICT.DENY, 'ALREADY_HANDLED'],
  ]) {
    const state = phase1();
    const record = recordFor(state, { confidence: 1 });
    mutate(state);
    const permission = check(state, record);
    assert.equal(permission.verdict, verdict, reason);
    assert.equal(permission.reasonCode, reason);
    assert.equal(permission.executionAuthorized, false);
  }
});

test('unsupported pricing, proof, results, commercial terms, complaint and candidate-side state hand off', () => {
  const cases = [
    ['How much does it cost?', 'PRICING_UNSUPPORTED'],
    ['Do you have case studies?', 'PROOF_UNSUPPORTED'],
    ['What results have you achieved?', 'RESULTS_UNSUPPORTED'],
    ['Can you guarantee 50 meetings and give a discount?', 'COMMERCIAL_UNSUPPORTED'],
    ['This is a spam complaint.', 'COMPLAINT'],
  ];
  for (const [body, reason] of cases) {
    const state = phase1();
    const record = recordFor(state);
    target(state).content = body;
    const permission = check(state, record);
    assert.equal(permission.verdict, VERDICT.HANDOFF, body);
    assert.equal(permission.reasonCode, reason, body);
  }
  const candidate = phase1();
  candidate.objections.push({ type: 'candidate_side_confusion', evidenceMessageId: MESSAGE,
    status: 'handed_off' });
  assert.equal(check(candidate, recordFor(candidate)).reasonCode, 'CANDIDATE_SIDE');
});

test('pricing facts are allowed only when the existing validator accepts approved pricing references', () => {
  const state = phase1();
  target(state).content = 'Is the pricing performance-based?';
  const approved = recordFor(state, { actionId: 'SUGGEST_FACT_ANSWER', templateId: 'FACTS_ONLY',
    factIds: ['F_PERFORMANCE_BASED'], reasonCode: 'APPROVED_FACT_MATCH' });
  assert.equal(check(state, approved).verdict, VERDICT.ALLOW);
  const unsupported = recordFor(state, { actionId: 'SUGGEST_INFO' });
  assert.equal(check(state, unsupported).reasonCode, 'PRICING_UNSUPPORTED');
});

test('booking coordination is advisory only with live intent and no prior link or booked call', () => {
  const state = phase1();
  state.booking.meetingIntent.value = true;
  const booking = recordFor(state, { actionId: 'SUGGEST_BOOKING_COORDINATION',
    factIds: [], templateId: 'BOOKING_COORDINATION', reasonCode: 'MEETING_INTENT' });
  assert.equal(booking.decision.status, 'valid');
  assert.equal(check(state, booking).reasonCode, 'BOOKING_COORDINATION_ADVISORY');
  assert.equal(check(state, recordFor(state)).reasonCode, 'BOOKING_INTENT_ACTION_MISMATCH');
  state.booking.linkSent.status = 'sent';
  assert.equal(check(state, recordFor(state, { actionId: 'SUGGEST_BOOKING_COORDINATION',
    factIds: [], templateId: 'BOOKING_COORDINATION', reasonCode: 'MEETING_INTENT' })).reasonCode,
  'BOOKING_LINK_ALREADY_SENT_OR_UNKNOWN');
  state.booking.call.live = true;
  assert.equal(check(state, booking).reasonCode, 'BOOKING_OR_RESCHEDULE');
  assert.equal(booking.decision.suggestedWording.includes('http'), false);
  const reschedule = phase1();
  const earlier = recordFor(reschedule);
  target(reschedule).content = 'Please reschedule our meeting.';
  assert.equal(check(reschedule, earlier).reasonCode, 'BOOKING_OR_RESCHEDULE');
});

test('repeat information and already-handled replies do not receive another proposal permission', () => {
  const state = phase1();
  state.qualification.legacyTags.push('infoSent');
  assert.equal(check(state, recordFor(state)).reasonCode, 'STAFFING_INFO_ALREADY_SENT');
  state.qualification.legacyTags.length = 0;
  state.turns.push({ direction: 'outbound', actor: 'automation', actionType: 'AUTO_STAFFING_SEND_INFO' });
  assert.equal(check(state, recordFor(state)).reasonCode, 'STAFFING_INFO_ALREADY_SENT');
  state.turns.pop();
  target(state).decision.executionStatus = 'sent';
  assert.equal(check(state, recordFor(state)).reasonCode, 'ALREADY_HANDLED');
  target(state).decision.executionStatus = 'recorded';
  target(state).decision.finalClassification = 'ALREADY_HANDLED';
  assert.equal(check(state, recordFor(state)).reasonCode, 'HUMAN_REVIEW_REQUIRED');
  target(state).decision.finalClassification = 'QUESTION';
  state.turns.push({ direction: 'outbound', actor: 'automation',
    inReplyToMessageId: MESSAGE, actionType: 'AUTO_QUESTION_RESPONSE' });
  assert.equal(check(state, recordFor(state)).reasonCode, 'ALREADY_HANDLED');
});

test('objection and referral proposals remain in the catalog but require human handoff', () => {
  const objection = phase1();
  objection.objections.push({ type: 'existing_provider', evidenceMessageId: MESSAGE, status: 'open' });
  const answer = recordFor(objection, { actionId: 'SUGGEST_OBJECTION_RESPONSE',
    factIds: ['F_HANDLES_OUTREACH'], objectionType: 'EXISTING_PROVIDER',
    templateId: 'OBJECTION_ACK', reasonCode: 'OBJECTION_EVIDENCE' });
  assert.equal(answer.decision.status, 'valid');
  assert.equal(check(objection, answer).reasonCode, 'OBJECTION_REQUIRES_HUMAN');
  const referral = phase1();
  referral.referral.status = 'referred';
  const ack = recordFor(referral, { actionId: 'SUGGEST_REFERRAL_ACK', factIds: [],
    templateId: 'REFERRAL_ACK', reasonCode: 'REFERRAL_EVIDENCE' });
  assert.equal(ack.decision.status, 'valid');
  assert.equal(check(referral, ack).reasonCode, 'REFERRAL_REQUIRES_HUMAN');
});

test('conflicting, multiple-thread, unclear, stale and missing production state fail closed', () => {
  for (const [mutate, reason] of [
    [s => { s.evidenceWarnings.push({ code: 'sender_mismatch' }); }, 'CONFLICTING_EVIDENCE'],
    [s => { s.thread.threadIds.push('other'); }, 'MULTIPLE_THREADS'],
    [s => { target(s).content = ''; target(s).contentAvailable = false; }, 'UNCLEAR_INTENT'],
    [s => { target(s).decision.status = 'not_evaluated'; }, 'PRODUCTION_DECISION_MISSING'],
    [s => { target(s).decision.policyAction = null; }, 'PRODUCTION_DECISION_MISSING'],
    [s => { target(s).genuineHuman = null; }, 'HUMAN_INBOUND_UNPROVEN'],
    [s => { s.responseState.answered = 'no_prospect_message'; }, 'RESPONSE_STATE_UNAVAILABLE'],
    [s => { s.ownership.owner = 'unknown'; }, 'OWNERSHIP_UNPROVEN'],
    [s => { s.thread.ownershipStatus = 'unproven'; }, 'OWNERSHIP_UNPROVEN'],
    [s => { s.ambiguities.push({ code: 'question_mark_without_rule', messageId: MESSAGE }); }, 'UNCLEAR_INTENT'],
  ]) {
    const state = phase1();
    const record = recordFor(state);
    mutate(state);
    const permission = check(state, record);
    assert.notEqual(permission.verdict, VERDICT.ALLOW, reason);
    assert.equal(permission.reasonCode, reason);
  }
  const stale = phase1();
  const record = recordFor(stale);
  stale.evidenceDigest = 'later-evidence';
  assert.equal(check(stale, record).reasonCode, 'STATE_CHANGED');
  stale.evidenceDigest = '';
  assert.equal(check(stale, record).reasonCode, 'STATE_OR_RECORD_UNAVAILABLE');
  assert.equal(evaluateAgentV2Permission(null, record).verdict, VERDICT.DENY);
  assert.equal(evaluateAgentV2Permission({ version: 'wrong' }, record).verdict, VERDICT.DENY);
});

test('malformed or mismatched completed decisions fail closed; handoff actions stay handoffs', () => {
  const state = phase1();
  const valid = recordFor(state);
  for (const change of [
    r => { r.decisionId = 'other'; },
    r => { r.authority = { ...AUTHORITY, send: true }; },
    r => { r.modelStatus = 'model_error'; },
    r => { r.decision.slotIds = ['roles']; },
    r => { r.decision.suggestedWording = 'Book here: https://example.test'; },
    r => { r.decision.confidence = 2; },
    r => { r.decision.extra = 'send'; },
  ]) {
    const altered = structuredClone(valid);
    change(altered);
    assert.equal(check(state, altered).verdict, VERDICT.DENY);
  }
  const handoff = recordFor(state, { actionId: 'HANDOFF', handoffCode: 'UNCLEAR_INTENT',
    factIds: [], templateId: 'NONE', reasonCode: 'HUMAN_REVIEW_REQUIRED' });
  assert.equal(handoff.decision.status, 'valid');
  assert.equal(check(state, handoff).reasonCode, 'UNCLEAR_INTENT');
  const noAction = recordFor(state, { actionId: 'NO_ACTION', factIds: [],
    templateId: 'NONE', reasonCode: 'NO_ACTION_REQUIRED' });
  assert.equal(check(state, noAction).reasonCode, 'NO_ACTION_REQUIRED');
});

test('permission module remains outside every production or one-shot execution path', () => {
  for (const file of ['server.js', 'outreach-agent.js', 'scripts/agent-v2-replay.js',
    'integrations/agent-v2-shadow.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), 'utf8'), /agent-v2-permission/);
  }
});
