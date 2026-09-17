'use strict';

const { STATUS } = require('./send-reservation-rules');
const { parseOutboundActionId } = require('./outbound-action-id');
const { verifyGmailSentMessage } = require('./gmail-provider-verify');
const { SEQUENCE_EVENTS } = require('./stage-sequences');

const SMARTLEAD_LIMITATION = 'Smartlead live mutations are disabled; provider enqueue state cannot be verified without a live mutating API. Uncertain Smartlead reservations stay manual-only and are never resent.';

const OPERATOR_ACTIONS = Object.freeze({
  VERIFY_AND_CONFIRM: 'verify_gmail_and_confirm_checkpoint',
  MANUAL_REVIEW: 'manual_review',
  MANUAL_REVIEW_SMARTLEAD: 'manual_review_smartlead',
  INSPECT_EXPIRED_LEASE: 'inspect_expired_lease',
  NONE: 'none',
});

function parseMeta(raw) {
  try { return JSON.parse(raw || '{}'); } catch (_) { return {}; }
}

function ageMs(row, now = new Date()) {
  const stamp = row?.reservedAt || row?.createdAt || row?.updatedAt;
  const at = stamp ? Date.parse(stamp) : NaN;
  return Number.isFinite(at) ? Math.max(0, now.getTime() - at) : null;
}

function recommendedOperatorAction(row, now = new Date()) {
  const provider = String(row?.provider || '').toLowerCase();
  const status = row?.status;
  const hasId = Boolean(String(row?.providerMessageId || '').trim());
  if (provider === 'smartlead') {
    return {
      recommendedAction: OPERATOR_ACTIONS.MANUAL_REVIEW_SMARTLEAD,
      retryableSend: false,
      reason: SMARTLEAD_LIMITATION,
    };
  }
  if (status === STATUS.SENT_UNCONFIRMED || status === STATUS.RECONCILIATION_REQUIRED) {
    if (provider === 'gmail' && hasId) {
      return {
        recommendedAction: OPERATOR_ACTIONS.VERIFY_AND_CONFIRM,
        retryableSend: false,
        reason: 'Gmail provider_message_id is present; verify SENT evidence and repair local checkpoints only',
      };
    }
    return {
      recommendedAction: OPERATOR_ACTIONS.MANUAL_REVIEW,
      retryableSend: false,
      reason: hasId
        ? 'Provider evidence cannot be automatically verified'
        : 'provider_message_id is missing; absence is not proof of non-send and must not be resent',
    };
  }
  if (status === STATUS.SENDING) {
    const expired = row.leaseExpiresAt && new Date(row.leaseExpiresAt).getTime() < now.getTime();
    return {
      recommendedAction: expired ? OPERATOR_ACTIONS.MANUAL_REVIEW : OPERATOR_ACTIONS.INSPECT_EXPIRED_LEASE,
      retryableSend: false,
      reason: 'a provider attempt started; expired sending leases are never automatically resent',
    };
  }
  if (status === STATUS.RESERVED) {
    return {
      recommendedAction: OPERATOR_ACTIONS.INSPECT_EXPIRED_LEASE,
      retryableSend: false,
      reason: 'stale reserved rows are listed for operators; they are never automatically resent by reconciliation',
    };
  }
  return { recommendedAction: OPERATOR_ACTIONS.NONE, retryableSend: false, reason: '' };
}

function operatorRow(row, now = new Date()) {
  const rec = recommendedOperatorAction(row, now);
  return {
    actionId: row.actionId,
    leadId: row.leadId,
    provider: row.provider,
    status: row.status,
    actionType: row.actionType || parseOutboundActionId(row.actionId).actionType,
    reservedAt: row.reservedAt || null,
    ageMs: ageMs(row, now),
    providerMessageIdPresent: Boolean(String(row.providerMessageId || '').trim()),
    providerMessageId: row.providerMessageId || null,
    providerThreadId: row.providerThreadId || null,
    lastError: row.lastError || null,
    leaseExpiresAt: row.leaseExpiresAt || null,
    recommendedAction: rec.recommendedAction,
    retryableSend: false,
    reason: rec.reason,
  };
}

