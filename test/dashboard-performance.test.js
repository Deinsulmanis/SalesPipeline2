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
  assert.match(server, /const rows = await readColdEmailDashboardRows\(\)/);
  assert.doesNotMatch(browser, /siteContext[^\n]+renderCeTable/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8'), /const READ_RANGE\s*=\s*`\$\{SHEET_NAME\}!A:W`/);
});

test('engagement lookup reads only identity and sent timestamp columns', () => {
  assert.match(server, /ranges: \[`\$\{CE_SHEET_NAME\}!A:B`, `\$\{CE_SHEET_NAME\}!J:J`\]/);
  assert.match(server, /readColdEmailSignalRows\(\)/);
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
