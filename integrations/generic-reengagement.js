'use strict';
/**
 * generic-reengagement.js — the generic_follow_up_v1 journey. PURE / READ-ONLY.
 * ─────────────────────────────────────────────────────────────────────────────
 * A separate re-engagement journey for prospects who finished the ORIGINAL cold
 * sequence, never meaningfully replied, and are still safe to contact.
 *
 * It is NOT Email 4/5. The cold cadence (FOLLOW_UP_SEQUENCE in outreach-agent.js)
 * is untouched. It is also not a stage journey: demo/Hot/no-show/cancelled/timing
 * all begin AFTER meaningful intent, and this one begins after silence.
 *
 * WHY A FRESH THREAD IS MANDATORY, NOT A FALLBACK
 * -----------------------------------------------
 * The 2026-09-09 bulk reconciliation proved sender ownership for 329/329
 * historical prospects but a UNIQUE Gmail thread for only 2 — and both of those
 * two are disqualified by an unsubscribe / not-interested state. Requiring an
 * old thread would therefore address zero prospects. Worse, reusing an
 * AMBIGUOUS historical thread would mean replying into whichever of several
 * competing conversations happened to sort last, which is a lie to the
 * recipient's mail client and to the operator reading the timeline.
 *
 * So Step 1 deliberately opens a NEW conversation. Sender proof stays
 * mandatory — we always mail from the mailbox that provably owns the prospect.
 * Step 2 then pins to the thread STEP 1 ITSELF created, which is provable
 * because we recorded the provider's own threadId on the step-1 send. The old
 * historical thread is never consulted by this journey at any step.
 *
 * SAFETY POSTURE
 * --------------
 * Pure: no sheets client, no network, no writes. Every function returns a
 * verdict with an explicit blocker list, and every unclear case fails CLOSED.
 */

const { addBusinessDays } = require('./pipeline-state');
const { malformedEmailReason } = require('./canonical-reply');
const { classify: classifyLeadEmail } = require('../check-leads');

const SEQUENCE_ID = 'generic_follow_up_v1';
const LABEL = 'Automated re-engagement';

const DAY_MS = 86400000;
const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Timing and rollout policy. Every value is configurable so the business can
 * retune the window without touching journey logic.
 *
 * autoEnrollAfter is the HISTORICAL BACKFILL GATE. A lead may only auto-enrol
 * when its final cold email landed at or after this instant, so deploying this
 * code cannot sweep the historical backlog into sending: every historical final
 * cold email predates it. Enrolling that backlog is a separate, explicitly
 * authorised operation (see selectPilotCohort) and never happens on deploy.
 */
function genericConfig(env = process.env) {
  return Object.freeze({
    sequenceId: SEQUENCE_ID,
    label: LABEL,
    maxSteps: 2,
    // Step 1 may not fire until the prospect has been quiet this long after the
    // FINAL cold email. Step 2 follows in business days, matching the recovery
    // journeys' clock rather than the cold cadence's calendar-day clock.
    minQuietDays: num(env.GENERIC_REENGAGEMENT_MIN_DAYS, 30),
    maxQuietDays: num(env.GENERIC_REENGAGEMENT_MAX_DAYS, 60),
    step2BusinessDays: num(env.GENERIC_REENGAGEMENT_STEP2_BUSINESS_DAYS, 8),
    // Master switch. Off means the journey never enrols and never sends.
    enabled: String(env.GENERIC_REENGAGEMENT_ENABLED || '') === '1',
    // Historical backfill gate — see above. Empty string disables auto-enrolment
    // entirely, which is the safest possible reading of a missing config.
    autoEnrollAfter: String(env.GENERIC_REENGAGEMENT_AUTO_ENROLL_AFTER
      || '2026-09-09T00:00:00.000Z'),
    // Hard ceiling on one authorised pilot enrolment batch.
    pilotLimit: num(env.GENERIC_REENGAGEMENT_PILOT_LIMIT, 50),
    // Any [REPLY: …] tag in notes disqualifies, including OOO. The historical
    // cohort predates the canonical activity model, so a notes tag is the ONLY
    // surviving evidence that a person wrote back; treating it as anything
    // weaker than a reply would mail someone who already answered.
    treatAnyReplyTagAsReply: String(env.GENERIC_REENGAGEMENT_ALLOW_OOO || '') !== '1',
  });
}

