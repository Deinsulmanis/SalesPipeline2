'use strict';

/**
 * One-off repair for OOO leads the OLD handler put on [MANUAL HOLD].
 *
 * Before 2026-10-03 an autoresponder made the lead [MANUAL HOLD] plus a
 * [RESUME:] tag that the canonical notes merge then dropped, so those leads
 * could never resume. A manual hold is absolute and only Resume releases it —
 * but Resume is a Pipeline-card transaction and these are ColdEmail-only
 * leads. This plan is the narrow bridge: it releases a hold ONLY when the
 * ledger proves the OOO handler applied it (not a person), and replaces it
 * with the same event-sourced OOO pause the new handler writes.
 *
 * planOooResumeSchedule is the operator's other OOO action: setting the resume
 * date for a lead the handler could not date, recording the same event.
 *
 * Every check reuses the shared definitions (suppression, booking events, hold
 * release) rather than restating them. Pure: the server route persists.
 */

const {
  MANUAL_HOLD_TAG, sendSuppressionReason, releaseHoldFromNotes, CALL_BOOKING_EVENTS,
} = require('./pipeline-state');
const { activityBelongsToLead } = require('./lead-activity');
const {
  buildOooResumeEvent, OOO_RESUME_SOURCE, parseMetadata, MAX_RESUME_HORIZON_DAYS,
  oooPauseState, OOO_PAUSE_STATUS,
} = require('./ooo-pause');
const { vancouverDayStart } = require('./sequence-timing');
const { classifyReplyText } = require('./canonical-reply');
const { isArchivedLead } = require('./lead-archive');
const GENUINE_REPLY_EVENTS = new Set([
  'positive_reply', 'meeting_requested', 'late_reply', 'question_reply', 'negative_reply',
  'unsubscribe_reply', 'wrong_person_reply', 'needs_human_reply',
]);
const toMs = value => (value === null || value === undefined || value === '' ? NaN : Date.parse(value));

/**
 * @returns {{ ok, refusals: string[], checks, event, nextNotes, fingerprint }}
 */