function plannedCheckpointRepair({
  reservation, proof, lead, activities = [], lastColdStep = 3, attribution = null,
}) {
  const parsed = parseOutboundActionId(reservation.actionId);
  const occurredAt = proof.occurredAt;
  const senderInboxId = String(lead?.senderInboxId || '').trim();
  const leadId = lead?.id || reservation.leadId;
  const existingIds = new Set((activities || []).map(row => row.eventId));

  if (parsed.kind === 'gmail_sequence_step') {
    const eventId = reservation.actionId;
    const activity = existingIds.has(eventId) ? null : {
      eventId,
      leadId: String(lead?.boardLeadId || `CE-${leadId}`),
      sourceLeadId: leadId,
      email: lead?.email || '',
      company: lead?.company || '',
      eventType: SEQUENCE_EVENTS.STEP_SENT,
      occurredAt,
      subject: proof.subject || '',
      content: '',
      metadata: {
        sequenceId: parsed.sequenceId, step: parsed.step,
        provider: 'gmail', providerMessageId: proof.providerMessageId,
        gmailMessageId: proof.providerMessageId, gmailThreadId: proof.threadId || '',
        rfcMessageId: proof.rfcMessageId || '', senderInboxId,
        recoveredAfterCheckpointFailure: true, ...attribution,
      },
    };
    return { kind: parsed.kind, activity, leadFields: null, parsed };
  }

  if (parsed.kind === 'gmail_warm_reply') {
    const eventId = reservation.actionId;
    const activity = existingIds.has(eventId) ? null : {
      eventId,
      leadId: `CE-${leadId}`,
      sourceLeadId: leadId,
      email: lead?.email || '',
      company: lead?.company || '',
      eventType: 'booking_link_sent',
      occurredAt,
      subject: proof.subject || '',
      content: '',
      metadata: {
        actionId: reservation.actionId, provider: 'gmail',
        providerMessageId: proof.providerMessageId, gmailMessageId: proof.providerMessageId,
        gmailThreadId: proof.threadId || '', rfcMessageId: proof.rfcMessageId || '',
        senderInboxId, recoveredAfterCheckpointFailure: true, ...attribution,
      },
    };
    return { kind: parsed.kind, activity, leadFields: null, parsed };
  }

  const step = Number(parsed.step || 0);
  const eventId = `gmail:${proof.providerMessageId}`;
  const isLast = step >= lastColdStep;
  const activity = existingIds.has(eventId) ? null : {
    eventId,
    leadId: `CE-${leadId}`,
    sourceLeadId: leadId,
    email: lead?.email || '',
    company: lead?.company || '',
    eventType: step === 1 ? 'initial_email_sent' : 'follow_up_sent',
    occurredAt,
    subject: proof.subject || '',
    content: '',
    metadata: {
      step, trigger: step === 1 ? 'cold_sequence_step_1' : 'cold_sequence_follow_up',
      provider: 'gmail', providerMessageId: proof.providerMessageId,
      gmailMessageId: proof.providerMessageId, gmailThreadId: proof.threadId || '',
      rfcMessageId: proof.rfcMessageId || '', senderInboxId,
      recoveredAfterCheckpointFailure: true, ...attribution,
    },
  };
  const currentStep = Number(lead?.emailStep || 0);
  const leadAlreadyAtLeast = currentStep >= step && Boolean(lead?.lastEmailedAt);
  const leadFields = leadAlreadyAtLeast ? null : {
    stage: isLast ? 'Done' : 'Contacted',
    emailStatus: isLast ? 'done' : 'emailed',
    lastEmailedAt: occurredAt,
    emailStep: String(step),
    ...(senderInboxId ? { senderInboxId } : {}),
  };
  return { kind: parsed.kind || 'gmail_cold_step', activity, leadFields, parsed };
}

