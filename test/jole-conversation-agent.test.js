'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  MODEL, EVENT_TYPE, SKILL_PATH, loadSkill, joleConversationAgentConfig, isPricingRequest, draftProblem,
  threadHistory, runJoleConversationAgent, draftActivity,
} = require('../integrations/clients/jole-conversation-agent');
const { handleManagedClientReply } = require('../integrations/clients/reply-pipeline');
const { createMemoryLedgerStore } = require('../integrations/clients/ledger-store');
const { WORKFLOW_STATE } = require('../integrations/clients/reply-policy');

const BOOKING = 'https://calendar.app.google/gRNEr9g4k99yhffN7';
const enabledEnv = (over = {}) => ({ JOLE_CONVERSATION_AGENT_ENABLED: 'true', ANTHROPIC_JOLE_CONVERSATION_AGENT_KEY: 'test-jole-key', ...over });
const joleLead = (over = {}) => ({
  id: 'jole-lead-1', company: 'American Steel Fab', contactName: 'Cliff Thornberry', email: 'cliff@steelfab-test.invalid',
  stage: 'Contacted', emailStatus: 'emailed', emailStep: '1', notes: '', ...over,
});
const GOOD_DRAFT = `Hi Cliff,\n\nGood to know, I appreciate you getting back to me.\n\nThat's exactly where we can help. We supply contract skilled tradespeople when additional manpower is needed.\n\nWould you be open to a quick 15 minute call? You can grab a time here:\n${BOOKING}\n\nJorge`;
const modelReply = (payload, extra = {}) => ({
  content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(payload) }],
  usage: { input_tokens: 4000, output_tokens: 300 }, stop_reason: 'end_turn', model: MODEL, ...extra,
});
const sendReply = draft => modelReply({ recommendedAction: 'SEND_REPLY', replyGoal: 'BOOK_MEETING', reason: 'interested', escalationReason: '', replyDraft: draft });
function spy(response) {
  const calls = [];
  const createMessage = async payload => { calls.push(payload); if (response instanceof Error) throw response; return response; };
  return { calls, createMessage };
}
const run = (over = {}) => runJoleConversationAgent({
  lead: joleLead(), message: { messageId: 'gm-1', subject: 'RE: contract tradespeople' },
  replyText: 'We do have an occasional need for temporary contract labor', workflowState: WORKFLOW_STATE.POSITIVE_INTEREST,
  env: enabledEnv(), ...over,
});

// ── THE SKILL FILE ─────────────────────────────────────────────────────────
test('skill: SKILL.md loads, carries the approved links and never a price', () => {
  const skill = loadSkill();
  assert.ok(skill, 'skill file must load');
  assert.ok(skill.text.length > 2000);
  assert.deepEqual([...skill.links].sort(), [BOOKING, 'https://jolebtx.netlify.app/'].sort());
  // Pricing is off limits to the agent, so the knowledge it reads holds none.
  assert.doesNotMatch(skill.text, /\$\s?\d/);
  assert.match(skill.text, /No pricing, ever/);
  assert.match(fs.readFileSync(SKILL_PATH, 'utf8'), /^---\nname: jole-btx-conversation\n/);
});

test('skill: a missing file escalates instead of drafting', async () => {
  const { calls, createMessage } = spy(sendReply(GOOD_DRAFT));
  const result = await run({ createMessage, skillPath: path.join(__dirname, 'no-such-skill.md') });
  assert.equal(result.recommendedAction, 'ESCALATE_HUMAN');
  assert.equal(result.status, 'skill_missing');
  assert.equal(calls.length, 0);
});

// ── PRICING NEVER REACHES THE MODEL ────────────────────────────────────────
test('pricing: rate, cost, quote and rate-sheet questions are recognised', () => {
  for (const text of [
    'Send me your rate sheet and I will review.',
    'If I need one welder/fabricator for one week to help finish a project what would that rate look like?',
    'How much for two pipefitters?', 'Can you send a quote?', 'What is your markup?', 'Do you pay per diem?',
    'What would that cost us?', 'Is $45 an hour doable?',
  ]) assert.equal(isPricingRequest(text), true, text);
  for (const text of [
    'We do have an occasional need for temporary contract labor', "I'm in charge of hiring at the plant",
    'What trades do you cover?', 'Can you staff a shutdown in March?',
  ]) assert.equal(isPricingRequest(text), false, text);
});

