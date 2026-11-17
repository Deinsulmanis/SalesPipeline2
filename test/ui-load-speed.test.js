'use strict';

// Dashboard load time.
//
// Measured in production (2026-11-17): every ScaleLab workspace waited for
// /api/leads and THEN /api/leads/next-actions (~2 s) before its own requests
// began, and a cold Outreach load spent ~10 s rebuilding the dataset, most of it
// reading the Supabase corpus as five 1,000-row pages one after another, after
// a Sheets read it does not depend on.
//
// What has to stay true while making that faster:
//   * the corpus is still one paged scan: the same pages, the same number of
//     requests, assembled in offset order;
//   * a page that fails still fails the whole read (never a partial corpus);
//   * rows added while the read is in flight are still read, as before;
//   * no count header means the old one-page-at-a-time read.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { readOutreachCorpus } = require('../integrations/outreach-state');

const root = path.join(__dirname, '..');
const readSource = file => fs.readFileSync(path.join(root, file), 'utf8').split('\r\n').join('\n');

const SECRET = 'sb_secret_TESTONLY_not_a_real_key';

// A PostgREST-shaped fake. `count` is the table size. `reportedTotal` is what
// the count header claims (defaults to count; null sends no header). `failAt`
// answers 500 for that offset. `growTo` makes the table that large after the
// first request, as if rows were imported mid-read.
function fakeCorpus(count, { reportedTotal = count, failAt = null, growTo = null, delayMs = 25 } = {}) {
  const requests = [];
  let size = count;
  let inFlight = 0;
  let maxInFlight = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const limit = Number(url.searchParams.get('limit') || 1000);
    const offset = Number(url.searchParams.get('offset') || 0);
    requests.push({ offset, limit, prefer: req.headers.prefer || '' });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const tableSize = size;
    if (growTo !== null) size = growTo;
    setTimeout(() => {
      inFlight -= 1;
      if (offset === failAt) { res.writeHead(500); res.end(); return; }
      const page = [];
      for (let i = offset; i < Math.min(offset + limit, tableSize); i++) {
        page.push({ lead_id: `ce-${String(i).padStart(6, '0')}`, stage: 'Contacted', email: `l${i}@x.test` });
      }
      const headers = { 'content-type': 'application/json' };
      if (/count=exact/.test(req.headers.prefer || '') && reportedTotal !== null) {
        headers['content-range'] = `${offset}-${offset + page.length - 1}/${reportedTotal}`;
      }
      res.writeHead(200, headers);
      res.end(JSON.stringify(page));
    }, delayMs);
  });
  return {
    requests,
    get maxInFlight() { return maxInFlight; },
    async start() {
      await new Promise(r => server.listen(0, '127.0.0.1', r));
      return { SUPABASE_URL: `http://127.0.0.1:${server.address().port}`, SUPABASE_SECRET_KEY: SECRET };
    },
    async stop() { await new Promise(r => server.close(r)); },
  };
}

const ids = leads => leads.map(lead => lead.id);
const expectedIds = n => Array.from({ length: n }, (_, i) => `ce-${String(i).padStart(6, '0')}`);

test('the corpus pages are read concurrently, in order, with no extra requests', async () => {
  const fake = fakeCorpus(4769);
  const env = await fake.start();
  try {
    const result = await readOutreachCorpus({ env });
    assert.equal(result.ok, true);
    assert.deepEqual(ids(result.leads), expectedIds(4769), 'every lead once, in lead_id order');
    assert.equal(fake.requests.length, 5, '4769 leads at 1000 per page is still five requests');
    assert.match(fake.requests[0].prefer, /count=exact/, 'only the first page asks for the count');
    for (const request of fake.requests.slice(1)) assert.doesNotMatch(request.prefer, /count=exact/);
    assert.ok(fake.maxInFlight > 1, 'pages after the first are read at the same time');
    assert.ok(fake.maxInFlight <= 4, 'never more than four pages in flight');
  } finally { await fake.stop(); }
});

test('a large corpus is read in bounded waves of four pages', async () => {
  const fake = fakeCorpus(12500, { delayMs: 5 });
  const env = await fake.start();
  try {
    const result = await readOutreachCorpus({ env });
    assert.equal(result.ok, true);
    assert.deepEqual(ids(result.leads), expectedIds(12500));
    assert.equal(fake.requests.length, 13);
    assert.ok(fake.maxInFlight <= 4);
  } finally { await fake.stop(); }
});

