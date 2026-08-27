'use strict';
/**
 * pipeline-state.js — derived pipeline state. READ-ONLY BY CONSTRUCTION.
 * ─────────────────────────────────────────────────────────────────────────────
 * Every function here is pure: no sheets client, no network, no writes. It
 * cannot send an email or move a lead, and that is the point — the audit needed
 * a place to answer "what happens next, and when?" without going anywhere near
 * outreach-agent.js, which is protected production sending infrastructure.
 *
 * THE ARCHITECTURAL FACT THIS MODULE EXISTS TO EXPOSE
 * ---------------------------------------------------
 * A lead has TWO records:
 *   - Leads      : the CRM board. Its `stage` is what a human drags around.
 *   - ColdEmail  : the sending engine. Its `emailStatus` is what actually gates
 *                  outbound (see selectQueued / selectFollowUps).
 *
 * Nothing in the board write path touches ColdEmail. So the board stage and the
 * automation state are INDEPENDENT: a lead can sit in "Call Booked" on the board
 * while its cold sequence keeps firing. deriveAutomationState() reads the twin
 * that actually decides, so the UI can show the truth rather than the stage.
 *
 * Nothing here changes sending behaviour. It only describes it.
 */

const { displayStageFor } = require('./cold-call-pipeline');
// The reply buckets come from the analytics module that already owns them —
// Next Action must never classify a reply a second way.
const { ANALYTICS_CATEGORY, categoriesFromNotes, classificationFromLead } = require('./reply-analytics');

// ── AUTOMATION STATE ────────────────────────────────────────────────────────
// Derived from the ColdEmail twin, because emailStatus — not stage — is what
// every selector in outreach-agent.js actually gates on.
const AUTOMATION_STATES = Object.freeze({
  NEVER: 'never',        // no sending record; nothing scheduled
  ACTIVE: 'active',      // a sequence is live and WILL send again
  STOPPED: 'stopped',    // terminal; no further automated send
  SCHEDULED: 'scheduled',// held, but a reactivation time is set and still future
  UNKNOWN: 'unknown',    // no ColdEmail twin — board-only lead
});

// Notes tags that outreach-agent.js treats as hard suppression. Mirrored (not
// imported) because requiring the agent would execute its run() on import.
// Kept in sync deliberately: see SUPPRESSION_TAGS in outreach-agent.js.
const SUPPRESSION_NOTE_TAGS = Object.freeze(['[REPLY: Unsubscribed]', '[BOUNCED']);

// A human took over. Written into ColdEmail notes by PUT /api/leads/:id when a
// lead enters a human-owned stage, and listed in SUPPRESSION_TAGS in
// outreach-agent.js — so it genuinely stops every send loop.
//
// Kept OUT of SUPPRESSION_NOTE_TAGS above on purpose: those are opt-out and
// bounce, which must never be reversed. A hold is a pause a human chose, so it
// must not permanently disqualify a lead from being reopened.
const MANUAL_HOLD_TAG = '[MANUAL HOLD]';

// The send-time suppression tags, in priority order. The permanent ones come
// FIRST so a lead that is both opted out and scheduled to reactivate reports
// the opt-out and stays blocked.
const SEND_SUPPRESSION_TAGS = Object.freeze([...SUPPRESSION_NOTE_TAGS, MANUAL_HOLD_TAG]);

/**
 * Why this lead may not be cold-emailed, or null if it may.
 *
 * THE single definition, shared by the sender and by the health checker. It
 * used to live only inside outreach-agent.js, which exports nothing, so any
 * other component wanting to reason about eligibility had to reimplement it —
 * and a health check that disagrees with the sender is worse than no health
 * check, because it reports green while the sender does something else.
 *
 * The global suppression list is injected rather than imported: it is runtime
 * state loaded from a sheet, and this module stays pure.
 */
function sendSuppressionReason(lead = {}, { suppressedEmails = new Set() } = {}) {
  const notes = lead.notes || '';
  for (const tag of SEND_SUPPRESSION_TAGS) {
    if (!notes.includes(tag)) continue;
    // A scheduled reactivation releases the REVERSIBLE manual hold, and only
    // once its resume instant has passed. The hold tag itself is never removed,
    // so this is the single point where a lead stops being held — and it fails
    // closed: no resume tag, an unparseable one, or a future one all keep the
    // lead suppressed. Opt-out and bounce are permanent and never released.
    if (tag === MANUAL_HOLD_TAG && manualHoldReleased(notes)) continue;
    return tag;
  }
  const email = String(lead.email || '').trim().toLowerCase();
  if (email && suppressedEmails.has(email)) return 'suppression-list';
  return null;
}

function noteHas(notes, tag) {
  return String(notes || '').includes(tag);
}

/** Is this lead already on manual hold? */
function hasManualHold(notes) {
  return noteHas(notes, MANUAL_HOLD_TAG);
}

/**
 * Idempotent hold application. Returns the notes unchanged when the tag is
 * already present — which is what stops a re-saved card from writing the sheet
 * again and stacking a second automation_held event.
 */
function applyHoldToNotes(notes) {
  const existing = String(notes || '');
  if (hasManualHold(existing)) return existing;
  return existing ? MANUAL_HOLD_TAG + ' ' + existing : MANUAL_HOLD_TAG;
}

// ── SCHEDULED REACTIVATION ──────────────────────────────────────────────────
// Removing [MANUAL HOLD] by hand is dangerous: selectFollowUps() in the agent
// asks only "has delayDays elapsed since lastEmailedAt?", so a lead held for 14
// days with a 3-day step-2 delay is ALREADY overdue the instant the tag goes.
// It would send on the very next pass.
//
// So reactivation never removes the hold. It adds a second tag beside it:
//
//   [MANUAL HOLD]                          → held indefinitely (unchanged)
//   [MANUAL HOLD] [RESUME: <ISO8601>]      → automation eligible from that time
//
// The hold tag stays put forever. suppressionReason() keeps returning it until
// the resume time passes, and only then steps aside and lets the ordinary
// cadence / cap / suppression checks decide. That is what makes the whole
// operation a SINGLE cell write which, on its own, cannot enable an immediate
// send — there is no window in which the lead is unheld and ungated.
const RESUME_TAG_RE = /\[RESUME:\s*([^\]]+)\]/i;

/** The scheduled resume instant in ms, or null when none is set/parseable. */
function resumeAtFromNotes(notes) {
  const match = RESUME_TAG_RE.exec(String(notes || ''));
  if (!match) return null;
  const ms = new Date(match[1].trim()).getTime();
  return Number.isFinite(ms) ? ms : null;   // unparseable reads as "no resume"
}

/**
 * Has a manual hold been released by a scheduled reactivation whose time has
 * arrived? Fail-closed: no tag, an unparseable tag, or a future time all mean
 * "still held".
 */
function manualHoldReleased(notes, now = Date.now()) {
  const resumeAt = resumeAtFromNotes(notes);
  if (resumeAt === null) return false;
  return new Date(now).getTime() >= resumeAt;
}

/** Idempotent: scheduling twice writes the same notes the second time. */
function applyResumeToNotes(notes, resumeAtIso) {
  const iso = new Date(resumeAtIso).toISOString();
  const tag = '[RESUME: ' + iso + ']';
  const existing = String(notes || '');
  // Test for the tag rather than comparing before/after: rescheduling to the
  // SAME instant produces an identical string, and treating that as "no tag
  // present" would append a second one.
  if (RESUME_TAG_RE.test(existing)) return existing.replace(RESUME_TAG_RE, tag);
  return existing ? tag + ' ' + existing : tag;
}

/** Cancelling only ever REDUCES eligibility: the hold tag is left untouched. */
function clearResumeFromNotes(notes) {
  return String(notes || '').replace(RESUME_TAG_RE, '').replace(/\s{2,}/g, ' ').trim();
}

const REACTIVATION_MODES = Object.freeze({
  KEEP_MANUAL: 'keep_manual',   // reopen for human work; automation stays held
  SCHEDULE: 'schedule',         // automation may resume at a chosen time
  CANCEL: 'cancel',             // drop a scheduled resume, back to indefinite
});

