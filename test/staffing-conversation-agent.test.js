'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  RECOMMENDED_ACTIONS, MODEL, STAFFING_AGENT_KEY_ENV, ZERO_AUTHORITY,
  staffingConversationAgentConfig, staffingAgentApiKey, normalizeAgentOutput,
  failClosedResult, broadlyAgree, EVENT_TYPE, shadowEventId, OPERATION,
} = require('../integrations/staffing-agent-schema');
const { buildStaffingAgentContext, conversationState } = require('../integrations/staffing-agent-context');
const { runStaffingConversationAgent, SYSTEM_PROMPT, parseJsonObject } = require('../integrations/staffing-conversation-agent');
const {
  evaluateStaffingConversationShadow, observeStaffingConversationShadows,
} = require('../integrations/staffing-agent-shadow');
const { STAFFING_CAMPAIGN } = require('../integrations/staffing-campaign');
const { decideReplyResponse } = require('../integrations/reply-response-policy');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').split('\r\n').join('\n');

const DEDICATED_KEY = 'test-staffing-conversation-agent-key';
const GENERAL_KEY = 'test-general-anthropic-key';
const enabledEnv = (over = {}) => ({
  STAFFING_CONVERSATION_AGENT_ENABLED: 'true',
  STAFFING_CONVERSATION_AGENT_MODE: 'shadow',
  [STAFFING_AGENT_KEY_ENV]: DEDICATED_KEY,
  ANTHROPIC_API_KEY: GENERAL_KEY,
  ...over,
});

const staffingLead = (over = {}) => ({
  id: 'staff-1',
  company: 'Acme Staffing',
  contactName: 'Ada Byron',
  firstName: 'Ada',
  email: 'ada@acmestaffing.com',
  title: 'Owner',
  stage: 'Contacted',
  emailStatus: 'emailed',
  campaign: STAFFING_CAMPAIGN.name,
  emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId,
  leadNiche: 'industrial_staffing',
  intendedCampaignVersion: STAFFING_CAMPAIGN.id,
  siteContext: 'Saw you place welders and machinists for manufacturers.',
  notes: '[STAFFING HIGH] Saw you place welders and machinists for manufacturers.',
  ...over,
});

const dentalLead = () => ({
  id: 'den-1', company: 'Cooper Dental', email: 'owner@cooper.test',
  leadNiche: 'dental', emailTemplateId: 'dental-guarantee-v1', notes: '',
});

const inbound = (over = {}) => ({
  messageId: 'gmail-msg-1', threadId: 'thread-1', body: 'Interested', snippet: 'Interested',
  occurredAt: '2026-09-18T12:00:00.000Z', ...over,
});

function jsonMessage(payload, usage = { input_tokens: 180, output_tokens: 70 }) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], usage };
}

function recommendation(action, over = {}) {
  return {
    intent: 'INTERESTED', confidence: 0.9, fit: 'UNKNOWN',
    recommendedAction: action, reason: `Recommend ${action}.`, replyDraft: 'Thanks — happy to help.',
    ...over,
  };
}

function replyEvent(lead, message, classification = 'INTERESTED') {
  return {
    eventId: `gmail-reply:${message.messageId}`,
    leadId: `CE-${lead.id}`, sourceLeadId: lead.id, email: lead.email, company: lead.company,
    eventType: classification === 'UNSUBSCRIBE' ? 'unsubscribe_reply' : 'positive_reply',
    occurredAt: message.occurredAt, subject: '', content: message.body,
    metadata: JSON.stringify({
      classification, gmailMessageId: message.messageId, gmailThreadId: message.threadId,
    }),
  };
}

async function shadowEval(over = {}) {
  const lead = over.lead || staffingLead();
  const message = over.message || inbound();
  const activities = over.activities || [];
  const calls = [];
  const persisted = [];
  const createMessage = over.createMessage || (async payload => {
    calls.push(payload);
    return jsonMessage(over.modelOutput || recommendation('ASK_QUALIFICATION'));
  });
  const result = await evaluateStaffingConversationShadow({
    lead, message, replyText: over.replyText || message.body,
    activities, persistEvent: async event => persisted.push(event),
    env: over.env || enabledEnv(),
    productionClassification: over.productionClassification || '',
    checkOnly: over.checkOnly || false,
    createMessage,
    AnthropicImpl: over.AnthropicImpl,
  });
  return { result, calls, persisted, activities, lead };
}