test('a page that fails fails the whole read, never a partial corpus', async () => {
  const fake = fakeCorpus(4769, { failAt: 2000 });
  const env = await fake.start();
  try {
    const result = await readOutreachCorpus({ env });
    assert.equal(result.ok, false);
    assert.deepEqual(result.leads, []);
    assert.equal(result.reason, 'HTTP 500');
  } finally { await fake.stop(); }
});

test('rows added while the pages are in flight are still read', async () => {
  // The count said 3000; by the time the pages are read the table holds 3500.
  const fake = fakeCorpus(3000, { growTo: 3500 });
  const env = await fake.start();
  try {
    const result = await readOutreachCorpus({ env });
    assert.equal(result.ok, true);
    assert.deepEqual(ids(result.leads), expectedIds(3500), 'the last full page continues the scan');
  } finally { await fake.stop(); }
});

test('an exact multiple of the page size ends with one empty page, as before', async () => {
  const fake = fakeCorpus(2000);
  const env = await fake.start();
  try {
    const result = await readOutreachCorpus({ env });
    assert.equal(result.ok, true);
    assert.equal(result.leads.length, 2000);
    assert.deepEqual(fake.requests.map(r => r.offset), [0, 1000, 2000]);
  } finally { await fake.stop(); }
});

test('without a count header the corpus is read one page at a time', async () => {
  const fake = fakeCorpus(2400, { reportedTotal: null });
  const env = await fake.start();
  try {
    const result = await readOutreachCorpus({ env });
    assert.equal(result.ok, true);
    assert.deepEqual(ids(result.leads), expectedIds(2400));
    assert.deepEqual(fake.requests.map(r => r.offset), [0, 1000, 2000]);
    assert.equal(fake.maxInFlight, 1);
  } finally { await fake.stop(); }
});

test('the dashboard snapshot starts the corpus read before the Sheets read, and awaits it once', () => {
  const server = readSource('server.js');
  const start = server.indexOf('async function loadOutreachDataset() {');
  const body = server.slice(start, server.indexOf('\nasync function ', start + 1));
  const corpusAt = body.indexOf('const pendingCorpus = ceFromSupabase ? readOutreachCorpus() : null;');
  const batchAt = body.indexOf('sheets().spreadsheets.values.batchGet(');
  assert.ok(corpusAt > 0 && batchAt > 0);
  assert.ok(corpusAt < batchAt, 'the two independent reads overlap');
  assert.equal((body.match(/readOutreachCorpus\(\)/g) || []).length, 1, 'still exactly one corpus read per snapshot');
  assert.match(body, /const corpus = await pendingCorpus;/);
});

test('startup renders without waiting for next-actions; every reload after a change still waits', () => {
  const html = readSource('public/index.html');
  const fn = name => { const at = html.indexOf(name); return html.slice(at, html.indexOf('\n}\n', at)); };
  const loadLeads = fn('async function loadLeads(');
  assert.ok(loadLeads.indexOf('loadNextActions()') < loadLeads.indexOf("fetch('/api/leads')"),
    'both reads start together');
  assert.match(loadLeads, /awaitNextActions = true/, 'the default still waits, for every caller that just changed a lead');
  assert.match(fn('async function init()'), /loadLeads\(\{ awaitNextActions: false \}\)/);
  assert.match(loadLeads, /return \{ pendingNextActions \};/,
    'returning the bare promise from an async function would make the caller wait for it anyway');
  const loadNext = fn('async function loadNextActions()');
  assert.match(loadNext, /if \(token !== nextActionsToken\) return;/, 'an older response never overwrites a newer one');
});

// ── /api/staffing/launch-readiness ──────────────────────────────────────────
// The report filtered the whole activity log, corpus and board once per staffing
// lead (6-17 s in production). It now hands each lead a superset from indexes
// built once; every per-lead rule still runs on it. These tests check, on a
// fixture built to stress identity matching, that each collaborator receives
// exactly what the old full-array filters selected.

