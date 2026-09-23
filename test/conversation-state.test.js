'use strict';

// Phase 1: the deterministic, read-only conversation state. Every scenario is
// built from ledger rows shaped exactly as production writes them, and reply
// decisions are created with production's own reply-decision functions.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildConversationState, normalizeConversationEvidence, EVIDENCE_PRECEDENCE } = require('../integrations/conversation-state');
const {
  indexConversationEvidence, selectConversationEvidence, loadHumanReplyTexts,
} = require('../integrations/conversation-evidence');
const {
  createReplyDecision, planReplyRoute, recordPolicy, recordExecution, finalizeReplyDecision,
  replyDecisionActivity, EXECUTION_STATUS,
} = require('../integrations/reply-decision');
const { ACTION } = require('../integrations/reply-response-policy');
const { STAFFING_CAMPAIGN } = require('../integrations/staffing-campaign');
const {
  STAFFING_QUALIFY_QUESTION, STAFFING_SEND_INFO_REPLY, staffingQualifiedReply,
} = require('../integrations/staffing-reply-policy');
const { BOOKING_URL } = require('../booking');

const root = path.join(__dirname, '..');
const readSource = file => fs.readFileSync(path.join(root, file), 'utf8').split('\r\n').join('\n');

const NOW = '2026-09-22T18:00:00.000Z';
const at = (day, hour = 15, minute = 0) =>
  `2026-09-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`;

const staffingLead = (over = {}) => ({
  id: 'S1', email: 'owner@harbourstaffing.test', company: 'Harbour Staffing', contactName: 'Alex Harbour',
  campaign: STAFFING_CAMPAIGN.name, intendedCampaignVersion: STAFFING_CAMPAIGN.id,
  emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId, leadNiche: 'industrial_staffing',
  stage: 'Replied', emailStatus: 'replied', emailStep: '1', notes: '', senderInboxId: 'primary', ...over,
});
const dentalLead = (over = {}) => ({
  id: 'D1', email: 'front@clinic.test', company: 'Harbour Dental', contactName: 'Sam Clinic',
  leadNiche: 'dental', emailTemplateId: 'dental-guarantee-v1', campaign: 'Dental V3',
  intendedCampaignVersion: 'dental_v3_pay_per_booking',
  stage: 'Replied', emailStatus: 'replied', emailStep: '1', notes: '', senderInboxId: 'primary', ...over,
});
const board = (lead, over = {}) => ({
  id: `CE-${lead.id}`, type: '', first: 'Alex', last: 'Harbour', company: lead.company, email: lead.email,
  stage: 'hot', priority: '', followup: '', notes: '', created: at(15), meetingAt: '', outcome: '', ...over,
});

const EMAIL_1 = "Hi Alex,\n\nYour warehouse team places CDL drivers for local manufacturers.\n\nWe help industrial staffing agencies turn that exact market into qualified employer meetings — and we get paid based on the meetings we generate.\n\nWorth seeing how we'd do this for Harbour Staffing?\n\n— Deins";
const EMAIL_3 = 'Hi Alex,\n\nQuick question —\n\nis bringing in more employer accounts something Harbour Staffing is focused on right now?';

// ── ledger rows, shaped as production writes them ────────────────────────────

const coldStep = (lead, step, when, body = EMAIL_1, meta = {}) => ({
  eventId: `gmail:c${step}-${lead.id}`, leadId: `CE-${lead.id}`, sourceLeadId: lead.id, email: lead.email,
  company: lead.company, eventType: step === 1 ? 'initial_email_sent' : 'follow_up_sent', occurredAt: when,
  subject: step === 1 ? 'employer accounts' : '', content: body,
  metadata: JSON.stringify({ step, gmailMessageId: `c${step}-${lead.id}`, gmailThreadId: 't1', senderInboxId: 'primary', ...meta }),
});
const inbound = (lead, id, when, text, { eventType = 'positive_reply', canonicalState = 'positive', reason = null, genuineHuman = true, extra = {} } = {}) => ({
  eventId: `gmail-reply:${id}`, leadId: `CE-${lead.id}`, sourceLeadId: lead.id, email: lead.email, company: lead.company,
  eventType, occurredAt: when, subject: 'Re: employer accounts', content: text,
  metadata: JSON.stringify({ provider: 'gmail', senderInboxId: 'primary', gmailMessageId: id, gmailThreadId: 't1',
    from: extra.from || lead.email, receivedAt: when, canonicalState, reason, genuineHuman, ...extra }),
});
const warmReply = (lead, action, inboundId, when, body, meta = {}) => ({
  eventId: `reply-action:${action}:${inboundId}`, leadId: `CE-${lead.id}`, sourceLeadId: lead.id, email: lead.email,
  company: lead.company, eventType: 'booking_link_sent', occurredAt: when, subject: 'Re: employer accounts', content: body,
  metadata: JSON.stringify({ actionId: `reply-action:${action}:${inboundId}`, action, classification: 'INTERESTED',
    senderInboxId: 'primary', gmailMessageId: `w-${inboundId}`, gmailThreadId: 't1', inboundMessageId: inboundId, ...meta }),
});
const humanReply = (lead, id, when, meta = {}, content = '') => ({
  eventId: `gmail-outbound:${id}`, leadId: `CE-${lead.id}`, sourceLeadId: lead.id, email: lead.email, company: lead.company,
  eventType: 'human_response_sent', occurredAt: when, subject: 'Re: employer accounts', content,
  metadata: JSON.stringify({ provider: 'gmail', direction: 'outbound', actor: 'human', trigger: 'gmail_outbound_ingestion',
    isResponseToInbound: true, gmailMessageId: id, gmailThreadId: 't1', senderInboxId: 'primary', ...meta }),
});
const evaluatedRow = (lead, messageId, classification, replyDecisionId) => ({
  eventId: `gmail-evaluated:primary:${messageId}`, leadId: `CE-${lead.id}`, sourceLeadId: lead.id, email: lead.email,
  company: lead.company, eventType: 'gmail_reply_evaluated', occurredAt: at(22, 1), subject: '', content: '',
  metadata: JSON.stringify({ sourceEventId: `gmail-reply:${messageId}`, gmailMessageId: messageId, senderInboxId: 'primary',
    classification, ...(replyDecisionId ? { replyDecisionId } : {}) }),
});
const callEvent = (lead, eventType, when, meetingAt, trigger = 'google_calendar', extra = {}) => ({
  eventId: `call:${eventType}:${when}`, leadId: `CE-${lead.id}`, sourceLeadId: lead.id, email: lead.email, company: lead.company,
  eventType, occurredAt: when, subject: '', content: '',
  metadata: JSON.stringify({ trigger, meetingAt, provider: trigger === 'google_calendar' ? 'google_calendar' : undefined, ...extra }),
});

/** A reply_decision_recorded row made by production's own decision code. */
function decisionRow(lead, messageId, occurredAt, {
  classification, source = 'rule', overlay = null, policy = null, execution = null, ruleCanonical = {},
}) {
  const decision = createReplyDecision({
    lead, message: { messageId, threadId: 't1', occurredAt },
    ruleCanonical: { state: 'positive', confidence: 'high', signals: [], ...ruleCanonical },
    classifier: { classification, source, ruleClassification: classification },
    overlay, now: new Date(occurredAt),
  });
  planReplyRoute(decision, { maySend: true });
  if (policy) recordPolicy(decision, policy);
  if (execution) recordExecution(decision, { ...execution, now: new Date(occurredAt) });
  finalizeReplyDecision(decision);
  return replyDecisionActivity(decision, { company: lead.company });
}

