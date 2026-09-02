'use strict';
/**
 * stage-sequences.js — stage-specific follow-up journeys. PURE / READ-ONLY.
 * ─────────────────────────────────────────────────────────────────────────────
 * The original cold sequence (FOLLOW_UP_SEQUENCE in outreach-agent.js) is for
 * prospects who have never engaged. It is NOT touched here. This module adds the
 * journeys that begin AFTER meaningful intent — a demo watched, a positive reply
 * gone quiet, a no-show, a cancelled call, a "maybe later".
 *
 * Every function is pure: no sheets client, no network, no writes. It decides
 * eligibility and derives state; the existing sending agent remains the only
 * thing that mails anyone, through its existing caps, validator and suppression.
 *
 * STATE LIVES IN THE ACTIVITY TIMELINE, NOT A NEW COLUMN
 * ------------------------------------------------------
 * Enrollment, steps, pauses and stops are canonical append-only activity events.
 * That is deliberate: it keeps a stage step distinguishable from a cold step
 * (emailStep is never touched), it is idempotent by stable event id, and it is
 * auditable. See deriveSequenceState().
 */

const { addBusinessDays, businessDay } = require('./pipeline-state');
// Stage comparisons go through the canonical normaliser, never the raw cell.
// Legacy rows store values like 'lost', 'warm' or 'Hot', and a raw compare
// would silently skip both the Hot journey AND the closed-lost stop condition.
const { displayStageFor } = require('./cold-call-pipeline');

// ── TIMING ──────────────────────────────────────────────────────────────────
// Every delay in one place. Business days, matching the Hot conversation clock —
// a recovery email landing on a Sunday helps nobody. These are NOT the cold
// cadence (FOLLOW_UP_DELAY_DAYS); conflating the two would tie a recovery
// journey to the cold sending schedule.
const SEQUENCE_TIMING = Object.freeze({
  DEMO_STEP_1_BUSINESS_DAYS: 3,   // after the booking-link email already sent
  DEMO_STEP_2_BUSINESS_DAYS: 5,
  HOT_STEP_1_BUSINESS_DAYS: 0,    // enrollment is itself the human's decision to go
  HOT_STEP_2_BUSINESS_DAYS: 4,
  NO_SHOW_STEP_1_BUSINESS_DAYS: 1,
  NO_SHOW_STEP_2_BUSINESS_DAYS: 4,
  CANCELLED_STEP_1_BUSINESS_DAYS: 1,
  CANCELLED_STEP_2_BUSINESS_DAYS: 5,
});

const SEQUENCE_STATUS = Object.freeze({
  NONE: 'none',
  ACTIVE: 'active',
  PAUSED: 'paused',
  CANCELLED: 'cancelled',
  COMPLETE: 'complete',
  STOPPED: 'stopped',
});

const SEQUENCE_OWNER = Object.freeze({ AUTOMATION: 'automation', HUMAN: 'human' });

// Canonical activity vocabulary for sequences.
const SEQUENCE_EVENTS = Object.freeze({
  ENROLLED: 'sequence_enrolled',
  SEND_RESERVED: 'sequence_send_reserved',
  SEND_FAILED: 'sequence_send_failed',
  STEP_SENT: 'sequence_step_sent',
  PAUSED: 'sequence_paused',
  RESUMED: 'sequence_resumed',
  CANCELLED: 'sequence_cancelled',
  COMPLETED: 'sequence_completed',
  STOPPED: 'sequence_stopped',
});
const SEQUENCE_EVENT_TYPES = Object.freeze(Object.values(SEQUENCE_EVENTS));