test('pricing: a pricing reply escalates with no model call, even when enabled', async () => {
  const { calls, createMessage } = spy(sendReply(GOOD_DRAFT));
  const result = await run({ createMessage, replyText: 'Send me your rate sheet and I will review.' });
  assert.equal(result.recommendedAction, 'ESCALATE_HUMAN');
  assert.equal(result.status, 'pricing');
  assert.equal(result.replyDraft, '');
  assert.equal(calls.length, 0);
  const viaTopic = await run({ createMessage, replyText: 'Interesting, tell me more', clarificationTopics: ['rates'] });
  assert.equal(viaTopic.status, 'pricing');
  assert.equal(calls.length, 0);
});

// ── DETERMINISTIC STATES AND CONFIG ────────────────────────────────────────
test('states: opt-outs, rejections, outside ICP and auto replies get NO_REPLY without a model call', async () => {
  const { calls, createMessage } = spy(sendReply(GOOD_DRAFT));
  for (const workflowState of [WORKFLOW_STATE.UNSUBSCRIBE, WORKFLOW_STATE.NOT_INTERESTED, WORKFLOW_STATE.OUTSIDE_ICP, WORKFLOW_STATE.AUTOMATED]) {
    assert.equal((await run({ createMessage, workflowState })).recommendedAction, 'NO_REPLY', workflowState);
  }
  assert.equal((await run({ createMessage, workflowState: WORKFLOW_STATE.WRONG_CONTACT })).recommendedAction, 'ESCALATE_HUMAN');
  assert.equal(calls.length, 0);
});

test('config: off unless JOLE_CONVERSATION_AGENT_ENABLED=true; a missing key escalates', async () => {
  assert.equal(joleConversationAgentConfig({}).enabled, false);
  assert.equal(joleConversationAgentConfig({ JOLE_CONVERSATION_AGENT_ENABLED: 'true' }).mode, 'draft');
  assert.equal(joleConversationAgentConfig({ ANTHROPIC_STAFFING_CONVERSATION_AGENT_KEY: 'k' }).keyConfigured, true);
  const { calls, createMessage } = spy(sendReply(GOOD_DRAFT));
  assert.equal((await run({ createMessage, env: {} })).status, 'disabled');
  assert.equal((await run({ env: { JOLE_CONVERSATION_AGENT_ENABLED: 'true' } })).status, 'unavailable');
  assert.equal(calls.length, 0);
});

// ── THE MODEL CALL ─────────────────────────────────────────────────────────
test('model: the skill is the system prompt and a clean draft comes back for review', async () => {
  const { calls, createMessage } = spy(sendReply(GOOD_DRAFT));
  const result = await run({ createMessage });
  assert.equal(result.recommendedAction, 'SEND_REPLY');
  assert.equal(result.replyGoal, 'BOOK_MEETING');
  assert.equal(result.replyDraft, GOOD_DRAFT);
  assert.deepEqual(result.authority, { send: false, crm: false, suppression: false, queue: false, booking: false });
  assert.equal(calls.length, 1);
  const payload = calls[0];
  assert.equal(payload.model, 'claude-opus-5-5');
  assert.equal(payload.fallbacks, 'default');
  assert.equal(payload.temperature, undefined);
  assert.equal(payload.system[0].text, loadSkill().text);
  const input = JSON.parse(payload.messages[0].content);
  assert.equal(input.prospect.firstName, 'Cliff');
  assert.equal(input.latestReply.text, 'We do have an occasional need for temporary contract labor');
});

