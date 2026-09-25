'use strict';
/**
 * false-opt-out-correction.js — release an opt-out our own classifier invented.
 * ─────────────────────────────────────────────────────────────────────────────
 * An opt-out tag is permanent by design: no ordinary notes write may lift
 * [REPLY: Unsubscribed] (outreach-state SAFETY_NOTE_MARKERS). That rule is right
 * for every opt-out a prospect actually sent. It is wrong for exactly one case:
 * the classifier read OUR quoted cold email — its 'Reply "unsubscribe"' footer —
 * as the prospect's words, and a human has since recorded, as a
 * reply_classification_override on that inbound message, that the reply was not
 * an opt-out.
 *
 * This module is the one supported way to correct that. It composes the
 * existing pieces rather than adding a write path of its own:
 *
 *   authority   the human reply_classification_override (reply-overrides.js)
 *   evidence    the original inbound event, re-read with recordedTerminalReply
 *   write       applyLeadChange with an optOutCorrection authorization — the
 *               canonical CAS path, which releases ONLY the exact opt-out tag
 *   audit       one append-only activity with a stable id, like the contact-
 *               change decision
 *
 * It releases nothing else. It never sends, never changes stage or emailStatus,
 * never removes [MANUAL HOLD], never touches a suppression list row, never
 * resumes a sequence and never reserves an action. A lead it corrects stays held.
 *
 * Fail closed: every precondition below must hold, or nothing is written.
 */

const crypto = require('crypto');
const { recordedTerminalReply } = require('./inbound-reply-guard');
const { NON_COLD_STAGES, deriveAutomationOwnership } = require('./automation-ownership');
const { HUMAN_OWNED_STAGES, MANUAL_HOLD_TAG, sendSuppressionReason } = require('./pipeline-state');
const { OVERRIDE_KIND, OVERRIDE_STATUS } = require('./reply-overrides');
const { SEQUENCE_EVENTS } = require('./stage-sequences');
const { PENDING_EVENT } = require('./agent-v2-pending-decision');

const FALSE_OPT_OUT_TAG = '[REPLY: Unsubscribed]';
const CORRECTION_EVENT = 'false_opt_out_corrected';
const CORRECTION_SOURCE = 'manual_false_opt_out_correction';

const REFUSAL = Object.freeze({
  LEAD_NOT_FOUND: 'lead_not_found',
  AMBIGUOUS_LEAD: 'ambiguous_lead',
  MISSING_INPUT: 'missing_message_or_override',
  NO_ORIGINAL_OPT_OUT: 'no_original_opt_out_for_message',
  NO_OVERRIDE: 'no_active_human_override',
  GENUINE_OPT_OUT: 'opt_out_supported_by_prospect_words',
  OTHER_OPT_OUT: 'another_opt_out_exists',
  TAG_ABSENT: 'false_opt_out_tag_absent',
  NO_MANUAL_HOLD: 'manual_hold_missing',
  NOT_HUMAN_OWNED: 'not_human_owned',
  STILL_SUPPRESSED: 'still_on_suppression_list',
  RESERVATION_ACTIVE: 'send_reservation_active',
  RESERVATION_UNVERIFIED: 'send_reservations_unverifiable',
  AUTOMATION_PENDING: 'automated_action_pending',
  AUTOMATION_RUNNING: 'automation_pass_running',
  PIPELINE_AMBIGUOUS: 'pipeline_card_ambiguous',
});

const norm = value => String(value || '').trim().toLowerCase();
const meta = row => {
  if (row && typeof row.metadata === 'object' && row.metadata) return row.metadata;
  try { return JSON.parse(String((row && row.metadata) || '{}')) || {}; } catch (_) { return {}; }
};
const refuse = (code, reason) => ({ ok: false, code, reason });

/** Stable, content-free audit id: one correction per lead and inbound message. */
function correctionEventId(leadId, messageId) {
  const digest = crypto.createHash('sha1').update(`${leadId}|${messageId}`).digest('hex').slice(0, 24);
  return `false-opt-out-correction:${digest}`;
}

