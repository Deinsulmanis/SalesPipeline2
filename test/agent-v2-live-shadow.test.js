'use strict';

// Agent v2 live production shadow (P0 2026-10-01): an always-on, zero-authority
// shadow hook; exactly-once decisions per inbound with bounded transient retry;
// quality evidence; client scoping; payment-term pricing detection; employer-
// acquisition qualification wording; the final freshness gate; and the reply
// pass's cross-inbox candidate selection.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildConversationState } = require('../integrations/conversation-state');
const { buildAgentV2Input, riskFlags, clientScopeBlock } = require('../integrations/agent-v2-input');
const { guardCode, validateModelDecision, qualificationWording, SLOT_CLAUSES } = require('../integrations/agent-v2-validation');
const { evaluateAgentV2Permission } = require('../integrations/agent-v2-permission');
const { evaluateAgentV2Shadow } = require('../integrations/agent-v2-shadow');
const { providerErrorCategory } = require('../integrations/agent-v2-model');
const { shadowFailure, retryDelaySeconds, MAX_SHADOW_ATTEMPTS } = require('../integrations/agent-v2-retry');
const { decisionIdFor } = require('../integrations/agent-v2-store');
const { agentV2ShadowConfig, shadowCandidate, stateEligibility, runAgentV2ShadowPass } = require('../integrations/agent-v2-shadow-hook');
const { agentV2FinalFreshness } = require('../integrations/agent-v2-freshness');
const { inboxMayRoute, preferNextReply } = require('../integrations/reply-candidate-selection');
const { deliverProspectReply } = require('../integrations/prospect-reply-delivery');
const { SCHEMA_VERSION, AUTHORITY, TOOL_SCHEMA } = require('../integrations/agent-v2-contract');
const { STAFFING_CAMPAIGN } = require('../integrations/staffing-campaign');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const NOW = '2026-10-01T15:00:00.000Z';
const ENV = { AGENT_V2_SHADOW_ENABLED: 'true', ANTHROPIC_AGENT_V2_KEY: 'test-only-key',
  AGENT_V2_SUPABASE_DATABASE_URL: 'postgresql://unused', AGENT_V2_SUPABASE_CA_CERT: 'unused',
  SUPABASE_URL: 'https://lasyefxhuwysjebasdbf.supabase.co' };

// ── fixtures: a real Phase 1 state from ledger rows ────────────────────────
function staffingLead(over = {}) {
  return { id: 'S1', email: 'owner@acme-industrial.ca', company: 'Acme Industrial Staffing',
    campaign: STAFFING_CAMPAIGN.name, leadNiche: 'industrial_staffing',
    emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId, intendedCampaignVersion: STAFFING_CAMPAIGN.id,
    stage: 'Replied', emailStatus: 'replied', emailStep: '1', notes: '', senderInboxId: 'primary',
    clientId: 'scalelab', ...over };
}
function ledger(lead, { text = 'Interested — how does it work?', genuineHuman = true, eventType = 'positive_reply',
  messageId = 'm1', finalClassification = 'INTERESTED' } = {}) {
  const base = { leadId: `CE-${lead.id}`, sourceLeadId: lead.id, email: lead.email, company: lead.company };
  return [
    { ...base, eventId: `gmail-reply:${messageId}`, eventType, occurredAt: '2026-10-01T14:00:00.000Z',
      subject: 'Re: employer accounts', content: text, metadata: JSON.stringify({ gmailMessageId: messageId,
        gmailThreadId: 't1', senderInboxId: 'primary', classification: finalClassification, from: lead.email, genuineHuman }) },
    { ...base, eventId: `reply-decision:${lead.id}:${messageId}`, eventType: 'reply_decision_recorded',
      occurredAt: '2026-10-01T14:01:00.000Z', subject: '', content: '', metadata: JSON.stringify({
        inboundMessageId: messageId, leadId: lead.id, decisionId: `reply-decision:${lead.id}:${messageId}`,
        finalClassification, policyAction: 'HUMAN_REVIEW', executionStatus: 'recorded' }) },
  ];
}
function stateOf(lead = staffingLead(), opts = {}) {
  return buildConversationState({ lead, activities: ledger(lead, opts), now: NOW,
    config: { sequencesEnabled: true, sendingEnabled: true } });
}
function proposal(input, over = {}) {
  return { version: SCHEMA_VERSION, actionId: 'SUGGEST_QUALIFICATION', handoffCode: 'NONE', factIds: [],
    slotIds: ['roles', 'geography'], objectionType: 'NONE', evidenceRefs: [input.targetRef],
    templateId: 'QUALIFY', reasonCode: 'QUALIFICATION_GAP', confidence: 0.86, ...over };
}

