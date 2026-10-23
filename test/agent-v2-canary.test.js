'use strict';

// Agent v2 controlled canary: the runtime kill switch, the deterministic canary
// scope, the durable daily cap, the decision gate and the ops evidence.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { readAgentV2KillSwitch, interpretControlRow, validateKillSwitchChange, setAgentV2KillSwitch } = require('../integrations/agent-v2-kill-switch');
const { CANARY, canaryPreScope, canaryCapVerdict, canaryDecisionGate, vancouverDay } = require('../integrations/agent-v2-canary');
const { agentV2ExecutionEvidence } = require('../integrations/agent-v2-ops');
const { responseActionId } = require('../integrations/prospect-reply-delivery');
const { PENDING_EVENT, QUALIFY_ACTION } = require('../integrations/agent-v2-pending-decision');
const { buildConversationState } = require('../integrations/conversation-state');
const { buildAgentV2Input } = require('../integrations/agent-v2-input');
const { validateModelDecision } = require('../integrations/agent-v2-validation');
const { runAgentV2ShadowPass } = require('../integrations/agent-v2-shadow-hook');
const { STAFFING_CAMPAIGN } = require('../integrations/staffing-campaign');
const { SCHEMA_VERSION } = require('../integrations/agent-v2-contract');

const root = path.join(__dirname, '..');
const NOW = new Date('2026-10-01T16:00:00.000Z');
const ENV = { SUPABASE_URL: 'https://lasyefxhuwysjebasdbf.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_test' };
const row = (over = {}) => ({ id: 'agent_v2_execution', armed: true, armed_until: '2026-10-10T00:00:00.000Z',
  reason: 'canary', updated_by: 'Deins', updated_at: '2026-10-01T15:00:00.000Z', version: 3, ...over });
const respond = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// ── kill switch ─────────────────────────────────────────────────────────────
test('kill switch reads armed only from one valid, unexpired, armed row; everything else is disarmed', async () => {
  const armed = await readAgentV2KillSwitch({ env: ENV, now: NOW, fetchImpl: respond(200, [row()]) });
  assert.deepEqual([armed.readable, armed.armed, armed.code], [true, true, 'kill_switch_armed']);
  const cases = [
    [{ env: {} }, false, 'kill_switch_unconfigured'],
    [{ fetchImpl: respond(500, {}) }, false, 'kill_switch_http_500'],
    [{ fetchImpl: respond(401, {}) }, false, 'kill_switch_http_401'],
    [{ fetchImpl: async () => { throw new Error('ECONNRESET'); } }, false, 'kill_switch_unreachable'],
    [{ fetchImpl: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; } }, false, 'kill_switch_timeout'],
    [{ fetchImpl: respond(200, []) }, true, 'kill_switch_missing'],
    [{ fetchImpl: respond(200, [row(), row()]) }, false, 'kill_switch_payload_invalid'],
    [{ fetchImpl: respond(200, { not: 'array' }) }, false, 'kill_switch_payload_invalid'],
    [{ fetchImpl: respond(200, [row({ armed: false, armed_until: null })]) }, true, 'kill_switch_disarmed'],
    [{ fetchImpl: respond(200, [row({ armed_until: null })]) }, true, 'kill_switch_no_expiry'],
    [{ fetchImpl: respond(200, [row({ armed_until: '2026-09-30T00:00:00.000Z' })]) }, true, 'kill_switch_expired'],
    [{ fetchImpl: respond(200, [row({ armed: 'true' })]) }, true, 'kill_switch_row_invalid'],
    [{ fetchImpl: respond(200, [row({ id: 'other' })]) }, true, 'kill_switch_row_invalid'],
  ];
  for (const [over, readable, code] of cases) {
    const state = await readAgentV2KillSwitch({ env: ENV, now: NOW, ...over });
    assert.equal(state.armed, false, code);
    assert.equal(state.readable, readable, code);
    assert.equal(state.code, code);
  }
  // A slow store is cut off and read as disarmed.
  const slow = await readAgentV2KillSwitch({ env: ENV, now: NOW, timeoutMs: 20,
    fetchImpl: (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => {
      const e = new Error('aborted'); e.name = 'AbortError'; reject(e); })) });
  assert.equal(slow.code, 'kill_switch_timeout');
  assert.equal(interpretControlRow(null).armed, false);
});

