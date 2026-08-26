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

// ── AUTOMATION STATE ────────────────────────────────────────────────────────
// Derived from the ColdEmail twin, because emailStatus — not stage — is what
// every selector in outreach-agent.js actually gates on.
const AUTOMATION_STATES = Object.freeze({
  NEVER: 'never',      // no sending record; nothing scheduled
  ACTIVE: 'active',    // a sequence is live and WILL send again
  STOPPED: 'stopped',  // terminal; no further automated send
  UNKNOWN: 'unknown',  // no ColdEmail twin — board-only lead
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
function deriveAutomationState(twin) {
  if (!twin) return { state: AUTOMATION_STATES.UNKNOWN, reason: 'no ColdEmail record linked to this lead' };

  const notes = twin.notes || '';
  for (const tag of SUPPRESSION_NOTE_TAGS) {
    if (noteHas(notes, tag)) return { state: AUTOMATION_STATES.STOPPED, reason: 'suppressed (' + tag + ')' };
  }
  if (noteHas(notes, MANUAL_HOLD_TAG)) {
    // Enforced: suppressionReason() in outreach-agent.js reads this tag before
    // every send, so the sequence really is stopped. Releasing it is manual by
    // design — see reopenEligibility().
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
const FOLLOW_UP_DELAY_DAYS = Object.freeze([3, 5]); // mirrors FOLLOW_UP_SEQUENCE

function addDays(iso, days) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return new Date(t + days * 86400000).toISOString();
}

/**
 * @returns { action, dueAt, source, needsAttention }
 *   source: 'followup-field' | 'derived' | 'none'
 *   needsAttention: true when an active lead has no defined next step
 */
function deriveNextAction(boardLead, twin) {
  const lead = boardLead || {};
  const stage = displayStageFor(lead.stage);
  const derived = deriveAutomationState(twin || null);
  const manualDate = String(lead.followup || '').trim();

  // A human-set follow-up date always wins — it is an explicit decision.
  const withManual = (action) => manualDate
    ? { action, dueAt: manualDate, source: 'followup-field', needsAttention: false }
    : null;

  if (stage === 'closed_won')  return { action: 'None — won', dueAt: null, source: 'none', needsAttention: false };
  if (stage === 'closed_lost') return { action: 'None — closed', dueAt: null, source: 'none', needsAttention: false };

  if (stage === 'call_booked') {
    const meetingAt = String(lead.meetingAt || '').trim();
    if (meetingAt) return { action: 'Attend booked call', dueAt: meetingAt, source: 'derived', needsAttention: false };
    return withManual('Confirm meeting time')
      || { action: 'Confirm meeting time', dueAt: null, source: 'derived', needsAttention: true };
  }

  if (stage === 'hot') {
    // Hot is human territory: automation is stopped, so if nobody set a date
    // there is genuinely no next step. That is the ghosting hole.
    return withManual('Human follow-up')
      || { action: 'Human follow-up — no date set', dueAt: null, source: 'none', needsAttention: true };
  }

  // follow_up
  if (derived.state === AUTOMATION_STATES.ACTIVE && twin) {
    const step = parseInt(twin.emailStep || '0', 10);
    const delay = FOLLOW_UP_DELAY_DAYS[step - 1];
    if (delay && twin.lastEmailedAt) {
      const dueAt = addDays(twin.lastEmailedAt, delay);
      if (dueAt) return { action: 'Automated follow-up #' + (step + 1), dueAt, source: 'derived', needsAttention: false };
    }
    if (String(twin.stage || '').toLowerCase() === 'queued') {
      return { action: 'Automated first send', dueAt: null, source: 'derived', needsAttention: false };
    }
  }
  return withManual('Manual follow-up')
    || { action: 'No next action defined', dueAt: null, source: 'none', needsAttention: true };
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
  hasManualHold, applyHoldToNotes, stageRequiresHold,
  OUTCOMES, OUTCOME_IDS, LOSS_OUTCOME_IDS, RECOVERABLE_OUTCOME_IDS,
  FOLLOW_UP_DELAY_DAYS,
  deriveAutomationState, automationConflict, deriveNextAction,
  stageTransitionCheck, reopenEligibility,
};
