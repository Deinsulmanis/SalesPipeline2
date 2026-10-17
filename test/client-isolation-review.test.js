'use strict';

// Review-pass coverage for the tenant-isolation and Jole daily-report branch.
// Deliberately mixed ScaleLab / Jole fixtures throughout. Nothing here sends,
// writes a lead, or touches production: stores are in memory and the HTTP
// server binds to localhost.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const { clientOutreachView } = require('../integrations/clients/outreach-view');
const {
  buildJoleDailyReport, createJoleDailyReportService, reportPeriod, previousWeekday, REPORT_TITLE,
} = require('../integrations/clients/daily-report');
const { createMemoryDailyReportStore } = require('../integrations/clients/daily-report-store');
const { registerClientRoutes } = require('../integrations/clients/routes');
const { createMemoryLedgerStore } = require('../integrations/clients/ledger-store');
const { filterInboxesForClient } = require('../integrations/clients/workspace-views');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

const lead = (id, clientId, extra = {}) => ({
  id, clientId, company: `${clientId} ${id}`, email: `${id}@example.invalid`,
  leadNiche: clientId === 'jole' ? 'jole_employer' : 'industrial_staffing',
  campaign: clientId === 'jole' ? 'jole-btx-employer-acquisition' : 'staffing_v2',
  stage: 'Contacted', emailStatus: 'emailed', notes: '', ...extra,
});
const send = (id, leadId, senderInboxId, occurredAt) => ({
  eventId: id, sourceLeadId: leadId, eventType: 'initial_email_sent', occurredAt,
  metadata: JSON.stringify({ gmailMessageId: id, senderInboxId }),
});
const reply = (id, leadId, occurredAt, eventType = 'positive_reply') => ({ eventId: id, sourceLeadId: leadId, eventType, occurredAt, metadata: '{}' });
const senders = [
  { id: 'primary', email: 'scale@example.invalid', clientId: 'scalelab', status: 'active', dailyLimit: 50 },
  { id: 'jole_group_jorge', email: 'jorge@jolebtxgroup.com', clientId: 'jole', status: 'active', dailyLimit: 15 },
  { id: 'jole_industrial_jorge', email: 'jorge@joleindustrial.com', clientId: 'jole', status: 'active', dailyLimit: 0 },
];
const datasetOf = ({ leads, activities = [], replyRecords = [], archivedRows = [], rows = null }) => ({
  leads, rows: rows || leads.filter(row => !archivedRows.some(item => item.id === row.id)),
  archivedRows, activities, replyRecords, classificationsByLeadId: new Map(), annotatedOpens: [],
});

// ── reporting period ────────────────────────────────────────────────────────

test('period: each report covers the previous weekday 14:00 CT up to its own 14:00 CT, across DST', () => {
  assert.deepEqual(reportPeriod('2026-10-16'), { start: Date.parse('2026-10-15T19:00:00Z'), cutoff: Date.parse('2026-10-16T19:00:00Z') });
  // Monday carries Friday afternoon and the whole weekend.
  assert.equal(previousWeekday('2026-10-19'), '2026-10-16');
  assert.deepEqual(reportPeriod('2026-10-19'), { start: Date.parse('2026-10-16T19:00:00Z'), cutoff: Date.parse('2026-10-19T19:00:00Z') });
  // Monday after the November fall-back: Friday is CDT (UTC-5), Monday is CST (UTC-6).
  assert.deepEqual(reportPeriod('2026-11-02'), { start: Date.parse('2026-10-30T19:00:00Z'), cutoff: Date.parse('2026-11-02T20:00:00Z') });
});

