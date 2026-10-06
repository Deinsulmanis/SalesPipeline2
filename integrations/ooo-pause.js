'use strict';

/**
 * Temporary out-of-office pause for cold automation.
 *
 * An autoresponder is not a person deciding anything, so it must not become a
 * [MANUAL HOLD]: a manual hold is absolute (only Resume releases it), which is
 * exactly why OOO leads used to stay stopped forever — the [RESUME:] tag the
 * handler wrote was dropped by the canonical notes merge, and even when kept,
 * ownership ignores it for held leads.
 *
 * Instead the pause is EVENT-SOURCED. When an OOO reply is handled, one
 * append-only `ooo_resume_scheduled` activity records when automation may
 * resume: the prospect's stated return date, or the 7-day OOO policy when none
 * was stated. reply-operations reads it and reports WAIT_UNTIL_RETURN with that
 * date; ownership rule 8 then keeps cold automation off until the instant
 * passes, and every other rule (a later human reply, a booking, an opt-out,
 * suppression, a real manual hold) still outranks it. No notes tag carries the
 * gate, so no stale notes write can erase or resurrect it.
 *
 * Pure: no I/O.
 */

const { addVancouverDays } = require('./sequence-timing');

const OOO_RESUME_EVENT = 'ooo_resume_scheduled';
const OOO_DEFAULT_RETRY_DAYS = 7;
const OOO_RESUME_SOURCE = Object.freeze({
  PROSPECT_STATED: 'prospect_stated',
  POLICY_DEFAULT: 'ooo_policy_default',
  OPERATOR_REPAIR: 'operator_repair',
});

const toMs = value => (value === null || value === undefined || value === '' ? NaN : Date.parse(value));
const isoOrNull = value => (Number.isFinite(toMs(value)) ? new Date(toMs(value)).toISOString() : null);

function parseMetadata(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}'); } catch (_) { return {}; }
}

/**
 * When cold automation may resume after an OOO reply. A stated return date in
 * the future wins; otherwise the policy default runs from when the
 * autoresponder ARRIVED, so re-processing the same message gives the same date.
 */
function planOooResume({ returnDate = '', occurredAt = '', now = Date.now() } = {}) {
  const nowMs = new Date(now).getTime();
  const stated = toMs(returnDate);
  if (Number.isFinite(stated) && stated > nowMs) {
    return { resumeAt: new Date(stated).toISOString(), resumeSource: OOO_RESUME_SOURCE.PROSPECT_STATED };
  }
  const received = Number.isFinite(toMs(occurredAt)) ? toMs(occurredAt) : nowMs;
  return {
    resumeAt: new Date(addVancouverDays(received, OOO_DEFAULT_RETRY_DAYS)).toISOString(),
    resumeSource: OOO_RESUME_SOURCE.POLICY_DEFAULT,
  };
}

function oooResumeEventId(leadId, oooMessageId, oooOccurredAt, { repair = false } = {}) {
  return `ooo-resume:${leadId}:${oooMessageId || oooOccurredAt || 'unknown'}${repair ? ':repair' : ''}`;
}

/** The append-only activity row. Carries ids and dates, never message text. */
function buildOooResumeEvent({
  lead, oooMessageId = '', oooOccurredAt = '', resumeAt, resumeSource,
  by = 'reply-auto', occurredAt = new Date().toISOString(), company = '',
}) {
  const repair = resumeSource === OOO_RESUME_SOURCE.OPERATOR_REPAIR;
  return {
    eventId: oooResumeEventId(lead.id, oooMessageId, oooOccurredAt, { repair }),
    leadId: `CE-${lead.id}`, sourceLeadId: lead.id, email: lead.email || '',
    company: company || lead.company || '', eventType: OOO_RESUME_EVENT, occurredAt,
    subject: '', content: '',
    metadata: JSON.stringify({
      resumeAt: isoOrNull(resumeAt), resumeSource, oooMessageId: oooMessageId || '',
      oooOccurredAt: isoOrNull(oooOccurredAt), by,
    }),
  };
}

/**
 * The scheduled resume that answers the OOO reply received at `since`, or
 * null. Only a schedule recorded at or after that reply counts: a newer
 * autoresponder is never answered by an older schedule.
 */
function scheduledOooResume(activities = [], { since = null } = {}) {
  const sinceMs = toMs(since);
  let chosen = null;
  for (const row of activities || []) {
    if (String(row?.eventType || '') !== OOO_RESUME_EVENT) continue;
    const at = toMs(row.occurredAt);
    if (!Number.isFinite(at) || (Number.isFinite(sinceMs) && at < sinceMs)) continue;
    const meta = parseMetadata(row.metadata);
    const resumeAt = isoOrNull(meta.resumeAt);
    if (!resumeAt) continue;
    if (!chosen || at > chosen.recordedAt) {
      chosen = { resumeAt, resumeSource: meta.resumeSource || OOO_RESUME_SOURCE.POLICY_DEFAULT, recordedAt: at, eventId: row.eventId || '' };
    }
  }
  return chosen;
}

module.exports = {
  OOO_RESUME_EVENT, OOO_DEFAULT_RETRY_DAYS, OOO_RESUME_SOURCE,
  planOooResume, buildOooResumeEvent, scheduledOooResume, oooResumeEventId, parseMetadata,
};