/** Remove every exact occurrence of the false tag, and nothing else. PURE. */
function removeFalseOptOutTag(notes) {
  const text = String(notes || '');
  const parts = text.split(FALSE_OPT_OUT_TAG);
  if (parts.length === 1) return { notes: text, removed: 0 };
  let out = parts[0];
  for (const part of parts.slice(1)) {
    // Drop only the one separating space the tag occupied; every other character stays.
    if (out.endsWith(' ') && (part === '' || part.startsWith(' '))) out = out.slice(0, -1);
    out += part.startsWith(' ') && (out === '' || out.endsWith(' ')) ? part.slice(1) : part;
  }
  return { notes: out, removed: parts.length - 1 };
}

function belongsToLead(row, leadId) {
  const id = String(leadId);
  return String(row.sourceLeadId || '') === id || String(row.leadId || '').replace(/^CE-/, '') === id;
}

function isOptOutRecord(row) {
  const data = meta(row);
  return row.eventType === 'unsubscribe_reply' || data.reason === 'unsubscribe_request'
    || String(data.classification || '').toUpperCase() === 'UNSUBSCRIBE';
}

/** The human override that authorises the release, or a reason there is none. */
function authorisingOverride(activities, { leadId, messageId, overrideId }) {
  const overrides = activities.filter(row => row.eventType === OVERRIDE_KIND.CLASSIFICATION && belongsToLead(row, leadId));
  const record = overrides.find(row => row.eventId === overrideId);
  if (!record) return { ok: false, reason: `override ${overrideId} is not recorded for this lead` };
  const data = meta(record);
  const reversed = overrides.some(row => meta(row).status === OVERRIDE_STATUS.REVERSED
    && meta(row).reverses === overrideId);
  if (data.status !== OVERRIDE_STATUS.ACTIVE || reversed) return { ok: false, reason: 'the override is not active' };
  if (String(data.providerMessageId || '') !== messageId) return { ok: false, reason: 'the override names a different inbound message' };
  if (data.previous?.reason !== 'unsubscribe_request') return { ok: false, reason: 'the override does not correct an unsubscribe classification' };
  if (!data.next?.state || data.next.state === 'negative') return { ok: false, reason: 'the override does not assert a non-opt-out meaning' };
  if (!String(data.by || '').trim()) return { ok: false, reason: 'the override does not name the human who made it' };
  return { ok: true, record, data };
}

/** Automated actions that could still act on this lead, from the ledger. */
function pendingAutomation(activities, leadId) {
  const mine = activities.filter(row => belongsToLead(row, leadId));
  const pending = [];
  if (mine.some(row => row.eventType === PENDING_EVENT)) pending.push('Agent v2 decision pending execution');
  const sequences = new Map();
  for (const row of [...mine].sort((a, b) => String(a.occurredAt || '').localeCompare(String(b.occurredAt || '')))) {
    const id = meta(row).sequenceId || '';
    if (row.eventType === SEQUENCE_EVENTS.ENROLLED || row.eventType === SEQUENCE_EVENTS.RESUMED) sequences.set(id, true);
    if ([SEQUENCE_EVENTS.STOPPED, SEQUENCE_EVENTS.CANCELLED, SEQUENCE_EVENTS.COMPLETED, SEQUENCE_EVENTS.PAUSED].includes(row.eventType)) sequences.set(id, false);
  }
  for (const [id, active] of sequences) if (active) pending.push(`stage sequence ${id || '(unnamed)'} is enrolled`);
  // A ledger reservation with no delivery after it is an action still in flight.
  // Each reservation kind is matched to its own delivery event, as the writers
  // record them: a cold step by its step number (the send also carries the
  // campaign's sequenceId, the reservation does not), a stage-sequence step by
  // the stepEventId its reservation names. An unknown reservation kind is live.
  const coldDelivered = new Set(mine.filter(row => ['initial_email_sent', 'follow_up_sent'].includes(row.eventType))
    .map(row => String(meta(row).step ?? '')));
  const sequenceResolved = new Set(mine.filter(row => [SEQUENCE_EVENTS.STEP_SENT, SEQUENCE_EVENTS.SEND_FAILED].includes(row.eventType))
    .map(row => row.eventId));
  for (const row of mine.filter(item => /send_reserved$|send_uncertain$/.test(item.eventType))) {
    const data = meta(row);
    const resolved = row.eventType === 'ordinary_send_reserved' ? coldDelivered.has(String(data.step ?? ''))
      : row.eventType === SEQUENCE_EVENTS.SEND_RESERVED ? sequenceResolved.has(String(data.stepEventId || ''))
        : false;
    if (!resolved) pending.push(`${row.eventType} ${row.eventId} has no delivery`);
  }
  return pending;
}