function classifyLegacySheetsReservation(row, activities = []) {
  const meta = parseMeta(row.metadata);
  const eventType = String(row.eventType || '');
  if (eventType === 'ordinary_send_reserved') {
    const failed = (activities || []).some(item => item.eventType === 'ordinary_send_failed'
      && parseMeta(item.metadata).reservationEventId === row.eventId);
    if (failed) {
      return {
        classification: 'provably_failed_pre_delivery',
        recommendedAction: OPERATOR_ACTIONS.NONE,
        retryableSend: false,
      };
    }
    const sent = (activities || []).some(item => {
      const itemMeta = parseMeta(item.metadata);
      const sameLead = item.sourceLeadId === row.sourceLeadId || itemMeta.leadId === meta.leadId;
      return sameLead && Number(itemMeta.step) === Number(meta.step)
        && ['initial_email_sent', 'follow_up_sent'].includes(item.eventType);
    });
    if (sent) {
      return {
        classification: 'provably_sent',
        recommendedAction: OPERATOR_ACTIONS.NONE,
        retryableSend: false,
      };
    }
    return {
      classification: 'unresolved_manual_review',
      recommendedAction: OPERATOR_ACTIONS.MANUAL_REVIEW,
      retryableSend: false,
      reason: 'legacy ordinary reservation has no matching send or pre-delivery failure; never automatically resent',
    };
  }
  if (eventType === SEQUENCE_EVENTS.SEND_RESERVED) {
    const failed = (activities || []).some(item => item.eventType === SEQUENCE_EVENTS.SEND_FAILED
      && parseMeta(item.metadata).reservationEventId === row.eventId);
    if (failed) {
      return {
        classification: 'provably_failed_pre_delivery',
        recommendedAction: OPERATOR_ACTIONS.NONE,
        retryableSend: false,
      };
    }
    const stepEventId = meta.stepEventId;
    const sent = (activities || []).some(item => item.eventType === SEQUENCE_EVENTS.STEP_SENT
      && (item.eventId === stepEventId || parseMeta(item.metadata).stepEventId === stepEventId));
    if (sent) {
      return {
        classification: 'provably_sent',
        recommendedAction: OPERATOR_ACTIONS.NONE,
        retryableSend: false,
      };
    }
    return {
      classification: 'unresolved_manual_review',
      recommendedAction: OPERATOR_ACTIONS.MANUAL_REVIEW,
      retryableSend: false,
      reason: 'legacy sequence reservation has no matching send or pre-delivery failure; never automatically resent',
    };
  }
  return {
    classification: 'unresolved_manual_review',
    recommendedAction: OPERATOR_ACTIONS.MANUAL_REVIEW,
    retryableSend: false,
  };
}

function listLegacySheetsReservations(activities = []) {
  const unresolvedTypes = new Set(['ordinary_send_reserved', SEQUENCE_EVENTS.SEND_RESERVED]);
  return (activities || [])
    .filter(row => unresolvedTypes.has(row.eventType))
    .map(row => ({
      eventId: row.eventId,
      eventType: row.eventType,
      leadId: row.sourceLeadId || parseMeta(row.metadata).leadId || '',
      occurredAt: row.occurredAt || null,
      metadata: parseMeta(row.metadata),
      ...classifyLegacySheetsReservation(row, activities),
    }));
}

async function leaveUnresolved({ store, reservation, code, reason }) {
  if (!store?.markReconciliationRequired) {
    return { ok: true, status: STATUS.RECONCILIATION_REQUIRED, code, reason, sends: 0 };
  }
  if (reservation.status === STATUS.CONFIRMED || reservation.status === STATUS.FAILED_PRE_DELIVERY) {
    return { ok: true, status: reservation.status, code, reason, sends: 0 };
  }
  const marked = await store.markReconciliationRequired(reservation.actionId, `${code}: ${reason}`.slice(0, 500));
  return {
    ok: true,
    status: marked.reservation?.status || STATUS.RECONCILIATION_REQUIRED,
    code, reason, sends: 0, reservation: marked.reservation || reservation,
  };
}

