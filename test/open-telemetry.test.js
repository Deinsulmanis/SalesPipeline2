'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8').split('\r\n').join('\n');
const server = source('server.js');
const agent = source('outreach-agent.js');
const browser = source(path.join('public', 'index.html'));

test('one or many opens cannot create Warm status or an outbound candidate', () => {
  const loader = server.slice(server.indexOf('async function loadOutreachDataset'), server.indexOf('async function getOutreachDataset'));
  assert.match(loader, /row\.warm = row\.demoEngaged;/);
  assert.doesNotMatch(loader, /if \(n >= 2\) signals\.warm\+\+|signals\.warm\+\+/);
  assert.doesNotMatch(agent, /getOpenTriggeredLeads|warmLeads|open-triggered|WARM_FOLLOW_UP_TEMPLATE/);
  assert.doesNotMatch(agent.slice(agent.indexOf('const newBatch'), agent.indexOf('console.log(`\\nDone.')), /ProposalOpens|annotatedOpens|realOpen|getOpenTriggered/i);
});

test('opens cannot mutate ownership, stage, safety, priority, sequences, or send eligibility', () => {
  const selectors = agent.slice(agent.indexOf('function selectQueued'), agent.indexOf('async function runStageSequencePass'));
  assert.doesNotMatch(selectors, /open|ProposalOpens/i);
  const telemetry = server.slice(server.indexOf('const proposalOpens ='), server.indexOf('const outside ='));
  for (const protectedSetting of ['SENDING_ENABLED', 'DAILY_LIMIT', 'suppression', 'ownership']) {
    assert.doesNotMatch(telemetry, new RegExp(protectedSetting, 'i'));
  }
  assert.doesNotMatch(telemetry, /stage\s*=|emailStatus\s*=|sequenceState\s*=/);
});

test('verified demo engagement remains the Warm signal and primary card', () => {
  assert.match(server, /row\.demoEngaged = demoCompanyKeys\.has/);
  assert.match(server, /row\.warm = row\.demoEngaged;/);
  assert.match(browser, /id="ce-stat-demo-plays"[^>]*>0<[\s\S]{0,100}Demo Plays/);
  assert.match(browser, /id="ce-stat-warm"[^>]*>0<[\s\S]{0,120}Demo-engaged Leads/);
  assert.doesNotMatch(browser, /id="ce-stat-opens"/);
});

test('historical open telemetry remains available but is labeled informational', () => {
  assert.match(server, /app\.get\('\/api\/proposalOpens'/);
  assert.match(server, /annotateOpens\(/);
  assert.match(browser, /Opens \(informational\)/);
  assert.match(browser, /informational open/);
  assert.match(browser, /email_opened/);
});