/**
 * Decide whether the false opt-out may be released. PURE: every fact is passed in.
 *
 * @param lead              the canonical outreach lead ({ id, email, stage, emailStatus, emailStep, notes })
 * @param leadMatches       how many outreach rows carry this id (must be exactly 1)
 * @param boardLeads        Pipeline cards sharing the lead's CE id or email
 * @param activities        the activity ledger (any superset of this lead's rows)
 * @param suppressedEmails  the durable suppression list
 * @param reservations      { ok, unresolved: [..rows for this lead], nextSteps: [{ actionId, status }] }
 * @param automationRunning true while any send-capable pass is in flight
 */
function evaluateFalseOptOutCorrection({
  lead = null, leadMatches = 0, boardLeads = [], activities = [], suppressedEmails = new Set(),
  reservations = null, automationRunning = false, messageId = '', overrideId = '',
  // Only when this correction's own audit record already exists: the lead was
  // released by an earlier run and only the Pipeline card copy remains.
  leadReleasedUnderAudit = false,
} = {}) {
  if (!lead || !lead.id || leadMatches === 0) return refuse(REFUSAL.LEAD_NOT_FOUND, 'the outreach lead does not exist');
  if (leadMatches !== 1) return refuse(REFUSAL.AMBIGUOUS_LEAD, 'the lead id is not exactly one outreach row');
  const leadId = String(lead.id);
  const message = String(messageId || '').trim();
  const override = String(overrideId || '').trim();
  if (!message || !override) return refuse(REFUSAL.MISSING_INPUT, 'the inbound message and the authorising override are both required');

  const mine = activities.filter(row => belongsToLead(row, leadId));
  const inbound = mine.filter(row => /reply|meeting_requested/.test(String(row.eventType || ''))
    && row.eventType !== OVERRIDE_KIND.CLASSIFICATION && row.eventType !== 'reply_decision_recorded'
    && row.eventType !== 'gmail_reply_evaluated');
  const original = inbound.find(row => String(meta(row).gmailMessageId || '') === message && isOptOutRecord(row));
  if (!original) return refuse(REFUSAL.NO_ORIGINAL_OPT_OUT, 'no opt-out classification is recorded for that inbound message');

  const authority = authorisingOverride(activities, { leadId, messageId: message, overrideId: override });
  if (!authority.ok) return refuse(REFUSAL.NO_OVERRIDE, authority.reason);

  // Re-read the prospect's own words. If they still say opt-out, it is genuine.
  const reread = recordedTerminalReply(original, { currentEmail: lead.email });
  if (reread.unsubscribe || reread.rejection) {
    return refuse(REFUSAL.GENUINE_OPT_OUT, 'the stored reply, re-read as the prospect\'s own words, still opts out or rejects');
  }
  const others = inbound.filter(row => row !== original && String(meta(row).gmailMessageId || '') !== message)
    .filter(row => {
      const other = recordedTerminalReply(row, { currentEmail: lead.email });
      return other.unsubscribe || other.rejection;
    });
  if (others.length) return refuse(REFUSAL.OTHER_OPT_OUT, `${others.length} other inbound reply(ies) still record an opt-out or rejection`);

  const notes = String(lead.notes || '');
  const auditedRelease = leadReleasedUnderAudit
    && activities.some(row => row.eventId === correctionEventId(leadId, message) && belongsToLead(row, leadId));
  if (!notes.includes(FALSE_OPT_OUT_TAG) && !auditedRelease) {
    return refuse(REFUSAL.TAG_ABSENT, 'the exact false opt-out tag is not on the lead');
  }
  if (!notes.includes(MANUAL_HOLD_TAG)) return refuse(REFUSAL.NO_MANUAL_HOLD, 'a [MANUAL HOLD] must keep automation off before the tag is released');

  const stage = norm(lead.stage);
  const status = norm(lead.emailStatus);
  if (!NON_COLD_STAGES.includes(stage) || ['unsub', 'unsubscribed', 'done'].includes(stage) || ['', 'emailed'].includes(status)) {
    return refuse(REFUSAL.NOT_HUMAN_OWNED, `stage ${lead.stage || '(blank)'} / emailStatus ${lead.emailStatus || '(blank)'} is not a human-owned conversation`);
  }
  if (boardLeads.length > 1) return refuse(REFUSAL.PIPELINE_AMBIGUOUS, 'more than one Pipeline card matches this lead');
  const board = boardLeads[0] || null;
  if (board && !HUMAN_OWNED_STAGES.includes(norm(board.stage))) {
    return refuse(REFUSAL.NOT_HUMAN_OWNED, `Pipeline stage ${board.stage || '(blank)'} is not human-owned`);
  }
  if (suppressedEmails.has(norm(lead.email))) {
    return refuse(REFUSAL.STILL_SUPPRESSED, 'the address is still on the durable suppression list; that row is a separate, deliberate decision');
  }

  if (automationRunning) return refuse(REFUSAL.AUTOMATION_RUNNING, 'a send-capable pass is running; retry after it finishes');
  if (!reservations || reservations.ok !== true) {
    return refuse(REFUSAL.RESERVATION_UNVERIFIED, `send reservations could not be verified${reservations?.reason ? `: ${reservations.reason}` : ''}`);
  }
  const live = (reservations.nextSteps || []).filter(item => item && item.status && !['confirmed', 'failed_pre_delivery'].includes(item.status));
  if ((reservations.unresolved || []).length || live.length) {
    return refuse(REFUSAL.RESERVATION_ACTIVE, 'an automated send reservation for this lead is unresolved');
  }
  const pending = pendingAutomation(activities, leadId);
  if (pending.length) return refuse(REFUSAL.AUTOMATION_PENDING, pending.join('; '));

  const nextNotes = removeFalseOptOutTag(notes).notes;
  const corrected = { ...lead, notes: nextNotes };
  // The release must leave automation exactly as blocked as before.
  const ownership = deriveAutomationOwnership(corrected, {
    boardLead: board, activities: mine, sendingEnabled: true, sequencesEnabled: true, coldCadenceDue: true,
    suppressionReason: item => sendSuppressionReason(item, { suppressedEmails }),
  });
  if (ownership.sendAllowed || ownership.sequenceAllowed || ownership.automationAllowed) {
    return refuse(REFUSAL.NOT_HUMAN_OWNED, `after release, ownership would be ${ownership.owner}; refusing`);
  }

  const eventId = correctionEventId(leadId, message);
  const originalData = meta(original);
  return {
    ok: true,
    leadId, messageId: message, overrideId: override, eventId,
    notes: nextNotes,
    boardNotes: board && String(board.notes || '').includes(FALSE_OPT_OUT_TAG) ? removeFalseOptOutTag(board.notes).notes : null,
    board,
    ownership: { owner: ownership.owner, blockedBy: ownership.blockedBy },
    original: {
      eventId: original.eventId || `gmail-reply:${message}`,
      eventType: original.eventType,
      reason: originalData.reason || null,
      canonicalState: originalData.canonicalState || null,
    },
    override: { eventId: override, by: authority.data.by, at: authority.data.at || null,
      state: authority.data.next.state },
  };
}

