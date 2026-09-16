'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  allocateScheduledSlots, fairShareQueuedOrder, isStaffingCandidate, assignedSenderId,
} = require('../integrations/scheduled-slot-allocator');
const { createSendingWindowQuota, sendingWindowRemainingBySender, consumeSendingWindowSuccess } =
  require('../integrations/sending-window-quota');

const WINDOW_CAP = 5;

function staffing(n, sender = 'primary') {
  return Array.from({ length: n }, (_, i) => ({
    id: `S${i + 1}`, email: `s${i + 1}@staffing.example`,
    leadNiche: 'industrial_staffing', senderInboxId: sender,
  }));
}
function dental(n, sender = 'primary', prefix = 'D') {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i + 1}`, email: `${prefix.toLowerCase()}${i + 1}@dental.example`,
    leadNiche: 'dental', senderInboxId: sender,
  }));
}
const ids = leads => leads.map(l => l.id);
const countBy = leads => ({
  staffing: leads.filter(isStaffingCandidate).length,
  other: leads.filter(l => !isStaffingCandidate(l)).length,
});

// ── The reservation and its spill ────────────────────────────────────────────

test('10 staffing / 10 dental → 3 staffing + 2 dental', () => {
  const { selected } = allocateScheduledSlots([...staffing(10), ...dental(10)], 'primary', WINDOW_CAP);
  assert.deepEqual(countBy(selected), { staffing: 3, other: 2 });
  assert.equal(selected.length, WINDOW_CAP);
});

test('1 staffing / 10 dental → 1 staffing + 4 dental (unused staffing share spills)', () => {
  const { selected } = allocateScheduledSlots([...staffing(1), ...dental(10)], 'primary', WINDOW_CAP);
  assert.deepEqual(countBy(selected), { staffing: 1, other: 4 });
});

test('10 staffing / 1 dental → 4 staffing + 1 dental (unused dental share spills)', () => {
  const { selected } = allocateScheduledSlots([...staffing(10), ...dental(1)], 'primary', WINDOW_CAP);
  assert.deepEqual(countBy(selected), { staffing: 4, other: 1 });
});

test('10 staffing / 0 dental → 5 staffing', () => {
  const { selected } = allocateScheduledSlots(staffing(10), 'primary', WINDOW_CAP);
  assert.deepEqual(countBy(selected), { staffing: 5, other: 0 });
});

test('0 staffing / 10 dental → 5 dental, so staffing never starves dental in reverse', () => {
  const { selected } = allocateScheduledSlots(dental(10), 'primary', WINDOW_CAP);
  assert.deepEqual(countBy(selected), { staffing: 0, other: 5 });
});

test('2 staffing / 2 dental → 4 total, no fabricated candidates', () => {
  const { selected } = allocateScheduledSlots([...staffing(2), ...dental(2)], 'primary', WINDOW_CAP);
  assert.equal(selected.length, 4);
  assert.deepEqual(countBy(selected), { staffing: 2, other: 2 });
  assert.equal(new Set(ids(selected)).size, 4, 'no candidate appears twice');
});

test('capacity is never left idle while an eligible candidate exists', () => {
  for (const [s, d] of [[10, 10], [1, 10], [10, 1], [10, 0], [0, 10], [3, 3], [5, 5], [7, 2]]) {
    const pool = [...staffing(s), ...dental(d)];
    const { selected } = allocateScheduledSlots(pool, 'primary', WINDOW_CAP);
    assert.equal(selected.length, Math.min(WINDOW_CAP, s + d),
      `${s} staffing / ${d} dental should fill min(cap, total)`);
  }
});

test('total selected never exceeds the window cap', () => {
  for (const cap of [0, 1, 2, 3, 4, 5]) {
    const { selected } = allocateScheduledSlots([...staffing(50), ...dental(50)], 'primary', cap);
    assert.ok(selected.length <= cap, `cap ${cap} honoured`);
    assert.equal(selected.length, cap);
  }
});

test('a partial bucket degrades proportionally instead of going to one niche', () => {
  const pool = [...staffing(10), ...dental(10)];
  assert.deepEqual(countBy(allocateScheduledSlots(pool, 'primary', 2).selected), { staffing: 1, other: 1 });
  assert.deepEqual(countBy(allocateScheduledSlots(pool, 'primary', 4).selected), { staffing: 2, other: 2 });
});

// ── The allocator decides order, never eligibility ───────────────────────────

test('an ineligible staffing candidate never reaches the allocator, so it consumes no staffing share', () => {
  // selectQueued filters first; the allocator only ever sees eligible leads.
  const eligible = [...staffing(1), ...dental(10)];
  const { selected } = allocateScheduledSlots(eligible, 'primary', WINDOW_CAP);
  assert.deepEqual(countBy(selected), { staffing: 1, other: 4 },
    'the two filtered-out staffing leads did not hold slots open');
});

test('an ineligible dental candidate never reaches the allocator, so it consumes no dental share', () => {
  const eligible = [...staffing(10), ...dental(1)];
  const { selected } = allocateScheduledSlots(eligible, 'primary', WINDOW_CAP);
  assert.deepEqual(countBy(selected), { staffing: 4, other: 1 });
});

test('a refused candidate wastes no slot: ordered falls through to the next candidate', () => {
  const pool = [...staffing(10), ...dental(10)];
  const { selected, ordered } = allocateScheduledSlots(pool, 'primary', WINDOW_CAP);
  assert.deepEqual(ids(ordered).slice(0, WINDOW_CAP), ids(selected), 'selected leads come first');
  assert.equal(ordered.length, pool.length, 'every candidate remains available to refill');
  assert.equal(new Set(ids(ordered)).size, pool.length, 'no duplicates in the refill order');
});

// ── Determinism ──────────────────────────────────────────────────────────────

test('ordering is deterministic and stable within each niche', () => {
  const pool = [...staffing(10), ...dental(10)];
  const a = allocateScheduledSlots(pool, 'primary', WINDOW_CAP);
  const b = allocateScheduledSlots(pool, 'primary', WINDOW_CAP);
  assert.deepEqual(ids(a.selected), ids(b.selected), 'repeated calls agree');
  assert.deepEqual(ids(a.selected.filter(isStaffingCandidate)), ['S1', 'S2', 'S3'],
    'staffing keeps its input order');
  assert.deepEqual(ids(a.selected.filter(l => !isStaffingCandidate(l))), ['D1', 'D2'],
    'dental keeps its input order');
});

test('neither niche is globally sorted ahead of the other', () => {
  const { selected } = allocateScheduledSlots([...staffing(10), ...dental(10)], 'primary', WINDOW_CAP);
  const shape = selected.map(l => (isStaffingCandidate(l) ? 'S' : 'D')).join('');
  assert.equal(shape, 'SDSDS', 'slots interleave rather than blocking one niche first');
});

// ── The exact production failure mode ────────────────────────────────────────

test('REGRESSION: dental candidates ordered first can no longer consume all five primary slots', () => {
  // Reproduces the observed run: dental sits earlier in sheet order and fills
  // the window, and staffing is then refused with the scheduled-window reason.
  const queuedInSheetOrder = [...dental(10), ...staffing(102)];

  // Old behaviour: walk the list in order until the bucket is spent.
  const oldWindow = queuedInSheetOrder.slice(0, WINDOW_CAP);
  assert.deepEqual(countBy(oldWindow), { staffing: 0, other: 5 },
    'precondition: unordered selection starves staffing completely');

  // New behaviour: the reservation survives the adverse ordering.
  const { selected } = allocateScheduledSlots(queuedInSheetOrder, 'primary', WINDOW_CAP);
  assert.deepEqual(countBy(selected), { staffing: 3, other: 2 });
  assert.deepEqual(ids(selected.filter(isStaffingCandidate)), ['S1', 'S2', 'S3']);
});

test('REGRESSION: the reverse ordering does not starve dental either', () => {
  const { selected } = allocateScheduledSlots([...staffing(102), ...dental(10)], 'primary', WINDOW_CAP);
  assert.deepEqual(countBy(selected), { staffing: 3, other: 2 });
});

// ── Caps and routing are untouched ───────────────────────────────────────────

test('the per-inbox scheduled-window cap of 5 still bounds the allocation', () => {
  const quota = createSendingWindowQuota({ senderIds: ['primary'], perSenderLimit: 5, globalLimit: 10 });
  const remaining = sendingWindowRemainingBySender(quota).get('primary');
  assert.equal(remaining, 5);
  const { selected } = allocateScheduledSlots([...staffing(50), ...dental(50)], 'primary', remaining);
  assert.equal(selected.length, 5);
});

test('a bucket already partly spent allocates only what is left', () => {
  const quota = createSendingWindowQuota({ senderIds: ['primary'], perSenderLimit: 5, globalLimit: 10 });
  consumeSendingWindowSuccess(quota, 'primary');
  consumeSendingWindowSuccess(quota, 'primary');
  const remaining = sendingWindowRemainingBySender(quota).get('primary');
  assert.equal(remaining, 3);
  const { selected } = allocateScheduledSlots([...staffing(50), ...dental(50)], 'primary', remaining);
  assert.equal(selected.length, 3, 'never over-allocates a partly spent window');
});

test('the global scheduled-window limit still bounds the per-sender remaining', () => {
  const quota = createSendingWindowQuota({ senderIds: ['primary', 'tryscalelabai'], perSenderLimit: 5, globalLimit: 10 });
  for (let i = 0; i < 5; i++) consumeSendingWindowSuccess(quota, 'tryscalelabai');
  for (let i = 0; i < 5; i++) consumeSendingWindowSuccess(quota, 'primary');
  assert.equal(sendingWindowRemainingBySender(quota).get('primary'), 0);
  const { selected } = allocateScheduledSlots(staffing(50), 'primary', 0);
  assert.equal(selected.length, 0, 'a spent global window allocates nothing');
});

test('allocation is per sender: another inbox keeps its own independent bucket', () => {
  const pool = [...staffing(10, 'primary'), ...dental(10, 'tryscalelabai')];
  const primary = allocateScheduledSlots(pool, 'primary', WINDOW_CAP);
  const secondary = allocateScheduledSlots(pool, 'tryscalelabai', WINDOW_CAP);
  assert.deepEqual(countBy(primary.selected), { staffing: 5, other: 0 });
  assert.deepEqual(countBy(secondary.selected), { staffing: 0, other: 5 });
  assert.ok(primary.selected.every(l => assignedSenderId(l) === 'primary'),
    'no lead is allocated against a sender it is not assigned to');
});

test('no sender fallback is introduced: unassigned leads are not allocated to a named bucket', () => {
  const unassigned = [{ id: 'U1', email: 'u1@x.example', leadNiche: 'dental', senderInboxId: '' }];
  const { selected, ordered } = allocateScheduledSlots([...staffing(2), ...unassigned], 'primary', WINDOW_CAP);
  assert.ok(!ids(selected).includes('U1'), 'unassigned lead never claims a primary slot');
  assert.ok(!ids(ordered).includes('U1'));
});

test('fairShareQueuedOrder preserves every candidate exactly once, unassigned leads last', () => {
  const pool = [
    ...dental(3, 'primary'), ...staffing(3, 'primary'),
    ...dental(2, 'tryscalelabai', 'T'),
    { id: 'U1', email: 'u1@x.example', leadNiche: 'dental', senderInboxId: '' },
  ];
  const ordered = fairShareQueuedOrder(pool, () => WINDOW_CAP);
  assert.equal(ordered.length, pool.length, 'no candidate is dropped');
  assert.equal(new Set(ids(ordered)).size, pool.length, 'no candidate is duplicated');
  assert.equal(ordered[ordered.length - 1].id, 'U1', 'dynamically routed leads keep their place at the end');
  const primarySlice = ordered.filter(l => assignedSenderId(l) === 'primary').slice(0, WINDOW_CAP);
  assert.deepEqual(countBy(primarySlice), { staffing: 3, other: 2 });
});

test('fairShareQueuedOrder is a no-op on ordering when only one niche is queued', () => {
  const pool = dental(4, 'primary');
  assert.deepEqual(ids(fairShareQueuedOrder(pool, () => WINDOW_CAP)), ids(pool),
    'backward compatible: a single-niche queue keeps its existing order');
});

// ── Wiring ───────────────────────────────────────────────────────────────────

test('the agent applies the allocator to the step-1 batch, after selectQueued', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');
  assert.match(src, /require\('\.\/integrations\/scheduled-slot-allocator'\)/);
  assert.match(src, /const newBatch\s+= fairShareQueuedOrder\(queued,/,
    'the step-1 batch is the fair-share ordering of the already-filtered queue');
  const selectAt = src.indexOf('const queued = selectQueued(all)');
  const allocAt = src.indexOf('fairShareQueuedOrder(queued,');
  assert.ok(selectAt > 0 && allocAt > selectAt, 'allocation happens after eligibility filtering');
});

test('the allocator is pure: no imports, no I/O, no mutation of its input', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'integrations', 'scheduled-slot-allocator.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // Nothing to require means nothing to send with, reserve with, or write to.
  assert.doesNotMatch(code, /\brequire\(/, 'the allocator imports nothing');
  for (const forbidden of [/consumeSendingWindowSuccess/, /sendEmail/, /gmail/i, /await\b/, /process\.env/]) {
    assert.doesNotMatch(code, forbidden, `the allocator must not reference ${forbidden}`);
  }

  const pool = [...staffing(4), ...dental(4)];
  const snapshot = ids(pool);
  const result = allocateScheduledSlots(pool, 'primary', WINDOW_CAP);
  assert.deepEqual(ids(pool), snapshot, 'the input array is not reordered in place');
  assert.ok(result.selected.every(lead => pool.includes(lead)),
    'it returns the caller\'s own lead objects, never copies or fabrications');
});