/**
 * Can this ColdEmail row be reactivated, and how? Extends the shared model that
 * deriveAutomationState() and reopenEligibility() already use — there is no
 * second eligibility system.
 *
 * @param twin           a ColdEmail row
 * @param opts.suppressedEmails durable Suppression-tab addresses
 * @param opts.stepCount how many follow-up steps the sequence actually has
 */
function reactivationEligibility(twin, opts = {}) {
  const row = twin || {};
  const notes = String(row.notes || '');
  const now = opts.now ? new Date(opts.now).getTime() : Date.now();
  const stepCount = Number.isFinite(opts.stepCount) ? opts.stepCount : FOLLOW_UP_DELAY_DAYS.length;
  const suppressedEmails = opts.suppressedEmails || new Set();

  const deny = (blocked, reason) => ({
    eligible: false, blocked, reason, state: blocked,
    canKeepManual: false, canSchedule: false, canCancel: false,
    resumeAt: null, nextStep: null,
  });

  if (!twin) return deny('unknown', 'no ColdEmail record is linked to this lead');

  // Permanent suppression always wins — over a manual hold, over a recoverable
  // loss outcome, over a late positive reply. It is never reactivatable here.
  for (const tag of SUPPRESSION_NOTE_TAGS) {
    if (noteHas(notes, tag)) return deny('suppressed', 'permanently suppressed (' + tag + ')');
  }
  if (suppressedEmails.has(String(row.email || '').trim().toLowerCase())) {
    return deny('suppressed', 'on the durable suppression list — opt-out survives row deletion');
  }

  if (!hasManualHold(notes)) {
    return deny('not_held', 'this lead is not on manual hold, so there is nothing to reactivate');
  }

  const resumeAt = resumeAtFromNotes(notes);
  const step = parseInt(row.emailStep || '0', 10);
  const status = String(row.emailStatus || '').trim().toLowerCase();
  // The step the sequence would send next. emailStep already records the last
  // step that actually went out, so resuming needs no step rewrite at all —
  // which is precisely why nothing here resets to step 1 or repeats a step.
  const nextStep = status === 'emailed' && step >= 1 && step <= stepCount ? step + 1 : null;
  const sequenceComplete = status === 'emailed' && step > stepCount;

  // Reopening for human work is always safe: it touches no ColdEmail state.
  const base = {
    eligible: true,
    blocked: null,
    canKeepManual: true,
    canCancel: resumeAt !== null,
    resumeAt: resumeAt === null ? null : new Date(resumeAt).toISOString(),
    nextStep,
  };

  if (nextStep === null) {
    // No further automated step exists. Human reopen stays available; automated
    // resume does not, and no step is invented to make it possible.
    return {
      ...base,
      canSchedule: false,
      state: resumeAt !== null ? 'scheduled' : 'held',
      reason: sequenceComplete || status === 'done'
        ? 'the sequence has already run every step — automated resume needs a recovery sequence that does not exist yet'
        : 'this lead has no sent step to resume from',
    };
  }

  return {
    ...base,
    canSchedule: true,
    state: resumeAt !== null ? 'scheduled' : 'held',
    reason: resumeAt !== null
      ? 'automation is scheduled to resume at ' + new Date(resumeAt).toISOString()
      : 'on manual hold; step ' + nextStep + ' can be scheduled to resume',
  };
}

/**
 * Does entering this stage mean a human owns the lead, and therefore that
 * automated follow-up must stop? Driven off HUMAN_OWNED_STAGES so a stage added
 * to the canonical list later cannot silently miss the hold.
 */
function stageRequiresHold(stage) {
  return HUMAN_OWNED_STAGES.includes(displayStageFor(stage));
}

/**
 * What will the sending agent do with this lead next?
 * @param twin a ColdEmail row ({ emailStatus, emailStep, lastEmailedAt, notes, stage })
 */
// `now` is injectable so the whole engine can be evaluated at a fixed instant;
// without it the scheduled-resume comparison would silently use the wall clock
// even when the caller asked for a different moment.
function deriveAutomationState(twin, now = Date.now()) {
  if (!twin) return { state: AUTOMATION_STATES.UNKNOWN, reason: 'no ColdEmail record linked to this lead' };

  const notes = twin.notes || '';
  for (const tag of SUPPRESSION_NOTE_TAGS) {
    if (noteHas(notes, tag)) return { state: AUTOMATION_STATES.STOPPED, reason: 'suppressed (' + tag + ')' };
  }
  if (noteHas(notes, MANUAL_HOLD_TAG)) {
    // Enforced: suppressionReason() in outreach-agent.js reads this tag before
    // every send, so the sequence really is stopped. A scheduled reactivation
    // does not remove the tag — it adds a time gate the agent honours, so the
    // lead stays STOPPED right up until that instant.
    const resumeAt = resumeAtFromNotes(notes);
    if (resumeAt !== null) {
      const iso = new Date(resumeAt).toISOString();
      return manualHoldReleased(notes, now)
        ? { state: AUTOMATION_STATES.ACTIVE, reason: 'scheduled reactivation reached (' + iso + ') — normal send checks now apply', resumeAt: iso }
        : { state: AUTOMATION_STATES.SCHEDULED, reason: 'held until the scheduled reactivation at ' + iso, resumeAt: iso };
    }
    return { state: AUTOMATION_STATES.STOPPED, reason: 'on manual hold — a human owns this lead' };
  }

  const status = String(twin.emailStatus || '').trim().toLowerCase();
  if (status === 'replied') return { state: AUTOMATION_STATES.STOPPED, reason: 'lead replied — sequence halted' };
  if (status === 'done')    return { state: AUTOMATION_STATES.STOPPED, reason: 'sequence complete or terminal reply' };
  if (status === 'emailed') {
    const step = parseInt(twin.emailStep || '0', 10);
    return step >= 1 && step <= FOLLOW_UP_DELAY_DAYS.length
      ? { state: AUTOMATION_STATES.ACTIVE, reason: 'cold sequence live at step ' + step }
      : { state: AUTOMATION_STATES.STOPPED, reason: 'sequence exhausted' };
  }
  if (status === '') {
    return String(twin.stage || '').trim().toLowerCase() === 'queued'
      ? { state: AUTOMATION_STATES.ACTIVE, reason: 'queued for first send' }
      : { state: AUTOMATION_STATES.NEVER, reason: 'never contacted' };
  }
  return { state: AUTOMATION_STATES.UNKNOWN, reason: 'unrecognised emailStatus "' + status + '"' };
}

// Board stages that mean a human has committed to this lead. Automation running
// underneath any of these is the leak the audit was looking for.
const HUMAN_OWNED_STAGES = Object.freeze(['hot', 'call_booked', 'closed_won', 'closed_lost']);

/**
 * The P0 check: is a human-owned lead still being mailed by the machine?
 * Returns null when there is no conflict.
 */
function automationConflict(boardLead, twin) {
  const stage = displayStageFor(boardLead && boardLead.stage);
  if (!HUMAN_OWNED_STAGES.includes(stage)) return null;
  const derived = deriveAutomationState(twin);
  if (derived.state !== AUTOMATION_STATES.ACTIVE) return null;
  return {
    stage,
    state: derived.state,
    reason: derived.reason,
    message: 'Lead is in "' + stage + '" but automation is still active (' + derived.reason + ').',
  };
}

// ── NEXT ACTION ─────────────────────────────────────────────────────────────
// The CRM already has a next-action DATE: Leads column O (`followup`). It has
// never had a next-action *description*, so an active lead could sit with no
// defined next step. This derives one; it never invents a date it cannot
// justify, and returns dueAt:null rather than guessing.
// ── THE NEXT ACTION ENGINE ──────────────────────────────────────────────────
// One canonical answer to "what happens next, when, who owns it, and is it
// due?" for every lead. Derived from state the CRM already holds:
//
//   board stage + ColdEmail twin + reply category + activity + meeting
//     → { type, label, dueAt, owner, status, reason, source }
//
// Nothing here writes, sends, moves a lead, or clears a hold. It only reads.

