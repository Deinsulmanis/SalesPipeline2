'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SmartleadClient, SmartleadError } = require('../integrations/smartlead-client');
const { normalizeEvent } = require('../integrations/smartlead-events');
const { classifyReply } = require('../integrations/reply-classifier');
const { normalizeEmail, buildEventKey, buildMappingKey, mappingMatchesEvent, leadEligibility, mutationDecision, canApplyProviderTransition, safeAuditPayload, eventStateTransition, executeEventAttempt, KeyedLock, fetchAllCampaignLeads, aggregateProviderStats, reconciliationHealth } = require('../integrations/smartlead-safety');

test('event keys prefer request ID and otherwise hash exact body', () => {
  const a = Buffer.from('{"a":1}'), b = Buffer.from('{"a":2}');
  assert.equal(buildEventKey(a, 'req-1'), buildEventKey(b, 'req-1'));
  assert.equal(buildEventKey(a), buildEventKey(Buffer.from('{"a":1}')));
  assert.notEqual(buildEventKey(a), buildEventKey(b));
});

test('provider event state machine retries failures but not processed events', () => {
  assert.equal(eventStateTransition('received', 'start'), 'processing');
  assert.equal(eventStateTransition('processing', 'fail'), 'failed');
  assert.equal(eventStateTransition('failed', 'start'), 'processing');
  assert.equal(eventStateTransition('processing', 'succeed'), 'processed');
  assert.equal(eventStateTransition('processed', 'start'), 'processed');
});

test('downstream failure is stored as failed and a retry can succeed', async () => {
  let record = { processingStatus: 'received', attemptCount: 0 }; let fail = true;
  const onState = async next => { record = next; };
  await assert.rejects(() => executeEventAttempt(record, async () => { if (fail) throw new Error('sheet failed'); }, { onState, now: () => 't1' }));
  assert.equal(record.processingStatus, 'failed'); assert.equal(record.processedAt, ''); assert.equal(record.attemptCount, 1);
  fail = false;
  record = await executeEventAttempt(record, async () => 'processed', { onState, now: () => 't2' });
  assert.equal(record.processingStatus, 'processed'); assert.equal(record.attemptCount, 2); assert.equal(record.processedAt, 't2');
});

test('keyed lock serializes concurrent duplicate deliveries', async () => {
  const lock = new KeyedLock(); let active = 0, max = 0;
  await Promise.all([1,2,3].map(() => lock.run('same', async () => { active++; max = Math.max(max, active); await new Promise(resolve => setTimeout(resolve, 5)); active--; })));
  assert.equal(max, 1);
});

test('composite mapping identity preserves campaign history and matches safely', () => {
  const one = buildMappingKey({ externalCampaignId: '1', externalLeadId: '9', email: 'a@b.com' });
  const two = buildMappingKey({ externalCampaignId: '2', externalLeadId: '9', email: 'a@b.com' });
  assert.notEqual(one, two);
  const row = { provider: 'smartlead', externalCampaignId: '1', externalLeadId: '9', normalizedEmail: 'a@b.com' };
  assert.equal(mappingMatchesEvent(row, { campaignId: '1', leadId: '9' }), true);
  assert.equal(mappingMatchesEvent(row, { campaignId: '2', leadId: '9' }), false);
  assert.equal(mappingMatchesEvent(row, { campaignId: '1', email: 'A@B.COM' }), true);
});

test('same email under different internal IDs conflicts while terminal history remains', () => {
  const lead = { id: 'new', email: ' A@B.COM ' };
  assert.equal(leadEligibility({ lead, providerMappings: [{ internalLeadId: 'old', normalizedEmail: 'a@b.com', normalizedStatus: 'Queued' }] }).ok, false);
  assert.equal(leadEligibility({ lead, providerMappings: [{ internalLeadId: 'old', normalizedEmail: 'a@b.com', normalizedStatus: 'Completed', externalCampaignId: '1' }], externalCampaignId: '2' }).ok, true);
});

