'use strict';

// Regression for the 2026-09-30 audit: the v1 staffing shadow agent built its
// prompt from the WHOLE activity ledger, so one lead inherited another lead's
// booking link, landing-page info, research facts and email snippets. Jole's
// first positive reply was recommended NO_ACTION because dental booking links
// and Bane Staffing's follow-up made it look already answered.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildStaffingAgentContext, compactAgentUserPayload, conversationState, storedResearch, leadScopedActivities,
} = require('../integrations/staffing-agent-context');
const {
  evaluateStaffingConversationShadow, pendingStaffingShadowItems, shadowRetryState, MAX_SHADOW_ATTEMPTS,
} = require('../integrations/staffing-agent-shadow');
const { STAFFING_AGENT_KEY_ENV, EVENT_TYPE } = require('../integrations/staffing-agent-schema');
const { STAFFING_CAMPAIGN } = require('../integrations/staffing-campaign');

const LANDING = 'https://scalelabai.ca/staffing/';
const env = { STAFFING_CONVERSATION_AGENT_ENABLED: 'true', STAFFING_CONVERSATION_AGENT_MODE: 'shadow',
  [STAFFING_AGENT_KEY_ENV]: 'test-dedicated-key' };

const staffing = (id, email, company, over = {}) => ({
  id, email, company, contactName: 'Pat Doe', firstName: 'Pat', stage: 'Contacted', emailStatus: 'emailed',
  campaign: STAFFING_CAMPAIGN.name, emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId,
  leadNiche: 'industrial_staffing', intendedCampaignVersion: STAFFING_CAMPAIGN.id, notes: '[STAFFING HIGH]',
  ...over,
});
const row = (lead, eventId, eventType, occurredAt, content = '', metadata = {}) => ({
  eventId, leadId: `CE-${lead.id}`, sourceLeadId: lead.id, email: lead.email, company: lead.company,
  eventType, occurredAt, subject: '', content, metadata: JSON.stringify(metadata),
});

const leadA = staffing('lead-a', 'owner@alpha-staffing.test', 'Alpha Staffing');
const leadB = staffing('lead-b', 'owner@bravo-staffing.test', 'Bravo Staffing');
const SECRET_A = 'ALPHA-ONLY welders in Dayton';
const ledgerA = [
  row(leadA, 'a-1', 'initial_email_sent', '2026-09-20T15:00:00.000Z', `Hi, ${SECRET_A}`,
    { personalization: { icpFit: 'FIT', facts: [{ kind: 'role', value: 'alpha-welder' }] } }),
  row(leadA, 'a-2', 'follow_up_sent', '2026-09-22T15:00:00.000Z', `See how it works: ${LANDING}`),
  row(leadA, 'gmail-reply:a-msg', 'positive_reply', '2026-09-23T15:00:00.000Z', 'Alpha says yes please',
    { gmailMessageId: 'a-msg', classification: 'INTERESTED' }),
  row(leadA, 'a-3', 'booking_link_sent', '2026-09-23T16:00:00.000Z', 'calendar for alpha'),
];
const ledgerB = [
  row(leadB, 'b-1', 'initial_email_sent', '2026-09-24T15:00:00.000Z', 'Hi Bravo, we help agencies win employers'),
  row(leadB, 'gmail-reply:b-msg', 'positive_reply', '2026-09-25T15:00:00.000Z', 'Bravo is interested',
    { gmailMessageId: 'b-msg', gmailThreadId: 'b-thread', classification: 'INTERESTED' }),
];
const all = [...ledgerA, ...ledgerB];

test('lead B context carries none of lead A\'s booking, info, research, snippets or classification', () => {
  const context = buildStaffingAgentContext({ lead: leadB, leads: [leadA, leadB], activities: all,
    message: { messageId: 'b-msg', threadId: 'b-thread' }, replyText: 'Bravo is interested' });
  assert.equal(context.state.bookingLinkSent, false);
  assert.equal(context.state.infoSent, false);
  assert.deepEqual(context.research.facts, []);
  assert.equal(context.research.icpFit, 'STORED'); // from Bravo's own [STAFFING HIGH] note only
  assert.ok(context.recentThread.length >= 1);
  assert.ok(context.recentThread.every(item => !/alpha/i.test(item.snippet)));
  assert.equal(context.state.previousReplyAction, 'INTERESTED');
  const payload = JSON.stringify(compactAgentUserPayload(context));
  for (const leak of [SECRET_A, 'alpha', 'Alpha', LANDING, 'calendar for alpha', 'alpha-welder'])
    assert.ok(!payload.includes(leak), `prompt payload leaked "${leak}"`);
});