test('period: a reply after 14:00 lands in the next report, never in none; weekend replies land on Monday', () => {
  const j1 = lead('j1', 'jole', { senderInboxId: 'jole_group_jorge' });
  const j2 = lead('j2', 'jole', { senderInboxId: 'jole_group_jorge' });
  const data = datasetOf({
    leads: [j1, j2, lead('s1', 'scalelab', { senderInboxId: 'primary' })],
    activities: [
      send('a1', 'j1', 'jole_group_jorge', '2026-10-15T13:00:00Z'), send('a2', 'j2', 'jole_group_jorge', '2026-10-15T13:30:00Z'),
      reply('r1', 'j1', '2026-10-15T22:00:00Z'),            // Thu 17:00 CT — after Thursday's freeze
      reply('r2', 'j2', '2026-10-18T15:00:00Z', 'negative_reply'), // Sunday
      reply('rs', 's1', '2026-10-16T15:00:00Z'),            // ScaleLab's, never Jole's
    ],
    replyRecords: [{ leadId: 'j1', category: 'positive' }, { leadId: 'j2', category: 'negative' }, { leadId: 's1', category: 'positive' }],
  });
  const at = iso => buildJoleDailyReport({ dataset: data, senders, now: new Date(iso) });
  const thursday = at('2026-10-15T19:00:00Z');
  const friday = at('2026-10-16T19:00:00Z');
  const monday = at('2026-10-19T19:00:00Z');
  assert.equal(thursday.replies, 0);
  assert.equal(thursday.replies_cumulative, 0, 'cumulative is bounded by the cutoff');
  assert.equal(friday.replies, 1);
  assert.equal(friday.positive_replies, 1);
  assert.equal(monday.replies, 1);
  assert.equal(monday.negative_replies, 1);
  assert.equal(thursday.replies + friday.replies + monday.replies, 2, 'every Jole reply is counted exactly once');
  assert.equal(monday.replies_cumulative, 2);
  assert.equal(thursday.successful_sends, 2);
  assert.equal(monday.sender_health.period_start, '2026-10-16T19:00:00.000Z');
});

test('period: a retry at 18:05 measures exactly what the 14:00 run would have', () => {
  const j1 = lead('j1', 'jole', { senderInboxId: 'jole_group_jorge' });
  const data = datasetOf({
    leads: [j1],
    activities: [send('a1', 'j1', 'jole_group_jorge', '2026-10-16T13:00:00Z'), reply('late', 'j1', '2026-10-16T21:30:00Z')],
    replyRecords: [{ leadId: 'j1', category: 'positive' }],
  });
  const strip = report => ({ ...report, generated_at: null, sender_health: { ...report.sender_health, observed_at: null } });
  const onTime = buildJoleDailyReport({ dataset: data, senders, now: new Date('2026-10-16T19:00:00Z') });
  const retried = buildJoleDailyReport({ dataset: data, senders, now: new Date('2026-10-16T23:05:00Z') });
  assert.deepEqual(strip(retried), strip(onTime));
  assert.equal(retried.replies, 0, 'the 16:30 CT reply belongs to Monday\'s report');
});

// ── report safety and content ───────────────────────────────────────────────

test('report generation reads frozen inputs, writes only its own snapshot, and imports no send path', async () => {
  const deepFreeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(deepFreeze); } return value; };
  const data = deepFreeze(datasetOf({ leads: [lead('j1', 'jole', { senderInboxId: 'jole_group_jorge' })],
    activities: [send('a1', 'j1', 'jole_group_jorge', '2026-10-16T13:00:00Z')] }));
  const frozenSenders = deepFreeze(senders.map(sender => ({ ...sender })));
  const calls = [];
  const memory = createMemoryDailyReportStore();
  const store = { enabled: true,
    get: (...args) => { calls.push('get'); return memory.get(...args); },
    insertIfAbsent: row => { calls.push('insertIfAbsent'); return memory.insertIfAbsent(row); } };
  const report = await createJoleDailyReportService({ store, loadDataset: async () => data, listMeetings: async () => [],
    senders: () => frozenSenders, senderStatus: async () => [], now: () => new Date('2026-10-16T19:00:00Z'), log: { error() {} },
  }).generateIfDue();
  assert.equal(report.successful_sends, 1);
  assert.deepEqual(calls, ['get', 'insertIfAbsent', 'get']);
  for (const file of ['integrations/clients/daily-report.js', 'integrations/clients/daily-report-store.js']) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.doesNotMatch(source, /send-lock|gmail-sender|outreach-queue|sendEmail|applyLeadChanges|sheets\(\)|upsertOpportunity|insertMeeting/, file);
    assert.doesNotMatch(source, /method: 'PATCH'|'DELETE'|resolution=merge-duplicates/, `${file} never updates a stored snapshot`);
  }
});

