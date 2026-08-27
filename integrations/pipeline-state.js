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
const HUMAN_TOUCH_EVENTS = Object.freeze(['conversation_note', 'call_booked']);

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
  };
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

  // ── Call Booked — the meeting is the authority ───────────────────────────
  if (stage === 'call_booked') {
    const meetingAt = String(lead.meetingAt || '').trim();
    if (meetingAt) {
      const meetingPassed = new Date(meetingAt).getTime() < new Date(now).getTime();
      if (!meetingPassed) {
        return buildAction({
          type: ACTION_TYPE.SALES_CALL, label: 'Sales call', dueAt: meetingAt,
          owner: ACTION_OWNER.MEETING, source: 'meeting', reason: 'booked meeting time', now,
        });
      }
      const outcome = String(lead.outcome || '').trim();
      // The meeting has passed. Never infer no-show or completion — that needs
      // explicit outcome information a human records.
      if (!outcome) {
        return buildAction({
          type: ACTION_TYPE.RECORD_CALL_OUTCOME, label: 'Record call outcome', dueAt: meetingAt,
          owner: ACTION_OWNER.HUMAN, status: ACTION_STATUS.OVERDUE, source: 'meeting',
          reason: 'meeting time has passed with no recorded outcome', needsAttention: true, now,
        });
      }
      return buildAction({
        type: ACTION_TYPE.CLOSE_OUT_CALL, label: 'Close out booked call', dueAt: meetingAt,
        owner: ACTION_OWNER.HUMAN, source: 'meeting',
        reason: 'outcome "' + outcome + '" recorded — move the card to its final stage', now,
      });
    }
    return withManual('Confirm meeting time', ACTION_TYPE.CONFIRM_MEETING)
      || buildAction({
        type: ACTION_TYPE.CONFIRM_MEETING, label: 'Confirm meeting time', dueAt: null,
        owner: ACTION_OWNER.HUMAN, status: ACTION_STATUS.BLOCKED, source: 'derived',
        reason: 'card is in Call Booked but carries no meeting time', needsAttention: true, now,
      });
  }

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

  // ── Hot — human territory, automation is held ────────────────────────────
  if (stage === 'hot') {
    return withManual('Human follow-up')
      || buildAction({
        type: ACTION_TYPE.NO_NEXT_ACTION, label: 'Human follow-up — no date set', dueAt: null,
        owner: ACTION_OWNER.HUMAN, status: ACTION_STATUS.BLOCKED, source: 'none',
        reason: 'Hot lead with no reply evidence and no follow-up date — this is the ghosting hole',
        needsAttention: true, now,
      });
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
  AUTOMATION_STATES, SUPPRESSION_NOTE_TAGS, MANUAL_HOLD_TAG, HUMAN_OWNED_STAGES,
  REACTIVATION_MODES, resumeAtFromNotes, manualHoldReleased,
  applyResumeToNotes, clearResumeFromNotes, reactivationEligibility,
  hasManualHold, applyHoldToNotes, stageRequiresHold,
  OUTCOMES, OUTCOME_IDS, LOSS_OUTCOME_IDS, RECOVERABLE_OUTCOME_IDS,
  FOLLOW_UP_DELAY_DAYS,
  deriveAutomationState, automationConflict, deriveNextAction,
  ACTION_OWNER, ACTION_STATUS, ACTION_TYPE, BUSINESS_TIMEZONE,
  businessDay, deriveActionStatus, compareNextActions, summarizeNextActions,
  stageTransitionCheck, reopenEligibility,
};
