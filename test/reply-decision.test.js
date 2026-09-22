'use strict';

// One authoritative decision per inbound message: interpretation, policy and
// execution kept distinct, persisted once, and read by analytics and the shadow
// agent instead of being re-derived. The reply pass itself is not unit-testable
// (it is one long procedure over Sheets and Gmail), so it calls
// interpretInboundReply and the record helpers exercised here, and the source
// checks at the end pin that wiring.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { classifyReplyText } = require('../integrations/canonical-reply');
const { classifyReply, classifyReplyDetailed, deterministicReplyCategory } = require('../integrations/reply-classifier');
const {
  ACTION, decideReplyResponse, numericConfidence, POSITIVE_AUTOSEND_FLOOR, POLICY_VERSION,
} = require('../integrations/reply-response-policy');
const {
  REPLY_DECISION_EVENT, CLASSIFICATION_SOURCE, POLICY_SOURCE, ROUTE, EXECUTION_STATUS, EFFECT,
  interpretInboundReply, recordPolicy, recordExecution, addEffect, executionForRoute,
  executionForDelivery, finalizeReplyDecision, replyDecisionEventId, replyDecisionActivity,
  parseReplyDecision, replyDecisionsByKey, replyDecisionFor, applyReplyDecisionsToReplyEvidence,
  productionFactsFromDecision,
} = require('../integrations/reply-decision');
const { categoryFromEvidence, buildReplyMetrics, buildReplyEvidenceMap } = require('../integrations/reply-analytics');
const { evaluateStaffingConversationShadow } = require('../integrations/staffing-agent-shadow');
const { STAFFING_AGENT_KEY_ENV, actionAgreesWithPolicy } = require('../integrations/staffing-agent-schema');
const { STAFFING_CAMPAIGN } = require('../integrations/staffing-campaign');
const { STAFFING_NOTE } = require('../integrations/staffing-reply-policy');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').split('\r\n').join('\n');

const NOW = new Date('2026-09-18T12:05:00.000Z');
const STAFFING_OFFER = { id: 'industrial_staffing_employer_acquisition_v1', pricing: null };
const DENTAL_OFFER = { id: 'dental_guarantee_v1', pricing: null };

const dentalLead = (over = {}) => ({
  id: 'den-1', company: 'Cooper Dental', email: 'owner@cooper.test',
  leadNiche: 'dental', emailTemplateId: 'dental-guarantee-v1', notes: '', ...over,
});

const staffingLead = (over = {}) => ({
  id: 'staff-1', company: 'Acme Staffing', email: 'ada@acmestaffing.com',
  campaign: STAFFING_CAMPAIGN.name, emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId,
  leadNiche: 'industrial_staffing', intendedCampaignVersion: STAFFING_CAMPAIGN.id, notes: '', ...over,
});

const inbound = (over = {}) => ({
  messageId: 'gm-1', threadId: 'th-1', subject: 'Re: quick question',
  occurredAt: '2026-09-18T12:00:00.000Z', ...over,
});

// A model stub. `null` means "no model available"; `calls` records use.
function modelReturning(label) {
  const calls = [];
  const createMessage = label === null ? undefined : async (payload) => {
    calls.push(payload);
    return { content: [{ type: 'text', text: label }], usage: { input_tokens: 10, output_tokens: 2 } };
  };
  return { calls, createMessage };
}

// The reply pass's interpretation step, with the real classifier and a stubbed model.
async function interpret({ lead, text, model = null, maySend = true, message = inbound() }) {
  const stub = modelReturning(model);
  const ruleCanonical = classifyReplyText(text, {
    subject: message.subject, currentEmail: lead.email, now: message.occurredAt,
  });
  const { decision, overlay } = await interpretInboundReply({
    lead, message, replyText: text, ruleCanonical, maySend, now: NOW,
    ruleCategory: deterministicReplyCategory,
    classify: () => classifyReplyDetailed({
      lead, subject: message.subject, plainTextReply: text,
      apiKey: '', createMessage: stub.createMessage, messageId: message.messageId,
    }),
  });
  return { decision, overlay, ruleCanonical, modelCalls: stub.calls };
}