test('kill switch changes are validated and go through the audited database function', async () => {
  assert.equal(validateKillSwitchChange({ armed: false, reason: 'stop', by: 'Deins' }, NOW), '');
  assert.match(validateKillSwitchChange({ armed: true, reason: 'go', by: 'Deins' }, NOW), /future armedUntil/);
  assert.match(validateKillSwitchChange({ armed: true, reason: 'go', by: 'Deins', armedUntil: '2026-10-30T00:00:00Z' }, NOW), /15 days/);
  assert.match(validateKillSwitchChange({ armed: true, reason: '', by: 'Deins', armedUntil: '2026-10-05T00:00:00Z' }, NOW), /reason/);
  assert.match(validateKillSwitchChange({ armed: true, reason: 'go', by: '', armedUntil: '2026-10-05T00:00:00Z' }, NOW), /named/);
  assert.match(validateKillSwitchChange({ armed: 'yes', reason: 'go', by: 'Deins' }, NOW), /true or false/);
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, options });
    return url.includes('/rpc/') ? { ok: true, status: 200, json: async () => [] }
      : { ok: true, status: 200, json: async () => [row({ armed: false, armed_until: null })] }; };
  const changed = await setAgentV2KillSwitch({ armed: false, reason: 'stop', by: 'Deins', env: ENV, fetchImpl, now: NOW });
  assert.equal(changed.ok, true);
  assert.match(calls[0].url, /\/rest\/v1\/rpc\/agent_v2_set_runtime_control$/);
  assert.deepEqual(Object.keys(JSON.parse(calls[0].options.body)).sort(),
    ['p_armed', 'p_armed_until', 'p_changed_by', 'p_expected_version', 'p_reason']);
  const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261001000000_agent_v2_runtime_control.sql'), 'utf8');
  assert.match(migration, /VALUES \('agent_v2_execution', false, 'created disarmed', 'migration'\)/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.agent_v2_runtime_control FROM PUBLIC, anon, authenticated, service_role;/);
  assert.match(migration, /CHECK \(\s*NOT armed OR \(armed_until IS NOT NULL/);
});

test('shadow evaluation never reads the kill switch and runs while it is disarmed', async () => {
  const hook = fs.readFileSync(path.join(root, 'integrations/agent-v2-shadow-hook.js'), 'utf8');
  assert.doesNotMatch(hook, /kill-switch|readAgentV2KillSwitch/);
  const shadow = fs.readFileSync(path.join(root, 'integrations/agent-v2-shadow.js'), 'utf8');
  assert.doesNotMatch(shadow, /kill-switch|readAgentV2KillSwitch/);
  // With execution configured ON and no switch at all, the shadow pass still runs.
  const result = await runAgentV2ShadowPass({ candidates: [], env: { AGENT_V2_SHADOW_ENABLED: 'true',
    AGENT_V2_EXECUTION_ENABLED: 'true', ANTHROPIC_AGENT_V2_KEY: 'k', AGENT_V2_SUPABASE_DATABASE_URL: 'x',
    AGENT_V2_SUPABASE_CA_CERT: 'y', SUPABASE_URL: 'z' },
  createStore: () => ({ listRetryable: async () => [], verifyPrivileges: async () => ({}), close: async () => {} }),
  loadEvidence: async () => ({}) });
  assert.equal(result.status, 'ok');
});

// ── canary scope ────────────────────────────────────────────────────────────
const lead = (over = {}) => ({ id: 'C1', email: 'owner@acme-industrial.ca', company: 'Acme', campaign: STAFFING_CAMPAIGN.name,
  leadNiche: 'industrial_staffing', emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId, intendedCampaignVersion: STAFFING_CAMPAIGN.id,
  stage: 'Replied', emailStatus: 'replied', emailStep: '1', notes: '', senderInboxId: 'primary', clientId: 'scalelab', ...over });
