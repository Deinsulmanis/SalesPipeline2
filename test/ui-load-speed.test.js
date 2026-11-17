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
