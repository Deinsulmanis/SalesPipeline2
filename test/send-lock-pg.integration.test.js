'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPgSendReservationStore } = require('../integrations/send-reservation-store');
const { STATUS } = require('../integrations/send-reservation-rules');
const { ordinaryColdActionId } = require('../integrations/outbound-action-id');

const url = process.env.SEND_LOCK_TEST_DATABASE_URL || '';

function action(suffix) {
  return {
    actionId: `${ordinaryColdActionId('pg', 1)}:${suffix}:${Date.now()}:${Math.random()}`,
    leadId: 'pg-lead',
    actionType: 'gmail_cold_step',
    provider: 'gmail',
  };
}

test('postgres integration is skipped unless SEND_LOCK_TEST_DATABASE_URL is set', () => {
  if (!url) {
    assert.equal(url, '');
    return;
  }
  assert.match(url, /^postgres/);
});

test('postgres unique constraint and concurrent reservation: exactly one winner', { skip: !url }, async () => {
  const store = createPgSendReservationStore({ connectionString: url });
  await store.applyMigration();
  const target = action('race');
  try {
    const [a, b] = await Promise.all([
      store.reserveOutboundAction(target, { leaseOwner: 'pg-a', leaseSeconds: 60 }),
      store.reserveOutboundAction(target, { leaseOwner: 'pg-b', leaseSeconds: 60 }),
    ]);
    const wins = [a, b].filter(item => item.ok);
    const losses = [a, b].filter(item => !item.ok);
    assert.equal(wins.length, 1);
    assert.equal(losses.length, 1);
    assert.equal(losses[0].code, 'reservation_leased');
  } finally {
    await store.close();
  }
});

test('postgres lease takeover only before provider attempt', { skip: !url }, async () => {
  const store = createPgSendReservationStore({ connectionString: url });
  await store.applyMigration();
  const target = action('takeover');
  try {
    const first = await store.reserveOutboundAction(target, { leaseOwner: 'dead', leaseSeconds: 1 });
    assert.equal(first.ok, true);
    await new Promise(resolve => setTimeout(resolve, 1200));
    const takeover = await store.reserveOutboundAction(target, { leaseOwner: 'live', leaseSeconds: 30 });
    assert.equal(takeover.ok, true);
    assert.equal(takeover.reservation.leaseOwner, 'live');
    await store.markProviderAttemptStarted(target.actionId, 'live');
    await new Promise(resolve => setTimeout(resolve, 50));
    const started = await store.getReservation(target.actionId);
    assert.equal(started.status, STATUS.SENDING);
    assert.ok(started.providerAttemptStartedAt);
  } finally {
    await store.close();
  }
});

test('postgres expired sending lease cannot be resent', { skip: !url }, async () => {
  const store = createPgSendReservationStore({ connectionString: url });
  await store.applyMigration();
  const target = action('sending');
  try {
    await store.reserveOutboundAction(target, { leaseOwner: 'dead', leaseSeconds: 1 });
    await store.markProviderAttemptStarted(target.actionId, 'dead');
    await new Promise(resolve => setTimeout(resolve, 1200));
    const again = await store.reserveOutboundAction(target, { leaseOwner: 'live', leaseSeconds: 30 });
    assert.equal(again.ok, false);
    assert.ok(['reservation_sending', 'reservation_reconciliation_required'].includes(again.code));
    const row = await store.getReservation(target.actionId);
    assert.ok(row.status === STATUS.SENDING || row.status === STATUS.RECONCILIATION_REQUIRED);
    assert.notEqual(row.status, STATUS.RESERVED);
  } finally {
    await store.close();
  }
});

test('postgres SELECT 1 health and schema verification', { skip: !url }, async () => {
  const store = createPgSendReservationStore({ connectionString: url });
  try {
    await store.applyMigration();
    const health = await store.health();
    assert.equal(health.ok, true);
    const verified = await store.verifySchema();
    assert.equal(verified.ok, true);
    assert.deepEqual(verified.primaryKey, ['action_id']);
  } finally {
    await store.close();
  }
});
