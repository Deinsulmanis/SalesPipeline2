'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { clientOutreachView } = require('../integrations/clients/outreach-view');
const { buildJoleDailyReport, createJoleDailyReportService, due, reportDate, reportPeriod, REPORT_TITLE } = require('../integrations/clients/daily-report');
const { createMemoryDailyReportStore, createSupabaseDailyReportStore } = require('../integrations/clients/daily-report-store');
const { registerClientRoutes } = require('../integrations/clients/routes');
const { createMemoryLedgerStore } = require('../integrations/clients/ledger-store');
const { senderFilterOptions } = require('../integrations/sender-visibility');
const { buildFunnelAnalytics } = require('../integrations/funnel-analytics');

const at = '2026-10-16T19:00:00.000Z'; // 14:00 Central daylight time
const lead = (id, clientId, extra = {}) => ({
  id, clientId, company: `${clientId} ${id}`, email: `${id}@example.invalid`,
  leadNiche: clientId === 'jole' ? 'jole_employer' : 'industrial_staffing',
  campaign: clientId === 'jole' ? 'jole-btx-employer-acquisition' : 'staffing_v2',
  stage: 'Queued', emailStatus: '', notes: '', ...extra,
});
const j1 = lead('j1', 'jole', { senderInboxId: 'jole_group_jorge', stage: 'Contacted', emailStatus: 'emailed' });
const j2 = lead('j2', 'jole');
const s1 = lead('s1', 'scalelab', { senderInboxId: 'primary', stage: 'Contacted', emailStatus: 'emailed' });
const s2 = lead('s2', 'scalelab');
const send = (id, leadId, senderInboxId, occurredAt = '2026-10-16T17:00:00Z') => ({
  eventId: id, sourceLeadId: leadId, eventType: 'initial_email_sent', occurredAt,
  metadata: JSON.stringify({ gmailMessageId: id, senderInboxId }),
});
const dataset = {
  at: Date.parse(at), leads: [j1, j2, s1, s2],
  rows: [j1, j2, s1, s2].map(row => ({ ...row, senderState: row.senderInboxId ? 'known' : 'unknown', campaignVersion: row.campaign })),
  archivedRows: [], classificationsByLeadId: new Map(),
  activities: [send('jg1', 'j1', 'jole_group_jorge'), send('sg1', 's1', 'primary'),
    { eventId: 'sr1', sourceLeadId: 's1', eventType: 'positive_reply', occurredAt: '2026-10-16T18:00:00Z', metadata: '{}' }],
  replyRecords: [{ leadId: 's1', category: 'positive', unsubscribe: false }],
  annotatedOpens: [{ id: 's1', company: 'scalelab s1', real: true }, { id: 'j1', company: 'jole j1', real: true }],
};
const senders = [
  { id: 'primary', email: 'scale@example.invalid', clientId: 'scalelab', status: 'active' },
  { id: 'jole_group_jorge', email: 'jole@example.invalid', clientId: 'jole', status: 'active' },
];
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
function sourceFunction(name) {
  const start = serverSource.indexOf(`function ${name}`);
  assert.ok(start >= 0);
  let depth = 0;
  for (let index = serverSource.indexOf('{', start); index < serverSource.length; index++) {
    if (serverSource[index] === '{') depth++;
    if (serverSource[index] === '}' && --depth === 0) return serverSource.slice(start, index + 1);
  }
  throw new Error(`Unclosed ${name}`);
}
const filterOutreachRows = new Function('matchesSenderFilter', 'GENUINE_REPLY_CATEGORIES', `
  ${sourceFunction('normalizedRouteNicheFor')}
  ${sourceFunction('campaignLabelFor')}
  ${sourceFunction('filterOutreachRows')}
  return filterOutreachRows;
`)((ownership, value) => ownership?.senderId === value, ['positive', 'negative', 'needs_human', 'unclassified']);

