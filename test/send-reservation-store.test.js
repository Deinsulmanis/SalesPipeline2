'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createMemorySendReservationStore } = require('../integrations/send-reservation-memory');
const { STATUS, canTakeOver, shouldMarkReconciliation } = require('../integrations/send-reservation-rules');
const { ordinaryColdActionId, stageSequenceActionId, smartleadEnqueueActionId, warmReplyActionId } = require('../integrations/outbound-action-id');
const { isDefinitePreDeliveryFailure } = require('../integrations/provider-delivery-error');

const migration = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '20260917000000_outbound_send_reservations.sql'), 'utf8');

function action(id = 'gmail-cold:L1:step:1') {
  return { actionId: id, leadId: 'L1', actionType: 'gmail_cold_step', provider: 'gmail' };
}

test('schema has unique action_id and no generic failed status', () => {
  assert.match(migration, /action_id\s+text PRIMARY KEY/);
  assert.match(migration, /failed_pre_delivery/);
  assert.match(migration, /reconciliation_required/);
  assert.match(migration, /sent_unconfirmed/);
  assert.doesNotMatch(migration, /'failed'/);
  assert.match(migration, /SEND_LOCK_DATABASE_URL/);
  assert.doesNotMatch(migration, /SUPABASE_URL/);
});

test('action ids are deterministic and distinct across leads', () => {
  assert.equal(ordinaryColdActionId('L1', 1), ordinaryColdActionId('L1', '1'));
  assert.notEqual(ordinaryColdActionId('L1', 1), ordinaryColdActionId('L2', 1));
  assert.notEqual(ordinaryColdActionId('L1', 1), ordinaryColdActionId('L1', 2));
  assert.equal(stageSequenceActionId('CE-L1', 'hot_stale_v1', 1), 'seq:CE-L1:hot_stale_v1:1');
  assert.equal(smartleadEnqueueActionId('L1', '99'), smartleadEnqueueActionId('L1', '99'));
  assert.notEqual(smartleadEnqueueActionId('L1', '99'), smartleadEnqueueActionId('L1', '100'));
  assert.equal(warmReplyActionId('L1', 'm1', 'AUTO_BOOKING_RESPONSE'), warmReplyActionId('L1', 'm1', 'AUTO_BOOKING_RESPONSE'));
  assert.notEqual(warmReplyActionId('L1', 'm1', 'A'), warmReplyActionId('L1', 'm1', 'B'));
});

test('definite 4xx is pre-delivery; timeout/5xx/checkpoint-gap are not', () => {
  const four = new Error('bad'); four.response = { status: 400 };
  const timeout = new Error('timeout'); timeout.code = 408;
  const five = new Error('oops'); five.response = { status: 500 };
  const gap = new Error('gap'); gap.code = 'durable_checkpoint_failed';
  assert.equal(isDefinitePreDeliveryFailure(four), true);
  assert.equal(isDefinitePreDeliveryFailure(timeout), false);
  assert.equal(isDefinitePreDeliveryFailure(five), false);
  assert.equal(isDefinitePreDeliveryFailure(gap), false);
  assert.equal(isDefinitePreDeliveryFailure(new Error('ECONNRESET')), false);
});

test('expired reserved lease without provider attempt is take-over eligible', () => {
  const now = new Date('2026-09-17T12:00:00.000Z');
  assert.equal(canTakeOver({
    status: STATUS.RESERVED, providerAttemptStartedAt: null,
    leaseExpiresAt: '2026-09-17T11:59:00.000Z',
  }, now), true);
  assert.equal(canTakeOver({
    status: STATUS.RESERVED, providerAttemptStartedAt: '2026-09-17T11:50:00.000Z',
    leaseExpiresAt: '2026-09-17T11:59:00.000Z',
  }, now), false);
  assert.equal(canTakeOver({
    status: STATUS.SENDING, providerAttemptStartedAt: '2026-09-17T11:50:00.000Z',
    leaseExpiresAt: '2026-09-17T11:59:00.000Z',
  }, now), false);
  assert.equal(shouldMarkReconciliation({
    status: STATUS.SENDING, leaseExpiresAt: '2026-09-17T11:59:00.000Z',
  }, now), true);
});