const build = (input) => buildConversationState({ now: NOW, suppressedEmails: new Set(), ...input });
const codes = state => state.evidenceWarnings.map(item => item.code);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

// ── 1. empty ──────────────────────────────────────────────────────────────

test('1. empty/new conversation: nothing is invented', () => {
  const lead = staffingLead({ stage: 'Queued', emailStatus: '', emailStep: '0' });
  const state = build({ lead, activities: [] });
  assert.equal(state.version, 'conversation_state_v1');
  assert.equal(state.asOf, NOW);
  assert.deepEqual(state.turns, []);
  assert.equal(state.qualification.status, 'not_started');
  for (const slot of ['roles', 'industries', 'employerTypes', 'geography', 'employerAcquisitionPriority']) {
    assert.equal(state.qualification.slots[slot].status, 'unknown', slot);
    assert.equal(state.qualification.slots[slot].value, null, slot);
  }
  assert.deepEqual(state.questions, []);
  assert.deepEqual(state.objections, []);
  assert.equal(state.booking.linkSent.status, 'not_observed');
  assert.equal(state.booking.call.status, 'none');
  assert.equal(state.responseState.answered, 'no_prospect_message');
  // Reply operations says `investigate` for every never-replied lead; the same
  // leadHasReply guard ownership applies keeps that from reading as human work.
  assert.equal(state.operational.action, 'investigate');
  assert.equal(state.responseState.waitingOn, 'no_reply_yet');
  assert.equal(state.responseState.waitingOnSource, 'ownership_investigate_guard');
  assert.equal(state.responseState.operationalAction, null);
  assert.equal(state.terminalState.blockedBy, null);
  assert.equal(state.ownership.owner, 'cold_automation');
  assert.equal(state.sources.modelOutputsUsed, false);
});

// ── 2-6. turns ────────────────────────────────────────────────────────────

test('2. one interested inbound becomes a prospect turn that waits on us', () => {
  const lead = staffingLead();
  const state = build({ lead, activities: [
    coldStep(lead, 1, at(18)),
    inbound(lead, 'r1', at(19), 'Sounds good, tell me more', { reason: 'expressed_interest' }),
  ] });
  assert.deepEqual(state.turns.map(turn => `${turn.direction}:${turn.actor}`), ['outbound:automation', 'inbound:prospect']);
  const reply = state.turns[1];
  assert.equal(reply.messageId, 'r1');
  assert.equal(reply.threadId, 't1');
  assert.equal(reply.content, 'Sounds good, tell me more');
  assert.equal(reply.contentSource, 'ledger_inbound_text');
  assert.equal(reply.canonicalState, 'positive');
  assert.equal(state.latest.prospectMessage.messageId, 'r1');
  assert.equal(state.responseState.answered, 'no');
  assert.equal(state.responseState.waitingOn, 'waiting_on_us');
  assert.equal(state.ownership.owner, 'human');
});

test('3. multiple inbound turns stay separate, ordered, one per Gmail message', () => {
  const lead = staffingLead();
  const state = build({ lead, activities: [
    coldStep(lead, 1, at(18)),
    inbound(lead, 'r1', at(19), 'Interested'),
    inbound(lead, 'r2', at(20), 'Also — do you cover Alberta?', { eventType: 'question_reply', canonicalState: 'needs_human', reason: 'question_or_objection' }),
  ] });
  assert.deepEqual(state.turns.filter(turn => turn.direction === 'inbound').map(turn => turn.messageId), ['r1', 'r2']);
  assert.deepEqual(state.turns.map(turn => turn.index), [0, 1, 2]);
  assert.equal(state.latest.inbound.messageId, 'r2');
});

test('4. an automated warm reply is an automation turn linked to the message it answered', () => {
  const lead = staffingLead({ notes: '[STAFFING QUALIFY ASKED] [REPLY: Interested]' });
  const state = build({ lead, activities: [
    coldStep(lead, 1, at(18)),
    inbound(lead, 'r1', at(19), "I'm interested"),
    warmReply(lead, ACTION.AUTO_STAFFING_QUALIFY_QUESTION, 'r1', at(19, 16), STAFFING_QUALIFY_QUESTION),
  ] });
  const reply = state.turns.find(turn => turn.actor === 'automation' && turn.eventType === 'booking_link_sent');
  assert.equal(reply.actionType, ACTION.AUTO_STAFFING_QUALIFY_QUESTION);
  assert.equal(reply.inReplyToMessageId, 'r1');
  assert.equal(reply.contentSource, 'ledger_sent_body');
  assert.equal(state.responseState.answered, 'yes');
  assert.equal(state.responseState.answeredBy, 'automation');
  assert.equal(state.qualification.status, 'awaiting_answer');
  assert.equal(state.qualification.slots.roles.askedBy[0].actionType, ACTION.AUTO_STAFFING_QUALIFY_QUESTION);
  assert.equal(state.booking.linkSent.status, 'not_observed', 'the qualify question carries no booking link');
});

test('5. a human reply is a human turn, a takeover, and the staffing automation hold', () => {
  const lead = staffingLead();
  const state = build({ lead, activities: [
    coldStep(lead, 1, at(18)),
    inbound(lead, 'r1', at(19), 'Interested — who runs this?'),
    humanReply(lead, 'h1', at(19, 17)),
  ] });
  const human = state.turns.find(turn => turn.actor === 'human');
  assert.equal(human.direction, 'outbound');
  assert.equal(human.messageId, 'h1');
  assert.equal(state.ownership.humanTakeover.value, true);
  assert.equal(state.ownership.humanTakeover.lastHumanOutboundAt, at(19, 17));
  assert.deepEqual(state.ownership.staffingAutomationHold, {
    applies: true, code: 'human_response_observed', reason: `a human response was already observed at ${at(19, 17)}`,
  });
  assert.equal(state.responseState.answeredBy, 'human');
  assert.equal(state.latest.humanOutbound.messageId, 'h1');
});

test('6. a proven human reply without recoverable text is reported, never invented', () => {
  const lead = staffingLead();
  const rows = [inbound(lead, 'r1', at(19), 'Interested'), humanReply(lead, 'h1', at(19, 17))];
  const state = build({ lead, activities: rows });
  const human = state.turns.find(turn => turn.actor === 'human');
  assert.equal(human.contentAvailable, false);
  assert.equal(human.content, '');
  assert.equal(human.contentUnavailableReason, 'human_reply_body_not_persisted');
  assert.ok(codes(state).includes('human_reply_text_unavailable'));

  // Provider text supplied by the loader is used, with its source.
  const withText = build({ lead, activities: rows,
    messageTexts: { h1: { text: 'Happy to walk you through it — what markets do you cover?', source: 'gmail_provider_message' } } });
  const recovered = withText.turns.find(turn => turn.actor === 'human');
  assert.equal(recovered.contentAvailable, true);
  assert.equal(recovered.contentSource, 'gmail_provider_message');
  assert.ok(!codes(withText).includes('human_reply_text_unavailable'));

  // A CRM "log response" note is an operator note, not provider text.
  const logged = build({ lead, activities: [inbound(lead, 'r1', at(19), 'Interested'), {
    eventId: 'human-response:abc', leadId: 'CE-S1', sourceLeadId: '', email: lead.email, eventType: 'human_response_sent',
    occurredAt: at(19, 18), subject: 'Response sent to prospect', content: 'Called them, sending deck',
    metadata: JSON.stringify({ direction: 'outbound', actor: 'human', trigger: 'crm_log_response' }),
  }] });
  assert.equal(logged.turns.find(turn => turn.actor === 'human').contentSource, 'operator_logged_note');
});

// ── 7-10. qualification ───────────────────────────────────────────────────

