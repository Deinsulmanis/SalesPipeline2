'use strict';

// The three pre-warmed outreachplateau.co inboxes (connected 2026-11-19):
// ScaleLab's own, sending as Deins Ulmanis, registered inactive.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const registry = require('../integrations/gmail-inbox-registry');
const { configuredSenders } = require('../integrations/gmail-sender-routing');
const { coldSenderVerdict } = require('../integrations/cold-delivery-policy');

const IDS = ['outreachplateau_zoe', 'outreachplateau_merrick', 'outreachplateau_dave'];
const TOKEN = JSON.stringify({ refresh_token: 'test-refresh-token' });
const ENV = Object.fromEntries(IDS.map(id => [`GMAIL_${id.toUpperCase()}_TOKEN_JSON`, TOKEN]));

const rows = () => registry.withDefaultInboxes(registry.parseRegistry('[]', ENV), ENV).filter(row => IDS.includes(row.id));

test('the three inboxes are registered once each, ScaleLab-owned, with their own credential variable', () => {
  const found = rows();
  assert.deepEqual(found.map(row => [row.id, row.email, row.clientId, row.tokenEnv, row.fromName]), [
    ['outreachplateau_zoe', 'zoe@outreachplateau.co', 'scalelab', 'GMAIL_OUTREACHPLATEAU_ZOE_TOKEN_JSON', 'Deins Ulmanis'],
    ['outreachplateau_merrick', 'merrick@outreachplateau.co', 'scalelab', 'GMAIL_OUTREACHPLATEAU_MERRICK_TOKEN_JSON', 'Deins Ulmanis'],
    ['outreachplateau_dave', 'dave@outreachplateau.co', 'scalelab', 'GMAIL_OUTREACHPLATEAU_DAVE_TOKEN_JSON', 'Deins Ulmanis'],
  ]);
  const all = registry.withDefaultInboxes(registry.parseRegistry('[]', ENV), ENV);
  assert.equal(new Set(all.map(row => row.id)).size, all.length, 'no duplicate sender ids');
  assert.equal(new Set(all.map(row => row.email)).size, all.length, 'no duplicate addresses');
  assert.equal(new Set(all.map(row => row.tokenEnv)).size, all.length, 'no shared credential variable');
  for (const row of found) assert.equal((row.policyBlockers || []).length, 0, `${row.id} passes ScaleLab sender policy`);
});

test('ready at 20/day and 2 per window, but not send-eligible until activated', () => {
  for (const row of rows()) {
    assert.equal(row.status, 'ready');
    assert.equal(row.dailyLimit, 20);
    assert.equal(row.perRunLimit, 2);
    assert.equal(registry.sendEligibleFor(row, ENV), false, `${row.id} sends nothing until activated`);
    // Once activated (runtime status active) it may send, at exactly these caps.
    assert.equal(registry.sendEligibleFor({ ...row, status: 'active' }, ENV), true);
  }
  for (const sender of configuredSenders({ ...ENV, COLD_SENDER_HOLDS: 'none', COLD_SENDER_POOL: 'all' }).filter(item => IDS.includes(item.id))) {
    assert.equal(sender.sendEligible, false, `${sender.id} cannot send campaign email`);
    assert.equal(coldSenderVerdict(sender, { COLD_SENDER_POOL: 'all', COLD_SENDER_HOLDS: 'none' }).allowed, false);
  }
});

test('observation is on and starts from now onward, so warm-up history is never read as replies', () => {
  for (const row of rows()) assert.equal(row.observerEnabled, true);
  const observer = fs.readFileSync(path.join(__dirname, '..', 'integrations', 'gmail-mailbox-observer.js'), 'utf8');
  assert.match(observer, /Safe bootstrap establishes "from now onward" and deliberately returns no\s*\n\s*\/\/ messages\./);
  assert.match(observer, /return \{ ids: \[\], nextHistoryId: profile\.data\.historyId \|\| null, mode: 'bootstrap', pages: 0 \};/);
});

test('ScaleLab inboxes with a registry fromName send under it; others keep the shared name', () => {
  const agent = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');
  const start = agent.indexOf('function fromNameForSender(sender) {');
  const body = agent.slice(start, agent.indexOf('\n}\n', start));
  assert.match(body, /if \(sender\?\.fromName && \(!ownClient \|\| getManagedClient\(ownClient\)\.isDefault\)\) return sender\.fromName;/);
  // Lent inboxes and Jole's own keep their existing names.
  assert.match(body, /if \(sender\?\.delegatedFromClientId && sender\.fromName\) return sender\.fromName;/);
  assert.match(body, /return client\.isDefault \? FROM_NAME : \(client\.senderIdentity\?\.fromName \|\| client\.displayName\);/);
  // The name is sanitised to plain text in the registry.
  const parsed = registry.parseRegistry(JSON.stringify([{ id: 'x_test', email: 'x@outreach-test.invalid', status: 'warming',
    tokenEnv: 'GMAIL_X_TEST_TOKEN_JSON', dailyLimit: 0, perRunLimit: 0, fromName: 'Deins\r\nBcc: <a@b>' }]), {});
  assert.equal(parsed[0].fromName, 'DeinsBcc: a@b');
});
