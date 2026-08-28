'use strict';

// Phase 2.1 — the historical reconciliation writer.
//
// This is the only Phase 2.1 component that can change production, so the tests
// are weighted toward what it must REFUSE to do. Several assert the absence of
// a capability rather than the behaviour of one: the writer is handed a single
// append function and nothing else, so whole classes of damage are unreachable.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  WRITE_OUTCOME, ABORT_REASON, applyReconciliation, compareToApproved, planManifest,
} = require('../integrations/reconciliation-writer');
const { RECONCILE_STATUS } = require('../integrations/reply-reconciliation');

const root = path.join(__dirname, '..');
const readSource = file => fs.readFileSync(file, 'utf8').split('\r\n').join('\n');

const event = (leadId, messageId, over = {}) => ({
  eventId: `gmail-reply:${messageId}`,
  leadId: `CE-${leadId}`, sourceLeadId: leadId, email: `${leadId}@clinic.test`,
  company: `${leadId} Clinic`, eventType: 'positive_reply',
  occurredAt: '2026-08-10T10:00:00.000Z', subject: 'Re: note',
  metadata: {
    provider: 'gmail', gmailMessageId: messageId, gmailThreadId: `t-${messageId}`,
    receivedAt: '2026-08-10T10:00:00.000Z', matchedColdEmailId: leadId,
    canonicalState: 'positive', subtype: null, reason: 'explicit_evaluation_intent',
    classifierVersion: 'reply_v2_evidence', confidence: 'high',
    evidenceSignals: ['pricing'], genuineHuman: true,
    returnDate: null, proposedEmail: null, identityMutationAllowed: false,
    source: 'historical_reconciliation',
    legacyTag: 'Not Interested', legacyState: 'negative', supersedesLegacyTag: true,
    isRepresentative: true,
    ...over,
  },
});

const plan = (leadId, messageIds, over = {}) => ({
  status: RECONCILE_STATUS.PROPOSED, leadId, company: `${leadId} Clinic`,
  email: `${leadId}@clinic.test`,
  proposedEvents: messageIds.map(id => event(leadId, id)),
  ...over,
});

const approvedFor = plans => planManifest(plans);

function recorder() {
  const written = [];
  return { written, append: async record => { written.push(record); } };
}

// ── Explicit application ────────────────────────────────────────────────────

test('the writer does nothing unless application is explicitly requested', async () => {
  const plans = [plan('a', ['m1'])];
  const sink = recorder();
  const dry = await applyReconciliation({
    plans, approved: approvedFor(plans), appendActivity: sink.append,
  });
  assert.equal(dry.applied, false);
  assert.equal(dry.written, 0);
  assert.equal(dry.wouldWrite, 1);
  assert.equal(sink.written.length, 0, 'a default invocation must not mutate anything');

  const live = await applyReconciliation({
    plans, approved: approvedFor(plans), appendActivity: sink.append, apply: true,
  });
  assert.equal(live.applied, true);
  assert.equal(live.written, 1);
  assert.equal(sink.written.length, 1);
});

test('apply without an append capability aborts rather than silently succeeding', async () => {
  const plans = [plan('a', ['m1'])];
  await assert.rejects(
    () => applyReconciliation({ plans, approved: approvedFor(plans), apply: true }),
    err => err.aborted === true);
});

// ── Approved-set enforcement ────────────────────────────────────────────────

test('a plan that drifted from the approved set aborts and explains the drift', async () => {
  const reviewed = [plan('a', ['m1'])];
  const approved = approvedFor(reviewed);
  // Production moved on: a new reply arrived for another lead.
  const regenerated = [plan('a', ['m1']), plan('b', ['m2'])];
  const sink = recorder();
  await assert.rejects(
    () => applyReconciliation({ plans: regenerated, approved, appendActivity: sink.append, apply: true }),
    err => err.reason === ABORT_REASON.PLAN_DRIFT);
  assert.equal(sink.written.length, 0, 'nothing is written when the set changed');

  // The diff names what changed, so a human can decide whether to re-review.
  const comparison = compareToApproved(regenerated, approved);
  assert.deepEqual(comparison.diff.leadsAdded, ['b']);
  assert.deepEqual(comparison.diff.messagesAdded, ['m2']);
  assert.equal(comparison.diff.matches, false);
});