// What handlePositiveAutomation does with the decision, minus the IO.
function applyPositivePolicy(decision, overlay, ruleCanonical, { offer, family = '' }) {
  const canonical = overlay?.canonical || ruleCanonical;
  const classification = overlay?.classification || decision.finalClassification;
  const policy = decideReplyResponse({
    classification, canonical, offer, family, text: '', qualificationFit: overlay?.fit || '',
    confidence: overlay?.confidence || numericConfidence({ classification, canonical }),
  });
  recordPolicy(decision, {
    action: policy.action, send: policy.send, reason: policy.reason, classification,
    source: POLICY_SOURCE.REPLY_RESPONSE_POLICY, confidence: policy.confidence,
    confidenceSource: overlay?.confidence ? 'staffing_overlay' : 'rule_signals', floor: POSITIVE_AUTOSEND_FLOOR,
  });
  return policy;
}

function observerReplyEvent(lead, message, ruleCanonical, eventType) {
  return {
    eventId: `gmail-reply:${message.messageId}`, leadId: `CE-${lead.id}`, sourceLeadId: lead.id,
    email: lead.email, company: lead.company, eventType, occurredAt: message.occurredAt,
    subject: message.subject, content: 'reply body',
    metadata: JSON.stringify({
      provider: 'gmail', gmailMessageId: message.messageId, gmailThreadId: message.threadId,
      canonicalState: ruleCanonical.state, reason: ruleCanonical.reason, confidence: ruleCanonical.confidence,
    }),
  };
}

const persisted = decision => JSON.parse(replyDecisionActivity(decision).metadata);

// ── A. deterministic-only ───────────────────────────────────────────────────

test('A. a confident rule classification persists consistently end to end', async () => {
  const lead = dentalLead();
  const { decision, overlay, ruleCanonical, modelCalls } = await interpret({
    lead, text: 'Sounds interesting, tell me more', model: 'NOT_INTERESTED',
  });
  assert.equal(modelCalls.length, 0, 'a confident rule result never calls the model');
  assert.equal(decision.ruleClassification, 'INTERESTED');
  assert.equal(decision.modelClassification, null);
  assert.equal(decision.modelStatus, 'not_called');
  assert.equal(decision.finalClassification, 'INTERESTED');
  assert.equal(decision.finalClassificationSource, CLASSIFICATION_SOURCE.RULE);
  assert.equal(decision.canonicalState, 'positive');
  assert.equal(decision.classificationConfidence, 'high');
  assert.equal(decision.classificationConfidenceSource, 'rule_canonical');
  assert.equal(decision.route, ROUTE.INTERESTED);
  assert.equal(decision.policyDeferredTo, POLICY_SOURCE.REPLY_RESPONSE_POLICY);

  const policy = applyPositivePolicy(decision, overlay, ruleCanonical, { offer: DENTAL_OFFER });
  assert.equal(policy.action, ACTION.AUTO_BOOKING_RESPONSE);
  recordExecution(decision, executionForDelivery(policy.action, { delivered: true, actionId: 'a1' }));
  finalizeReplyDecision(decision);

  const row = persisted(decision);
  assert.equal(row.ruleClassification, 'INTERESTED');
  assert.equal(row.finalClassification, 'INTERESTED');
  assert.equal(row.finalClassificationSource, 'rule');
  assert.equal(row.policyAction, ACTION.AUTO_BOOKING_RESPONSE);
  assert.equal(row.policyConfidence, 90);
  assert.equal(row.policyConfidenceSource, 'rule_signals');
  assert.equal(row.policyConfidenceFloor, POSITIVE_AUTOSEND_FLOOR);
  assert.equal(row.executedAction, ACTION.AUTO_BOOKING_RESPONSE);
  assert.equal(row.executionStatus, EXECUTION_STATUS.SENT);
  assert.equal(row.requiresHumanAttention, false);
  assert.equal(row.policyVersion, POLICY_VERSION);
  assert.ok(row.classifierVersion, 'the rule classifier version is stamped');
});

// ── B. model fallback changes the classification ────────────────────────────

