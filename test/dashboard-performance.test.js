'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const browser = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('dashboard lead list skips siteContext without changing the sheet or sending agent', () => {
  assert.match(server, /ranges: \[`\$\{CE_SHEET_NAME\}!A:O`, `\$\{CE_SHEET_NAME\}!Q:W`\]/);
  assert.match(server, /length: 15[^\n]+left\[index\]\?\.\[column\]/);
  assert.match(server, /length: 7[^\n]+right\[index\]\?\.\[column\]/);
  // Still the single reader for the lead list — now called once by the shared
  // outreach snapshot rather than per request.
  assert.match(server, /readColdEmailDashboardRows\(\),/);
  assert.doesNotMatch(browser, /siteContext[^\n]+renderCeTable/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8'), /const READ_RANGE\s*=\s*`\$\{SHEET_NAME\}!A:W`/);
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
  assert.match(server, /range: `\$\{CE_SHEET_NAME\}!H\$\{rowNum\}`/);
});