// In-memory store with the Postgres store's claim, retry and listing semantics.
function memoryStore(clock = { now: Date.parse(NOW) }) {
  const rows = new Map();
  const active = new Set();
  const store = { rows, clock, abandoned: [], closed: 0, verified: 0,
    verifyPrivileges: async () => { store.verified++; return { ok: true }; },
    close: async () => { store.closed++; },
    get: async id => rows.get(id)?.record || null,
    listRetryable: async ({ limit = 5 } = {}) => [...rows.entries()]
      .filter(([, row]) => row.record?.retryable === true && row.attempts < MAX_SHADOW_ATTEMPTS
        && clock.now - row.completedAt >= retryDelaySeconds(row.attempts) * 1000)
      .slice(0, limit).map(([id, row]) => ({ decision_id: id, lead_id: row.leadId, message_id: row.messageId })),
    abandonRetry: async (id, reason) => {
      const row = rows.get(id);
      if (!row?.record?.retryable) return false;
      row.record = { ...row.record, retryable: false, retryAbandoned: reason };
      store.abandoned.push(id);
      return true;
    },
    claim: async ({ decisionId, leadId, messageId }) => {
      if (active.has(decisionId)) return { status: 'busy' };
      const prior = rows.get(decisionId);
      const due = prior?.record?.retryable === true && prior.attempts < MAX_SHADOW_ATTEMPTS
        && clock.now - prior.completedAt >= retryDelaySeconds(prior.attempts) * 1000;
      if (prior?.record && !due) return { status: 'complete', record: prior.record, retryPending: prior.record.retryable === true };
      active.add(decisionId);
      const row = prior || { leadId, messageId, record: null, attempts: 0, modelStartedAt: null, completedAt: null };
      row.attempts += 1;
      rows.set(decisionId, row);
      return { status: 'claimed', attempt: row.attempts, priorRecord: row.record,
        priorModelAttempt: row.modelStartedAt !== null && (row.completedAt === null || row.modelStartedAt > row.completedAt),
        signal: new AbortController().signal,
        markModelStarted: async () => { row.modelStartedAt = clock.now + 0.5; },
        complete: async record => { row.record = record; row.completedAt = clock.now + 1; return record; },
        release: async () => { active.delete(decisionId); } };
    } };
  return store;
}
const okModel = (calls, over = {}) => async input => { calls.push(input); return { raw: proposal(input, over), status: 'ok',
  model: 'claude-haiku-4-5-20251001', usage: { inputTokens: 900, outputTokens: 80 }, latencyMs: 640, estimatedCostUsd: 0.0013 }; };

function passArgs(store, evidence, extra = {}) {
  return { env: ENV, createStore: () => store, loadEvidence: async () => evidence, now: new Date(NOW), ...extra };
}
const candidateFor = (lead, messageId = 'm1') => shadowCandidate({ lead,
  message: { messageId, threadId: 't1', senderInboxId: 'primary', fromAddr: lead.email },
  decision: { route: 'interested', finalClassification: 'INTERESTED', canonicalState: 'positive' } }).item;

// ── configuration / observability ───────────────────────────────────────────
test('config: shadow and execution are independent; send authority needs every execution precondition', () => {
  assert.equal(agentV2ShadowConfig({}).shadowEnabled, false);
  const shadowOnly = agentV2ShadowConfig(ENV);
  assert.equal(shadowOnly.shadowEnabled, true);
  assert.equal(shadowOnly.shadowActive, true);
  assert.equal(shadowOnly.executionEnabled, false);
  assert.equal(shadowOnly.effectiveSendAuthority, false);
  assert.equal(agentV2ShadowConfig({ ...ENV, AGENT_V2_EXECUTION_ENABLED: 'false' }).effectiveSendAuthority, false);
  assert.equal(agentV2ShadowConfig({ ...ENV, AGENT_V2_EXECUTION_ENABLED: 'true' }).effectiveSendAuthority, true);
  assert.equal(agentV2ShadowConfig({ ...ENV, ANTHROPIC_AGENT_V2_KEY: '' }).shadowActive, false);
  assert.equal(agentV2ShadowConfig(ENV).model, 'claude-haiku-4-5-20251001');
  assert.deepEqual(agentV2ShadowConfig(ENV).shadowAuthority, AUTHORITY);
  assert.ok(Object.values(AUTHORITY).every(value => value === false));
  // The config never carries a credential value.
  assert.ok(!JSON.stringify(agentV2ShadowConfig(ENV)).includes('test-only-key'));
});