test('mixed corpus: both tenant projections isolate leads, totals, replies, senders, campaigns, opens and search/page inputs', () => {
  const jole = clientOutreachView(dataset, 'jole', senders, 'America/Chicago');
  const scale = clientOutreachView(dataset, 'scalelab', senders, 'America/Vancouver');
  assert.deepEqual(jole.rows.map(row => row.id), ['j1', 'j2']);
  assert.deepEqual(scale.rows.map(row => row.id), ['s1', 's2']);
  assert.equal(jole.counts.total, 2);
  assert.equal(scale.counts.total, 2);
  assert.equal(jole.counts.queued, 1);
  assert.equal(scale.counts.queued, 1);
  assert.equal(jole.replyRecords.length, 0);
  assert.equal(scale.replyRecords.length, 1);
  assert.deepEqual(jole.senderRows.map(row => row.id), ['jole_group_jorge']);
  assert.deepEqual(scale.senderRows.map(row => row.id), ['primary']);
  assert.equal(JSON.stringify(senderFilterOptions(jole.senderRows)).includes('scale@example.invalid'), false);
  assert.equal(JSON.stringify(senderFilterOptions(scale.senderRows)).includes('jole@example.invalid'), false);
  assert.deepEqual(Object.keys(jole.facets.campaigns), ['jole-btx-employer-acquisition']);
  assert.deepEqual(Object.keys(scale.facets.campaigns), ['staffing_v2']);
  assert.deepEqual(jole.opens.map(row => row.id), ['j1']);
  assert.deepEqual(scale.opens.map(row => row.id), ['s1']);
  assert.equal(filterOutreachRows(jole.rows, { search: 'scalelab' }).length, 0);
  assert.equal(filterOutreachRows(scale.rows, { search: 'jole' }).length, 0);
  assert.equal(filterOutreachRows(jole.rows, { search: 'jole' }).length, 2);
  assert.equal(filterOutreachRows(jole.rows, { search: 'jole' }).slice(1, 2).length, 1);
  assert.equal(filterOutreachRows(jole.rows, { search: 'jole' }).length, jole.counts.total);
  const funnel = buildFunnelAnalytics({ leads: jole.leads, activities: jole.activeActivities,
    replyRecords: jole.replyRecords, boardLeads: [], currentVersion: '' }, { version: 'lifetime' });
  assert.equal(JSON.stringify(funnel).includes('s1'), false);
  assert.equal(JSON.stringify(funnel).includes('s2'), false);
  // The route filters and paginates only after selecting `scope.view.rows`.
  assert.match(serverSource, /const scopedRows = scope\.view\?\.rows \|\| dataset\.rows;[\s\S]*?filterOutreachRows\(scopedRows, req\.query\)[\s\S]*?filtered\.slice\(offset, offset \+ limit\)/);
  assert.match(serverSource, /const client = resolveClientId\(query\.client === undefined \? 'scalelab' : query\.client\)/);
  assert.match(serverSource, /const view = scope\.view \|\| dataset;[\s\S]*?const activeRecords = view\.replyRecords/);
  assert.match(serverSource, /res\.json\(scope\.view\?\.opens \|\| dataset\.annotatedOpens\)/);
  assert.match(serverSource, /const allowed = scope\.view && new Set\(scope\.view\.archivedRows/);
  assert.match(serverSource, /const lead = scope\.view\.leads\.find/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /createObjectURL|download=".*csv"|text\/csv/i, 'there is no client data export surface');
});

test('an unlabelled open at a company shared by tenants fails closed after company normalization', () => {
  const mixed = {
    ...dataset,
    leads: [lead('jc', 'jole', { company: 'Acme, Inc.' }), lead('sc', 'scalelab', { company: 'Acme Inc' })],
    rows: [lead('jc', 'jole', { company: 'Acme, Inc.' }), lead('sc', 'scalelab', { company: 'Acme Inc' })],
    activities: [], replyRecords: [],
    annotatedOpens: [{ company: 'Acme Inc', real: true }],
  };
  assert.deepEqual(clientOutreachView(mixed, 'jole', senders).opens, []);
  assert.deepEqual(clientOutreachView(mixed, 'scalelab', senders).opens, []);
});

test('Jole daily report uses Central date, provider-confirmed sends, Jole meetings and six-source-ready sender list', () => {
  assert.equal(reportDate(new Date(at)), '2026-10-16');
  assert.equal(due(new Date('2026-10-16T18:59:00Z')), false);
  assert.equal(due(new Date(at)), true);
  assert.equal(due(new Date('2026-10-17T19:00:00Z')), false);
  assert.equal(due(new Date('2026-11-02T20:00:00Z')), true); // standard time
  const before = JSON.stringify(dataset.leads);
  const report = buildJoleDailyReport({ dataset, meetings: [
    { client_id: 'jole', booked_at: '2026-10-16T18:30:00Z' },
    { client_id: 'scalelab', booked_at: '2026-10-16T18:30:00Z' },
  ], senders, inboxes: [{ id: 'jole_group_jorge', observerHealth: 'healthy' }, { id: 'primary', observerHealth: 'healthy' }], now: new Date(at) });
  assert.equal(report.client_id, 'jole');
  assert.equal(report.successful_sends, 1);
  assert.equal(report.contacted_cumulative, 1);
  assert.equal(report.untouched_remaining, 1);
  assert.equal(report.replies_cumulative, 0);
  assert.equal(report.meetings_booked, 1);
  assert.equal(report.meetings_cumulative, 1);
  assert.equal(report.sends_attempted, null);
  assert.equal(report.per_sender.length, 1);
  assert.equal(report.per_sender[0].sent_today, 1);
  assert.equal(JSON.stringify(report).includes('scale@example.invalid'), false);
  assert.equal(JSON.stringify(dataset.leads), before, 'report generation leaves lead state unchanged');
  const six = ['group_jorge', 'group_jguerrero', 'team_jorge', 'team_jguerrero', 'industrial_jorge', 'industrial_jguerrero']
    .map((name, index) => ({ id: `jole_${name}`, email: `${name}@example.invalid`, clientId: 'jole',
      status: index < 4 ? 'active' : 'warming' }));
  const future = buildJoleDailyReport({ dataset: { ...dataset, activities: [] }, senders: six,
    inboxes: six.map(sender => ({ id: sender.id, observerHealth: 'healthy' })), now: new Date(at) });
  assert.equal(future.per_sender.length, 6);
  assert.equal(future.per_sender.filter(row => row.status === 'warming').length, 2);
  assert.equal(future.sender_health.total, 6);
});

test('every supported daily metric uses Jole evidence in a mixed tenant corpus', () => {
  const mixed = {
    ...dataset,
    leads: [j1, { ...j2, senderInboxId: 'jole_group_jorge', emailStatus: 'emailed' }, s1, s2],
    rows: [j1, { ...j2, senderInboxId: 'jole_group_jorge', emailStatus: 'emailed' }, s1, s2],
    activities: [send('jg1', 'j1', 'jole_group_jorge'), send('jg2', 'j2', 'jole_group_jorge'), send('sg1', 's1', 'primary'),
      { eventId: 'jr1', sourceLeadId: 'j1', eventType: 'positive_reply', occurredAt: at, metadata: '{}' },
      { eventId: 'jr2', sourceLeadId: 'j2', eventType: 'unsubscribe_reply', occurredAt: at, metadata: '{}' },
      { eventId: 'sr1', sourceLeadId: 's1', eventType: 'positive_reply', occurredAt: at, metadata: '{}' },
      { eventId: 'jb1', sourceLeadId: 'j2', eventType: 'email_bounced', occurredAt: at,
        metadata: JSON.stringify({ gmailMessageId: 'jg2' }) }],
    replyRecords: [{ leadId: 'j1', category: 'positive', unsubscribe: false },
      { leadId: 'j2', category: 'negative', unsubscribe: true },
      { leadId: 's1', category: 'positive', unsubscribe: false }],
  };
  const report = buildJoleDailyReport({ dataset: mixed,
    meetings: [{ client_id: 'jole', booked_at: at }, { client_id: 'scalelab', booked_at: at }],
    senders, now: new Date(at) });
  for (const [field, expected] of Object.entries({ successful_sends: 2, replies: 2,
    positive_replies: 1, negative_replies: 0, unsubscribe_requests: 1, bounces: 1,
    meetings_booked: 1, untouched_remaining: 0, contacted_cumulative: 2,
    replies_cumulative: 2, positive_replies_cumulative: 1, meetings_cumulative: 1,
    reply_rate: 100, positive_reply_rate: 50, meeting_rate: 50 })) {
    assert.equal(report[field], expected, field);
  }
  assert.equal(report.per_sender[0].sent_today, 2);
  assert.equal(report.per_sender[0].replies_attributable, 2);
  assert.equal(report.sends_attempted, null);
});

test('same-date generation is idempotent across retries and process restart', async () => {
  const store = createMemoryDailyReportStore();
  let loads = 0;
  const deps = { store, loadDataset: async () => { loads++; return dataset; },
    listMeetings: async () => [], senders: () => senders, senderStatus: async () => [],
    now: () => new Date(at), log: { error() {} } };
  const first = createJoleDailyReportService(deps);
  const [a, b] = await Promise.all([first.generateIfDue(), first.generateIfDue()]);
  const afterRestart = await createJoleDailyReportService(deps).generateIfDue();
  assert.deepEqual(a, b);
  assert.deepEqual(a, afterRestart);
  assert.equal(loads, 1);
  assert.equal(afterRestart.generated_at, at);
  await assert.rejects(store.get('scalelab', '2026-10-16'), error => error.code === 'client_isolation_violation');
});

test('a missed 14:00 run catches up at 14:05 Central without replacing a frozen report', async () => {
  const store = createMemoryDailyReportStore();
  const deps = { store, loadDataset: async () => dataset, listMeetings: async () => [],
    senders: () => senders, senderStatus: async () => [],
    now: () => new Date('2026-10-16T19:05:00Z'), log: { error() {} } };
  const report = await createJoleDailyReportService(deps).generateIfDue();
  assert.equal(report.report_date, '2026-10-16');
  assert.equal(report.generated_at, '2026-10-16T19:05:00.000Z');
  const later = await createJoleDailyReportService({ ...deps, now: () => new Date('2026-10-16T23:05:00Z') }).generateIfDue();
  assert.equal(later.generated_at, report.generated_at);
  const source = fs.readFileSync(path.join(__dirname, '..', 'integrations', 'clients', 'daily-report.js'), 'utf8');
  assert.match(source, /const REPORT_CRON = '0 14 \* \* 1-5'/);
  assert.match(source, /cron\.schedule\(REPORT_CRON, run, \{ timezone: TIMEZONE \}\)/);
  assert.match(source, /const RETRY_CRON = '5 14-23 \* \* 1-5'/);
  assert.match(source, /cron\.schedule\(RETRY_CRON, run, \{ timezone: TIMEZONE \}\)/);
  assert.match(source, /setImmediate\(run\)/);
});

test('Supabase report store sends a Jole/date-filtered GET and insert-only ignore-duplicate POST', async () => {
  const calls = [];
  const store = createSupabaseDailyReportStore({ env: {
    SUPABASE_URL: 'https://db.example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'test-only',
    CLIENT_DAILY_REPORT_ENABLED: 'true',
  }, fetchImpl: async (url, options) => {
    calls.push({ url, method: options.method, headers: options.headers, body: options.body });
    return { ok: true, status: options.method === 'GET' ? 200 : 201,
      text: async () => options.method === 'GET' ? '[]' : '' };
  } });
  assert.equal(store.enabled, true);
  assert.equal(await store.get('jole', '2026-10-16'), null);
  await store.insertIfAbsent({ client_id: 'jole', report_date: '2026-10-16' });
  assert.match(calls[0].url, /client_id=eq\.jole&report_date=eq\.2026-10-16/);
  assert.equal(calls[1].method, 'POST');
  assert.match(calls[1].url, /on_conflict=client_id,report_date/);
  assert.equal(calls[1].headers.Prefer, 'resolution=ignore-duplicates,return=minimal');
  assert.ok(!calls.some(call => ['PATCH', 'PUT', 'DELETE'].includes(call.method)));
  await assert.rejects(store.get('scalelab', '2026-10-16'), error => error.code === 'client_isolation_violation');
});

test('unsupported daily metrics remain unavailable instead of fabricated zero', () => {
  const uncertain = { ...dataset,
    activities: [{ eventId: 'u1', sourceLeadId: 'j1', eventType: 'initial_email_sent',
      occurredAt: '2026-10-16T17:00:00Z', metadata: '{}' }],
    replyRecords: [{ leadId: 'j1', category: 'positive', unsubscribe: false }] };
  const report = buildJoleDailyReport({ dataset: uncertain, senders, now: new Date(at) });
  for (const field of ['successful_sends', 'replies', 'positive_replies', 'untouched_remaining',
    'contacted_cumulative', 'reply_rate', 'positive_reply_rate', 'meeting_rate']) {
    assert.equal(report[field], null, field);
    assert.ok(report.unavailable[field], `${field} names its missing evidence`);
  }
  assert.equal(report.per_sender[0].sent_today, null);
  assert.equal(report.per_sender[0].replies_attributable, null);
  assert.equal(report.sender_health.healthy, null);
  assert.ok(report.unavailable.sender_health);
  const undated = buildJoleDailyReport({ dataset: { ...dataset, activities: [
    send('jg1', 'j1', 'jole_group_jorge', '')
  ] }, senders, now: new Date(at) });
  assert.equal(undated.successful_sends, null);
  assert.equal(undated.per_sender[0].sent_today, null);
});

// Production 2026-10-27: muz4hqf98919a6001ed2 failed step-1 validation and was
// parked Queued + emailStatus 'draft' with no step, timestamp or send row. That
// one never-sent lead blanked the contacted count and every rate.
const parkedDraft = lead('muz4hqf98919a6001ed2', 'jole', { senderInboxId: 'jole_group_jorge',
  stage: 'Queued', emailStatus: 'draft', emailStep: '', lastEmailedAt: '' });
const withParkedDraft = (draft, activities = []) => ({ ...dataset,
  leads: [j1, j2, draft, s1, s2], rows: [j1, j2, draft, s1, s2],
  activities: [...dataset.activities, ...activities] });
const RATE_FIELDS = ['untouched_remaining', 'contacted_cumulative', 'reply_rate', 'positive_reply_rate', 'meeting_rate'];

test('a never-sent lead parked as a Queued draft does not blank campaign totals', () => {
  const report = buildJoleDailyReport({ dataset: withParkedDraft(parkedDraft), senders, now: new Date(at) });
  assert.equal(report.contacted_cumulative, 1);
  assert.equal(report.untouched_remaining, 2);
  assert.equal(report.reply_rate, 0);
  assert.equal(report.positive_reply_rate, 0);
  assert.equal(report.meeting_rate, 0);
  for (const field of RATE_FIELDS) assert.equal(report.unavailable[field], undefined, field);
  // Case is not evidence: a 'Draft' status is the same parked lead.
  const cased = buildJoleDailyReport({ dataset: withParkedDraft({ ...parkedDraft, emailStatus: ' Draft ' }), senders, now: new Date(at) });
  assert.equal(cased.contacted_cumulative, 1);
});

test('a draft lead with conflicting contact or send evidence still blanks campaign totals', () => {
  const sendRow = (eventType, metadata = {}) => ({ eventId: `${eventType}-d`, sourceLeadId: parkedDraft.id, eventType,
    occurredAt: '2026-10-16T17:00:00Z', metadata: JSON.stringify({ senderInboxId: 'jole_group_jorge', ...metadata }) });
  const conflicts = {
    'contact stage': [{ ...parkedDraft, stage: 'Contacted' }],
    'done stage': [{ ...parkedDraft, stage: 'Done' }],
    'email step': [{ ...parkedDraft, emailStep: '1' }],
    'send timestamp': [{ ...parkedDraft, lastEmailedAt: '2026-10-16T17:00:00Z' }],
    'unconfirmed send row': [parkedDraft, [sendRow('initial_email_sent')]],
    'send reservation': [parkedDraft, [sendRow('ordinary_send_reserved')]],
    'failed send': [parkedDraft, [sendRow('ordinary_send_failed')]],
    'non-draft status': [{ ...parkedDraft, emailStatus: 'emailed' }],
  };
  for (const [name, [draft, activities]] of Object.entries(conflicts)) {
    const report = buildJoleDailyReport({ dataset: withParkedDraft(draft, activities), senders, now: new Date(at) });
    for (const field of RATE_FIELDS) {
      assert.equal(report[field], null, `${name}: ${field}`);
      assert.match(report.unavailable[field], /provider-confirmed send record/, `${name}: ${field}`);
    }
  }
  // A provider-confirmed send makes the draft a contacted lead, counted once.
  const sent = buildJoleDailyReport({ dataset: withParkedDraft(parkedDraft,
    [send('jgd', parkedDraft.id, 'jole_group_jorge')]), senders, now: new Date(at) });
  assert.equal(sent.contacted_cumulative, 2);
});

test('operator report API is Jole-only and reads the stored snapshot', async () => {
  const store = createMemoryDailyReportStore();
  const report = buildJoleDailyReport({ dataset, senders, now: new Date(at) });
  await store.insertIfAbsent(report);
  const app = express();
  let datasetReads = 0;
  registerClientRoutes(app, { requireAuth: (_req, _res, next) => next(), loadDataset: async () => { datasetReads++; return dataset; },
    getStore: () => createMemoryLedgerStore(), senders: () => senders,
    routedLeadReady: () => ({ ok: false }), reportStore: store, startReportScheduler: false,
    env: {}, log: { log() {}, error() {} } });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${url}/api/clients/scalelab/daily-report?date=2026-10-16`)).status, 404);
    const response = await fetch(`${url}/api/clients/jole/daily-report?date=2026-10-16`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).report, report);
    assert.equal((await fetch(`${url}/api/clients/jole/daily-report?date=2026-10-15`)).status, 404);
    assert.equal(datasetReads, 0, 'GET report never generates or mutates a snapshot');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('client switch clears rendered records, selections and filters before new requests settle', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const switched = html.slice(html.indexOf('async function switchClient('), html.indexOf('async function setActiveClient('));
  for (const action of ['ceRequestSeq += 1', 'ceLeads = []', 'ceOutreachStats = null', 'ceSelected = new Set()',
    'rdRecords = []', "ceSearchQuery = ''", 'renderCeTable()', 'updateCeStats()']) assert.ok(switched.includes(action), action);
  assert.match(html, /if \(!current\(\)\) return;[\s\S]*?ceLeads\s*= cePage\.leads/);
  assert.match(html, /if \(seq !== ceRequestSeq\) return;[\s\S]*?ceLeads = append/);
  assert.match(html, /const opensData = opensResp\.ok \? await opensResp\.json\(\) : \[\];\s*if \(!current\(\)\) return;\s*ceOpensData = opensData/);
  assert.match(html, /const outreachStats = statsResp\.ok \? await statsResp\.json\(\) : null;\s*if \(!current\(\)\) return;\s*ceOutreachStats = outreachStats/);
  assert.match(html, /async function loadFunnelAnalytics\(\)[\s\S]*?if \(!current\(\)\) return;\s*funnelAnalytics = result/);
  assert.match(html, /async function loadArchiveWorkspace[\s\S]*?const data = await response\.json\(\);\s*if \(!current\(\)\) return;\s*archiveState\.rows/);
  assert.match(html, /body\[data-client-mode="managed"\] #ws-settings #agent-panel\{display:none!important\}/);
  assert.match(html, /body\[data-client-mode="managed"\] #smartlead-health\{display:none!important\}/);
  assert.match(html, /const providerStats = !activeClientIsManaged\(\) && smartleadIntegration\?\.stats/);
  assert.match(html, /if \(!activeClientIsManaged\(\) && !smartleadIntegration && !smartleadIntegrationLoading\) loadSmartleadIntegration\(\)/);
});

test('daily report layout presents frozen business metrics on desktop, mobile and print without internal fields', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const renderer = html.slice(html.indexOf('function joleReportValue('), html.indexOf('let joleReportRequestSeq = 0;'));
  const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const render = new Function('esc', `${renderer}\nreturn renderJoleDailyReport;`)(esc);
  const report = buildJoleDailyReport({ dataset, senders, now: new Date(at) });
  const rendered = render(report, REPORT_TITLE);
  assert.match(rendered, /<h2>Jole BTX — Employer Acquisition<\/h2>/);
  assert.match(rendered, /Daily Outreach Report/);
  assert.match(rendered, /Prepared by ScaleLab AI/);
  assert.match(rendered, /Friday, October 16, 2026/);
  assert.match(rendered, /Emails sent/);
  assert.match(rendered, /Negative replies/);
  assert.match(rendered, /Sender breakdown/);
  assert.match(rendered, /Reporting timezone: America\/Chicago/);
  assert.match(rendered, /since the previous weekday's 2:00 PM up to 2:00 PM/);
  assert.doesNotMatch(rendered, /api[_ -]?key|oauth|token|railway|observerError/i);
  assert.doesNotMatch(render({ ...report, per_sender: [{ email: 'jole@example.invalid', health: 'unhealthy_quota' }] }), /unhealthy_quota/);
  assert.match(render({ ...report, per_sender: [{ email: 'jole@example.invalid', health: 'unhealthy_quota' }] }), /Needs attention/);
  assert.match(html, /@media\(max-width:760px\)\{\.jole-report/);
  // Phones keep two metric columns (one column made a screenshot ~2,700px tall).
  assert.match(html, /@media\(max-width:420px\)\{[^}]*\}\.jole-report-grid,\.jole-report-grid\.totals,\.jole-report-grid\.secondary\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(html, /@media print\{#crm-sidebar,header,\.jole-report-tools/);
  assert.match(html, /analytics\.insertAdjacentHTML\('beforeend', '<div id="jole-report-launcher"/);
  assert.match(html, /body\[data-daily-report="true"\] #jole-report-launcher\{display:block\}/);
  assert.match(html, /document\.body\.dataset\.dailyReport = activeClient\(\)\?\.dailyReport \? 'true' : 'false'/);
  assert.match(html, /body\[data-client-mode="managed"\]\.daily-report-mode #jole-report-view\{display:block\}/);
  assert.match(html, /const host = document\.getElementById\('jole-report-view'\)/);
  assert.match(html, /onclick="closeJoleDailyReport\(\)"/);
  const unavailable = render({ ...report, successful_sends: null });
  assert.match(unavailable, /Emails sent<\/span><strong>Unavailable<\/strong>/);
});