test('provider transitions prevent delayed regressions and allow refinements', () => {
  const t1 = '2026-01-01T10:00:00Z', t2 = '2026-01-01T11:00:00Z';
  assert.equal(canApplyProviderTransition({ currentStatus: 'Sent', currentEventAt: t1, incomingStatus: 'Replied', incomingEventAt: t2 }), true);
  assert.equal(canApplyProviderTransition({ currentStatus: 'Replied', currentEventAt: t2, incomingStatus: 'Sent', incomingEventAt: t1 }), false);
  assert.equal(canApplyProviderTransition({ currentStatus: 'Replied', incomingStatus: 'Interested' }), true);
  assert.equal(canApplyProviderTransition({ currentStatus: 'Interested', incomingStatus: 'Replied' }), false);
  assert.equal(canApplyProviderTransition({ currentStatus: 'Unsubscribed', incomingStatus: 'Sent' }), false);
  assert.equal(canApplyProviderTransition({ currentStatus: 'Bounced', incomingStatus: 'Sent' }), false);
  assert.equal(canApplyProviderTransition({ currentStatus: 'Replied', currentEventAt: 'bad', incomingStatus: 'Sent', incomingEventAt: '' }), false);
});

test('pilot mutation policy fails closed and normalizes recipients', () => {
  const base = { integrationEnabled: true, liveMutationsEnabled: true, pilotMode: true, campaignId: '7', recipients: [' TEST@EXAMPLE.COM '] };
  assert.equal(mutationDecision({ ...base, approvedCampaignIds: new Set(), recipientAllowlist: new Set() }).ok, false);
  assert.equal(mutationDecision({ ...base, approvedCampaignIds: new Set(['8']), recipientAllowlist: new Set(['test@example.com']) }).ok, false);
  assert.equal(mutationDecision({ ...base, approvedCampaignIds: new Set(['7']), recipientAllowlist: new Set(['other@example.com']) }).ok, false);
  assert.equal(mutationDecision({ ...base, approvedCampaignIds: new Set(['7']), recipientAllowlist: new Set(['test@example.com']) }).ok, true);
  assert.equal(normalizeEmail(' TEST@EXAMPLE.COM '), 'test@example.com');
});

test('Smartlead add payload keeps all ignore protections false', async () => {
  let request;
  const http = { request: async input => { request = input; return { data: { added_count: 1, lead_ids: [2] } }; } };
  const client = new SmartleadClient({ apiKey: 'x', integrationEnabled: true, liveMutationsEnabled: true, pilotMode: true, approvedCampaignIds: new Set(['7']), recipientAllowlist: new Set(['test@example.com']), http, maxRetries: 0 });
  await client.addLeads('7', [{ email: ' TEST@EXAMPLE.COM ' }]);
  assert.deepEqual(request.data.settings, { ignore_global_block_list: false, ignore_unsubscribe_list: false, ignore_duplicate_leads_in_other_campaign: false, ignore_community_bounce_list: false, return_lead_ids: true });
});

test('global live mutation flag alone is insufficient', async () => {
  const client = new SmartleadClient({ apiKey: 'x', integrationEnabled: true, liveMutationsEnabled: true, pilotMode: true, approvedCampaignIds: new Set(), recipientAllowlist: new Set(), http: { request: async () => ({ data: {} }) } });
  await assert.rejects(() => client.addLeads('7', [{ email: 'x@example.com' }]), error => error instanceof SmartleadError && error.code === 'MUTATION_NOT_APPROVED');
});

test('safe audit payload allowlists fields and strips nested content, HTML and controls', () => {
  const event = { reply_body: '<p>secret full body</p>', history: [{ email_body: 'secret history' }], lead_data: { huge: 'x'.repeat(10000) }, token: 'never-store', nested: { reply_body: 'nested secret' } };
  const normalized = { type: 'EMAIL_REPLY', campaignId: '1', leadId: '2', email: 'a@b.com', occurredAt: 'now', reply: '<b>Hello\u0000 world</b>', subject: 'Re: hi', rawStatus: 'EMAIL_REPLY' };
  const audit = safeAuditPayload(event, normalized); const json = JSON.stringify(audit);
  assert.equal(audit.replyPreview, 'Hello world');
  assert.equal(json.includes('secret full body'), false); assert.equal(json.includes('secret history'), false); assert.equal(json.includes('never-store'), false);
  assert.equal(audit.omitted.history, true);
});

for (const count of [0, 42, 100, 235]) test(`pagination fetches all ${count} leads`, async () => {
  const data = Array.from({ length: count }, (_, id) => ({ id: id + 1 }));
  const result = await fetchAllCampaignLeads(({ offset, limit }) => Promise.resolve({ data: data.slice(offset, offset + limit), total_leads: String(count) }));
  assert.equal(result.leads.length, count);
  assert.equal(result.pages, count === 0 ? 1 : Math.ceil(count / 100));
});