test('7. a delivered qualification question is the ask, with its evidence', () => {
  const lead = staffingLead({ notes: '[STAFFING INFO SENT] [STAFFING QUALIFY ASKED]' });
  const state = build({ lead, activities: [
    inbound(lead, 'r1', at(19), 'Send me some info'),
    warmReply(lead, ACTION.AUTO_STAFFING_SEND_INFO, 'r1', at(19, 16), STAFFING_SEND_INFO_REPLY),
  ] });
  assert.equal(state.qualification.status, 'awaiting_answer');
  assert.equal(state.qualification.asked.length, 1);
  assert.equal(state.qualification.asked[0].actionType, ACTION.AUTO_STAFFING_SEND_INFO);
  assert.equal(state.qualification.slots.roles.status, 'unknown');
  assert.ok(!codes(state).includes('info_sent_tag_without_delivery'));
});

test('8. a qualification answer fills slots with the message that proves them', () => {
  const lead = staffingLead({ notes: '[STAFFING QUALIFIED] [STAFFING QUALIFY RECEIVED] [STAFFING QUALIFY ASKED]' });
  const answer = 'We place welders and machinists around Houston for manufacturers';
  const state = build({ lead, activities: [
    inbound(lead, 'r1', at(18), "I'm interested"),
    warmReply(lead, ACTION.AUTO_STAFFING_QUALIFY_QUESTION, 'r1', at(18, 16), STAFFING_QUALIFY_QUESTION),
    inbound(lead, 'r2', at(19), answer),
    decisionRow(lead, 'r2', at(19), {
      classification: 'INTERESTED',
      overlay: { overlay: true, classification: 'STAFFING_QUALIFICATION', fit: 'clear', canonical: { state: 'positive' } },
      policy: { action: ACTION.AUTO_STAFFING_QUALIFIED, send: true, reason: 'fits', source: 'reply_response_policy' },
      execution: { executedAction: ACTION.AUTO_STAFFING_QUALIFIED, status: EXECUTION_STATUS.SENT },
    }),
    warmReply(lead, ACTION.AUTO_STAFFING_QUALIFIED, 'r2', at(19, 16), staffingQualifiedReply({ company: 'Harbour Staffing', bookingUrl: BOOKING_URL })),
  ] });
  const roles = state.qualification.slots.roles;
  assert.equal(roles.status, 'filled');
  assert.deepEqual(roles.value, ['welders', 'machinists']);
  assert.equal(roles.evidence[0].messageId, 'r2');
  assert.equal(roles.evidence[0].source, 'prospect_inbound');
  assert.equal(roles.evidence[0].afterAsk, true);
  assert.equal(roles.evidence[0].productionFit, 'clear');
  assert.equal(state.qualification.slots.industries.status, 'filled');
  assert.ok(state.qualification.slots.geography.value.some(value => value.includes('houston')));
  assert.equal(state.qualification.status, 'qualified');
  assert.equal(state.qualification.productionQualified.source, 'delivered_staffing_qualified_reply');
  assert.equal(state.booking.linkSent.status, 'sent');
});

test('9. a legacy qualified tag proves qualification but never fabricates a slot value', () => {
  const lead = staffingLead({ notes: '[STAFFING QUALIFIED] [STAFFING QUALIFY RECEIVED]' });
  const state = build({ lead, activities: [] });
  assert.equal(state.qualification.status, 'qualified_legacy');
  assert.equal(state.qualification.productionQualified.source, 'legacy_tag');
  for (const slot of ['roles', 'industries', 'employerTypes', 'geography']) {
    assert.equal(state.qualification.slots[slot].status, 'legacy_unknown_value', slot);
    assert.equal(state.qualification.slots[slot].value, null, slot);
  }
  assert.ok(codes(state).includes('qualified_tag_without_delivery'));
  assert.ok(state.legacyTags.some(tag => tag.tag === '[STAFFING QUALIFIED]' && /productionQualified/.test(tag.meaning)));
});

test('10. the same slot across several messages keeps every piece of evidence', () => {
  const lead = staffingLead({ notes: '[STAFFING QUALIFY ASKED]' });
  const state = build({ lead, activities: [
    inbound(lead, 'r1', at(17), "I'm interested"),
    warmReply(lead, ACTION.AUTO_STAFFING_QUALIFY_QUESTION, 'r1', at(17, 16), STAFFING_QUALIFY_QUESTION),
    inbound(lead, 'r2', at(18), 'Mostly welders'),
    inbound(lead, 'r3', at(19), 'Forgot to say — forklift operators too'),
  ] });
  const roles = state.qualification.slots.roles;
  assert.equal(roles.status, 'filled');
  assert.deepEqual(roles.evidence.map(item => item.messageId), ['r2', 'r3']);
  assert.deepEqual(roles.value, ['welders', 'forklift', 'operators']);
  assert.equal(roles.latestEvidenceMessageId, 'r3');
});

test('an unsolicited market mention is "mentioned", not a filled answer', () => {
  const lead = staffingLead();
  const state = build({ lead, activities: [inbound(lead, 'r1', at(19), 'We staff welders for fabrication shops — is this legit?')] });
  assert.equal(state.qualification.slots.roles.status, 'mentioned');
  assert.equal(state.qualification.slots.roles.evidence[0].afterAsk, false);
  assert.equal(state.qualification.status, 'not_started');
});

test('stored research never fills a qualification slot', () => {
  const lead = staffingLead();
  const state = build({ lead, activities: [
    coldStep(lead, 1, at(18), EMAIL_1, { personalization: { icpFit: 'FIT', facts: [{ kind: 'role', value: 'CDL drivers' }] } }),
  ] });
  assert.equal(state.research.provenance, 'stored_personalization_research');
  assert.equal(state.research.icpFit, 'FIT');
  assert.deepEqual(state.research.facts, [{ kind: 'role', value: 'CDL drivers' }]);
  assert.equal(state.research.openingLine, 'Your warehouse team places CDL drivers for local manufacturers.');
  assert.equal(state.research.openingLineSource, 'delivered_step1_body');
  assert.equal(state.qualification.slots.roles.status, 'unknown');
});

test('cold Email 3 is recorded as the employer-acquisition-priority ask; the answer stays unknown', () => {
  const lead = staffingLead({ emailStep: '3' });
  const state = build({ lead, activities: [
    coldStep(lead, 1, at(10)), coldStep(lead, 2, at(13), 'Hi Alex, ...'), coldStep(lead, 3, at(18), EMAIL_3),
    inbound(lead, 'r1', at(19), 'Yes it is'),
  ] });
  const priority = state.qualification.slots.employerAcquisitionPriority;
  assert.equal(priority.askedBy.length, 1);
  assert.equal(priority.askedBy[0].actionType, 'cold_step_3');
  assert.deepEqual(priority.repliesAfterAsk, ['r1']);
  assert.equal(priority.status, 'unknown');
  assert.equal(priority.value, null);
});

// ── 11-13. questions and objections ───────────────────────────────────────

test('11. a prospect question gets a deterministic topic and its handling', () => {
  const lead = staffingLead();
  const state = build({ lead, activities: [
    inbound(lead, 'r1', at(19), 'How much does this cost per meeting?', { eventType: 'question_reply', canonicalState: 'needs_human', reason: 'question_or_objection' }),
    decisionRow(lead, 'r1', at(19), {
      classification: 'QUESTION', ruleCanonical: { state: 'needs_human', reason: 'question_or_objection', signals: ['pricing'] },
      policy: { action: ACTION.HUMAN_REVIEW, send: false, reason: 'pricing is not configured', source: 'question_answerer' },
      execution: { executedAction: ACTION.HUMAN_REVIEW, status: EXECUTION_STATUS.ROUTED_TO_HUMAN, effects: ['draft_queued'] },
    }),
  ] });
  assert.equal(state.questions.length, 1);
  assert.equal(state.questions[0].topic, 'pricing');
  assert.equal(state.questions[0].evidenceMessageId, 'r1');
  assert.equal(state.questions[0].status, 'handed_off');
  assert.equal(state.questions[0].askedBy, 'prospect');
});