test('boot log and ops endpoint report flags and counts only, behind ops auth', () => {
  const server = read('server.js');
  const boot = server.slice(server.indexOf('[agent-v2] init'), server.indexOf('[agent-v2] init') + 500);
  assert.match(boot, /AGENT_V2_SHADOW_ENABLED=\$\{v2\.shadowEnabled\}/);
  assert.match(boot, /AGENT_V2_EXECUTION_ENABLED=\$\{v2\.executionEnabled\}/);
  assert.match(boot, /configuredSendAuthority=\$\{v2\.effectiveSendAuthority\}/);
  assert.match(server, /\[agent-v2\] kill switch readable=\$\{runtime\.readable\} armed=\$\{runtime\.armed\}/);
  assert.doesNotMatch(boot, /process\.env\.ANTHROPIC|DATABASE_URL\}|CA_CERT\}/);
  const route = server.slice(server.indexOf("app.get('/api/ops/agent-v2'"), server.indexOf("app.get('/api/ops/conversation-state"));
  assert.match(route, /app\.get\('\/api\/ops\/agent-v2', requireAuth,/);
  for (const field of ['shadowEnabled', 'executionEnabled', 'effectiveSendAuthority', 'totalDecisions', 'successful',
    'failed', 'retryable', 'lastShadowAt', 'lastSuccessAt', 'lastErrorCategory', 'execution', 'deployment'])
    assert.match(route, new RegExp(field));
  assert.doesNotMatch(route, /rawModelToolInput|\.content\b|replyDraft|res\.json\(.*process\.env/);
});

// ── eligibility ─────────────────────────────────────────────────────────────
test('eligibility: only genuine human replies from ScaleLab staffing leads reach the shadow', () => {
  const lead = staffingLead();
  const msg = { messageId: 'm1', threadId: 't1', senderInboxId: 'primary', fromAddr: lead.email };
  const positive = { finalClassification: 'INTERESTED', canonicalState: 'positive', route: 'interested' };
  assert.equal(shadowCandidate({ lead, message: msg, decision: positive }).eligible, true);
  const cases = [
    [{ lead: { ...lead, campaign: 'Ontario List', leadNiche: 'dental', emailTemplateId: 'dental-guarantee-v1', intendedCampaignVersion: '' } }, 'not_staffing'],
    [{ lead: { ...lead, clientId: 'jole' } }, 'not_scalelab_client'],
    [{ lead: { ...lead, stage: 'Archived', notes: '[ARCHIVED: offer retired]' } }, 'archived'],
    [{ lead: { ...lead, email: 'qa@agency.test' } }, 'test_lead'],
    [{ lead: { ...lead, id: 'SYNTHETIC_AGENT_V2_PILOT_1' } }, 'test_lead'],
    [{ message: { ...msg, fromAddr: 'deins@scalelabai.ca' }, internalDomains: ['scalelabai.ca'] }, 'internal_sender'],
    [{ decision: { finalClassification: 'OUT_OF_OFFICE', canonicalState: 'automated_reply' } }, 'automated_reply'],
    [{ message: { ...msg, messageId: '' } }, 'no_message_id'],
  ];
  for (const [over, reason] of cases) {
    const result = shadowCandidate({ lead, message: msg, decision: positive, ...over });
    assert.equal(result.eligible, false, reason);
    assert.equal(result.reason, reason);
  }
  assert.equal(stateEligibility(stateOf(), 'm1'), null);
  assert.equal(stateEligibility(stateOf(staffingLead(), { genuineHuman: false }), 'm1'), 'not_genuine_human');
  assert.equal(stateEligibility(stateOf(staffingLead(), { eventType: 'out_of_office_reply' }), 'm1'), 'not_genuine_human');
  assert.equal(stateEligibility(stateOf(), 'missing'), 'inbound_absent');
});

// ── the shadow pass ─────────────────────────────────────────────────────────
test('shadow runs with execution OFF, persists one decision with evidence, and has zero authority', async () => {
  const lead = staffingLead();
  const state = stateOf(lead);
  const store = memoryStore();
  const calls = [];
  const logs = [];
  const result = await runAgentV2ShadowPass({ candidates: [candidateFor(lead)], model: okModel(calls),
    log: entry => logs.push(entry), ...passArgs(store, { lead, state }) });
  assert.equal(result.status, 'ok');
  assert.equal(result.evaluated, 1);
  assert.equal(result.calledModel, 1);
  assert.equal(calls.length, 1);
  assert.equal(store.closed, 1);
  const record = store.rows.get(decisionIdFor('S1', 'm1')).record;
  assert.equal(record.modelStatus, 'ok');
  assert.equal(record.decision.actionId, 'SUGGEST_QUALIFICATION');
  assert.equal(record.decision.confidence, 0.86);
  assert.deepEqual(record.authority, AUTHORITY);
  assert.equal(record.retryable, false);
  assert.equal(record.attempt, 1);
  assert.equal(record.latencyMs, 640);
  assert.deepEqual(record.usage, { inputTokens: 900, outputTokens: 80 });
  assert.equal(record.messageId, 'm1');
  assert.equal(record.leadId, 'S1');
  assert.ok(record.stateDigest && record.inputDigest);
  assert.equal(record.shadow.source, 'reply_pass');
  assert.equal(record.shadow.threadId, 't1');
  assert.equal(record.shadow.senderInboxId, 'primary');
  assert.equal(record.shadow.campaign, STAFFING_CAMPAIGN.name);
  assert.equal(record.shadow.client.clientId, 'scalelab');
  assert.equal(record.shadow.client.active, true);
  assert.ok(['ALLOW', 'DENY', 'HANDOFF'].includes(record.shadow.permission.verdict));
  assert.ok(record.shadow.wording);
  assert.deepEqual(record.shadow.riskFlags, []);
  assert.equal(record.productionDecision.classification, 'INTERESTED');
  const line = logs.find(entry => entry.event === 'agent_v2_shadow');
  assert.equal(line.send_authority, false);
  assert.equal(line.called_model, true);
  assert.ok(!JSON.stringify(logs).includes('Interested — how does it work?'));
});