const ACTION_OWNER = Object.freeze({
  AUTOMATION: 'automation', // the sending agent will do this unattended
  HUMAN:      'human',      // you have to do this
  MEETING:    'meeting',    // a calendar event does this
  WAITING:    'waiting',    // legitimately nobody's move — the prospect's
  NONE:       'none',       // terminal
});

const ACTION_STATUS = Object.freeze({
  UPCOMING:  'upcoming',
  DUE_TODAY: 'due_today',
  OVERDUE:   'overdue',
  WAITING:   'waiting',
  BLOCKED:   'blocked',   // the action cannot safely happen (e.g. hold vs board)
  NONE:      'none',      // terminal lead, legitimately nothing to do
});

const ACTION_TYPE = Object.freeze({
  AUTOMATED_FIRST_SEND:  'automated_first_send',
  AUTOMATED_FOLLOW_UP:   'automated_follow_up',
  RESPOND_REPLY:         'respond_reply',
  REVIEW_REPLY:          'review_reply',
  REVIEW_UNCLASSIFIED:   'review_unclassified_reply',
  RESPOND_LATE_REPLY:    'respond_late_reply',
  REVIEW_LATE_REPLY:     'review_late_reply',
  WAITING_PROSPECT:      'waiting_prospect',
  SALES_CALL:            'sales_call',
  CONFIRM_MEETING:       'confirm_meeting_time',
  RECORD_CALL_OUTCOME:   'record_call_outcome',
  CLOSE_OUT_CALL:        'close_out_call',
  MANUAL_FOLLOW_UP:      'manual_follow_up',
  BLOCKED_BY_HOLD:       'blocked_by_hold',
  AUTOMATION_RESUMES:    'automation_resumes',
  HOT_FOLLOW_UP:         'hot_follow_up',
  HOT_REVIEW:            'hot_review',
  CALL_CANCELLED_REVIEW: 'call_cancelled_review',
  NO_SHOW_FOLLOW_UP:     'no_show_follow_up',
  SEQUENCE_STEP:         'sequence_step',
  SEQUENCE_REVIEW:       'sequence_review',
  NONE_WON:              'none_won',
  NONE_LOST:             'none_lost',
  NO_NEXT_ACTION:        'no_next_action',
});

// The CRM's business calendar. Every "is it due today?" question is answered on
// this calendar, never on UTC — an evening action would otherwise read as
// tomorrow. Mirrors the convention already used by the digest and the agent.
const BUSINESS_TIMEZONE = 'America/Vancouver';

function businessDay(value = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-CA', { timeZone: BUSINESS_TIMEZONE });
}

/** Compare a due date to now on the business calendar, not on UTC. */
function deriveActionStatus(dueAt, now = new Date()) {
  if (!dueAt) return null;
  const due = businessDay(dueAt);
  const today = businessDay(now);
  if (!due || !today) return null;
  if (due < today) return ACTION_STATUS.OVERDUE;
  if (due === today) return ACTION_STATUS.DUE_TODAY;
  return ACTION_STATUS.UPCOMING;
}

// Sequence cadence. Mirrors FOLLOW_UP_SEQUENCE in outreach-agent.js rather
// than importing it, because requiring the agent would execute its run().
const FOLLOW_UP_DELAY_DAYS = Object.freeze([3, 5]);

function addDays(iso, days) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return new Date(t + days * 86400000).toISOString();
}

// Activity event types that represent an inbound reply, and the ones that
// represent us having already answered. Mirrors the recorded event vocabulary.
const REPLY_EVENTS = Object.freeze([
  'positive_reply', 'meeting_requested', 'late_reply', 'question_reply',
  'negative_reply', 'unsubscribe_reply', 'wrong_person_reply', 'needs_human_reply',
]);
const HUMAN_TOUCH_EVENTS = Object.freeze(['human_response_sent', 'conversation_note', 'call_booked']);

function latestEventAt(activities, types) {
  let latest = '';
  for (const row of activities || []) {
    if (!types.includes(String(row.eventType || ''))) continue;
    const at = String(row.occurredAt || '');
    if (at > latest) latest = at;
  }
  return latest || null;
}

/**
 * Is there real evidence of an inbound reply? A bare emailStatus of 'replied'
 * with no tag and no activity is NOT evidence — it tells us a reply happened
 * but nothing about what it said, so it must not drive an action.
 */
function replyEvidence(twin, activities) {
  const notes = String((twin && twin.notes) || '');
  const tagged = categoriesFromNotes(notes).length > 0;
  const replyAt = latestEventAt(activities, REPLY_EVENTS);
  if (!tagged && !replyAt) return null;
  const late = /\[LATE REPLY:/i.test(notes)
    || (activities || []).some(row => String(row.eventType || '') === 'late_reply');
  return {
    category: classificationFromLead(twin || {}, []),
    occurredAt: replyAt,
    late,
    answeredAt: latestEventAt(activities, HUMAN_TOUCH_EVENTS),
  };
}

// ── HOT LEAD STALENESS ──────────────────────────────────────────────────────
// A Hot lead is a live human sales conversation, and until now nothing aged it.
// deriveNextAction() returned WAITING_PROSPECT with dueAt:null, which resolves
// to status 'waiting' — a bucket the work queues rank BELOW upcoming and never
// escalate. So a Hot lead whose prospect went quiet sat in "waiting" forever and
// never surfaced anywhere. That is the rot this model fixes.
//
// Nothing here sends, schedules a send, moves a stage, or decides an outcome.
// It answers one question: whose move is it, and by when.

// Every threshold in one place. These are CRM action deadlines for a human,
// deliberately NOT reusing FOLLOW_UP_DELAY_DAYS — that is cold-email cadence
// mirroring FOLLOW_UP_SEQUENCE, and conflating the two would tie a sales
// conversation timer to the sending schedule.
const HOT_FOLLOW_UP = Object.freeze({
  WAITING_ON_PROSPECT_BUSINESS_DAYS: 2, // they owe us a reply; chase after 2
  STALE_DAYS_PAST_DUE: 7,               // substantially overdue
  SEVERELY_STALE_DAYS_PAST_DUE: 21,     // clearly abandoned unless handled
});

const WAITING_ON = Object.freeze({
  US: 'waiting_on_us',
  PROSPECT: 'waiting_on_prospect',
  MEETING: 'meeting_scheduled',
  UNKNOWN: 'unknown',          // evidence is insufficient — never guessed
});

const HOT_STALENESS = Object.freeze({
  ACTIVE: 'active',
  FOLLOW_UP_DUE: 'follow_up_due',
  OVERDUE: 'overdue',
  STALE: 'stale',
  SEVERELY_STALE: 'severely_stale',
  UNKNOWN: 'unknown',
});

// What counts as a real sales interaction. An open, a warm signal, a demo view
// or an automated cold send prove nothing about the conversation, so none of
// them appear here and none of them reset the timer.
const MEANINGFUL_INBOUND_EVENTS = Object.freeze(
  REPLY_EVENTS.filter(type => type !== 'unsubscribe_reply'));
const MEANINGFUL_HUMAN_EVENTS = Object.freeze([
  'human_response_sent',   // we answered them — recorded, never sent from here
  'conversation_note',     // a human wrote up the conversation
  'call_booked',
  'meeting_rescheduled',
]);

// A bare YYYY-MM-DD (what the follow-up field holds) is ALREADY a calendar day.
// Running it through businessDay() would parse it as UTC midnight and then shift
// it back a day in Vancouver, making a date that is due today read as overdue.
// Only real timestamps need converting.
function calendarDayOf(value) {
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return businessDay(raw);
}

/** Vancouver-calendar business days, skipping Sat/Sun. Never invents a date. */
function addBusinessDays(iso, days) {
  const start = new Date(iso).getTime();
  if (!Number.isFinite(start)) return null;
  const cursor = new Date(start);
  let remaining = Math.max(0, days);
  while (remaining > 0) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    // Weekend is judged on the business calendar, not on UTC.
    const weekday = new Date(cursor).toLocaleDateString('en-US', { timeZone: BUSINESS_TIMEZONE, weekday: 'short' });
    if (weekday !== 'Sat' && weekday !== 'Sun') remaining--;
  }
  return cursor.toISOString();
}

