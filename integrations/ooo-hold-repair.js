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
 * Every check reuses the shared definitions (suppression, booking events, hold
 * release) rather than restating them. Pure: the server route persists.
 */

const {
  MANUAL_HOLD_TAG, sendSuppressionReason, releaseHoldFromNotes, CALL_BOOKING_EVENTS,
} = require('./pipeline-state');
const { activityBelongsToLead } = require('./lead-activity');
const { buildOooResumeEvent, OOO_RESUME_SOURCE, parseMetadata } = require('./ooo-pause');

// A resume further out than this is a mis-parsed date, not an absence.
const MAX_RESUME_HORIZON_DAYS = 60;
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

module.exports = { planOooHoldRelease, MAX_RESUME_HORIZON_DAYS };