const message = (over = {}) => ({ messageId: 'm1', threadId: 't1', senderInboxId: 'primary', occurredAt: '2026-10-01T15:40:00.000Z', ...over });
const policy = { action: QUALIFY_ACTION, send: true };
const activity = (eventType, eventId, metadata = {}, over = {}) => ({ eventId, leadId: 'CE-C1', sourceLeadId: 'C1',
  email: 'owner@acme-industrial.ca', eventType, occurredAt: over.occurredAt || '2026-10-01T15:40:00.000Z', subject: '',
  content: over.content || '', metadata: JSON.stringify(metadata) });
const inboundRow = (id = 'm1', over = {}) => activity('positive_reply', `gmail-reply:${id}`,
  { gmailMessageId: id, gmailThreadId: 't1', senderInboxId: 'primary', genuineHuman: true }, over);

test('canary pre-scope admits only a first, fresh, ScaleLab staffing qualification reply on primary', () => {
  const base = { lead: lead(), message: message(), policy, activities: [inboundRow()], now: NOW };
  assert.deepEqual({ ...canaryPreScope(base) }, { inScope: true, code: null });
  const cases = [
    [{ lead: lead({ campaign: 'Ontario List', leadNiche: 'dental', emailTemplateId: 'dental-guarantee-v1', intendedCampaignVersion: '' }) }, 'not_staffing_campaign'],
    [{ lead: lead({ clientId: '' }) }, 'not_explicit_scalelab_client'],
    [{ lead: lead({ clientId: 'jole' }) }, 'not_explicit_scalelab_client'],
    [{ lead: lead({ senderInboxId: 'tryscalelabai' }) }, 'not_primary_inbox'],
    [{ message: message({ senderInboxId: 'tryscalelabai' }) }, 'not_primary_inbox'],
    [{ policy: { action: 'AUTO_STAFFING_SEND_INFO', send: true } }, 'policy_not_qualification'],
    [{ policy: { action: QUALIFY_ACTION, send: false } }, 'policy_not_qualification'],
    [{ message: message({ occurredAt: '2026-10-01T14:00:00.000Z' }) }, 'inbound_not_fresh'],
    [{ message: message({ occurredAt: '' }) }, 'inbound_not_fresh'],
    [{ activities: [inboundRow('m0', { occurredAt: '2026-09-30T10:00:00Z' }), inboundRow()] }, 'not_first_prospect_message'],
    [{ activities: [inboundRow(), activity('human_response_sent', 'h1')] }, 'prior_human_or_warm_outbound'],
    [{ activities: [inboundRow(), activity('booking_link_sent', 'b1')] }, 'prior_human_or_warm_outbound'],
    [{ message: message({ messageId: '' }) }, 'identity_missing'],
  ];
  for (const [over, code] of cases) assert.equal(canaryPreScope({ ...base, ...over }).code, code, code);
});

test('daily cap: 3 attempts per Vancouver day, counted from durable pending records', () => {
  const pending = (id, at) => activity(PENDING_EVENT, `reply-decision-pending:C1:${id}`, { inboundMessageId: id }, { occurredAt: at });
  const today = vancouverDay(NOW);
  const rows = [pending('a', '2026-10-01T15:00:00Z'), pending('b', '2026-10-01T15:10:00Z')];
  assert.equal(canaryCapVerdict(rows, { day: today, messageId: 'c' }).allowed, true);
  rows.push(pending('c', '2026-10-01T15:20:00Z'));
  assert.equal(canaryCapVerdict(rows, { day: today, messageId: 'd' }).allowed, false);
  // The message's own pending record is not counted against it.
  assert.equal(canaryCapVerdict(rows, { day: today, messageId: 'c' }).used, 2);
  // Yesterday's attempts (Vancouver time) do not count.
  assert.equal(canaryCapVerdict([pending('y', '2026-10-01T06:00:00Z')], { day: today }).used, 0);
  assert.equal(CANARY.dailyCap, 3);
});