// ── flags / schema ──────────────────────────────────────────────────────────

test('missing flag, unknown mode, and non-shadow modes stay disabled', () => {
  assert.equal(staffingConversationAgentConfig({}).enabled, false);
  assert.equal(staffingConversationAgentConfig({ STAFFING_CONVERSATION_AGENT_ENABLED: 'true' }).mode, 'disabled');
  assert.equal(staffingConversationAgentConfig({
    STAFFING_CONVERSATION_AGENT_ENABLED: 'true', STAFFING_CONVERSATION_AGENT_MODE: 'active',
  }).enabled, false);
  assert.equal(staffingConversationAgentConfig({
    STAFFING_CONVERSATION_AGENT_ENABLED: 'true', STAFFING_CONVERSATION_AGENT_MODE: 'shadow',
  }).mode, 'shadow');
  assert.equal(staffingConversationAgentConfig(enabledEnv({ STAFFING_CONVERSATION_AGENT_ENABLED: 'yes' })).enabled, false);
});

test('schema allowlist and fail-closed normalization', () => {
  assert.deepEqual(RECOMMENDED_ACTIONS, [
    'ASK_QUALIFICATION', 'SEND_INFO', 'SEND_BOOKING', 'HOLD_FOR_LATER',
    'MARK_NOT_INTERESTED', 'UNSUBSCRIBE', 'STORE_REFERRAL', 'ALREADY_HANDLED',
    'ESCALATE_HUMAN', 'NO_ACTION',
  ]);
  assert.equal(MODEL, 'claude-haiku-4-5');
  assert.equal(normalizeAgentOutput(recommendation('ASK_QUALIFICATION')).ok, true);
  assert.equal(normalizeAgentOutput(recommendation('ASK_QUALIFICATION', { confidence: 94 })).confidence, 0.94);
  assert.equal(normalizeAgentOutput('not-json').recommendedAction, 'ESCALATE_HUMAN');
  assert.equal(normalizeAgentOutput(recommendation('LAUNCH_NUKES')).recommendedAction, 'ESCALATE_HUMAN');
  assert.equal(normalizeAgentOutput({ intent: 'INTERESTED', confidence: 0.9, fit: 'UNKNOWN', recommendedAction: 'ASK_QUALIFICATION', reason: 'x' }).status, 'agent_error');
  assert.equal(normalizeAgentOutput(recommendation('ASK_QUALIFICATION', { confidence: 'nope' })).reason.includes('invalid confidence'), true);
  assert.equal(failClosedResult('x').authority.send, false);
  assert.deepEqual(failClosedResult('x').authority, ZERO_AUTHORITY);
});

test('malformed JSON from the model parser fails closed', () => {
  assert.throws(() => parseJsonObject('not json'), /malformed JSON/);
  assert.throws(() => parseJsonObject('[]'), /malformed JSON/);
  const parsed = parseJsonObject('Here you go\n{"intent":"INTERESTED","confidence":0.5,"fit":"UNKNOWN","recommendedAction":"ASK_QUALIFICATION","reason":"x","replyDraft":"y"}');
  assert.equal(parsed.recommendedAction, 'ASK_QUALIFICATION');
});

// ── context ─────────────────────────────────────────────────────────────────