test('B. a model result that wins is the final classification, and analytics counts it', async () => {
  const lead = dentalLead();
  const message = inbound();
  const text = 'We are all set with our current vendor';
  const { decision, ruleCanonical, modelCalls } = await interpret({ lead, text, model: 'NOT_INTERESTED', message });
  assert.equal(modelCalls.length, 1, 'the rules declined, so the model was asked');
  assert.equal(decision.ruleClassification, null, 'the rule classifier declined');
  assert.equal(decision.ruleCanonical.state, 'needs_human');
  assert.equal(decision.modelClassification, 'NOT_INTERESTED');
  assert.notEqual(decision.ruleClassification, decision.modelClassification);
  assert.equal(decision.finalClassification, decision.modelClassification);
  assert.equal(decision.finalClassificationSource, CLASSIFICATION_SOURCE.MODEL);
  assert.equal(decision.canonicalState, 'negative');
  assert.equal(decision.classificationConfidence, null, 'the model returns a label, not a confidence');
  assert.equal(decision.route, ROUTE.NOT_INTERESTED);
  recordExecution(decision, executionForRoute(decision.route, undefined));
  finalizeReplyDecision(decision);

  // The observer stored the rule classifier's reading before classification.
  const reply = observerReplyEvent(lead, message, ruleCanonical, 'needs_human_reply');
  assert.equal(categoryFromEvidence(lead, [reply]), 'needs_human', 'the old divergence, without a decision');
  const activities = [reply, replyDecisionActivity(decision)];
  assert.equal(categoryFromEvidence(lead, activities), 'negative');
  const metrics = buildReplyMetrics([{ ...lead, emailStatus: 'replied' }], {
    activitiesByLeadId: new Map([[lead.id, activities]]),
  });
  assert.equal(metrics.negative, 1);
  assert.equal(metrics.needsHuman, 0);
  assert.equal(buildReplyEvidenceMap(activities).get(lead.id)[0].classification, 'NOT_INTERESTED');
});

test('B2. provenance never changes which category the classifier returns', async () => {
  const cases = [
    ['Sounds interesting, tell me more', 'QUESTION', 'rule'],
    ['We are all set with our current vendor', 'NOT_INTERESTED', 'model'],
    ['We are all set with our current vendor', 'GIBBERISH', 'model_fallback'],
    ['We are all set with our current vendor', null, 'model_fallback'],
  ];
  for (const [text, label, source] of cases) {
    const stub = modelReturning(label);
    const input = { lead: dentalLead(), plainTextReply: text, apiKey: '', createMessage: stub.createMessage };
    const detailed = await classifyReplyDetailed(input);
    assert.equal(detailed.classification, await classifyReply(input), text);
    assert.equal(detailed.source, source, `${text} / ${label}`);
  }
  const erroring = await classifyReplyDetailed({
    lead: dentalLead(), plainTextReply: 'We are all set with our current vendor',
    createMessage: async () => { throw new Error('overloaded'); },
  });
  assert.equal(erroring.classification, 'NEEDS_HUMAN');
  assert.equal(erroring.modelStatus, 'error');
  const prior = await classifyReplyDetailed({
    lead: dentalLead(), plainTextReply: 'hmm ok', alreadyEvaluated: true, priorClassification: 'QUESTION',
  });
  assert.deepEqual([prior.classification, prior.source], ['QUESTION', 'prior_evaluation']);
});

// ── C. staffing overlay changes the classification ──────────────────────────

test('C. the staffing overlay is recorded beside the classifier result, and the final is explicit', async () => {
  const lead = staffingLead();
  const { decision, overlay, ruleCanonical } = await interpret({ lead, text: 'Send me some info', model: 'QUESTION' });
  assert.equal(decision.ruleClassification, null);
  assert.equal(decision.modelClassification, 'QUESTION');
  assert.equal(decision.upstreamClassification, 'QUESTION');
  assert.equal(decision.overlayClassification, 'SEND_INFO');
  assert.equal(decision.finalClassification, 'SEND_INFO');
  assert.equal(decision.finalClassificationSource, CLASSIFICATION_SOURCE.STAFFING_OVERLAY);
  assert.equal(decision.canonicalState, 'positive');
  assert.equal(decision.route, ROUTE.SEND_INFO);

  const policy = applyPositivePolicy(decision, overlay, ruleCanonical, { offer: STAFFING_OFFER, family: 'industrial_staffing' });
  assert.equal(policy.action, ACTION.AUTO_STAFFING_SEND_INFO);
  assert.equal(decision.policyConfidenceSource, 'staffing_overlay');
  assert.equal(decision.policyClassification, undefined, 'policy saw the same classification the decision records');
});

test('C2. a blocked staffing overlay is a review case whatever the rules read', async () => {
  const lead = staffingLead();
  const { decision } = await interpret({ lead, text: "I'm looking for a job as a welder, my resume attached", model: 'INTERESTED' });
  assert.equal(decision.finalClassificationSource, CLASSIFICATION_SOURCE.STAFFING_OVERLAY);
  assert.ok(['WRONG_PERSON', 'ALREADY_HANDLED'].includes(decision.finalClassification));
  assert.equal(decision.canonicalState, 'needs_human');
  assert.equal(decision.policyAction, ACTION.HUMAN_REVIEW);
  assert.equal(decision.overlay.blocked, true);
});