test('idempotency: replayed, duplicated and concurrent deliveries make one model call and one row', async () => {
  const lead = staffingLead();
  const state = stateOf(lead);
  const store = memoryStore();
  const calls = [];
  const item = candidateFor(lead);
  // Two observers reporting the same inbound in one pass, then a cron retry
  // and a restart replaying the same pass.
  await runAgentV2ShadowPass({ candidates: [item, { ...item }], model: okModel(calls), ...passArgs(store, { lead, state }) });
  const replay = await runAgentV2ShadowPass({ candidates: [item], model: okModel(calls), ...passArgs(store, { lead, state }) });
  assert.equal(replay.reused, 1);
  assert.equal(replay.calledModel, 0);
  assert.equal(calls.length, 1);
  assert.equal(store.rows.size, 1);

  const racing = memoryStore();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const raceCalls = [];
  const slow = async input => { raceCalls.push(input); await gate; return okModel([])(input); };
  const first = runAgentV2ShadowPass({ candidates: [item], model: slow, ...passArgs(racing, { lead, state }) });
  await new Promise(resolve => setImmediate(resolve));
  const second = await runAgentV2ShadowPass({ candidates: [item], model: slow, ...passArgs(racing, { lead, state }) });
  assert.equal(second.busy, 1);
  release();
  await first;
  assert.equal(raceCalls.length, 1);
});

test('transient provider failure is persisted, retried after backoff by the pass, then final', async () => {
  const lead = staffingLead();
  const state = stateOf(lead);
  const clock = { now: Date.parse(NOW) };
  const store = memoryStore(clock);
  let calls = 0;
  const credits = async () => { calls++; return { raw: null, status: 'model_error', errorCode: '400',
    errorCategory: 'credits', usage: { inputTokens: 0, outputTokens: 0 } }; };
  await runAgentV2ShadowPass({ candidates: [candidateFor(lead)], model: credits, ...passArgs(store, { lead, state }) });
  const failed = store.rows.get(decisionIdFor('S1', 'm1')).record;
  assert.equal(failed.retryable, true);
  assert.equal(failed.errorCategory, 'credits');
  assert.equal(failed.decision.handoffCode, 'MODEL_ERROR');
  // Too soon: nothing listed, no call.
  clock.now += 10 * 60 * 1000;
  assert.equal((await runAgentV2ShadowPass({ model: credits, ...passArgs(store, { lead, state }) })).considered, 0);
  assert.equal(calls, 1);
  // After the backoff the pass retries on its own, without a new inbound.
  clock.now += 25 * 60 * 1000;
  const sent = [];
  const retried = await runAgentV2ShadowPass({ model: okModel(sent), ...passArgs(store, { lead, state }) });
  assert.equal(retried.retried, 1);
  assert.equal(sent.length, 1);
  const record = store.rows.get(decisionIdFor('S1', 'm1')).record;
  assert.equal(record.modelStatus, 'ok');
  assert.equal(record.retryable, false);
  assert.equal(record.attempt, 2);
  assert.equal(record.shadow.source, 'retry');
  assert.deepEqual(record.retryHistory.map(item => item.errorCategory), ['credits']);
  clock.now += 24 * 3600 * 1000;
  assert.equal((await runAgentV2ShadowPass({ model: okModel(sent), ...passArgs(store, { lead, state }) })).considered, 0);
  assert.equal(sent.length, 1);
});

test('retry classification: transient categories retry, deterministic outcomes never do', () => {
  for (const category of ['credits', 'rate_limited', 'overloaded', 'server_error', 'timeout', 'network'])
    assert.equal(shadowFailure({ modelStatus: 'model_error', errorCategory: category }).retryable, true, category);
  assert.equal(shadowFailure({ modelStatus: 'key_unavailable' }).retryable, true);
  assert.equal(shadowFailure({ modelStatus: 'previous_model_attempt_unresolved', decisionStatus: 'unresolved_model_attempt' }).retryable, true);
  for (const outcome of [{ modelStatus: 'ok' }, { modelStatus: 'guarded' }, { modelStatus: 'invalid_response' },
    { modelStatus: 'model_mismatch' }, { modelStatus: 'model_error', errorCategory: 'bad_request' }])
    assert.equal(shadowFailure(outcome).retryable, false, JSON.stringify(outcome));
  assert.deepEqual([1, 2, 3].map(retryDelaySeconds), [1800, 3600, 7200]);
  assert.equal(MAX_SHADOW_ATTEMPTS, 4);
});

