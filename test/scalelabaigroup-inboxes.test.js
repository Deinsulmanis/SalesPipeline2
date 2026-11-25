'use strict';

// The three scalelabaigroup.com inboxes (connected 2026-11-25): ScaleLab's own,
// registered in warm-up, so they cannot send until the owner readies them.

const test = require('node:test');
const assert = require('node:assert/strict');

const registry = require('../integrations/gmail-inbox-registry');
const { configuredSenders } = require('../integrations/gmail-sender-routing');
const { coldSenderVerdict } = require('../integrations/cold-delivery-policy');
const { markWarmupReady, activationBlockers } = require('../integrations/gmail-sender-lifecycle');

const IDS = ['scalelabaigroup_deins', 'scalelabaigroup_deniels', 'scalelabaigroup_ulmanis'];
const TOKEN = JSON.stringify({ refresh_token: 'test-refresh-token' });
const ENV = Object.fromEntries(IDS.map(id => [`GMAIL_${id.toUpperCase()}_TOKEN_JSON`, TOKEN]));
const all = () => registry.withDefaultInboxes(registry.parseRegistry('[]', ENV), ENV);
const rows = () => all().filter(row => IDS.includes(row.id));

test('registered once each, ScaleLab-owned, each with its own credential variable', () => {
  assert.deepEqual(rows().map(row => [row.id, row.email, row.clientId, row.tokenEnv, row.fromName || null]), [
    ['scalelabaigroup_deins', 'deins@scalelabaigroup.com', 'scalelab', 'GMAIL_SCALELABAIGROUP_DEINS_TOKEN_JSON', 'Deins Ulmanis'],
    ['scalelabaigroup_deniels', 'deniels@scalelabaigroup.com', 'scalelab', 'GMAIL_SCALELABAIGROUP_DENIELS_TOKEN_JSON', null],
    ['scalelabaigroup_ulmanis', 'ulmanis@scalelabaigroup.com', 'scalelab', 'GMAIL_SCALELABAIGROUP_ULMANIS_TOKEN_JSON', 'Deins Ulmanis'],
  ]);
  const every = all();
  for (const key of ['id', 'email', 'tokenEnv']) {
    assert.equal(new Set(every.map(row => row[key])).size, every.length, `no duplicate ${key}`);
  }
  for (const row of rows()) assert.equal((row.policyBlockers || []).length, 0, `${row.id} passes ScaleLab sender policy`);
});

test('warm-up mode: never send-eligible, even credentialed and outside any hold or pool', () => {
  for (const row of rows()) {
    assert.equal(row.status, 'warming');
    assert.equal(registry.sendEligibleFor(row, ENV), false);
    assert.equal(registry.assertDormant(row), true);
    assert.equal(row.observerEnabled, true, 'observed from now onward, so warm-up mail is never a reply');
  }
  for (const sender of configuredSenders({ ...ENV, COLD_SENDER_HOLDS: 'none', COLD_SENDER_POOL: 'all' }).filter(item => IDS.includes(item.id))) {
    assert.equal(sender.sendEligible, false, `${sender.id} cannot send`);
    assert.equal(coldSenderVerdict(sender, { COLD_SENDER_POOL: 'all', COLD_SENDER_HOLDS: 'none' }).allowed, false);
  }
});

test('when warm-up is done: Mark ready, then Activate works at 25/day and 3 per window with no code change', () => {
  for (const row of rows()) {
    assert.equal(row.dailyLimit, 25);
    assert.equal(row.perRunLimit, 3);
    const ready = markWarmupReady(row);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.sendEligible, false, 'ready is still not sending');
    // With a healthy observer and credential, the only activation checks pass.
    const blockers = activationBlockers({ ...ready, credentialConfigured: true },
      { observer: { health: 'healthy', cursorState: 'present' }, senders: all(), env: { COLD_SENDER_HOLDS: 'none' } });
    assert.deepEqual(blockers, [], `${row.id}: ${blockers.join('; ')}`);
  }
});