test('context includes stored staffing facts and does not invent research', () => {
  const lead = staffingLead({
    notes: '[STAFFING HIGH]\n[STAFFING QUALIFICATION ASKED]\n[REPLY: Question — auto-answered, booking link sent]',
  });
  const activities = [
    replyEvent(lead, inbound({ messageId: 'old', body: 'Tell me more' }), 'QUESTION'),
    {
      eventId: 'gmail:sent-1', sourceLeadId: lead.id, eventType: 'booking_link_sent',
      occurredAt: '2026-09-17T12:00:00.000Z', content: 'calendar',
      metadata: JSON.stringify({ personalization: { icpFit: 'FIT', facts: [{ kind: 'role', value: 'welder' }] } }),
    },
  ];
  const context = buildStaffingAgentContext({
    lead, message: inbound({ body: 'We place welders in Houston' }),
    replyText: 'We place welders in Houston', activities,
  });
  assert.equal(context.lead.id, 'staff-1');
  assert.equal(context.lead.email, 'ada@acmestaffing.com');
  assert.equal(context.lead.firstName, 'Ada');
  assert.equal(context.lead.company, 'Acme Staffing');
  assert.equal(context.lead.title, 'Owner');
  assert.equal(context.campaign.family, 'industrial_staffing');
  assert.equal(context.campaign.offerId, STAFFING_CAMPAIGN.id);
  assert.equal(context.state.qualificationAsked, true);
  assert.equal(context.state.bookingLinkSent, true);
  assert.equal(context.state.qualificationReceived, false);
  assert.equal(context.research.facts[0].value, 'welder');
  assert.equal(context.inboundMessageId, 'gmail-msg-1');
  assert.ok(context.contextHash);
  assert.equal(conversationState(staffingLead()).qualificationAsked, false);
});

test('qualification markers are read-only and absent by default', () => {
  const lead = staffingLead();
  const state = conversationState(lead, []);
  assert.equal(state.qualificationAsked, false);
  assert.equal(state.infoSent, false);
  assert.equal(state.qualificationReceived, false);
  assert.equal(state.markedQualified, false);
  assert.equal(state.bookingLinkSent, false);
  const asked = conversationState(staffingLead({ notes: '[STAFFING QUALIFICATION ASKED]' }), []);
  const received = conversationState(staffingLead({ notes: '[STAFFING QUALIFICATION RECEIVED]' }), []);
  const qualified = conversationState(staffingLead({ notes: '[STAFFING QUALIFIED]' }), []);
  const info = conversationState(staffingLead({ notes: 'see https://scalelabai.ca/staffing/' }), []);
  assert.equal(asked.qualificationAsked, true);
  assert.equal(received.qualificationReceived, true);
  assert.equal(qualified.markedQualified, true);
  assert.equal(info.infoSent, true);
});

// ── recommendation cases (mocked Anthropic) ─────────────────────────────────

const CASES = [
  ['Interested', 'Interested', 'ASK_QUALIFICATION', { intent: 'INTERESTED' }],
  ['More info', 'Send me some info', 'SEND_INFO', { intent: 'QUESTION' }],
  ['Website/details', 'Do you have a website?', 'SEND_INFO', { intent: 'QUESTION' }],
  ['Negative', 'Not interested', 'MARK_NOT_INTERESTED', { intent: 'NOT_INTERESTED' }],
  ['Unsubscribe', 'Stop emailing me', 'UNSUBSCRIBE', { intent: 'UNSUBSCRIBE' }],
  ['Timing', 'Maybe next month', 'HOLD_FOR_LATER', { intent: 'TIMING' }],
  ['Referral', 'Talk to Sarah', 'STORE_REFERRAL', { intent: 'REFERRAL' }],
  ['Existing internal team', 'We already have an internal BD team', 'ALREADY_HANDLED', { intent: 'EXISTING_PROVIDER' }],
  ['Ambiguous', 'unclear reply', 'ESCALATE_HUMAN', { intent: 'AMBIGUOUS' }],
];

for (const [name, reply, action, over] of CASES) {
  test(`recommendation: ${name}`, async () => {
    const { result, persisted } = await shadowEval({
      message: inbound({ body: reply }), replyText: reply,
      modelOutput: recommendation(action, { ...over, reason: `${name} case` }),
    });
    assert.equal(result.result.recommendedAction, action);
    assert.equal(result.result.ok, true);
    assert.deepEqual(result.authority, ZERO_AUTHORITY);
    assert.equal(persisted[0].eventType, EVENT_TYPE);
    assert.equal(JSON.parse(persisted[0].metadata).autoSendAllowed, false);
  });
}