test('provider failures are categorized without keeping provider text', () => {
  const error = (message, status, extra = {}) => Object.assign(new Error(message), { status }, extra);
  assert.equal(providerErrorCategory(error('Your credit balance is too low to access the Anthropic API.', 400)), 'credits');
  assert.equal(providerErrorCategory(error('rate_limit_error', 429)), 'rate_limited');
  assert.equal(providerErrorCategory(error('Overloaded', 529)), 'overloaded');
  assert.equal(providerErrorCategory(error('internal', 500)), 'server_error');
  assert.equal(providerErrorCategory(error('Request timed out.', undefined)), 'timeout');
  assert.equal(providerErrorCategory(error('fetch failed', undefined, { code: 'ECONNRESET' })), 'network');
  assert.equal(providerErrorCategory(error('invalid x-api-key', 401)), 'auth');
  assert.equal(providerErrorCategory(error('messages: field required', 400)), 'bad_request');
});

test('a retry whose input can no longer be built is closed instead of listed forever', async () => {
  const lead = staffingLead();
  const clock = { now: Date.parse(NOW) };
  const store = memoryStore(clock);
  const credits = async () => ({ raw: null, status: 'model_error', errorCategory: 'credits', usage: { inputTokens: 0, outputTokens: 0 } });
  await runAgentV2ShadowPass({ candidates: [candidateFor(lead)], model: credits, ...passArgs(store, { lead, state: stateOf(lead) }) });
  clock.now += 3 * 3600 * 1000;
  const broken = await runAgentV2ShadowPass({ model: credits, ...passArgs(store, { lead, state: { version: 'unknown' } }) });
  assert.equal(broken.skipped, 1);
  assert.deepEqual(store.abandoned, [decisionIdFor('S1', 'm1')]);
  assert.equal(store.rows.get(decisionIdFor('S1', 'm1')).record.errorCategory, 'credits');
});

test('ineligible state, disabled flag or missing configuration never reach the model or the ledger', async () => {
  const lead = staffingLead();
  const calls = [];
  const store = memoryStore();
  const automated = await runAgentV2ShadowPass({ candidates: [candidateFor(lead)], model: okModel(calls),
    ...passArgs(store, { lead, state: stateOf(lead, { genuineHuman: false }) }) });
  assert.equal(automated.skipped, 1);
  assert.equal(store.rows.size, 0);
  let created = 0;
  const off = await runAgentV2ShadowPass({ candidates: [candidateFor(lead)], env: {}, model: okModel(calls),
    createStore: () => { created++; return store; }, loadEvidence: async () => ({}) });
  assert.equal(off.status, 'disabled');
  const unconfigured = await runAgentV2ShadowPass({ candidates: [candidateFor(lead)], model: okModel(calls),
    env: { AGENT_V2_SHADOW_ENABLED: 'true' }, createStore: () => { created++; return store; }, loadEvidence: async () => ({}) });
  assert.equal(unconfigured.status, 'unconfigured');
  assert.equal(created, 0);
  assert.equal(calls.length, 0);
  const failing = await runAgentV2ShadowPass({ candidates: [candidateFor(lead)], model: okModel(calls),
    env: ENV, createStore: () => { throw new Error('Agent v2 requires a Supabase session-pooler host'); }, loadEvidence: async () => ({}) });
  assert.equal(failing.status, 'failed');
});