test('lead A still sees its own booking, info and research', () => {
  const context = buildStaffingAgentContext({ lead: leadA, leads: [leadA, leadB], activities: all,
    message: { messageId: 'a-msg' }, replyText: 'Alpha says yes please' });
  assert.equal(context.state.bookingLinkSent, true);
  assert.equal(context.state.infoSent, true);
  assert.equal(context.research.facts[0].value, 'alpha-welder');
});

test('every exported context entry point is lead-scoped, even without a leads list', () => {
  assert.equal(conversationState(leadB, all).bookingLinkSent, false);
  assert.equal(conversationState(leadB, all).infoSent, false);
  assert.deepEqual(storedResearch(leadB, all).facts, []);
  assert.deepEqual(leadScopedActivities(leadB, all).map(item => item.eventId).sort(), ['b-1', 'gmail-reply:b-msg']);
  assert.deepEqual(leadScopedActivities({}, all), []);
});

test('a row naming another lead is never borrowed by email, and a shared address is not matched by email', () => {
  const foreignSameEmail = { ...row(leadA, 'x-1', 'booking_link_sent', '2026-09-26T00:00:00.000Z'), email: leadB.email };
  assert.ok(!leadScopedActivities(leadB, [...all, foreignSameEmail]).includes(foreignSameEmail));
  const twin = staffing('lead-b-twin', leadB.email, 'Bravo Twin');
  const unattributed = { eventId: 'u-1', leadId: '', sourceLeadId: '', email: leadB.email, company: '',
    eventType: 'booking_link_sent', occurredAt: '2026-09-26T00:00:00.000Z', subject: '', content: '', metadata: '{}' };
  assert.ok(leadScopedActivities(leadB, [...all, unattributed], [leadB]).includes(unattributed));
  assert.ok(!leadScopedActivities(leadB, [...all, unattributed], [leadB, twin]).includes(unattributed));
});

// ── Jole regression (audited 2026-09-25 18:00Z evaluation) ──────────────────
const jole = staffing('mu5sratzhkzhrw3yv8', 'jorge@jole.test', 'Jole Enterprise', {
  notes: '[STAFFING HIGH] [B2 Tier 1] Saw you place pipe fitters and welders for industrial construction contractors.',
});
const bane = staffing('mtwgdei10eo2l73z1mb', 'sarah@bane.test', 'Bane Staffing');
const dental = { id: 'mt9ka4dnwfgdo8rlbz', email: 'front@silver-dental.test', company: 'Silver 7 Dental',
  leadNiche: 'dental', emailTemplateId: 'dental-guarantee-v1', notes: '' };
const JOLE_REPLY = 'If you only get paid for meetings I would like more info please';
const joleLedger = [
  row(dental, 'den-book', 'booking_link_sent', '2026-09-14T06:12:10.003Z', 'Grab 15 minutes: https://calendar.app.google/dental'),
  row(bane, 'bane-fu', 'follow_up_sent', '2026-09-21T17:03:02.546Z',
    `Hi Sarah, Just to clarify — we're not talking about candidate sourcing. You can see how it works here: ${LANDING}`,
    { personalization: { facts: [{ kind: 'role', value: 'CNC operators' }] } }),
  row(jole, 'jole-initial', 'initial_email_sent', '2026-09-25T17:32:07.433Z',
    'Hi Jorge, Saw you place pipe fitters and welders for industrial construction contractors. We help industrial staffing agencies turn that exact market into qualified employer meetings.'),
  row(jole, 'gmail-reply:1a0d9adeb5af5f83', 'positive_reply', '2026-09-25T17:47:15.000Z', JOLE_REPLY,
    { gmailMessageId: '1a0d9adeb5af5f83', gmailThreadId: '1a0d99fdbe57df11', classification: 'QUESTION', genuineHuman: true }),
];

test('Jole: first positive inbound has bookingLinkSent=false and infoSent=false, and no other lead in the prompt', async () => {
  const sent = [];
  const outcome = await evaluateStaffingConversationShadow({
    lead: jole, leads: [jole, bane], activities: [...joleLedger],
    message: { messageId: '1a0d9adeb5af5f83', threadId: '1a0d99fdbe57df11', body: JOLE_REPLY },
    replyText: JOLE_REPLY, env, now: new Date('2026-09-25T18:00:20.000Z'),
    createMessage: async payload => { sent.push(payload); return { content: [{ type: 'text', text: JSON.stringify({
      intent: 'INTERESTED', confidence: 0.92, fit: 'FIT', recommendedAction: 'SEND_INFO',
      reason: 'Positive interest conditional on pay-per-meeting.', replyDraft: 'Happy to share how it works.' }) }],
    usage: { input_tokens: 900, output_tokens: 60 } }; },
  });
  assert.equal(outcome.status, 'ok');
  assert.equal(sent.length, 1);
  const prompt = JSON.parse(sent[0].messages[0].content);
  assert.equal(prompt.state.bookingLinkSent, false);
  assert.equal(prompt.state.infoSent, false);
  assert.deepEqual(prompt.research.facts, []);
  const text = sent[0].messages[0].content;
  for (const leak of ['Bane', 'Sarah', 'candidate sourcing', LANDING, 'Silver 7', 'calendar.app.google', 'CNC operators'])
    assert.ok(!text.includes(leak), `Jole prompt leaked "${leak}"`);
  assert.ok(prompt.recentThread.every(item => item.direction === 'outbound' ? /Jorge/.test(item.snippet) : true));
  const metadata = JSON.parse(outcome.event.metadata);
  assert.equal(metadata.replyDraft, 'Happy to share how it works.');
  assert.equal(metadata.attempt, 1);
  assert.equal(metadata.retryable, false);
});