/** The append-only audit record. Identifiers only — no reply text, no notes. */
function correctionActivity(plan, { lead, by, at }) {
  return {
    eventId: plan.eventId,
    leadId: plan.board?.id || `CE-${plan.leadId}`,
    sourceLeadId: plan.leadId,
    email: lead.email || '',
    company: lead.company || '',
    eventType: CORRECTION_EVENT,
    occurredAt: at,
    subject: 'False opt-out correction authorized',
    content: '',
    metadata: JSON.stringify({
      // Written before the release, as the contact-change decision is; the
      // release itself is verifiable in the lead and card notes it names.
      decision: 'release_false_opt_out',
      source: CORRECTION_SOURCE,
      correctedBy: by,
      correctedAt: at,
      gmailMessageId: plan.messageId,
      originalEventId: plan.original.eventId,
      originalClassification: { eventType: plan.original.eventType, reason: plan.original.reason,
        canonicalState: plan.original.canonicalState },
      authorizedByOverrideId: plan.overrideId,
      overrideBy: plan.override.by,
      overrideState: plan.override.state,
      releasedMarker: FALSE_OPT_OUT_TAG,
      releasedFrom: ['outreach_lead_notes', ...(plan.boardNotes !== null ? ['pipeline_card_notes'] : [])],
      unchanged: ['stage', 'emailStatus', 'emailStep', 'manual_hold', 'suppression_list', 'booking', 'reply_history'],
      automationResumed: false,
    }),
  };
}