test('memory store: first reserve wins; second is denied', async () => {
  const store = createMemorySendReservationStore();
  const a = await store.reserveOutboundAction(action(), { leaseOwner: 'w1', leaseSeconds: 60 });
  const b = await store.reserveOutboundAction(action(), { leaseOwner: 'w2', leaseSeconds: 60 });
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.equal(b.code, 'reservation_leased');
});

test('memory store: crash before provider attempt allows takeover after expiry', async () => {
  let now = new Date('2026-09-17T12:00:00.000Z');
  const store = createMemorySendReservationStore({ now: () => now, leaseSeconds: 30 });
  assert.equal((await store.reserveOutboundAction(action(), { leaseOwner: 'w1' })).ok, true);
  now = new Date('2026-09-17T12:00:31.000Z');
  const again = await store.reserveOutboundAction(action(), { leaseOwner: 'w2' });
  assert.equal(again.ok, true);
  assert.equal(again.reservation.leaseOwner, 'w2');
  assert.equal(again.reservation.providerAttemptStartedAt, null);
});

test('memory store: crash after provider attempt forbids resend after expiry', async () => {
  let now = new Date('2026-09-17T12:00:00.000Z');
  const store = createMemorySendReservationStore({ now: () => now, leaseSeconds: 30 });
  await store.reserveOutboundAction(action(), { leaseOwner: 'w1' });
  await store.markProviderAttemptStarted(action().actionId, 'w1');
  now = new Date('2026-09-17T12:00:31.000Z');
  const again = await store.reserveOutboundAction(action(), { leaseOwner: 'w2' });
  assert.equal(again.ok, false);
  assert.equal(again.existing.status, STATUS.RECONCILIATION_REQUIRED);
});

test('memory store: Gmail success records provider ids and blocks a second send', async () => {
  const store = createMemorySendReservationStore();
  await store.reserveOutboundAction(action(), { leaseOwner: 'w1', leaseSeconds: 60 });
  await store.markProviderAttemptStarted(action().actionId, 'w1');
  const saved = await store.markProviderSucceeded(action().actionId, 'w1', { providerMessageId: 'm1', providerThreadId: 't1' });
  assert.equal(saved.reservation.status, STATUS.SENT_UNCONFIRMED);
  assert.equal(saved.reservation.providerMessageId, 'm1');
  const again = await store.reserveOutboundAction(action(), { leaseOwner: 'w2', leaseSeconds: 60 });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'reservation_sent_unconfirmed');
});

test('memory store: definite pre-delivery failure can be retried; owner cannot mutate another lease', async () => {
  const store = createMemorySendReservationStore();
  await store.reserveOutboundAction(action(), { leaseOwner: 'w1', leaseSeconds: 60 });
  await store.markProviderAttemptStarted(action().actionId, 'w1');
  const other = await store.markProviderSucceeded(action().actionId, 'w2', { providerMessageId: 'x' });
  assert.equal(other.ok, false);
  assert.equal(other.code, 'reservation_not_owned');
  const failed = await store.markPreDeliveryFailed(action().actionId, 'w1', '400 bad recipient');
  assert.equal(failed.ok, true);
  const retry = await store.reserveOutboundAction(action(), { leaseOwner: 'w2', leaseSeconds: 60 });
  assert.equal(retry.ok, true);
});

test('memory store: confirmed action never sends again', async () => {
  const store = createMemorySendReservationStore();
  await store.reserveOutboundAction(action(), { leaseOwner: 'w1', leaseSeconds: 60 });
  await store.markProviderAttemptStarted(action().actionId, 'w1');
  await store.markProviderSucceeded(action().actionId, 'w1', { providerMessageId: 'm1' });
  await store.markConfirmed(action().actionId, 'w1');
  const again = await store.reserveOutboundAction(action(), { leaseOwner: 'w2', leaseSeconds: 60 });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'reservation_confirmed');
});
