'use strict';
// Same-touch recovery for a cold touch whose delivery provably FAILED.
//
// The 2026-10-03 .com incident left 19 leads whose Touch 1 Gmail accepted and
// Microsoft then finally rejected (4.7.26, sender authentication). Their rows
// still say emailStep=1 / emailed, because Gmail did accept the attempt. Two
// layers keep them still today: [MANUAL HOLD] and the Review stage. Both are
// operator-editable text. Remove the hold and put the stage back to Contacted
// and the ordinary cadence would send Touch 2 — a "following up" email in a
// thread whose first message never arrived.
//
// This module is the ledger-derived third layer, plus the recovery plan:
//
//   unrecoveredTouchBlock   a proven failed touch blocks every LATER cold touch
//                           until a recovery of that touch is recorded. Read by
//                           sequence-timing, so every cadence consumer agrees.
//   planSameTouchRecovery   would one replacement Touch 1 be safe right now?
//                           Pure; never sends, writes or reserves.
//   recoveryActionId        the durable send-lock id for that replacement. One
//                           per failed send, distinct from the ordinary step-1
//                           id (which is already confirmed for these leads), so
//                           the existing reservation store refuses a second
//                           recovery after a crash, a retry or a race.
//
// Execution is not wired. There is no executor in this module and no caller
// that sends. SAME_TOUCH_RECOVERY_ENABLED (default off) is reported by the plan
// so a future executor has one switch to read; flipping it alone sends nothing.

const FAILED_TOUCH_EVENT = 'sender_auth_failed_touch_reconciled';
const SENDER_AUTH_FAILURE_EVENT = 'sender_auth_delivery_failure';
const RECOVERY_AUTHORIZED_EVENT = 'same_touch_recovery_authorized';
const RECOVERY_RESERVED_EVENT = 'same_touch_recovery_reserved';
const RECOVERY_SENT_EVENT = 'same_touch_recovery_sent';
const PRESUMED_DELIVERED_EVENT = 'sender_auth_incident_reconciled';
// Incident classifications that mean the touch may have reached the prospect.
// E_ambiguous is included on purpose: unproven non-delivery is not a failure.
const MAY_HAVE_ARRIVED = new Set(['PRESUMED_DELIVERED_AFTER_DELAY', 'DELIVERED', 'D_delivered', 'E_ambiguous']);
const ENABLED_VAR = 'SAME_TOUCH_RECOVERY_ENABLED';
const SENDERS_VAR = 'SAME_TOUCH_RECOVERY_SENDERS';
// Same-Touch-1 only. A failed Touch 2/3 is blocked (by the guard) but never
// planned for recovery here: it needs its own reviewed policy.
const RECOVERABLE_STEP = 1;
const AUTHORIZATION_MAX_AGE_DAYS = 14;

// Anything a prospect sent us, or a decision about something they sent.
const INBOUND_EVENTS = new Set([
  'positive_reply', 'negative_reply', 'needs_human_reply', 'wrong_person_reply',
  'out_of_office_reply', 'unsubscribe_reply', 'meeting_requested', 'call_booked',
  'gmail_reply_evaluated', 'reply_decision_recorded', 'ooo_resume_scheduled',
  'reply_classification_override', 'false_opt_out_corrected',
]);
const COLD_SENDS = new Set(['initial_email_sent', 'follow_up_sent', 'sequence_step_sent']);
const RECIPIENT_REJECTED_EVENT = 'email_bounced';
const BOUNCE_RETRACTED_EVENT = 'email_bounce_retracted';

const meta = row => {
  if (row && row.metadata && typeof row.metadata === 'object') return row.metadata;
  try { return JSON.parse(row?.metadata || '{}'); } catch (_) { return {}; }
};
const norm = value => String(value || '').trim().toLowerCase();
const leadIdOf = lead => String(lead?.id || '').trim();

function rowsForLead(activities = [], leadId) {
  const id = String(leadId || '').trim();
  if (!id) return [];
  return activities.filter(row => String(row.sourceLeadId || '') === id
    || String(row.leadId || '') === `CE-${id}` || String(row.leadId || '') === id);
}

function recoveryActionId(leadId, step, originalGmailMessageId) {
  return `gmail-touch-recovery:${String(leadId)}:step:${Number(step)}:${String(originalGmailMessageId)}`;
}

function failureKey(step, originalGmailMessageId) {
  return `${Number(step)}:${String(originalGmailMessageId || '')}`;
}