const inFlight = new Map();

/**
 * Apply the correction. Idempotent, serialised per lead, fail closed.
 *
 * deps (all injected, none can send):
 *   loadState()                       → { lead, leadMatches, row, boardLeads, boardRow, activities,
 *                                          suppressedEmails, reservations, automationRunning }
 *   writeLeadNotes({ lead, row, notes, expectedState, optOutCorrection })
 *   writeBoardNotes({ boardRow, boardId, expectedNotes, notes })
 *   appendActivity(event)
 *   now()
 */
function applyFalseOptOutCorrection({ leadId, messageId, overrideId, by }, deps) {
  const key = String(leadId || '');
  const run = (inFlight.get(key) || Promise.resolve()).then(() => correctOnce({ leadId, messageId, overrideId, by }, deps));
  const settled = run.catch(() => {});
  inFlight.set(key, settled);
  settled.then(() => { if (inFlight.get(key) === settled) inFlight.delete(key); });
  return run;
}

async function correctOnce({ leadId, messageId, overrideId, by }, deps) {
  const actor = String(by || '').trim();
  if (!actor) return { status: 'refused', code: REFUSAL.MISSING_INPUT, reason: 'the human making the correction must be named' };
  const state = await deps.loadState();
  const lead = state.lead;
  const eventId = lead ? correctionEventId(String(lead.id), String(messageId || '').trim()) : '';
  const audited = Boolean(lead) && state.activities.some(row => row.eventId === eventId);
  const boardTagged = (state.boardLeads || []).some(card => String(card.notes || '').includes(FALSE_OPT_OUT_TAG));

  // Already done: nothing is written again.
  if (audited && lead && !String(lead.notes || '').includes(FALSE_OPT_OUT_TAG) && !boardTagged) {
    return { status: 'already_corrected', eventId, writes: 0 };
  }

  const leadStillTagged = Boolean(lead) && String(lead.notes || '').includes(FALSE_OPT_OUT_TAG);
  // A previous run recorded the audit and released the lead but not the card copy:
  // every precondition is re-checked, then only the card is finished.
  const plan = evaluateFalseOptOutCorrection({
    lead, leadMatches: state.leadMatches, boardLeads: state.boardLeads || [],
    activities: state.activities, suppressedEmails: state.suppressedEmails, reservations: state.reservations,
    automationRunning: state.automationRunning, messageId, overrideId,
    leadReleasedUnderAudit: audited && !leadStillTagged && boardTagged,
  });
  if (!plan.ok) return { status: 'refused', code: plan.code, reason: plan.reason, writes: 0 };

  let writes = 0;
  const at = deps.now();
  // Audit first, as the contact-change decision does: a partial failure leaves a
  // record of the authorised decision and a re-run finishes the same one.
  if (!audited) { await deps.appendActivity(correctionActivity(plan, { lead, by: actor, at })); writes++; }
  if (leadStillTagged) {
    await deps.writeLeadNotes({
      lead, row: state.row, notes: plan.notes,
      // Compare-and-set against exactly the state that was evaluated.
      expectedState: { stage: lead.stage, emailStatus: lead.emailStatus, emailStep: lead.emailStep, notes: lead.notes },
      optOutCorrection: { leadId: plan.leadId, providerMessageId: plan.messageId, overrideId: plan.overrideId, correctionEventId: plan.eventId },
    });
    writes++;
  }
  if (plan.boardNotes !== null && plan.board) {
    await deps.writeBoardNotes({ boardRow: state.boardRow, boardId: plan.board.id, expectedNotes: plan.board.notes, notes: plan.boardNotes });
    writes++;
  }
  return { status: 'corrected', eventId: plan.eventId, writes, ownership: plan.ownership,
    releasedFrom: ['outreach_lead_notes', ...(plan.boardNotes !== null ? ['pipeline_card_notes'] : [])] };
}

module.exports = {
  FALSE_OPT_OUT_TAG, CORRECTION_EVENT, CORRECTION_SOURCE, REFUSAL,
  correctionEventId, removeFalseOptOutTag, evaluateFalseOptOutCorrection, correctionActivity,
  applyFalseOptOutCorrection, pendingAutomation,
};
