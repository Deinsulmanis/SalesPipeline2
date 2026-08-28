'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
// core.autocrlf is on for this repo, so a fresh checkout hands these tests CRLF
// source while an editor-written file is LF. Normalising on read keeps the
// slicing and regexes below independent of how git materialised the file.
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
const server = readSource(path.join(root, 'server.js'));
const browser = readSource(path.join(root, 'public', 'index.html'));
const agent = readSource(path.join(root, 'outreach-agent.js'));

// Pull one handler body out of server.js. Ends at the handler's own closing
// `});` so the slice cannot bleed into the next helper and report its writes.
function handler(route) {
  const start = server.indexOf(`app.get('${route}'`);
  assert.notEqual(start, -1, `${route} exists`);
  const body = server.slice(start);
  const end = body.indexOf('\n});');
  assert.notEqual(end, -1, `${route} handler is closed`);
  return body.slice(0, end);
}

// The pure filter/paging logic, lifted out of the server so it can be exercised
// directly without a live sheet.
function loadFilter() {
  const start = server.indexOf('function filterOutreachRows');
  const end = server.indexOf('\n}\n', start) + 3;
  const helpers = server.slice(server.indexOf('function normalizedRouteNicheFor'), server.indexOf('// The row the table actually needs'));
  return new Function(`${helpers}\n${server.slice(start, end)}\nreturn filterOutreachRows;`)();
}
const filterOutreachRows = loadFilter();

function row(id, extra = {}) {
  return {
    id, company: `${id} Dental`, contactName: `Dr ${id}`, email: `${id}@example.com`,
    city: 'Vancouver', tradeType: 'dentist', stage: 'Contacted', emailStatus: 'emailed',
    lastEmailedAt: '', campaign: 'Aug Dental', leadNiche: 'dental',
    replyCategory: '', lateReply: false, bounced: false, ...extra,
  };
}
const ROWS = [
  row('a', { replyCategory: 'positive', stage: 'Replied' }),
  row('b', { replyCategory: 'positive', stage: 'Replied' }),
  row('c', { replyCategory: 'negative', stage: 'Done' }),
  row('d', { replyCategory: 'needs_human', stage: 'Replied' }),
  row('e', { replyCategory: 'unclassified', stage: 'Replied' }),
  row('f', { company: 'Zenith Roofing', tradeType: 'roofer', leadNiche: 'roofing', campaign: 'Roof Q3' }),
  row('g', { stage: 'Unsub' }),
];

// ── 1–4. Summary / pagination ───────────────────────────────────────────────

test('1. the summary endpoint returns counts only, never lead rows', () => {
  for (const route of ['/api/coldemail/stats', '/api/coldemail/summary']) {
    const body = handler(route);
    assert.match(body, /replyMetrics/);
    assert.ok(!/dataset\.rows[^.]/.test(body.replace(/dataset\.rows\.length/g, '')),
      `${route} does not serialise lead rows`);
    assert.ok(!/dataset\.leads/.test(body), `${route} does not serialise full leads`);
  }
});

test('2/3. the lead endpoint paginates and bounds the first page', () => {
  const body = handler('/api/coldemail');
  assert.match(server, /const DEFAULT_CE_PAGE = 100;/);
  assert.match(server, /const MAX_CE_PAGE = 500;/);
  assert.match(body, /filtered\.slice\(offset, offset \+ limit\)/);
  assert.match(body, /Math\.min\(requested, MAX_CE_PAGE\)/);
  assert.match(browser, /const CE_PAGE_SIZE = 100;/);
});

test('4. offset paging walks the set without repeating or dropping rows', () => {
  const all = filterOutreachRows(ROWS, {});
  const page1 = all.slice(0, 3);
  const page2 = all.slice(3, 6);
  const page3 = all.slice(6, 9);
  assert.equal(page1.length, 3);
  assert.equal(page2.length, 3);
  assert.equal(page3.length, 1);
  const seen = [...page1, ...page2, ...page3].map(r => r.id);
  assert.deepEqual(seen, ROWS.map(r => r.id));
  assert.equal(new Set(seen).size, ROWS.length, 'no row served twice');
});

// ── 5–9. Server-side filtering ──────────────────────────────────────────────