/**
 * The most recent MEANINGFUL interaction on this opportunity, in each
 * direction. Reads the canonical activity records — it builds no second
 * timeline and stores nothing.
 */
function lastMeaningfulInteraction(activities = []) {
  const inboundAt = latestEventAt(activities, MEANINGFUL_INBOUND_EVENTS);
  const humanAt = latestEventAt(activities, MEANINGFUL_HUMAN_EVENTS);
  const candidates = [inboundAt, humanAt].filter(Boolean).sort();
  return {
    inboundAt,
    humanAt,
    at: candidates.length ? candidates[candidates.length - 1] : null,
    direction: !candidates.length ? null
      : (humanAt && (!inboundAt || humanAt >= inboundAt)) ? 'outbound' : 'inbound',
  };
}

/**
 * Whose move is it, when is the follow-up due, and how stale is it?
 *
 * @param boardLead  a Leads row (stage, followup, meetingAt, outcome)
 * @param context    { activities, now }
 * @returns { waitingOn, dueAt, staleness, daysPastDue, source, lastInteractionAt,
 *            hasConversationEvidence, reason }
 */
function deriveHotState(boardLead, context = {}) {
  const lead = boardLead || {};
  const now = context.now || new Date();
  const activities = context.activities || [];
  const interaction = lastMeaningfulInteraction(activities);
  const manualDate = String(lead.followup || '').trim();

  // A booked meeting outranks any follow-up timer — the next move is the call.
  const meetingAt = String(lead.meetingAt || '').trim();
  const meetingMs = meetingAt ? new Date(meetingAt).getTime() : NaN;
  if (Number.isFinite(meetingMs) && meetingMs >= new Date(now).getTime()) {
    return {
      waitingOn: WAITING_ON.MEETING, dueAt: meetingAt, staleness: HOT_STALENESS.ACTIVE,
      daysPastDue: 0, source: 'meeting', lastInteractionAt: interaction.at,
      hasConversationEvidence: Boolean(interaction.at),
      reason: 'a meeting is booked; the call is the next move',
    };
  }

  let waitingOn = WAITING_ON.UNKNOWN;
  let dueAt = null;
  let source = 'none';
  let reason = '';

  if (interaction.inboundAt && (!interaction.humanAt || interaction.inboundAt > interaction.humanAt)) {
    // They spoke last. We owe them a reply, so it is due the day it arrived.
    waitingOn = WAITING_ON.US;
    dueAt = interaction.inboundAt;
    source = 'activity';
    reason = 'they replied ' + businessDay(interaction.inboundAt) + ' and we have not answered';
  } else if (interaction.humanAt) {
    // We spoke last. Give them a working window before chasing.
    waitingOn = WAITING_ON.PROSPECT;
    dueAt = addBusinessDays(interaction.humanAt, HOT_FOLLOW_UP.WAITING_ON_PROSPECT_BUSINESS_DAYS);
    source = 'activity';
    reason = 'we responded ' + businessDay(interaction.humanAt) + '; chase after '
      + HOT_FOLLOW_UP.WAITING_ON_PROSPECT_BUSINESS_DAYS + ' business days';
  }

  // An explicit human date always wins over a derived one — the person who set
  // it knows something the activity log does not. It can also supply a date
  // when there is no conversation evidence at all, which is the only honest way
  // to age a lead that predates the activity timeline.
  if (manualDate) {
    dueAt = manualDate;
    source = 'followup-field';
    reason = reason
      ? reason + '; overridden by the follow-up date set by hand'
      : 'follow-up date set by hand';
    if (waitingOn === WAITING_ON.UNKNOWN) waitingOn = WAITING_ON.PROSPECT;
  }

  if (!dueAt) {
    // No conversation evidence and no human date. Refuse to invent an age.
    return {
      waitingOn: WAITING_ON.UNKNOWN, dueAt: null, staleness: HOT_STALENESS.UNKNOWN,
      daysPastDue: null, source: 'none', lastInteractionAt: interaction.at,
      hasConversationEvidence: false,
      reason: 'no dated conversation and no follow-up date — the age of this opportunity cannot be proven',
    };
  }

  const dueDay = calendarDayOf(dueAt);
  const today = businessDay(now);
  let staleness = HOT_STALENESS.ACTIVE;
  let daysPastDue = 0;
  if (dueDay && today) {
    const dayMs = 86400000;
    daysPastDue = Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(dueDay + 'T00:00:00Z')) / dayMs);
    if (daysPastDue < 0) staleness = HOT_STALENESS.ACTIVE;
    else if (daysPastDue === 0) staleness = HOT_STALENESS.FOLLOW_UP_DUE;
    else if (daysPastDue >= HOT_FOLLOW_UP.SEVERELY_STALE_DAYS_PAST_DUE) staleness = HOT_STALENESS.SEVERELY_STALE;
    else if (daysPastDue >= HOT_FOLLOW_UP.STALE_DAYS_PAST_DUE) staleness = HOT_STALENESS.STALE;
    else staleness = HOT_STALENESS.OVERDUE;
  }

  return {
    waitingOn, dueAt, staleness, daysPastDue: Math.max(0, daysPastDue), source,
    lastInteractionAt: interaction.at,
    hasConversationEvidence: Boolean(interaction.at),
    reason,
  };
}

// ── CALL LIFECYCLE ──────────────────────────────────────────────────────────
// A booked call had exactly two derived states: in the future it was a Sales
// call, in the past it was "Record call outcome". Nothing could say whether the
// meeting HAPPENED. Worse, the only place to record that was the `outcome`
// column — which is the SALES outcome, and whose taxonomy lists no_show as a
// LOSS. Recording "they did not attend" therefore made the opportunity eligible
// for Closed Lost, conflating a missed meeting with a dead deal.
//
// So meeting outcome and sales outcome are kept apart on purpose:
//   meeting outcome  -> canonical ACTIVITY events (here)
//   sales outcome    -> the `outcome` column, unchanged
//
// The lifecycle is DERIVED from activity history plus the current meetingAt.
// No new sheet column: the events are the record, and meetingAt is the current
// booking. Nothing here writes, sends, or decides a sales outcome.

const CALL_STATUS = Object.freeze({
  NONE: 'none',                       // no meeting has ever been booked
  SCHEDULED: 'scheduled',             // a future booking stands
  RESCHEDULED: 'rescheduled',         // moved at least once; still a live booking
  CANCELLED: 'cancelled',             // retired; NOT a lost opportunity
  COMPLETED: 'completed',             // the call happened; NOT a won deal
  NO_SHOW: 'no_show',                 // explicitly recorded by a human
  OUTCOME_PENDING: 'outcome_pending', // the time passed and nobody said what happened
});

// Ordered oldest-first when walked. call_booked / meeting_rescheduled already
// existed and are reused; the two resolution events are new.
const CALL_BOOKING_EVENTS = Object.freeze(['call_booked', 'meeting_rescheduled']);
const CALL_RESOLUTION_EVENTS = Object.freeze(['meeting_cancelled', 'meeting_completed', 'meeting_no_show']);
const CALL_EVENTS = Object.freeze([...CALL_BOOKING_EVENTS, ...CALL_RESOLUTION_EVENTS]);

const CALL_RESOLUTION_STATUS = Object.freeze({
  meeting_cancelled: CALL_STATUS.CANCELLED,
  meeting_completed: CALL_STATUS.COMPLETED,
  meeting_no_show: CALL_STATUS.NO_SHOW,
});

function callEventMetadata(row) {
  try { return JSON.parse(row.metadata || '{}'); } catch (_) { return {}; }
}

/**
 * The current state of the booked call.
 *
 * A meeting OCCURRENCE is identified by its meetingAt instant: a resolution
 * event carries the occurrence it resolved, so cancelling meeting #1 can never
 * leak onto meeting #2 booked afterwards.
 *
 * @param boardLead a Leads row ({ meetingAt, outcome, ... })
 * @param context   { activities, now }
 * @returns { status, meetingAt, previousMeetingAt, resolvedAt, resolvedOccurrenceAt,
 *            rescheduleCount, salesOutcome, needsResolution, reason }
 */