test('the hook has no send, CRM, queue, stage, Sheets or Gmail capability and routing never reads it', () => {
  const hook = read('integrations/agent-v2-shadow-hook.js');
  const requires = [...hook.matchAll(/require\('([^']+)'\)/g)].map(match => match[1]).sort();
  assert.deepEqual(requires, ['./agent-v2-contract', './agent-v2-input', './agent-v2-permission', './agent-v2-shadow',
    './agent-v2-store', './agent-v2-wording', './clients/email-scope', './clients/registry', './lead-archive',
    './staffing-campaign']);
  const code = hook.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /sendEmail|deliver|applyLeadChange|recordMailboxActivity|queueDraft|sheets\(|gmail/i);
  const agent = read('outreach-agent.js');
  const observe = agent.slice(agent.indexOf('async function observeAgentV2Shadows'), agent.indexOf('async function commitMailboxObservationCheckpoints'));
  assert.doesNotMatch(observe, /AGENT_V2_EXECUTION|deliver|sendEmail|applyLeadChange|recordMailboxActivity/);
  // Candidates are collected only after the decision and evaluated marker are written.
  const evaluated = agent.indexOf('eventType: \'gmail_reply_evaluated\', occurredAt: new Date().toISOString()');
  const collected = agent.indexOf('agentV2ShadowCandidates.push(');
  const persisted = agent.indexOf('await persistReplyDecision(lead, replyDecision');
  assert.ok(persisted > 0 && evaluated > persisted && collected > evaluated);
  const routing = agent.slice(agent.indexOf('switch (route)'), persisted);
  assert.doesNotMatch(routing, /agentV2ShadowCandidates|observeAgentV2Shadows|runAgentV2ShadowPass/);
  assert.match(agent, /if \(!DRY_RUN\) \{\n    try \{\n      await observeStaffingConversationShadows/);
});

// ── P0-8 pricing ────────────────────────────────────────────────────────────
test('payment and fee wording is a pricing request; qualification cannot answer it', () => {
  for (const text of ['how do you get paid?', 'when do I pay?', 'is payment per meeting?', 'what does it cost?',
    'how much?', 'what are the fees?', 'is there a monthly fee?', 'If you only get paid for meetings I would like more info please'])
    assert.ok(riskFlags({ thread: { threadIds: ['t1'] }, evidenceWarnings: [] }, { content: text }).includes('pricing_request'), text);
  for (const text of ['We place welders in Houston', 'Interested, tell me more'])
    assert.ok(!riskFlags({ thread: { threadIds: ['t1'] }, evidenceWarnings: [] }, { content: text }).includes('pricing_request'), text);
  const input = buildAgentV2Input(stateOf(staffingLead(), { text: 'how do you get paid?' }), 'm1');
  const qualify = validateModelDecision(proposal(input), input);
  assert.equal(qualify.actionId, 'HANDOFF');
  assert.equal(qualify.handoffCode, 'PRICING_UNSUPPORTED');
  const facts = validateModelDecision(proposal(input, { actionId: 'SUGGEST_FACT_ANSWER', templateId: 'FACTS_ONLY',
    slotIds: [], factIds: ['F_PERFORMANCE_BASED', 'F_PAYMENT_TIED_MEETINGS'], reasonCode: 'APPROVED_FACT_MATCH' }), input);
  assert.equal(facts.status, 'valid');
  const amount = buildAgentV2Input(stateOf(staffingLead(), { text: 'how much?' }), 'm1');
  assert.equal(guardCode(amount), 'PRICING_UNSUPPORTED');
  // Production policy is untouched by Agent v2 pricing detection.
  assert.doesNotMatch(read('integrations/reply-response-policy.js'), /agent-v2/);
});

// ── P0-10 client scoping ────────────────────────────────────────────────────
test('client scope: ScaleLab staffing only; missing, inactive or other clients fail closed', async () => {
  const scalelab = buildAgentV2Input(stateOf(), 'm1');
  assert.deepEqual(scalelab.client, { clientId: 'scalelab', clientSource: 'explicit', active: true,
    campaign: STAFFING_CAMPAIGN.name, campaignAuthorized: true });
  assert.equal(clientScopeBlock(scalelab.client), '');
  const inferred = stateOf(staffingLead({ clientId: '' }));
  assert.equal(inferred.identity.clientSource, 'inferred');
  // A lead claimed by another client on ScaleLab's campaign is an ownership conflict.
  const conflicted = stateOf(staffingLead({ clientId: 'jole' }));
  assert.equal(conflicted.identity.clientId, null);
  assert.equal(clientScopeBlock(buildAgentV2Input(conflicted, 'm1').client), 'CLIENT_UNRESOLVED');
  assert.equal(clientScopeBlock({ clientId: 'jole', active: false, campaignAuthorized: false }), 'CLIENT_INACTIVE');
  assert.equal(clientScopeBlock({ clientId: 'jole', active: true, campaignAuthorized: false }), 'CLIENT_NOT_AUTHORIZED');
  // No model call for an out-of-scope client; the record is a NO_ACTION guard.
  const store = memoryStore();
  let called = 0;
  const result = await evaluateAgentV2Shadow({ state: conflicted, messageId: 'm1', store,
    model: async () => { called++; return {}; } });
  assert.equal(called, 0);
  assert.equal(result.record.decision.actionId, 'NO_ACTION');
  assert.equal(result.record.decision.handoffCode, 'CLIENT_NOT_AUTHORIZED');
  assert.equal(result.record.retryable, false);
  const permission = evaluateAgentV2Permission(conflicted, result.record);
  assert.equal(permission.verdict, 'DENY');
  assert.equal(permission.reasonCode, 'CLIENT_UNRESOLVED');
  assert.equal(permission.executionAuthorized, false);
});

// ── P0-7 wording ────────────────────────────────────────────────────────────
test('golden qualification wording: employer-account framing, fixed order, at most two questions', () => {
  assert.equal(qualificationWording(['roles']),
    "Got it. To make sure we'd target the right employer accounts for you, what roles or trades do you place most often?");
  assert.equal(qualificationWording(['geography', 'roles']),
    "Got it. To make sure we'd target the right employer accounts for you, what roles or trades do you place most often, and which locations do you cover?");
  assert.equal(qualificationWording(['industries']),
    "Got it. To make sure we'd target the right employer accounts for you, which industries are your employer clients in?");
  assert.equal(qualificationWording([]), '');
  for (const clause of Object.values(SLOT_CLAUSES)) {
    assert.doesNotMatch(clause, /candidate|recruit|hire for you|fill(?:ing)? (?:roles|positions|jobs)|source|talent/i);
    assert.doesNotMatch(clause, /\$|price|fee|guarantee|case stud|results/i);
  }
  assert.equal(TOOL_SCHEMA.properties.slotIds.maxItems, 2);
  const input = buildAgentV2Input(stateOf(), 'm1');
  const three = validateModelDecision(proposal(input, { slotIds: ['roles', 'industries', 'geography'] }), input);
  assert.equal(three.status, 'invalid_model_output');
  assert.equal(three.validationError, 'too many qualification slots');
  const two = validateModelDecision(proposal(input), input);
  assert.equal(two.suggestedWording, qualificationWording(['roles', 'geography']));
});

// ── P0-9 final freshness ────────────────────────────────────────────────────
function freshState(over = {}) {
  const inbound = { turnId: 'turn:m1', index: 1, direction: 'inbound', actor: 'prospect', messageId: 'm1',
    threadId: 't1', senderInboxId: 'primary' };
  return { evidenceDigest: 'digest-1',
    identity: { leadId: 'S1', clientId: 'scalelab', clientSource: 'explicit', family: 'industrial_staffing', campaign: STAFFING_CAMPAIGN.name },
    turns: [{ turnId: 'turn:o0', index: 0, direction: 'outbound', actor: 'automation' }, inbound],
    latest: { inbound }, thread: { threadIds: ['t1'] }, responseState: { answered: 'no' },
    ownership: { humanTakeover: { value: false }, staffingAutomationHold: { applies: false } },
    terminalState: { isTerminal: false, blockedBy: null },
    booking: { call: { status: 'none', live: false }, meetingIntent: { value: false } },
    evidenceWarnings: [], ambiguities: [], ...over };
}
const freshArgs = (over = {}) => ({ leadId: 'S1', messageId: 'm1', senderInboxId: 'primary', threadId: 't1',
  stateDigest: 'digest-1', original: { id: 'S1', email: 'owner@acme-industrial.ca' },
  current: { id: 'S1', email: 'Owner@Acme-Industrial.ca' }, state: freshState(), guards: {}, ...over });

test('final freshness refuses any change since the decision and allows only an untouched conversation', () => {
  assert.deepEqual({ ...agentV2FinalFreshness(freshArgs()) }, { allowed: true, code: null });
  const newer = { turnId: 'turn:m2', index: 2, direction: 'inbound', messageId: 'm2', threadId: 't1', senderInboxId: 'primary' };
  const cases = [
    [{ state: freshState({ latest: { inbound: newer }, turns: [...freshState().turns, newer] }) }, 'newer_inbound'],
    [{ state: freshState({ turns: [...freshState().turns, { index: 2, direction: 'outbound', actor: 'human' }] }) }, 'human_response_after_inbound'],
    [{ state: freshState({ turns: [...freshState().turns, { index: 2, direction: 'outbound', actor: 'automation', inReplyToMessageId: 'm1' }] }) }, 'already_answered'],
    [{ state: freshState({ responseState: { answered: 'yes' } }) }, 'already_answered'],
    [{ state: freshState({ ownership: { humanTakeover: { value: true }, staffingAutomationHold: { applies: false } } }) }, 'human_takeover'],
    [{ state: freshState({ ownership: { humanTakeover: { value: false }, staffingAutomationHold: { applies: true } } }) }, 'human_takeover'],
    [{ state: freshState({ terminalState: { isTerminal: true, blockedBy: 'unsubscribed' } }) }, 'terminal_state'],
    [{ state: freshState({ booking: { call: { status: 'scheduled', live: false }, meetingIntent: { value: false } } }) }, 'booking_supersedes'],
    [{ state: freshState({ booking: { call: { status: 'none', live: false }, meetingIntent: { value: true } } }) }, 'booking_supersedes'],
    [{ guards: { suppressed: true } }, 'suppressed'],
    [{ guards: { alreadySent: true } }, 'already_answered'],
    [{ guards: { humanTouch: true } }, 'human_takeover'],
    [{ guards: { repeat: true } }, 'repeat_response'],
    [{ current: { id: 'S1', email: 'someone-else@acme-industrial.ca' } }, 'lead_changed'],
    [{ current: { id: 'S2', email: 'owner@acme-industrial.ca' } }, 'lead_changed'],
    [{ senderInboxId: 'tryscalelabai' }, 'thread_or_sender_changed'],
    [{ threadId: 't9' }, 'thread_or_sender_changed'],
    [{ state: freshState({ thread: { threadIds: ['t1', 't2'] } }) }, 'thread_or_sender_changed'],
    [{ stateDigest: 'digest-0' }, 'state_changed'],
    [{ state: freshState({ identity: { ...freshState().identity, clientSource: 'inferred' } }) }, 'client_id_missing'],
    [{ state: freshState({ identity: { ...freshState().identity, clientId: 'jole' } }) }, 'client_inactive'],
    [{ state: freshState({ evidenceWarnings: [{ code: 'sender_mismatch' }] }) }, 'evidence_conflict'],
    [{ state: null }, 'freshness_input_unavailable'],
  ];
  for (const [over, code] of cases) {
    const verdict = agentV2FinalFreshness(freshArgs(over));
    assert.equal(verdict.allowed, false, code);
    assert.equal(verdict.code, code);
  }
  // Wired into the Phase 6 final gate, which still sits before the Gmail thread check.
  const agent = read('outreach-agent.js');
  const gate = agent.slice(agent.indexOf('async function deliverAgentV2Qualification'), agent.indexOf('async function handlePositiveAutomation'));
  assert.match(gate, /agentV2FinalFreshness\(/);
});

test('delivery order: final revalidation, then the Gmail thread check, then reservation and send', async () => {
  const order = [];
  const deps = (threadOk) => ({
    existingDelivery: async () => false, findDelivered: async () => null,
    existingReservation: async () => ({ unresolved: false, attempts: 0 }),
    finalRevalidate: async () => { order.push('finalRevalidate'); return { allowed: true }; },
    verifyThread: async () => { order.push('verifyThread'); return threadOk ? { ok: true } : { ok: false, reason: 'newer thread activity appeared before send' }; },
    persistReservation: async () => { order.push('persistReservation'); return {}; },
    sendProvider: async () => { order.push('sendProvider'); return { data: { id: 'gmail-1' } }; },
    persistDelivered: async () => { order.push('persistDelivered'); },
  });
  const input = { lead: { id: 'S1', email: 'owner@acme-industrial.ca' }, sender: { id: 'primary', email: 'deins@scalelabai.ca', sendEligible: true },
    thread: { threadId: 't1' }, inboundMessage: { messageId: 'm1', rfcMessageId: '<m1@mail>' }, action: 'AUTO_STAFFING_QUALIFY_QUESTION',
    subject: 'Re: employer accounts', body: qualificationWording(['roles']) };
  const refused = await deliverProspectReply(input, deps(false));
  assert.equal(refused.delivered, false);
  assert.equal(refused.code, 'thread_mismatch');
  assert.deepEqual(order, ['finalRevalidate', 'verifyThread']);
  order.length = 0;
  const sent = await deliverProspectReply(input, deps(true));
  assert.equal(sent.delivered, true);
  assert.deepEqual(order, ['finalRevalidate', 'verifyThread', 'persistReservation', 'sendProvider', 'persistDelivered']);
});

// ── P0-11 reply candidate selection ─────────────────────────────────────────
test('reply selection: a non-owner inbox never displaces the owner inbox\'s reply; otherwise newest wins', () => {
  const pinned = { id: 'J1', senderInboxId: 'primary' };
  const ownerOld = { id: 'p1', internalDate: '1000', observedSenderId: 'primary' };
  const ownerNew = { id: 'p2', internalDate: '2000', observedSenderId: 'primary' };
  const strayNewer = { id: 'd1', internalDate: '3000', observedSenderId: 'tryscalelabai' };
  // Same inbox, oldest-first order (the observer's sort): the newest wins.
  assert.equal(preferNextReply(ownerOld, ownerNew, pinned), true);
  assert.equal(preferNextReply(ownerNew, ownerOld, pinned), false);
  // The audited defect: tryscalelabai is read after primary in the same pass.
  assert.equal(preferNextReply(ownerNew, strayNewer, pinned), false);
  assert.equal(preferNextReply(strayNewer, ownerOld, pinned), true);
  assert.equal(preferNextReply(undefined, strayNewer, pinned), true);
  // An unpinned lead is routable from any inbox; newest wins.
  assert.equal(preferNextReply(ownerNew, strayNewer, { id: 'U1' }), true);
  // A terminal replay is routable regardless of inbox.
  assert.equal(inboxMayRoute(pinned, 'tryscalelabai', { terminalReplay: true }), true);
  assert.equal(inboxMayRoute(pinned, 'tryscalelabai', {}), false);
  assert.equal(inboxMayRoute(pinned, 'primary', {}), true);
  assert.equal(inboxMayRoute({ id: 'U1' }, 'deniels', {}), true);
  const agent = read('outreach-agent.js');
  assert.match(agent, /preferNextReply\(repliesByLead\.get\(item\.leadId\), next, candidatesById\.get\(item\.leadId\)\)/);
  assert.match(agent, /if \(!inboxMayRoute\(lead, sender\.id, rawMessage\)\) continue;/);
});