function readinessWithSpies(check) {
  const oqPath = require.resolve('../integrations/outreach-queue');
  const poPath = require.resolve('../integrations/provider-ownership');
  const srPath = require.resolve('../integrations/staffing-readiness');
  const oq = require(oqPath);
  const po = require(poPath);
  const original = { queueEligibility: oq.queueEligibility, authoritativeProvider: po.authoritativeProvider };
  oq.queueEligibility = (lead, options) => check.queue(lead, options, original.queueEligibility);
  po.authoritativeProvider = args => check.provider(args, original.authoritativeProvider);
  delete require.cache[srPath];
  try { return require(srPath); } finally {
    Object.assign(oq, { queueEligibility: original.queueEligibility });
    Object.assign(po, { authoritativeProvider: original.authoritativeProvider });
    delete require.cache[srPath];
  }
}

function identityFixture() {
  const staffing = { leadNiche: 'industrial_staffing', campaign: 'industrial-staffing-v2', intendedCampaignVersion: 'industrial-staffing-v2',
    company: 'Acme', contactName: 'Ann', senderInboxId: 'primary', routingRequired: 'true', notes: '', emailStatus: '', emailStep: '' };
  const leads = [
    { ...staffing, id: 'L1', email: 'a@x.com', stage: 'Queued' },
    { ...staffing, id: 'L2', email: '  A@X.COM ', stage: 'Import' },              // same address, other case and padding
    { ...staffing, id: 'L3', email: 'c@x.com', stage: 'Import' },
    { ...staffing, id: 'L3', email: 'd@x.com', stage: 'Queued' },                  // duplicate id
    { ...staffing, id: '', email: 'e@x.com', stage: 'Import' },                    // blank id
    { ...staffing, id: 'L6', email: 'f@x.com', stage: 'Import', clientId: 'jole' },
    { ...staffing, id: 'L7', email: '', stage: 'Import' },
    { id: 'R1', email: 'a@x.com', stage: 'Queued', leadNiche: 'roofing' },        // non-staffing twin of L1's address
  ];
  const activities = [
    { sourceLeadId: 'L1', leadId: 'CE-L1', email: 'a@x.com', eventType: 'lead_queued', occurredAt: '2026-11-01T17:00:00Z' },
    { leadId: 'CE-L1', email: 'zz@x.com', eventType: 'email_sent', occurredAt: '2026-11-02T17:00:00Z' },
    { leadId: 'L2', email: 'zz@x.com', eventType: 'positive_reply', occurredAt: '2026-11-03T17:00:00Z' },
    { email: 'C@X.COM', eventType: 'send_reserved', occurredAt: '2026-11-04T17:00:00Z' },
    { sourceLeadId: 'L9', leadId: 'CE-L3', email: 'c@x.com', eventType: 'note', occurredAt: '2026-11-05T17:00:00Z' },
    { sourceLeadId: '', leadId: '', email: 'e@x.com', eventType: 'note', occurredAt: '2026-11-06T17:00:00Z' },
    { sourceLeadId: 'L6', email: 'f@x.com', eventType: 'unsubscribe_reply', occurredAt: '2026-11-07T17:00:00Z' },
  ];
  const boardLeads = [
    { id: 'CE-L1', email: 'other@x.com', stage: 'follow_up' },
    { id: 'B2', email: 'A@x.com', stage: 'call_booked' },
    { id: 'L3', email: 'c@x.com', stage: 'hot' },
    { id: 'B4', email: 'd@x.com', stage: 'closed_won' },
    { id: 'B5', email: 'd@x.com', stage: 'hot' },
  ];
  return { leads, activities, boardLeads, suppressedEmails: new Set(['f@x.com']), env: {}, now: Date.UTC(2026, 10, 17) };
}

test('the readiness report gives queueEligibility and the provider check exactly what full scans did', () => {
  const input = identityFixture();
  let queueCalls = 0;
  let providerCalls = 0;
  const { staffingReadinessReport } = readinessWithSpies({
    queue(lead, options, original) {
      queueCalls += 1;
      const narrowed = original(lead, options);
      const full = original(lead, { ...options, leads: input.leads, activities: input.activities, boardLeads: input.boardLeads });
      assert.deepEqual(narrowed, full, `queueEligibility verdict for ${lead.id || '(blank id)'} / ${lead.email}`);
      return narrowed;
    },
    provider(args, original) {
      providerCalls += 1;
      const expected = input.activities.filter(row => row.sourceLeadId === args.lead.id || row.leadId === `CE-${args.lead.id}`);
      assert.deepEqual(args.activities, expected, `activities for ${args.lead.id || '(blank id)'}`);
      return original(args);
    },
  });
  const report = staffingReadinessReport(input);
  assert.equal(report.counts.totalStaffing, 7);
  assert.equal(queueCalls, 7);
  assert.equal(providerCalls, 7);
});

