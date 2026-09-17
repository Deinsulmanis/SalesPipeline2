'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const browser = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
function sheetColumn(number) {
  let result = '', n = number;
  while (n > 0) { n--; result = String.fromCharCode(65 + (n % 26)) + result; n = Math.floor(n / 26); }
  return result;
}

test('dashboard lead list skips siteContext without changing the sheet or sending agent', () => {
  assert.match(server, /ranges: \[`\$\{CE_SHEET_NAME\}!A:O`, `\$\{CE_SHEET_NAME\}!Q:X`\]/);
  assert.match(server, /length: 15[^\n]+left\[index\]\?\.\[column\]/);
  assert.match(server, /length: 7[^\n]+right\[index\]\?\.\[column\]/);
  // Still the single reader for the lead list — now called once by the shared
  // outreach snapshot rather than per request.
  assert.match(server, /readColdEmailDashboardRows\(\),/);
  assert.doesNotMatch(browser, /siteContext[^\n]+renderCeTable/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8'), /const READ_RANGE\s*=\s*`\$\{SHEET_NAME\}!A:X`/);
});

test('engagement lookup no longer costs a second ColdEmail read', () => {
  // It used to fetch A:B + J:J on its own; it now projects the columns it needs
  // out of the shared snapshot, so /api/proposalOpens reads ColdEmail zero times.
  assert.doesNotMatch(server, /readColdEmailSignalRows\(\)/);
  // Stronger than before: the handler now does no lead work at all — the opens
  // are annotated once inside the snapshot and simply served from it.
  const handler = server.slice(server.indexOf("app.get('/api/proposalOpens'"));
  const body = handler.slice(0, handler.indexOf('\n});'));
  assert.match(body, /const dataset = await getOutreachDataset\(\);/);
  assert.match(body, /res\.json\(dataset\.annotatedOpens\)/);
  assert.ok(!/spreadsheets\.values\.get/.test(body), 'the opens route reads no sheet of its own');
});

test('dashboard counters reuse loaded data and otherwise use the compact stats endpoint', () => {
  assert.match(browser, /refreshAgentLeadCounts\(ceLeads\)/);
  assert.match(browser, /fetch\('\/api\/coldemail\/stats'\)/);
  assert.match(server, /app\.get\('\/api\/coldemail\/stats', requireAuth/);
});

test('stage changes use a narrow endpoint and never write the hidden site context column', () => {
  assert.match(browser, /fetch\(`\/api\/coldemail\/\$\{id\}\/stage`/);
  assert.match(browser, /method: 'PATCH'/);
  assert.match(server, /app\.patch\('\/api\/coldemail\/:id\/stage', requireAuth/);
  // The write goes through the canonical mutation abstraction now, so the
  // narrowness lives in the PATCH rather than in a literal range. Same
  // guarantee, asserted on the new expression of it - and asserted harder:
  // the patch names exactly one field, so no extra column can ride along.
  assert.match(server, /applyLeadChange\(req\.params\.id, \{ stage \}, \{/);
  // Bounded to the PATCH route itself. The legacy PUT /api/coldemail/:id sits
  // between it and DELETE, so a wider span would be asserting about a different
  // endpoint (see the Stage 3 write-site classification).
  const route = server.slice(
    server.indexOf("app.patch('/api/coldemail/:id/stage'"),
    server.indexOf("app.put('/api/coldemail/:id'"));
  assert.ok(!/siteContext/.test(route), 'the hidden site context column is never written by a stage change');
  assert.ok(!/values\.(update|append)\(/.test(route),
    'no direct sheet mutation may bypass the abstraction in this route');
});

test('legacy ColdEmail PUT covers the full A:X row of 24 columns', () => {
  const route = server.slice(
    server.indexOf("app.put('/api/coldemail/:id'"),
    server.indexOf("app.delete('/api/coldemail/:id'"));
  const columns = [...server.slice(server.indexOf('const CE_COLUMNS'), server.indexOf('const CE_COL_RANGE'))
    .matchAll(/'([^']+)'/g)].map(match => match[1]);
  const lastColumn = sheetColumn(columns.length);
  assert.equal(columns.length, 24);
  assert.equal(lastColumn, 'X', '24 ColdEmail fields are A:X');
  assert.match(route, /CE_COLUMNS\.map\(col => lead\[col\] !== undefined \? String\(lead\[col\]\) : ''\)/);
  assert.match(route, new RegExp(String.raw`\$\{CE_SHEET_NAME\}!A\$\{rowNum\}:${lastColumn}\$\{rowNum\}`));
  assert.doesNotMatch(route, /:S\$\{rowNum\}/);
});

test('the localStorage backup HTML is not part of the runtime or build', () => {
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'index-backup-localstorage.html')), false);
  assert.doesNotMatch(server, /index-backup-localstorage/);
  assert.doesNotMatch(browser, /index-backup-localstorage/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'SETUP.md'), 'utf8'), /index-backup-localstorage/);
});