async function reconcileGmailReservation({
  reservation, mailbox, lead, activities = [], store, applyCheckpoint,
  lastColdStep = 3, attribution = null, now = new Date(),
}) {
  const sends = 0;
  if (!reservation?.actionId) {
    return { ok: false, code: 'reservation_missing', sends, retryableSend: false };
  }
  if (reservation.status === STATUS.CONFIRMED) {
    return {
      ok: true, code: 'already_confirmed', confirmed: true, alreadyConfirmed: true, repaired: false,
      sends, retryableSend: false, reservation,
    };
  }
  if (String(reservation.provider || '').toLowerCase() === 'smartlead') {
    return {
      ok: true, code: 'smartlead_manual_only', confirmed: false, repaired: false,
      sends, retryableSend: false, reason: SMARTLEAD_LIMITATION, reservation,
    };
  }
  if (![STATUS.SENT_UNCONFIRMED, STATUS.RECONCILIATION_REQUIRED].includes(reservation.status)) {
    if (reservation.status === STATUS.SENDING || reservation.status === STATUS.RESERVED) {
      return {
        ok: true, code: 'not_automatically_sendable', confirmed: false, repaired: false,
        sends, retryableSend: false,
        reason: recommendedOperatorAction(reservation, now).reason, reservation,
      };
    }
    return {
      ok: true, code: 'not_reconcileable', confirmed: false, repaired: false,
      sends, retryableSend: false, reservation,
    };
  }

  const proof = await verifyGmailSentMessage({
    gmail: mailbox?.gmail, providerMessageId: reservation.providerMessageId,
    expectedSenderEmail: mailbox?.email, expectedRecipientEmail: lead?.email,
  });
  if (!proof.ok) {
    const left = await leaveUnresolved({
      store, reservation, code: proof.code, reason: proof.reason,
    });
    return {
      ok: true, verified: false, confirmed: false, repaired: false,
      sends, retryableSend: false, code: proof.code, reason: proof.reason,
      reservation: left.reservation || reservation,
    };
  }

  const plan = plannedCheckpointRepair({
    reservation, proof, lead, activities, lastColdStep, attribution,
  });
  let repaired = false;
  if (applyCheckpoint) {
    const applied = await applyCheckpoint(plan, { reservation, proof, lead });
    repaired = Boolean(applied?.repaired || plan.activity || plan.leadFields);
  } else {
    repaired = Boolean(plan.activity || plan.leadFields);
  }

  let confirmed = { ok: false };
  if (store?.markConfirmed) {
    confirmed = await store.markConfirmed(reservation.actionId, null, { allowReconciliation: true });
  }
  return {
    ok: Boolean(confirmed.ok || confirmed.alreadyConfirmed),
    verified: true,
    confirmed: Boolean(confirmed.ok || confirmed.alreadyConfirmed),
    alreadyConfirmed: Boolean(confirmed.alreadyConfirmed),
    repaired,
    sends,
    retryableSend: false,
    code: (confirmed.ok || confirmed.alreadyConfirmed) ? 'gmail_sent_confirmed' : (confirmed.code || 'confirm_failed'),
    proof: {
      providerMessageId: proof.providerMessageId,
      threadId: proof.threadId,
      occurredAt: proof.occurredAt,
    },
    plan,
    reservation: confirmed.reservation || reservation,
  };
}

module.exports = {
  SMARTLEAD_LIMITATION, OPERATOR_ACTIONS,
  ageMs, recommendedOperatorAction, operatorRow,
  plannedCheckpointRepair, classifyLegacySheetsReservation, listLegacySheetsReservations,
  reconcileGmailReservation,
};