function deriveCallLifecycle(boardLead, context = {}) {
  const lead = boardLead || {};
  const now = new Date(context.now || Date.now()).getTime();
  const meetingAt = String(lead.meetingAt || '').trim();
  const meetingMs = meetingAt ? new Date(meetingAt).getTime() : NaN;
  const salesOutcome = String(lead.outcome || '').trim();

  const events = (context.activities || [])
    .filter(row => CALL_EVENTS.includes(String(row.eventType || '')))
    .slice()
    .sort((a, b) => String(a.occurredAt || '').localeCompare(String(b.occurredAt || '')));

  // Walk the history forward, tracking which occurrence is live and how it was
  // last resolved. A later booking always supersedes an earlier resolution.
  let occurrenceAt = '';
  let previousMeetingAt = '';
  let rescheduleCount = 0;
  let resolution = null;
  for (const row of events) {
    const type = String(row.eventType || '');
    const metadata = callEventMetadata(row);
    if (CALL_BOOKING_EVENTS.includes(type)) {
      if (type === 'meeting_rescheduled') {
        rescheduleCount++;
        previousMeetingAt = String(metadata.previousMeetingAt || occurrenceAt || '');
      }
      occurrenceAt = String(metadata.meetingAt || occurrenceAt || '');
      resolution = null;             // a new/moved booking reopens the call
      continue;
    }
    resolution = {
      status: CALL_RESOLUTION_STATUS[type],
      at: String(row.occurredAt || ''),
      occurrenceAt: String(metadata.meetingAt || metadata.previousMeetingAt || occurrenceAt || ''),
    };
  }

  const base = {
    meetingAt, previousMeetingAt, rescheduleCount, salesOutcome,
    resolvedAt: resolution ? resolution.at : null,
    resolvedOccurrenceAt: resolution ? resolution.occurrenceAt : null,
  };

  // A resolution only stands while it describes the CURRENT booking. Booking a
  // new time after a cancellation or a no-show supersedes it.
  const resolutionApplies = Boolean(resolution)
    && (!meetingAt || !resolution.occurrenceAt || resolution.occurrenceAt === meetingAt);

  if (resolutionApplies) {
    return {
      ...base, status: resolution.status,
      needsResolution: false,
      reason: resolution.status === CALL_STATUS.CANCELLED
        ? 'the booked call was cancelled — the opportunity is not closed by this'
        : resolution.status === CALL_STATUS.COMPLETED
          ? 'the call happened — this says nothing about whether the deal is won'
          : 'the prospect did not attend — recorded by hand, and recoverable',
    };
  }

  if (!meetingAt || !Number.isFinite(meetingMs)) {
    return { ...base, status: CALL_STATUS.NONE, needsResolution: false,
      reason: meetingAt ? 'the stored meeting time cannot be read' : 'no meeting has been booked' };
  }

  if (meetingMs >= now) {
    return {
      ...base,
      status: rescheduleCount > 0 ? CALL_STATUS.RESCHEDULED : CALL_STATUS.SCHEDULED,
      needsResolution: false,
      reason: rescheduleCount > 0
        ? 'moved ' + rescheduleCount + ' time(s); the current booking stands'
        : 'a future booking stands',
    };
  }

  // The time passed and nobody said what happened. The system deliberately does
  // NOT guess completed, cancelled or no-show from elapsed time alone.
  return {
    ...base, status: CALL_STATUS.OUTCOME_PENDING, needsResolution: true,
    reason: 'the meeting time passed with no recorded result — a human has to say what happened',
  };
}

/**
 * Which lifecycle actions are legitimate right now. The drawer renders only
 * these, and the server re-derives them before accepting a mutation, so an
 * impossible transition cannot be offered or slipped through.
 */
function callLifecycleActions(lifecycle, now = Date.now()) {
  const state = lifecycle || {};
  const meetingMs = state.meetingAt ? new Date(state.meetingAt).getTime() : NaN;
  const hasBooking = Number.isFinite(meetingMs);
  const passed = hasBooking && meetingMs < new Date(now).getTime();
  const live = [CALL_STATUS.SCHEDULED, CALL_STATUS.RESCHEDULED, CALL_STATUS.OUTCOME_PENDING].includes(state.status);
  return {
    book: !hasBooking || [CALL_STATUS.CANCELLED, CALL_STATUS.COMPLETED, CALL_STATUS.NO_SHOW, CALL_STATUS.NONE].includes(state.status),
    reschedule: live,
    cancel: live,
    // Only a meeting that has actually come and gone can be resolved.
    complete: live && passed,
    no_show: live && passed,
  };
}

function buildAction(fields) {
  const dueAt = fields.dueAt || null;
  const status = fields.status || deriveActionStatus(dueAt, fields.now) || ACTION_STATUS.UPCOMING;
  return {
    type: fields.type,
    // `action` is the original field name and is kept as the label alias so the
    // existing drawer and its tests keep working unchanged.
    action: fields.label,
    label: fields.label,
    dueAt,
    owner: fields.owner,
    status,
    reason: fields.reason || '',
    source: fields.source,
    needsAttention: Boolean(fields.needsAttention),
    recoverable: fields.recoverable || false,
    // Present only for Hot leads; the drawer and card render it directly rather
    // than recomputing any of it in the browser.
    hotState: fields.hotState || null,
    // Likewise for Call Booked leads — the browser derives no lifecycle state.
    callState: fields.callState || null,
    // And for a lead enrolled in a stage recovery journey.
    sequenceState: fields.sequenceState || null,
  };
}

// Maps stage-sequence state onto the existing vocabulary. The engine that
// decides eligibility lives in stage-sequences.js; this only labels it, so
// there is no second task engine.
function sequenceNextAction(lead, context, withManual) {
  const now = context.now || new Date();
  const seq = context.sequenceState || {};
  const label = seq.label || seq.sequenceId || 'stage follow-up';

  if (seq.status === 'active' && !seq.stopReason) {
    const step = (seq.step || 0) + 1;
    return buildAction({
      type: ACTION_TYPE.SEQUENCE_STEP, label: `${label} #${step}`,
      dueAt: seq.nextDueAt || null, owner: ACTION_OWNER.AUTOMATION,
      source: 'stage-sequence', sequenceState: seq, now,
      reason: seq.featureEnabled
        ? (seq.reason || 'scheduled recovery step')
        : (seq.reason || 'scheduled') + ' — stage sending is currently disabled',
    });
  }

  if (seq.status === 'paused') {
    return buildAction({
      type: ACTION_TYPE.SEQUENCE_REVIEW, label: `Review paused ${label}`,
      dueAt: null, owner: ACTION_OWNER.HUMAN, status: ACTION_STATUS.BLOCKED,
      source: 'stage-sequence', sequenceState: seq, needsAttention: true, now,
      reason: seq.stopReason || 'paused by hand',
    });
  }

  if (seq.stopReason) {
    return buildAction({
      type: ACTION_TYPE.SEQUENCE_REVIEW, label: `${label} stopped — decide next step`,
      dueAt: null, owner: ACTION_OWNER.HUMAN, status: ACTION_STATUS.BLOCKED,
      source: 'stage-sequence', sequenceState: seq, needsAttention: true, now,
      reason: seq.stopReason,
    });
  }

  // Complete or cancelled: the journey is over and a human decides what follows.
  return withManual(`${label} finished — decide next step`, ACTION_TYPE.SEQUENCE_REVIEW)
    || buildAction({
      type: ACTION_TYPE.SEQUENCE_REVIEW, label: `${label} finished — decide next step`,
      dueAt: null, owner: ACTION_OWNER.HUMAN, status: ACTION_STATUS.BLOCKED,
      source: 'stage-sequence', sequenceState: seq, needsAttention: true, now,
      reason: 'every step has been sent and the prospect has not replied',
    });
}

