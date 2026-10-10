'use strict';

// Operational consumers (Inbox / Next Action, ownership, CRM Health, the
// inbound guard) read production's reply decision instead of re-deriving reply
// meaning from the rule classifier, while every safety fact keeps precedence.
// Scenarios are built with the same interpretation and policy code the reply
// pass runs, then read back through the real consumers.

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyReplyText } = require('../integrations/canonical-reply');
const { classifyReplyDetailed, deterministicReplyCategory } = require('../integrations/reply-classifier');
const { ACTION, decideReplyResponse, numericConfidence, POSITIVE_AUTOSEND_FLOOR } = require('../integrations/reply-response-policy');
const {
  interpretInboundReply, recordPolicy, recordExecution, executionForRoute, executionForDelivery,
  finalizeReplyDecision, replyDecisionActivity, effectiveReplyDecision, operationalAcceptance,
  operationalReplyEvidence, POLICY_SOURCE, ROUTE, EXECUTION_STATUS,
} = require('../integrations/reply-decision');
const { deriveReplyOperation, deriveOperationalAction, REPLY_ACTION, WAITING_ON, ACTION_OWNER } = require('../integrations/reply-operations');
const { deriveAutomationOwnership, mayColdSend, OWNER, BLOCKED_BY } = require('../integrations/automation-ownership');
const { deriveNextAction } = require('../integrations/pipeline-state');
const { committedInboundClassification, inboundAlreadyEvaluated } = require('../integrations/inbound-reply-guard');
const { categoryFromEvidence } = require('../integrations/reply-analytics');
const { buildCrmHealth } = require('../integrations/crm-health');
const { latestResponseAt } = require('../integrations/prospect-response');
const { STAFFING_CAMPAIGN } = require('../integrations/staffing-campaign');

const RECEIVED = '2026-09-18T12:00:00.000Z';
const DECIDED = new Date('2026-09-18T12:05:00.000Z');
const LATER = new Date('2026-09-18T15:00:00.000Z');
const DENTAL_OFFER = { id: 'dental_guarantee_v1', pricing: null };
const STAFFING_OFFER = { id: 'industrial_staffing_employer_acquisition_v1', pricing: null };

const dentalLead = (over = {}) => ({
  id: 'den-1', company: 'Cooper Dental', email: 'owner@cooper.test',
  leadNiche: 'dental', emailTemplateId: 'dental-guarantee-v1', notes: '',
  stage: 'Contacted', emailStatus: 'emailed', emailStep: '1', ...over,
});
const staffingLead = (over = {}) => ({
  id: 'staff-1', company: 'Acme Staffing', email: 'ada@acmestaffing.com',
  campaign: STAFFING_CAMPAIGN.name, emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId,
  leadNiche: 'industrial_staffing', intendedCampaignVersion: STAFFING_CAMPAIGN.id, notes: '',
  stage: 'Contacted', emailStatus: 'emailed', emailStep: '1', ...over,
});

const OBSERVER_EVENT = {
  positive: 'positive_reply', negative: 'negative_reply', needs_human: 'needs_human_reply',
  automated_reply: 'out_of_office_reply', contact_change_review: 'needs_human_reply',
};

/**
 * One inbound reply, interpreted and decided as the reply pass does it.
 * `execute(decision, ctx)` records policy and outcome the way the handler
 * for that route does. Returns the lead's activities as the ledger would hold
 * them: the observer's reply event (rule reading) and the decision.
 */