test('report: held and capped Jole inboxes say so; a ScaleLab inbox never appears', () => {
  const env = { COLD_SENDER_HOLDS: 'jole_industrial_jorge:warmup_incomplete' };
  const report = buildJoleDailyReport({ dataset: datasetOf({ leads: [lead('j1', 'jole')] }), senders,
    inboxes: senders.map(sender => ({ id: sender.id, observerHealth: 'healthy' })), now: new Date('2026-10-16T19:00:00Z'), env });
  assert.deepEqual(report.per_sender.map(row => [row.sender_id, row.daily_limit, row.cold_hold]), [
    ['jole_group_jorge', 15, null], ['jole_industrial_jorge', 0, 'warmup_incomplete']]);
  assert.equal(report.sender_health.healthy, 2);
  assert.equal(REPORT_TITLE, 'Jole BTX — Employer Acquisition');
  const renderer = html.slice(html.indexOf('function joleReportValue('), html.indexOf('let joleReportRequestSeq = 0;'));
  const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rendered = new Function('esc', `${renderer}\nreturn renderJoleDailyReport;`)(esc)(report, REPORT_TITLE);
  assert.match(rendered, /On hold \(warm-up\)/);
  assert.match(rendered, /15\/day/);
});

test('report API: dailyReport is a server-declared capability, a bad date is refused, ScaleLab has none', async () => {
  const app = express();
  registerClientRoutes(app, { requireAuth: (_req, _res, next) => next(), loadDataset: async () => datasetOf({ leads: [] }),
    getStore: () => createMemoryLedgerStore(), senders: () => senders, routedLeadReady: () => ({ ok: false }),
    reportStore: createMemoryDailyReportStore(), startReportScheduler: false, env: {}, log: { log() {}, error() {} } });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/clients`;
    const list = await (await fetch(url)).json();
    assert.deepEqual(Object.fromEntries(list.clients.map(client => [client.clientId, client.dailyReport])), { scalelab: false, jole: true });
    assert.equal((await (await fetch(`${url}/jole`)).json()).client.dailyReport, true);
    assert.equal((await fetch(`${url}/jole/daily-report?date=2026-10-16;drop`)).status, 422);
    assert.equal((await fetch(`${url}/scalelab/daily-report?date=2026-10-16`)).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

// ── tenant projections ──────────────────────────────────────────────────────

test('archive and send charts: archived activity stays out of active charts and each tenant sees only its own archive', () => {
  const live = lead('j1', 'jole', { senderInboxId: 'jole_group_jorge' });
  const archived = lead('j9', 'jole', { senderInboxId: 'jole_group_jorge' });
  const scaleArchived = lead('s9', 'scalelab', { senderInboxId: 'primary' });
  const data = datasetOf({
    leads: [live, archived, scaleArchived], archivedRows: [archived, scaleArchived],
    activities: [send('a1', 'j1', 'jole_group_jorge', '2026-10-16T13:00:00Z'), send('a9', 'j9', 'jole_group_jorge', '2026-10-15T13:00:00Z'),
      send('s9', 's9', 'primary', '2026-10-15T13:00:00Z')],
  });
  const jole = clientOutreachView(data, 'jole', senders, 'America/Chicago');
  const scale = clientOutreachView(data, 'scalelab', senders, 'America/Vancouver');
  assert.deepEqual(jole.sendActivity, [{ date: '2026-10-16', count: 1 }], 'active chart: live sends only');
  assert.deepEqual(jole.historicalSendActivity, [{ date: '2026-10-15', count: 1 }, { date: '2026-10-16', count: 1 }]);
  assert.deepEqual(jole.archivedRows.map(row => row.id), ['j9']);
  assert.deepEqual(scale.archivedRows.map(row => row.id), ['s9']);
  assert.equal(jole.counts.archived, 1);
  assert.deepEqual(scale.sendActivity, []);
});

test('sender health and bookings: each tenant reads only its own inboxes and meetings', async () => {
  const inboxes = senders.map(sender => ({ ...sender, observerHealth: 'healthy' }));
  assert.deepEqual(filterInboxesForClient(inboxes, 'jole').map(row => row.id), ['jole_group_jorge', 'jole_industrial_jorge']);
  assert.deepEqual(filterInboxesForClient(inboxes, 'scalelab').map(row => row.id), ['primary']);
  const store = createMemoryLedgerStore();
  store.tables.meetings.set('m1', { meeting_id: 'm1', client_id: 'jole', booked_at: '2026-10-16T15:00:00Z' });
  store.tables.meetings.set('m2', { meeting_id: 'm2', client_id: 'scalelab', booked_at: '2026-10-16T15:00:00Z' });
  assert.deepEqual((await store.listMeetings('jole')).map(row => row.meeting_id), ['m1']);
  // And the report ignores any foreign row it is handed.
  const report = buildJoleDailyReport({ dataset: datasetOf({ leads: [] }), meetings: [...store.tables.meetings.values()], senders,
    now: new Date('2026-10-16T19:00:00Z') });
  assert.equal(report.meetings_booked, 1);
  assert.equal(report.meetings_cumulative, 1);
});

test('lead timeline keeps legacy email-matched activity, but never another client\'s lead activity', () => {
  const route = serverSource.slice(serverSource.indexOf("app.get('/api/coldemail/:id/activity'"));
  const body = route.slice(0, route.indexOf('\n});'));
  assert.match(body, /const tenantLeadIds = new Set\(scope\.view\.leads\.map/);
  assert.match(body, /activityMatchesLead\(row, lead\) && \(!rowLeadId \|\| tenantLeadIds\.has\(rowLeadId\)\)/);
  assert.match(body, /const lead = scope\.view\.leads\.find/);
});

// ── browser guards ──────────────────────────────────────────────────────────

test('no dashboard function shadows its own current() staleness guard (temporal dead zone)', () => {
  const script = html.slice(html.indexOf('<script>'), html.lastIndexOf('</script>'));
  const starts = [...script.matchAll(/\n(?:async )?function (\w+)\s*\(/g)];
  const offenders = [];
  starts.forEach((match, index) => {
    const body = script.slice(match.index, starts[index + 1]?.index ?? script.length);
    const guards = (body.match(/const current = \(\) =>/g) || []).length;
    const declarations = (body.match(/\b(?:const|let|var) current\b/g) || []).length;
    if (guards && declarations > guards) offenders.push(match[1]);
  });
  assert.deepEqual(offenders, []);
});

test('the dashboard names no client: report, timezone and controls come from client config', () => {
  assert.equal(/===\s*'jole'|!==\s*'jole'|'jole'\s*[!=]==|"jole"/.test(html), false);
  assert.match(html, /const chartTimeZone = activeClient\(\)\?\.timezone \|\| 'America\/Vancouver'/);
  assert.match(html, /if \(!activeClient\(\)\?\.dailyReport \|\| activeWorkspace !== 'analytics'\) return;/);
  assert.match(html, /fetch\(`\/api\/clients\/\$\{encodeURIComponent\(clientId\)\}\/daily-report\?date=/);
  assert.match(serverSource, /getManagedClientConfig\(client\.clientId\)\.timezone \|\| 'America\/Vancouver'/);
});