test('12. a question later answered is "responded", with who responded', () => {
  const lead = staffingLead();
  const state = build({ lead, activities: [
    inbound(lead, 'r1', at(19), 'How does it work?', { eventType: 'question_reply', canonicalState: 'needs_human', reason: 'question_or_objection' }),
    humanReply(lead, 'h1', at(20)),
  ] });
  const question = state.questions.find(item => item.topic === 'how_it_works');
  assert.equal(question.status, 'responded');
  assert.equal(question.respondedBy, 'human');
  assert.equal(question.responseAt, at(20));
});

test('13. an objection is tracked; a response makes it responded, later interest supersedes it', () => {
  const lead = staffingLead();
  const objection = inbound(lead, 'r1', at(18), 'We already have an internal BD team that handles employers',
    { eventType: 'needs_human_reply', canonicalState: 'needs_human', reason: 'already_handled' });
  const open = build({ lead, activities: [objection] });
  assert.equal(open.objections.length, 1);
  assert.equal(open.objections[0].type, 'existing_provider');
  assert.match(open.objections[0].source, /^not_qualified_markers\./);
  assert.equal(open.objections[0].status, 'open');

  const responded = build({ lead, activities: [objection, humanReply(lead, 'h1', at(19))] });
  assert.equal(responded.objections[0].status, 'responded');

  const superseded = build({ lead, activities: [objection, inbound(lead, 'r2', at(20), 'Actually, sounds good — tell me more')] });
  assert.equal(superseded.objections[0].status, 'superseded');
  assert.equal(superseded.objections[0].supersededBy, 'r2');
});

test('timing, candidate-side and referral evidence are read from existing rules only', () => {
  const lead = staffingLead();
  const timing = build({ lead, activities: [inbound(lead, 'r1', at(19), 'Circle back in November',
    { eventType: 'needs_human_reply', canonicalState: 'needs_human', reason: 'deferred_timing', extra: { revisitDate: '2026-11-02T16:00:00.000Z' } })] });
  assert.equal(timing.objections[0].type, 'timing');
  assert.equal(timing.objections[0].revisitDate, '2026-11-02T16:00:00.000Z');

  const candidate = build({ lead, activities: [inbound(lead, 'r1', at(19), 'I am looking for a job as a welder', { eventType: 'needs_human_reply', canonicalState: 'needs_human' })] });
  assert.equal(candidate.objections[0].type, 'candidate_side_confusion');

  const referral = build({ lead, activities: [inbound(lead, 'r1', at(19), "I'm not the right person, talk to our ops manager",
    { eventType: 'wrong_person_reply', canonicalState: 'contact_change_review', extra: { suppliedContact: 'ops@harbourstaffing.test' } })] });
  assert.equal(referral.referral.status, 'referred');
  assert.equal(referral.referral.suppliedContact, 'ops@harbourstaffing.test');
  assert.equal(referral.referral.identityMutationAllowed, false);
  assert.equal(referral.identity.email, 'owner@harbourstaffing.test', 'identity is never changed by a referral');
});

// ── 14-16. booking ────────────────────────────────────────────────────────

test('14. a booking link sent is not a booking', () => {
  const lead = staffingLead();
  const state = build({ lead, boardLead: board(lead), activities: [
    inbound(lead, 'r1', at(19), 'We place welders in Dallas'),
    warmReply(lead, ACTION.AUTO_STAFFING_QUALIFIED, 'r1', at(19, 16), staffingQualifiedReply({ company: 'Harbour Staffing', bookingUrl: BOOKING_URL })),
  ] });
  assert.equal(state.booking.linkSent.status, 'sent');
  assert.equal(state.booking.linkSent.source, 'delivered_message_body');
  assert.equal(state.booking.call.status, 'none');
  assert.equal(state.booking.call.live, false);
  assert.equal(state.booking.meetingIntent.value, false);
});

test('15. a confirmed calendar booking is the meeting truth and owns the lead', () => {
  const lead = staffingLead({ notes: '[MANUAL HOLD]' });
  const meetingAt = '2026-09-25T17:00:00.000Z';
  const state = build({ lead, boardLead: board(lead, { stage: 'call_booked', meetingAt }), activities: [
    inbound(lead, 'r1', at(19), 'Can we talk Thursday?', { eventType: 'meeting_requested' }),
    callEvent(lead, 'call_booked', at(20), meetingAt),
  ] });
  assert.equal(state.booking.call.status, 'scheduled');
  assert.equal(state.booking.call.live, true);
  assert.equal(state.booking.call.meetingAt, meetingAt);
  assert.equal(state.booking.call.confirmedByCalendar, true);
  assert.equal(state.booking.call.bookingSource, 'google_calendar');
  assert.equal(state.booking.meetingIntent.value, true);
  assert.equal(state.booking.liveCalendarChecked, false);
});

test('16. a rescheduled meeting is reported as rescheduled with its history', () => {
  const lead = staffingLead();
  const first = '2026-09-25T17:00:00.000Z';
  const moved = '2026-09-29T17:00:00.000Z';
  const state = build({ lead, boardLead: board(lead, { stage: 'call_booked', meetingAt: moved }), activities: [
    callEvent(lead, 'call_booked', at(20), first),
    callEvent(lead, 'meeting_rescheduled', at(21), moved, 'google_calendar', { previousMeetingAt: first }),
  ] });
  assert.equal(state.booking.call.status, 'rescheduled');
  assert.equal(state.booking.call.rescheduled, true);
  assert.equal(state.booking.call.rescheduleCount, 1);
  assert.equal(state.booking.call.previousMeetingAt, first);
});

// ── 17-21. terminal ───────────────────────────────────────────────────────

test('17. a manual hold is authoritative and blocks automation', () => {
  const lead = staffingLead({ notes: '[MANUAL HOLD] [REPLY: Interested]' });
  const state = build({ lead, activities: [inbound(lead, 'r1', at(19), 'Interested')] });
  assert.equal(state.terminalState.manualHold.value, true);
  assert.equal(state.terminalState.blockedBy, 'manual_hold');
  assert.equal(state.terminalState.isTerminal, false);
  // Production counts the hold as a send-suppression reason; it is reversible,
  // so it is reported as a hold, not as durable suppression.
  assert.equal(state.terminalState.suppressed.value, false);
  assert.equal(state.terminalState.suppressed.sendSuppressionReason, '[MANUAL HOLD]');
  assert.equal(state.ownership.owner, 'none');
  assert.equal(state.ownership.blockedBy, 'manual_hold');
});

test('18. Not Interested is terminal, with every piece of evidence', () => {
  const lead = staffingLead({ stage: 'Done', emailStatus: 'done', notes: '[REPLY: Not Interested]' });
  const state = build({ lead, activities: [
    inbound(lead, 'r1', at(19), 'Not interested, thanks.', { eventType: 'negative_reply', canonicalState: 'negative', reason: 'explicit_rejection' }),
    decisionRow(lead, 'r1', at(19), { classification: 'NOT_INTERESTED', ruleCanonical: { state: 'negative', reason: 'explicit_rejection' },
      execution: { executedAction: ACTION.AUTO_NEGATIVE_CLOSE, status: EXECUTION_STATUS.SUPPRESSED } }),
  ], suppressedEmails: new Set(['owner@harbourstaffing.test']) });
  assert.equal(state.terminalState.notInterested.value, true);
  assert.deepEqual(state.terminalState.notInterested.evidence.map(item => item.source).sort(), ['notes_tag', 'reply_decision', 'reply_event']);
  assert.equal(state.terminalState.blockedBy, 'not_interested');
  assert.equal(state.terminalState.isTerminal, true);
  assert.equal(state.ownership.sendAllowed, false);
});

