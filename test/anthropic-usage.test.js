'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  FEATURES, TOKEN_BUDGET_EXCEEDED, DEFAULT_HARD, DEFAULT_WARN,
  wrapCreateMessage, recordUsage, queryAnthropicUsage, listUsageRecords,
  resetAnthropicUsage, setAnthropicUsageConfigForTests, setSleepForTests,
  knownFeature,
} = require('../integrations/anthropic-usage');
const { registerAnthropicUsageRoutes } = require('../integrations/anthropic-usage-route');
const { classifyReply } = require('../integrations/reply-classifier');
const { classifyReply: classifyRoofingReply } = require('../integrations/roofing-survey-profile');
const { personalizeStaffingLead } = require('../integrations/staffing-personalization');
const { STAFFING_CAMPAIGN } = require('../integrations/staffing-campaign');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').split('\r\n').join('\n');

function fakeSend({ text = 'NEEDS_HUMAN', usage, failOn } = {}) {
  let calls = 0;
  const send = async () => {
    calls += 1;
    if (failOn && calls <= failOn.times) {
      const error = new Error(failOn.message || 'transient');
      error.status = failOn.status;
      error.code = failOn.code;
      throw error;
    }
    return {
      content: [{ type: 'text', text }],
      usage: usage || { input_tokens: 12, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    };
  };
  send.calls = () => calls;
  return send;
}

const staffingLead = {
  campaign: STAFFING_CAMPAIGN.name, campaignId: STAFFING_CAMPAIGN.id,
  company: 'Example Staffing', companyDomain: 'example.com',
  companyWebsite: 'https://example.com',
  emailStatus: 'verified (NOT catch-all) — Tier 1 send-ready',
  id: 'lead-1',
};

test.beforeEach(() => {
  resetAnthropicUsage();
  setAnthropicUsageConfigForTests({ warn: 0, hardLimit: 0, dir: null, databaseUrl: '' });
  setSleepForTests(async () => {});
});

test.afterEach(() => {
  resetAnthropicUsage();
  setSleepForTests(null);
});

test('1. every Anthropic call records usage', async () => {
  const send = fakeSend({ usage: { input_tokens: 40, output_tokens: 6 } });
  const create = wrapCreateMessage(send, { feature: FEATURES.cold_personalization, operation: 'opener' });
  await create({ model: 'claude-haiku-4-5', max_tokens: 60, messages: [{ role: 'user', content: 'hi' }] });
  const rows = listUsageRecords();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].success, true);
  assert.equal(rows[0].inputTokens, 40);
  assert.equal(rows[0].outputTokens, 6);
  assert.equal(rows[0].totalTokens, 46);
  assert.equal(send.calls(), 1);
});

test('2. feature tags are populated and never unknown when the call site is identified', async () => {
  const send = fakeSend();
  const create = wrapCreateMessage(send, { feature: FEATURES.staffing_personalization, operation: 'extract', campaign: STAFFING_CAMPAIGN.id, leadId: 'lead-1' });
  await create({ model: 'claude-haiku-4-5' });
  const row = listUsageRecords()[0];
  assert.equal(row.feature, 'staffing_personalization');
  assert.equal(row.operation, 'extract');
  assert.equal(row.campaign, STAFFING_CAMPAIGN.id);
  assert.equal(row.leadId, 'lead-1');
  assert.notEqual(row.feature, 'other');
  assert.equal(knownFeature('reply_classification'), 'reply_classification');
  assert.equal(knownFeature(''), 'other');
});

test('3. input/output tokens persist correctly including cache fields', async () => {
  const send = fakeSend({
    usage: { input_tokens: 100, output_tokens: 8, cache_creation_input_tokens: 20, cache_read_input_tokens: 5 },
  });
  await wrapCreateMessage(send, { feature: FEATURES.reply_question_answer, operation: 'answer' })({ model: 'claude-haiku-4-5' });
  const row = listUsageRecords()[0];
  assert.equal(row.inputTokens, 100);
  assert.equal(row.outputTokens, 8);
  assert.equal(row.cacheCreationInputTokens, 20);
  assert.equal(row.cacheReadInputTokens, 5);
  assert.equal(row.totalTokens, 133);
});