// ── SEQUENCE DEFINITIONS ────────────────────────────────────────────────────
// Bounded by construction: maxSteps is explicit and the engine refuses to go
// past it. This is a recovery engine, not a nurture drip.
const SEQUENCES = Object.freeze({
  demo_follow_up_v1: {
    id: 'demo_follow_up_v1',
    label: 'Demo follow-up',
    stage: 'follow_up',
    requiresEnrollment: true,    // auto-enrolled from verified booking-link evidence
    maxSteps: 2,
    delays: [SEQUENCE_TIMING.DEMO_STEP_1_BUSINESS_DAYS, SEQUENCE_TIMING.DEMO_STEP_2_BUSINESS_DAYS],
  },
  hot_stale_v1: {
    id: 'hot_stale_v1',
    label: 'Hot follow-up',
    stage: 'hot',
    requiresEnrollment: true,    // Hot is human-owned; automation needs consent
    maxSteps: 2,
    delays: [SEQUENCE_TIMING.HOT_STEP_1_BUSINESS_DAYS, SEQUENCE_TIMING.HOT_STEP_2_BUSINESS_DAYS],
  },
  no_show_recovery_v1: {
    id: 'no_show_recovery_v1',
    label: 'No-show recovery',
    stage: 'call_booked',
    requiresEnrollment: true,
    maxSteps: 2,
    delays: [SEQUENCE_TIMING.NO_SHOW_STEP_1_BUSINESS_DAYS, SEQUENCE_TIMING.NO_SHOW_STEP_2_BUSINESS_DAYS],
  },
  cancelled_rebook_v1: {
    id: 'cancelled_rebook_v1',
    label: 'Rebooking follow-up',
    stage: 'call_booked',
    requiresEnrollment: true,
    maxSteps: 2,
    delays: [SEQUENCE_TIMING.CANCELLED_STEP_1_BUSINESS_DAYS, SEQUENCE_TIMING.CANCELLED_STEP_2_BUSINESS_DAYS],
  },
  timing_recontact_v1: {
    id: 'timing_recontact_v1',
    label: 'Timing re-contact',
    stage: null,                 // may sit on a recoverable Closed Lost
    requiresEnrollment: true,
    maxSteps: 1,
    delays: [0],                 // fires on the human's chosen date
  },
});
const SEQUENCE_IDS = Object.freeze(Object.keys(SEQUENCES));

// Which journey wins when more than one looks eligible. Meeting reality first,
// then the live human conversation, then demo interest, then nurture.
const SEQUENCE_PRECEDENCE = Object.freeze([
  'no_show_recovery_v1',
  'cancelled_rebook_v1',
  'hot_stale_v1',
  'demo_follow_up_v1',
  'timing_recontact_v1',
]);

// ── STOP CONDITIONS ─────────────────────────────────────────────────────────
// Centralised, and evaluated before ANY eligibility question. No sequence may
// continue underneath a live human conversation.
const INBOUND_REPLY_EVENTS = Object.freeze([
  'positive_reply', 'meeting_requested', 'late_reply', 'question_reply',
  'negative_reply', 'unsubscribe_reply', 'wrong_person_reply', 'needs_human_reply',
]);
const HUMAN_INTERVENTION_EVENTS = Object.freeze(['human_response_sent', 'conversation_note']);
const BOOKING_EVENTS = Object.freeze(['call_booked', 'meeting_rescheduled']);

const HARD_SUPPRESSION_TAGS = Object.freeze(['[REPLY: Unsubscribed]', '[BOUNCED']);

function latestAt(activities, types) {
  let latest = '';
  for (const row of activities || []) {
    if (!types.includes(String(row.eventType || ''))) continue;
    const at = String(row.occurredAt || '');
    if (at > latest) latest = at;
  }
  return latest || null;
}

/**
 * Suppression SCOPED to stage sequences.
 *
 * [MANUAL HOLD] always blocks cold cadence and also blocks generic demo/Hot
 * automation. Only an explicit lifecycle action — no-show, cancellation, or a
 * human-selected timing date — authorises its matching recovery journey through
 * the hold. The tag itself is never removed, so ordinary Email 2/3 stay stopped.
 *
 * Everything permanent still wins: opt-out, bounce and the durable list block
 * every path, always.
 */
function hasManualHold(twin = {}) {
  return String(twin.notes || '').includes('[MANUAL HOLD]');
}

