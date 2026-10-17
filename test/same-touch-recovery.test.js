'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  recoveryActionId, provenFailedTouches, unrecoveredTouchBlock, planSameTouchRecovery,
  ENABLED_VAR, SENDERS_VAR,
} = require('../integrations/same-touch-recovery');
const { isFollowUpDue, nextFollowUp } = require('../integrations/sequence-timing');
const { ordinaryColdActionId } = require('../integrations/outbound-action-id');
const { sendSuppressionReason, releaseHoldFromNotes } = require('../integrations/pipeline-state');
const { createMemorySendReservationStore } = require('../integrations/send-reservation-memory');
const { observeMailbox } = require('../integrations/gmail-mailbox-observer');
const { planMailboxEvents } = require('../integrations/mailbox-observation-events');

const NOW = new Date('2026-10-20T16:00:00Z');
const T1_AT = '2026-09-30T14:51:39.311Z';
const ORIGINAL = '1a0f2ccbd11d6619';
const DSN = '1a10596566069d71';
const HOLD = '[MANUAL HOLD] [SENDER-AUTH: FAILED DELIVERY; SAME-TOUCH RECOVERY REQUIRED: T1]';

// The 19 .com leads as production holds them: provider accepted Touch 1, the
// row says step 1 / emailed, a final 4.7.26 failure is reconciled to Touch 1.
function heldLead(over = {}) {
  return { id: 'L1', email: 'pat@acme-staffing.com', company: 'Acme Staffing', stage: 'Review',
    emailStatus: 'emailed', emailStep: '1', lastEmailedAt: T1_AT, senderInboxId: 'scalelabaiteam',
    notes: HOLD, ...over };
}
const row = (eventType, metadata, over = {}) => ({ eventId: `${eventType}:${Math.random()}`, leadId: 'CE-L1',
  sourceLeadId: 'L1', email: 'pat@acme-staffing.com', eventType, occurredAt: over.occurredAt || T1_AT,
  subject: '', content: '', metadata: JSON.stringify(metadata), ...over });
const touch1Sent = () => row('initial_email_sent', { step: 1, gmailMessageId: ORIGINAL, gmailThreadId: ORIGINAL, senderInboxId: 'scalelabaiteam' }, { eventId: `gmail:${ORIGINAL}` });
const observerFailure = (final = true) => row('sender_auth_delivery_failure', { gmailMessageId: DSN, senderInboxId: 'scalelabaiteam',
  deliveryClass: 'sender_auth_failure', dsnAction: final ? 'failed' : 'delayed', dsnStatus: '4.7.26', finalFailure: final },
  { eventId: `gmail-sender-auth:scalelabaiteam:${DSN}:L1`, occurredAt: '2026-10-03T16:42:01Z' });
const reconciledFailure = (step = 1, original = ORIGINAL) => row('sender_auth_failed_touch_reconciled', { step, gmailMessageId: DSN,
  senderInboxId: 'scalelabaiteam', originalGmailMessageId: original, originalGmailThreadId: original, originalSendAt: T1_AT,
  deliveryClass: 'sender_auth_failure', dsnAction: 'failed', dsnStatus: '4.7.26', finalFailure: true, deliverySucceeded: false },
  { eventId: `sender-auth-failed-touch:${DSN}:L1` });
const incidentLedger = () => [touch1Sent(), observerFailure(), reconciledFailure()];
const ACTION = recoveryActionId('L1', 1, ORIGINAL);
const authorization = (over = {}) => row('same_touch_recovery_authorized', { step: 1, originalGmailMessageId: ORIGINAL, actionId: ACTION,
  authorizedBy: 'Deins', authorizedAt: '2026-10-19T16:00:00Z', recoverySenderId: 'healthy', ...over });
const HEALTHY = { senders: [{ id: 'healthy', status: 'active', sendEligible: true }, { id: 'scalelabaiteam', status: 'paused', sendEligible: false }],
  observers: [{ senderInboxId: 'healthy', health: 'healthy' }] };