test('5/6/7/8. each reply category filters to exactly its own rows', () => {
  const of = category => filterOutreachRows(ROWS, { replyCategory: category }).map(r => r.id);
  assert.deepEqual(of('positive'), ['a', 'b']);
  assert.deepEqual(of('negative'), ['c']);
  assert.deepEqual(of('needs_human'), ['d']);
  assert.deepEqual(of('unclassified'), ['e']);
  assert.equal(filterOutreachRows(ROWS, { replyCategory: 'all' }).length, ROWS.length);
});

test('9. search composes with paging and other filters', () => {
  assert.deepEqual(filterOutreachRows(ROWS, { search: 'zenith' }).map(r => r.id), ['f']);
  assert.deepEqual(filterOutreachRows(ROWS, { search: 'a@example' }).map(r => r.id), ['a']);
  // Search narrows within a stage rather than across everything.
  assert.deepEqual(filterOutreachRows(ROWS, { stage: 'Replied', search: 'b dental' }).map(r => r.id), ['b']);
  // And the narrowed set is what gets paged.
  const narrowed = filterOutreachRows(ROWS, { stage: 'Replied' });
  assert.equal(narrowed.length, 4);
  assert.deepEqual(narrowed.slice(0, 2).map(r => r.id), ['a', 'b']);
});

test('stage, niche and campaign filters are answered server-side', () => {
  assert.deepEqual(filterOutreachRows(ROWS, { niche: 'roofing' }).map(r => r.id), ['f']);
  assert.deepEqual(filterOutreachRows(ROWS, { campaign: 'Roof Q3' }).map(r => r.id), ['f']);
  // 'Unsub' is what the agent writes; the Unsubscribed tab must still find it.
  assert.deepEqual(filterOutreachRows(ROWS, { stage: 'Unsubscribed' }).map(r => r.id), ['g']);
});

test('the browser sends filters to the server instead of filtering in memory', () => {
  assert.match(browser, /params\.set\('stage', stage\)/);
  assert.match(browser, /params\.set\('search', ceSearchQuery\)/);
  assert.match(browser, /params\.set\('replyCategory', ceReplyCategoryFilter\)/);
  // The old client-side filter chain is gone.
  assert.ok(!/const stageFiltered =/.test(browser));
  assert.ok(!/const nicheFiltered =/.test(browser));
  assert.match(browser, /const filtered = ceLeads;/);
});

// ── 6/10. Payload weight and lazy detail ────────────────────────────────────