test('shared reply classifier handles key outcomes for both providers', async () => {
  const cases = [['Yes, let us schedule a call','MEETING_REQUEST'],['No thanks, not interested','NOT_INTERESTED'],['How does it work?','QUESTION'],['Please unsubscribe me','UNSUBSCRIBE'],['Automatic reply: out of office','OUT_OF_OFFICE'],['I am interested','INTERESTED']];
  for (const provider of ['gmail','smartlead']) for (const [reply, expected] of cases) assert.equal(await classifyReply({ provider, plainTextReply: reply }), expected);
});

test('statistics aggregate unique mappings with documented denominators', () => {
  const rows = [{ mappingKey: '1', normalizedStatus: 'Interested' },{ mappingKey: '2', normalizedStatus: 'Meeting requested' },{ mappingKey: '3', normalizedStatus: 'Bounced' },{ mappingKey: '4', normalizedStatus: 'Queued' },{ mappingKey: '1', normalizedStatus: 'Sent' }];
  const stats = aggregateProviderStats(rows);
  assert.equal(stats.totalLeads, 4); assert.equal(stats.interested, 0); assert.equal(stats.meetings, 1); assert.equal(stats.bounced, 1);
});

test('health distinguishes complete, partial, and failed reconciliation', () => {
  const complete = reconciliationHealth({ attempted: 2, successful: 2, failed: 0, errors: [] }, 't1');
  const partial = reconciliationHealth({ attempted: 2, successful: 1, failed: 1, errors: [{}] }, 't2');
  const failed = reconciliationHealth({ attempted: 2, successful: 0, failed: 2, errors: [{},{}] }, 't3');
  assert.equal(complete.lastSuccessfulReconciliation, 't1');
  assert.equal(partial.lastPartialReconciliation, 't2'); assert.equal(partial.lastSuccessfulReconciliation, undefined);
  assert.equal(failed.lastSuccessfulReconciliation, undefined); assert.equal(failed.lastPartialReconciliation, undefined);
  assert.equal(reconciliationHealth({ attempted: 1, successful: 1, failed: 0, errors: [] }, 't4').lastSuccessfulReconciliation, 't4');
});

test('verified Smartlead client methods use documented routes and methods', async () => {
  const calls = [];
  const http = { request: async request => { calls.push(request); return { data: {} }; } };
  const client = new SmartleadClient({ apiKey: 'x', integrationEnabled: true, liveMutationsEnabled: true, pilotMode: true, approvedCampaignIds: new Set(['7']), recipientAllowlist: new Set(['test@example.com']), http, maxRetries: 0 });
  await client.listCampaigns(); await client.getCampaign('7'); await client.getCampaignLeads('7'); await client.getCampaignStats('7');
  await client.pauseLead('7','9','test@example.com'); await client.resumeLead('7','9','test@example.com',3); await client.unsubscribeLead('7','9','test@example.com'); await client.getMessageHistory('7','9'); await client.updateLeadCategory('7','9',5,'test@example.com');
  assert.deepEqual(calls.map(call => `${call.method.toUpperCase()} ${new URL(call.url).pathname}`), [
    'GET /api/v1/campaigns','GET /api/v1/campaigns/7','GET /api/v1/campaigns/7/leads','GET /api/v1/campaigns/7/analytics','POST /api/v1/campaigns/7/leads/9/pause','POST /api/v1/campaigns/7/leads/9/resume','POST /api/v1/leads/9/unsubscribe','GET /api/v1/campaigns/7/leads/9/message-history','POST /api/v1/campaigns/7/leads/9/category',
  ]);
  assert.deepEqual(calls[5].data, { resume_lead_with_delay_days: 3 });
  assert.deepEqual(calls[8].data, { category_id: 5, pause_lead: false });
});

test('failed-event visibility and retry endpoints require dashboard authentication', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /app\.get\('\/api\/integrations\/smartlead\/events\/attention', requireAuth/);
  assert.match(source, /app\.post\('\/api\/integrations\/smartlead\/events\/:eventId\/retry', requireAuth/);
});

test('browser code contains no Smartlead secrets or API key variables', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.doesNotMatch(source, /SMARTLEAD_(?:API_KEY|WEBHOOK_SECRET|TEST_RECIPIENT_ALLOWLIST|APPROVED_CAMPAIGN_IDS)/);
});