test('a plan missing an approved lead also aborts', async () => {
  const reviewed = [plan('a', ['m1']), plan('b', ['m2'])];
  const approved = approvedFor(reviewed);
  const sink = recorder();
  await assert.rejects(
    () => applyReconciliation({ plans: [plan('a', ['m1'])], approved, appendActivity: sink.append, apply: true }),
    err => err.reason === ABORT_REASON.PLAN_DRIFT);
  assert.equal(sink.written.length, 0);
});

test('an unapproved message inside an approved lead aborts', async () => {
  const reviewed = [plan('a', ['m1'])];
  const approved = approvedFor(reviewed);
  // Same lead, but the plan now carries a message nobody reviewed. Lead ids
  // still match, so only the message-level gate can catch this.
  const sneaky = [plan('a', ['m1'])];
  sneaky[0].proposedEvents.push(event('a', 'm-unreviewed'));
  const sink = recorder();
  await assert.rejects(
    () => applyReconciliation({ plans: sneaky, approved, appendActivity: sink.append, apply: true }),
    err => [ABORT_REASON.PLAN_DRIFT, ABORT_REASON.UNAPPROVED_MESSAGE].includes(err.reason));
  assert.equal(sink.written.length, 0);
});

// ── Idempotency ─────────────────────────────────────────────────────────────

test('running the writer twice adds the events once, then nothing', async () => {
  const plans = [plan('a', ['m1', 'm2']), plan('b', ['m3'])];
  const approved = approvedFor(plans);
  const store = [];
  const append = async record => { store.push(record); };

  const first = await applyReconciliation({
    plans, approved, existingActivities: store, appendActivity: append, apply: true,
  });
  assert.equal(first.written, 3);
  assert.equal(store.length, 3);

  const second = await applyReconciliation({
    plans, approved, existingActivities: store, appendActivity: append, apply: true,
  });
  assert.equal(second.written, 0, 'a replay writes nothing');
  assert.equal(second.skippedExisting, 3);
  assert.equal(store.length, 3, 'and creates no duplicate rows');

  const ids = store.map(row => row.eventId);
  assert.equal(new Set(ids).size, ids.length);
});

test('partially-applied state completes without duplicating what exists', async () => {
  const plans = [plan('a', ['m1', 'm2'])];
  const approved = approvedFor(plans);
  // m1 was already written by an earlier interrupted run.
  const store = [{ eventId: 'gmail-reply:m1', metadata: JSON.stringify({ gmailMessageId: 'm1' }) }];
  const append = async record => { store.push(record); };
  const result = await applyReconciliation({
    plans, approved, existingActivities: store, appendActivity: append, apply: true,
  });
  assert.equal(result.written, 1, 'only the missing event');
  assert.equal(result.skippedExisting, 1);
  assert.equal(store.filter(row => row.eventId === 'gmail-reply:m1').length, 1);
});

test('an existing event is recognised from metadata even under a different event id', async () => {
  const plans = [plan('a', ['m1'])];
  const store = [{ eventId: 'legacy-id-shape', metadata: JSON.stringify({ gmailMessageId: 'm1' }) }];
  const sink = recorder();
  const result = await applyReconciliation({
    plans, approved: approvedFor(plans), existingActivities: store,
    appendActivity: sink.append, apply: true,
  });
  assert.equal(result.written, 0);
  assert.equal(result.skippedExisting, 1);
});