test('19. unsubscribe outranks every other state', () => {
  const lead = staffingLead({ stage: 'Unsub', emailStatus: 'done', notes: '[REPLY: Unsubscribed] [MANUAL HOLD] [STAFFING QUALIFIED]' });
  const state = build({ lead, activities: [
    inbound(lead, 'r1', at(19), 'Please unsubscribe me from this list.', { eventType: 'unsubscribe_reply', canonicalState: 'negative', reason: 'unsubscribe_request' }),
  ], suppressedEmails: new Set(['owner@harbourstaffing.test']) });
  assert.equal(state.terminalState.unsubscribed.value, true);
  assert.equal(state.terminalState.suppressed.value, true);
  assert.equal(state.terminalState.blockedBy, 'unsubscribed');
  assert.equal(state.terminalState.isTerminal, true);
  assert.equal(state.ownership.owner, 'none');
});

test('20. an out-of-office reply is a hold, not a prospect message', () => {
  const lead = staffingLead({ notes: '[REPLY: OOO until 2026-10-15] [MANUAL HOLD] [RESUME: 2026-10-15T15:00:00.000Z]' });
  const state = build({ lead, activities: [
    coldStep(lead, 1, at(18)),
    inbound(lead, 'r1', at(19), 'I am out of the office until October 15.', { eventType: 'out_of_office_reply', canonicalState: 'automated_reply',
      genuineHuman: false, extra: { returnDate: '2026-10-15T15:00:00.000Z' } }),
  ] });
  const reply = state.turns.find(turn => turn.direction === 'inbound');
  assert.equal(reply.automatedReply, true);
  assert.equal(reply.genuineHuman, false);
  assert.equal(state.terminalState.outOfOffice.value, true);
  assert.equal(state.terminalState.outOfOffice.status, 'active');
  assert.equal(state.terminalState.outOfOffice.returnDate, '2026-10-15T15:00:00.000Z');
  assert.equal(state.responseState.answered, 'no_prospect_message');
  assert.deepEqual(state.questions, []);
  assert.equal(state.latest.prospectMessage, null);
});

test('21. a suppressed address is reported with the reason production uses', () => {
  const lead = staffingLead({ stage: 'Queued', emailStatus: 'emailed' });
  const state = build({ lead, activities: [], suppressedEmails: new Set(['owner@harbourstaffing.test']) });
  assert.equal(state.terminalState.suppressed.value, true);
  assert.equal(state.terminalState.suppressed.reason, 'suppression-list');
  assert.equal(state.terminalState.suppressed.onSuppressionList, true);
  assert.equal(state.terminalState.blockedBy, 'suppressed');
  assert.equal(state.ownership.owner, 'none');
  assert.equal(state.ownership.blockedBy, 'suppression');
});

// ── 22-25. ownership and decisions ────────────────────────────────────────

test('22. an unanswered question is human-owned, straight from production ownership', () => {
  const lead = staffingLead();
  const state = build({ lead, boardLead: board(lead), activities: [
    inbound(lead, 'r1', at(19), 'Do you work in Canada?', { eventType: 'question_reply', canonicalState: 'needs_human', reason: 'question_or_objection' }),
  ] });
  assert.equal(state.ownership.owner, 'human');
  assert.equal(state.ownership.blockedBy, 'human_owned');
  assert.deepEqual(state.ownership.executableOwners, []);
  assert.deepEqual(state.ownership.inputs, { sendingEnabled: false, sequencesEnabled: false, coldCadenceDue: false, replyResponseDecision: null });
});

test('23. reply automation is represented as production records it, and never claimed without a pending reply', () => {
  const lead = staffingLead({ notes: '[STAFFING QUALIFY ASKED] [REPLY: Interested]' });
  const state = build({ lead, boardLead: board(lead), activities: [
    inbound(lead, 'r1', at(19), "I'm interested"),
    decisionRow(lead, 'r1', at(19), { classification: 'INTERESTED',
      overlay: { overlay: true, classification: 'INTERESTED', canonical: { state: 'positive' } },
      policy: { action: ACTION.AUTO_STAFFING_QUALIFY_QUESTION, send: true, reason: 'staffing interest', source: 'reply_response_policy' },
      execution: { executedAction: ACTION.AUTO_STAFFING_QUALIFY_QUESTION, status: EXECUTION_STATUS.SENT } }),
    warmReply(lead, ACTION.AUTO_STAFFING_QUALIFY_QUESTION, 'r1', at(19, 16), STAFFING_QUALIFY_QUESTION),
  ] });
  const reply = state.turns.find(turn => turn.direction === 'inbound');
  assert.equal(reply.decision.policyAction, ACTION.AUTO_STAFFING_QUALIFY_QUESTION);
  assert.equal(reply.decision.executionStatus, 'sent');
  assert.equal(state.responseState.answeredBy, 'automation');
  assert.equal(state.responseState.waitingOn, 'waiting_on_prospect');
  assert.notEqual(state.ownership.owner, 'reply_automation');
  assert.equal(state.ownership.inputs.replyResponseDecision, null);
});

test('24. the canonical reply decision is linked to its inbound message and wins over the event label', () => {
  const lead = staffingLead();
  const state = build({ lead, activities: [
    // The observer's rule reading said needs_human; production's decision said interested.
    inbound(lead, 'r1', at(19), 'Send me some info', { eventType: 'needs_human_reply', canonicalState: 'needs_human', reason: 'unclear_intent' }),
    decisionRow(lead, 'r1', at(19), { classification: 'QUESTION',
      overlay: { overlay: true, classification: 'SEND_INFO', canonical: { state: 'positive' } },
      policy: { action: ACTION.AUTO_STAFFING_SEND_INFO, send: true, reason: 'info', source: 'reply_response_policy' },
      execution: { executedAction: null, status: EXECUTION_STATUS.BLOCKED, code: 'human_response_observed', fallbackAction: ACTION.HUMAN_REVIEW } }),
    evaluatedRow(lead, 'r1', 'SEND_INFO', 'reply-decision:S1:r1'),
  ] });
  const decision = state.turns[0].decision;
  assert.equal(decision.exists, true);
  assert.equal(decision.status, 'recorded');
  assert.equal(decision.decisionId, 'reply-decision:S1:r1');
  assert.equal(decision.finalClassification, 'SEND_INFO');
  assert.equal(decision.executionStatus, 'blocked');
  assert.equal(decision.executionCode, 'human_response_observed');
  assert.equal(decision.evaluatedEventId, 'gmail-evaluated:primary:r1');
  assert.deepEqual(state.turns[0].classification, { value: 'SEND_INFO', source: 'reply_decision' });
  assert.deepEqual(state.decisionCoverage, { inboundTurns: 1, recorded: 1, legacyEvaluated: 0, decisionMissing: 0, notEvaluated: 0 });
});

