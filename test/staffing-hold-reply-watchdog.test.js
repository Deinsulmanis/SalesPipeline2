'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withStaffingHold, staffingHoldStatus, staffingHoldInconsistencies } = require('../integrations/staffing-hold');
const { queueEligibility } = require('../integrations/outreach-queue');
const { responseNeed, createReplyDecision, planReplyRoute, ROUTE,
  recordExecution, finalizeReplyDecision, EXECUTION_STATUS } = require('../integrations/reply-decision');
const { orphanedHumanReplies, watchdogAlertEvent } = require('../integrations/reply-watchdog');

const reviewedAt = '2026-10-09T04:00:00.000Z';
const reviewTag = fit => `[STAFFING_REVIEW_V1 fit=${fit};personalization=FAILED;routing_ready=false]`;
const held = (reason, fit = 'ICP_UNRESOLVED', manual = false) => ({
  id: 'lead-1', company: 'Example Staffing', email: 'owner@example.com',
  leadNiche: 'industrial_staffing', campaign: 'Industrial Staffing Agency', stage: 'Import',
  notes: manual ? '[MANUAL HOLD]' : '', emailStatus: '', emailStep: '', lastEmailedAt: '',
  campaign_notes: withStaffingHold(reviewTag(fit), { reason, explanation: `${reason} is supported by the source`,
    evidence: [{ source: 'https://example.com/service', detail: 'First-party service description' }],
    reviewedAt, reviewSource: 'held_audit_v1', temporary: true, couldBecomeEligible: true }),
});

test('specific staffing reasons survive canonical campaign_notes serialization', () => {
  for (const [reason, fit] of [
    ['NON_INDUSTRIAL_STAFFING', 'ICP_REJECT'], ['ICP_CONFLICT', 'ICP_UNRESOLVED'],
    ['ICP_UNCONFIRMED', 'ICP_UNRESOLVED'], ['WEBSITE_UNAVAILABLE', 'ICP_UNRESOLVED'],
    ['PERSONALIZATION_AUDIT_FAILED', 'ICP_CONFIRMED'],
    ['DUPLICATE_OPENING', 'ICP_CONFIRMED'], ['MANUAL_HOLD', 'ICP_CONFIRMED'],
  ]) {
    const lead = held(reason, fit, reason === 'MANUAL_HOLD');
    assert.equal(staffingHoldStatus(lead).reason, reason);
    assert.equal(staffingHoldStatus(lead).evidence[0].source, 'https://example.com/service');
    assert.deepEqual(staffingHoldInconsistencies(lead), []);
  }
});

test('website failure does not reject and a hold never admits queueing', () => {
  const lead = held('WEBSITE_UNAVAILABLE');
  assert.equal(staffingHoldStatus(lead).reason, 'WEBSITE_UNAVAILABLE');
  assert.match(lead.campaign_notes, /fit=ICP_UNRESOLVED/);
  assert.equal(queueEligibility(lead, { leads: [lead] }).ok, false);
  assert.equal(queueEligibility(lead, { leads: [lead] }).reason, 'staffing hold requires explicit reviewed release');
  assert.deepEqual(staffingHoldInconsistencies({ ...lead,
    campaign_notes: lead.campaign_notes.replace('routing_ready=false', 'routing_ready=true') }),
  ['held lead marked routing ready']);
});