test('the readiness report scales with the corpus, not corpus × activity log', () => {
  const { staffingReadinessReport } = require('../integrations/staffing-readiness');
  const N = 4000;
  const leads = Array.from({ length: N }, (_, i) => ({ id: `L${i}`, email: `p${i}@x.com`, company: 'Acme', contactName: 'Ann',
    stage: 'Import', leadNiche: 'industrial_staffing', campaign: 'industrial-staffing-v2', intendedCampaignVersion: 'industrial-staffing-v2',
    senderInboxId: 'primary', routingRequired: 'true', notes: '' }));
  const activities = Array.from({ length: 20000 }, (_, i) => ({ sourceLeadId: `L${i % N}`, leadId: `CE-L${i % N}`, email: `p${i % N}@x.com`,
    eventType: 'note', occurredAt: '2026-11-01T17:00:00Z' }));
  const started = Date.now();
  const report = staffingReadinessReport({ leads, activities, boardLeads: [], suppressedEmails: new Set(), env: {}, now: Date.UTC(2026, 10, 17) });
  assert.equal(report.rows.length, N);
  // Was ~4 s at this size on a dev machine; now well under a second. Generous bound.
  assert.ok(Date.now() - started < 2500, `took ${Date.now() - started} ms`);
});

test('launch-readiness reads the corpus and the dataset together', () => {
  const server = readSource('server.js');
  const route = server.slice(server.indexOf("app.get('/api/staffing/launch-readiness'"));
  const body = route.slice(0, route.indexOf('\n});'));
  assert.match(body, /await Promise\.all\(\[\s*readOutreachCorpus\(\),\s*getOutreachDataset\(\{ force: false \}\)/);
  assert.equal((body.match(/readOutreachCorpus\(\)/g) || []).length, 1, 'still one fresh corpus read');
});

// ── /api/landing/funnel ─────────────────────────────────────────────────────

function slowSupabase(rowsFor, { failTables = [], delayMs = 20 } = {}) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = async url => {
    const table = new URL(url).pathname.split('/').pop();
    calls.push({ table, startedWith: inFlight });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(r => setTimeout(r, delayMs));
    inFlight -= 1;
    if (failTables.includes(table)) return { ok: false, status: 402, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => rowsFor(table, url) };
  };
  return { calls, fetchImpl, get maxInFlight() { return maxInFlight; } };
}
const FUNNEL_ENV = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_test_value' };
const FUNNEL_NOW = new Date('2026-09-26T02:00:00Z');

test('the funnel reads its independent tables together, then the two that depend on them', async () => {
  const { loadStaffingFunnel } = require('../integrations/landing-dashboard');
  const issuance = { issuance_id: 'I1', lead_id: 'L1', sent_at: '2026-09-20T17:00:00Z', source: 'followup_2', is_test: false };
  const fake = slowSupabase(table => ({ landing_link_issuances: [issuance], landing_booking_attribution: [], landing_sessions: [] })[table] || []);
  const result = await loadStaffingFunnel({ query: { includeInternal: '1' }, env: FUNNEL_ENV, fetchImpl: fake.fetchImpl, now: FUNNEL_NOW });
  assert.equal(result.ok, true);
  const firstThree = fake.calls.slice(0, 3).map(call => call.table).sort();
  assert.deepEqual(firstThree, ['landing_booking_attribution', 'landing_link_issuances', 'landing_sessions']);
  assert.deepEqual(fake.calls.slice(0, 3).map(call => call.startedWith), [0, 1, 2], 'started together');
  assert.deepEqual(fake.calls.slice(3).map(call => call.table).sort(), ['landing_session_facts', 'outreach_leads']);
});

test('funnel id chunks are read concurrently and kept in chunk order', async () => {
  const { loadStaffingFunnel } = require('../integrations/landing-dashboard');
  const issuances = Array.from({ length: 330 }, (_, i) => ({ issuance_id: `I${i}`, lead_id: `L${i}`, sent_at: '2026-09-20T17:00:00Z', source: 'followup_2', is_test: false }));
  const sessionUrls = [];
  const fake = slowSupabase((table, url) => {
    if (table === 'landing_link_issuances') return issuances;
    if (table === 'landing_session_facts') { sessionUrls.push(url); return []; }
    return [];
  });
  const result = await loadStaffingFunnel({ env: FUNNEL_ENV, fetchImpl: fake.fetchImpl, now: FUNNEL_NOW });
  assert.equal(result.ok, true);
  assert.equal(sessionUrls.length, 5, '330 ids in chunks of 80');
  assert.ok(fake.maxInFlight >= 4, 'chunks overlap');
});

test('funnel failures are reported in the original order', async () => {
  const { loadStaffingFunnel } = require('../integrations/landing-dashboard');
  const issuance = { issuance_id: 'I1', lead_id: 'L1', sent_at: '2026-09-20T17:00:00Z', source: 'followup_2', is_test: false };
  const rows = table => ({ landing_link_issuances: [issuance] })[table] || [];
  // Sessions came before bookings in the sequential loader, so its failure wins.
  for (const [failTables, expected] of [
    [['landing_link_issuances', 'landing_booking_attribution'], 'HTTP 402'],
    [['landing_session_facts', 'landing_booking_attribution'], 'HTTP 402'],
  ]) {
    const fake = slowSupabase(rows, { failTables, delayMs: 1 });
    assert.deepEqual(await loadStaffingFunnel({ env: FUNNEL_ENV, fetchImpl: fake.fetchImpl, now: FUNNEL_NOW }), { ok: false, error: expected });
  }
  // A failed bookings read never spends a leads read.
  const fake = slowSupabase(rows, { failTables: ['landing_booking_attribution'], delayMs: 1 });
  assert.equal((await loadStaffingFunnel({ env: FUNNEL_ENV, fetchImpl: fake.fetchImpl, now: FUNNEL_NOW })).ok, false);
  assert.equal(fake.calls.some(call => call.table === 'outreach_leads'), false);
});

// ── /api/leads/next-actions ─────────────────────────────────────────────────

test('next-actions is served from a cache that every dataset invalidation also drops', () => {
  const server = readSource('server.js');
  const route = server.slice(server.indexOf("app.get('/api/leads/next-actions'"));
  const routeBody = route.slice(0, route.indexOf('\n});'));
  assert.match(routeBody, /const \{ at: _cachedAt, \.\.\.view \} = await nextActionsCache\.get\(\{ force: req\.query\.refresh === '1' \}\);/);
  assert.match(routeBody, /res\.json\(view\);/, 'the browser payload keeps its shape');
  // The cache decides freshness from `at` on the cached value; without it nothing is ever reused.
  const view = server.slice(server.indexOf('async function loadNextActionsView() {'));
  assert.match(view.slice(0, view.indexOf('\n}\n')), /return \{ at: Date\.now\(\), generatedAt:/);
  assert.match(server, /const nextActionsCache = createOutreachCache\(\{\s*load: \(\) => loadNextActionsView\(\),\s*ttlMs: NEXT_ACTIONS_CACHE_TTL_MS,/);
  assert.match(server, /const NEXT_ACTIONS_CACHE_TTL_MS = OUTREACH_CACHE_TTL_MS;/);
  const invalidate = server.slice(server.indexOf('function invalidateOutreachCache('));
  assert.match(invalidate.slice(0, invalidate.indexOf('\n}')), /nextActionsCache\.invalidate\(\);/);
  // It also reads Suppression and the observer state, which the dataset hook does not watch.
  const wrapper = server.slice(server.indexOf('function sheets() {'));
  const body = wrapper.slice(0, wrapper.indexOf('\n}'));
  assert.match(body, /range\.includes\('Suppression!'\) \|\| range\.includes\(GMAIL_OBSERVATION_STATE_SHEET\)/);
  assert.match(body, /nextActionsCache\.invalidate\(\);/);
});

test('the shared cache serves one load per TTL, shares a load in flight, and reloads after invalidation', async () => {
  const { createOutreachCache } = require('../integrations/outreach-cache');
  let loads = 0;
  let clock = 0;
  const cache = createOutreachCache({ load: async () => ({ n: ++loads, at: clock }), ttlMs: 30000, now: () => clock });
  const [a, b] = await Promise.all([cache.get(), cache.get()]);
  assert.equal(loads, 1, 'concurrent requests share one load');
  assert.equal(a, b);
  clock = 29000; await cache.get(); assert.equal(loads, 1);
  cache.invalidate(); await cache.get(); assert.equal(loads, 2, 'a write drops it immediately');
  clock = 60000; await cache.get(); assert.equal(loads, 3, 'and the TTL bounds it');
});