test('25. historical inbound without a decision is represented explicitly', () => {
  const lead = staffingLead();
  const state = build({ lead, activities: [
    inbound(lead, 'old', at(10), 'Interested'),
    evaluatedRow(lead, 'old', 'INTERESTED', null),
    inbound(lead, 'gap', at(11), 'Following up'),
    evaluatedRow(lead, 'gap', 'NEEDS_HUMAN', 'reply-decision:S1:gap'),
    inbound(lead, 'new', at(19), 'Hello?', { canonicalState: 'needs_human' }),
  ] });
  const byId = Object.fromEntries(state.turns.map(turn => [turn.messageId, turn.decision]));
  assert.equal(byId.old.status, 'legacy_evaluated');
  assert.equal(byId.old.exists, false);
  assert.deepEqual(state.turns.find(turn => turn.messageId === 'old').classification, { value: 'INTERESTED', source: 'gmail_reply_evaluated' });
  assert.equal(byId.gap.status, 'evaluated_decision_missing');
  assert.ok(codes(state).includes('reply_decision_missing'));
  assert.equal(byId.new.status, 'not_evaluated');
  assert.ok(state.ambiguities.some(item => item.code === 'inbound_not_evaluated' && item.messageId === 'new'));
});

// ── 26-30. integrity ──────────────────────────────────────────────────────

test('26. a duplicated ledger row is one event, and the duplicate is reported', () => {
  const lead = staffingLead();
  const reply = inbound(lead, 'r1', at(19), 'Interested');
  const state = build({ lead, activities: [reply, { ...reply }, coldStep(lead, 1, at(18))] });
  assert.equal(state.turns.filter(turn => turn.direction === 'inbound').length, 1);
  assert.equal(state.sources.duplicateRowsDropped, 1);
  assert.ok(codes(state).includes('duplicate_event_rows'));
  const normalized = normalizeConversationEvidence({ activities: [reply, { ...reply }] });
  assert.deepEqual(normalized.duplicates, [{ eventId: 'gmail-reply:r1', copies: 2, identical: true }]);
});

function richConversation() {
  const lead = staffingLead({ notes: '[STAFFING QUALIFY ASKED] [STAFFING INFO SENT]' });
  return {
    lead,
    boardLead: board(lead),
    activities: [
      coldStep(lead, 1, at(15)),
      inbound(lead, 'r1', at(16), 'Send me some info'),
      warmReply(lead, ACTION.AUTO_STAFFING_SEND_INFO, 'r1', at(16, 16), STAFFING_SEND_INFO_REPLY),
      inbound(lead, 'r2', at(17), 'We mostly do welders around Calgary. How much is it?', { eventType: 'question_reply', canonicalState: 'needs_human', reason: 'question_or_objection' }),
      humanReply(lead, 'h1', at(18)),
      inbound(lead, 'r3', at(19), 'Sounds good'),
    ],
  };
}

test('27. rows supplied in any order give the same state', () => {
  const { lead, boardLead, activities } = richConversation();
  const forward = JSON.stringify(build({ lead, boardLead, activities }));
  const reversed = JSON.stringify(build({ lead, boardLead, activities: [...activities].reverse() }));
  const shuffled = JSON.stringify(build({ lead, boardLead, activities: [activities[3], activities[0], activities[5], activities[1], activities[4], activities[2]] }));
  assert.equal(reversed, forward);
  assert.equal(shuffled, forward);
});

test('28. conflicting evidence is surfaced, not silently resolved', () => {
  const lead = staffingLead({ notes: '[STAFFING INFO SENT] [STAFFING QUALIFIED]' });
  const meetingAt = '2026-09-25T17:00:00.000Z';
  const state = build({ lead, boardLead: board(lead, { stage: 'call_booked', meetingAt }), activities: [
    coldStep(lead, 1, at(15)),
    { ...coldStep(lead, 2, at(16), 'Hi Alex, ...'), metadata: JSON.stringify({ step: 2, gmailMessageId: 'c2-S1', gmailThreadId: 't2', senderInboxId: 'tryscalelabai' }) },
    inbound(lead, 'r1', at(17), 'Interested'),
    humanReply(lead, 'h1', at(18)),
    callEvent(lead, 'call_booked', at(18, 18), meetingAt),
    inbound(lead, 'r2', at(19), 'Thanks — see you then'),
    warmReply(lead, ACTION.AUTO_BOOKING_RESPONSE, 'r2', at(19, 16), `Absolutely.\n\n${BOOKING_URL}`),
  ] });
  const found = codes(state);
  assert.equal(state.thread.ownershipStatus, 'conflict');
  for (const code of ['sender_ownership_conflict', 'multiple_threads', 'info_sent_tag_without_delivery',
    'qualified_tag_without_delivery', 'booking_link_while_meeting_booked', 'automation_after_human_takeover']) {
    assert.ok(found.includes(code), `${code} missing from ${found.join(', ')}`);
  }
  // The hold on human handling still stands; later automation does not erase it.
  assert.equal(state.ownership.humanTakeover.value, true);
});

test('a rebooking link after a no-show is not flagged; a link during a live booking is', () => {
  // From a real production conversation: booked, no-show, then a human re-sent the link.
  const lead = dentalLead();
  const meetingAt = '2026-09-02T00:30:00.000Z';
  const rows = [
    callEvent(lead, 'call_booked', at(1, 18), meetingAt, 'google_calendar'),
    callEvent(lead, 'meeting_no_show', at(2, 4), meetingAt, 'crm_call_lifecycle'),
    inbound(lead, 'p1', at(15, 19), 'Sorry I missed it — can we reschedule?'),
  ];
  const rebook = build({ lead, boardLead: board(lead, { stage: 'call_booked', meetingAt }), activities: rows,
    messageTexts: { h1: { text: `No problem — pick a new time here: ${BOOKING_URL}`, source: 'gmail_provider_message' } } });
  const withHuman = build({ lead, boardLead: board(lead, { stage: 'call_booked', meetingAt }),
    activities: [...rows, humanReply(lead, 'h1', at(15, 20))],
    messageTexts: { h1: { text: `No problem — pick a new time here: ${BOOKING_URL}`, source: 'gmail_provider_message' } } });
  assert.equal(rebook.booking.call.status, 'no_show');
  assert.equal(withHuman.booking.linkSent.status, 'sent');
  assert.equal(withHuman.booking.linkSent.evidence[0].actor, 'human');
  assert.ok(!codes(withHuman).includes('booking_link_while_meeting_booked'));

  const live = build({ lead, boardLead: board(lead, { stage: 'call_booked', meetingAt: '2026-09-30T17:00:00.000Z' }), activities: [
    callEvent(lead, 'call_booked', at(18), '2026-09-30T17:00:00.000Z'),
    inbound(lead, 'p2', at(19), 'See you then'),
    warmReply(lead, ACTION.AUTO_MEETING_RESPONSE, 'p2', at(19, 16), `Yes — pick a time here:\n${BOOKING_URL}`),
  ] });
  assert.ok(codes(live).includes('booking_link_while_meeting_booked'));
});

test('an unanswered question on an opted-out conversation is closed, not open work', () => {
  // From real production data: an information request on a lead that then unsubscribed.
  const lead = dentalLead({ notes: '[REPLY: Unsubscribed]', stage: 'Unsub', emailStatus: 'done' });
  const state = build({ lead, activities: [
    inbound(lead, 'q1', at(19), 'Do you have a website?', { eventType: 'question_reply', canonicalState: 'needs_human', reason: 'question_or_objection' }),
  ] });
  assert.equal(state.questions.length, 1);
  assert.equal(state.questions[0].status, 'closed_terminal');
  assert.equal(state.questions[0].closedBy, 'unsubscribed');
});

