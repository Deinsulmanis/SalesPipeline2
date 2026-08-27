'use strict';

// The regression this file exists to prevent: dashboard cards that describe
// whatever page happens to be loaded instead of the whole Outreach database.
// Pagination shipped, `ceLeads` became one page of 100, and Total silently
// changed from 1,849 to 100. Nothing here touches Google or the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
// core.autocrlf is on for this repo, so a fresh checkout yields CRLF source.
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
const server = readSource(path.join(root, 'server.js'));
const browser = readSource(path.join(root, 'public', 'index.html'));

function handler(route) {
  const start = server.indexOf(`app.get('${route}'`);
  assert.notEqual(start, -1, `${route} exists`);
  const body = server.slice(start);
  const end = body.indexOf('\n});');
  return body.slice(0, end === -1 ? undefined : end);
}

// The real pure filter, lifted from server.js.
function loadFilter() {
  const start = server.indexOf('function filterOutreachRows');
  const end = server.indexOf('\n}\n', start) + 3;
  const helpers = server.slice(server.indexOf('function normalizedRouteNicheFor'), server.indexOf('// The row the table actually needs'));
  return new Function(`${helpers}\n${server.slice(start, end)}\nreturn filterOutreachRows;`)();
}
const filterOutreachRows = loadFilter();

// The real updateCeStats, lifted from the browser and run against a stub DOM.
// This is the exact function the regression lived in.
function runUpdateCeStats({ ceLeads, stats }) {
  const body = browser.match(/function updateCeStats\(\)\s*\{[\s\S]*?\n\}/)[0];
  const els = {};
  const stub = id => els[id] || (els[id] = { textContent: '' });
  const ctx = {
    document: { getElementById: stub },
    ceLeads,
    ceOutreachStats: stats,
    ceOpensMap: new Map(),
    ceCompanyKey: c => String(c || '').toLowerCase().replace(/[^a-z0-9]/g, ''),
    ceHasReplied: () => false,
    ceLeadCompanyKeys: () => new Set(),
  };
  new Function(...Object.keys(ctx), `${body}; updateCeStats();`)(...Object.values(ctx));
  return {
    total: els['ce-stat-total'].textContent,
    queued: els['ce-stat-queued'].textContent,
    emailed: els['ce-stat-emailed'].textContent,
    opens: els['ce-stat-opens'].textContent,
    warm: els['ce-stat-warm'].textContent,
    hits: (els['ce-stat-opens-label'] || {}).textContent,
    replies: els['ce-stat-replied'].textContent,
    positive: els['ce-stat-positive'].textContent,
  };
}

// The canonical live shape, matching the real production dataset.
const SUMMARY = {
  total: 1849, totalLeads: 1849, queued: 88, emailed: 938, done: 371, replied: 22,
  signals: { opens: 44, hits: 89, warm: 16 },
  replyMetrics: { totalReplies: 22, positive: 4, negative: 13, needsHuman: 3, unclassified: 2, positiveReplyRate: 0.4 },
};
const page = n => Array.from({ length: n }, (_, i) => ({
  id: 'L' + i, company: 'Co' + i, stage: 'Contacted', emailStatus: 'emailed',
}));

// ── 1–6. The regression itself ──────────────────────────────────────────────

test('1. 1,849 source rows with a 100-row page still report Total 1,849', () => {
  const out = runUpdateCeStats({ ceLeads: page(100), stats: SUMMARY });
  assert.equal(out.total, 1849, 'Total must not become the page size');
  assert.notEqual(out.total, 100);
});

test('2/3. Emailed and Queued aggregate the full dataset, not the page', () => {
  const out = runUpdateCeStats({ ceLeads: page(100), stats: SUMMARY });
  assert.equal(out.emailed, 938, 'every row on the page is emailed; the global count is not 100');
  assert.equal(out.queued, 88, 'the page holds no Queued rows, but 88 exist');
});

test('4/5/6. Opens, hits and Warm aggregate the full dataset', () => {
  const out = runUpdateCeStats({ ceLeads: page(100), stats: SUMMARY });
  assert.equal(out.opens, 44);
  assert.equal(out.hits, 'Opens · 89 hits');
  assert.equal(out.warm, 16);
});