function stageSequenceSuppressionReason(twin = {}, suppressedEmails = new Set(), options = {}) {
  const notes = String(twin.notes || '');
  for (const tag of HARD_SUPPRESSION_TAGS) {
    if (notes.includes(tag)) return `suppressed (${tag})`;
  }
  if (suppressedEmails.has(String(twin.email || '').trim().toLowerCase())) {
    return 'on the durable suppression list';
  }
  if (hasManualHold(twin) && !options.explicitLifecycleAuthorization) {
    return 'manual hold — human owns this lead';
  }
  return null;
}

/**
 * Every global stop condition in one place.
 * @returns a stop reason string, or null when the sequence may continue.
 */
function sequenceStopReason(input = {}) {
  const { boardLead = {}, twin = {}, activities = [], enrolledAt = null,
    suppressedEmails = new Set(), identityConflict = false, callStatus = null } = input;

  const explicitLifecycleAuthorization = ['no_show_recovery_v1', 'cancelled_rebook_v1', 'timing_recontact_v1']
    .includes(String(input.sequenceId || ''));
  const suppression = stageSequenceSuppressionReason(twin, suppressedEmails, { explicitLifecycleAuthorization });
  if (suppression) return suppression;
  if (identityConflict) return 'identity mapping conflict';

  const stage = displayStageFor(boardLead.stage);
  if (stage === 'closed_won') return 'opportunity closed won';
  if (stage === 'closed_lost'
    && !(String(input.sequenceId || '') === 'timing_recontact_v1'
      && String(boardLead.outcome || '') === 'timing')) return 'opportunity closed lost';

  // Anything that happened AFTER enrollment ends the journey. Before enrollment
  // it is just history the human already saw when they chose to enrol.
  const since = at => Boolean(at) && Boolean(enrolledAt) && at > enrolledAt;

  const replyAt = latestAt(activities, INBOUND_REPLY_EVENTS);
  if (since(replyAt)) return 'the prospect replied';

  const humanAt = latestAt(activities, HUMAN_INTERVENTION_EVENTS);
  if (since(humanAt)) return 'a human took the conversation over';

  const bookingAt = latestAt(activities, BOOKING_EVENTS);
  if (since(bookingAt)) return 'a meeting was booked';

  // A live booking makes the call lifecycle authoritative, whatever the clock says.
  if (['scheduled', 'rescheduled'].includes(String(callStatus || ''))) {
    return 'a meeting is on the calendar';
  }
  return null;
}

// ── SEQUENCE STATE ──────────────────────────────────────────────────────────
function sequenceMetadata(row) {
  try { return JSON.parse(row.metadata || '{}'); } catch (_) { return {}; }
}

/**
 * Current state of the stage sequence for one lead, derived from the canonical
 * timeline. emailStep is never read or written here, so a cold step and a stage
 * step can never be confused.
 *
 * @returns { sequenceId, status, step, enrolledAt, lastStepAt, owner, stopReason }
 */
function deriveSequenceState(activities = []) {
  const events = activities
    .filter(row => SEQUENCE_EVENT_TYPES.includes(String(row.eventType || '')))
    .slice()
    .sort((a, b) => String(a.occurredAt || '').localeCompare(String(b.occurredAt || '')));

  let state = { sequenceId: null, status: SEQUENCE_STATUS.NONE, step: 0, enrolledAt: null,
    lastStepAt: null, owner: null, stopReason: null };

  for (const row of events) {
    const type = String(row.eventType || '');
    const metadata = sequenceMetadata(row);
    const at = String(row.occurredAt || '');
    switch (type) {
      case SEQUENCE_EVENTS.ENROLLED:
        // A new enrollment always supersedes whatever came before.
        state = { sequenceId: String(metadata.sequenceId || ''), status: SEQUENCE_STATUS.ACTIVE,
          step: 0, enrolledAt: at, lastStepAt: null, owner: SEQUENCE_OWNER.AUTOMATION, stopReason: null,
          recontactAt: metadata.recontactAt || null };
        break;
      case SEQUENCE_EVENTS.STEP_SENT:
        state.step = Math.max(state.step, Number(metadata.step) || state.step + 1);
        state.lastStepAt = at;
        break;
      case SEQUENCE_EVENTS.PAUSED:
        state.status = SEQUENCE_STATUS.PAUSED;
        state.owner = SEQUENCE_OWNER.HUMAN;
        state.stopReason = String(metadata.reason || 'paused by hand');
        break;
      case SEQUENCE_EVENTS.RESUMED:
        state.status = SEQUENCE_STATUS.ACTIVE;
        state.owner = SEQUENCE_OWNER.AUTOMATION;
        state.stopReason = null;
        break;
      case SEQUENCE_EVENTS.CANCELLED:
        state.status = SEQUENCE_STATUS.CANCELLED;
        state.owner = SEQUENCE_OWNER.HUMAN;
        state.stopReason = String(metadata.reason || 'cancelled by hand');
        break;
      case SEQUENCE_EVENTS.COMPLETED:
        state.status = SEQUENCE_STATUS.COMPLETE;
        state.owner = SEQUENCE_OWNER.HUMAN;
        state.stopReason = null;
        break;
      case SEQUENCE_EVENTS.STOPPED:
        state.status = SEQUENCE_STATUS.STOPPED;
        state.owner = SEQUENCE_OWNER.HUMAN;
        state.stopReason = String(metadata.reason || 'stopped');
        break;
      default: break;
    }
  }
  return state;
}

