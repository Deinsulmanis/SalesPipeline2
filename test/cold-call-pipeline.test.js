'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  COLD_CALL_STAGES,
  displayStageFor,
  scoreColdCallLead,
} = require('../integrations/cold-call-pipeline');

const root = path.join(__dirname, '..');
const agent = fs.readFileSync(path.join(root, 'outreach-agent.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const browser = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

test('cold-call pipeline has exactly five stages and legacy rows remain visible without migration', () => {
  assert.deepEqual(COLD_CALL_STAGES.map(stage => stage.id), ['follow_up', 'hot', 'call_booked', 'closed_won', 'closed_lost']);
  assert.equal(displayStageFor('new'), 'follow_up');
  assert.equal(displayStageFor('proposal'), 'call_booked');
  assert.equal(displayStageFor('lost'), 'closed_lost');
  assert.equal(displayStageFor('hot'), 'hot');
});

test('lead score reflects verified engagement without exceeding 100', () => {
  const activities = ['initial_email_sent','demo_pair_played','booking_link_sent','positive_reply','call_booked']
    .map(eventType => ({ eventType }));
  assert.equal(scoreColdCallLead({ meetingAt: '2026-08-26T18:00:00Z' }, activities), 100);
  assert.equal(scoreColdCallLead({}, []), 10);
});

test('future trigger automations are additive and the standard sending loop stays isolated', () => {
  const standardSend = agent.slice(agent.indexOf('// ── New sends (step 1)'), agent.indexOf('// ── Follow-ups (steps 2 & 3)'));
  // markSent now takes optional send metadata so the activity row can carry the
  // real Gmail message id. The ORDER is what this guards: send, then record,
  // then count.
  assert.match(standardSend, /sendEmail\([\s\S]*?markSent\(lead, 1,[\s\S]*?sent\+\+/);
  // The loop itself must still contain no trigger automation. Activity logging
  // lives inside markSent, which only runs after a send has already succeeded.
  assert.doesNotMatch(standardSend, /recordColdCallActivity|upsertColdCallLeadFromEvent/);
  assert.match(agent, /non-blocking log failure/);
  assert.match(agent, /upsertColdCallLeadFromEvent\([\s\S]*?'follow_up'/);
  assert.match(agent, /handleInterested\(lead, message, replyText/);
  assert.match(agent, /eventType: 'booking_link_sent'/);
  assert.doesNotMatch(agent, /deleteDimension/);
});

test('cold-call detail APIs use additive columns and do not mutate ColdEmail', () => {
  assert.match(server, /app\.get\('\/api\/leads\/:id\/activity'/);
  assert.match(server, /app\.patch\('\/api\/leads\/:id\/call-details'/);
  assert.match(server, /range: `\$\{SHEET_NAME\}!U\$\{rowNum\}:W\$\{rowNum\}`/);
  const detailsRoute = server.slice(server.indexOf("app.patch('/api/leads/:id/call-details'"), server.indexOf("app.post('/api/coldemail/queue'"));
  assert.doesNotMatch(detailsRoute, /CE_SHEET_NAME|ColdEmail|sendEmail|spawnAgent/);
});

test('dashboard stage columns mirror the canonical list and its inline script parses', () => {
  // The SPA keeps its own STAGES array; drift between the two is the bug this
  // catches, so assert against the module rather than a hardcoded copy.
  for (const { id } of COLD_CALL_STAGES) assert.match(browser, new RegExp(`id: '${id}'`));
  assert.match(browser, /Legacy stage:/);
  assert.match(browser, /Add the booked meeting time before moving/);
  const script = browser.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new vm.Script(script));
});

test('dashboard reframes the two views as one Pipeline with Outreach', () => {
  assert.match(browser, /data-m="cold-calls"[^>]*[\s\S]*?Pipeline/);
  assert.match(browser, /data-m="cold-email"[^>]*[\s\S]*?Outreach/);
  assert.match(browser, /Queued" in the Outreach tab/);
  assert.match(browser, /added to the Pipeline/);
  assert.match(browser, /TODO\(source-filter\)/);
  assert.doesNotMatch(browser, />\s*Cold Calls\s*</);
  assert.doesNotMatch(browser, />\s*Cold Email\s*</);
});

test('adding closed_won moved no existing rows: legacy values keep their old buckets', () => {
  // 'closed' reads like it belongs in the new Won column, but two live leads
  // store that bare value and were never marked won by a human. Every legacy
  // alias must still land exactly where it landed before closed_won existed.
  assert.equal(displayStageFor('closed'), 'closed_lost');
  assert.equal(displayStageFor('lost'), 'closed_lost');
  assert.equal(displayStageFor('new'), 'follow_up');
  assert.equal(displayStageFor('warm'), 'follow_up');
  assert.equal(displayStageFor('proposal'), 'call_booked');
  assert.equal(displayStageFor('hot'), 'hot');
  assert.equal(displayStageFor(''), 'follow_up');
  // Only an explicit closed_won reaches the new column.
  assert.equal(displayStageFor('closed_won'), 'closed_won');
});
