'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAgent } = require('../integrations/research-icp/agent');
const { config, VERSION } = require('../integrations/research-icp/config');
const { CLASSIFICATIONS, validate, outputSchema, emptyResearch, validateResearch, validateFit } = require('../integrations/research-icp/schema');
const { normalizeInput, compareHistorical } = require('../integrations/research-icp/input');
const { collectSources } = require('../integrations/research-icp/sources');
const { resolveCampaign, STAFFING_ID } = require('../integrations/research-icp/campaigns');
const { createStore } = require('../integrations/research-icp/store');
const { readLead } = require('../integrations/research-icp/read-lead');
const { registerResearchRoutes } = require('../integrations/research-icp/routes');

const env = { AGENT_RESEARCH_ENABLED: 'true', AGENT_RESEARCH_API_KEY: 'test-dedicated-key' };
const input = () => ({ company: { name: 'Example', domain: 'example.com' }, campaign: { id: 'custom', icp: { targetCompanyTypes: ['staffing'] } } });
const sources = [{ id: 'https://example.com/services', sourceType: 'website', text: 'Example is a staffing agency. We place welders for manufacturers.' }];
const facts = () => ({ ...emptyResearch(), companyType: 'staffing agency', rolesStaffed: ['welders'],
  evidence: [
    { field: 'companyType', claim: 'staffing agency', source: sources[0].id, sourceType: 'website', quote: 'Example is a staffing agency.', confidence: 0.9 },
    { field: 'rolesStaffed', claim: 'welders', source: sources[0].id, sourceType: 'website', quote: 'We place welders for manufacturers.', confidence: 0.9 },
  ] });
const fit = (classification = 'HIGH') => ({ campaignId: 'custom', classification, confidence: 0.9,
  reasons: ['Source establishes the service.'], disqualifiers: classification === 'ICP_MISMATCH' ? ['Affirmatively excluded business.'] : [], evidenceIndexes: [0] });
const message = value => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(value) }],
  model: 'test-model', usage: { input_tokens: 10, output_tokens: 20 } });
function harness(options = {}) {
  const rows = [], calls = [];
  const store = { async start(row) { rows.push(structuredClone(row)); },
    async finish(id, row) { Object.assign(rows.find(r => r.run_id === id), structuredClone(row)); },
    async get(id) { return rows.find(r => r.run_id === id); } };
  const agent = createAgent({ env, store, logger: {},
    research: async () => ({ sources, warnings: [], retrievalFailed: false, insufficient: false }),
    createMessage: async payload => { calls.push(payload); return message(calls.length % 2 ? facts() : fit()); }, ...options });
  return { agent, rows, calls, store };
}

