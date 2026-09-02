'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const audit = fs.readFileSync(path.join(root, 'scripts', 'audit-gmail-crm-sends.js'), 'utf8');

test('the production send audit is authenticated and read-only', () => {
  assert.match(server, /app\.get\('\/api\/ops\/send-audit', requireAuth/);
  assert.match(audit, /spreadsheets\.readonly/);
  assert.match(audit, /spreadsheets\.values\.batchGet/);
  assert.match(audit, /ordinaryFollowUpOwnership/);
  assert.doesNotMatch(audit, /gmail\.users\.messages\.send|spreadsheets\.values\.(?:append|update|batchUpdate)/);
});

test('recovery can only checkpoint exact Gmail SENT evidence', () => {
  const route = server.slice(
    server.indexOf("app.post('/api/ops/send-recovery'"),
    server.indexOf("app.get('/api/outreach/routing-options'"),
  );
  assert.match(route, /requireAuth/);
  assert.match(route, /messages\.get/);
  assert.match(route, /includes\('SENT'\)/);
  assert.match(route, /from\.includes\(mailbox\.email\)/);
  assert.match(route, /recipients\.includes\(normalizeEmail\(lead\.email\)\)/);
  assert.doesNotMatch(route, /messages\.send|sendEmail|spawnAgent/);
});

test('ordinary sends reserve a deterministic provider identity before delivery', () => {
  const agent = fs.readFileSync(path.join(root, 'outreach-agent.js'), 'utf8');
  const delivery = agent.slice(
    agent.indexOf('async function deliverOrdinaryColdStep'),
    agent.indexOf('async function markReplied'),
  );
  assert.match(delivery, /ordinary_send_reserved/);
  assert.match(delivery, /coldStepRfcMessageId/);
  assert.match(delivery, /findSuccessfulSequenceSend/);
  assert.match(delivery, /await sendEmail/);
});