test('4. failed calls record failure without fake token values', async () => {
  const send = fakeSend({ failOn: { times: 5, status: 400, message: 'credit balance is too low' } });
  await assert.rejects(
    () => wrapCreateMessage(send, { feature: FEATURES.cold_personalization })({ model: 'claude-haiku-4-5' }),
    /credit balance/,
  );
  const rows = listUsageRecords();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].success, false);
  assert.equal(rows[0].inputTokens, 0);
  assert.equal(rows[0].outputTokens, 0);
  assert.equal(rows[0].totalTokens, 0);
  assert.equal(send.calls(), 1, 'permanent 4xx is not retried');
});

test('5. retry attempts are counted for transient errors only', async () => {
  const send = fakeSend({ failOn: { times: 1, status: 429, message: 'rate limited' }, usage: { input_tokens: 9, output_tokens: 1 } });
  const result = await wrapCreateMessage(send, { feature: FEATURES.site_research, operation: 'extract_owner_name' })({ model: 'claude-haiku-4-5' });
  assert.equal(result.content[0].text, 'NEEDS_HUMAN');
  const rows = listUsageRecords();
  assert.equal(send.calls(), 2);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].success, false);
  assert.equal(rows[0].retryNumber, 0);
  assert.equal(rows[0].totalTokens, 0);
  assert.equal(rows[1].success, true);
  assert.equal(rows[1].retryNumber, 1);
  assert.equal(rows[1].inputTokens, 9);
});

test('6. deterministic unsubscribe uses zero Claude calls', async () => {
  let calls = 0;
  const createMessage = async () => { calls += 1; throw new Error('model must not run'); };
  assert.equal(await classifyReply({ plainTextReply: 'Please unsubscribe me', createMessage }), 'UNSUBSCRIBE');
  assert.equal(await classifyReply({ plainTextReply: 'Please remove us from your mailing list.', createMessage }), 'UNSUBSCRIBE');
  assert.equal(calls, 0);
  assert.equal(listUsageRecords().length, 0);
});

test('7. deterministic not-interested uses zero Claude calls', async () => {
  let calls = 0;
  const createMessage = async () => { calls += 1; throw new Error('model must not run'); };
  assert.equal(await classifyReply({ plainTextReply: 'Not interested', createMessage }), 'NOT_INTERESTED');
  assert.equal(await classifyReply({ plainTextReply: 'No thanks, not interested', createMessage }), 'NOT_INTERESTED');
  assert.equal(calls, 0);
  assert.equal(listUsageRecords().length, 0);
});

test('8. duplicate processing does not double-call Claude', async () => {
  const send = fakeSend({ usage: { input_tokens: 4, output_tokens: 1 } });
  const tracked = wrapCreateMessage(send, { feature: FEATURES.reply_classification, operation: 'classify' });
  const nested = wrapCreateMessage(tracked, { feature: FEATURES.reply_classification, leadId: 'same' });
  await nested({ model: 'claude-haiku-4-5' });
  assert.equal(send.calls(), 1);
  assert.equal(listUsageRecords().length, 1);

  let modelCalls = 0;
  const createMessage = async () => { modelCalls += 1; throw new Error('model must not run'); };
  await classifyReply({ plainTextReply: 'unsubscribe', createMessage });
  await classifyReply({ plainTextReply: 'unsubscribe', createMessage });
  assert.equal(modelCalls, 0);
});

test('9. warning threshold logs loudly but does not block', async () => {
  setAnthropicUsageConfigForTests({ warn: 10, hardLimit: 0, dir: null, databaseUrl: '' });
  await recordUsage({
    feature: FEATURES.staffing_personalization, model: 'claude-haiku-4-5',
    success: true, inputTokens: 20, outputTokens: 1,
  });
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(String(args[0]));
  try {
    const send = fakeSend({ usage: { input_tokens: 5, output_tokens: 1 } });
    await wrapCreateMessage(send, { feature: FEATURES.cold_personalization })({ model: 'claude-haiku-4-5' });
  } finally { console.warn = original; }
  assert.equal(listUsageRecords().filter(row => row.success).length, 2);
  assert.ok(warnings.some(line => /anthropic_daily_token_warn/.test(line)));
});