function gateFixture({ text = 'Interested, tell me more.', confidence = 0.95, slotIds = ['roles', 'geography'],
  extra = [], leadOver = {} } = {}) {
  const l = lead(leadOver);
  const activities = [inboundRow('m1', { content: text }),
    activity('reply_decision_recorded', 'reply-decision:C1:m1', { inboundMessageId: 'm1', leadId: 'C1',
      decisionId: 'reply-decision:C1:m1', finalClassification: 'INTERESTED', policyAction: QUALIFY_ACTION, executionStatus: 'recorded' },
    { occurredAt: '2026-10-01T15:41:00Z' }), ...extra];
  const state = buildConversationState({ lead: l, activities, now: NOW.toISOString(), config: { sequencesEnabled: true, sendingEnabled: true } });
  const input = buildAgentV2Input(state, 'm1');
  const raw = { version: SCHEMA_VERSION, actionId: 'SUGGEST_QUALIFICATION', handoffCode: 'NONE', factIds: [], slotIds,
    objectionType: 'NONE', evidenceRefs: [input.targetRef], templateId: 'QUALIFY', reasonCode: 'QUALIFICATION_GAP', confidence };
  const record = { messageId: 'm1', modelStatus: 'ok', decision: validateModelDecision(raw, input) };
  return { record, state, input };
}

test('canary decision gate: SUGGEST_QUALIFICATION, >= 0.90, 1–2 slots, no risk, first genuine-human message', () => {
  assert.deepEqual({ ...canaryDecisionGate(gateFixture()) }, { allowed: true, code: null });
  assert.equal(canaryDecisionGate(gateFixture({ confidence: 0.89 })).code, 'confidence_below_floor');
  assert.equal(canaryDecisionGate(gateFixture({ slotIds: ['roles', 'industries', 'geography'] })).code, 'decision_not_valid');
  assert.equal(canaryDecisionGate(gateFixture({ text: 'Interested — how do you get paid?' })).code, 'decision_not_valid');
  assert.equal(canaryDecisionGate(gateFixture({ leadOver: { clientId: '' } })).code, 'client_not_in_canary');
  const info = gateFixture();
  assert.equal(canaryDecisionGate({ ...info, record: { ...info.record, decision: { ...info.record.decision, actionId: 'SUGGEST_INFO' } } }).code,
    'action_not_in_canary');
  assert.equal(canaryDecisionGate({ ...info, record: { ...info.record, modelStatus: 'model_error' } }).code, 'decision_not_valid');
  const human = gateFixture({ extra: [activity('human_response_sent', 'h0', { gmailMessageId: 'h0', senderInboxId: 'primary', gmailThreadId: 't1' },
    { occurredAt: '2026-10-01T15:30:00Z' })] });
  assert.equal(canaryDecisionGate(human).allowed, false);
  assert.equal(canaryDecisionGate({ record: info.record }).code, 'state_unavailable');
});

// ── ops evidence ────────────────────────────────────────────────────────────
test('ops evidence counts attempts, sends, unresolved and reconciliation without prospect text', () => {
  const pending = (id, at) => activity(PENDING_EVENT, `reply-decision-pending:C1:${id}`, { leadId: 'C1', inboundMessageId: id }, { occurredAt: at });
  const decision = (id, code, status) => activity('reply_decision_recorded', `reply-decision:C1:${id}`,
    { inboundMessageId: id, executionCode: code, executionStatus: status });
  const rows = [
    pending('a', '2026-10-01T15:00:00Z'), activity('booking_link_sent', responseActionId('C1', 'a', QUALIFY_ACTION), {}, { occurredAt: '2026-10-01T15:01:00Z', content: 'secret body' }),
    decision('a', null, 'sent'),
    pending('b', '2026-10-01T15:10:00Z'), decision('b', 'agent_v2_kill_switch_disarmed', 'blocked'),
    pending('c', '2026-10-01T15:20:00Z'), decision('c', 'provider_ambiguous', 'failed'),
    pending('d', '2026-10-01T15:30:00Z'),
  ];
  const evidence = agentV2ExecutionEvidence(rows, { now: NOW });
  assert.equal(evidence.attemptsTotal, 4);
  assert.equal(evidence.attemptsToday, 4);
  assert.equal(evidence.sendsTotal, 1);
  assert.equal(evidence.sendsToday, 1);
  assert.equal(evidence.lastSendAt, '2026-10-01T15:01:00Z');
  assert.equal(evidence.unresolvedAttempts, 1);
  assert.equal(evidence.reconciliationRequired, 1);
  assert.deepEqual(evidence.recentDenyOrHandoff, { agent_v2_kill_switch_disarmed: 1, provider_ambiguous: 1 });
  assert.ok(!JSON.stringify(evidence).includes('secret body'));
});