// Maps the call lifecycle onto the existing action vocabulary. A meeting result
// never implies a sales result: a completed call still asks for the sales
// outcome, and a no-show or cancellation closes nothing.
function callNextAction(lead, { activities, now }) {
  const call = deriveCallLifecycle(lead, { activities, now });
  const base = { source: 'meeting', reason: call.reason, now, callState: call };
  const manualDate = String(lead.followup || '').trim();

  if (call.status === CALL_STATUS.SCHEDULED || call.status === CALL_STATUS.RESCHEDULED) {
    return buildAction({ ...base, type: ACTION_TYPE.SALES_CALL, label: 'Sales call',
      dueAt: call.meetingAt, owner: ACTION_OWNER.MEETING });
  }

  if (call.status === CALL_STATUS.OUTCOME_PENDING) {
    // The MEETING result is still unknown — callState says so, and the drawer
    // keeps offering the resolution controls. But if the SALES outcome has
    // already been recorded the human has clearly dealt with this, so the next
    // action is to move the card rather than to nag for a second answer.
    if (call.salesOutcome) {
      return buildAction({ ...base, type: ACTION_TYPE.CLOSE_OUT_CALL, label: 'Close out booked call',
        dueAt: call.meetingAt, owner: ACTION_OWNER.HUMAN,
        reason: 'sales outcome "' + call.salesOutcome + '" recorded — move the card to its final stage' });
    }
    return buildAction({ ...base, type: ACTION_TYPE.RECORD_CALL_OUTCOME, label: 'Record call outcome',
      dueAt: call.meetingAt, owner: ACTION_OWNER.HUMAN, status: ACTION_STATUS.OVERDUE, needsAttention: true });
  }

  if (call.status === CALL_STATUS.NO_SHOW) {
    // Recoverable by design: Step 10's recovery sequence reads this state. It
    // does not close the opportunity and it does not resume cold email.
    return buildAction({ ...base, type: ACTION_TYPE.NO_SHOW_FOLLOW_UP, label: 'Follow up after no-show',
      dueAt: call.resolvedAt, owner: ACTION_OWNER.HUMAN, needsAttention: true });
  }

  if (call.status === CALL_STATUS.CANCELLED) {
    return buildAction({ ...base, type: ACTION_TYPE.CALL_CANCELLED_REVIEW,
      label: 'Decide next step after cancelled call',
      dueAt: manualDate || call.resolvedAt, owner: ACTION_OWNER.HUMAN, needsAttention: true });
  }

  if (call.status === CALL_STATUS.COMPLETED) {
    // The call happened. That is a MEETING result; the sales result is still
    // missing until someone records it.
    if (!call.salesOutcome) {
      return buildAction({ ...base, type: ACTION_TYPE.RECORD_CALL_OUTCOME, label: 'Record sales outcome',
        dueAt: call.resolvedAt, owner: ACTION_OWNER.HUMAN, needsAttention: true,
        reason: 'the call happened; the opportunity outcome has not been recorded' });
    }
    return buildAction({ ...base, type: ACTION_TYPE.CLOSE_OUT_CALL, label: 'Close out booked call',
      dueAt: call.resolvedAt, owner: ACTION_OWNER.HUMAN,
      reason: 'sales outcome "' + call.salesOutcome + '" recorded — move the card to its final stage' });
  }

  // Call Booked with nothing booked at all.
  return withManualFollowUp(lead, now)
    || buildAction({ ...base, type: ACTION_TYPE.CONFIRM_MEETING, label: 'Confirm meeting time',
      dueAt: null, owner: ACTION_OWNER.HUMAN, status: ACTION_STATUS.BLOCKED, needsAttention: true,
      reason: 'card is in Call Booked but carries no meeting time' });
}

// Small shared helper so callNextAction can honour an explicit human date the
// same way the rest of the engine does.
function withManualFollowUp(lead, now) {
  const manualDate = String(lead.followup || '').trim();
  if (!manualDate) return null;
  return buildAction({
    type: ACTION_TYPE.CONFIRM_MEETING, label: 'Confirm meeting time', dueAt: manualDate,
    owner: ACTION_OWNER.HUMAN, source: 'followup-field', reason: 'follow-up date set by hand', now,
  });
}

// Maps the Hot state onto the EXISTING action vocabulary. Deliberately small:
// two new types, everything else reuses what the engine already speaks.
function hotNextAction(lead, { activities, now, twin }) {
  const hot = deriveHotState(lead, { activities, now });
  const base = { source: hot.source, reason: hot.reason, now, hotState: hot };

  if (hot.waitingOn === WAITING_ON.MEETING) {
    return buildAction({ ...base, type: ACTION_TYPE.SALES_CALL, label: 'Sales call',
      dueAt: hot.dueAt, owner: ACTION_OWNER.MEETING });
  }

  // Nothing datable. Say so rather than inventing an age or a due date.
  if (hot.staleness === HOT_STALENESS.UNKNOWN) {
    return buildAction({ ...base, type: ACTION_TYPE.HOT_REVIEW, label: 'Review Hot lead',
      dueAt: null, owner: ACTION_OWNER.HUMAN, status: ACTION_STATUS.BLOCKED, needsAttention: true });
  }

  if (hot.waitingOn === WAITING_ON.US) {
    // Reuse the canonical reply category so a question still reads as review
    // work rather than "respond" — the Hot clock changes WHEN, not WHAT.
    const category = twin ? classificationFromLead(twin, []) : null;
    const shape = category === ANALYTICS_CATEGORY.NEEDS_HUMAN
      ? { type: ACTION_TYPE.REVIEW_REPLY, label: 'Review reply' }
      : category === ANALYTICS_CATEGORY.UNCLASSIFIED
        ? { type: ACTION_TYPE.REVIEW_UNCLASSIFIED, label: 'Review unclassified reply',
            reason: hot.reason + '; reply could not be classified — do not guess' }
        : category === ANALYTICS_CATEGORY.POSITIVE
          ? { type: ACTION_TYPE.RESPOND_REPLY, label: 'Respond to positive reply' }
          : { type: ACTION_TYPE.RESPOND_REPLY, label: 'Respond to prospect' };
    return buildAction({ ...base, ...shape, dueAt: hot.dueAt, owner: ACTION_OWNER.HUMAN, needsAttention: true });
  }

  // Waiting on them, and the window has not closed yet: genuinely nobody's move.
  if (hot.staleness === HOT_STALENESS.ACTIVE) {
    return buildAction({ ...base, type: ACTION_TYPE.WAITING_PROSPECT, label: 'Waiting for prospect',
      dueAt: hot.dueAt, owner: ACTION_OWNER.WAITING, status: ACTION_STATUS.WAITING });
  }

  // Due, overdue or stale — this is now a human task with a real deadline, and
  // it escalates through the ordinary status ladder into the work queues.
  const stale = hot.staleness === HOT_STALENESS.STALE || hot.staleness === HOT_STALENESS.SEVERELY_STALE;
  return buildAction({
    ...base, type: ACTION_TYPE.HOT_FOLLOW_UP, owner: ACTION_OWNER.HUMAN, dueAt: hot.dueAt,
    label: stale ? 'Follow up — stale Hot lead' : 'Follow up with prospect',
    needsAttention: stale,
    reason: hot.reason + '; ' + hot.daysPastDue + ' day(s) past due'
      + (stale ? ' — decide whether this is still live (nothing is closed automatically)' : ''),
  });
}

/**
 * The canonical Next Action for one lead.
 *
 * @param boardLead a Leads row ({ stage, followup, meetingAt, outcome, ... })
 * @param twin      the ColdEmail row that actually gates sending
 * @param context   { activities, now } — optional; richer input, better answer
 * @returns { type, action, label, dueAt, owner, status, reason, source,
 *            needsAttention, recoverable }
 */