test('10. optional hard limit fails closed for non-critical generation', async () => {
  assert.equal(DEFAULT_HARD, 0);
  setAnthropicUsageConfigForTests({ warn: 10, hardLimit: 30, dir: null, databaseUrl: '' });
  await recordUsage({
    feature: FEATURES.staffing_personalization, model: 'claude-haiku-4-5',
    success: true, inputTokens: 40, outputTokens: 0,
  });
  const send = fakeSend();
  await assert.rejects(
    () => wrapCreateMessage(send, { feature: FEATURES.cold_personalization })({ model: 'claude-haiku-4-5' }),
    error => error.code === TOKEN_BUDGET_EXCEEDED && error.failClosed === true,
  );
  assert.equal(send.calls(), 0);
  const failed = listUsageRecords().filter(row => !row.success);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].totalTokens, 0);
  assert.equal(failed[0].errorCode, TOKEN_BUDGET_EXCEEDED);
});

test('11. reply safety still works when Claude is unavailable or over budget', async () => {
  setAnthropicUsageConfigForTests({ warn: 10, hardLimit: 5, dir: null, databaseUrl: '' });
  await recordUsage({
    feature: FEATURES.cold_personalization, model: 'claude-haiku-4-5',
    success: true, inputTokens: 20, outputTokens: 0,
  });
  let calls = 0;
  const createMessage = async () => { calls += 1; throw new Error('should not be called'); };
  assert.equal(await classifyReply({
    plainTextReply: 'zzzz qqqq nnnn',
    createMessage,
  }), 'NEEDS_HUMAN');
  assert.equal(calls, 0, 'over-budget classification must not call Claude');
  assert.equal(await classifyReply({
    plainTextReply: 'Please unsubscribe me',
    createMessage,
  }), 'UNSUBSCRIBE');
  const roofing = await classifyRoofingReply({
    replyText: 'Hard to say',
    createMessage,
  });
  assert.equal(roofing.category, 'ambiguous');
  assert.equal(roofing.requires_human_review, true);
  assert.equal(calls, 0);
});

test('staffing personalization records tagged extract/audit calls', async () => {
  const { SYSTEM, FACT_AUDIT_SYSTEM, AUDIT_SYSTEM } = require('../integrations/staffing-personalization');
  const page = { url: 'https://example.com/services', title: 'Example Staffing', text: 'Example Staffing supplies welders, machinists and electricians to manufacturers and serves employers across Northeast Ohio.\nOur headquarters is in Houston.' };
  const facts = [
    { id: 'r', kind: 'role', value: 'welders', evidenceIds: ['p0b0'] },
    { id: 'r2', kind: 'role', value: 'machinists', evidenceIds: ['p0b0'] },
    { id: 'r3', kind: 'role', value: 'electricians', evidenceIds: ['p0b0'] },
    { id: 'm', kind: 'employer_market', value: 'manufacturing', evidenceIds: ['p0b0'] },
    { id: 'g', kind: 'geography', value: 'Northeast Ohio', evidenceIds: ['p0b0'] },
  ];
  const extract = {
    companyIdentityConfirmed: true, icpFit: 'FIT', fitEvidenceIds: ['p0b0'], researchNotes: 'Industrial staffing service.',
    facts, hyperPersonalizedOpening: 'Saw you place welders and machinists with manufacturers across Northeast Ohio.', usedFactIds: ['r', 'r2', 'm', 'g'],
  };
  const checks = Object.fromEntries([
    'oneSentence','noCompliments','supportedGeography','supportedRoles','supportedIndustries',
    'noRepetitiveWording','grammar','noCandidateSourcing','marketReferent','reasonableLength','companyIdentity',
    'staffingBusiness','naturalEmployerLanguage','supportedByValidatedFacts','usedFactIdsComplete',
  ].map(k => [k, true]));
  const result = await personalizeStaffingLead(staffingLead, {
    researchCompany: async () => ({ pages: [page], failures: [], reviewRequired: false }),
    createMessage: async args => {
      let payload;
      if (args.system === SYSTEM) payload = extract;
      else if (args.system === FACT_AUDIT_SYSTEM) payload = {
        companyIdentityConfirmed: true, icpFit: 'FIT', fitEvidenceIds: ['p0b0'], reason: 'Services explicitly match',
        facts: JSON.parse(args.messages[0].content).candidateFacts.map(f => ({
          id: f.id, kind: f.kind, valid: true, staffingRelationship: true,
          specificRole: f.kind === 'role', explicitServiceTerritory: f.kind === 'geography',
        })),
      };
      else if (args.system === AUDIT_SYSTEM) payload = { checks, companySpecific: true, rejectedFactIds: [], reasons: [] };
      else throw new Error('Unexpected model stage');
      return { content: [{ type: 'text', text: JSON.stringify(payload) }], usage: { input_tokens: 11, output_tokens: 4 } };
    },
  });
  assert.equal(result.confidence, 'HIGH');
  const rows = listUsageRecords();
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => row.operation), ['extract', 'fact_audit', 'opening_audit']);
  assert.ok(rows.every(row => row.feature === 'staffing_personalization'));
  assert.ok(rows.every(row => row.campaign === STAFFING_CAMPAIGN.id));
  assert.equal(rows[0].inputTokens, 11);
  assert.equal(rows[0].outputTokens, 4);
});