test('the same Gmail message twice in one plan aborts', async () => {
  const plans = [plan('a', ['m1'])];
  plans[0].proposedEvents.push(event('a', 'm1'));   // duplicate
  const sink = recorder();
  await assert.rejects(
    () => applyReconciliation({
      plans, approved: { leadIds: ['a'], messageIds: ['m1'] },
      appendActivity: sink.append, apply: true,
    }),
    err => err.reason === ABORT_REASON.DUPLICATE_MESSAGE_ID);
  assert.equal(sink.written.length, 0);
});

// ── Identity ────────────────────────────────────────────────────────────────

test('a malformed identity aborts the whole run', async () => {
  const plans = [plan('silver', ['m1'], { email: '-687-1887silverspringsspa@gmail.com' })];
  const sink = recorder();
  await assert.rejects(
    () => applyReconciliation({
      plans, approved: approvedFor(plans), appendActivity: sink.append, apply: true,
    }),
    err => err.reason === ABORT_REASON.MALFORMED_IDENTITY);
  assert.equal(sink.written.length, 0, 'no partial write before the abort');
});

test('an event with no provider message id aborts as ambiguous', async () => {
  const plans = [plan('a', ['m1'])];
  plans[0].proposedEvents[0].metadata.gmailMessageId = '';
  const sink = recorder();
  await assert.rejects(
    () => applyReconciliation({
      plans, approved: { leadIds: ['a'], messageIds: ['m1'] },
      appendActivity: sink.append, apply: true,
    }),
    err => err.reason === ABORT_REASON.AMBIGUOUS_IDENTITY);
});

// ── Preserved evidence ──────────────────────────────────────────────────────

test('every written event preserves provider identity, provenance and legacy disagreement', async () => {
  const plans = [plan('a', ['m1'])];
  const sink = recorder();
  await applyReconciliation({
    plans, approved: approvedFor(plans), appendActivity: sink.append, apply: true,
  });
  const record = sink.written[0];
  const meta = JSON.parse(record.metadata);

  assert.equal(record.eventId, 'gmail-reply:m1', 'provider-derived identity');
  for (const [key, value] of Object.entries({
    provider: 'gmail', gmailMessageId: 'm1', gmailThreadId: 't-m1',
    receivedAt: '2026-08-10T10:00:00.000Z', matchedColdEmailId: 'a',
    canonicalState: 'positive', reason: 'explicit_evaluation_intent',
    classifierVersion: 'reply_v2_evidence', confidence: 'high', genuineHuman: true,
    identityMutationAllowed: false,
  })) assert.deepEqual(meta[key], value, `metadata.${key}`);
  assert.deepEqual(meta.evidenceSignals, ['pricing']);

  // The historical marker distinguishes this from live ingestion...
  assert.equal(meta.source, 'historical_reconciliation');
  assert.ok(meta.reconciledAt, 'and records when it was recovered');
  // ...and the legacy interpretation survives alongside the new one.
  assert.equal(meta.legacyTag, 'Not Interested');
  assert.equal(meta.legacyState, 'negative');
  assert.equal(meta.supersedesLegacyTag, true);

  // The event shape matches live ingestion — same fields, same event id scheme.
  assert.deepEqual(Object.keys(record).sort(),
    ['company', 'content', 'email', 'eventId', 'eventType', 'leadId', 'metadata', 'occurredAt', 'sourceLeadId', 'subject'].sort());
});

test('a contact-change event carries the proposed address but forbids mutation', async () => {
  const plans = [plan('orah', ['m9'])];
  Object.assign(plans[0].proposedEvents[0].metadata, {
    canonicalState: 'contact_change_review', subtype: 'mailbox_migration',
    proposedEmail: 'info@orahspa.com',
  });
  const sink = recorder();
  await applyReconciliation({
    plans, approved: approvedFor(plans), appendActivity: sink.append, apply: true,
  });
  const meta = JSON.parse(sink.written[0].metadata);
  assert.equal(meta.proposedEmail, 'info@orahspa.com');
  assert.equal(meta.identityMutationAllowed, false);
  // The written row still carries the ORIGINAL address.
  assert.equal(sink.written[0].email, 'orah@clinic.test');
});