async function scenario({ lead, text, model = null, messageId = 'gm-1', maySend = true, execute }) {
  const message = { messageId, threadId: 'th-1', subject: 'Re: hello', occurredAt: RECEIVED };
  const ruleCanonical = classifyReplyText(text, { subject: message.subject, currentEmail: lead.email, now: RECEIVED });
  const createMessage = model === null ? undefined
    : async () => ({ content: [{ type: 'text', text: model }], usage: { input_tokens: 1, output_tokens: 1 } });
  const { decision, overlay } = await interpretInboundReply({
    lead, message, replyText: text, ruleCanonical, maySend, now: DECIDED,
    ruleCategory: deterministicReplyCategory,
    classify: () => classifyReplyDetailed({ lead, subject: message.subject, plainTextReply: text, apiKey: '', createMessage }),
  });
  if (execute) execute(decision, { overlay, ruleCanonical });
  finalizeReplyDecision(decision);
  const reply = {
    eventId: `gmail-reply:${messageId}`, leadId: `CE-${lead.id}`, sourceLeadId: lead.id, email: lead.email,
    company: lead.company, eventType: OBSERVER_EVENT[ruleCanonical.state] || 'needs_human_reply',
    occurredAt: RECEIVED, subject: message.subject, content: text,
    metadata: JSON.stringify({
      provider: 'gmail', gmailMessageId: messageId, gmailThreadId: 'th-1',
      canonicalState: ruleCanonical.state, reason: ruleCanonical.reason, confidence: ruleCanonical.confidence,
      evidenceSignals: ruleCanonical.signals || [], genuineHuman: ruleCanonical.genuineHuman,
      revisitDate: ruleCanonical.revisitDate || null,
    }),
  };
  return { decision, reply, activities: [reply, replyDecisionActivity(decision)] };
}