const ENV = { [SENDERS_VAR]: 'healthy' };
const plan = (over = {}) => planSameTouchRecovery({ lead: heldLead(), activities: [...incidentLedger(), authorization()],
  suppressedEmails: new Set(), ...HEALTHY, env: ENV, now: NOW, sendSuppressionReason, releaseHoldFromNotes, ...over });
const codes = result => result.refusals.map(r => r.code);

// ── The cadence guard ────────────────────────────────────────────────────────

test('a proven failed Touch 1 makes Touch 2 never due, even after the hold and Review stage are removed', () => {
  // Exactly what a human could do from the drawer today: drop the hold, put the
  // stage back. Without the guard Touch 2 is overdue and would be selected.
  const unheld = heldLead({ notes: '', stage: 'Contacted' });
  assert.equal(isFollowUpDue(unheld, NOW, { activities: [touch1Sent()] }), true, 'baseline: an ordinary lead is due');
  assert.equal(isFollowUpDue(unheld, NOW, { activities: incidentLedger() }), false);
  assert.equal(nextFollowUp(unheld, { activities: incidentLedger() }).blockedBy.code, 'failed_touch_unrecovered');
});

test('an observer-recorded final failure not yet reconciled to a touch blocks Touch 2 and Touch 3', () => {
  const ledger = [touch1Sent(), observerFailure(true)];
  assert.equal(unrecoveredTouchBlock(heldLead(), ledger, 2).code, 'unreconciled_delivery_failure');
  assert.equal(unrecoveredTouchBlock(heldLead(), ledger, 3).code, 'unreconciled_delivery_failure');
  assert.equal(isFollowUpDue(heldLead({ notes: '', stage: 'Contacted' }), NOW, { activities: ledger }), false);
});

test('a Delay notice or a presumed-delivered touch is NOT a failure and keeps the normal cadence', () => {
  const delayed = [touch1Sent(), observerFailure(false),
    row('sender_auth_incident_reconciled', { classification: 'PRESUMED_DELIVERED_AFTER_DELAY', touch: 1 })];
  assert.deepEqual(provenFailedTouches(delayed, 'L1'), []);
  assert.equal(unrecoveredTouchBlock(heldLead(), delayed, 2), null);
  assert.equal(isFollowUpDue(heldLead({ notes: '', stage: 'Contacted' }), NOW, { activities: delayed }), true);
});

test('a failed Touch 2 blocks Touch 3 but a Touch 1 failure never blocks Touch 1 itself', () => {
  const ledger = [touch1Sent(), reconciledFailure(2, 'T2MSG')];
  assert.equal(unrecoveredTouchBlock(heldLead(), ledger, 3).failedStep, 2);
  assert.equal(unrecoveredTouchBlock(heldLead(), incidentLedger(), 1), null);
});

test('a recorded recovery of the failed touch releases the guard for that failure only', () => {
  const recovered = [...incidentLedger(), row('same_touch_recovery_sent', { step: 1, originalGmailMessageId: ORIGINAL, actionId: ACTION })];
  assert.equal(unrecoveredTouchBlock(heldLead(), recovered, 2), null);
  const otherFailure = [...recovered, reconciledFailure(1, 'OTHER')];
  assert.equal(unrecoveredTouchBlock(heldLead(), otherFailure, 2).code, 'failed_touch_unrecovered');
});

test('the send path refuses a blocked follow-up before any reservation is written', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'outreach-agent.js'), 'utf8');
  const body = src.slice(src.indexOf('async function deliverOrdinaryColdStep('));
  const guard = body.indexOf('unrecoveredTouchBlock(lead, activitiesForCycle');
  assert.ok(guard > 0, 'deliverOrdinaryColdStep must call the failed-touch guard');
  assert.ok(guard < body.indexOf('recordColdCallActivityStrict(reservation)'));
  assert.ok(guard < body.indexOf('sendEmail({'));
});