test('qualification answer after qualification was asked recommends SEND_BOOKING', async () => {
  const lead = staffingLead({ notes: '[STAFFING HIGH]\n[STAFFING QUALIFICATION ASKED]' });
  const reply = 'We place welders and machinists for manufacturers around Houston';
  const { result } = await shadowEval({
    lead, message: inbound({ body: reply }), replyText: reply,
    modelOutput: recommendation('SEND_BOOKING', { intent: 'INTERESTED', fit: 'FIT' }),
  });
  assert.equal(result.result.recommendedAction, 'SEND_BOOKING');
  assert.equal(buildStaffingAgentContext({ lead, message: inbound(), replyText: reply }).state.qualificationAsked, true);
});

test('qualification answer without pending qualification state is conservative', async () => {
  const lead = staffingLead();
  const reply = 'We place welders and machinists for manufacturers around Houston';
  const { result } = await shadowEval({
    lead, message: inbound({ body: reply }), replyText: reply,
    modelOutput: recommendation('ESCALATE_HUMAN', { intent: 'AMBIGUOUS' }),
  });
  assert.equal(buildStaffingAgentContext({ lead, message: inbound(), replyText: reply }).state.qualificationAsked, false);
  assert.equal(result.result.recommendedAction, 'ESCALATE_HUMAN');
});

// ── model / key isolation ───────────────────────────────────────────────────

test('uses claude-haiku-4-5 and the dedicated staffing key only', async () => {
  const constructed = [];
  class FakeAnthropic {
    constructor(opts) { constructed.push(opts.apiKey); this.opts = opts; }
    get messages() {
      return {
        create: async payload => {
          assert.equal(payload.model, 'claude-haiku-4-5');
          return jsonMessage(recommendation('ASK_QUALIFICATION'));
        },
      };
    }
  }
  const { result } = await shadowEval({
    AnthropicImpl: FakeAnthropic,
    createMessage: undefined,
    env: enabledEnv(),
  });
  // createMessage is still provided by shadowEval default. Call the live client path directly.
  const live = await runStaffingConversationAgent({
    context: buildStaffingAgentContext({ lead: staffingLead(), message: inbound(), replyText: 'Interested' }),
    env: enabledEnv(),
    AnthropicImpl: FakeAnthropic,
  });
  assert.deepEqual(constructed, [DEDICATED_KEY]);
  assert.equal(live.model, 'claude-haiku-4-5');
  assert.equal(live.ok, true);
  assert.equal(result.result.ok, true);
});

test('dedicated key missing does not fall back to ANTHROPIC_API_KEY', async () => {
  const constructed = [];
  class FakeAnthropic {
    constructor(opts) { constructed.push(opts.apiKey); this.messages = { create: async () => jsonMessage(recommendation('ASK_QUALIFICATION')) }; }
  }
  let createCalls = 0;
  const { result, persisted } = await shadowEval({
    env: enabledEnv({ [STAFFING_AGENT_KEY_ENV]: '' }),
    AnthropicImpl: FakeAnthropic,
    createMessage: async () => { createCalls++; return jsonMessage(recommendation('ASK_QUALIFICATION')); },
  });
  assert.equal(staffingAgentApiKey(enabledEnv({ [STAFFING_AGENT_KEY_ENV]: '' })), '');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.result.recommendedAction, 'ESCALATE_HUMAN');
  assert.equal(result.calledModel, false);
  assert.equal(createCalls, 0);
  assert.deepEqual(constructed, []);
  assert.equal(JSON.parse(persisted[0].metadata).status, 'unavailable');
});

test('Anthropic API unavailable fails closed without blocking', async () => {
  const { result } = await shadowEval({
    createMessage: async () => { throw new Error('rate limit exceeded'); },
  });
  assert.equal(result.status, 'rate_limited');
  assert.equal(result.result.recommendedAction, 'ESCALATE_HUMAN');
  assert.deepEqual(result.authority, ZERO_AUTHORITY);
});