/**
 * Every proven final delivery failure of a cold touch for this lead.
 *
 * A reconciled failure names its step and original message. A final
 * sender-auth failure the observer recorded but nobody has reconciled yet
 * names neither, so it is returned with step=null: it is a failure of SOME
 * touch, and the guard treats it as blocking everything after Touch 1.
 * Delay notices (finalFailure=false) are not failures and are ignored.
 */
function provenFailedTouches(activities = [], leadId) {
  const rows = rowsForLead(activities, leadId);
  const reconciled = rows.filter(row => row.eventType === FAILED_TOUCH_EVENT)
    .map(row => ({ row, m: meta(row) }))
    .filter(({ m }) => m.finalFailure === true && m.deliverySucceeded !== true
      && Number.isInteger(Number(m.step)) && Number(m.step) >= 1 && m.originalGmailMessageId);
  const reconciledDsnIds = new Set(reconciled.map(({ m }) => String(m.gmailMessageId || '')).filter(Boolean));
  const out = reconciled.map(({ row, m }) => ({
    step: Number(m.step), originalGmailMessageId: String(m.originalGmailMessageId),
    originalGmailThreadId: String(m.originalGmailThreadId || ''), originalSendAt: m.originalSendAt || '',
    senderInboxId: String(m.senderInboxId || ''), dsnMessageId: String(m.gmailMessageId || ''),
    dsnStatus: m.dsnStatus || '', deliveryClass: m.deliveryClass || '', eventId: row.eventId, reconciled: true,
  }));
  for (const row of rows) {
    if (row.eventType !== SENDER_AUTH_FAILURE_EVENT) continue;
    const m = meta(row);
    if (m.finalFailure !== true) continue;
    if (reconciledDsnIds.has(String(m.gmailMessageId || ''))) continue;
    out.push({ step: null, originalGmailMessageId: '', originalGmailThreadId: '', originalSendAt: '',
      senderInboxId: String(m.senderInboxId || ''), dsnMessageId: String(m.gmailMessageId || ''),
      dsnStatus: m.dsnStatus || '', deliveryClass: m.deliveryClass || '', eventId: row.eventId, reconciled: false });
  }
  return out;
}

/** Recovery sends recorded for this lead, keyed by step:originalGmailMessageId. */
function recordedRecoveries(activities = [], leadId) {
  const keys = new Map();
  for (const row of rowsForLead(activities, leadId)) {
    if (row.eventType !== RECOVERY_SENT_EVENT) continue;
    const m = meta(row);
    keys.set(failureKey(m.step, m.originalGmailMessageId), row);
  }
  return keys;
}

/**
 * Why the cold touch `nextStep` may not be sent, or null.
 *
 * Blocks when an earlier touch (or an unidentified touch) provably failed and
 * no recovery of it is recorded. It can only ever REMOVE a lead from a send.
 */
function unrecoveredTouchBlock(lead = {}, activities = [], nextStep) {
  const step = Number(nextStep);
  if (!Number.isInteger(step) || step < 2) return null;
  const leadId = leadIdOf(lead);
  if (!leadId || !Array.isArray(activities) || !activities.length) return null;
  const recovered = recordedRecoveries(activities, leadId);
  for (const failure of provenFailedTouches(activities, leadId)) {
    if (failure.step !== null && failure.step >= step) continue;
    if (failure.step !== null && recovered.has(failureKey(failure.step, failure.originalGmailMessageId))) continue;
    return {
      code: failure.step === null ? 'unreconciled_delivery_failure' : 'failed_touch_unrecovered',
      failedStep: failure.step, dsnMessageId: failure.dsnMessageId, eventId: failure.eventId,
      reason: failure.step === null
        ? 'a final sender-auth delivery failure for this lead is not yet reconciled to a touch; later touches stay blocked'
        : `Touch ${failure.step} provably failed (${failure.dsnStatus || 'final failure'}) and has not been recovered; Touch ${step} would follow an email the prospect never received`,
    };
  }
  return null;
}

function recoverySenders(env = process.env) {
  return new Set(String(env[SENDERS_VAR] || '').split(',').map(s => s.trim()).filter(Boolean));
}