test('a delivered cold step the lead row does not reflect is reported', () => {
  // From real production data: Email 1 delivered from one inbox, the lead row
  // still Queued at step 0 and pinned to another inbox.
  const lead = dentalLead({ stage: 'Queued', emailStatus: '', emailStep: '', senderInboxId: 'primary' });
  const send = { ...coldStep(lead, 1, at(14), 'Hi Sam, ...'),
    metadata: JSON.stringify({ step: 1, gmailMessageId: 'c1-D1', gmailThreadId: 't1', senderInboxId: 'tryscalelabai' }) };
  const state = build({ lead, activities: [send] });
  const found = codes(state);
  assert.ok(found.includes('lead_row_behind_ledger'));
  assert.ok(found.includes('sender_mismatch'));
  assert.equal(state.thread.senderProof.senderInboxId, 'tryscalelabai');
});

test('a cold step recorded twice is reported, not merged and not hidden', () => {
  // From a real production conversation: a legacy row without a provider id
  // beside the provider-backed row for the same send.
  const lead = dentalLead();
  const provider = coldStep(lead, 1, '2026-08-31T18:44:03.465Z', 'Hi Sam, ...');
  const legacy = { ...provider, eventId: 'e55639a7-184b-4ce5-835d-c76c4245ac', occurredAt: '2026-08-31T18:44:03.000Z',
    metadata: JSON.stringify({ gmailThreadId: 't1' }) };
  const state = build({ lead, activities: [provider, legacy] });
  assert.equal(state.turns.filter(turn => turn.actionType === 'cold_step_1').length, 2);
  const warning = state.evidenceWarnings.find(item => item.code === 'cold_step_recorded_more_than_once');
  assert.ok(warning);
  assert.match(warning.detail, /1 without a provider id/);
});

test('an automated sequence send also ingested as a human reply stays automated and is reported', () => {
  // From a real production conversation: the observer's already-recorded check
  // compares gmailMessageId, but sequence steps store the id as providerMessageId.
  const lead = dentalLead();
  const step = {
    eventId: 'seq:no_show_recovery_v1:2', leadId: 'CE-D1', sourceLeadId: 'D1', email: lead.email,
    eventType: 'sequence_step_sent', occurredAt: '2026-09-15T15:30:46.085Z', subject: '', content: 'Following up...',
    metadata: JSON.stringify({ sequenceId: 'no_show_recovery_v1', step: 2, providerMessageId: 'm-seq', gmailThreadId: 't1', senderInboxId: 'primary' }),
  };
  const state = build({ lead, activities: [step, humanReply(lead, 'm-seq', '2026-09-15T15:30:45.000Z')] });
  assert.equal(state.turns.length, 1);
  assert.equal(state.turns[0].actor, 'automation');
  assert.equal(state.turns[0].actionType, 'no_show_recovery_v1:step_2');
  assert.deepEqual(state.turns[0].sourceEventIds, ['gmail-outbound:m-seq', 'seq:no_show_recovery_v1:2']);
  assert.ok(codes(state).includes('automated_send_also_recorded_as_human'));
  assert.equal(state.ownership.humanTakeover.value, false);
});

test('29. missing message content is unavailable, never guessed, and fills nothing', () => {
  const lead = staffingLead({ notes: '[STAFFING QUALIFY ASKED]' });
  const state = build({ lead, activities: [
    inbound(lead, 'r1', at(17), "I'm interested"),
    warmReply(lead, ACTION.AUTO_STAFFING_QUALIFY_QUESTION, 'r1', at(17, 16), STAFFING_QUALIFY_QUESTION),
    inbound(lead, 'r2', at(18), ''),
    { ...warmReply(lead, ACTION.AUTO_STAFFING_QUALIFIED, 'r2', at(18, 16), ''),
      metadata: JSON.stringify({ actionId: 'reply-action:x', provider: 'gmail', gmailMessageId: 'w-r2', gmailThreadId: 't1', senderInboxId: 'primary', recoveredAfterCheckpointFailure: true }) },
  ] });
  const blank = state.turns.find(turn => turn.messageId === 'r2');
  assert.equal(blank.contentAvailable, false);
  assert.equal(blank.contentUnavailableReason, 'inbound_text_not_recorded');
  const recovered = state.turns.find(turn => turn.messageId === 'w-r2');
  assert.equal(recovered.contentUnavailableReason, 'recovered_send_without_body');
  assert.equal(recovered.actionType, 'unrecorded_action');
  assert.ok(codes(state).includes('outbound_content_unavailable'));
  assert.equal(state.qualification.slots.roles.status, 'unknown');
});

test('30. repeated builds are byte-identical and never modify their inputs', () => {
  const input = deepFreeze(richConversation());
  const first = JSON.stringify(build(input));
  const second = JSON.stringify(build(input));
  assert.equal(second, first);
  assert.equal(JSON.parse(first).evidenceDigest.length, 64);
  // A later clock is a different reading of the same evidence.
  const later = buildConversationState({ ...input, suppressedEmails: new Set(), now: '2026-09-23T18:00:00.000Z' });
  assert.equal(later.evidenceDigest, JSON.parse(first).evidenceDigest);
  assert.notEqual(later.asOf, JSON.parse(first).asOf);
});

// ── guarantees ────────────────────────────────────────────────────────────

test('model output is never an input: a shadow recommendation changes nothing', () => {
  const { lead, boardLead, activities } = richConversation();
  const shadow = {
    eventId: 'staffing_agent_shadow:r3', leadId: 'CE-S1', sourceLeadId: 'S1', email: lead.email,
    eventType: 'staffing_agent_shadow', occurredAt: at(19, 1), subject: 'Shadow SEND_BOOKING', content: 'looks qualified',
    metadata: JSON.stringify({ gmailMessageId: 'r3', recommendedAction: 'SEND_BOOKING', agentIntent: 'INTERESTED', agentFit: 'FIT' }),
  };
  const without = build({ lead, boardLead, activities });
  const withShadow = build({ lead, boardLead, activities: [...activities, shadow] });
  for (const key of ['turns', 'qualification', 'questions', 'objections', 'booking', 'responseState', 'ownership', 'terminalState']) {
    assert.deepEqual(withShadow[key], without[key], key);
  }
  assert.equal(withShadow.sources.modelOutputsUsed, false);
});

test('the builder requires an explicit clock and an identity', () => {
  assert.throws(() => buildConversationState({ lead: staffingLead(), activities: [] }), /explicit, valid `now`/);
  assert.throws(() => buildConversationState({ activities: [], now: NOW }), /lead or a boardLead/);
});

test('the same builder works across families: dental turns and ownership, no staffing slots', () => {
  const lead = dentalLead();
  const state = build({ lead, activities: [
    coldStep(lead, 1, at(18), 'Hi Sam, ...'),
    inbound(lead, 'd1', at(19), 'What does it cost?', { eventType: 'question_reply', canonicalState: 'needs_human', reason: 'question_or_objection' }),
    humanReply(lead, 'dh1', at(20)),
  ] });
  assert.equal(state.qualification.applicable, false);
  assert.equal(state.qualification.status, 'not_applicable');
  assert.deepEqual(state.turns.map(turn => turn.actor), ['automation', 'prospect', 'human']);
  assert.equal(state.questions[0].topic, 'pricing');
  assert.equal(state.questions[0].status, 'responded');
  assert.equal(state.ownership.staffingAutomationHold.applies, false);
});

test('precedence is documented in the state itself', () => {
  const state = build({ lead: staffingLead(), activities: [] });
  assert.deepEqual(state.sources.precedence, EVIDENCE_PRECEDENCE);
  assert.ok(EVIDENCE_PRECEDENCE.some(line => /reply_decision_recorded > gmail_reply_evaluated/.test(line)));
  assert.ok(EVIDENCE_PRECEDENCE.some(line => /a link is never a booking/.test(line)));
});