// ── The recovery plan ────────────────────────────────────────────────────────

test('a fully qualified failed Touch 1 is ready, but execution stays disabled by default', () => {
  const result = plan();
  assert.deepEqual(result.refusals, []);
  assert.equal(result.ready, true);
  assert.equal(result.executionEnabled, false);
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'recovery_execution_disabled');
  assert.equal(result.actionId, `gmail-touch-recovery:L1:step:1:${ORIGINAL}`);
  assert.equal(plan({ env: { ...ENV, [ENABLED_VAR]: 'true' } }).allowed, true);
});

test('the recovery action id is deterministic, one per failed send, and never the ordinary step-1 id', () => {
  assert.equal(recoveryActionId('L1', 1, ORIGINAL), recoveryActionId('L1', 1, ORIGINAL));
  assert.notEqual(recoveryActionId('L1', 1, ORIGINAL), recoveryActionId('L1', 1, 'OTHER'));
  assert.notEqual(recoveryActionId('L1', 1, ORIGINAL), ordinaryColdActionId('L1', 1));
});

test('delivered or presumed-delivered leads can never be planned as failed', () => {
  const presumed = [touch1Sent(), observerFailure(false),
    row('sender_auth_incident_reconciled', { classification: 'PRESUMED_DELIVERED_AFTER_DELAY', touch: 1 }), authorization()];
  const result = plan({ activities: presumed });
  assert.equal(result.ready, false);
  assert.ok(codes(result).includes('no_proven_failure'));
  assert.ok(codes(result).includes('delivery_presumed'));
  const ambiguous = [...incidentLedger(), authorization(), row('sender_auth_incident_reconciled', { classification: 'E_ambiguous' })];
  assert.ok(codes(plan({ activities: ambiguous })).includes('delivery_presumed'));
});

for (const [name, eventType] of [['positive reply', 'positive_reply'], ['OOO', 'out_of_office_reply'],
  ['needs-human reply', 'needs_human_reply'], ['unsubscribe reply', 'unsubscribe_reply']]) {
  test(`a ${name} suppresses recovery`, () => {
    const result = plan({ activities: [...incidentLedger(), authorization(), row(eventType, { gmailMessageId: 'R1' })] });
    assert.equal(result.ready, false);
    assert.ok(codes(result).includes('reply_exists'));
  });
}

test('unsubscribe, DNC and suppression always win', () => {
  assert.ok(codes(plan({ lead: heldLead({ notes: `${HOLD} [REPLY: Unsubscribed]` }) })).includes('suppressed'));
  assert.ok(codes(plan({ suppressedEmails: new Set(['pat@acme-staffing.com']) })).includes('suppressed'));
  assert.ok(codes(plan({ lead: heldLead({ notes: `${HOLD} [BOUNCED]` }) })).includes('suppressed'));
  assert.equal(plan({ lead: heldLead({ emailStatus: 'replied' }) }).ready, false);
});

test('same-Touch-1 recovery is not Resume: it needs the hold, the Review stage and a named authorization', () => {
  assert.ok(codes(plan({ lead: heldLead({ notes: '' }) })).includes('not_held'));
  assert.ok(codes(plan({ lead: heldLead({ stage: 'Contacted' }) })).includes('state_changed'));
  assert.ok(codes(plan({ activities: incidentLedger() })).includes('authorization_required'));
  const expired = [...incidentLedger(), authorization({ authorizedAt: '2026-09-01T00:00:00Z' })];
  assert.ok(codes(plan({ activities: expired })).includes('authorization_required'));
  const otherFailure = [...incidentLedger(), authorization({ originalGmailMessageId: 'OTHER', actionId: recoveryActionId('L1', 1, 'OTHER') })];
  assert.ok(codes(plan({ activities: otherFailure })).includes('authorization_required'));
  const anonymous = [...incidentLedger(), authorization({ authorizedBy: '' })];
  assert.ok(codes(plan({ activities: anonymous })).includes('authorization_required'));
});