/**
 * Would ONE replacement Touch 1 be safe for this lead right now?
 *
 * Pure. Never sends, writes, reserves or releases a hold. Every refusal is
 * listed (not just the first) so an audit shows the whole picture; `ready` is
 * true only when none apply, and `allowed` additionally needs the execution
 * switch. The hold stays: a recovery executor must take its authority from a
 * named, unexpired same_touch_recovery_authorized event, never from Resume.
 *
 * @param lead            canonical ColdEmail row, as it is now
 * @param activities      the canonical ledger
 * @param suppressedEmails global Suppression list (Set of lowercased emails)
 * @param senders         live sender roster ({ id, status, sendEligible })
 * @param observers       live observer health ({ senderInboxId, health })
 * @param reservation     the durable send-lock row for the recovery action id, or null
 * @param sendSuppressionReason, releaseHoldFromNotes  pipeline-state functions (injected, keeps this pure)
 */
function planSameTouchRecovery({
  lead, activities = [], suppressedEmails = new Set(), senders = [], observers = [], reservation = null,
  env = process.env, now = new Date(), sendSuppressionReason, releaseHoldFromNotes,
} = {}) {
  const refusals = [];
  const refuse = (code, reason) => refusals.push({ code, reason });
  const leadId = leadIdOf(lead);
  const rows = rowsForLead(activities, leadId);
  if (!leadId || !lead?.email) refuse('invalid_identity', 'lead identity is missing');

  const failures = leadId ? provenFailedTouches(activities, leadId) : [];
  const recovered = leadId ? recordedRecoveries(activities, leadId) : new Map();
  const touch1 = failures.filter(f => f.step === RECOVERABLE_STEP);
  if (failures.some(f => f.step === null)) refuse('unreconciled_delivery_failure', 'a final delivery failure is not reconciled to a touch');
  if (failures.some(f => f.step !== null && f.step !== RECOVERABLE_STEP)) refuse('later_touch_failed', 'only a failed Touch 1 is recoverable here');
  if (!touch1.length) refuse('no_proven_failure', 'no proven final failure of Touch 1 is recorded');
  if (touch1.length > 1) refuse('multiple_failed_touch1', 'more than one failed Touch 1 is recorded; review manually');
  const failure = touch1.length === 1 ? touch1[0] : null;
  const actionId = failure ? recoveryActionId(leadId, RECOVERABLE_STEP, failure.originalGmailMessageId) : null;

  // Already recovered, or a recovery in flight / uncertain.
  if (failure && recovered.has(failureKey(RECOVERABLE_STEP, failure.originalGmailMessageId))) {
    refuse('already_recovered', 'a replacement Touch 1 is already recorded');
  }
  if (rows.some(row => row.eventType === RECOVERY_RESERVED_EVENT && meta(row).actionId === actionId)) {
    refuse('recovery_reserved', 'a recovery reservation already exists; reconcile it, never resend');
  }
  if (reservation) refuse('reservation_exists', `the recovery send-lock row exists (${reservation.status}); it is never reopened`);

  // The original attempt must be the only Touch 1, and nothing may have followed it.
  const sends = rows.filter(row => COLD_SENDS.has(row.eventType));
  const step1Sends = sends.filter(row => Number(meta(row).step || 1) === 1 && row.eventType === 'initial_email_sent');
  if (failure && !step1Sends.some(row => String(meta(row).gmailMessageId) === failure.originalGmailMessageId)) {
    refuse('original_send_missing', 'the failed Touch 1 send is not in the ledger');
  }
  if (step1Sends.length > 1) refuse('duplicate_touch1', 'more than one Touch 1 send is recorded');
  if (sends.some(row => Number(meta(row).step) > 1 || row.eventType !== 'initial_email_sent')) {
    refuse('later_touch_sent', 'a later touch was already sent; the sequence cannot be rewound');
  }
  if (lead && (String(lead.emailStep) !== '1' || norm(lead.emailStatus) !== 'emailed')) {
    refuse('state_changed', `lead is at step ${lead.emailStep || '?'} / ${lead.emailStatus || '?'}, not the failed Touch 1`);
  }
  if (lead && norm(lead.stage) !== 'review') refuse('state_changed', `lead stage is ${lead.stage || '?'}, not the incident Review stage`);

  // Any sign the prospect DID receive something: reply, OOO, unsubscribe,
  // booking, a delivery presumption, or a later recipient-side bounce.
  if (rows.some(row => INBOUND_EVENTS.has(row.eventType))) refuse('reply_exists', 'the prospect has replied or a reply decision exists');
  if (lead && ['replied', 'done'].includes(norm(lead.emailStatus))) refuse('reply_exists', `emailStatus is ${lead.emailStatus}`);
  if (rows.some(row => row.eventType === PRESUMED_DELIVERED_EVENT && MAY_HAVE_ARRIVED.has(String(meta(row).classification || '')))) {
    refuse('delivery_presumed', 'a delivery presumption is recorded for this lead; never resend a touch that may have arrived');
  }
  const retracted = new Set(rows.filter(row => row.eventType === BOUNCE_RETRACTED_EVENT).map(row => meta(row).retractsEventId));
  if (rows.some(row => row.eventType === RECIPIENT_REJECTED_EVENT && !retracted.has(row.eventId))) {
    refuse('recipient_bounced', 'a recipient bounce is recorded');
  }

  // Suppression / DNC / unsubscribe / archive / bounce always win. The hold is
  // expected (it is what parks these leads) and is evaluated separately.
  if (lead && typeof sendSuppressionReason === 'function') {
    const held = String(lead.notes || '').includes('[MANUAL HOLD]');
    if (!held) refuse('not_held', 'recovery is only for held incident leads; the hold is missing');
    const withoutHold = typeof releaseHoldFromNotes === 'function' ? releaseHoldFromNotes(lead.notes || '') : String(lead.notes || '');
    const suppressed = sendSuppressionReason({ ...lead, notes: withoutHold }, { suppressedEmails });
    if (suppressed) refuse('suppressed', `suppressed: ${suppressed}`);
  } else if (lead) {
    refuse('suppression_unchecked', 'suppression could not be evaluated');
  }

  // Explicit, named, unexpired authorization for exactly this failure.
  const authorizations = rows.filter(row => row.eventType === RECOVERY_AUTHORIZED_EVENT).map(row => ({ row, m: meta(row) }))
    .filter(({ m }) => failure && Number(m.step) === RECOVERABLE_STEP
      && String(m.originalGmailMessageId) === failure.originalGmailMessageId && m.actionId === actionId
      && String(m.authorizedBy || '').trim() && String(m.recoverySenderId || '').trim());
  const nowMs = new Date(now).getTime();
  const live = authorizations.filter(({ m }) => {
    const at = Date.parse(m.authorizedAt || '');
    return Number.isFinite(at) && at <= nowMs && nowMs - at <= AUTHORIZATION_MAX_AGE_DAYS * 86400000;
  }).sort((a, b) => Date.parse(b.m.authorizedAt) - Date.parse(a.m.authorizedAt));
  const authorization = live[0]?.m || null;
  if (!authorization) refuse('authorization_required', 'no named, unexpired same_touch_recovery_authorized event for this failure');

  // The recovery sender must be explicitly allow-listed AND healthy right now.
  const senderId = authorization?.recoverySenderId || '';
  if (senderId) {
    const sender = senders.find(s => s.id === senderId);
    if (!recoverySenders(env).has(senderId)) refuse('sender_not_allowlisted', `${senderId} is not in ${SENDERS_VAR}`);
    if (!sender) refuse('sender_unknown', `${senderId} is not a registered sender`);
    else if (norm(sender.status) !== 'active' || sender.sendEligible !== true) refuse('sender_unhealthy', `${senderId} is not active and send-eligible`);
    const observer = observers.find(o => o.senderInboxId === senderId || o.id === senderId);
    if (norm(observer?.health || observer?.observerHealth) !== 'healthy') refuse('observer_unhealthy', `${senderId} mailbox observer is not healthy`);
  }

  const executionEnabled = String(env[ENABLED_VAR] || '') === 'true';
  const ready = refusals.length === 0;
  return {
    leadId, step: RECOVERABLE_STEP, actionId, failure, recoverySenderId: senderId || null,
    ready, executionEnabled, allowed: ready && executionEnabled,
    code: !ready ? refusals[0].code : (executionEnabled ? 'recovery_allowed' : 'recovery_execution_disabled'),
    refusals,
    // Contract for a future executor (not implemented here): reserve actionId in
    // the durable send-lock store, re-run this plan inside the reservation, send
    // ONE fresh-thread Touch 1 from recoverySenderId through sendEmail, record
    // RECOVERY_SENT_EVENT with step/originalGmailMessageId/actionId and the new
    // Gmail ids, and only then may the cadence (Touch 2) consider the lead again.
  };
}

module.exports = {
  FAILED_TOUCH_EVENT, SENDER_AUTH_FAILURE_EVENT, RECOVERY_AUTHORIZED_EVENT, RECOVERY_RESERVED_EVENT,
  RECOVERY_SENT_EVENT, ENABLED_VAR, SENDERS_VAR, RECOVERABLE_STEP, AUTHORIZATION_MAX_AGE_DAYS,
  recoveryActionId, provenFailedTouches, recordedRecoveries, unrecoveredTouchBlock, planSameTouchRecovery,
};