// ── evidence selection ────────────────────────────────────────────────────

test('selection matches by lead, Pipeline id and email, and never borrows a twin\'s rows', () => {
  const lead = staffingLead();
  const other = staffingLead({ id: 'S2', email: 'someone@else.test' });
  const card = board(lead);
  const rows = [
    inbound(lead, 'r1', at(19), 'Interested'),
    { ...callEvent(lead, 'call_booked', at(20), '2026-09-25T17:00:00.000Z', 'crm_call_lifecycle'), sourceLeadId: '', leadId: card.id },
    { ...humanReply(lead, 'h9', at(21)), sourceLeadId: '', leadId: 'L-legacy' },
    inbound(other, 'x1', at(19), 'Not me'),
    { ...inbound(other, 'x2', at(19), 'Wrong lead'), email: lead.email },
  ];
  const index = indexConversationEvidence({ leads: [lead, other], boardLeads: [card], activities: rows });
  for (const id of ['S1', 'CE-S1']) {
    const selected = selectConversationEvidence(index, id);
    assert.equal(selected.lead.id, 'S1');
    assert.equal(selected.boardLead.id, 'CE-S1');
    const ids = selected.activities.map(row => row.eventId).sort();
    assert.ok(ids.includes('gmail-reply:r1'));
    assert.ok(ids.includes('gmail-outbound:h9'), 'an email-only match is used when the address is unique');
    assert.ok(!ids.includes('gmail-reply:x1'));
    assert.ok(!ids.includes('gmail-reply:x2'), 'a row naming another lead is never borrowed');
    assert.equal(selected.selection.counts.foreignExcluded, 1);
  }
  assert.equal(selectConversationEvidence(index, 'nope').lead, null);

  const twin = staffingLead({ id: 'S3' });
  const shared = selectConversationEvidence(indexConversationEvidence({ leads: [lead, twin], boardLeads: [], activities: rows }), 'S1');
  assert.ok(!shared.activities.some(row => row.eventId === 'gmail-outbound:h9'), 'email-only matches are refused when two leads share the address');
  assert.equal(shared.selection.warnings[0].code, 'email_shared_with_other_leads');
  const state = build({ lead: shared.lead, activities: shared.activities, selection: shared.selection });
  assert.ok(codes(state).includes('email_shared_with_other_leads'));
});

// ── human reply text ──────────────────────────────────────────────────────

function fakeMailbox(messages) {
  const calls = [];
  return {
    calls,
    mailboxFor: id => {
      if (id !== 'primary') throw new Error('not configured');
      return { email: 'deins@scalelabai.ca', gmail: { users: { messages: { get: async ({ id: messageId, format }) => {
        calls.push({ messageId, format });
        if (!messages[messageId]) { const error = new Error('Not Found'); error.code = 404; throw error; }
        return { data: messages[messageId] };
      } } } } };
    },
  };
}
const gmailMessage = ({ from = 'Deins <deins@scalelabai.ca>', threadId = 't1', labels = ['SENT'], text }) => ({
  threadId, labelIds: labels,
  payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: from }], body: { data: Buffer.from(text).toString('base64url') } },
});

test('human reply text is reconstructed only when Gmail proves it is the recorded message', async () => {
  const lead = staffingLead();
  const rows = [
    humanReply(lead, 'ok', at(19)),
    humanReply(lead, 'wrongthread', at(18)),
    humanReply(lead, 'notsent', at(17)),
    humanReply(lead, 'otherfrom', at(16)),
    humanReply(lead, 'missing', at(15)),
    humanReply(lead, 'nomailbox', at(14), { senderInboxId: '' }),
    humanReply(lead, 'logged', at(13), {}, 'already has text'),
  ];
  const { mailboxFor, calls } = fakeMailbox({
    ok: gmailMessage({ text: 'Happy to explain — what roles do you fill?\n\nOn Mon, Alex wrote:\n> interested' }),
    wrongthread: gmailMessage({ threadId: 't9', text: 'x' }),
    notsent: gmailMessage({ labels: ['INBOX'], text: 'x' }),
    otherfrom: gmailMessage({ from: 'someone@else.test', text: 'x' }),
  });
  const result = await loadHumanReplyTexts({ activities: rows, mailboxFor });
  assert.deepEqual(result.texts, { ok: { text: 'Happy to explain — what roles do you fill?', source: 'gmail_provider_message' } });
  const reasons = Object.fromEntries(result.failures.map(item => [item.messageId, item.reason]));
  assert.deepEqual(reasons, { wrongthread: 'thread_mismatch', notsent: 'not_a_sent_message', otherfrom: 'sender_mismatch',
    missing: 'message_not_found', nomailbox: 'mailbox_not_recorded' });
  assert.ok(!calls.some(call => call.messageId === 'logged'), 'a row that already has text is not fetched');
  assert.ok(!calls.some(call => call.messageId === 'nomailbox'), 'no recorded mailbox, no provider call');
  assert.ok(calls.every(call => call.format === 'full'));
  assert.equal(result.attempted, 6);
  assert.equal(result.providerCalls, 5);

  const bounded = await loadHumanReplyTexts({ activities: rows, mailboxFor, limit: 2 });
  assert.equal(bounded.attempted, 2);
  assert.equal(bounded.providerCalls, 2);
  assert.equal(bounded.skippedOverLimit, 4);
  const state = build({ lead, activities: rows, messageTexts: result.texts });
  assert.equal(state.turns.find(turn => turn.messageId === 'ok').contentSource, 'gmail_provider_message');
  assert.equal(state.turns.find(turn => turn.messageId === 'missing').contentAvailable, false);
});

// ── read-only boundary ────────────────────────────────────────────────────

test('the inspection endpoint is authenticated, snapshot-backed and cannot mutate', () => {
  const server = readSource('server.js');
  const start = server.indexOf("app.get('/api/ops/conversation-state/:leadId', requireAuth,");
  assert.ok(start > 0, 'endpoint missing or unauthenticated');
  const route = server.slice(start, server.indexOf('\n});', start));
  assert.match(route, /getOutreachDataset\(\{ force: req\.query\.refresh === '1' \}\)/);
  assert.match(route, /req\.query\.humanText === '1'\s*\n?\s*\? await loadHumanReplyTexts\(/);
  for (const forbidden of [/append/i, /\.update\(/, /applyLeadChange/, /recordColdCallActivity/, /addSuppression/,
    /spawnAgent/, /sendEmail/, /queueDraft/, /applyManualHold/, /batchUpdate/, /anthropic/i, /values\.get/]) {
    assert.doesNotMatch(route, forbidden, String(forbidden));
  }
});

test('no production decision path consumes the conversation state', () => {
  for (const file of ['outreach-agent.js', 'integrations/reply-response-policy.js', 'integrations/staffing-reply-policy.js',
    'integrations/automation-ownership.js', 'integrations/reply-decision.js', 'integrations/stage-sequences.js',
    'integrations/staffing-agent-shadow.js', 'integrations/prospect-reply-delivery.js', 'integrations/send-safety-revalidate.js']) {
    assert.doesNotMatch(readSource(file), /conversation-state|conversation-evidence/, file);
  }
  const state = readSource('integrations/conversation-state.js');
  assert.doesNotMatch(state, /require\((['"])(?:@anthropic-ai\/sdk|googleapis)\1\)/);
  for (const forbidden of [/sendEmail/, /appendColdCallActivities/, /recordColdCallActivity/, /applyLeadChange/,
    /addSuppression/, /spreadsheets\./, /messages\.send/, /fetch\(/]) {
    assert.doesNotMatch(state, forbidden, String(forbidden));
  }
});