test('invalid model output variants fail closed', async () => {
  for (const output of [
    { content: [{ type: 'text', text: 'not json' }] },
    { content: [{ type: 'text', text: JSON.stringify(recommendation('WIRE_MONEY')) }] },
    { content: [{ type: 'text', text: JSON.stringify({ intent: 'INTERESTED', confidence: 0.9, fit: 'UNKNOWN', recommendedAction: 'ASK_QUALIFICATION', reason: 'x' }) }] },
    { content: [{ type: 'text', text: JSON.stringify(recommendation('ASK_QUALIFICATION', { confidence: 181 })) }] },
  ]) {
    const { result } = await shadowEval({ createMessage: async () => output });
    assert.equal(result.result.ok, false);
    assert.equal(result.result.recommendedAction, 'ESCALATE_HUMAN');
  }
});

// ── idempotency / CHECK_ONLY ────────────────────────────────────────────────

test('duplicate inbound message does not call the model again', async () => {
  const first = await shadowEval();
  assert.equal(first.calls.length, 1);
  const second = await evaluateStaffingConversationShadow({
    lead: staffingLead(), message: inbound(), replyText: 'Interested',
    activities: first.activities, persistEvent: async () => { throw new Error('must not persist twice'); },
    env: enabledEnv(), createMessage: async () => { throw new Error('must not call Anthropic twice'); },
  });
  assert.equal(second.reused, true);
  assert.equal(second.status, 'already_evaluated');
});

test('CHECK_ONLY repeat does not cause another model call', async () => {
  const lead = staffingLead();
  const message = inbound({ body: 'Interested' });
  const activities = [replyEvent(lead, message)];
  const calls = [];
  const env = enabledEnv();
  const createMessage = async payload => { calls.push(payload); return jsonMessage(recommendation('ASK_QUALIFICATION')); };
  const persistEvent = async event => activities.push(event);
  const first = await observeStaffingConversationShadows({
    leads: [lead], activities, checkOnly: true, persistEvent, env, createMessage,
  });
  const second = await observeStaffingConversationShadows({
    leads: [lead], activities, checkOnly: true, persistEvent, env, createMessage,
  });
  assert.equal(calls.length, 1);
  assert.equal(first.evaluated, 1);
  assert.equal(second.evaluated, 0);
  assert.equal(activities.filter(row => row.eventType === EVENT_TYPE).length, 1);
});

test('disabled agent never calls Anthropic even when a general key exists', async () => {
  let calls = 0;
  const { result } = await shadowEval({
    env: enabledEnv({ STAFFING_CONVERSATION_AGENT_ENABLED: 'false' }),
    createMessage: async () => { calls++; return jsonMessage(recommendation('ASK_QUALIFICATION')); },
  });
  assert.equal(result.status, 'disabled');
  assert.equal(calls, 0);
});

test('dental replies never invoke the staffing agent', async () => {
  let calls = 0;
  const { result } = await shadowEval({
    lead: dentalLead(),
    createMessage: async () => { calls++; return jsonMessage(recommendation('ASK_QUALIFICATION')); },
  });
  assert.equal(result.status, 'not_staffing');
  assert.equal(calls, 0);
});

// ── zero authority ──────────────────────────────────────────────────────────

test('shadow output cannot trigger send, CRM mutation, or suppression', async () => {
  const lead = staffingLead({ stage: 'Contacted', notes: '[STAFFING HIGH] opener', emailStatus: 'emailed' });
  const snapshot = { stage: lead.stage, notes: lead.notes, emailStatus: lead.emailStatus };
  const { result, persisted } = await shadowEval({
    lead,
    modelOutput: recommendation('SEND_BOOKING', { intent: 'INTERESTED', fit: 'FIT' }),
  });
  assert.equal(result.result.recommendedAction, 'SEND_BOOKING');
  assert.equal(lead.stage, snapshot.stage);
  assert.equal(lead.notes, snapshot.notes);
  assert.equal(lead.emailStatus, snapshot.emailStatus);
  assert.equal(result.authority.send, false);
  assert.equal(result.authority.crm, false);
  assert.equal(result.authority.suppression, false);
  assert.equal(JSON.parse(persisted[0].metadata).identityMutationAllowed, false);
  const shadowSrc = read('integrations/staffing-agent-shadow.js');
  const agentSrc = read('integrations/staffing-conversation-agent.js');
  for (const src of [shadowSrc, agentSrc]) {
    assert.doesNotMatch(src, /applyLeadChange|sendEmail|addSuppression|deliverProspectReply|deliverHardenedWarmReply|queueDraft|upsertColdCallLeadFromEvent/);
    assert.doesNotMatch(src, /ANTHROPIC_API_KEY/);
  }
});