test('usage endpoint is read-only and returns grouped totals', async () => {
  await recordUsage({
    feature: FEATURES.staffing_personalization, operation: 'extract', model: 'claude-haiku-4-5',
    campaign: STAFFING_CAMPAIGN.id, success: true, inputTokens: 1000, outputTokens: 50, leadId: 'a',
  });
  await recordUsage({
    feature: FEATURES.reply_classification, operation: 'classify', model: 'claude-haiku-4-5',
    campaign: 'dental', success: true, inputTokens: 20, outputTokens: 2, leadId: 'b',
  });
  const handlers = {};
  const app = { get: (url, _auth, fn) => { handlers[url] = fn; } };
  registerAnthropicUsageRoutes(app, (_req, _res, next) => next());
  let payload;
  await handlers['/api/ops/anthropic-usage']({ query: { date: 'today' } }, { json: value => { payload = value; }, status() { return this; } });
  assert.equal(payload.totals.requests, 2);
  assert.equal(payload.totals.inputTokens, 1020);
  assert.equal(payload.totals.outputTokens, 52);
  assert.equal(payload.totals.totalTokens, 1072);
  assert.equal(payload.averages.inputTokensPerRequest, 510);
  assert.equal(payload.maxInputTokensPerRequest, 1000);
  assert.equal(payload.byFeature[0].key, 'staffing_personalization');
  assert.ok(payload.byModel.some(row => row.key === 'claude-haiku-4-5'));
  assert.ok(payload.byCampaign.some(row => row.key === STAFFING_CAMPAIGN.id));
  assert.equal(payload.highestTokenOperations[0].inputTokens, 1000);
  assert.equal(payload.limits.hardLimit, null);

  const routeSrc = read('integrations/anthropic-usage-route.js');
  assert.doesNotMatch(routeSrc, /app\.(post|put|patch|delete)\(/);
  assert.match(read('server.js'), /registerAnthropicUsageRoutes/);
});

test('hard limit stays disabled by default and warn default is observational', () => {
  const env = read('.env.example');
  assert.match(env, /ANTHROPIC_DAILY_TOKEN_HARD_LIMIT=0/);
  assert.match(env, /ANTHROPIC_DAILY_TOKEN_WARN=2000000/);
  assert.equal(DEFAULT_WARN, 2_000_000);
  assert.equal(DEFAULT_HARD, 0);
});

test('every production Anthropic call site is tracked with an explicit feature', () => {
  const files = [
    'outreach-agent.js',
    'integrations/reply-classifier.js',
    'integrations/staffing-personalization.js',
    'integrations/roofing-survey-profile.js',
    'enrich-names.js',
  ];
  for (const file of files) {
    const src = read(file);
    assert.match(src, /wrapCreateMessage|createTrackedAnthropic/, `${file} must record usage`);
    assert.match(src, /FEATURES/, `${file} must tag a feature`);
  }
  const agent = read('outreach-agent.js');
  assert.match(agent, /ANTHROPIC_FEATURES\.cold_personalization/);
  assert.match(agent, /ANTHROPIC_FEATURES\.reply_question_answer/);
  assert.match(agent, /boundedSite = String\(siteText \|\| ''\)\.slice\(0, 1500\)/);
  assert.match(agent, /createTrackedAnthropic/);
  assert.match(agent, /messageId: message\.messageId/);
  assert.match(agent, /threadId: message\.threadId/);
  assert.doesNotMatch(agent, /new Anthropic\(/);
  assert.match(read('integrations/reply-classifier.js'), /messageId,/);
  assert.match(read('server.js'), /messageId: eventRow\.eventKey/);
});

test('JSONL persistence stores metadata only and respects retention files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anthropic-usage-'));
  setAnthropicUsageConfigForTests({ warn: 0, hardLimit: 0, dir, databaseUrl: '' });
  const send = fakeSend({ usage: { input_tokens: 7, output_tokens: 2 } });
  await wrapCreateMessage(send, { feature: FEATURES.cold_personalization, operation: 'opener', leadId: 'x' })({
    model: 'claude-haiku-4-5',
    system: 'secret system prompt that must not be logged',
    messages: [{ role: 'user', content: 'secret user prompt' }],
  });
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  const dumped = fs.readFileSync(path.join(dir, files[0]), 'utf8');
  assert.doesNotMatch(dumped, /secret system prompt|secret user prompt|sk-ant/);
  assert.match(dumped, /cold_personalization/);
  const summary = await queryAnthropicUsage({ date: 'today' });
  assert.equal(summary.totals.requests, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('invalid usage date range is rejected', async () => {
  await assert.rejects(() => queryAnthropicUsage({ date: 'not-a-date' }), error => error.code === 'INVALID_DATE');
});

test('usage query supports an inclusive from/to date range', async () => {
  await recordUsage({
    feature: FEATURES.cold_personalization, model: 'claude-haiku-4-5',
    occurredAt: '2026-09-10T19:00:00.000Z', success: true, inputTokens: 10, outputTokens: 1,
  });
  await recordUsage({
    feature: FEATURES.staffing_personalization, model: 'claude-haiku-4-5',
    occurredAt: '2026-09-17T19:00:00.000Z', success: true, inputTokens: 20, outputTokens: 2,
  });
  const summary = await queryAnthropicUsage({ from: '2026-09-10', to: '2026-09-17' });
  assert.equal(summary.from, '2026-09-10');
  assert.equal(summary.to, '2026-09-17');
  assert.equal(summary.date, null);
  assert.equal(summary.totals.requests, 2);
  assert.equal(summary.totals.inputTokens, 30);
  assert.ok(summary.byFeature.some(row => row.key === 'staffing_personalization'));
});

test('ambiguous reply classification records leadId messageId and threadId', async () => {
  const send = fakeSend({ text: 'NEEDS_HUMAN', usage: { input_tokens: 8, output_tokens: 1 } });
  assert.equal(await classifyReply({
    plainTextReply: 'zzzz qqqq nnnn',
    createMessage: send,
    lead: { id: 'CE-1', company: 'Acme', email: 'a@x.com' },
    campaign: { id: 'dental' },
    messageId: 'msg-1',
    threadId: 'thr-1',
  }), 'NEEDS_HUMAN');
  assert.equal(send.calls(), 1);
  const row = listUsageRecords()[0];
  assert.equal(row.feature, 'reply_classification');
  assert.equal(row.leadId, 'CE-1');
  assert.equal(row.campaign, 'dental');
  assert.equal(row.messageId, 'msg-1');
  assert.equal(row.threadId, 'thr-1');
  assert.equal(row.inputTokens, 8);
});