test('the recovery sender must be allow-listed, active, send-eligible and observed healthy', () => {
  assert.ok(codes(plan({ env: {} })).includes('sender_not_allowlisted'));
  assert.ok(codes(plan({ senders: [{ id: 'healthy', status: 'paused', sendEligible: false }] })).includes('sender_unhealthy'));
  assert.ok(codes(plan({ observers: [{ senderInboxId: 'healthy', health: 'backoff' }] })).includes('observer_unhealthy'));
  // The failed sender itself is paused: naming it is refused even if allow-listed.
  const failedSender = [...incidentLedger(), authorization({ recoverySenderId: 'scalelabaiteam' })];
  const result = plan({ activities: failedSender, env: { [SENDERS_VAR]: 'scalelabaiteam' },
    observers: [{ senderInboxId: 'scalelabaiteam', health: 'healthy' }] });
  assert.ok(codes(result).includes('sender_unhealthy'));
});

test('a later touch, a duplicate Touch 1 or a changed row refuses the plan', () => {
  const t2 = row('follow_up_sent', { step: 2, gmailMessageId: 'T2', senderInboxId: 'scalelabaiteam' });
  assert.ok(codes(plan({ activities: [...incidentLedger(), authorization(), t2] })).includes('later_touch_sent'));
  const dup = row('initial_email_sent', { step: 1, gmailMessageId: 'DUP', senderInboxId: 'primary' });
  assert.ok(codes(plan({ activities: [...incidentLedger(), authorization(), dup] })).includes('duplicate_touch1'));
  assert.ok(codes(plan({ lead: heldLead({ emailStep: '2' }) })).includes('state_changed'));
  const failedT2 = [...incidentLedger(), authorization(), reconciledFailure(2, 'T2')];
  assert.ok(codes(plan({ activities: failedT2 })).includes('later_touch_failed'));
});

test('duplicate recovery is blocked by the ledger and by the durable reservation', () => {
  const sent = [...incidentLedger(), authorization(), row('same_touch_recovery_sent', { step: 1, originalGmailMessageId: ORIGINAL, actionId: ACTION })];
  assert.ok(codes(plan({ activities: sent })).includes('already_recovered'));
  const reserved = [...incidentLedger(), authorization(), row('same_touch_recovery_reserved', { actionId: ACTION })];
  assert.ok(codes(plan({ activities: reserved })).includes('recovery_reserved'));
  assert.ok(codes(plan({ reservation: { actionId: ACTION, status: 'confirmed' } })).includes('reservation_exists'));
});

test('crash/retry: the existing reservation store sends a recovery action at most once', async () => {
  let clock = new Date('2026-10-20T16:00:00Z');
  const store = createMemorySendReservationStore({ now: () => clock, leaseSeconds: 60 });
  const action = { actionId: ACTION, leadId: 'L1', actionType: 'gmail_touch_recovery', provider: 'gmail' };
  // The ordinary step-1 action is already confirmed for these leads; the
  // recovery id does not collide with it.
  const ordinary = { actionId: ordinaryColdActionId('L1', 1), leadId: 'L1', actionType: 'gmail_cold_step', provider: 'gmail' };
  await store.reserveOutboundAction(ordinary, { leaseOwner: 'old' });
  await store.markProviderAttemptStarted(ordinary.actionId, 'old');
  await store.markProviderSucceeded(ordinary.actionId, 'old', { providerMessageId: ORIGINAL });
  await store.markConfirmed(ordinary.actionId, 'old');
  assert.equal((await store.reserveOutboundAction(ordinary, { leaseOwner: 'x' })).code, 'reservation_confirmed');

  const first = await store.reserveOutboundAction(action, { leaseOwner: 'w1' });
  assert.equal(first.ok, true);
  assert.equal((await store.markProviderAttemptStarted(ACTION, 'w1')).ok, true);
  // Worker crashes mid-send. A retry, a second worker, and the post-expiry
  // takeover are all refused: an attempt that may have reached Gmail is never resent.
  assert.equal((await store.reserveOutboundAction(action, { leaseOwner: 'w2' })).ok, false);
  clock = new Date(clock.getTime() + 10 * 60000);
  const afterExpiry = await store.reserveOutboundAction(action, { leaseOwner: 'w3' });
  assert.equal(afterExpiry.ok, false);
  assert.equal(afterExpiry.code, 'reservation_reconciliation_required');
  // And the plan refuses as soon as the row exists.
  assert.ok(codes(plan({ reservation: await store.getReservation(ACTION) })).includes('reservation_exists'));
});