test('C3. a qualification answer records its fit as the qualification state', async () => {
  const lead = staffingLead({ notes: STAFFING_NOTE.QUALIFY_ASKED });
  const { decision } = await interpret({ lead, text: 'We place welders and machinists for manufacturers in Ohio', model: 'NEEDS_HUMAN' });
  assert.equal(decision.finalClassification, 'STAFFING_QUALIFICATION');
  assert.equal(decision.qualificationState, 'clear');
  assert.equal(decision.route, ROUTE.STAFFING_QUALIFICATION);
});

// ── D. NOT_INTERESTED ───────────────────────────────────────────────────────

test('D. a rejection: final decision, suppression and analytics agree', async () => {
  const lead = dentalLead();
  const message = inbound({ messageId: 'gm-no' });
  const { decision, ruleCanonical, modelCalls } = await interpret({ lead, text: 'Not interested, thanks', model: 'INTERESTED', message });
  assert.equal(modelCalls.length, 0, 'an explicit rejection never waits on a model');
  assert.equal(decision.finalClassification, 'NOT_INTERESTED');
  assert.equal(decision.finalClassificationSource, CLASSIFICATION_SOURCE.RULE);
  assert.equal(decision.policyAction, ACTION.AUTO_NEGATIVE_CLOSE);
  assert.equal(decision.policySend, false);
  recordExecution(decision, executionForRoute(decision.route, undefined));
  finalizeReplyDecision(decision);
  assert.equal(decision.executedAction, ACTION.AUTO_NEGATIVE_CLOSE);
  assert.equal(decision.executionStatus, EXECUTION_STATUS.SUPPRESSED);
  assert.deepEqual(decision.effects, [EFFECT.SUPPRESSION_ADDED]);
  const activities = [observerReplyEvent(lead, message, ruleCanonical, 'negative_reply'), replyDecisionActivity(decision)];
  assert.equal(categoryFromEvidence(lead, activities), 'negative');
});

// ── E. INTERESTED below the auto-send floor ─────────────────────────────────

test('E. a model-only INTERESTED is routed to a human and never recorded as sent', async () => {
  const lead = dentalLead();
  const { decision, overlay, ruleCanonical } = await interpret({ lead, text: 'I would love to learn more about this', model: 'INTERESTED' });
  assert.equal(decision.finalClassification, 'INTERESTED');
  assert.equal(decision.finalClassificationSource, CLASSIFICATION_SOURCE.MODEL);
  assert.equal(decision.canonicalState, 'positive');
  const policy = applyPositivePolicy(decision, overlay, ruleCanonical, { offer: DENTAL_OFFER });
  assert.equal(policy.action, ACTION.HUMAN_REVIEW);
  assert.equal(decision.policyAction, ACTION.HUMAN_REVIEW);
  assert.equal(decision.policySend, false);
  assert.equal(decision.policyConfidence, 40, 'the score comes from rule signals, which were weak');
  assert.equal(decision.policyConfidenceSource, 'rule_signals');
  recordExecution(decision, { ...executionForRoute(ROUTE.NEEDS_HUMAN, undefined), effects: [EFFECT.DRAFT_QUEUED] });
  finalizeReplyDecision(decision);
  assert.equal(decision.executedAction, ACTION.HUMAN_REVIEW);
  assert.equal(decision.executionStatus, EXECUTION_STATUS.ROUTED_TO_HUMAN);
  assert.notEqual(decision.executionStatus, EXECUTION_STATUS.SENT);
  assert.equal(decision.requiresHumanAttention, true);
});

// ── F. successful auto-reply ────────────────────────────────────────────────