test('model: drafts that break a rule are refused and escalated', async () => {
  const cases = {
    'mentions pricing': GOOD_DRAFT.replace('Would you', 'Our rates start low. Would you'),
    'dollar sign': GOOD_DRAFT.replace('Would you', 'Welders run $50. Would you'),
    'dash punctuation': GOOD_DRAFT.replace('Good to know, I', 'Good to know — I'),
    'unapproved link': GOOD_DRAFT.replace(BOOKING, 'https://example.com/book'),
    'ScaleLab': GOOD_DRAFT.replace('We supply', 'ScaleLab and Jole supply'),
    'no sign-off': GOOD_DRAFT.replace(/\n\nJorge$/, ''),
  };
  for (const [name, draft] of Object.entries(cases)) {
    const { createMessage } = spy(sendReply(draft));
    const result = await run({ createMessage });
    assert.equal(result.recommendedAction, 'ESCALATE_HUMAN', name);
    assert.equal(result.status, 'draft_refused', name);
    assert.equal(result.replyDraft, '', name);
  }
  assert.equal(draftProblem(GOOD_DRAFT, { links: [BOOKING] }), '');
});

test('model: refusals, bad JSON, unknown actions and API errors escalate', async () => {
  const refused = await run({ createMessage: spy(modelReply({}, { stop_reason: 'refusal', content: [] })).createMessage });
  assert.equal(refused.status, 'refusal');
  const garbled = await run({ createMessage: spy({ content: [{ type: 'text', text: 'Sure! Here you go.' }], usage: {} }).createMessage });
  assert.equal(garbled.status, 'invalid_response');
  const unknown = await run({ createMessage: spy(modelReply({ recommendedAction: 'SEND_NOW', replyGoal: 'NONE', reason: 'x', replyDraft: '' })).createMessage });
  assert.equal(unknown.recommendedAction, 'ESCALATE_HUMAN');
  const failed = await run({ createMessage: spy(new Error('overloaded')).createMessage });
  assert.equal(failed.status, 'api_error');
  for (const result of [refused, garbled, unknown, failed]) assert.equal(result.replyDraft, '');
});

test('model: the agent itself may escalate or decline to reply', async () => {
  const escalated = await run({ createMessage: spy(modelReply({ recommendedAction: 'ESCALATE_HUMAN', replyGoal: 'NONE', reason: 'job seeker', escalationReason: 'not an employer', replyDraft: 'ignored' })).createMessage });
  assert.equal(escalated.recommendedAction, 'ESCALATE_HUMAN');
  assert.equal(escalated.escalationReason, 'not an employer');
  assert.equal(escalated.replyDraft, '');
});

// ── THREAD HISTORY AND THE LEDGER ROW ──────────────────────────────────────
test('thread: earlier messages for this lead only, oldest first, without the one being answered', () => {
  const lead = joleLead();
  const rows = [
    { eventType: 'human_response_sent', sourceLeadId: lead.id, occurredAt: '2026-11-13T05:39:00Z', content: 'Hi Cliff, quick call?' },
    { eventType: 'client_reply_classified', sourceLeadId: lead.id, occurredAt: '2026-11-12T23:54:00Z', content: 'We do have an occasional need', metadata: '{"gmailMessageId":"gm-0"}' },
    { eventType: 'client_reply_classified', sourceLeadId: lead.id, occurredAt: '2026-11-14T10:00:00Z', content: 'Monday works', metadata: '{"gmailMessageId":"gm-1"}' },
    { eventType: 'client_reply_classified', sourceLeadId: 'other-lead', occurredAt: '2026-11-12T00:00:00Z', content: 'not this lead' },
    { eventType: 'lead_queued', sourceLeadId: lead.id, occurredAt: '2026-11-01T00:00:00Z', content: 'queued' },
  ];
  assert.deepEqual(threadHistory(lead, rows, 'gm-1').map(item => [item.from, item.text]), [
    ['prospect', 'We do have an occasional need'], ['jorge', 'Hi Cliff, quick call?'],
  ]);
});