test('ScaleLab read model and drawer show hold detail without Jole hold data', () => {
  const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(server, /const \{[^}]*resolveLeadClient[^}]*\} = require\('\.\/integrations\/clients\/ownership'\)/);
  assert.match(server, /resolveLeadClient\(lead\)\.clientId === DEFAULT_CLIENT_ID[\s\S]*?row\.staffingHoldReason = hold\?\.reason/);
  assert.match(server, /staffingHold: String\(lead\.leadNiche[\s\S]*?DEFAULT_CLIENT_ID \? staffingHoldStatus\(lead\) : null/);
  for (const label of ['Hold reason', 'Why held', 'Fit', 'Personalization', 'Routing ready', 'Manual hold']) {
    assert.match(html, new RegExp(`label: '${label}'`));
  }
  assert.match(html, /Hold: \$\{esc\(l\.staffingHoldReason/);
});

test('response need is separate from classification confidence and send safety', () => {
  for (const body of ['Can you send pricing?', 'What exactly do you do?', 'How does this work?',
    'Who have you worked with?', 'Send me more info.', 'Talk to John instead.',
    'What does qualified mean?', 'How much per meeting?', 'Call me next week.']) {
    const need = responseNeed({ classification: 'NEEDS_HUMAN', replyText: body,
      rule: { confidence: 'low', genuineHuman: true } });
    assert.equal(need.requiresResponse, true, body);
    assert.equal(need.isHumanMessage, true, body);
    assert.equal(need.confidence, 0.4, body);
  }
  assert.equal(responseNeed({ classification: 'OUT_OF_OFFICE' }).requiresResponse, false);
  assert.equal(responseNeed({ classification: 'UNSUBSCRIBE' }).requiresResponse, false);
  assert.equal(responseNeed({ classification: 'NOT_INTERESTED' }).requiresResponse, false);
  assert.equal(responseNeed({ classification: 'NEEDS_HUMAN',
    rule: { genuineHuman: true, revisitDate: '2026-11-03' } }).requiresResponse, false);
  const invite = responseNeed({ classification: 'NEEDS_HUMAN', replyText: 'Accepted: Discovery Call invitation' });
  assert.equal(invite.intent, 'meeting_request');
  assert.equal(invite.requiresResponse, true);
  assert.equal(invite.acceptedInvite, true);
  assert.equal(responseNeed({ classification: 'NEEDS_HUMAN', replyText: 'Accepted: Discovery Call invitation',
    rule: { genuineHuman: false } }).requiresResponse, false);
});

test('unclear fresh human message in check-only reaches high-priority human review', () => {
  const decision = createReplyDecision({ lead: { id: 'lead-1', email: 'owner@example.com' },
    message: { messageId: 'gm-1' }, classifier: { classification: 'NEEDS_HUMAN' },
    ruleCanonical: { genuineHuman: true, confidence: 'low' }, replyText: 'Could we talk about this?' });
  planReplyRoute(decision, { maySend: false, reviewIfNoSend: true });
  assert.equal(decision.route, ROUTE.HISTORICAL_REVIEW);
  assert.equal(decision.safeToAutoReply, false);
  recordExecution(decision, { executedAction: 'HUMAN_REVIEW', status: EXECUTION_STATUS.ROUTED_TO_HUMAN });
  finalizeReplyDecision(decision);
  assert.equal(decision.responseDisposition, 'waiting-for-human');
  assert.equal(decision.escalationPriority, 'high');
  const unresolved = createReplyDecision({ lead: { id: 'lead-2' }, message: { messageId: 'gm-2' },
    classifier: { classification: 'NEEDS_HUMAN' }, ruleCanonical: { genuineHuman: true } });
  recordExecution(unresolved, { status: EXECUTION_STATUS.UNREPORTED });
  finalizeReplyDecision(unresolved);
  assert.equal(unresolved.responseDisposition, null);
});

const lead = (id, clientId = 'scalelab', extras = {}) => ({ id, company: `${clientId} company`,
  email: `${id}@example.com`, clientId, leadNiche: clientId === 'jole' ? 'enterprise_staffing' : 'industrial_staffing',
  stage: 'Contacted', notes: '', ...extras });
const inbound = (id, leadId, receivedAt = '2026-10-09T04:00:00.000Z', type = 'needs_human_reply') => ({
  eventId: `gmail-reply:${id}`, sourceLeadId: leadId, leadId: `CE-${leadId}`,
  eventType: type, occurredAt: receivedAt,
  metadata: JSON.stringify({ gmailMessageId: id, gmailThreadId: `thread-${id}`,
    senderInboxId: 'primary', genuineHuman: true, canonicalState: 'needs_human' }),
});

test('watchdog flags genuine orphan once across restarts, scoped to its client and sender', () => {
  const row = inbound('gm-1', 'scale-1');
  const inputs = { leads: [lead('scale-1'), lead('jole-1', 'jole')],
    activities: [row], now: '2026-10-09T04:11:00.000Z' };
  const first = orphanedHumanReplies(inputs);
  assert.equal(first.length, 1);
  assert.equal(first[0].clientId, 'scalelab');
  assert.equal(first[0].senderInboxId, 'primary');
  const alert = watchdogAlertEvent(first[0]);
  const second = orphanedHumanReplies({ ...inputs, activities: [row, alert] });
  assert.equal(second.length, 1);
  assert.equal(second[0].alreadyAlerted, true);
  assert.equal(second[0].alertId, first[0].alertId);
  assert.equal(orphanedHumanReplies({ ...inputs, now: '2026-10-09T04:05:00.000Z' }).length, 0);
});

test('watchdog respects manual response, human review, automated reply and unsubscribe', () => {
  const row = inbound('gm-1', 'scale-1');
  const answered = { eventId: 'human-out-1', sourceLeadId: 'scale-1', eventType: 'human_response_sent',
    occurredAt: '2026-10-09T04:02:00.000Z', metadata: JSON.stringify({ gmailThreadId: 'thread-gm-1' }) };
  const options = { leads: [lead('scale-1')], now: '2026-10-09T04:20:00.000Z' };
  assert.equal(orphanedHumanReplies({ ...options, activities: [row, answered] }).length, 0);
  assert.equal(orphanedHumanReplies({ ...options, activities: [inbound('gm-2', 'scale-1', undefined, 'out_of_office_reply')] }).length, 0);
  assert.equal(orphanedHumanReplies({ ...options, activities: [inbound('gm-3', 'scale-1', undefined, 'unsubscribe_reply')] }).length, 0);
  const reviewLead = lead('scale-1', 'scalelab', { stage: 'Review', notes: '[REPLY: Needs human] [REPLY PRIORITY: HIGH]' });
  const decision = { eventId: 'reply-decision:scale-1:gm-1', sourceLeadId: 'scale-1',
    eventType: 'reply_decision_recorded', occurredAt: '2026-10-09T04:01:00.000Z',
    metadata: JSON.stringify({ leadId: 'scale-1', inboundMessageId: 'gm-1',
      finalClassification: 'NEEDS_HUMAN', executionStatus: 'routed_to_human' }) };
  assert.equal(orphanedHumanReplies({ ...options, leads: [reviewLead], activities: [row, decision] }).length, 0);
  const failed = { ...decision, eventId: 'failed', metadata: JSON.stringify({ leadId: 'scale-1',
    inboundMessageId: 'gm-1', finalClassification: 'NEEDS_HUMAN', executionStatus: 'failed' }) };
  assert.equal(orphanedHumanReplies({ ...options, leads: [reviewLead], activities: [row, failed] }).length, 1);
});

test('later same-thread human review covers an earlier inbound only with matching sender evidence', () => {
  const first = inbound('gm-1', 'scale-1');
  const second = { ...inbound('gm-2', 'scale-1', '2026-10-09T04:02:00.000Z'),
    metadata: JSON.stringify({ gmailMessageId: 'gm-2', gmailThreadId: 'thread-gm-1',
      senderInboxId: 'primary', genuineHuman: true, canonicalState: 'needs_human' }) };
  const review = { eventId: 'reply-decision:scale-1:gm-2', sourceLeadId: 'scale-1',
    eventType: 'reply_decision_recorded', occurredAt: '2026-10-09T04:03:00.000Z',
    metadata: JSON.stringify({ leadId: 'scale-1', inboundMessageId: 'gm-2',
      inboundThreadId: 'thread-gm-1', receivedAt: second.occurredAt,
      executionStatus: 'routed_to_human', responseDisposition: 'waiting-for-human' }) };
  const options = { leads: [lead('scale-1')], now: '2026-10-09T04:20:00.000Z' };
  assert.equal(orphanedHumanReplies({ ...options, activities: [first, second, review] }).length, 0);
  assert.equal(orphanedHumanReplies({ ...options, activities: [first, review] }).length, 1);
  const otherSender = { ...second, metadata: JSON.stringify({ ...JSON.parse(second.metadata), senderInboxId: 'secondary' }) };
  assert.equal(orphanedHumanReplies({ ...options, activities: [first, otherSender, review] }).length, 1);
  const noReview = { ...review, metadata: JSON.stringify({ ...JSON.parse(review.metadata),
    responseDisposition: null }) };
  assert.equal(orphanedHumanReplies({ ...options, activities: [first, second, noReview] }).length, 1);
});