/** When the next step of an active sequence becomes eligible. */
function nextStepDueAt(definition, state, anchors = {}) {
  if (!definition) return null;
  const nextStep = (state.step || 0) + 1;
  if (nextStep > definition.maxSteps) return null;
  const delay = definition.delays[nextStep - 1] ?? 0;
  // Step 1 counts from the journey's own anchor (the booking-link email, the
  // no-show, the cancellation, the enrollment). Later steps count from the
  // previous step actually sent.
  const from = nextStep === 1
    ? (state.enrolledAt || anchors.anchorAt || null)
    : state.lastStepAt;
  if (!from) return null;
  if (definition.id === 'timing_recontact_v1' && state.recontactAt) return state.recontactAt;
  return delay > 0 ? addBusinessDays(from, delay) : from;
}

// ── ELIGIBILITY ─────────────────────────────────────────────────────────────
/**
 * Which journey, if any, applies to this lead right now — and whether its next
 * step is due. Fail-closed: anything unclear returns not-eligible with a reason.
 *
 * @param input { boardLead, twin, activities, callState, hotState, suppressedEmails,
 *                identityConflict, now, featureEnabled }
 */
function evaluateStageSequence(input = {}) {
  const { boardLead = {}, twin = {}, activities = [], callState = null, hotState = null,
    suppressedEmails = new Set(), identityConflict = false, now = Date.now(),
    featureEnabled = false } = input;

  const state = deriveSequenceState(activities);
  const definition = state.sequenceId ? SEQUENCES[state.sequenceId] : null;
  const stage = displayStageFor(boardLead.stage);

  const base = {
    sequenceId: state.sequenceId, label: definition ? definition.label : null,
    status: state.status, step: state.step, maxSteps: definition ? definition.maxSteps : null,
    enrolledAt: state.enrolledAt, lastStepAt: state.lastStepAt,
    owner: state.owner, eligible: false, dueNow: false, nextDueAt: null,
    stopReason: state.stopReason, featureEnabled,
  };

  // ── which journeys COULD be offered, independent of enrollment ───────────
  const callStatus = callState ? String(callState.status || '') : null;
  const offers = [];
  if (callStatus === 'no_show') offers.push('no_show_recovery_v1');
  if (callStatus === 'cancelled') offers.push('cancelled_rebook_v1');
  if (stage === 'hot' && hotState && ['follow_up_due', 'overdue', 'stale', 'severely_stale'].includes(hotState.staleness)
    && hotState.waitingOn === 'waiting_on_prospect') {
    offers.push('hot_stale_v1');
  }
  if (stage === 'follow_up' && activities.some(row => String(row.eventType || '') === 'booking_link_sent')) {
    offers.push('demo_follow_up_v1');
  }
  const offered = SEQUENCE_PRECEDENCE.filter(id => offers.includes(id));
  base.offers = offered;
  base.offer = offered[0] || null;

  // ── an inactive lead may still be offered a journey, but sends nothing ────
  if (state.status !== SEQUENCE_STATUS.ACTIVE) {
    if (state.status === SEQUENCE_STATUS.NONE && base.offer) {
      const stop = sequenceStopReason({
        boardLead, twin, activities, suppressedEmails, identityConflict,
        callStatus, sequenceId: base.offer,
      });
      if (stop) return { ...base, stopReason: stop, reason: stop };
    }
    return { ...base, reason: state.status === SEQUENCE_STATUS.NONE
      ? (base.offer ? 'a journey is available but nobody has enrolled this lead' : 'no stage sequence applies')
      : `sequence is ${state.status}` };
  }

  // ── active: does anything stop it? ───────────────────────────────────────
  const stop = sequenceStopReason({
    boardLead, twin, activities, enrolledAt: state.enrolledAt, sequenceId: state.sequenceId,
    suppressedEmails, identityConflict, callStatus,
  });
  if (stop) return { ...base, status: SEQUENCE_STATUS.ACTIVE, stopReason: stop, reason: stop };

  if (!definition) return { ...base, reason: 'unknown sequence id — refusing to send' };

  // Bounded: never past maxSteps.
  if (state.step >= definition.maxSteps) {
    return { ...base, status: SEQUENCE_STATUS.COMPLETE, reason: 'every step of this sequence has been sent' };
  }

  const anchorAt = latestAt(activities, ['booking_link_sent']);
  const due = nextStepDueAt(definition, state, { anchorAt });
  const dueNow = Boolean(due) && new Date(due).getTime() <= new Date(now).getTime();
  return {
    ...base, label: definition.label, maxSteps: definition.maxSteps,
    owner: SEQUENCE_OWNER.AUTOMATION, nextDueAt: due, dueNow,
    // The feature gate is the LAST word: with it off, nothing is ever eligible.
    eligible: Boolean(featureEnabled && dueNow),
    reason: !due ? 'no due date could be derived'
      : dueNow ? `step ${state.step + 1} is due`
        : `step ${state.step + 1} due ${businessDay(due)}`,
  };
}