test('7. reply metrics are unchanged — they were always server-aggregated', () => {
  const out = runUpdateCeStats({ ceLeads: page(100), stats: SUMMARY });
  assert.equal(out.replies, 22);
  assert.equal(out.positive, 4);
});

test('the cards no longer read the lead array at all', () => {
  const body = browser.match(/function updateCeStats\(\)\s*\{[\s\S]*?\n\}/)[0];
  // Strip comments: the word appears in the note explaining why it was removed.
  const code = body.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert.ok(!/ceLeads/.test(code), 'updateCeStats must not reference the paginated array');
  assert.ok(!/ceOpensMap/.test(code), 'open counts come from the summary, not a client map');
});

// ── 8–10. Pagination invariance ─────────────────────────────────────────────

test('8/9/10. page size, offset and Load More never move the totals', () => {
  const baseline = runUpdateCeStats({ ceLeads: page(100), stats: SUMMARY });
  for (const [label, leads] of [
    ['limit=50', page(50)],
    ['limit=500', page(500)],
    ['offset=100 (page 2)', page(100)],
    ['after Load More', page(200)],
    ['empty page', []],
  ]) {
    const out = runUpdateCeStats({ ceLeads: leads, stats: SUMMARY });
    assert.deepEqual(out, baseline, `${label} changed the dashboard totals`);
  }
});

