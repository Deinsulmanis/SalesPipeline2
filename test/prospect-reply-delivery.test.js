'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { deliverProspectReply, responseActionId } = require('../integrations/prospect-reply-delivery');
const base = { lead: { id: 'l1', email: 'lead@example.com' }, sender: { id: 'primary', email: 'me@example.com', sendEligible: true },
  thread: { threadId: 't1' }, inboundMessage: { messageId: 'm1', rfcMessageId: '<m1@example.com>' },
  action: 'AUTO_BOOKING_RESPONSE', subject: 'Re: hello', body: 'Book here' };
const harness = overrides => { const calls = []; return { calls, deps: {
  findDelivered: async () => overrides?.recovered || null, existingReservation: async () => overrides?.reservation || null,
  existingDelivery: async () => Boolean(overrides?.checkpointed),
  finalRevalidate: async () => overrides?.gate || { allowed: true }, verifyThread: async () => overrides?.thread || { ok: true },
  persistReservation: async x => { calls.push('reserve'); return x; }, sendProvider: async x => { calls.push('send'); return { data: { id: 'out', threadId: x.threadId } }; },
  consumeQuota: () => calls.push('quota'), persistDelivered: async () => { calls.push('persist'); if (overrides?.checkpointFailure) throw new Error('sheet'); },
  persistFailure: async () => calls.push('failure'),
} }; };

test('action identity is stable for duplicate observer delivery', () => assert.equal(responseActionId('l1','m1','A'), responseActionId('l1','m1','A')));
test('reservation precedes provider and provider success consumes quota before checkpoint', async () => { const h = harness(); const out = await deliverProspectReply(base, h.deps); assert.equal(out.delivered, true); assert.deepEqual(h.calls, ['reserve','send','quota','persist']); });
test('CHECK_ONLY and final stale-state revalidation cannot send', async () => { let h = harness(); assert.equal((await deliverProspectReply({ ...base, checkOnly: true }, h.deps)).code, 'check_only'); assert.deepEqual(h.calls, []); h = harness({ gate: { allowed: false, code: 'meeting_booked' } }); assert.equal((await deliverProspectReply(base, h.deps)).code, 'meeting_booked'); assert.deepEqual(h.calls, []); });
test('unresolved reservation blocks duplicate run', async () => { const h = harness({ reservation: { unresolved: true } }); assert.equal((await deliverProspectReply(base, h.deps)).code, 'reservation_unresolved'); assert.deepEqual(h.calls, []); });
test('Gmail recovery checkpoints without another provider call', async () => { const h = harness({ recovered: { providerMessageId: 'out' } }); const out = await deliverProspectReply(base, h.deps); assert.equal(out.recovered, true); assert.deepEqual(h.calls, ['persist','quota']); });
test('a completed action replay does not consume quota again', async () => { const h = harness({ checkpointed: true, recovered: { providerMessageId: 'out' } }); const out = await deliverProspectReply(base, h.deps); assert.equal(out.alreadyCheckpointed, true); assert.deepEqual(h.calls, []); });
test('ambiguous timeout keeps reservation unresolved', async () => { const h = harness(); h.deps.sendProvider = async () => { h.calls.push('send'); throw new Error('timeout'); }; assert.equal((await deliverProspectReply(base, h.deps)).code, 'provider_ambiguous'); assert.deepEqual(h.calls, ['reserve','send']); });
test('definite 4xx writes failure marker and can be retried', async () => { const h = harness(); h.deps.sendProvider = async () => { h.calls.push('send'); const e = new Error('bad recipient'); e.response = { status: 400 }; throw e; }; assert.equal((await deliverProspectReply(base, h.deps)).code, 'provider_rejected'); assert.deepEqual(h.calls, ['reserve','send','failure']); });