// ── COPY ────────────────────────────────────────────────────────────────────
// Short by design. The prospect already has the context, the offer and the
// guarantee from the original thread — repeating the whole pitch in a recovery
// email reads like a cold blast, not a follow-up.
//
// Every fact here is CANONICAL: whether a call happened, whether they no-showed,
// the company name, the meeting time. Nothing about the offer, pricing or the
// guarantee is restated or generated, so nothing can drift.

function firstName(lead = {}) {
  const raw = String(lead.contactName || lead.first || '').trim();
  const part = raw.split(/\s+/)[0] || '';
  return /^(dr|mr|mrs|ms|the)$/i.test(part) ? (raw.split(/\s+/)[1] || '') : part;
}

function salutation(lead) {
  const name = firstName(lead);
  if (!name) return 'Hi,';
  // Some board rows carry the COMPANY in the name fields (an import artefact),
  // which produced "Hi Galaxy," for Galaxy Dental. A greeting that is really
  // the company name reads worse than no name at all, so drop it.
  const company = companyOf(lead).toLowerCase();
  const looksLikeCompany = company
    && company.split(/\s+/).some(word => word.length > 2 && word === name.toLowerCase());
  if (looksLikeCompany) return 'Hi,';
  // A single-token "name" that is not a plausible person's name is also unsafe.
  if (!/^[A-Za-z][A-Za-z'’-]{1,}$/.test(name)) return 'Hi,';
  return `Hi ${name},`;
}

function companyOf(lead = {}) {
  return String(lead.company || '').trim();
}

const SIGN_OFF = 'Deins';

/**
 * The canonical Gmail thread to reply into, if there genuinely is one.
 *
 * Both the send paths and the reply paths already stash gmailThreadId (and the
 * RFC Message-ID) on their activity metadata, so the conversation is recoverable
 * from the timeline. The newest one wins: that is the live thread.
 *
 * Returns null when nothing verifiable exists — and that is the whole point. A
 * "Re:" subject on a message that is NOT in the prior thread is a lie to the
 * recipient's mail client: it breaks threading, and it pretends to continue a
 * conversation the message is not part of.
 */
function resolveSequenceThread(activities = [], options = {}) {
  let best = null;
  for (const row of activities) {
    let metadata = {};
    try { metadata = JSON.parse(row.metadata || '{}'); } catch (_) { continue; }
    const threadId = String(metadata.gmailThreadId || '').trim();
    if (!threadId) continue;
    if (options.senderInboxId
      && String(metadata.senderInboxId || '').trim() !== String(options.senderInboxId)) continue;
    const at = String(row.occurredAt || '');
    if (!best || at > best.at) {
      best = {
        at,
        threadId,
        // Message-ID of the last known message in that thread, so the reply
        // chains correctly rather than just landing in the same thread.
        rfcMessageId: String(metadata.rfcMessageId || '').trim(),
      };
    }
  }
  if (!best) return null;
  return { threadId: best.threadId, rfcMessageId: best.rfcMessageId || '' };
}

const SENDER_EVIDENCE_EVENTS = Object.freeze([
  'initial_email_sent', 'follow_up_sent', 'sequence_step_sent', 'booking_link_sent',
  'human_response_sent', 'positive_reply', 'meeting_requested', 'late_reply',
  'question_reply', 'negative_reply', 'unsubscribe_reply', 'wrong_person_reply',
]);

function provenSequenceSenderId(twin = {}, activities = []) {
  const ids = new Set();
  const persisted = String(twin.senderInboxId || '').trim();
  if (persisted && (Number(twin.emailStep || 0) > 0 || String(twin.emailStatus || '').trim())) ids.add(persisted);
  for (const row of activities) {
    if (!SENDER_EVIDENCE_EVENTS.includes(String(row.eventType || ''))) continue;
    const id = String(sequenceMetadata(row).senderInboxId || '').trim();
    if (id) ids.add(id);
  }
  if (ids.size > 1) return { ok: false, reason: 'sender ownership conflict' };
  if (!ids.size) return { ok: false, reason: 'sender ownership is not proven' };
  return { ok: true, senderInboxId: [...ids][0] };
}

function automaticEnrollmentDecision(input = {}) {
  const { twin = {}, activities = [], verdict = {}, senderProof = null,
    thread = null, callState = null, hotState = null, now = Date.now() } = input;
  const state = deriveSequenceState(activities);
  if (state.status !== SEQUENCE_STATUS.NONE) return { enroll: false, reason: 'sequence state already exists' };
  const sequenceId = String(verdict.offer || '');
  if (!sequenceId) return { enroll: false, reason: 'no unambiguous journey applies' };
  if (verdict.stopReason) return { enroll: false, reason: verdict.stopReason };
  if (!senderProof?.ok) return { enroll: false, reason: senderProof?.reason || 'sender ownership is not proven' };
  if (!thread?.threadId) return { enroll: false, reason: 'conversation thread is not proven for the owning sender' };

  const explicitLifecycle = ['no_show_recovery_v1', 'cancelled_rebook_v1', 'timing_recontact_v1'].includes(sequenceId);
  if (hasManualHold(twin) && !explicitLifecycle) {
    return { enroll: false, reason: 'manual hold — demo and Hot automation require human review' };
  }
  if (sequenceId === 'demo_follow_up_v1'
    && !activities.some(row => String(row.eventType || '') === 'booking_link_sent')) {
    return { enroll: false, reason: 'verified booking-link evidence is missing' };
  }
  if (sequenceId === 'hot_stale_v1'
    && !(hotState && hotState.waitingOn === 'waiting_on_prospect'
      && ['follow_up_due', 'overdue', 'stale', 'severely_stale'].includes(hotState.staleness))) {
    return { enroll: false, reason: 'Hot lead is not due while waiting on the prospect' };
  }
  if (sequenceId === 'no_show_recovery_v1' && String(callState?.status || '') !== 'no_show') {
    return { enroll: false, reason: 'explicit no-show event is missing' };
  }
  if (sequenceId === 'cancelled_rebook_v1' && String(callState?.status || '') !== 'cancelled') {
    return { enroll: false, reason: 'trusted cancellation event is missing' };
  }
  const anchorTypes = sequenceId === 'demo_follow_up_v1' ? ['booking_link_sent']
    : sequenceId === 'no_show_recovery_v1' ? ['meeting_no_show']
      : sequenceId === 'cancelled_rebook_v1' ? ['meeting_cancelled'] : [];
  const anchorAt = latestAt(activities, anchorTypes) || null;
  if (!anchorAt && sequenceId !== 'hot_stale_v1') return { enroll: false, reason: 'canonical lifecycle anchor is missing' };
  const decisionAnchor = anchorAt || String(hotState?.lastInteractionAt || '');
  const laterInbound = latestAt(activities, INBOUND_REPLY_EVENTS);
  const laterHuman = latestAt(activities, HUMAN_INTERVENTION_EVENTS);
  const laterBooking = latestAt(activities, BOOKING_EVENTS);
  if (decisionAnchor && [laterInbound, laterHuman, laterBooking].some(at => at && at > decisionAnchor)) {
    return { enroll: false, reason: 'newer reply, human response, or booking supersedes the automation trigger' };
  }
  return {
    enroll: true, sequenceId, enrolledAt: anchorAt || new Date(now).toISOString(),
    authorization: explicitLifecycle ? 'explicit_lifecycle' : 'automatic_canonical_state',
    senderInboxId: senderProof.senderInboxId, gmailThreadId: thread.threadId,
  };
}

function automaticEnrollmentEventId(leadId, sequenceId, anchorAt) {
  return `seq-enroll:${leadId}:${sequenceId}:${String(anchorAt || '').replace(/[^0-9TZ]/g, '')}`;
}

// One builder per journey and step. Returns { subject, body, replyToThread }.
const SEQUENCE_COPY = Object.freeze({
  demo_follow_up_v1: [
    (lead) => ({
      subjectThread: `Re: a quick demo I built for ${companyOf(lead) || 'your business'}`,
      subjectFresh: `Following up on the demo for ${companyOf(lead) || 'your business'}`,
      body: [salutation(lead),
        '',
        'Just checking you saw the demo I put together — happy to walk through it live if that is easier.',
        '',
        'Would a short call this week or next suit you better?',
        '', SIGN_OFF].join('\n'),
    }),
    (lead) => ({
      subjectThread: `Re: a quick demo I built for ${companyOf(lead) || 'your business'}`,
      subjectFresh: `Closing the loop on the demo for ${companyOf(lead) || 'your business'}`,
      body: [salutation(lead),
        '',
        'Last note from me on this one — I do not want to clutter your inbox.',
        '',
        'If the timing is not right, just say the word and I will close the file. If it is, reply here and I will send a couple of times.',
        '', SIGN_OFF].join('\n'),
    }),
  ],
  hot_stale_v1: [
    (lead) => ({
      subjectThread: `Re: ${companyOf(lead) || 'your enquiry'}`,
      subjectFresh: `Following up — ${companyOf(lead) || 'your enquiry'}`,
      body: [salutation(lead),
        '',
        'Following up on my last note — did you get a chance to look?',
        '',
        'Happy to answer anything outstanding, or set up a short call if that is easier.',
        '', SIGN_OFF].join('\n'),
    }),
    (lead) => ({
      subjectThread: `Re: ${companyOf(lead) || 'your enquiry'}`,
      subjectFresh: `Closing the loop — ${companyOf(lead) || 'your enquiry'}`,
      body: [salutation(lead),
        '',
        'I will leave this with you rather than keep chasing.',
        '',
        'If it is a timing thing, tell me roughly when to come back and I will. If it is a no, that is genuinely fine too.',
        '', SIGN_OFF].join('\n'),
    }),
  ],
  no_show_recovery_v1: [
    (lead) => ({
      subjectThread: `Re: our call — ${companyOf(lead) || 'rescheduling'}`,
      subjectFresh: `Rescheduling our call — ${companyOf(lead) || ''}`.trim(),
      body: [salutation(lead),
        '',
        'Sorry we missed each other — things come up.',
        '',
        'Want me to send over a couple of new times?',
        '', SIGN_OFF].join('\n'),
    }),
    (lead) => ({
      subjectThread: `Re: our call — ${companyOf(lead) || 'rescheduling'}`,
      subjectFresh: `One last note about our call — ${companyOf(lead) || ''}`.trim(),
      body: [salutation(lead),
        '',
        'Last one from me — I will assume the timing is not right unless I hear otherwise.',
        '',
        'If you would still like to talk, just reply and I will get something in the diary.',
        '', SIGN_OFF].join('\n'),
    }),
  ],
  cancelled_rebook_v1: [
    (lead) => ({
      subjectThread: `Re: rescheduling our call — ${companyOf(lead) || ''}`.trim(),
      subjectFresh: `Rescheduling our call — ${companyOf(lead) || ''}`.trim(),
      body: [salutation(lead),
        '',
        'No problem at all about cancelling.',
        '',
        'Would you like me to send a few new times, or is it better to park this for now?',
        '', SIGN_OFF].join('\n'),
    }),
    (lead) => ({
      subjectThread: `Re: rescheduling our call — ${companyOf(lead) || ''}`.trim(),
      subjectFresh: `Closing the loop on our call — ${companyOf(lead) || ''}`.trim(),
      body: [salutation(lead),
        '',
        'Closing the loop on this one.',
        '',
        'If you would like to pick it back up, reply here any time and I will sort a new time.',
        '', SIGN_OFF].join('\n'),
    }),
  ],
  timing_recontact_v1: [
    (lead) => ({
      subjectThread: `Re: circling back — ${companyOf(lead) || ''}`.trim(),
      subjectFresh: `Circling back — ${companyOf(lead) || ''}`.trim(),
      body: [salutation(lead),
        '',
        'You mentioned the timing was not right when we last spoke, so I am circling back as promised.',
        '',
        'Is this worth a look now, or should I check in again later in the year?',
        '', SIGN_OFF].join('\n'),
    }),
  ],
});

/**
 * Build the exact email for one step. Pure and deterministic, so the dry-run
 * preview and the sender produce byte-identical output.
 */
function buildSequenceEmail(sequenceId, step, lead = {}, options = {}) {
  const steps = SEQUENCE_COPY[sequenceId];
  if (!steps) return { error: `unknown sequence "${sequenceId}"` };
  const builder = steps[step - 1];
  if (!builder) return { error: `sequence "${sequenceId}" has no step ${step}` };
  const built = builder(lead);

  // "Re:" is used ONLY when the message really is going into that Gmail thread.
  // Without a verifiable thread it would break the recipient's threading and
  // imply a conversation this message is not part of, so a standalone subject
  // is used instead.
  const thread = options.thread && String(options.thread.threadId || '').trim()
    ? options.thread : null;
  const subject = thread ? built.subjectThread : built.subjectFresh;
  return {
    sequenceId, step, subject,
    body: built.body,
    replyToThread: Boolean(thread),
    threadId: thread ? thread.threadId : '',
    inReplyTo: thread ? (thread.rfcMessageId || '') : '',
    references: thread ? (thread.rfcMessageId || '') : '',
  };
}

/** Deterministic id so a step can never be recorded — or sent — twice. */
function sequenceStepEventId(leadId, sequenceId, step) {
  return `seq:${leadId}:${sequenceId}:${step}`;
}

module.exports = {
  SEQUENCES, SEQUENCE_IDS, SEQUENCE_PRECEDENCE, SEQUENCE_TIMING,
  SEQUENCE_STATUS, SEQUENCE_OWNER, SEQUENCE_EVENTS, SEQUENCE_EVENT_TYPES,
  INBOUND_REPLY_EVENTS, HUMAN_INTERVENTION_EVENTS, BOOKING_EVENTS,
  hasManualHold, stageSequenceSuppressionReason, sequenceStopReason,
  deriveSequenceState, nextStepDueAt, evaluateStageSequence, sequenceStepEventId,
  SEQUENCE_COPY, buildSequenceEmail, resolveSequenceThread, provenSequenceSenderId,
  automaticEnrollmentDecision, automaticEnrollmentEventId,
};