// ── Capability containment ──────────────────────────────────────────────────

test('the writer cannot touch tags, suppression, holds, promotion, mail or calendar', () => {
  const src = readSource(path.join(root, 'integrations', 'reconciliation-writer.js'));
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of [
    'REPLY:', 'notes', 'addSuppression', 'suppress', 'applyHoldToNotes', 'MANUAL HOLD',
    'promotionDecision', 'promote', 'sendEmail', 'sendMail', 'googleapis',
    'spreadsheets', 'values.update', 'batchUpdate', 'calendar', 'campaignVersion',
  ]) {
    assert.ok(!code.includes(forbidden),
      `the writer must have no reachable path to ${forbidden}`);
  }
  // Its ONLY capability is the injected append function.
  assert.match(code, /appendActivity\(/);
});

test('the writer only ever appends reply activities — never updates a lead row', async () => {
  const plans = [plan('a', ['m1'])];
  const calls = [];
  await applyReconciliation({
    plans, approved: approvedFor(plans), apply: true,
    appendActivity: async record => { calls.push(record); },
  });
  assert.equal(calls.length, 1);
  const record = calls[0];
  // Nothing in the written record can express a lead mutation.
  for (const field of ['notes', 'stage', 'emailStatus', 'suppressed', 'hold']) {
    assert.equal(record[field], undefined, `a written activity must not carry ${field}`);
  }
  assert.match(record.eventType, /_reply$/, 'only reply activities are written');
});

test('planning inputs are never mutated by a write', async () => {
  const plans = [plan('a', ['m1'])];
  const before = JSON.stringify(plans);
  await applyReconciliation({
    plans, approved: approvedFor(plans), apply: true, appendActivity: async () => {},
  });
  assert.equal(JSON.stringify(plans), before);
});

test('non-proposed plans are ignored entirely', async () => {
  const plans = [
    plan('a', ['m1']),
    { status: RECONCILE_STATUS.NO_GMAIL_EVIDENCE, leadId: 'ghost', email: 'g@x.test', proposedEvents: [] },
    { status: RECONCILE_STATUS.IDENTITY_UNUSABLE, leadId: 'silver', email: 'bad', proposedEvents: [] },
  ];
  const sink = recorder();
  const result = await applyReconciliation({
    plans, approved: approvedFor(plans), appendActivity: sink.append, apply: true,
  });
  assert.equal(result.written, 1);
  assert.equal(sink.written[0].sourceLeadId, 'a');
});

test('a fully-applied plan reports completion, not drift', async () => {
  // After a successful apply the planner reports leads as already_reconciled,
  // so the regenerated manifest is legitimately empty. That must read as
  // "finished", not as "someone changed the approved set" — the two need
  // different answers, and only one of them is a reason to stop and re-review.
  const plans = [plan('a', ['m1', 'm2'])];
  const approved = approvedFor(plans);
  const store = [];
  const append = async record => { store.push(record); };

  await applyReconciliation({ plans, approved, existingActivities: store, appendActivity: append, apply: true });
  assert.equal(store.length, 2);

  // Replay with the planner's post-apply view: nothing proposed any more.
  const settled = [{ status: RECONCILE_STATUS.ALREADY_RECONCILED, leadId: 'a', email: 'a@clinic.test', proposedEvents: [] }];
  const replay = await applyReconciliation({
    plans: settled, approved, existingActivities: store, appendActivity: append, apply: true,
  });
  assert.equal(replay.alreadyComplete, true);
  assert.equal(replay.written, 0);
  assert.equal(replay.skippedExisting, 2);
  assert.equal(store.length, 2, 'and still nothing duplicated');

  // A genuinely DRIFTED plan still aborts — completion must not mask it.
  const drifted = [plan('b', ['m9'])];
  await assert.rejects(
    () => applyReconciliation({ plans: drifted, approved, existingActivities: store, appendActivity: append, apply: true }),
    err => err.reason === ABORT_REASON.PLAN_DRIFT);
});