test('11/12. a stage filter or search narrows the table, never the cards', () => {
  // The summary request carries no filter parameters at all.
  const query = browser.slice(browser.indexOf('function ceQuery'), browser.indexOf('async function reloadCePage'));
  assert.match(query, /params\.set\('stage', stage\)/, 'the LEAD query is filtered');
  const loader = browser.slice(browser.indexOf('async function loadCeLeads'), browser.indexOf('function cleanCompanyName'));
  assert.match(loader, /fetch\('\/api\/coldemail\/stats'\)/, 'the SUMMARY request is unfiltered');
  assert.ok(!/coldemail\/stats\?[^']*stage/.test(browser), 'no filter is ever appended to the summary');
  // And re-filtering does not recompute the cards.
  const reload = browser.slice(browser.indexOf('async function reloadCePage'), browser.indexOf('function loadMoreCeLeads'));
  assert.ok(!/updateCeStats\(\)/.test(reload), 'a filter change must not recompute global cards');
  // Filtered rows still page correctly, which is the separate `totalMatching`.
  const rows = [
    { id: 'a', stage: 'Import', company: 'A', email: 'a@x', contactName: '', tradeType: '', leadNiche: '', campaign: '', replyCategory: '' },
    { id: 'b', stage: 'Import', company: 'B', email: 'b@x', contactName: '', tradeType: '', leadNiche: '', campaign: '', replyCategory: '' },
    { id: 'c', stage: 'Done', company: 'C', email: 'c@x', contactName: '', tradeType: '', leadNiche: '', campaign: '', replyCategory: '' },
  ];
  assert.equal(filterOutreachRows(rows, { stage: 'Import' }).length, 2);
  assert.equal(filterOutreachRows(rows, {}).length, 3);
});

test('the footer total is the filtered match count, distinct from the card total', () => {
  assert.match(browser, /Showing \$\{ceLeads\.length\} of \$\{ceTotal\}/);
  // ceTotal comes from the paginated response; the cards come from the summary.
  assert.match(browser, /ceTotal = data\.total \|\| 0;/);
  assert.match(browser, /num\(counts\.totalLeads, '–'\)/);
});

// ── Server aggregation ──────────────────────────────────────────────────────

test('the summary aggregates the snapshot, and never a page', () => {
  const loader = server.slice(server.indexOf('async function loadOutreachDataset'), server.indexOf('async function getOutreachDataset'));
  assert.match(loader, /counts\.total = rows\.length;/);
  assert.match(loader, /const signals = \{ opens: 0, hits: 0, warm: 0 \};/);
  // Aggregation happens before any slicing, over every lead.
  assert.ok(!/slice\(offset/.test(loader), 'the snapshot never paginates');
  for (const route of ['/api/coldemail/stats', '/api/coldemail/summary']) {
    assert.match(handler(route), /signals: dataset\.signals/, `${route} serves the signals`);
  }
});

test('open semantics are preserved exactly: distinct companies, matched to leads', () => {
  const loader = server.slice(server.indexOf('async function loadOutreachDataset'), server.indexOf('async function getOutreachDataset'));
  assert.match(loader, /if \(open\.real === false\) continue;/, 'scanner detonations excluded');
  assert.match(loader, /if \(!leadKeys\.has\(k\)\) continue;/, 'orphaned open rows excluded');
  assert.match(loader, /if \(n >= 2\) signals\.warm\+\+;/, 'warm is >= 2 real opens');
  assert.match(loader, /signals\.hits \+= n;/, 'hits is the raw real-open count');
});

test('13. the fix adds no extra Sheets read', () => {
  const loader = server.slice(server.indexOf('async function loadOutreachDataset'), server.indexOf('async function getOutreachDataset'));
  assert.equal((loader.match(/spreadsheets\.values\.get/g) || []).length, 6, 'still six fixed reads');
  assert.match(loader, /readColdEmailDashboardRows\(\)/);
  // The opens are annotated once and reused rather than recomputed per request.
  assert.match(loader, /const annotatedOpens = annotateOpens\(\{/);
  assert.match(handler('/api/proposalOpens'), /res\.json\(dataset\.annotatedOpens\)/);
});

test('the Agent tab counters are global too', () => {
  const fn = browser.slice(browser.indexOf('async function refreshAgentLeadCounts'), browser.indexOf('// ============================================================\n// MOTION SWITCHER'));
  assert.ok(!/loadedLeads\.filter/.test(fn), 'must not count whatever array it was handed');
  assert.match(fn, /ceOutreachStats\.queued/);
  assert.match(fn, /ceOutreachStats\.emailed/);
});

// ── 14–18. The performance work stays intact ────────────────────────────────

test('14. the first page is still bounded to 100 rows by default', () => {
  assert.match(server, /const DEFAULT_CE_PAGE = 100;/);
  assert.match(server, /const MAX_CE_PAGE = 500;/);
  assert.match(browser, /const CE_PAGE_SIZE = 100;/);
  assert.match(handler('/api/coldemail'), /filtered\.slice\(offset, offset \+ limit\)/);
});

test('15/16. the payload stays light and the DOM stays bounded', () => {
  const fields = server.slice(server.indexOf('const CE_LIGHT_FIELDS'), server.indexOf('];', server.indexOf('const CE_LIGHT_FIELDS')));
  for (const heavy of ['notes', 'siteContext', 'campaign_notes', 'website']) {
    assert.ok(!new RegExp(`'${heavy}'`).test(fields), `${heavy} is still not shipped`);
  }
  assert.match(browser, /const filtered = ceLeads;/, 'the table still renders only the page');
  assert.ok(!/const stageFiltered =/.test(browser), 'no client-side full-set filtering returned');
});

test('17. no N+1 read returned with the fix', () => {
  for (const route of ['/api/coldemail', '/api/coldemail/stats', '/api/coldemail/replies', '/api/proposalOpens', '/api/demoPlays']) {
    const body = handler(route);
    assert.ok(!/for\s*\([^)]*\)\s*\{[^}]*await[^}]*spreadsheets/.test(body), `${route} has no per-lead read`);
    assert.match(body, /getOutreachDataset\(/, `${route} uses the shared snapshot`);
  }
});

test('18/23. no Gmail polling and no send path on the Outreach load', () => {
  for (const route of ['/api/coldemail', '/api/coldemail/stats', '/api/coldemail/summary', '/api/proposalOpens']) {
    const body = handler(route);
    assert.ok(!/gmail|LATE_REPLY_CHECK|sendEmail/i.test(body), `${route} stays read-only`);
    assert.ok(!/values\.(update|append|batchUpdate|clear)/.test(body), `${route} writes nothing`);
  }
  const loader = server.slice(server.indexOf('async function loadOutreachDataset'), server.indexOf('async function getOutreachDataset'));
  assert.ok(!/gmail|sendEmail/i.test(loader));
});

test('search remains debounced and the cache is still shared', () => {
  assert.match(browser, /ceSearchTimer = setTimeout\(\(\) => reloadCePage\(\), 250\);/);
  assert.match(server, /const OUTREACH_CACHE_TTL_MS = 30000;/);
  assert.match(server, /if \(!force && outreachCacheLoad\) return outreachCacheLoad;/);
});