for (const classification of CLASSIFICATIONS) test(`strict output schema accepts ${classification}`, () => {
  assert.equal(validate({ agent: 'research_icp', version: VERSION, mode: 'shadow',
    companyResearch: facts(), campaignFit: fit(classification), warnings: [] }, outputSchema).campaignFit.classification, classification);
});
test('successful run stores version, evidence, input/ICP snapshot, model, tokens and comparison', async () => {
  const h = harness();
  const result = await h.agent.run({ ...input(), historicalDecision: 'HIGH' });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.comparison.agreement, true);
  assert.equal(h.rows[0].version, VERSION);
  assert.deepEqual(h.rows[0].sources, sources);
  assert.equal(h.rows[0].usage.length, 2);
  assert.equal(h.rows[0].usage[0].model, 'test-model');
  assert.equal(h.calls[0].tools, undefined);
  assert.equal(JSON.parse(h.calls[0].messages[0].content).campaign, undefined);
  assert.deepEqual(JSON.parse(h.calls[1].messages[0].content).campaign.icp, input().campaign.icp);
});
for (const classification of ['MEDIUM', 'ICP_MISMATCH', 'INSUFFICIENT_EVIDENCE']) test(`agent persists ${classification}`, async () => {
  let count = 0;
  const h = harness({ createMessage: async () => message(++count === 1 ? facts() : fit(classification)) });
  const result = await h.agent.run(input());
  assert.equal(result.result.campaignFit.classification, classification);
  assert.equal(h.rows[0].status, 'succeeded');
});
for (const [name, response, code] of [
  ['malformed JSON', { stop_reason: 'end_turn', content: [{ type: 'text', text: '{oops' }] }, 'MALFORMED_MODEL_JSON'],
  ['truncated JSON', { ...message(facts()), stop_reason: 'max_tokens' }, 'INVALID_MODEL_OUTPUT'],
  ['tool use', { ...message(facts()), content: [{ type: 'tool_use', name: 'send_email' }] }, 'INVALID_MODEL_OUTPUT'],
  ['extra model properties', message({ ...facts(), action: 'queue' }), 'INVALID_MODEL_OUTPUT'],
]) test(`${name} fails safely and is audited`, async () => {
  const h = harness({ createMessage: async () => response });
  const result = await h.agent.run(input());
  assert.equal(result.errorCode, code);
  assert.equal(h.rows[0].status, 'failed');
  assert.equal(result.result.campaignFit.classification, 'INSUFFICIENT_EVIDENCE');
});
test('invented classification cannot escape the server validator', async () => {
  let n = 0;
  const h = harness({ createMessage: async () => message(++n === 1 ? facts() : fit('APPROVED')) });
  assert.equal((await h.agent.run(input())).errorCode, 'INVALID_MODEL_OUTPUT');
});
test('missing dedicated key never falls back to the Conversation Agent key', async () => {
  const h = harness({ env: { AGENT_RESEARCH_ENABLED: 'true', ANTHROPIC_API_KEY: 'not-for-research' } });
  assert.equal((await h.agent.run(input())).errorCode, 'MISSING_RESEARCH_API_KEY');
  assert.equal(h.calls.length, 0);
  assert.equal(h.rows[0].status, 'failed');
});
test('missing ICP fails before any model call', async () => {
  const h = harness();
  assert.equal((await h.agent.run({ company: { name: 'Example' }, campaign: { id: 'unknown' } })).errorCode, 'MISSING_CAMPAIGN_ICP');
  assert.equal(h.calls.length, 0);
});
test('provider failure is recorded with sanitized error and usage from earlier calls', async () => {
  let n = 0;
  const h = harness({ createMessage: async () => { if (++n === 1) return message(facts()); throw new Error('secret provider request test-dedicated-key'); } });
  const result = await h.agent.run(input());
  assert.equal(result.errorCode, 'MODEL_PROVIDER_FAILURE');
  assert.equal(result.result.campaignFit.classification, 'RETRIEVAL_FAILURE');
  assert.equal(result.usage.length, 1);
  assert.doesNotMatch(JSON.stringify([result, h.rows]), /test-dedicated-key/);
});
test('retrieval failure is different from missing evidence and mismatch', async () => {
  for (const failed of [true, false]) {
    const h = harness({ research: async () => ({ sources: [], warnings: [], retrievalFailed: failed, insufficient: true }) });
    const result = await h.agent.run(input());
    assert.equal(result.result.campaignFit.classification, failed ? 'RETRIEVAL_FAILURE' : 'INSUFFICIENT_EVIDENCE');
    assert.equal(h.calls.length, 0);
  }
});
test('model cannot declare a transport retrieval failure after successful research', async () => {
  let n = 0;
  const h = harness({ createMessage: async () => message(++n === 1 ? facts() : fit('RETRIEVAL_FAILURE')) });
  assert.equal((await h.agent.run(input())).errorCode, 'INVALID_MODEL_OUTPUT');
});
test('evidence must reference a real source, exact quote and matching claimed field', () => {
  assert.deepEqual(validateResearch(facts(), sources), facts());
  for (const patch of [{ source: 'https://invented.com' }, { quote: 'We place surgeons.' }, { sourceType: 'existing_data' }, { field: 'services' }, { claim: '' }]) {
    const research = facts(); Object.assign(research.evidence[0], patch);
    assert.throws(() => validateResearch(research, sources));
  }
  const research = facts(); research.geographies = ['Canada'];
  assert.throws(() => validateResearch(research, sources), /UNCITED/);
});
test('confidence accepts endpoints and rejects out-of-range/non-numeric values', () => {
  for (const value of [0, 1]) { const research = facts(); research.evidence[0].confidence = value; validateResearch(research, sources); validateFit({ ...fit(), confidence: value }, 'custom', facts()); }
  for (const value of [-0.01, 1.01, NaN, Infinity, '0.9', null]) {
    assert.throws(() => validateFit({ ...fit(), confidence: value }, 'custom', facts()));
    const research = facts(); research.evidence[0].confidence = value;
    assert.throws(() => validateResearch(research, sources));
  }
});
test('fit must cite real evidence and bind to the requested campaign', () => {
  for (const patch of [{ campaignId: 'other' }, { evidenceIndexes: [999] }, { evidenceIndexes: [] }, { evidenceIndexes: [-1] }, { evidenceIndexes: [0.5] }]) {
    assert.throws(() => validateFit({ ...fit(), ...patch }, 'custom', facts()));
  }
  assert.throws(() => validateFit({ ...fit('ICP_MISMATCH'), disqualifiers: [] }, 'custom', facts()));
});
test('HIGH cannot rely exclusively on Apollo/database evidence', () => {
  const research = facts(); research.evidence.forEach(e => { e.sourceType = 'existing_data'; });
  assert.throws(() => validateFit(fit(), 'custom', research));
});
test('disabled/default config and non-shadow mode cannot start runs or call tools', async () => {
  for (const customEnv of [{}, { ...env, AGENT_RESEARCH_MODE: 'autonomous' }]) {
    const h = harness({ env: customEnv });
    await assert.rejects(h.agent.run(input()), /RESEARCH_DISABLED|SHADOW_MODE_REQUIRED/);
    assert.equal(h.rows.length + h.calls.length, 0);
  }
  assert.equal(config({}).model, 'claude-haiku-4-5');
  assert.equal(config({ ANTHROPIC_HAIKU_MODEL: 'shared-alias' }).model, 'shared-alias');
  assert.equal(config({ AGENT_RESEARCH_MODEL: 'agent-model' }).model, 'agent-model');
});
test('historical labels compare literally; held/accepted/audit failure never become fit labels', () => {
  assert.equal(compareHistorical('HIGH', fit()).agreement, true);
  assert.equal(compareHistorical('MEDIUM', fit()).agreement, false);
  for (const label of ['accepted', 'held', 'REVIEW_REQUIRED', 'RETRY_REQUIRED', 'APPROVED', 'audit failure', null]) assert.equal(compareHistorical(label, fit()).agreement, null);
});
test('input accepts optional company fields and rejects malformed/private/mismatched URLs', () => {
  assert.equal(normalizeInput({ company: { name: 'Example' } }).leadId, null);
  assert.equal(normalizeInput({ company: { domain: 'www.example.com' } }).company.domain, 'example.com');
  for (const raw of [{ company: 'string' }, { campaign: { icp: [] } }, { company: { website: 'http://127.0.0.1' } },
    { company: { website: 'https://one.com', domain: 'two.com' } }, { company: { existingData: [] } }]) assert.throws(() => normalizeInput(raw));
});
test('campaign policy preserves later staffing requirements and supports unrelated ICPs', () => {
  const icp = resolveCampaign({ id: STAFFING_ID }).icp;
  assert.match(JSON.stringify(icp), /three worker-level roles/);
  assert.match(JSON.stringify(icp), /35%/);
  assert.match(JSON.stringify(icp), /direct-hire-only/);
  assert.match(JSON.stringify(icp), /professional services alongside/);
  const different = { id: 'software', icp: { targetCompanyTypes: ['software publisher'] } };
  assert.deepEqual(resolveCampaign(different).icp, different.icp);
  icp.targetCompanyTypes.push('mutation');
  assert.equal(resolveCampaign({ id: STAFFING_ID }).icp.targetCompanyTypes.includes('mutation'), false);
  assert.equal(resolveCampaign({ name: 'Industrial Staffing — Employer Acquisition' }).id, STAFFING_ID);
});
test('model cannot transfer researched identity from another domain', async () => {
  const otherSources = [...sources, { id: 'input:existingData', sourceType: 'existing_data', text: 'wrong.example.org' }];
  const research = facts(); research.domain = 'wrong.example.org';
  research.evidence.push({ field: 'domain', claim: research.domain, quote: research.domain, source: 'input:existingData', sourceType: 'existing_data', confidence: 1 });
  const h = harness({ research: async () => ({ sources: otherSources, warnings: [] }), createMessage: async () => message(research) });
  const result = await h.agent.run(input());
  assert.equal(result.errorCode, 'INVALID_MODEL_OUTPUT');
  assert.deepEqual(result.result.companyResearch, emptyResearch());
});
test('malformed stored historical metadata cannot prevent finalizing a run', async () => {
  const h = harness({ loadLead: async () => ({ id: 'a', company: 'Example', historicalDecision: { invalid: true } }),
    research: async () => ({ sources: [], warnings: [], insufficient: true }) });
  const result = await h.agent.run({ ...input(), leadId: 'a' });
  assert.equal(h.rows[0].status, 'succeeded');
  assert.equal(result.comparison.agreement, null);
  assert.ok(result.result.warnings.includes('HISTORICAL_DECISION_UNREADABLE'));
});
test('neutral retrieval keeps existing Apollo data and bounds website calls', async () => {
  const calls = [];
  const company = normalizeInput({ company: { domain: 'example.com', existingData: { apollo: { industry: 'Staffing' } } } }).company;
  const retrieved = await collectSources(company, { fetch: async url => {
    calls.push(url); return { url, text: 'Company service evidence', links: Array.from({ length: 10 }, (_, i) => ({ href: `/services/${i}`, label: 'Services' })) };
  } });
  assert.equal(calls.length, 4);
  assert.equal(retrieved.sources.find(s => s.id === 'input:existingData').sourceType, 'existing_data');
  const blocked = await collectSources(company, { fetch: async () => { throw new Error('blocked'); } });
  assert.equal(blocked.retrievalFailed, false);
  assert.equal(blocked.insufficient, false);
  const none = await collectSources({ ...company, existingData: {} }, { fetch: async () => { throw new Error('blocked'); } });
  assert.equal(none.retrievalFailed, true);
});
test('historical lead identity is loaded read-only and request overrides cannot replace it', async () => {
  const lead = Object.freeze({ id: 'lead-1', company: 'Stored Company', website: 'https://example.com',
    intendedCampaignVersion: STAFFING_ID, stage: 'Held', senderInboxId: 'unchanged', notes: 'MANUAL HOLD' });
  const before = JSON.stringify(lead);
  const h = harness({ loadLead: async () => lead, research: async () => ({ sources: [], warnings: [], insufficient: true }) });
  await h.agent.run({ leadId: 'lead-1', company: { name: 'Forged' }, historicalDecision: 'accepted' });
  assert.equal(h.rows[0].company, 'Stored Company');
  assert.equal(h.rows[0].campaign_id, STAFFING_ID);
  assert.equal(h.rows[0].comparison.agreement, null);
  assert.equal(JSON.stringify(lead), before);
});
test('failed lead lookup is durably recorded', async () => {
  for (const loadLead of [async () => null, async () => { throw new Error('secret'); }]) {
    const h = harness({ loadLead });
    assert.equal((await h.agent.run({ leadId: 'missing' })).result.campaignFit.classification, 'RETRIEVAL_FAILURE');
    assert.equal(h.rows[0].status, 'failed');
  }
});
test('company research can be reused for another campaign without research/extraction or history overwrite', async () => {
  const h = harness();
  const first = await h.agent.run(input());
  const original = structuredClone(h.rows[0]);
  const second = createAgent({ env, store: h.store, logger: {}, research: async () => assert.fail('must reuse'),
    createMessage: async payload => { assert.match(payload.system, /Evaluate only/); return message({ ...fit(), campaignId: 'other' }); } });
  const result = await second.run({ ...input(), campaign: { id: 'other', icp: { targetCompanyTypes: ['industrial supplier'] } }, researchRunId: first.runId });
  assert.equal(result.status, 'succeeded');
  assert.equal(h.rows.length, 2);
  assert.deepEqual(h.rows[0], original);
  assert.equal(h.rows[1].research_run_id, first.runId);
  const wrong = await second.run({ ...input(), company: { domain: 'different.com' }, researchRunId: first.runId });
  assert.equal(wrong.errorCode, 'INVALID_RESEARCH_REUSE');
});
test('storage failure before reservation prevents all paid work; final failure is explicit', async () => {
  const h = harness({ store: { start: async () => { throw new Error('RESEARCH_STORAGE_UNAVAILABLE'); } } });
  await assert.rejects(h.agent.run(input()), /STORAGE/);
  assert.equal(h.calls.length, 0);
  const h2 = harness({ store: { start: async () => {}, finish: async () => { throw new Error('secret'); } } });
  await assert.rejects(h2.agent.run(input()), /RESEARCH_STORAGE_UNAVAILABLE/);
});
test('read adapter reads the authoritative backend and never initializes/mirrors Sheets', async () => {
  const supaEnv = { SUPABASE_OUTREACH_WRITES: 'supabase' };
  const lead = { id: 'a', company: 'Stored' };
  assert.deepEqual(await readLead('a', { env: supaEnv, getSupabase: async () => ({ ok: true, lead }), readSheet: async () => assert.fail() }), lead);
  assert.equal((await readLead('a', { env: {}, readSheet: async () => [['id'], ['a', 'Stored']] })).company, 'Stored');
  await assert.rejects(readLead('a', { env: supaEnv, getSupabase: async () => ({ ok: false }), readSheet: async () => assert.fail() }), /LEAD_READ_FAILED/);
});
test('complete execution HTTP writes are confined to the audit table, with encoded identifiers', async () => {
  const requests = [], rows = [];
  const store = createStore({ env: { SUPABASE_URL: 'https://database.example', SUPABASE_SECRET_KEY: 'secret' }, fetchImpl: async (url, options) => {
    requests.push({ url, method: options.method });
    assert.equal(new URL(url).pathname, '/rest/v1/research_icp_runs');
    const body = options.body ? JSON.parse(options.body) : null;
    if (options.method === 'POST') { rows.push(body); return { ok: true, json: async () => [body] }; }
    if (options.method === 'PATCH') { Object.assign(rows[0], body); return { ok: true, json: async () => rows }; }
    return { ok: true, json: async () => [] };
  } });
  const h = harness({ store });
  await h.agent.run(input());
  assert.deepEqual(requests.map(r => r.method), ['POST', 'PATCH']);
  assert.match(requests[1].url, /status=eq.running/);
  await store.list({ leadId: 'x&status=eq.live', campaignId: 'campaign' });
  assert.equal(new URL(requests[2].url).searchParams.get('lead_id'), 'eq.x&status=eq.live');
  assert.equal(new URL(requests[2].url).searchParams.has('status'), false);
});
test('audit storage fails closed on missing configuration, HTTP errors or zero finalized rows', async () => {
  const missing = createStore({ env: {}, fetchImpl: async () => assert.fail('no network without config') });
  await assert.rejects(missing.start({ run_id: 'a' }), /STORAGE/);
  const databaseEnv = { SUPABASE_URL: 'https://database.example', SUPABASE_SECRET_KEY: 'secret' };
  const failed = createStore({ env: databaseEnv, fetchImpl: async () => ({ ok: false, text: async () => 'sensitive database details' }) });
  await assert.rejects(failed.get('a'), /^Error: RESEARCH_STORAGE_UNAVAILABLE$/);
  const finalized = createStore({ env: databaseEnv, fetchImpl: async () => ({ ok: true, json: async () => [] }) });
  await assert.rejects(finalized.finish('a', {}), /STORAGE/);
});
test('module dependency boundary exposes no sending, queue or Conversation Agent capability', () => {
  const root = path.resolve(__dirname, '../integrations/research-icp');
  const allowed = new Set(['../staffing-research', '../staffing-campaign', '../supabase-mirror', '../outreach-state']);
  for (const file of fs.readdirSync(root).filter(f => f.endsWith('.js'))) {
    const content = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of content.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
      if (match[1].startsWith('../')) assert.ok(allowed.has(match[1]), `unexpected capability in ${file}: ${match[1]}`);
    }
    assert.doesNotMatch(content, /applyLeadChange|mirrorOutreach|sendEmail|enqueue|bookMeeting|spawn\(/);
  }
  const readSource = fs.readFileSync(path.join(root, 'read-lead.js'), 'utf8');
  assert.match(readSource, /spreadsheets\.readonly/);
  assert.doesNotMatch(readSource, /\.append\(|\.update\(|\.batchUpdate\(|ensureColdEmailSheet/);
  const server = fs.readFileSync(path.resolve(__dirname, '../server.js'), 'utf8');
  assert.ok(server.indexOf('app.use(requireAuth)') < server.indexOf("require('./integrations/research-icp/routes')"));
});

async function serve(t, options = {}) {
  const express = require('express');
  const app = express(); app.use(express.json());
  const auth = (req, res, next) => req.headers.authorization === 'Basic test' ? next() : res.status(401).end();
  registerResearchRoutes(app, auth, { env, store: { list: async () => [], get: async () => null }, ...options });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return (url, data, authenticated = true) => fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: 'Basic test' } : {}) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
}
test('manual endpoints require auth, bound batch size and return structured results', async t => {
  let count = 0;
  const request = await serve(t, { agent: { run: async () => { count++; return { status: 'succeeded', result: { mode: 'shadow' } }; } } });
  const route = '/api/agents/research/test';
  assert.equal((await request(route, input(), false)).status, 401);
  assert.equal((await request('/api/agents/research/runs', undefined, false)).status, 401);
  assert.equal((await request(route, { items: Array(6).fill(input()) })).status, 422);
  const response = await request(route, { items: [input(), input()] });
  assert.equal((await response.json()).runs.length, 2);
  assert.equal(count, 2);
});
test('manual endpoint refuses overlapping executions and releases its lock', async t => {
  let finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const request = await serve(t, { agent: { run: async () => { entered(); return new Promise(resolve => { finish = resolve; }); } } });
  const first = request('/api/agents/research/test', input());
  await started;
  assert.equal((await request('/api/agents/research/test', input())).status, 409);
  finish({ status: 'succeeded' });
  assert.equal((await first).status, 200);
});