// ── Observer: a vanished message can never take a reply's state with it ────

test('production code has no Gmail call that can trash, delete or relabel mail', () => {
  const root = path.join(__dirname, '..');
  const files = ['outreach-agent.js', 'server.js',
    ...fs.readdirSync(path.join(root, 'integrations')).filter(f => f.endsWith('.js')).map(f => `integrations/${f}`)];
  // Gmail's namespace only (Anthropic's client also has messages.create).
  const mutation = /users\.(messages|threads|drafts|labels)\.(trash|untrash|delete|batchDelete|batchModify|modify|insert|import|create|update|patch|send)\s*\(/;
  const offenders = [];
  for (const file of files) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    for (const line of src.split('\n')) {
      // messages.send is the one sanctioned outbound call (sendEmail).
      if (mutation.test(line) && !/users\.messages\.send\s*\(/.test(line)) offenders.push(`${file}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('deleted draft revisions in a thread are recorded as gaps while the prospect reply in that thread is still classified', async () => {
  // The 2026-10-06 primary case: 23 DRAFT revisions vanished before the
  // observer fetched them. Here the same thread also holds a real reply.
  const lead = { id: 'L9', email: 'prospect@example.com', company: 'Clinic', emailStatus: 'emailed', emailStep: '1',
    senderInboxId: 'primary', lastEmailedAt: '2026-10-01T00:00:00Z', notes: '' };
  const reply = { id: 'reply1', threadId: 'T', internalDate: String(Date.parse('2026-10-06T04:00:00Z')), labelIds: ['INBOX'],
    payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: lead.email }, { name: 'To', value: 'sender@example.com' },
      { name: 'Message-ID', value: '<reply1@test>' }], body: { data: Buffer.from('Yes, I am interested').toString('base64url') } } };
  const drafts = Array.from({ length: 23 }, (_, i) => ({ id: `d${String(i).padStart(2, '0')}`, threadId: 'T' }));
  const gone = () => Object.assign(new Error('Requested entity was not found.'), { response: { status: 404 } });
  const gmail = { users: {
    history: { list: async () => ({ data: { historyId: '201', history: [...drafts, { id: 'reply1', threadId: 'T' }].map(m => ({ messagesAdded: [{ message: m }] })) } }) },
    messages: { get: async p => { if (p.id === 'reply1') return { data: reply }; throw gone(); } },
    threads: { get: async () => ({ data: { messages: [reply] } }) },
  } };
  const input = { gmail, leads: [lead], activities: [], senderInboxId: 'primary', senderEmail: 'sender@example.com',
    historyId: '100', lastSuccessfulObservationAt: '2026-10-06T03:50:00Z', now: new Date('2026-10-06T04:15:00Z') };
  const observation = await observeMailbox(input);
  assert.equal(observation.unavailable.length, 23);
  const plan = await planMailboxEvents({ ...input, observation });
  const gaps = plan.events.filter(e => e.eventType === 'gmail_observation_gap');
  assert.equal(gaps.length, 23);
  for (const gap of gaps) {
    const m = JSON.parse(gap.metadata);
    assert.equal(m.autoSendAllowed, false);
    assert.equal(m.requiresHumanAttention, true);
  }
  assert.equal(plan.events.filter(e => e.eventType === 'positive_reply' && e.sourceLeadId === 'L9').length, 1);
});