test('lead rows keep heavy notes/context lazy while website supports master search', () => {
  assert.match(server, /const CE_LIGHT_FIELDS = \[/);
  const fields = server.slice(server.indexOf('const CE_LIGHT_FIELDS'), server.indexOf('];', server.indexOf('const CE_LIGHT_FIELDS')));
  for (const heavy of ['notes', 'siteContext', 'campaign_notes']) {
    assert.ok(!new RegExp(`'${heavy}'`).test(fields), `${heavy} is not sent to the table`);
  }
  assert.match(fields, /'website'/, 'website is the one added searchable identity field');
  // The two facts the UI read out of notes survive as precomputed flags.
  assert.match(server, /row\.lateReply = /);
  assert.match(server, /row\.bounced = /);
});

test('10. the drawer still loads full detail on demand', () => {
  assert.match(browser, /function openCeDetail\(id\)/);
  assert.match(server, /app\.get\('\/api\/leads\/:id\/activity'/);
  // Detail is fetched when a lead is opened, not embedded in the list payload.
  assert.match(browser, /loadColdCallActivity\(/);
});

// ── 11. Drill-down still reconciles ─────────────────────────────────────────

test('11. drill-down records and card counts come from the same snapshot', () => {
  const replies = handler('/api/coldemail/replies');
  assert.match(replies, /dataset\.replyRecords/);
  const stats = handler('/api/coldemail/stats');
  assert.match(stats, /dataset\.metrics/);
  // Both derive from one build, so they cannot disagree. The reply evidence map
  // is built ONCE and handed to both, which is what makes that true — asserting
  // the shared variable rather than an exact call signature, so the property
  // survives arguments being added to either call.
  assert.match(server, /const replyEvidenceByLeadId = buildReplyEvidenceMap\(activities\)/);
  assert.match(server, /buildReplyMetrics\(leads, \{[^}]*evidenceByLeadId: replyEvidenceByLeadId/);
  assert.match(server, /const replyRecords = buildReplyRecords\(leads, \{/);
  assert.match(server, /evidenceByLeadId: replyEvidenceByLeadId,/);
});

// ── 12. No N+1 ──────────────────────────────────────────────────────────────

test('12. no endpoint on the Outreach load path performs a per-lead read', () => {
  for (const route of ['/api/coldemail', '/api/coldemail/stats', '/api/coldemail/replies', '/api/demoPlays', '/api/proposalOpens']) {
    const body = handler(route);
    assert.ok(!/for\s*\([^)]*\)\s*\{[^}]*await[^}]*spreadsheets/.test(body), `${route} has no per-lead await`);
    assert.ok(!/\.map\(async/.test(body), `${route} has no per-row async map`);
  }
  // The one place that reads sheets does so a fixed number of times, whatever
  // the lead count is.
  const loader = server.slice(server.indexOf('async function loadOutreachDataset'), server.indexOf('async function getOutreachDataset'));
  const reads = (loader.match(/spreadsheets\.values\.get/g) || []).length;
  assert.equal(reads, 7, 'seven fixed reads (including the board join) plus the ColdEmail batch, whatever the lead count');
  assert.match(loader, /readColdEmailDashboardRows\(\)/);
  assert.ok(!/for\s*\(/.test(loader.slice(0, loader.indexOf('const leads ='))), 'no loop before the fetch');
});

test('the four Outreach endpoints share one snapshot instead of re-reading', () => {
  for (const route of ['/api/coldemail', '/api/coldemail/stats', '/api/coldemail/replies', '/api/demoPlays']) {
    assert.match(handler(route), /getOutreachDataset\(/, `${route} uses the shared snapshot`);
  }
  // ColdEmail is fetched in exactly one place now.
  assert.equal((server.match(/readColdEmailDashboardRows\(\)/g) || []).length, 2,
    'defined once, called once');
});

// ── 13–15. Cache behaviour ──────────────────────────────────────────────────

test('13/14. the snapshot has a bounded TTL and can be forced fresh', () => {
  assert.match(server, /const OUTREACH_CACHE_TTL_MS = 30000;/);
  assert.match(server, /Date\.now\(\) - outreachCache\.at < OUTREACH_CACHE_TTL_MS/);
  assert.match(server, /force: req\.query\.refresh === '1'/);
  // Concurrent callers share one in-flight load rather than stampeding.
  assert.match(server, /if \(!force && outreachCacheLoad\) return outreachCacheLoad;/);
});

test('15. a write cannot be hidden by the cache', () => {
  // Every mutating Sheets call funnels through the sheets() wrapper, so a write
  // touching ColdEmail drops the snapshot regardless of which of the ~30 call
  // sites made it.
  assert.match(server, /const MUTATING_VALUE_METHODS = \['update', 'append', 'batchUpdate', 'clear'\]/);
  // A ColdEmail write must bust the snapshot. Matched loosely so the guard can
  // be widened to other tabs (it since was) without failing this test.
  const wrapper = server.slice(server.indexOf('for (const method of MUTATING_VALUE_METHODS)'), server.indexOf('return client;'));
  assert.match(wrapper, /ranges\.some\(range => range\.includes\(CE_SHEET_NAME\)/, 'a ColdEmail write busts the snapshot');
  assert.match(wrapper, /invalidateOutreachCache\(/, 'the wrapper invalidates');
  assert.match(server, /function rangesTouched\(params\)/);
  // batchUpdate hides its ranges inside requestBody.data — those count too.
  assert.match(server, /requestBody && params\.requestBody\.data/);

  const rangesTouched = new Function(
    server.slice(server.indexOf('function rangesTouched'), server.indexOf('function sheets()')) + 'return rangesTouched;')();
  assert.deepEqual(rangesTouched({ range: 'ColdEmail!H2' }), ['ColdEmail!H2']);
  assert.deepEqual(rangesTouched({ requestBody: { data: [{ range: 'ColdEmail!H5' }, { range: 'ColdEmail!L5' }] } }),
    ['ColdEmail!H5', 'ColdEmail!L5']);
  assert.deepEqual(rangesTouched({}), []);
});

test('the per-process sheet check no longer runs on every request', () => {
  assert.match(server, /let ceSheetChecked = false;/);
  assert.match(server, /async function ensureColdEmailSheet\(\) \{\s*\n\s*if \(ceSheetChecked\) return;/);
});

// ── 16. Late-reply isolation ────────────────────────────────────────────────

test('16. opening the dashboard never triggers Gmail late-reply polling', () => {
  for (const route of ['/api/coldemail', '/api/coldemail/stats', '/api/coldemail/replies', '/api/proposalOpens']) {
    const body = handler(route);
    assert.ok(!/gmail|LATE_REPLY_CHECK|runLateReplyCheckPass|getLateReplyMessages/i.test(body),
      `${route} does not poll Gmail`);
  }
  const loader = server.slice(server.indexOf('async function loadOutreachDataset'), server.indexOf('async function getOutreachDataset'));
  assert.ok(!/gmail/i.test(loader));
  // The watcher stays on its own scheduled path.
  assert.match(server, /isDailyLateReplyWindow/);
  assert.match(agent, /if \(!LATE_REPLY_CHECK\) return;/);
});

// ── 21. No sending ──────────────────────────────────────────────────────────

test('21. nothing on the read path can send', () => {
  const loader = server.slice(server.indexOf('// ── SHARED OUTREACH DATASET'), server.indexOf("app.post('/api/coldemail'"));
  assert.ok(!/sendEmail|nodemailer|transporter/i.test(loader));
  // And the read endpoints perform no sheet writes.
  for (const route of ['/api/coldemail', '/api/coldemail/stats', '/api/coldemail/replies']) {
    assert.ok(!/values\.(update|append|batchUpdate|clear)/.test(handler(route)), `${route} writes nothing`);
  }
});

// ── 15/22/23. UX and responsiveness ─────────────────────────────────────────

test('search is debounced rather than firing per keystroke', () => {
  assert.match(browser, /clearTimeout\(ceSearchTimer\);\s*\n\s*ceSearchTimer = setTimeout\(\(\) => reloadCePage\(\), 250\);/);
  // A stale response cannot overwrite a newer one.
  assert.match(browser, /const seq = \+\+ceRequestSeq;/);
  assert.match(browser, /if \(!resp\.ok \|\| seq !== ceRequestSeq\) return;/);
});

test('14. the table shows a loading state instead of looking empty', () => {
  assert.match(browser, /Loading leads…/);
  assert.match(browser, /empty\.style\.display = ceLoading \? 'none' : 'block'/);
});

test('17. paging chrome reports progress, freshness and a manual refresh', () => {
  assert.match(browser, /Showing \$\{ceLeads\.length\} of \$\{ceTotal\}/);
  assert.match(browser, /Load more/);
  assert.match(browser, /Updated \$\{age < 60 \? age \+ 's' : Math\.round\(age \/ 60\) \+ 'm'\} ago/);
  assert.match(browser, /function refreshCeLeads\(\)/);
});

test('22/23. desktop and mobile paging chrome are both defined', () => {
  assert.match(browser, /\.ce-footer-row \{/);
  const mobile = browser.slice(browser.indexOf('@media (max-width: 700px)'));
  assert.match(mobile, /\.ce-footer-row \.btn-cancel \{ min-height: 44px; \}/);
  assert.match(mobile, /\.ce-footer-age \{ margin-left: 0; width: 100%; \}/);
});

test('the Campaigns panel is the only view that pulls the full set, on demand', () => {
  assert.match(browser, /async function ensureAllCeLeads\(\)/);
  assert.match(browser, /fetch\('\/api\/coldemail\?limit=0'\)/);
  assert.match(browser, /for \(const l of \(ceAllLeads \|\| ceLeads\)\)/);
  // It is not fetched during the normal load.
  const loader = browser.slice(browser.indexOf('async function loadCeLeads'), browser.indexOf('function cleanCompanyName'));
  assert.ok(!/limit=0/.test(loader), 'the default load never requests the full set');
});
