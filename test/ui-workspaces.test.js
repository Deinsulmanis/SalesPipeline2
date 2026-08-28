'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

test('workspace shell exposes the nine truthful CRM workspaces', () => {
  const ids = ['pipeline','outreach','inbox','campaigns','analytics','sequences','bookings','health','settings'];
  for (const id of ids) assert.match(html, new RegExp(`data-workspace="${id}"`));
  assert.match(html, /function setWorkspace\(/);
  assert.match(html, /class="crm-sidebar"/);
});

test('sidebar navigation is read-only and only changes workspace state', () => {
  const sidebar = html.slice(html.indexOf('<aside class="crm-sidebar"'), html.indexOf('</aside>') + 8);
  assert.doesNotMatch(sidebar, /fetch\(|POST|PUT|PATCH|DELETE|sendEmail|runAgent/);
  assert.doesNotMatch(sidebar, /onclick="(?!setWorkspace|toggleSidebar)/);
});

test('Inbox consumes canonical reply records and canonical Next Actions', () => {
  assert.match(html, /fetch\('\/api\/coldemail\/replies\?category=all'\)/);
  assert.match(html, /inboxActionFor\(record\)/);
  assert.match(html, /nextActions\.get\(record\.boardLeadId\)/);
  assert.match(server, /boardLeadId: row\.boardLeadId \|\| ''/);
  assert.doesNotMatch(html, /function classifyInboxReply/);
});

test('Daily Sends uses the full cached activity aggregate, not visible rows', () => {
  assert.match(server, /const sendActivity = \[\.\.\.dailySends\.entries\(\)\]/);
  assert.match(server, /sendActivity: dataset\.sendActivity/);
  const chart = html.slice(html.indexOf('function buildSendChart()'), html.indexOf('function renderCeTable()'));
  assert.match(chart, /ceOutreachStats\?\.sendActivity/);
  assert.doesNotMatch(chart, /for \(const lead of ceLeads\)/);
});

test('Settings exposes only non-secret status', () => {
  const route = server.slice(server.indexOf("app.get('/api/crm/ui-status'"), server.indexOf('// Campaign performance'));
  assert.match(route, /sending:/);
  assert.match(route, /stageSequences:/);
  assert.match(route, /calendarSync:/);
  assert.doesNotMatch(route, /API_KEY\s*[:,]|PASSWORD\s*[:,]|SERVICE_ACCOUNT_JSON\s*[:,]|TOKEN\s*[:,]/);
  assert.doesNotMatch(route, /process\.env\.SMARTLEAD_API_KEY/);
});

test('Sequences and Bookings have intentional disabled and empty states', () => {
  assert.match(html, /Stage sequences are \$\{enabled \? 'enabled' : 'disabled'\}/);
  assert.match(html, /No current calls/);
  assert.match(html, /No pipeline lead currently has a visible stage-sequence action/);
});

test('obsolete Realtor presentation is removed without removing generic type data', () => {
  assert.doesNotMatch(html, /Realtor|realtor/);
  assert.match(html, /Industry \/ lead type/);
  assert.match(server, /tradeType/);
});

test('drawer retains audited reply and contact-change controls', () => {
  for (const label of ['Correct classification','Set next action','Reverse active override','Approve change','Reject']) {
    assert.match(html, new RegExp(label));
  }
  assert.match(html, /d-pipeline-state/);
  assert.match(html, /d-activity/);
  assert.match(html, /d-sequence/);
  assert.match(html, /d-reactivation/);
});

test('responsive shell has a collapsible narrow-width navigation', () => {
  assert.match(html, /@media\(max-width:700px\)/);
  assert.match(html, /\.crm-sidebar\.open\{transform:translateX\(0\)\}/);
  assert.match(html, /function toggleSidebar\(\)/);
});


test('an Inbox row can open a lead that is not on the loaded Outreach page', () => {
  // The Inbox lists leads from the FULL reply set while the Outreach table
  // holds one bounded 100-row page, so an Inbox row is frequently for a lead
  // the browser has never fetched. openCeDetail used to return silently in
  // that case and the click did nothing at all.
  assert.match(html, /fetch\('\/api\/coldemail\?limit=1&leadId=' \+ encodeURIComponent\(id\)\)/,
    'the drawer falls back to fetching the single lead');
  assert.match(html, /if \(options\.retried\) return;/, 'and the retry is bounded, so it cannot loop');

  // The lookup is an EXACT id filter served from the shared snapshot — not an
  // extra Sheets read, and deliberately separate from the human-facing search.
  assert.match(server, /const leadId = String\(query\.leadId \|\| ''\)\.trim\(\);/);
  assert.match(server, /if \(leadId && String\(row\.id\) !== leadId\) return false;/);
  const listRoute = server.slice(server.indexOf("app.get('/api/coldemail'"), server.indexOf("app.get('/api/coldemail/funnel'"));
  assert.match(listRoute, /getOutreachDataset/, 'still served from the cached snapshot');
  assert.ok(!/spreadsheets\.values\.get/.test(listRoute), 'and adds no direct sheet read');
});