test('F. a delivered auto-reply records the same action as executed and sent', async () => {
  const lead = staffingLead();
  const { decision, overlay, ruleCanonical } = await interpret({ lead, text: 'Yes, I am interested in learning more.' });
  const policy = applyPositivePolicy(decision, overlay, ruleCanonical, { offer: STAFFING_OFFER, family: 'industrial_staffing' });
  assert.equal(policy.action, ACTION.AUTO_STAFFING_QUALIFY_QUESTION);
  recordExecution(decision, executionForDelivery(policy.action, { delivered: true, actionId: 'act-1' }));
  addEffect(decision, EFFECT.PROMOTED_HOT);
  finalizeReplyDecision(decision);
  assert.equal(decision.policyAction, ACTION.AUTO_STAFFING_QUALIFY_QUESTION);
  assert.equal(decision.executedAction, decision.policyAction);
  assert.equal(decision.executionStatus, EXECUTION_STATUS.SENT);
  assert.equal(decision.requiresHumanAttention, false);
  // A replayed delivery is recorded as already sent, not as a second send.
  const replay = executionForDelivery(policy.action, { delivered: true, recovered: true, alreadyCheckpointed: true });
  assert.equal(replay.status, EXECUTION_STATUS.ALREADY_SENT);
  // The booking_link_sent event still carries the action the taxonomy reads.
  const agent = read('outreach-agent.js');
  const deliver = agent.slice(agent.indexOf('async function deliverHardenedWarmReply'), agent.indexOf('async function handlePositiveAutomation'));
  assert.match(deliver, /eventType: 'booking_link_sent'/);
  assert.match(deliver, /metadata: JSON\.stringify\(\{ actionId, action, classification,/);
  assert.match(deliver, /replyDecisionId/);
});

// ── G. failed auto-reply ────────────────────────────────────────────────────

test('G. a refused or failed send keeps the policy intent visible and marks execution', async () => {
  const lead = dentalLead();
  for (const [code, status] of [['provider_rejected', 'failed'], ['provider_ambiguous', 'failed'], ['meeting_booked_live', 'blocked'], ['manual_hold', 'blocked']]) {
    const { decision, overlay, ruleCanonical } = await interpret({ lead, text: 'Sounds interesting, tell me more' });
    applyPositivePolicy(decision, overlay, ruleCanonical, { offer: DENTAL_OFFER });
    recordExecution(decision, executionForDelivery(decision.policyAction, { delivered: false, code }));
    finalizeReplyDecision(decision);
    assert.equal(decision.policyAction, ACTION.AUTO_BOOKING_RESPONSE, code);
    assert.equal(decision.policySend, true);
    assert.equal(decision.executedAction, null, code);
    assert.equal(decision.executionStatus, status, code);
    assert.equal(decision.executionCode, code);
    assert.equal(decision.fallbackAction, ACTION.HUMAN_REVIEW);
    assert.equal(decision.requiresHumanAttention, true);
  }
});

test('G2. a question the answerer wanted to send but a gate held is blocked, not re-labelled', () => {
  const decision = { effects: [], executionStatus: EXECUTION_STATUS.PENDING, finalClassification: 'QUESTION' };
  recordPolicy(decision, {
    action: ACTION.AUTO_QUESTION_RESPONSE, send: true, reason: 'confident answer (pricing)',
    source: POLICY_SOURCE.QUESTION_ANSWERER, confidence: 92, confidenceSource: 'answer_model', floor: 85,
    classification: 'QUESTION',
  });
  recordExecution(decision, {
    executedAction: null, status: EXECUTION_STATUS.BLOCKED, code: 'daily_send_cap',
    fallbackAction: ACTION.HUMAN_REVIEW, effects: [EFFECT.DRAFT_QUEUED],
  });
  finalizeReplyDecision(decision);
  assert.equal(decision.policyAction, ACTION.AUTO_QUESTION_RESPONSE);
  assert.equal(decision.executionStatus, 'blocked');
  assert.equal(decision.requiresHumanAttention, true);
});

// ── H. idempotent reprocessing ──────────────────────────────────────────────

test('H. reprocessing the same inbound message cannot produce a second, contradictory decision', async () => {
  const lead = dentalLead();
  const message = inbound({ messageId: 'gm-same' });
  const first = (await interpret({ lead, text: 'Sounds interesting, tell me more', message })).decision;
  const second = (await interpret({ lead, text: 'Sounds interesting, tell me more', message })).decision;
  assert.equal(first.decisionId, 'reply-decision:den-1:gm-same');
  assert.equal(first.decisionId, second.decisionId, 'identity is lead + Gmail message, not time');
  assert.equal(replyDecisionEventId('CE-den-1', 'gm-same'), first.decisionId);
  assert.notEqual(replyDecisionEventId('other-lead', 'gm-same'), first.decisionId);
  assert.equal(replyDecisionEventId('den-1', ''), '', 'no message id, no persisted decision');

  recordExecution(first, executionForDelivery(ACTION.AUTO_BOOKING_RESPONSE, { delivered: true }));
  recordExecution(second, executionForDelivery(ACTION.AUTO_BOOKING_RESPONSE, { delivered: true, alreadyCheckpointed: true }));
  const rows = [
    { ...replyDecisionActivity(second), occurredAt: '2026-09-18T13:00:00.000Z' },
    { ...replyDecisionActivity(first), occurredAt: '2026-09-18T12:05:00.000Z' },
  ];
  const decisions = replyDecisionsByKey(rows);
  assert.equal(decisions.size, 1);
  assert.equal(replyDecisionFor(rows, 'gm-same', lead.id).executionStatus, EXECUTION_STATUS.SENT,
    'if a duplicate ever existed, the first decision (the one acted on) wins');

  // The writer refuses a second append for the same id, in this pass and across runs.
  const agent = read('outreach-agent.js');
  const writer = agent.slice(agent.indexOf('async function persistReplyDecision'), agent.indexOf('async function handleNotInterested'));
  assert.ok(writer.indexOf("String(item.eventId || '') === row.eventId") < writer.indexOf('recordMailboxActivity(row)'));
  const mailboxWriter = agent.slice(agent.indexOf('async function recordMailboxActivity'), agent.indexOf('// Re-resolve a lead'));
  assert.match(mailboxWriter, /current\.find\(row => row\.eventId === event\.eventId\)/,
    'recordMailboxActivity re-reads the ledger before appending');
});

// ── I. shadow evaluation ────────────────────────────────────────────────────

const shadowEnv = {
  STAFFING_CONVERSATION_AGENT_ENABLED: 'true', STAFFING_CONVERSATION_AGENT_MODE: 'shadow',
  [STAFFING_AGENT_KEY_ENV]: 'test-dedicated-key',
};
const agentSays = action => async () => ({
  content: [{ type: 'text', text: JSON.stringify({
    intent: 'INTERESTED', confidence: 0.9, fit: 'UNKNOWN', recommendedAction: action,
    reason: `Recommend ${action}.`, replyDraft: 'Thanks.',
  }) }],
  usage: { input_tokens: 100, output_tokens: 40 },
});

async function sentStaffingDecision(messageId) {
  const lead = staffingLead();
  const { decision, overlay, ruleCanonical } = await interpret({
    lead, text: 'Yes, I am interested in learning more.', message: inbound({ messageId }),
  });
  applyPositivePolicy(decision, overlay, ruleCanonical, { offer: STAFFING_OFFER, family: 'industrial_staffing' });
  recordExecution(decision, executionForDelivery(decision.policyAction, { delivered: true }));
  finalizeReplyDecision(decision);
  return { lead, decision };
}

test('I. the shadow compares against the real production decision, not a recomputation', async () => {
  const { lead, decision } = await sentStaffingDecision('gm-shadow-1');
  const events = [];
  await evaluateStaffingConversationShadow({
    lead, message: inbound({ messageId: 'gm-shadow-1', body: 'Yes, I am interested in learning more.' }),
    replyText: 'Yes, I am interested in learning more.', activities: [],
    productionClassification: decision.finalClassification, productionAction: decision.policyAction,
    productionDecision: productionFactsFromDecision(decision),
    persistEvent: async event => events.push(event), env: shadowEnv, createMessage: agentSays('ASK_QUALIFICATION'),
  });
  const meta = JSON.parse(events[0].metadata);
  // The old code re-ran decideReplyResponse without confidence and recorded
  // HUMAN_REVIEW for every auto-send.
  assert.equal(decideReplyResponse({ classification: 'INTERESTED', offer: STAFFING_OFFER, text: '' }).action, ACTION.HUMAN_REVIEW);
  assert.equal(meta.productionAction, ACTION.AUTO_STAFFING_QUALIFY_QUESTION);
  assert.equal(meta.productionPolicyAction, ACTION.AUTO_STAFFING_QUALIFY_QUESTION);
  assert.equal(meta.productionExecutedAction, ACTION.AUTO_STAFFING_QUALIFY_QUESTION);
  assert.equal(meta.productionExecutionStatus, 'sent');
  assert.equal(meta.productionDecisionSource, 'reply_decision');
  assert.equal(meta.productionDecisionId, decision.decisionId);
  assert.equal(meta.productionClassification, 'INTERESTED');
  assert.equal(meta.broadlyAgree, true, 'agent vs final interpretation');
  assert.equal(meta.actionAgreesWithPolicy, true, 'agent vs production policy');
  assert.equal(meta.policyExecuted, true, 'production policy vs what happened');
  assert.equal(meta.autoSendAllowed, false);
});

test('I2. without in-pass facts the shadow reads the persisted decision; with neither it says unavailable', async () => {
  const { lead, decision } = await sentStaffingDecision('gm-shadow-2');
  const events = [];
  await evaluateStaffingConversationShadow({
    lead, message: inbound({ messageId: 'gm-shadow-2', body: 'Yes' }), replyText: 'Yes',
    activities: [replyDecisionActivity(decision)],
    persistEvent: async event => events.push(event), env: shadowEnv, createMessage: agentSays('SEND_BOOKING'),
  });
  let meta = JSON.parse(events[0].metadata);
  assert.equal(meta.productionDecisionSource, 'reply_decision');
  assert.equal(meta.productionPolicyAction, ACTION.AUTO_STAFFING_QUALIFY_QUESTION);
  assert.equal(meta.actionAgreesWithPolicy, false);

  events.length = 0;
  await evaluateStaffingConversationShadow({
    lead, message: inbound({ messageId: 'gm-shadow-3', body: 'Interested' }), replyText: 'Interested',
    activities: [], persistEvent: async event => events.push(event), env: shadowEnv,
    createMessage: agentSays('ASK_QUALIFICATION'),
  });
  meta = JSON.parse(events[0].metadata);
  assert.equal(meta.productionDecisionSource, 'unavailable');
  assert.equal(meta.productionAction, '', 'no production action is invented');
  assert.equal(meta.productionClassification, '', 'no production classification is invented');
  assert.equal(meta.actionAgreesWithPolicy, null);
  assert.equal(meta.policyExecuted, null);

  const shadow = read('integrations/staffing-agent-shadow.js');
  assert.doesNotMatch(shadow, /decideReplyResponse|deterministicReplyCategory|observableProductionAction/);
  assert.equal(actionAgreesWithPolicy('ESCALATE_HUMAN', 'HUMAN_REVIEW'), true);
  assert.equal(actionAgreesWithPolicy('SEND_BOOKING', ''), null);
});

// ── J. safety precedence ────────────────────────────────────────────────────

test('J. opt-out and rejection win everywhere, and check-only never routes to a send', async () => {
  const staffing = staffingLead({ notes: STAFFING_NOTE.QUALIFY_ASKED });
  const unsub = await interpret({ lead: staffing, text: 'Please unsubscribe me', model: 'INTERESTED', maySend: false });
  assert.equal(unsub.modelCalls.length, 0);
  assert.equal(unsub.overlay, null, 'the staffing overlay never relabels an opt-out');
  assert.equal(unsub.decision.finalClassification, 'UNSUBSCRIBE');
  assert.equal(unsub.decision.route, ROUTE.UNSUBSCRIBE, 'CHECK_ONLY/historical still suppresses');
  assert.equal(unsub.decision.policyAction, ACTION.SUPPRESS);

  // A rejection that also names a date is still a rejection.
  const negative = await interpret({ lead: dentalLead(), text: 'Not interested. Maybe try again in March.' });
  assert.equal(negative.decision.route, ROUTE.NOT_INTERESTED);

  // Historical / CHECK_ONLY positive: no send-capable route at all.
  const historical = await interpret({ lead: dentalLead(), text: 'Sounds interesting, tell me more', maySend: false });
  assert.equal(historical.decision.route, ROUTE.HISTORICAL_NO_ACTION);
  assert.equal(historical.decision.policyAction, ACTION.NO_ACTION);
  assert.equal(historical.decision.policySend, false);
  const skipped = executionForRoute(historical.decision.route, undefined);
  assert.equal(skipped.status, EXECUTION_STATUS.SKIPPED);

  // A dated deferral schedules recontact; an undated one holds for a human.
  const dated = await interpret({ lead: dentalLead(), text: 'Not right now, maybe reach out in March' });
  assert.equal(dated.decision.route, ROUTE.TIMING);
  assert.equal(dated.decision.policyAction, ACTION.AUTO_TIMING_RECONTACT);
  assert.equal(executionForRoute(ROUTE.TIMING, { scheduled: true }).status, EXECUTION_STATUS.RECONTACT_SCHEDULED);
  assert.equal(executionForRoute(ROUTE.TIMING, { scheduled: false }).executedAction, ACTION.HUMAN_REVIEW);
  // A handler that could not find the lead row reports it rather than looking done.
  const missing = executionForRoute(ROUTE.UNSUBSCRIBE, { skipped: 'lead_row_missing' });
  assert.equal(missing.status, EXECUTION_STATUS.SKIPPED);
  assert.equal(missing.executedAction, null);
});

test('J2. the decision records safety outcomes; it cannot send, write or suppress', () => {
  const src = read('integrations/reply-decision.js');
  assert.doesNotMatch(src, /sendEmail|applyLeadChange|addSuppression|recordColdCall|deliverProspectReply|googleapis|@anthropic-ai/);
  const agent = read('outreach-agent.js');
  const deliver = agent.slice(agent.indexOf('async function deliverHardenedWarmReply'), agent.indexOf('async function handlePositiveAutomation'));
  // The last-moment gates are unchanged: suppression, hold, meeting, ownership, quota.
  for (const gate of ["'[MANUAL HOLD]'", 'evaluateFreshSendSafety', "code: 'meeting_booked'", 'deriveAutomationOwnership',
    "code: 'sender_quota'", "code: 'observer_not_incremental'"]) {
    assert.ok(deliver.includes(gate), `warm send still checks ${gate}`);
  }
  // Execution is recorded from what delivery returned, after it returned.
  const positive = agent.slice(agent.indexOf('async function handlePositiveAutomation'), agent.indexOf('async function handleTimingReply'));
  assert.ok(positive.indexOf('deliverHardenedWarmReply(') < positive.indexOf('executionForDelivery(policy.action, delivered)'));
  assert.match(positive, /decidedOverlay !== undefined/, 'the reply pass overlay is reused, not recomputed');
});

// ── historical compatibility and wiring ─────────────────────────────────────

test('legacy replies without a decision keep their stored evidence', () => {
  const lead = dentalLead();
  const legacy = {
    eventId: 'gmail-reply:old', sourceLeadId: lead.id, leadId: `CE-${lead.id}`, eventType: 'needs_human_reply',
    occurredAt: '2026-08-01T00:00:00.000Z',
    metadata: JSON.stringify({ gmailMessageId: 'old', canonicalState: 'needs_human' }),
  };
  assert.equal(applyReplyDecisionsToReplyEvidence([legacy])[0], legacy, 'no decision: the row is untouched');
  assert.equal(categoryFromEvidence(lead, [legacy]), 'needs_human');
  // A decision for another lead on the same message id does not leak across.
  const other = {
    eventId: 'reply-decision:x:old', sourceLeadId: 'x', eventType: REPLY_DECISION_EVENT, occurredAt: '2026-08-01T00:01:00.000Z',
    metadata: JSON.stringify({ leadId: 'x', inboundMessageId: 'old', canonicalState: 'negative', finalClassification: 'NOT_INTERESTED' }),
  };
  assert.equal(categoryFromEvidence(lead, [legacy, other]), 'needs_human');
  assert.equal(parseReplyDecision(legacy), null);
});

test('the reply pass builds, executes and persists one decision per message', () => {
  const agent = read('outreach-agent.js');
  const pass = agent.slice(agent.indexOf('async function runReplyCheckPass'), agent.indexOf('async function commitMailboxObservationCheckpoints'));
  assert.match(pass, /await interpretInboundReply\(\{/);
  assert.match(pass, /const classification = replyDecision\.finalClassification;/);
  assert.match(pass, /switch \(route\)/);
  assert.match(pass, /recordReplyExecution\(replyDecision, executionForRoute\(route, result\)\)/);
  assert.ok(pass.indexOf('finalizeReplyDecision(replyDecision)') < pass.indexOf('persistReplyDecision(lead, replyDecision'));
  assert.ok(pass.indexOf('persistReplyDecision(lead, replyDecision') < pass.indexOf("eventType: 'gmail_reply_evaluated'"),
    'the decision is persisted before the evaluated checkpoint, after execution');
  assert.match(pass, /replyDecisionId: replyDecision\.decisionId/);
  assert.match(pass, /decision: productionFactsFromDecision\(replyDecision\)/);
  assert.match(pass, /decision: productionFactsFromDecision\(prior\)/);
  // No second, independent classification of the message in the pass.
  assert.doesNotMatch(pass, /await classifyReply\(/);
  assert.equal((pass.match(/overlayStaffingReplyClassification\(/g) || []).length, 0);
});
