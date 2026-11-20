'use strict';

// 2026-11-20: queueing Industrial Campaign 3 with senderInboxId "auto" assigned
// leads to scalelabaiteam, an inbox on the cold sender hold list. The final
// gate would never send from it, so the lead would only be stranded. Automatic
// assignment and the scheduled refill now take their senders from
// coldAssignableSenders: in the cold pool and not on the hold list.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { coldAssignableSenders } = require('../integrations/sender-balance');

const SENDERS = [{ id: 'primary' }, { id: 'deniels' }, { id: 'scalelabaiteam' }, { id: 'tryscalelabai' },
  { id: 'outreachplateau_zoe' }, { id: 'jole_team_jorge', clientId: 'jole' }];

test('held inboxes are never assignable', () => {
  const env = { COLD_SENDER_POOL: 'all', COLD_SENDER_HOLDS: 'scalelabaiteam:mailbox_archived,tryscalelabai:mailbox_archived' };
  assert.deepEqual(coldAssignableSenders(SENDERS, env).map(s => s.id), ['primary', 'deniels', 'outreachplateau_zoe', 'jole_team_jorge']);
});

test('a restricted cold pool limits assignment to the pool', () => {
  const env = { COLD_SENDER_POOL: 'primary,outreachplateau_zoe', COLD_SENDER_HOLDS: 'none' };
  assert.deepEqual(coldAssignableSenders(SENDERS, env).map(s => s.id), ['primary', 'outreachplateau_zoe']);
});

test('the default holds apply when COLD_SENDER_HOLDS is unset', () => {
  const ids = coldAssignableSenders(SENDERS, { COLD_SENDER_POOL: 'all' }).map(s => s.id);
  assert.ok(!ids.includes('tryscalelabai'), 'tryscalelabai is held by default');
});

test('both automatic queue assignment and the refill use the filter', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /assignBatch\(\{ batch, input: \{ \.\.\.state, senders: coldAssignableSenders\(configuredSenders\(\)\)/);
  const loader = src.slice(src.indexOf('async function loadSenderBalanceInput'), src.indexOf('function insideSendWindow'));
  assert.match(loader, /senders: coldAssignableSenders\(configuredSenders\(\)\)/);
  assert.doesNotMatch(loader, /senders: configuredSenders\(\),/);
});