function deriveNextAction(boardLead, twin, context = {}) {
  const lead = boardLead || {};
  const now = context.now || new Date();
  const activities = context.activities || [];
  const stage = displayStageFor(lead.stage);
  const derived = deriveAutomationState(twin || null, now);
  const manualDate = String(lead.followup || '').trim();

  // A human-set follow-up date is an explicit decision, so it wins wherever the
  // system has no authoritative state of its own to offer.
  const withManual = (label, type = ACTION_TYPE.MANUAL_FOLLOW_UP) => manualDate
    ? buildAction({ type, label, dueAt: manualDate, owner: ACTION_OWNER.HUMAN,
        source: 'followup-field', reason: 'follow-up date set by hand', now })
    : null;

  const nothing = (type, label, reason) => buildAction({
    type, label, dueAt: null, owner: ACTION_OWNER.NONE,
    status: ACTION_STATUS.NONE, source: 'none', reason, now,
  });

  // ── Terminal stages ──────────────────────────────────────────────────────
  if (stage === 'closed_won') {
    return nothing(ACTION_TYPE.NONE_WON, 'None — won', 'deal won; no post-sale action model exists yet');
  }
  if (stage === 'closed_lost') {
    const outcome = String(lead.outcome || '').trim();
    const recoverable = RECOVERABLE_OUTCOME_IDS.includes(outcome);
    const closed = nothing(ACTION_TYPE.NONE_LOST, 'None — closed',
      recoverable
        ? 'outcome "' + outcome + '" is recoverable — eligible for a future recovery sequence'
        : 'closed/lost');
    // Metadata only. No due date and no action: the recovery system does not
    // exist yet, and inventing one here would imply a send that cannot happen.
    closed.recoverable = recoverable;
    return closed;
  }

  // ── An enrolled stage sequence owns the next action ──────────────────────
  // Once a human explicitly hands a recovery journey to automation, that IS what
  // happens next, so this outranks the Hot and Call Booked branches below.
  // Terminal stages still come first: a closed opportunity has no next action,
  // and the engine stops any sequence on one anyway.
  if (context.sequenceState) return sequenceNextAction(lead, context, withManual);

  // ── Call Booked — the call lifecycle is the authority ────────────────────
  if (stage === 'call_booked') return callNextAction(lead, { activities, now });

  // ── Hot — a live human conversation on a clock ───────────────────────────
  // Handled before the generic reply branch: a Hot lead's next move depends on
  // WHO SPOKE LAST and how long ago, which the reply branch cannot see. The
  // reply category is still used to label the action, so a question on a Hot
  // lead still reads "Review reply" rather than "Respond".
  if (stage === 'hot') return hotNextAction(lead, { activities, now, twin });

  // ── Reply-driven human work (applies to any non-terminal stage) ──────────
  const reply = replyEvidence(twin, activities);
  if (reply) {
    // Already answered after the reply landed — the ball is with the prospect.
    if (reply.answeredAt && reply.occurredAt && reply.answeredAt > reply.occurredAt) {
      return buildAction({
        type: ACTION_TYPE.WAITING_PROSPECT, label: 'Waiting for prospect',
        dueAt: manualDate || null, owner: ACTION_OWNER.WAITING,
        status: manualDate ? undefined : ACTION_STATUS.WAITING,
        source: manualDate ? 'followup-field' : 'activity',
        reason: 'replied to on ' + businessDay(reply.answeredAt) + '; awaiting their response', now,
      });
    }
    const dueAt = reply.occurredAt || null;
    const base = {
      dueAt, owner: ACTION_OWNER.HUMAN, source: 'reply-analytics', needsAttention: true, now,
      status: dueAt ? undefined : ACTION_STATUS.DUE_TODAY,
    };
    if (reply.late) {
      // A late reply must never resume the old sequence. This is review work.
      return reply.category === ANALYTICS_CATEGORY.POSITIVE
        ? buildAction({ ...base, type: ACTION_TYPE.RESPOND_LATE_REPLY, label: 'Respond to late positive reply',
            reason: 'positive reply arrived after the sequence ended — automation stays stopped' })
        : buildAction({ ...base, type: ACTION_TYPE.REVIEW_LATE_REPLY, label: 'Review late reply',
            reason: 'reply arrived after the sequence ended — automation stays stopped' });
    }
    if (reply.category === ANALYTICS_CATEGORY.POSITIVE) {
      return buildAction({ ...base, type: ACTION_TYPE.RESPOND_REPLY, label: 'Respond to positive reply',
        reason: 'positive reply awaiting a human response' });
    }
    if (reply.category === ANALYTICS_CATEGORY.NEEDS_HUMAN) {
      return buildAction({ ...base, type: ACTION_TYPE.REVIEW_REPLY, label: 'Review reply',
        reason: 'reply needs a human decision' });
    }
    if (reply.category === ANALYTICS_CATEGORY.UNCLASSIFIED) {
      return buildAction({ ...base, type: ACTION_TYPE.REVIEW_UNCLASSIFIED, label: 'Review unclassified reply',
        reason: 'reply could not be classified — do not guess' });
    }
    // Negative / excluded: the conversation is over, nothing to chase.
    return withManual('Manual follow-up')
      || nothing(ACTION_TYPE.NONE_LOST, 'None — reply closed the conversation',
        'reply classified as negative; no outbound action');
  }

  // ── Follow Up — automation territory ─────────────────────────────────────
  // A hold on a lead the board still treats as automated is a genuine conflict:
  // the sequence would run, but a human stopped it and nothing replaced it.
  // A released reactivation falls through to the ordinary automation path —
  // the lead is no longer held, so its next action is the real next step.
  if (hasManualHold((twin && twin.notes) || '') && !manualHoldReleased((twin && twin.notes) || '', now)) {
    const step = parseInt((twin && twin.emailStep) || '0', 10);
    const wouldSend = String((twin && twin.emailStatus) || '').trim().toLowerCase() === 'emailed'
      && step >= 1 && step <= FOLLOW_UP_DELAY_DAYS.length;
    // A scheduled reactivation is a real, dated, automation-owned next action —
    // not a gap and never overdue, because the hold is doing its job until the
    // resume instant arrives.
    const resumeAt = resumeAtFromNotes((twin && twin.notes) || '');
    if (wouldSend && resumeAt !== null && !manualHoldReleased(twin.notes, now)) {
      return buildAction({
        type: ACTION_TYPE.AUTOMATION_RESUMES, label: 'Automation resumes at step ' + (step + 1),
        dueAt: new Date(resumeAt).toISOString(), owner: ACTION_OWNER.AUTOMATION, source: 'reactivation',
        reason: 'scheduled reactivation; the manual hold keeps the sequence stopped until then', now,
      });
    }
    if (wouldSend) {
      return withManual('Manual follow-up')
        || buildAction({
          type: ACTION_TYPE.BLOCKED_BY_HOLD, label: 'Blocked by manual hold', dueAt: null,
          owner: ACTION_OWNER.HUMAN, status: ACTION_STATUS.BLOCKED, source: 'derived',
          reason: 'the sequence has a step left but ' + MANUAL_HOLD_TAG
            + ' stops it — decide manually; releasing the hold is not automatic',
          needsAttention: true, now,
        });
    }
  }

  if (derived.state === AUTOMATION_STATES.ACTIVE && twin) {
    const step = parseInt(twin.emailStep || '0', 10);
    const delay = FOLLOW_UP_DELAY_DAYS[step - 1];
    if (delay && twin.lastEmailedAt) {
      const dueAt = addDays(twin.lastEmailedAt, delay);
      if (dueAt) {
        return buildAction({
          type: ACTION_TYPE.AUTOMATED_FOLLOW_UP, label: 'Automated follow-up #' + (step + 1),
          dueAt, owner: ACTION_OWNER.AUTOMATION, source: 'derived',
          reason: 'cold sequence step ' + step + ' sent ' + businessDay(twin.lastEmailedAt)
            + '; next step fires ' + delay + ' days later', now,
        });
      }
    }
    if (String(twin.stage || '').toLowerCase() === 'queued') {
      return buildAction({
        type: ACTION_TYPE.AUTOMATED_FIRST_SEND, label: 'Automated first send', dueAt: null,
        owner: ACTION_OWNER.AUTOMATION, status: ACTION_STATUS.UPCOMING, source: 'derived',
        reason: 'queued for its first send on the next agent pass', now,
      });
    }
  }

  return withManual('Manual follow-up')
    || buildAction({
      type: ACTION_TYPE.NO_NEXT_ACTION, label: 'No next action defined', dueAt: null,
      owner: ACTION_OWNER.HUMAN, status: ACTION_STATUS.BLOCKED, source: 'none',
      reason: derived.reason || 'no automation and no follow-up date',
      needsAttention: true, now,
    });
}