// What handlePositiveAutomation does with the decision, minus the IO.
function positivePolicy(decision, { overlay, ruleCanonical }, { offer = DENTAL_OFFER, family = '' } = {}) {
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
const routeExecution = decision => recordExecution(decision, executionForRoute(decision.route, undefined));
const humanReview = decision => recordExecution(decision, executionForRoute(ROUTE.NEEDS_HUMAN, undefined));

// The booking_link_sent a delivered warm reply writes (see deliverHardenedWarmReply).
const warmSent = (lead, decision, at = '2026-09-18T12:05:00.000Z') => ({
  eventId: `warm:${decision.decisionId}`, leadId: `CE-${lead.id}`, sourceLeadId: lead.id, email: lead.email,
  eventType: 'booking_link_sent', occurredAt: at, subject: 'Re: hello', content: 'body',
  metadata: JSON.stringify({ action: decision.policyAction, inboundMessageId: decision.inboundMessageId,
    replyDecisionId: decision.decisionId }),
});

const ownership = (lead, activities, over = {}) => deriveAutomationOwnership(lead, {
  activities, sendingEnabled: true, coldCadenceDue: true, now: LATER,
  suppressionReason: () => null, ...over,
});

// ── A. rule and final agree ─────────────────────────────────────────────────

test('A. rule and final agree: no regression in Next Action or ownership', async () => {
  const lead = dentalLead();
  const { decision, reply, activities } = await scenario({
    lead, text: 'Sounds interesting, tell me more',
    execute: (d, ctx) => { positivePolicy(d, ctx); humanReview(d); },
  });
  assert.equal(decision.finalClassificationSource, 'rule');
  const withDecision = deriveReplyOperation(lead, { activities });
  const legacy = deriveReplyOperation(lead, { activities: [reply] });
  assert.equal(withDecision.action, legacy.action);
  assert.equal(withDecision.owner, legacy.owner);
  assert.equal(withDecision.evidence.canonicalState, 'positive');
  assert.equal(withDecision.evidence.canonicalStateSource, 'reply_decision');
  assert.equal(withDecision.evidence.replyDecision.finalClassification, 'INTERESTED');
});

// ── B. model-only NOT_INTERESTED ────────────────────────────────────────────

test('B. model-only NOT_INTERESTED: display agrees with production, suppression still wins, nothing sends', async () => {
  const lead = dentalLead();
  const { decision, reply, activities } = await scenario({
    lead, text: 'We are all set with our current vendor', model: 'NOT_INTERESTED', execute: routeExecution,
  });
  assert.equal(decision.ruleCanonical.state, 'needs_human');
  assert.equal(decision.finalClassification, 'NOT_INTERESTED');
  assert.equal(decision.executionStatus, EXECUTION_STATUS.SUPPRESSED);

  // Before: the rule reading made this a human "Respond" task.
  assert.equal(deriveReplyOperation(lead, { activities: [reply] }).action, REPLY_ACTION.RESPOND);
  const op = deriveOperationalAction(lead, { activities });
  assert.equal(op.action, REPLY_ACTION.NO_ACTION_SUPPRESSED);
  assert.equal(op.owner, ACTION_OWNER.NONE);
  assert.equal(op.evidence.ruleCanonicalState, 'needs_human', 'the rule reading stays inspectable');
  assert.equal(categoryFromEvidence(lead, activities), 'negative', 'analytics agrees');

  // As the NOT_INTERESTED handler left the lead: Done, tagged, on the list.
  const handled = { ...lead, stage: 'Done', emailStatus: 'done', notes: '[REPLY: Not Interested]' };
  const suppressed = ownership(handled, activities, { suppressionReason: () => 'suppression-list' });
  assert.equal(suppressed.owner, OWNER.NONE);
  assert.equal(suppressed.blockedBy, BLOCKED_BY.SUPPRESSION);
  assert.equal(mayColdSend(suppressed).allowed, false);
  // Even without the suppression reader, the Done stage keeps cold cadence out.
  assert.equal(mayColdSend(ownership(handled, activities, { suppressionReason: null })).allowed, false);
  assert.notEqual(suppressed.owner, OWNER.HUMAN, 'not human-owned merely because the rule was uncertain');

  const next = deriveNextAction(null, handled, { now: LATER, activities, suppressionReason: () => 'suppression-list' });
  assert.notEqual(next.type, 'respond_reply');
});

test('B2. a model NOT_INTERESTED that production did not execute keeps the rule reading', async () => {
  const lead = dentalLead();
  const { activities } = await scenario({
    lead, text: 'We are all set with our current vendor', model: 'NOT_INTERESTED',
    execute: d => recordExecution(d, executionForRoute(d.route, { skipped: 'lead_row_missing' })),
  });
  const op = deriveOperationalAction(lead, { activities });
  assert.equal(op.owner, ACTION_OWNER.HUMAN, 'an unexecuted close must not remove human ownership');
  assert.equal(op.evidence.replyDecision.operationallyAccepted, false);
  assert.equal(op.evidence.replyDecision.acceptanceReason, 'negative_not_executed');
  assert.equal(ownership(lead, activities).owner, OWNER.HUMAN);
});

// ── C. model-only INTERESTED with human review ──────────────────────────────

test('C. model-only INTERESTED + HUMAN_REVIEW: interest is recognised and a human owns the next move', async () => {
  const lead = dentalLead();
  const { decision, activities } = await scenario({
    lead, text: 'I would love to learn more about this', model: 'INTERESTED',
    execute: (d, ctx) => { positivePolicy(d, ctx); humanReview(d); },
  });
  assert.equal(decision.policyAction, ACTION.HUMAN_REVIEW);
  assert.equal(decision.executionStatus, EXECUTION_STATUS.ROUTED_TO_HUMAN);
  const op = deriveOperationalAction(lead, { activities });
  assert.equal(op.action, REPLY_ACTION.CONTINUE_EVALUATION, 'the CRM reads it as interest');
  assert.equal(op.owner, ACTION_OWNER.HUMAN);
  assert.equal(op.waitingOn, WAITING_ON.US);
  assert.equal(op.evidence.replyDecision.policyAction, ACTION.HUMAN_REVIEW, 'and knows policy handed it to a human');
  assert.equal(categoryFromEvidence(lead, activities), 'positive');
  const owned = ownership({ ...lead, stage: 'Replied', emailStatus: 'replied' }, activities);
  assert.equal(owned.owner, OWNER.HUMAN);
  assert.equal(owned.sendAllowed, false);
  assert.equal(owned.automationAllowed, false, 'interest never becomes send permission');
});

test('C2. a model MEETING_REQUEST reads as book-a-call', async () => {
  const lead = dentalLead();
  const { activities } = await scenario({
    lead, text: 'I would love to learn more about this', model: 'MEETING_REQUEST',
    execute: (d, ctx) => { positivePolicy(d, ctx); humanReview(d); },
  });
  assert.equal(deriveOperationalAction(lead, { activities }).action, REPLY_ACTION.BOOK_CALL);
});

// ── D. staffing overlay ─────────────────────────────────────────────────────

test('D. the staffing overlay decision drives the operation; provenance stays inspectable', async () => {
  const lead = staffingLead();
  const { decision, activities } = await scenario({
    lead, text: 'Send me some info', model: 'QUESTION',
    execute: (d, ctx) => {
      positivePolicy(d, ctx, { offer: STAFFING_OFFER, family: 'industrial_staffing' });
      recordExecution(d, executionForDelivery(d.policyAction, { delivered: false, code: 'staffing_launch_paused' }));
    },
  });
  assert.equal(decision.finalClassification, 'SEND_INFO');
  const op = deriveOperationalAction(lead, { activities });
  assert.equal(op.evidence.canonicalState, 'positive');
  assert.equal(op.evidence.ruleCanonicalState, 'needs_human');
  assert.equal(op.evidence.replyDecision.finalClassificationSource, 'staffing_overlay');
  assert.equal(op.action, REPLY_ACTION.CONTINUE_EVALUATION);
  assert.equal(op.owner, ACTION_OWNER.HUMAN);
});

// ── E. successful auto-reply ────────────────────────────────────────────────

test('E. a sent auto-reply: interested, answered, waiting on the prospect, no Respond', async () => {
  const lead = dentalLead();
  const { decision, activities } = await scenario({
    lead, text: 'Sounds interesting, tell me more',
    execute: (d, ctx) => { positivePolicy(d, ctx); recordExecution(d, executionForDelivery(d.policyAction, { delivered: true })); },
  });
  assert.equal(decision.policyAction, ACTION.AUTO_BOOKING_RESPONSE);
  const ledger = [...activities, warmSent(lead, decision)];
  assert.ok(latestResponseAt(ledger), 'the response taxonomy says we answered');
  const op = deriveOperationalAction(lead, { activities: ledger });
  assert.equal(op.action, REPLY_ACTION.WAIT);
  assert.equal(op.waitingOn, WAITING_ON.PROSPECT);
  assert.equal(op.source, 'already_answered');
  assert.equal(op.evidence.canonicalState, 'positive', 'still an interested prospect');
  const next = deriveNextAction(null, { ...lead, stage: 'Replied', emailStatus: 'replied' }, { now: LATER, activities: ledger });
  assert.notEqual(next.type, 'respond_reply');
  assert.notEqual(next.type, 'continue_evaluation');
});

// ── F/G. blocked and failed auto-replies ────────────────────────────────────

for (const [label, code, status] of [['F. blocked', 'meeting_booked_live', 'blocked'], ['G. provider-failed', 'provider_rejected', 'failed']]) {
  test(`${label} auto-reply: interested, unanswered, human attention, not waiting on the prospect`, async () => {
    const lead = dentalLead();
    const { decision, activities } = await scenario({
      lead, text: 'Sounds interesting, tell me more',
      execute: (d, ctx) => { positivePolicy(d, ctx); recordExecution(d, executionForDelivery(d.policyAction, { delivered: false, code })); },
    });
    assert.equal(decision.executionStatus, status);
    assert.equal(latestResponseAt(activities), null, 'no answer was sent');
    const op = deriveOperationalAction(lead, { activities });
    assert.equal(op.evidence.canonicalState, 'positive');
    assert.equal(op.owner, ACTION_OWNER.HUMAN);
    assert.equal(op.waitingOn, WAITING_ON.US);
    assert.notEqual(op.waitingOn, WAITING_ON.PROSPECT);
    assert.equal(op.requiresHumanReview, true);
    assert.match(op.reason, new RegExp(`AUTO_BOOKING_RESPONSE was not sent \\(${status}: ${code}\\)`));
    assert.equal(ownership({ ...lead, stage: 'Replied', emailStatus: 'replied' }, activities).owner, OWNER.HUMAN);

    // Once a human answers in Gmail, the response taxonomy moves the ball.
    const answered = [...activities, { eventId: 'h1', sourceLeadId: lead.id, leadId: `CE-${lead.id}`,
      eventType: 'human_response_sent', occurredAt: '2026-09-18T13:00:00.000Z', metadata: '{}' }];
    assert.equal(deriveOperationalAction(lead, { activities: answered }).waitingOn, WAITING_ON.PROSPECT);
  });
}

test('F2. CRM Health reports an undelivered auto-reply until someone answers', async () => {
  const lead = dentalLead({ stage: 'Replied', emailStatus: 'replied' });
  const { activities } = await scenario({
    lead, text: 'Sounds interesting, tell me more',
    execute: (d, ctx) => { positivePolicy(d, ctx); recordExecution(d, executionForDelivery(d.policyAction, { delivered: false, code: 'provider_rejected' })); },
  });
  const finding = acts => buildCrmHealth({ leads: [lead], activities: acts, now: LATER })
    .findings.find(item => item.id === 'reply.auto_reply_not_delivered');
  const open = finding(activities);
  assert.equal(open.status, 'fail');
  assert.equal(open.affected, 1);
  assert.equal(open.sample[0].executionCode, 'provider_rejected');
  const answered = [...activities, { eventId: 'h1', sourceLeadId: lead.id, leadId: `CE-${lead.id}`,
    eventType: 'human_response_sent', occurredAt: '2026-09-18T13:00:00.000Z', metadata: '{}' }];
  assert.equal(finding(answered), undefined);
  assert.ok(buildCrmHealth({ leads: [lead], activities: answered, now: LATER }).healthy
    .includes('reply.auto_reply_not_delivered'), 'healthy once a human has answered');
});

// ── H. historical reply ─────────────────────────────────────────────────────

test('H. a historical reply with no decision keeps the legacy derivation exactly', async () => {
  const lead = dentalLead();
  const { reply } = await scenario({ lead, text: 'We are all set with our current vendor', model: 'NOT_INTERESTED' });
  const legacy = [reply];
  assert.equal(operationalReplyEvidence(legacy), legacy, 'no decision: rows are returned untouched');
  const op = deriveOperationalAction(lead, { activities: legacy });
  assert.equal(op.action, REPLY_ACTION.RESPOND);
  assert.equal(op.evidence.replyDecision, null);
  assert.equal(op.evidence.canonicalStateSource, null);
  assert.equal(effectiveReplyDecision({ activities: legacy, messageId: 'gm-1', leadId: lead.id }).source, 'legacy');
  // The guard answers from the legacy reply event when no decision exists.
  const tagged = [{ ...reply, metadata: JSON.stringify({ ...JSON.parse(reply.metadata), classification: 'QUESTION' }) }];
  assert.equal(committedInboundClassification(tagged, 'gm-1'), 'QUESTION');
});

// ── I. unsubscribe ──────────────────────────────────────────────────────────

test('I. deterministic unsubscribe outranks everything', async () => {
  const lead = staffingLead();
  const { decision, activities } = await scenario({
    lead, text: 'Please unsubscribe me', model: 'INTERESTED', execute: routeExecution,
  });
  assert.equal(decision.finalClassification, 'UNSUBSCRIBE');
  assert.equal(decision.finalClassificationSource, 'rule');
  const op = deriveOperationalAction(lead, { activities });
  assert.equal(op.action, REPLY_ACTION.NO_ACTION_SUPPRESSED);
  assert.match(op.reason, /opted out/);
  const handled = { ...lead, stage: 'Unsub', emailStatus: 'done', notes: '[REPLY: Unsubscribed]' };
  assert.equal(mayColdSend(ownership(handled, activities, { suppressionReason: () => 'suppression-list' })).allowed, false);

  // A rule opt-out is a safety fact no later decision may replace operationally.
  assert.deepEqual(operationalAcceptance({ canonicalState: 'positive', executionStatus: 'sent' }, 'negative'),
    { accepted: false, reason: 'rule_safety_state' });
  assert.deepEqual(operationalAcceptance({ canonicalState: 'needs_human' }, 'contact_change_review'),
    { accepted: false, reason: 'rule_safety_state' });
});

// ── J. manual hold ──────────────────────────────────────────────────────────

test('J. a manual hold wins whatever the final classification', async () => {
  for (const [text, model] of [['Sounds interesting, tell me more', null], ['We are all set with our current vendor', 'NOT_INTERESTED']]) {
    const lead = dentalLead({ notes: '[MANUAL HOLD]' });
    const { activities } = await scenario({ lead, text, model, execute: (d, ctx) => {
      if (d.route === ROUTE.INTERESTED) { positivePolicy(d, ctx); recordExecution(d, executionForDelivery(d.policyAction, { delivered: true })); }
      else routeExecution(d);
    } });
    const held = ownership(lead, activities);
    assert.equal(held.blockedBy, BLOCKED_BY.MANUAL_HOLD, text);
    assert.equal(mayColdSend(held).allowed, false);
  }
});

// ── K. meeting booked ───────────────────────────────────────────────────────

test('K. a booked meeting owns the lead whatever the final classification', async () => {
  const lead = dentalLead({ stage: 'Replied', emailStatus: 'replied' });
  const { activities } = await scenario({
    lead, text: 'I would love to learn more about this', model: 'INTERESTED',
    execute: (d, ctx) => { positivePolicy(d, ctx); humanReview(d); },
  });
  const owned = ownership(lead, activities, {
    callState: { status: 'scheduled', meetingAt: '2026-09-25T16:00:00.000Z' },
  });
  assert.equal(owned.owner, OWNER.MEETING);
  assert.equal(mayColdSend(owned).allowed, false);
});

// ── L. cold send safety ─────────────────────────────────────────────────────

test('L. no decision reopens cold cadence for a replied lead', async () => {
  const cases = [
    ['Sounds interesting, tell me more', null, 'Replied'],
    ['I would love to learn more about this', 'INTERESTED', 'Replied'],
    ['I would love to learn more about this', 'OUT_OF_OFFICE', 'Contacted'],
    ['We are all set with our current vendor', 'NOT_INTERESTED', 'Done'],
    ['We are all set with our current vendor', 'NEEDS_HUMAN', 'Review'],
    ['hmm ok', 'QUESTION', 'Review'],
  ];
  for (const [text, model, stage] of cases) {
    const lead = dentalLead();
    const { decision, activities } = await scenario({ lead, text, model, execute: (d, ctx) => {
      if ([ROUTE.INTERESTED, ROUTE.MEETING_REQUEST].includes(d.route)) {
        positivePolicy(d, ctx);
        recordExecution(d, d.policySend ? executionForDelivery(d.policyAction, { delivered: true }) : executionForRoute(ROUTE.NEEDS_HUMAN, undefined));
      } else if (d.route === ROUTE.QUESTION) {
        recordPolicy(d, { action: ACTION.HUMAN_REVIEW, reason: 'draft', source: POLICY_SOURCE.QUESTION_ANSWERER });
        humanReview(d);
      } else routeExecution(d);
    } });
    // The ColdEmail row as that handler leaves it; cadence "due" is the worst case.
    const row = { ...lead, stage, emailStatus: stage === 'Done' ? 'done' : 'replied',
      notes: decision.route === ROUTE.OUT_OF_OFFICE ? '[REPLY: OOO — retry in 7d] [MANUAL HOLD]' : lead.notes };
    const verdict = ownership(row, activities);
    assert.equal(mayColdSend(verdict).allowed, false, `${text} / ${model}: ${verdict.owner} ${verdict.blockedBy}`);
    assert.notEqual(verdict.owner, OWNER.COLD_AUTOMATION, `${text} / ${model}`);
  }
});

test('L2. a model OUT_OF_OFFICE without the hold it implies stays human-owned', async () => {
  const lead = dentalLead();
  const { activities } = await scenario({
    lead, text: 'I would love to learn more about this', model: 'OUT_OF_OFFICE',
    execute: d => recordExecution(d, executionForRoute(d.route, { skipped: 'lead_row_missing' })),
  });
  const op = deriveOperationalAction(lead, { activities });
  assert.equal(op.owner, ACTION_OWNER.HUMAN);
  assert.equal(op.evidence.replyDecision.acceptanceReason, 'automated_reply_not_executed');
});

// ── inbound guard ───────────────────────────────────────────────────────────

test('the guard reports production\'s decision; "already handled" stays event-based', async () => {
  const lead = dentalLead();
  const { activities } = await scenario({
    lead, text: 'We are all set with our current vendor', model: 'NOT_INTERESTED', execute: routeExecution,
  });
  assert.equal(committedInboundClassification(activities, 'gm-1'), 'NOT_INTERESTED',
    'the observer event carried no classification; the decision does');
  assert.equal(inboundAlreadyEvaluated(activities, 'gm-1'), false, 'a decision is not a gmail_reply_evaluated checkpoint');
});