test('ledger row: drafts are recorded for an operator and never allowed to auto-send', async () => {
  const result = await run({ createMessage: spy(sendReply(GOOD_DRAFT)).createMessage });
  const row = draftActivity({ lead: joleLead(), message: { messageId: 'gm-1', threadId: 'th-1', senderInboxId: 'jole_team_jorge' }, workflowState: 'positive_interest', result });
  assert.equal(row.eventType, EVENT_TYPE);
  assert.equal(row.eventId, 'jole-agent:gm-1');
  assert.equal(row.content, GOOD_DRAFT);
  const meta = JSON.parse(row.metadata);
  assert.equal(meta.autoSendAllowed, false);
  assert.equal(meta.recommendedAction, 'SEND_REPLY');
  assert.equal(meta.clientId, 'jole');
  assert.ok(meta.skillVersion);
});

// ── REPLY PIPELINE STEP 5 ──────────────────────────────────────────────────
function pipelineDeps(overrides = {}) {
  const calls = { activities: [], leadChanges: [], unsubscribes: [], globalSuppressions: [] };
  const deps = {
    recordActivity: async row => { calls.activities.push(row); },
    applyLeadChange: async (lead, patch) => { calls.leadChanges.push({ id: lead.id, patch }); },
    applyGlobalUnsubscribe: async lead => { calls.unsubscribes.push(lead.id); },
    addGlobalSuppression: async (lead, reason) => { calls.globalSuppressions.push([lead.email, reason]); },
    store: createMemoryLedgerStore(), activities: [], log: { log() {}, error() {} },
    ...overrides,
  };
  return { deps, calls };
}
const context = { ok: true, clientId: 'jole', campaignId: 'jole-btx-employer-acquisition', policyMode: 'managed' };

test('pipeline: the draft is recorded after the reply evidence and the lead change', async t => {
  t.after(require('../test-support/client-lifecycle').activateJoleForTest());
  const seen = [];
  const { deps, calls } = pipelineDeps({
    draftReply: async ({ verdict }) => { seen.push(verdict.workflowState); return { eventId: 'jole-agent:gm-9', eventType: EVENT_TYPE, metadata: '{}' }; },
  });
  const result = await handleManagedClientReply({ lead: joleLead(), replyText: 'Sounds interesting, tell me more', context, message: { messageId: 'gm-9' } }, deps);
  assert.equal(result.draft, 'recorded');
  assert.equal(calls.leadChanges.length, 1);
  assert.deepEqual(calls.activities.map(row => row.eventType), ['client_reply_classified', EVENT_TYPE]);
  assert.equal(seen.length, 1);
});

test('pipeline: a failing agent changes nothing else, and auto replies are never drafted', async t => {
  t.after(require('../test-support/client-lifecycle').activateJoleForTest());
  const { deps, calls } = pipelineDeps({ draftReply: async () => { throw new Error('agent down'); } });
  const result = await handleManagedClientReply({ lead: joleLead(), replyText: 'Sounds interesting, tell me more', context, message: { messageId: 'gm-10' } }, deps);
  assert.equal(result.handled, true);
  assert.equal(result.draft, 'failed');
  assert.equal(calls.leadChanges[0].patch.emailStatus, 'replied');
  assert.deepEqual(calls.activities.map(row => row.eventType), ['client_reply_classified']);

  let called = false;
  const auto = pipelineDeps({ draftReply: async () => { called = true; return null; } });
  const autoResult = await handleManagedClientReply({ lead: joleLead(), replyText: 'I am out of the office until Monday', context, message: { messageId: 'gm-11' } }, auto.deps);
  assert.equal(autoResult.verdict.workflowState, WORKFLOW_STATE.AUTOMATED);
  assert.equal(called, false);
});

test('pipeline: without a draftReply dependency nothing changes', async t => {
  t.after(require('../test-support/client-lifecycle').activateJoleForTest());
  const { deps, calls } = pipelineDeps();
  const result = await handleManagedClientReply({ lead: joleLead(), replyText: 'Sounds interesting, tell me more', context, message: { messageId: 'gm-12' } }, deps);
  assert.equal(result.draft, 'skipped');
  assert.deepEqual(calls.activities.map(row => row.eventType), ['client_reply_classified']);
});