function planOooHoldRelease({ lead = {}, activities = [], suppressedEmails = new Set(), resumeAt, by = '', now = Date.now() } = {}) {
  const nowMs = new Date(now).getTime();
  const notes = String(lead.notes || '');
  const mine = (activities || []).filter(row => activityBelongsToLead(row, lead));
  const metaOf = row => parseMetadata(row.metadata);
  const ooo = mine.filter(row => row.eventType === 'out_of_office_reply')
    .sort((a, b) => toMs(b.occurredAt) - toMs(a.occurredAt))[0] || null;
  const oooAt = ooo ? toMs(ooo.occurredAt) : NaN;
  const decision = mine.find(row => row.eventType === 'reply_decision_recorded'
    && metaOf(row).route === 'out_of_office'
    && (metaOf(row).effects || []).includes('hold_applied'));
  const humanHold = mine.find(row => row.eventType === 'automation_held');
  const laterReply = mine.find(row => GENUINE_REPLY_EVENTS.has(row.eventType) && toMs(row.occurredAt) > oooAt);
  const humanResponse = mine.find(row => row.eventType === 'human_response_sent' && toMs(row.occurredAt) > oooAt);
  const booking = mine.find(row => CALL_BOOKING_EVENTS.includes(String(row.eventType || '')));
  // The sender's own suppression rule, asked about the lead as it would be
  // WITHOUT the hold: any other tag (opt-out, bounce, archive) or the durable
  // list still refuses.
  const otherSuppression = sendSuppressionReason({ ...lead, notes: releaseHoldFromNotes(notes) }, { suppressedEmails });
  const resumeMs = toMs(resumeAt);

  const refusals = [];
  if (!String(by).trim()) refusals.push('by is required (who authorised the release)');
  if (!notes.includes(MANUAL_HOLD_TAG)) refusals.push('the lead is not on [MANUAL HOLD]; nothing to release');
  if (!/\[REPLY:\s*OOO/i.test(notes)) refusals.push('the notes carry no OOO marker; this hold was not written by the OOO handler');
  if (!ooo) refusals.push('no out_of_office_reply event is recorded for this lead');
  if (!decision) refusals.push('no reply decision proves the OOO handler applied this hold (route out_of_office, effect hold_applied)');
  if (humanHold) refusals.push(`a person also applied a manual hold (${humanHold.eventId || humanHold.occurredAt}); only Resume may release it`);
  if (laterReply) refusals.push(`a genuine reply arrived after the OOO (${laterReply.eventType}); a person owns the next move`);
  if (humanResponse) refusals.push('a person answered after the OOO; automation must not resume');
  if (booking) refusals.push(`a booking exists (${booking.eventType})`);
  if (otherSuppression) refusals.push(`suppressed (${otherSuppression})`);
  if (String(lead.emailStatus || '').trim().toLowerCase() !== 'emailed') {
    refusals.push(`emailStatus is "${lead.emailStatus || ''}", not an active cold sequence`);
  }
  if (!Number.isFinite(resumeMs)) refusals.push('resumeAt is required and must be a valid date');
  else {
    if (Number.isFinite(oooAt) && resumeMs < oooAt) refusals.push('resumeAt is before the OOO reply');
    if (resumeMs > nowMs + MAX_RESUME_HORIZON_DAYS * 86400000) refusals.push(`resumeAt is more than ${MAX_RESUME_HORIZON_DAYS} days out`);
  }

  const checks = {
    oooEventId: ooo?.eventId || null, oooOccurredAt: ooo?.occurredAt || null,
    statedReturnDate: ooo ? (metaOf(ooo).returnDate || null) : null,
    holdProvenance: decision ? (decision.eventId || 'reply_decision_recorded') : null,
    humanHold: Boolean(humanHold), laterGenuineReply: laterReply?.eventType || null,
    humanResponseAfterOoo: Boolean(humanResponse), booking: booking?.eventType || null,
    otherSuppression: otherSuppression || null,
    emailStatus: lead.emailStatus || '', emailStep: lead.emailStep || '',
  };
  if (refusals.length) return { ok: false, refusals, checks, event: null, nextNotes: null, fingerprint: null };

  const event = buildOooResumeEvent({
    lead, oooMessageId: metaOf(ooo).gmailMessageId || '', oooOccurredAt: ooo.occurredAt,
    resumeAt: new Date(resumeMs).toISOString(), resumeSource: OOO_RESUME_SOURCE.OPERATOR_REPAIR,
    by: String(by).trim(), occurredAt: new Date(nowMs).toISOString(),
  });
  // Removes the hold and any [RESUME:] residue; the OOO marker stays as history.
  const nextNotes = releaseHoldFromNotes(notes);
  const fingerprint = [lead.id, notes, event.eventId, new Date(resumeMs).toISOString()].join('|');
  return { ok: true, refusals: [], checks, event, nextNotes, fingerprint };
}

// 'YYYY-MM-DD' is a return DAY (00:00 Vancouver); anything else must be an instant.
function resumeInstantMs(value) {
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return vancouverDayStart(text);
  return toMs(text);
}

/**
 * An operator sets the resume for an OOO lead the handler could not date: no
 * reliable return date, a misread one, or a schedule the retired 7-day policy
 * invented. It records the SAME ooo_resume_scheduled event the handler writes,
 * source operator_scheduled — and nothing else: no notes, no hold, no send.
 * After that instant the agent's ordinary gates decide, caps and windows
 * included. Refuses whenever automation resuming would be wrong.
 *
 * @returns {{ ok, refusals: string[], checks, event, alreadyRecorded, fingerprint }}
 */
function planOooResumeSchedule({
  lead = {}, activities = [], suppressedEmails = new Set(), resumeAt, by = '', evidence = '', now = Date.now(),
} = {}) {
  const nowMs = new Date(now).getTime();
  const notes = String(lead.notes || '');
  const mine = (activities || []).filter(row => activityBelongsToLead(row, lead));
  const state = oooPauseState(lead, mine, { now: nowMs });
  const ooo = state.oooEventId ? mine.find(row => row.eventId === state.oooEventId) || null : null;
  const oooAt = ooo ? toMs(ooo.occurredAt) : NaN;
  // What the autoresponder says, read again with the current parser: evidence
  // for the operator, never a substitute for their decision.
  const parsedReturnDate = ooo && String(ooo.content || '').trim()
    ? (classifyReplyText(String(ooo.content), { subject: ooo.subject || '', now: ooo.occurredAt }).returnDate || null)
    : null;
  const humanResponse = mine.find(row => row.eventType === 'human_response_sent' && toMs(row.occurredAt) > oooAt);
  const booking = mine.find(row => CALL_BOOKING_EVENTS.includes(String(row.eventType || '')));
  const suppression = sendSuppressionReason(lead, { suppressedEmails });
  const resumeMs = resumeInstantMs(resumeAt);

  const refusals = [];
  if (!String(by).trim()) refusals.push('by is required (who set the resume date)');
  if (state.status === OOO_PAUSE_STATUS.NONE) refusals.push('no automated reply is recorded for this lead');
  if (state.status === OOO_PAUSE_STATUS.SUPERSEDED) refusals.push('a genuine reply exists; a person owns the next move');
  if (state.status === OOO_PAUSE_STATUS.SEQUENCE_COMPLETE) refusals.push('every touch was already sent; there is nothing to resume');
  if (state.status === OOO_PAUSE_STATUS.RESUMED) refusals.push('a touch was already sent after this autoresponder; the sequence has resumed');
  if (humanResponse) refusals.push('a person answered after the OOO; automation must not resume');
  if (booking) refusals.push(`a booking exists (${booking.eventType})`);
  if (notes.includes(MANUAL_HOLD_TAG)) refusals.push('the lead is on [MANUAL HOLD]; only Resume (or the OOO hold release) may lift it');
  else if (suppression) refusals.push(`suppressed (${suppression})`);
  if (isArchivedLead(lead)) refusals.push('the lead is archived');
  if (String(lead.emailStatus || '').trim().toLowerCase() !== 'emailed') {
    refusals.push(`emailStatus is "${lead.emailStatus || ''}", not an active cold sequence`);
  }
  if (state.status !== OOO_PAUSE_STATUS.NONE && !state.stepsConsistent) {
    refusals.push(`the ledger shows Touch ${state.ledgerLastStep} sent but the row says step ${state.cellStep}; reconcile the sequence first`);
  }
  if (state.status !== OOO_PAUSE_STATUS.NONE && !state.nextStep) refusals.push('no next touch exists to resume');
  if (!Number.isFinite(resumeMs)) refusals.push('resumeAt is required: a return day (YYYY-MM-DD) or an ISO instant');
  else {
    if (Number.isFinite(oooAt) && resumeMs < vancouverDayStart(new Date(oooAt).toISOString().slice(0, 10))) {
      refusals.push('resumeAt is before the day of the OOO reply');
    }
    if (resumeMs > nowMs + MAX_RESUME_HORIZON_DAYS * 86400000) refusals.push(`resumeAt is more than ${MAX_RESUME_HORIZON_DAYS} days out`);
  }

  const checks = {
    status: state.status || null, oooEventId: state.oooEventId || null, oooOccurredAt: state.oooOccurredAt || null,
    oooSubject: ooo ? (ooo.subject || '') : null,
    recordedReturnDate: state.statedReturnDate || null, parsedReturnDate,
    currentResumeAt: state.resumeAt || null, currentResumeSource: state.resumeSource || null,
    ignoredPolicyResumeAt: state.ignoredPolicyResumeAt || null,
    ledgerLastStep: state.ledgerLastStep ?? null, cellStep: state.cellStep ?? null, nextStep: state.nextStep ?? null,
    humanResponseAfterOoo: Boolean(humanResponse), booking: booking?.eventType || null,
    manualHold: notes.includes(MANUAL_HOLD_TAG), suppression: suppression || null,
    emailStatus: lead.emailStatus || '', senderInboxId: lead.senderInboxId || '',
  };
  if (refusals.length) return { ok: false, refusals, checks, event: null, alreadyRecorded: false, fingerprint: null };

  const event = buildOooResumeEvent({
    lead, oooMessageId: state.oooMessageId || '', oooOccurredAt: state.oooOccurredAt,
    resumeAt: new Date(resumeMs).toISOString(), resumeSource: OOO_RESUME_SOURCE.OPERATOR_SCHEDULED,
    by: String(by).trim(), occurredAt: new Date(nowMs).toISOString(),
    statedReturnDate: parsedReturnDate || '', evidence,
  });
  const alreadyRecorded = mine.some(row => row.eventId === event.eventId);
  const fingerprint = [lead.id, notes, lead.emailStep || '', state.oooEventId, event.eventId].join('|');
  return { ok: true, refusals: [], checks, event, alreadyRecorded, fingerprint };
}

module.exports = { planOooHoldRelease, planOooResumeSchedule, MAX_RESUME_HORIZON_DAYS };
