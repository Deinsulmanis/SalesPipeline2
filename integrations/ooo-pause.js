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
 * Instead the pause is EVENT-SOURCED. When an OOO reply states a reliable
 * return date, one append-only `ooo_resume_scheduled` activity records when
 * automation may resume: 00:00 Vancouver time on that date. reply-operations
 * reads it and reports WAIT_UNTIL_RETURN; ownership keeps cold automation off
 * until the instant passes, and every other rule (a later human reply, a
 * booking, an opt-out, suppression, a real manual hold) still outranks it. No
 * notes tag carries the gate, so no stale notes write can erase or resurrect it.
 *
 * An ABSENCE (out-of-office, temporary closure) with no reliable date
 * schedules NOTHING. No return date is invented: the lead waits for a person
 * (reply-operations' OOO_REVIEW), who records the resume through the operator
 * route — the same event, source operator. Schedules the 7-day policy wrote for
 * absences before 2026-10-15 are invented dates: read as evidence only, never
 * as permission to resume. A generic acknowledgement ("thanks for contacting
 * us") claims no absence and keeps the 7-day retry it has always had.
 *
 * On resume the sequence continues at the next unsent step (the ledger, never
 * Touch 1 again), and the first touch after the return may carry one line of
 * context (oooResumeCopy). Capacity, windows and every send gate still apply.
 *
 * Pure: no I/O.
 */

const { addVancouverDays, vancouverDayStart, sendsFor, SEQUENCE_TIMING } = require('./sequence-timing');
const { activityBelongsToLead } = require('./lead-activity');
const { LEGACY_REPLY_EVENT_TYPES, GENUINE_HUMAN_STATES, REPLY_STATE } = require('./canonical-reply');

const OOO_RESUME_EVENT = 'ooo_resume_scheduled';
const OOO_RESUME_SOURCE = Object.freeze({
  PROSPECT_STATED: 'prospect_stated',
  // 7 days after a generic acknowledgement. Never a return date: since
  // 2026-10-15 an absence with no stated date is reviewed, not defaulted.
  POLICY_DEFAULT: 'ooo_policy_default',
  OPERATOR_REPAIR: 'operator_repair',
  // A person read the autoresponder and set the resume date.
  OPERATOR_SCHEDULED: 'operator_scheduled',
});
// Only these may let cold automation resume.
const AUTHORITATIVE_RESUME_SOURCES = Object.freeze([
  OOO_RESUME_SOURCE.PROSPECT_STATED, OOO_RESUME_SOURCE.OPERATOR_REPAIR, OOO_RESUME_SOURCE.OPERATOR_SCHEDULED,
]);
// A resume further out than this is a mis-parsed date, not an absence.
const MAX_RESUME_HORIZON_DAYS = 60;
// The retry after a generic acknowledgement autoresponder (not an absence).
const OOO_DEFAULT_RETRY_DAYS = 7;
// canonical-reply's subtype for "we received your message": no one is away.
const GENERIC_AUTORESPONDER = 'autoresponder';
const isGenericAutoresponder = subtype => String(subtype || '') === GENERIC_AUTORESPONDER;

const OOO_PAUSE_STATUS = Object.freeze({
  NONE: 'none',                           // no automated reply on record
  SUPERSEDED: 'superseded_by_human_reply', // a person wrote; the human reply owns the lead
  SEQUENCE_COMPLETE: 'sequence_complete', // every touch was sent; nothing to resume
  REVIEW_REQUIRED: 'review_required',     // no reliable return date; a person decides
  WAITING: 'waiting',                     // a resume instant is set and still ahead
  RESUME_DUE: 'resume_due',               // reached; the next touch is the resumed one
  RESUMED: 'resumed',                     // a touch has already gone out since the OOO
});

const toMs = value => (value === null || value === undefined || value === '' ? NaN : Date.parse(value));
const isoOrNull = value => (Number.isFinite(toMs(value)) ? new Date(toMs(value)).toISOString() : null);

function parseMetadata(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}'); } catch (_) { return {}; }
}

/** The calendar day a stated return date names ('YYYY-MM-DD'), or ''. */
function statedReturnDay(value) {
  const day = String(value || '').slice(0, 10);
  return Number.isFinite(vancouverDayStart(day)) ? day : '';
}

/**
 * When cold automation may resume after an automated reply: 00:00 Vancouver on
 * the stated return date. An absence with no stated date — or one implausibly
 * far from the autoresponder — schedules nothing and a person reviews. A
 * generic acknowledgement keeps its 7-day retry from when it ARRIVED.
 * Deterministic: re-processing the same message gives the same plan.
 */
function planOooResume({ returnDate = '', occurredAt = '', subtype = null } = {}) {
  const day = statedReturnDay(returnDate);
  const receivedMs = toMs(occurredAt);
  if (!day && isGenericAutoresponder(subtype) && Number.isFinite(receivedMs)) {
    return { resumeAt: new Date(addVancouverDays(receivedMs, OOO_DEFAULT_RETRY_DAYS)).toISOString(),
      resumeSource: OOO_RESUME_SOURCE.POLICY_DEFAULT, reviewRequired: false };
  }
  if (!day) {
    return { resumeAt: null, resumeSource: null, reviewRequired: true,
      reason: 'the autoresponder states no reliable return date' };
  }
  const resumeMs = vancouverDayStart(day);
  if (Number.isFinite(receivedMs) && resumeMs > addVancouverDays(receivedMs, MAX_RESUME_HORIZON_DAYS)) {
    return { resumeAt: null, resumeSource: null, reviewRequired: true, statedReturnDate: day,
      reason: `the stated return date is more than ${MAX_RESUME_HORIZON_DAYS} days after the autoresponder` };
  }
  return { resumeAt: new Date(resumeMs).toISOString(), resumeSource: OOO_RESUME_SOURCE.PROSPECT_STATED,
    reviewRequired: false, statedReturnDate: day };
}

function oooResumeEventId(leadId, oooMessageId, oooOccurredAt, { resumeSource = '', resumeAt = '' } = {}) {
  const base = `ooo-resume:${leadId}:${oooMessageId || oooOccurredAt || 'unknown'}`;
  if (resumeSource === OOO_RESUME_SOURCE.OPERATOR_REPAIR) return `${base}:repair`;
  // One event per reviewed date: re-applying the same date is a no-op, a
  // corrected date is a new, later record (the latest record wins).
  if (resumeSource === OOO_RESUME_SOURCE.OPERATOR_SCHEDULED) return `${base}:operator:${isoOrNull(resumeAt) || 'unknown'}`;
  return base;
}

/** The append-only activity row. Carries ids, dates and a short quote, never the message. */
function buildOooResumeEvent({
  lead, oooMessageId = '', oooOccurredAt = '', resumeAt, resumeSource,
  by = 'reply-auto', occurredAt = new Date().toISOString(), company = '',
  statedReturnDate = '', evidence = '',
}) {
  const metadata = {
    resumeAt: isoOrNull(resumeAt), resumeSource, oooMessageId: oooMessageId || '',
    oooOccurredAt: isoOrNull(oooOccurredAt), by,
  };
  if (statedReturnDate) metadata.statedReturnDate = statedReturnDate;
  if (evidence) metadata.evidence = String(evidence).slice(0, 200);
  return {
    eventId: oooResumeEventId(lead.id, oooMessageId, oooOccurredAt, { resumeSource, resumeAt }),
    leadId: `CE-${lead.id}`, sourceLeadId: lead.id, email: lead.email || '',
    company: company || lead.company || '', eventType: OOO_RESUME_EVENT, occurredAt,
    subject: '', content: '',
    metadata: JSON.stringify(metadata),
  };
}

function resumeRecordsSince(activities, sinceMs) {
  const out = [];
  for (const row of activities || []) {
    if (String(row?.eventType || '') !== OOO_RESUME_EVENT) continue;
    const at = toMs(row.occurredAt);
    if (!Number.isFinite(at) || (Number.isFinite(sinceMs) && at < sinceMs)) continue;
    const meta = parseMetadata(row.metadata);
    const resumeAt = isoOrNull(meta.resumeAt);
    if (!resumeAt) continue;
    out.push({ resumeAt, resumeSource: meta.resumeSource || OOO_RESUME_SOURCE.POLICY_DEFAULT,
      recordedAt: at, eventId: row.eventId || '' });
  }
  return out;
}

/**
 * The scheduled resume that answers the automated reply received at `since`,
 * or null. Only a schedule recorded at or after that reply counts — a newer
 * autoresponder is never answered by an older schedule — and of those the
 * latest recorded wins, so there is only ever one active resume. A 7-day
 * policy schedule counts only for a generic acknowledgement (`acceptPolicy`);
 * for an absence it was an invented return date.
 */
function scheduledOooResume(activities = [], { since = null, acceptPolicy = false } = {}) {
  let chosen = null;
  for (const record of resumeRecordsSince(activities, toMs(since))) {
    if (!AUTHORITATIVE_RESUME_SOURCES.includes(record.resumeSource)
      && !(acceptPolicy && record.resumeSource === OOO_RESUME_SOURCE.POLICY_DEFAULT)) continue;
    if (!chosen || record.recordedAt > chosen.recordedAt) chosen = record;
  }
  return chosen;
}

/** The latest 7-day policy schedule for the same reply (set aside for an absence). */
function ignoredPolicyResume(activities = [], { since = null } = {}) {
  let chosen = null;
  for (const record of resumeRecordsSince(activities, toMs(since))) {
    if (record.resumeSource !== OOO_RESUME_SOURCE.POLICY_DEFAULT) continue;
    if (!chosen || record.recordedAt > chosen.recordedAt) chosen = record;
  }
  return chosen;
}

const isAutomatedReplyRow = row => {
  const meta = parseMetadata(row.metadata);
  const state = String(meta.canonicalState || '');
  return state ? state === REPLY_STATE.AUTOMATED_REPLY : String(row.eventType) === 'out_of_office_reply';
};
const isGenuineReplyRow = row => {
  const meta = parseMetadata(row.metadata);
  const state = String(meta.canonicalState || '');
  return state ? GENUINE_HUMAN_STATES.includes(state) : String(row.eventType) !== 'out_of_office_reply';
};

/**
 * The lead's whole OOO situation, derived from the ledger alone:
 * which autoresponder governs, whether a person wrote, the authoritative
 * resume (or why there is none), what the ledger proves was sent, and the step
 * a resume would send. Read by the replies view, the operator route and the
 * resume copy; the send gate itself stays in ownership.
 */
function oooPauseState(lead = {}, activities = [], { now = Date.now() } = {}) {
  const mine = (activities || []).filter(row => activityBelongsToLead(row, lead));
  const inbound = mine.filter(row => LEGACY_REPLY_EVENT_TYPES.includes(String(row.eventType || '')))
    .sort((a, b) => toMs(b.occurredAt) - toMs(a.occurredAt));
  const ooo = inbound.find(isAutomatedReplyRow) || null;
  if (!ooo) return { status: OOO_PAUSE_STATUS.NONE };
  const meta = parseMetadata(ooo.metadata);
  const oooMs = toMs(ooo.occurredAt);

  // What the ledger proves: the current sequence starts at the latest Touch 1.
  const sends = sendsFor(lead, mine);
  const start = sends.filter(s => s.step === 1).reduce((max, s) => Math.max(max, s.at), -Infinity);
  const current = sends.filter(s => s.at >= start);
  const ledgerLastStep = current.reduce((max, s) => Math.max(max, s.step), 0);
  const sentAfterOoo = current.some(s => s.at > oooMs);
  const cellStep = parseInt(lead.emailStep || '0', 10) || 0;
  const nextStep = ledgerLastStep >= 1 && ledgerLastStep < SEQUENCE_TIMING.touchCount ? ledgerLastStep + 1 : null;

  const subtype = meta.subtype || (String(ooo.eventType) === 'out_of_office_reply' ? 'out_of_office' : null);
  const acceptPolicy = isGenericAutoresponder(subtype);
  const scheduled = scheduledOooResume(mine, { since: ooo.occurredAt, acceptPolicy });
  const statedDay = statedReturnDay(meta.returnDate);
  // A return date stated in the autoresponder itself and recorded with it (an
  // OOO handled before resume events existed) is the same prospect evidence.
  const resume = scheduled || (statedDay ? {
    resumeAt: new Date(vancouverDayStart(statedDay)).toISOString(),
    resumeSource: OOO_RESUME_SOURCE.PROSPECT_STATED, eventId: null,
  } : null);
  const ignored = acceptPolicy ? null : ignoredPolicyResume(mine, { since: ooo.occurredAt });

  const base = {
    oooEventId: ooo.eventId || null, oooOccurredAt: isoOrNull(ooo.occurredAt),
    oooMessageId: meta.gmailMessageId || null, oooThreadId: meta.gmailThreadId || null,
    subtype,
    statedReturnDate: statedDay || null,
    resumeAt: resume ? resume.resumeAt : null, resumeSource: resume ? resume.resumeSource : null,
    resumeEventId: resume ? (resume.eventId || null) : null,
    ignoredPolicyResumeAt: ignored ? ignored.resumeAt : null,
    ledgerLastStep, cellStep, nextStep, sentAfterOoo,
    stepsConsistent: ledgerLastStep === cellStep,
  };
  const status = inbound.some(isGenuineReplyRow) ? OOO_PAUSE_STATUS.SUPERSEDED
    : !nextStep && ledgerLastStep >= SEQUENCE_TIMING.touchCount ? OOO_PAUSE_STATUS.SEQUENCE_COMPLETE
      // A generic acknowledgement with no schedule simply waits, as it always has.
      : !resume ? (acceptPolicy ? OOO_PAUSE_STATUS.WAITING : OOO_PAUSE_STATUS.REVIEW_REQUIRED)
        : new Date(now).getTime() < toMs(resume.resumeAt) ? OOO_PAUSE_STATUS.WAITING
          : sentAfterOoo ? OOO_PAUSE_STATUS.RESUMED
            : OOO_PAUSE_STATUS.RESUME_DUE;
  return { status, ...base };
}

/**
 * Whether the touch about to be sent is the first one after the prospect's
 * return, so it may open with one line of context. Only for an out-of-office
 * autoresponder — the message itself said they were away — and only while the
 * ledger and the row agree on what was sent: a resume never guesses its step.
 *
 * @returns {{ resumed: boolean, contextLine: boolean, refusal: string|null, state }}
 */
function oooResumeCopy(lead = {}, activities = [], { step, now = Date.now() } = {}) {
  const state = oooPauseState(lead, activities, { now });
  if (state.status !== OOO_PAUSE_STATUS.RESUME_DUE) return { resumed: false, contextLine: false, refusal: null, state };
  if (!state.stepsConsistent) {
    return { resumed: true, contextLine: false, state,
      refusal: `OOO resume: the ledger shows Touch ${state.ledgerLastStep} sent but the row says step ${state.cellStep}` };
  }
  if (step !== undefined && Number(step) !== state.nextStep) {
    return { resumed: true, contextLine: false, state,
      refusal: `OOO resume: the next unsent touch is ${state.nextStep}, not ${step}` };
  }
  return { resumed: true, contextLine: state.subtype === 'out_of_office', refusal: null, state };
}

module.exports = {
  OOO_RESUME_EVENT, OOO_RESUME_SOURCE, AUTHORITATIVE_RESUME_SOURCES, MAX_RESUME_HORIZON_DAYS, OOO_PAUSE_STATUS,
  OOO_DEFAULT_RETRY_DAYS, GENERIC_AUTORESPONDER, isGenericAutoresponder,
  planOooResume, buildOooResumeEvent, scheduledOooResume, ignoredPolicyResume, oooResumeEventId,
  oooPauseState, oooResumeCopy, statedReturnDay, parseMetadata,
};