// ── v1 transient-failure retry ──────────────────────────────────────────────
const creditError = async () => { const error = new Error('400 Your credit balance is too low to access the Anthropic API.'); error.status = 400; throw error; };
const okModel = async () => ({ content: [{ type: 'text', text: JSON.stringify({ intent: 'INTERESTED', confidence: 0.9,
  fit: 'FIT', recommendedAction: 'ASK_QUALIFICATION', reason: 'Interested.', replyDraft: '' }) }],
usage: { input_tokens: 10, output_tokens: 5 } });

test('v1: a credits failure is recorded, reused within backoff, then retried as a new attempt row', async () => {
  const activities = [...ledgerB];
  const message = { messageId: 'b-msg', threadId: 'b-thread', body: 'Bravo is interested' };
  const persisted = [];
  const base = { lead: leadB, leads: [leadB], activities, message, replyText: message.body, env,
    persistEvent: async event => persisted.push(event) };
  const first = await evaluateStaffingConversationShadow({ ...base, now: new Date('2026-09-28T15:30:00Z'), createMessage: creditError });
  assert.equal(first.result.status, 'credits');
  assert.equal(JSON.parse(first.event.metadata).retryable, true);
  assert.equal(first.event.eventId, `${EVENT_TYPE}:b-msg`);
  let calls = 0;
  const counted = async () => { calls++; return okModel(); };
  const tooSoon = await evaluateStaffingConversationShadow({ ...base, now: new Date('2026-09-28T15:45:00Z'), createMessage: counted });
  assert.equal(tooSoon.reused, true);
  assert.equal(calls, 0);
  assert.equal(pendingStaffingShadowItems({ leads: [leadB], activities, now: new Date('2026-09-28T15:45:00Z') }).length, 0);
  assert.equal(pendingStaffingShadowItems({ leads: [leadB], activities, now: new Date('2026-09-28T16:01:00Z') }).length, 1);
  const retried = await evaluateStaffingConversationShadow({ ...base, now: new Date('2026-09-28T16:01:00Z'), createMessage: counted });
  assert.equal(retried.result.status, 'ok');
  assert.equal(retried.event.eventId, `${EVENT_TYPE}:b-msg:attempt-2`);
  assert.equal(JSON.parse(retried.event.metadata).attempt, 2);
  assert.equal(calls, 1);
  const later = await evaluateStaffingConversationShadow({ ...base, now: new Date('2026-10-05T00:00:00Z'), createMessage: counted });
  assert.equal(later.reused, true);
  assert.equal(calls, 1);
  assert.equal(new Set(persisted.map(event => event.eventId)).size, persisted.length);
});

test('v1: validation failures are final and retries are bounded', async () => {
  const activities = [...ledgerB];
  const message = { messageId: 'b-msg', threadId: 'b-thread', body: 'Bravo is interested' };
  const malformed = async () => ({ content: [{ type: 'text', text: '{"intent":"INTERESTED"}' }], usage: {} });
  const bad = await evaluateStaffingConversationShadow({ lead: leadB, leads: [leadB], activities, message,
    replyText: message.body, env, now: new Date('2026-09-28T15:30:00Z'), createMessage: malformed });
  assert.equal(JSON.parse(bad.event.metadata).retryable, false);
  assert.equal(shadowRetryState(activities, 'b-msg', new Date('2026-12-01T00:00:00Z')).final, true);

  const outage = [...ledgerB];
  let at = Date.parse('2026-09-28T15:30:00Z');
  let calls = 0;
  for (let i = 0; i < 6; i++) {
    await evaluateStaffingConversationShadow({ lead: leadB, leads: [leadB], activities: outage, message,
      replyText: message.body, env, now: new Date(at), createMessage: async () => { calls++; return creditError(); } });
    at += 6 * 3600 * 1000;
  }
  assert.equal(calls, MAX_SHADOW_ATTEMPTS);
  assert.equal(shadowRetryState(outage, 'b-msg', new Date(at)).final, true);
});