// ── WORK QUEUE ──────────────────────────────────────────────────────────────
// Ordering for an action-focused view: most urgent first. The Kanban board's
// own ordering is untouched — this sorts a filtered list, not the columns.
const STATUS_RANK = Object.freeze({
  [ACTION_STATUS.OVERDUE]: 0,
  [ACTION_STATUS.BLOCKED]: 1,
  [ACTION_STATUS.DUE_TODAY]: 2,
  [ACTION_STATUS.UPCOMING]: 3,
  [ACTION_STATUS.WAITING]: 4,
  [ACTION_STATUS.NONE]: 5,
});

function compareNextActions(a, b) {
  const rankA = STATUS_RANK[a && a.status] ?? 9;
  const rankB = STATUS_RANK[b && b.status] ?? 9;
  if (rankA !== rankB) return rankA - rankB;
  // Same urgency: oldest due date first, undated last.
  const dueA = (a && a.dueAt) || '';
  const dueB = (b && b.dueAt) || '';
  if (!dueA && !dueB) return 0;
  if (!dueA) return 1;
  if (!dueB) return -1;
  return dueA.localeCompare(dueB);
}

// A lead needs attention when the CRM cannot say what happens next, or when the
// answer is "something you have already missed". These are the workflow holes.
function summarizeNextActions(entries = []) {
  const summary = {
    total: 0, withAction: 0, dueToday: 0, overdue: 0, upcoming: 0,
    waiting: 0, blocked: 0, noNextAction: 0, terminal: 0,
  };
  for (const entry of entries) {
    const action = (entry && entry.nextAction) || entry;
    if (!action) continue;
    summary.total++;
    if (action.status === ACTION_STATUS.NONE) { summary.terminal++; continue; }
    if (action.type === ACTION_TYPE.NO_NEXT_ACTION) summary.noNextAction++;
    if (action.status === ACTION_STATUS.OVERDUE)   summary.overdue++;
    if (action.status === ACTION_STATUS.DUE_TODAY) summary.dueToday++;
    if (action.status === ACTION_STATUS.UPCOMING)  summary.upcoming++;
    if (action.status === ACTION_STATUS.WAITING)   summary.waiting++;
    if (action.status === ACTION_STATUS.BLOCKED)   summary.blocked++;
    if (action.type !== ACTION_TYPE.NO_NEXT_ACTION) summary.withAction++;
  }
  return summary;
}

// ── LOSS REASONS ────────────────────────────────────────────────────────────
// The board previously offered no way to say WHY a lead was lost beyond
// no_show / ghosted / not_fit. `closed_won` is deliberately absent: it became
// its own stage, so it is no longer a loss outcome.
const OUTCOMES = Object.freeze([
  { id: 'active',         label: 'Active conversation', terminal: false, kind: 'open', recoverable: false },
  { id: 'booked',         label: 'Call booked',         terminal: false, kind: 'open', recoverable: false },
  { id: 'no_show',        label: 'No-show',             terminal: true,  kind: 'loss', recoverable: true },
  { id: 'ghosted',        label: 'Ghosted',             terminal: true,  kind: 'loss', recoverable: true },
  { id: 'not_interested', label: 'Not interested',      terminal: true,  kind: 'loss', recoverable: false },
  { id: 'not_fit',        label: 'Bad fit',             terminal: true,  kind: 'loss', recoverable: false },
  { id: 'timing',         label: 'Wrong timing',        terminal: true,  kind: 'loss', recoverable: true },
  { id: 'other',          label: 'Other',               terminal: true,  kind: 'loss', recoverable: true },
]);
const OUTCOME_IDS = Object.freeze(OUTCOMES.map(o => o.id));
const LOSS_OUTCOME_IDS = Object.freeze(OUTCOMES.filter(o => o.kind === 'loss').map(o => o.id));
// Outcomes that describe a pause rather than a verdict — a future no-show /
// timing recovery sequence targets exactly these.
const RECOVERABLE_OUTCOME_IDS = Object.freeze(OUTCOMES.filter(o => o.recoverable).map(o => o.id));

// ── STAGE TRANSITION VALIDATION ─────────────────────────────────────────────
// One shared rule set. The SPA enforced these inline in two places that could
// drift; this is the single source both can call.
function stageTransitionCheck(toStage, lead) {
  const row = lead || {};
  const stage = displayStageFor(toStage);
  if (stage === 'call_booked' && !String(row.meetingAt || '').trim()) {
    return { ok: false, field: 'meetingAt', message: 'Add the booked meeting time before moving this lead to Call Booked.' };
  }
  if (stage === 'closed_lost' && !LOSS_OUTCOME_IDS.includes(String(row.outcome || '').trim())) {
    return { ok: false, field: 'outcome', message: 'Choose a loss reason before moving this lead to Closed / Lost.' };
  }
  return { ok: true };
}

// ── REOPENING ───────────────────────────────────────────────────────────────
// A lead that replies or books after being marked lost. Reopening is a HUMAN
// decision here — this only reports whether it is safe and what it would cost.
function reopenEligibility(boardLead, twin) {
  const lead = boardLead || {};
  const stage = displayStageFor(lead.stage);
  if (stage !== 'closed_lost') return { reopenable: false, reason: 'lead is not closed/lost' };

  const notes = twin ? twin.notes || '' : '';
  for (const tag of SUPPRESSION_NOTE_TAGS) {
    if (noteHas(notes, tag)) {
      return { reopenable: false, blocked: 'suppression', reason: tag + ' — opt-out/bounce must never be reversed automatically' };
    }
  }
  const outcome = String(lead.outcome || '').trim();
  if (outcome && !RECOVERABLE_OUTCOME_IDS.includes(outcome)) {
    return { reopenable: false, reason: 'outcome "' + outcome + '" is a definitive loss' };
  }
  return {
    reopenable: true,
    reason: outcome ? 'outcome "' + outcome + '" is recoverable' : 'no definitive loss recorded',
    // Reopening must not resurrect the old sequence — that is how a lead gets
    // re-mailed a sequence they already received.
    caution: 'reopen to Hot for human follow-up; do NOT clear emailStatus or remove '
      + MANUAL_HOLD_TAG + ' (either would let the cold sequence resume immediately, because lastEmailedAt is already past its delay)',
  };
}

module.exports = {
  AUTOMATION_STATES, SUPPRESSION_NOTE_TAGS, MANUAL_HOLD_TAG,
  SEND_SUPPRESSION_TAGS, sendSuppressionReason, HUMAN_OWNED_STAGES,
  REACTIVATION_MODES, resumeAtFromNotes, manualHoldReleased,
  HOT_FOLLOW_UP, WAITING_ON, HOT_STALENESS, MEANINGFUL_INBOUND_EVENTS, MEANINGFUL_HUMAN_EVENTS,
  CALL_STATUS, CALL_EVENTS, CALL_BOOKING_EVENTS, CALL_RESOLUTION_EVENTS,
  deriveCallLifecycle, callLifecycleActions,
  addBusinessDays, calendarDayOf, lastMeaningfulInteraction, deriveHotState,
  applyResumeToNotes, clearResumeFromNotes, reactivationEligibility,
  hasManualHold, applyHoldToNotes, stageRequiresHold,
  OUTCOMES, OUTCOME_IDS, LOSS_OUTCOME_IDS, RECOVERABLE_OUTCOME_IDS,
  FOLLOW_UP_DELAY_DAYS,
  deriveAutomationState, automationConflict, deriveNextAction,
  ACTION_OWNER, ACTION_STATUS, ACTION_TYPE, BUSINESS_TIMEZONE,
  businessDay, deriveActionStatus, compareNextActions, summarizeNextActions,
  stageTransitionCheck, reopenEligibility,
};