test('production reply policy is unchanged by a SEND_BOOKING shadow recommendation', () => {
  const offer = { pricing: null };
  const production = decideReplyResponse({ classification: 'NOT_INTERESTED', offer, text: 'Not interested' });
  assert.equal(production.send, false);
  assert.equal(production.action, 'AUTO_NEGATIVE_CLOSE');
  assert.equal(broadlyAgree('NOT_INTERESTED', 'SEND_BOOKING'), false);
});

test('token usage is recorded against staffing_conversation_agent_shadow', async () => {
  const { result, persisted } = await shadowEval({
    createMessage: async () => jsonMessage(recommendation('ASK_QUALIFICATION'), { input_tokens: 210, output_tokens: 85 }),
  });
  assert.equal(result.result.usage.inputTokens, 210);
  assert.equal(result.result.usage.outputTokens, 85);
  assert.equal(result.result.operation, OPERATION);
  const meta = JSON.parse(persisted[0].metadata);
  assert.equal(meta.operation, 'staffing_conversation_agent_shadow');
  assert.equal(meta.inputTokens, 210);
  assert.equal(meta.outputTokens, 85);
  assert.equal(meta.model, 'claude-haiku-4-5');
});

test('system prompt stays compact and forbids invented facts', () => {
  assert.match(SYSTEM_PROMPT, /employer acquisition, not candidate sourcing/);
  assert.match(SYSTEM_PROMPT, /Never invent pricing/);
  assert.match(SYSTEM_PROMPT, /explicit unsubscribe → UNSUBSCRIBE/);
  assert.ok(SYSTEM_PROMPT.length < 2200, 'prompt must stay compact');
});

test('outreach-agent invokes shadow observation without routing on it', () => {
  const agent = read('outreach-agent.js');
  assert.match(agent, /observeStaffingConversationShadows\(/);
  assert.match(agent, /evaluateStaffingConversationShadow\(/);
  const interested = agent.slice(agent.indexOf('async function handleInterested'), agent.indexOf('const ACTIVE_REPLY_EVENT_TYPES'));
  assert.doesNotMatch(interested, /recommendedAction/);
  const replySwitch = agent.slice(agent.indexOf("switch (classification)"), agent.indexOf('await recordMailboxActivity({ eventId: `gmail-evaluated:'));
  assert.match(replySwitch, /case 'INTERESTED':/);
  assert.doesNotMatch(replySwitch, /recommendedAction/);
  assert.match(agent, /\[staffing-shadow\] failed closed/);
});

test('.env.example documents disabled shadow flags and does not contain a secret value', () => {
  const env = read('.env.example');
  assert.match(env, /STAFFING_CONVERSATION_AGENT_ENABLED=false/);
  assert.match(env, /STAFFING_CONVERSATION_AGENT_MODE=shadow/);
  assert.match(env, /ANTHROPIC_STAFFING_CONVERSATION_AGENT_KEY/);
  const staffingBlock = env.slice(env.indexOf('Staffing conversation agent'), env.indexOf('ROOFING_SURVEY_URL='));
  assert.doesNotMatch(staffingBlock, /sk-ant-/);
  assert.doesNotMatch(staffingBlock, /ANTHROPIC_STAFFING_CONVERSATION_AGENT_KEY=/);
  assert.match(env, /never falls back to/);
});

test('shadow event id is stable per inbound Gmail message', () => {
  assert.equal(shadowEventId('abc'), 'staffing_agent_shadow:abc');
  assert.equal(shadowEventId(''), '');
});