// ── LEGACY REPLY SIGNALS ────────────────────────────────────────────────────
// The canonical activity model is authoritative for anything recent. For the
// historical cohort it is silent — those rows carry their entire reply history
// in the ColdEmail notes cell — so both are consulted and either one blocks.
const REPLY_TAG = /\[REPLY:/i;
const NEGATIVE_TAG = /\[REPLY: (Not Interested|Unsub)/i;
const BOUNCE_TAG = /\[(BOUNCED|SUPPRESS)/i;
const MANUAL_HOLD_TAG = '[MANUAL HOLD]';

const norm = value => String(value || '').trim().toLowerCase();
const parseMeta = row => { try { return JSON.parse(row.metadata || '{}'); } catch (_) { return {}; } };

function latestAt(activities, types) {
  let latest = '';
  for (const row of activities || []) {
    if (!types.includes(String(row.eventType || ''))) continue;
    const at = String(row.occurredAt || '');
    if (at > latest) latest = at;
  }
  return latest || null;
}

/** The instant the original cold sequence last touched this prospect. */
function finalColdEmailAt(twin = {}, activities = []) {
  const fromActivity = latestAt(activities, ['initial_email_sent', 'follow_up_sent']);
  const fromTwin = String(twin.lastEmailedAt || '').trim();
  if (fromActivity && fromTwin) return fromActivity > fromTwin ? fromActivity : fromTwin;
  return fromActivity || fromTwin || null;
}

function quietDays(finalAt, now) {
  const at = Date.parse(finalAt || '');
  if (!Number.isFinite(at)) return null;
  return Math.floor((new Date(now).getTime() - at) / DAY_MS);
}

/**
 * Is this prospect eligible for generic_follow_up_v1 right now?
 *
 * Returns EVERY blocker rather than the first, so an operator previewing the
 * cohort can see exactly why a lead was excluded instead of re-running the
 * filter one condition at a time.
 *
 * @param input { twin, boardLead, activities, sequenceState, callState,
 *                suppressedEmails, senderProof, now, config, forPilot }
 */
function genericEligibility(input = {}) {
  const {
    twin = {}, boardLead = null, activities = [], sequenceState = null,
    callState = null, suppressedEmails = new Set(), senderProof = null,
    now = Date.now(), config = genericConfig(), forPilot = false,
  } = input;

  // Lazily required: stage-sequences owns the canonical event vocabularies and
  // itself imports this module for the journey definition. Requiring it here
  // rather than at module load keeps that dependency one-way at load time.
  const { INBOUND_REPLY_EVENTS, HUMAN_INTERVENTION_EVENTS, BOOKING_EVENTS,
    deriveSequenceState, SEQUENCE_STATUS } = require('./stage-sequences');

  const blockers = [];
  const notes = String(twin.notes || '');
  const email = String(twin.email || '').trim();

  // ── identity ─────────────────────────────────────────────────────────────
  const identityIssue = malformedEmailReason(email)
    || (classifyLeadEmail(email) !== 'CLEAN' ? `address classified ${classifyLeadEmail(email)}` : '');
  if (!twin.id) blockers.push('no canonical lead id');
  if (identityIssue) blockers.push(`invalid identity (${identityIssue})`);

  // ── the original cold sequence must be FINISHED ──────────────────────────
  // 'done' is what the cold sender itself writes when it runs past the last
  // step, so it is the canonical completion marker rather than a step count
  // this module would have to keep in sync.
  const status = norm(twin.emailStatus);
  if (status !== 'done') blockers.push(`cold sequence is not complete (emailStatus "${twin.emailStatus || ''}")`);

  // ── suppression / opt-out / bounce ───────────────────────────────────────
  if (suppressedEmails instanceof Set && suppressedEmails.has(norm(email))) blockers.push('on the durable suppression list');
  if (BOUNCE_TAG.test(notes)) blockers.push('bounced or suppressed by tag');
  if (NEGATIVE_TAG.test(notes)) blockers.push('negative reply or unsubscribe recorded in notes');
  if (norm(twin.stage) === 'unsubscribed') blockers.push('ColdEmail stage is Unsubscribed');
  if (config.treatAnyReplyTagAsReply && REPLY_TAG.test(notes) && !NEGATIVE_TAG.test(notes)) {
    blockers.push('a reply is recorded in notes');
  }
  if (notes.includes(MANUAL_HOLD_TAG)) blockers.push('MANUAL HOLD');

  // ── nobody may have written back, by hand or by machine ──────────────────
  const replyAt = latestAt(activities, INBOUND_REPLY_EVENTS);
  if (replyAt) blockers.push('the prospect replied');
  const humanAt = latestAt(activities, HUMAN_INTERVENTION_EVENTS);
  if (humanAt) blockers.push('a human took the conversation over');
  const bookingAt = latestAt(activities, BOOKING_EVENTS);
  if (bookingAt) blockers.push('a meeting was booked');
  if (callState && ['scheduled', 'rescheduled', 'outcome_pending'].includes(String(callState.status || ''))) {
    blockers.push('a meeting is on the calendar');
  }

  // ── terminal / pipeline ownership ────────────────────────────────────────
  const boardStage = norm(boardLead && boardLead.stage);
  if (['closed_won', 'closed_lost', 'closed', 'won', 'lost'].includes(boardStage)
    || ['closed_won', 'closed_lost', 'won', 'lost'].includes(norm(twin.stage))) {
    blockers.push('the opportunity is closed');
  }

  // ── no other journey may already own this lead ───────────────────────────
  const state = sequenceState || deriveSequenceState(activities);
  if (state && state.status && state.status !== SEQUENCE_STATUS.NONE) {
    blockers.push(`another journey state exists (${state.sequenceId || 'unknown'} ${state.status})`);
  }

  // ── sender ownership must be PROVEN ──────────────────────────────────────
  if (!senderProof || !senderProof.ok) {
    blockers.push(senderProof?.reason || 'sender ownership is not proven');
  }

  // ── age window ───────────────────────────────────────────────────────────
  const finalAt = finalColdEmailAt(twin, activities);
  const age = quietDays(finalAt, now);
  if (!finalAt || age === null) blockers.push('no final cold email date could be derived');
  else {
    if (age < config.minQuietDays) blockers.push(`only ${age}d since the final cold email (needs ${config.minQuietDays})`);
    if (age > config.maxQuietDays) blockers.push(`${age}d since the final cold email exceeds the ${config.maxQuietDays}d window — recycle/requalify case`);
  }

  // ── historical backfill gate ─────────────────────────────────────────────
  // Skipped for an explicitly authorised pilot, which is the ONLY way a
  // historical lead may ever be enrolled.
  let backfillBlocked = false;
  if (!forPilot) {
    const cutoff = String(config.autoEnrollAfter || '');
    if (!cutoff) { blockers.push('automatic enrolment is disabled (no rollout cutoff configured)'); backfillBlocked = true; }
    else if (finalAt && finalAt < cutoff) {
      blockers.push(`historical backfill gate: final cold email ${finalAt} predates the rollout cutoff ${cutoff}`);
      backfillBlocked = true;
    }
  }

  const eligible = blockers.length === 0;
  return {
    sequenceId: SEQUENCE_ID,
    eligible,
    blockers,
    reason: eligible
      ? `quiet ${age}d since the final cold email; cold sequence complete, no reply, no meeting, sender proven`
      : blockers[0],
    ageDays: age,
    finalColdEmailAt: finalAt,
    senderInboxId: senderProof && senderProof.ok ? senderProof.senderInboxId : null,
    // Step 1 is due the moment the quiet threshold is crossed, so enrolment and
    // due-date derivation agree rather than drifting apart.
    projectedStep1DueAt: finalAt
      ? new Date(Date.parse(finalAt) + config.minQuietDays * DAY_MS).toISOString()
      : null,
    backfillBlocked,
    campaign: String(twin.campaign || '').trim() || '(none)',
  };
}

/**
 * The Gmail thread this journey must use for a given step.
 *
 * Step 1  → FRESH. Never the historical thread, even when one happens to be
 *           provable: this journey's whole premise is a new conversation.
 * Step 2  → PINNED to the thread Step 1 created, proven from Step 1's own send
 *           record. Fails closed when that proof is missing, so Step 2 can
 *           never silently fall back to a fresh thread or an old one.
 */
function genericJourneyThread(activities = [], options = {}) {
  const step = Number(options.step) || 1;
  const senderInboxId = String(options.senderInboxId || '').trim();
  if (step === 1) {
    return { ok: true, mode: 'fresh', thread: null, reason: 'Step 1 deliberately opens a new conversation' };
  }
  const sends = (activities || [])
    .filter(row => String(row.eventType || '') === 'sequence_step_sent')
    .map(row => ({ at: String(row.occurredAt || ''), meta: parseMeta(row) }))
    .filter(item => String(item.meta.sequenceId || '') === SEQUENCE_ID && Number(item.meta.step) === 1)
    .sort((a, b) => a.at.localeCompare(b.at));
  const step1 = sends[sends.length - 1];
  if (!step1) return { ok: false, mode: 'blocked', thread: null, reason: 'Step 1 send record is missing' };
  if (!String(step1.meta.providerMessageId || '').trim()) {
    return { ok: false, mode: 'blocked', thread: null, reason: 'Step 1 provider delivery is not proven' };
  }
  const threadId = String(step1.meta.gmailThreadId || '').trim();
  if (!threadId) return { ok: false, mode: 'blocked', thread: null, reason: 'Step 1 did not persist a Gmail thread id' };
  if (senderInboxId && String(step1.meta.senderInboxId || '').trim() !== senderInboxId) {
    return { ok: false, mode: 'blocked', thread: null, reason: 'Step 1 was sent from a different mailbox' };
  }
  return {
    ok: true, mode: 'pinned',
    thread: { threadId, rfcMessageId: String(step1.meta.rfcMessageId || '').trim() },
    reason: 'pinned to the thread Step 1 created',
  };
}

/** When the next step of this journey is due. */
function genericNextDueAt(state = {}, input = {}) {
  const config = input.config || genericConfig();
  const step = (state.step || 0) + 1;
  if (step > config.maxSteps) return null;
  if (step === 1) {
    // Enrolment only happens once the quiet threshold has already passed, so
    // Step 1 is due immediately; the projected date is kept for the preview.
    return state.enrolledAt || input.projectedStep1DueAt || null;
  }
  if (!state.lastStepAt) return null;
  return addBusinessDays(state.lastStepAt, config.step2BusinessDays);
}

/**
 * Deterministic pilot cohort: oldest eligible first, tie-broken by lead id so
 * the same input always yields the same cohort in the same order. Bounded by an
 * explicit limit that the caller must pass — there is no unbounded form.
 */
function selectPilotCohort(candidates = [], options = {}) {
  const config = options.config || genericConfig();
  const requested = Number.isFinite(Number(options.limit)) ? Number(options.limit) : config.pilotLimit;
  const limit = Math.max(0, Math.min(requested, config.pilotLimit));
  const eligible = candidates.filter(item => item && item.eligible);
  const ordered = eligible.slice().sort((a, b) => {
    const at = String(a.finalColdEmailAt || '');
    const bt = String(b.finalColdEmailAt || '');
    if (at !== bt) return at.localeCompare(bt);            // oldest first
    return String(a.leadId || '').localeCompare(String(b.leadId || ''));
  });
  return {
    limit,
    eligibleCount: eligible.length,
    selected: ordered.slice(0, limit),
    deferred: Math.max(0, ordered.length - limit),
  };
}

/** Deterministic enrolment id, so the same authorised pilot cannot double-enrol. */
function genericEnrollmentEventId(leadId, anchorAt) {
  return `seq-enroll:${leadId}:${SEQUENCE_ID}:${String(anchorAt || '').replace(/[^0-9TZ]/g, '')}`;
}

// ── COPY / TEMPLATES ────────────────────────────────────────────────────────
/**
 * The business copy is decided separately from this task, so journey mechanics
 * must not hardcode it. Templates come from configuration and are rendered with
 * a tiny, explicit placeholder vocabulary.
 *
 * The shipped default is a PLACEHOLDER, and it is marked as one. Anything that
 * renders a placeholder reports isPlaceholder:true and the send path refuses to
 * deliver it — so shipping this code without copy cannot mail a prospect
 * scaffolding text. That is a deliberate fail-closed, not an oversight.
 */
const PLACEHOLDER_MARK = '{{REPLACE_BEFORE_SENDING}}';

const DEFAULT_TEMPLATES = Object.freeze([
  Object.freeze({
    subjectFresh: `${PLACEHOLDER_MARK} re-engagement step 1 — {{company}}`,
    subjectThread: `${PLACEHOLDER_MARK} re-engagement step 1 — {{company}}`,
    body: `${PLACEHOLDER_MARK}\n\nStep 1 body copy has not been configured yet.`,
  }),
  Object.freeze({
    subjectFresh: `${PLACEHOLDER_MARK} re-engagement step 2 — {{company}}`,
    subjectThread: `${PLACEHOLDER_MARK} re-engagement step 2 — {{company}}`,
    body: `${PLACEHOLDER_MARK}\n\nStep 2 body copy has not been configured yet.`,
  }),
]);

/**
 * Templates for this journey, newest configuration wins:
 *   1. an explicit per-campaign override passed by the caller
 *   2. GENERIC_REENGAGEMENT_TEMPLATES (JSON array of {subjectFresh,subjectThread,body})
 *   3. the placeholder default
 * Malformed JSON falls back to the placeholder rather than throwing, so a bad
 * config cannot take the sending agent down — it just refuses to send.
 */
function genericTemplates(options = {}) {
  const { env = process.env, campaignTemplates = null } = options;
  if (Array.isArray(campaignTemplates) && campaignTemplates.length) return campaignTemplates;
  const raw = String(env.GENERIC_REENGAGEMENT_TEMPLATES || '').trim();
  if (!raw) return DEFAULT_TEMPLATES;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length && parsed.every(item => item && item.body)) return parsed;
  } catch (_) { /* fall through to the placeholder */ }
  return DEFAULT_TEMPLATES;
}

function firstNameOf(lead = {}) {
  const raw = String(lead.contactName || lead.first || '').trim();
  const parts = raw.split(/\s+/).filter(Boolean);
  const candidate = /^(dr|mr|mrs|ms|the)$/i.test(parts[0] || '') ? (parts[1] || '') : (parts[0] || '');
  // A single token that is really the company name, or is not a plausible
  // person's name, is worse than no name at all.
  const company = String(lead.company || '').trim().toLowerCase();
  if (!candidate) return '';
  if (company.split(/\s+/).some(word => word.length > 2 && word === candidate.toLowerCase())) return '';
  return /^[A-Za-z][A-Za-z'’-]{1,}$/.test(candidate) ? candidate : '';
}

function renderGenericCopy(step, lead = {}, options = {}) {
  const templates = genericTemplates(options);
  const template = templates[Number(step) - 1];
  if (!template) return { error: `${SEQUENCE_ID} has no step ${step}` };
  const name = firstNameOf(lead);
  const company = String(lead.company || '').trim();
  const fill = value => String(value || '')
    .split('{{firstName}}').join(name)
    .split('{{company}}').join(company || 'your business')
    .split('{{salutation}}').join(name ? `Hi ${name},` : 'Hi,');
  const rendered = {
    subjectFresh: fill(template.subjectFresh || template.subject),
    subjectThread: fill(template.subjectThread || template.subject),
    body: fill(template.body),
  };
  rendered.isPlaceholder = [rendered.subjectFresh, rendered.subjectThread, rendered.body]
    .some(value => String(value).includes(PLACEHOLDER_MARK));
  return rendered;
}

module.exports = {
  GENERIC_SEQUENCE_ID: SEQUENCE_ID,
  GENERIC_LABEL: LABEL,
  GENERIC_PLACEHOLDER_MARK: PLACEHOLDER_MARK,
  genericConfig, genericEligibility, genericJourneyThread, genericNextDueAt,
  selectPilotCohort, genericEnrollmentEventId, finalColdEmailAt, quietDays,
  genericTemplates, renderGenericCopy,
};
