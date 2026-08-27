'use strict';
/**
 * crm-health.js — "is the CRM operating correctly right now?" PURE.
 * ─────────────────────────────────────────────────────────────────────────────
 * A diagnostic layer, not a repair layer. Every function here reads state and
 * returns findings; nothing writes, sends, promotes, holds, or backfills.
 *
 * The hard design rule is REUSE. A health checker that disagrees with the
 * sender because it re-implemented eligibility would be worse than no checker
 * at all — it would report green while the sender does something else, or cry
 * wolf about behaviour that is actually correct. So every judgement below is
 * delegated to the module that already owns it:
 *
 *   identity/junk email    check-leads.classify           (the sender's own rule)
 *   suppression + holds    pipeline-state                 (tags, resume, automation)
 *   promotion identity     promotion-policy               (fail-closed CE mapping)
 *   reply meaning          canonical-reply                (evidence hierarchy)
 *   hot staleness          pipeline-state.deriveHotState
 *   call lifecycle         pipeline-state.deriveCallLifecycle
 *   sequences              stage-sequences.evaluateStageSequence
 *   bookings               google-calendar
 *   attribution            campaign-versions
 *   funnel reconciliation  funnel-analytics (consumed, never rebuilt)
 *   activity integrity     activity-timeline.inspectActivityIntegrity
 *
 * SEVERITY PHILOSOPHY
 * This CRM carries a lot of legacy data from before most of its instrumentation
 * existed. A dashboard that paints all of that red is useless — people stop
 * reading it, and then a genuine incident hides among 40 permanent warnings. So
 * "critical" is reserved for things that can cause damage right now: automation
 * about to touch a lead it must not, a live feature missing mandatory config,
 * identity ambiguity that could misroute a real action. Historical gaps are
 * INFO. A disabled feature is INFO, never a failure.
 */

const { classify: classifyLeadEmail } = require('../check-leads');
const {
  MANUAL_HOLD_TAG, hasManualHold, manualHoldReleased, stageRequiresHold,
  deriveAutomationState, automationConflict, AUTOMATION_STATES,
  deriveHotState, deriveCallLifecycle, CALL_STATUS, HOT_STALENESS,
} = require('./pipeline-state');
const { resolvePromotionIdentity } = require('./promotion-policy');
const {
  REPLY_STATE, EVIDENCE_SOURCE, GENUINE_HUMAN_STATES, LEGACY_REPLY_EVENT_TYPES,
  resolveReplyState, resolveCanonicalReplyBoundary, isAfterBoundary,
} = require('./canonical-reply');
const { evaluateStageSequence, SEQUENCE_STATUS } = require('./stage-sequences');
const { LEGACY_UNKNOWN, CAMPAIGN_VERSIONS, parseMetadata, attributionFromActivity } = require('./campaign-versions');
const { inspectActivityIntegrity } = require('./activity-timeline');

const SEVERITY = Object.freeze({
  HEALTHY: 'healthy', INFO: 'info', WARNING: 'warning', CRITICAL: 'critical',
});

// Ordered worst-first. Used for aggregation and sorting; never averaged, so a
// single critical finding can never be diluted by a hundred healthy ones.
const SEVERITY_RANK = Object.freeze({ critical: 3, warning: 2, info: 1, healthy: 0 });

const CATEGORY = Object.freeze({
  IDENTITY: 'identity', REPLY: 'reply', OUTREACH: 'outreach', HOLD: 'manual_hold',
  PIPELINE: 'pipeline', HOT: 'hot', CALL: 'call', SEQUENCE: 'sequence',
  CALENDAR: 'calendar', ATTRIBUTION: 'attribution', FUNNEL: 'funnel',
  ACTIVITY: 'activity', SYNC: 'sync',
});

// A finding's status separates "this feature is off" from "this feature is
// broken". An intentionally disabled feature reports DISABLED and severity
// INFO, which keeps it visible without ever degrading overall health.
const STATUS = Object.freeze({
  PASS: 'pass', FAIL: 'fail', DISABLED: 'disabled', NOT_APPLICABLE: 'not_applicable',
});

// How many affected entity ids travel inside a finding. The aggregate response
// must stay small; the full set is reachable through the drill-down endpoint.
const SAMPLE_LIMIT = 10;

const norm = value => String(value || '').trim().toLowerCase();
const isoOrNull = value => {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const daysBetween = (a, b) => Math.floor((new Date(a).getTime() - new Date(b).getTime()) / 86400000);

/**
 * One finding. `affected` is the true count; `sample` is bounded. Callers
 * render from these fields directly — nothing here requires parsing prose.
 */
function finding({
  id, category, severity = SEVERITY.HEALTHY, status = STATUS.PASS,
  summary, affected = 0, sample = [], evidence = {}, requiresHumanReview = false,
  classification = null,
}) {
  return {
    id, category, severity, status, summary,
    affected,
    sample: sample.slice(0, SAMPLE_LIMIT),
    sampleTruncated: sample.length > SAMPLE_LIMIT,
    evidence,
    requiresHumanReview,
    // What KIND of problem this is, so a reader knows whether to act now or
    // file it: automation_risk | data_quality | operational | historical |
    // disabled_feature.
    classification,
  };
}

const pass = (id, category, summary, evidence = {}) =>
  finding({ id, category, severity: SEVERITY.HEALTHY, status: STATUS.PASS, summary, evidence });

const disabled = (id, category, summary, evidence = {}) =>
  finding({
    id, category, severity: SEVERITY.INFO, status: STATUS.DISABLED, summary, evidence,
    classification: 'disabled_feature',
  });

// ── INDEXING ────────────────────────────────────────────────────────────────

function buildIndex({ leads = [], boardLeads = [], activities = [] }) {
  const byId = new Map();
  const byEmail = new Map();
  // Indexing runs BEFORE the per-check error handling, so it must tolerate junk
  // on its own. A diagnostic layer that crashes on a null row would take down
  // the very endpoint you open to find out what is wrong.
  const rows = value => (Array.isArray(value) ? value : []).filter(Boolean);
  leads = rows(leads); boardLeads = rows(boardLeads); activities = rows(activities);
  for (const lead of leads) {
    if (!lead.id) continue;
    byId.set(String(lead.id), lead);
    const email = norm(lead.email);
    if (!email) continue;
    const bucket = byEmail.get(email) || [];
    bucket.push(lead);
    byEmail.set(email, bucket);
  }
  const activityByLead = new Map();
  for (const row of activities) {
    const key = String(row.sourceLeadId || '').trim()
      || String(row.leadId || '').replace(/^CE-/, '').trim();
    if (!key) continue;
    const bucket = activityByLead.get(key) || [];
    bucket.push(row);
    activityByLead.set(key, bucket);
  }
  for (const bucket of activityByLead.values()) {
    bucket.sort((a, b) => String(a.occurredAt || '').localeCompare(String(b.occurredAt || '')));
  }
  // Board -> ColdEmail using the SAME rule promotion uses, so health and
  // promotion can never disagree about who a lead is.
  const boardToLead = new Map();
  for (const board of boardLeads) {
    const direct = String(board.id || '').replace(/^CE-/, '').trim();
    if (String(board.id || '').startsWith('CE-') && byId.has(direct)) {
      boardToLead.set(board.id, direct);
      continue;
    }
    const matches = byEmail.get(norm(board.email)) || [];
    if (matches.length === 1) boardToLead.set(board.id, matches[0].id);
  }
  return { byId, byEmail, activityByLead, boardToLead };
}

// ── 1. IDENTITY ─────────────────────────────────────────────────────────────

function identityChecks({ leads, boardLeads }, index) {
  const out = [];

  // Malformed addresses, judged by the sender's own classifier so health and
  // sending share one definition of "junk".
  const malformed = leads
    .filter(lead => lead.email && classifyLeadEmail(lead.email) === 'MALFORMED')
    .map(lead => ({ id: lead.id, company: lead.company, email: lead.email, verdict: 'MALFORMED' }));
  out.push(malformed.length
    ? finding({
      id: 'identity.malformed_email', category: CATEGORY.IDENTITY,
      severity: SEVERITY.WARNING, status: STATUS.FAIL,
      summary: `${malformed.length} ColdEmail row(s) hold a malformed address. The sender already refuses these, so nothing can be mailed to them — but they are unreachable and their records cannot be trusted as reply evidence.`,
      affected: malformed.length, sample: malformed,
      classification: 'data_quality', requiresHumanReview: true,
    })
    : pass('identity.malformed_email', CATEGORY.IDENTITY, 'Every ColdEmail address passes the sender\'s own validity classifier.'));

  // Duplicate normalized identities.
  const duplicates = [...index.byEmail.entries()]
    .filter(([, bucket]) => bucket.length > 1)
    .map(([email, bucket]) => ({ email, count: bucket.length, ids: bucket.map(l => l.id) }));
  out.push(duplicates.length
    ? finding({
      id: 'identity.duplicate_coldemail', category: CATEGORY.IDENTITY,
      severity: SEVERITY.WARNING, status: STATUS.FAIL,
      summary: `${duplicates.length} address(es) appear on more than one ColdEmail row. Promotion fails closed on these, so an inbound reply cannot be attributed to a single lead.`,
      affected: duplicates.length, sample: duplicates,
      classification: 'data_quality', requiresHumanReview: true,
    })
    : pass('identity.duplicate_coldemail', CATEGORY.IDENTITY, 'Every ColdEmail address maps to exactly one row.'));

  // Board rows that cannot be tied to outreach. Expected for other channels, so
  // this is disclosure, not an error.
  const unmapped = boardLeads
    .filter(board => !index.boardToLead.has(board.id))
    .map(board => ({ id: board.id, stage: board.stage, email: board.email || '' }));
  out.push(unmapped.length
    ? finding({
      id: 'identity.board_without_outreach', category: CATEGORY.IDENTITY,
      severity: SEVERITY.INFO, status: STATUS.PASS,
      summary: `${unmapped.length} of ${boardLeads.length} pipeline opportunities have no canonical ColdEmail mapping. That is expected for leads acquired outside cold outreach; it is disclosed so funnel totals are never mistaken for company-wide totals.`,
      affected: unmapped.length, sample: unmapped,
      classification: 'historical',
    })
    : pass('identity.board_without_outreach', CATEGORY.IDENTITY, 'Every pipeline opportunity maps to a ColdEmail lead.'));

  // Two board rows claiming one ColdEmail lead — genuinely ambiguous for any
  // automation that writes back.
  const collisions = new Map();
  for (const [boardId, leadId] of index.boardToLead) {
    const bucket = collisions.get(leadId) || [];
    bucket.push(boardId);
    collisions.set(leadId, bucket);
  }
  const ambiguous = [...collisions.entries()]
    .filter(([, boards]) => boards.length > 1)
    .map(([leadId, boards]) => ({ leadId, boardIds: boards }));
  out.push(ambiguous.length
    ? finding({
      id: 'identity.ambiguous_board_mapping', category: CATEGORY.IDENTITY,
      severity: SEVERITY.CRITICAL, status: STATUS.FAIL,
      summary: `${ambiguous.length} ColdEmail lead(s) are claimed by more than one pipeline opportunity. Any automation writing back could update the wrong record.`,
      affected: ambiguous.length, sample: ambiguous,
      classification: 'automation_risk', requiresHumanReview: true,
    })
    : pass('identity.ambiguous_board_mapping', CATEGORY.IDENTITY, 'No ColdEmail lead is claimed by two pipeline opportunities.'));

  return out;
}

// ── 2. REPLY INTEGRITY ──────────────────────────────────────────────────────

/**
 * `canonicalReplyBoundary` is the instant canonical reply activity started
 * being written. Before it, a reply with only a legacy tag is a historical
 * limitation. After it, the same shape means ingestion silently failed — a very
 * different problem, and the distinction is the whole point of this check.
 */
function replyChecks({ leads, replyRecords = [], canonicalReplyBoundary = null }, index) {
  const out = [];
  const resolvedBoundary = resolveCanonicalReplyBoundary(canonicalReplyBoundary);
  const boundary = resolvedBoundary.at;
  // A boundary that silently stopped working would disable the very detection
  // it exists for, so a bad override is surfaced rather than swallowed.
  if (resolvedBoundary.error) {
    out.push(finding({
      id: 'reply.boundary_misconfigured', category: CATEGORY.REPLY,
      severity: SEVERITY.WARNING, status: STATUS.FAIL,
      summary: `The canonical-reply boundary is misconfigured (${resolvedBoundary.error}). Post-boundary ingestion-failure detection is DISABLED until it is fixed; historical replies are unaffected.`,
      affected: 1, evidence: { configured: resolvedBoundary.configured },
      classification: 'operational', requiresHumanReview: true,
    }));
  } else {
    out.push(pass('reply.boundary_configured', CATEGORY.REPLY,
      `Canonical-reply ingestion boundary is active from ${boundary}. Replies before it are historical; replies after it are expected to carry canonical activity.`,
      { boundary, source: resolvedBoundary.source }));
  }

  const resolvedByLead = new Map();
  for (const record of replyRecords) {
    const lead = index.byId.get(String(record.leadId));
    if (!lead) continue;
    resolvedByLead.set(lead.id, {
      lead, record,
      resolved: resolveReplyState(lead, { activities: index.activityByLead.get(lead.id) || [] }),
    });
  }

  // Evidence-free reply states.
  const unknown = [...resolvedByLead.values()]
    .filter(entry => entry.resolved.state === REPLY_STATE.UNKNOWN)
    .map(entry => ({
      id: entry.lead.id, company: entry.lead.company,
      reason: entry.resolved.note || 'no evidence', identityIssue: entry.resolved.identityIssue || null,
    }));
  out.push(unknown.length
    ? finding({
      id: 'reply.no_trustworthy_evidence', category: CATEGORY.REPLY,
      severity: SEVERITY.WARNING, status: STATUS.FAIL,
      summary: `${unknown.length} lead(s) look like they replied but carry no trustworthy evidence — no canonical activity and no reply tag. They are reported as unknown rather than being assigned a sentiment.`,
      affected: unknown.length, sample: unknown,
      classification: 'data_quality', requiresHumanReview: true,
    })
    : pass('reply.no_trustworthy_evidence', CATEGORY.REPLY, 'Every reply-bearing lead has evidence behind its classification.'));

  // Legacy-only evidence. Historical before the boundary, a failure after it.
  const legacyOnly = [...resolvedByLead.values()]
    .filter(entry => entry.resolved.source === EVIDENCE_SOURCE.LEGACY_TAG);
  // Strictly after the boundary; an equal or unparseable timestamp stays
  // historical, so ambiguity can never manufacture an ingestion failure.
  const postBoundary = boundary
    ? legacyOnly.filter(entry => isAfterBoundary(entry.record && entry.record.occurredAt, boundary))
    : [];
  const historical = legacyOnly.length - postBoundary.length;

  if (postBoundary.length) {
    out.push(finding({
      id: 'reply.missing_canonical_evidence_post_boundary', category: CATEGORY.REPLY,
      severity: SEVERITY.CRITICAL, status: STATUS.FAIL,
      summary: `${postBoundary.length} reply(ies) arrived AFTER canonical reply storage went live but produced no canonical activity. That points at a current ingestion failure, not a historical gap.`,
      affected: postBoundary.length,
      sample: postBoundary.map(entry => ({
        id: entry.lead.id, company: entry.lead.company, occurredAt: entry.record.occurredAt,
      })),
      evidence: { canonicalReplyBoundary: boundary },
      classification: 'automation_risk', requiresHumanReview: true,
    }));
  }
  out.push(historical > 0
    ? finding({
      id: 'reply.legacy_evidence_only', category: CATEGORY.REPLY,
      severity: SEVERITY.INFO, status: STATUS.PASS,
      summary: `${historical} reply(ies) rest on a legacy [REPLY: ...] tag because they predate canonical activity storage. Their classification is usable but weaker than verified provider evidence.`,
      affected: historical,
      sample: legacyOnly.filter(entry => !postBoundary.includes(entry))
        .map(entry => ({ id: entry.lead.id, company: entry.lead.company, legacyTag: entry.resolved.legacyTag })),
      evidence: { canonicalReplyBoundary: boundary },
      classification: 'historical',
    })
    : pass('reply.legacy_evidence_only', CATEGORY.REPLY, 'No reply depends on a legacy tag alone.'));

  // A malformed identity must never be carrying trusted reply evidence.
  const untrusted = [...resolvedByLead.values()]
    .filter(entry => entry.resolved.identityIssue
      && GENUINE_HUMAN_STATES.includes(entry.resolved.state))
    .map(entry => ({ id: entry.lead.id, company: entry.lead.company, issue: entry.resolved.identityIssue }));
  out.push(untrusted.length
    ? finding({
      id: 'reply.trusted_evidence_on_malformed_identity', category: CATEGORY.REPLY,
      severity: SEVERITY.CRITICAL, status: STATUS.FAIL,
      summary: `${untrusted.length} lead(s) with a malformed address are being treated as having a genuine reply. Evidence attributed to an unreachable address is fiction.`,
      affected: untrusted.length, sample: untrusted,
      classification: 'automation_risk', requiresHumanReview: true,
    })
    : pass('reply.trusted_evidence_on_malformed_identity', CATEGORY.REPLY,
      'No malformed identity carries trusted reply evidence.'));

  // Provider message-id collisions across different leads.
  const byMessageId = new Map();
  for (const [leadId, rows] of index.activityByLead) {
    for (const row of rows) {
      if (!LEGACY_REPLY_EVENT_TYPES.includes(String(row.eventType || ''))) continue;
      const messageId = String(parseMetadata(row.metadata).gmailMessageId || '').trim();
      if (!messageId) continue;
      const bucket = byMessageId.get(messageId) || new Set();
      bucket.add(leadId);
      byMessageId.set(messageId, bucket);
    }
  }
  const collisions = [...byMessageId.entries()]
    .filter(([, leadIds]) => leadIds.size > 1)
    .map(([messageId, leadIds]) => ({ gmailMessageId: messageId, leadIds: [...leadIds] }));
  out.push(collisions.length
    ? finding({
      id: 'reply.provider_identity_collision', category: CATEGORY.REPLY,
      severity: SEVERITY.CRITICAL, status: STATUS.FAIL,
      summary: `${collisions.length} Gmail message(s) are attributed to more than one lead. Provider identity must be unique or reply attribution is unsound.`,
      affected: collisions.length, sample: collisions,
      classification: 'automation_risk', requiresHumanReview: true,
    })
    : pass('reply.provider_identity_collision', CATEGORY.REPLY, 'Every Gmail message maps to at most one lead.'));

  // Unsupported canonical states — a forward-compatibility guard.
  const known = new Set(Object.values(REPLY_STATE));
  const impossible = [];
  for (const [leadId, rows] of index.activityByLead) {
    for (const row of rows) {
      const state = parseMetadata(row.metadata).canonicalState;
      if (state && !known.has(state)) impossible.push({ leadId, eventId: row.eventId, state });
    }
  }
  out.push(impossible.length
    ? finding({
      id: 'reply.unsupported_canonical_state', category: CATEGORY.REPLY,
      severity: SEVERITY.WARNING, status: STATUS.FAIL,
      summary: `${impossible.length} reply activity(ies) carry a canonical state this build does not recognise. Most likely a newer writer against an older reader.`,
      affected: impossible.length, sample: impossible,
      classification: 'data_quality', requiresHumanReview: true,
    })
    : pass('reply.unsupported_canonical_state', CATEGORY.REPLY, 'Every stored canonical reply state is recognised.'));

  return out;
}

// ── 3. OUTREACH / SEND-STATE ────────────────────────────────────────────────

/**
 * The sender's guard is `suppressionReason()` in outreach-agent.js, which is
 * not importable. Rather than reimplement it — the exact mistake this file
 * warns against — the caller INJECTS it, so health asks the real function.
 * With no injection the check reports NOT_APPLICABLE instead of guessing.
 */
function outreachChecks({ leads, suppressionReason = null }, index) {
  const out = [];
  if (typeof suppressionReason !== 'function') {
    out.push(finding({
      id: 'outreach.suppression_conflict', category: CATEGORY.OUTREACH,
      severity: SEVERITY.INFO, status: STATUS.NOT_APPLICABLE,
      summary: 'Send-eligibility could not be checked: the sender\'s own suppression rule was not supplied. Health deliberately does not approximate it, because a checker that disagrees with the sender is worse than none.',
      classification: 'operational',
    }));
    return out;
  }

  // A lead that is suppressed AND still looks sendable is the single most
  // dangerous state in this CRM: it means automation could contact someone who
  // opted out, bounced, or is being handled by a human.
  const conflicts = [];
  for (const lead of leads) {
    const reason = suppressionReason(lead);
    if (!reason) continue;
    const looksSendable = String(lead.stage || '').trim().toLowerCase() === 'queued'
      && String(lead.emailStatus || '').trim() === ''
      && classifyLeadEmail(lead.email) === 'CLEAN';
    if (looksSendable) {
      conflicts.push({ id: lead.id, company: lead.company, suppressionReason: reason, stage: lead.stage });
    }
  }
  out.push(conflicts.length
    ? finding({
      id: 'outreach.suppression_conflict', category: CATEGORY.OUTREACH,
      severity: SEVERITY.CRITICAL, status: STATUS.FAIL,
      summary: `${conflicts.length} suppressed lead(s) are also in a sendable state. The send-time guard should still stop them, but the contradiction means one dropped guard would mail a suppressed contact.`,
      affected: conflicts.length, sample: conflicts,
      classification: 'automation_risk', requiresHumanReview: true,
    })
    : pass('outreach.suppression_conflict', CATEGORY.OUTREACH,
      'No suppressed lead is simultaneously queued and sendable.'));

  // A lead that genuinely replied must not still be sitting in the cold queue.
  const repliedButQueued = leads
    .filter(lead => {
      const resolved = resolveReplyState(lead, { activities: index.activityByLead.get(lead.id) || [] });
      return GENUINE_HUMAN_STATES.includes(resolved.state)
        && String(lead.stage || '').trim().toLowerCase() === 'queued'
        && String(lead.emailStatus || '').trim() === '';
    })
    .map(lead => ({ id: lead.id, company: lead.company, stage: lead.stage }));
  out.push(repliedButQueued.length
    ? finding({
      id: 'outreach.replied_lead_still_queued', category: CATEGORY.OUTREACH,
      severity: SEVERITY.CRITICAL, status: STATUS.FAIL,
      summary: `${repliedButQueued.length} lead(s) with a genuine human reply are queued for cold sending. A prospect who already answered must never receive a cold opener.`,
      affected: repliedButQueued.length, sample: repliedButQueued,
      classification: 'automation_risk', requiresHumanReview: true,
    })
    : pass('outreach.replied_lead_still_queued', CATEGORY.OUTREACH,
      'No lead that replied is queued for a cold send.'));

  return out;
}

// ── 4. MANUAL HOLD ──────────────────────────────────────────────────────────

function holdChecks({ boardLeads, suppressionReason = null }, index) {
  const out = [];
  const missing = [];
  const stillActive = [];
  // Whether a missing hold is REACHABLE matters more than whether it is absent.
  // A terminal lead whose emailStatus already blocks re-entry is untidy; one
  // that is genuinely queued and sendable is dangerous. Reporting both as
  // "automation risk" would be crying wolf, and the panel would stop being read.
  const reachable = lead => Boolean(lead)
    && String(lead.stage || '').trim().toLowerCase() === 'queued'
    && String(lead.emailStatus || '').trim() === ''
    && classifyLeadEmail(lead.email) === 'CLEAN'
    && (typeof suppressionReason !== 'function' || !suppressionReason(lead));

  for (const board of boardLeads) {
    const leadId = index.boardToLead.get(board.id);
    const twin = leadId ? index.byId.get(leadId) : null;
    if (!twin) continue;

    // Does this stage require a hold, and is one present? stageRequiresHold and
    // hasManualHold are the canonical definitions — never re-derived here.
    if (stageRequiresHold(board.stage) && !hasManualHold(twin.notes)) {
      missing.push({
        boardId: board.id, leadId, stage: board.stage, company: twin.company,
        sendEligibleNow: reachable(twin),
      });
    }
    // A human-owned stage with automation still active. automationConflict
    // already encodes this rule, including the Step 10 carve-out.
    const conflict = automationConflict(board, twin);
    if (conflict) {
      stillActive.push({ boardId: board.id, leadId, stage: conflict.stage, reason: conflict.reason });
    }
  }

  const reachableMissing = missing.filter(row => row.sendEligibleNow);
  out.push(missing.length
    ? finding({
      id: 'hold.missing_where_required', category: CATEGORY.HOLD,
      severity: reachableMissing.length ? SEVERITY.CRITICAL : SEVERITY.WARNING,
      status: STATUS.FAIL,
      summary: reachableMissing.length
        ? `${reachableMissing.length} of ${missing.length} opportunity(ies) missing a required MANUAL HOLD are ALSO currently send-eligible. Cold automation could contact a human-owned lead.`
        : `${missing.length} opportunity(ies) sit in a stage that requires a MANUAL HOLD but their ColdEmail twin does not carry one. None is currently send-eligible — their send state already blocks re-entry — so this is untidy rather than dangerous, and would only matter if one were re-queued.`,
      affected: missing.length, sample: missing,
      evidence: { sendEligibleNow: reachableMissing.length },
      classification: reachableMissing.length ? 'automation_risk' : 'data_quality',
      requiresHumanReview: true,
    })
    : pass('hold.missing_where_required', CATEGORY.HOLD, 'Every stage that requires a MANUAL HOLD has one.'));

  out.push(stillActive.length
    ? finding({
      id: 'hold.automation_active_in_human_stage', category: CATEGORY.HOLD,
      severity: SEVERITY.CRITICAL, status: STATUS.FAIL,
      summary: `${stillActive.length} human-owned opportunity(ies) still have active cold automation.`,
      affected: stillActive.length, sample: stillActive,
      classification: 'automation_risk', requiresHumanReview: true,
    })
    : pass('hold.automation_active_in_human_stage', CATEGORY.HOLD,
      'No human-owned opportunity has cold automation running. (An explicitly enrolled stage sequence operating past a cold-campaign hold is intended behaviour and is not counted here.)'));

  return out;
}

// ── 5. PIPELINE / HOT / CALL ────────────────────────────────────────────────

function pipelineChecks({ boardLeads, now = new Date() }, index) {
  const out = [];
  const bookedNoMeeting = [];
  const unresolvedPast = [];
  const contradictory = [];
  const terminalWithLiveCall = [];

  for (const board of boardLeads) {
    const leadId = index.boardToLead.get(board.id);
    const activities = leadId ? (index.activityByLead.get(leadId) || []) : [];
    const stage = norm(board.stage);
    const call = deriveCallLifecycle(board, { activities, now });

    if (stage === 'call_booked' && !board.meetingAt) {
      bookedNoMeeting.push({ boardId: board.id, stage: board.stage });
    }
    if (call.status === CALL_STATUS.OUTCOME_PENDING) {
      unresolvedPast.push({ boardId: board.id, meetingAt: call.meetingAt, status: call.status });
    }
    const types = new Set(activities.map(row => String(row.eventType || '')));
    if (types.has('meeting_completed') && types.has('meeting_no_show')) {
      contradictory.push({ boardId: board.id, conflict: 'both completed and no-show recorded' });
    }
    const terminal = ['closed_won', 'closed_lost', 'closed', 'lost'].includes(stage);
    const liveCall = [CALL_STATUS.SCHEDULED, CALL_STATUS.RESCHEDULED].includes(call.status);
    if (terminal && liveCall) {
      terminalWithLiveCall.push({ boardId: board.id, stage: board.stage, callStatus: call.status });
    }
  }

  out.push(bookedNoMeeting.length
    ? finding({
      id: 'pipeline.call_booked_without_meeting', category: CATEGORY.PIPELINE,
      severity: SEVERITY.WARNING, status: STATUS.FAIL,
      summary: `${bookedNoMeeting.length} opportunity(ies) are staged Call Booked with no meeting time recorded.`,
      affected: bookedNoMeeting.length, sample: bookedNoMeeting,
      classification: 'data_quality', requiresHumanReview: true,
    })
    : pass('pipeline.call_booked_without_meeting', CATEGORY.PIPELINE, 'Every booked call has a meeting time.'));

  out.push(unresolvedPast.length
    ? finding({
      id: 'call.unresolved_past_meeting', category: CATEGORY.CALL,
      severity: SEVERITY.WARNING, status: STATUS.FAIL,
      summary: `${unresolvedPast.length} meeting(s) are in the past with no outcome recorded. Someone needs to say what happened; the CRM will not guess.`,
      affected: unresolvedPast.length, sample: unresolvedPast,
      classification: 'operational', requiresHumanReview: true,
    })
    : pass('call.unresolved_past_meeting', CATEGORY.CALL, 'No past meeting is awaiting an outcome.'));

  out.push(contradictory.length
    ? finding({
      id: 'call.contradictory_lifecycle', category: CATEGORY.CALL,
      severity: SEVERITY.WARNING, status: STATUS.FAIL,
      summary: `${contradictory.length} opportunity(ies) record both a completed meeting and a no-show.`,
      affected: contradictory.length, sample: contradictory,
      classification: 'data_quality', requiresHumanReview: true,
    })
    : pass('call.contradictory_lifecycle', CATEGORY.CALL, 'No opportunity has contradictory call outcomes.'));

  out.push(terminalWithLiveCall.length
    ? finding({
      id: 'call.terminal_with_live_meeting', category: CATEGORY.CALL,
      severity: SEVERITY.WARNING, status: STATUS.FAIL,
      summary: `${terminalWithLiveCall.length} closed opportunity(ies) still have a live scheduled meeting.`,
      affected: terminalWithLiveCall.length, sample: terminalWithLiveCall,
      classification: 'operational', requiresHumanReview: true,
    })
    : pass('call.terminal_with_live_meeting', CATEGORY.CALL, 'No closed opportunity has a live meeting.'));

  return out;
}

function hotChecks({ boardLeads, now = new Date() }, index) {
  const stale = [];
  const waitingOnUs = [];
  for (const board of boardLeads) {
    if (norm(board.stage) !== 'hot') continue;
    const leadId = index.boardToLead.get(board.id);
    const twin = leadId ? index.byId.get(leadId) : null;
    const activities = leadId ? (index.activityByLead.get(leadId) || []) : [];
    const hot = deriveHotState(board, twin, { activities, now });
    if (!hot) continue;
    if ([HOT_STALENESS.STALE, HOT_STALENESS.SEVERELY_STALE, HOT_STALENESS.OVERDUE].includes(hot.staleness)) {
      stale.push({ boardId: board.id, staleness: hot.staleness, waitingOn: hot.waitingOn, lastInteractionAt: hot.lastInteractionAt || null });
    }
    if (hot.waitingOn === 'waiting_on_us') {
      waitingOnUs.push({ boardId: board.id, staleness: hot.staleness });
    }
  }
  const out = [];
  out.push(stale.length
    ? finding({
      id: 'hot.stale_followup', category: CATEGORY.HOT,
      severity: SEVERITY.WARNING, status: STATUS.FAIL,
      // Explicitly operational: a stale Hot lead is a job someone has not done,
      // not evidence that the CRM is broken.
      summary: `${stale.length} Hot lead(s) are overdue or stale. This is an operational follow-up, not data corruption.`,
      affected: stale.length, sample: stale,
      classification: 'operational', requiresHumanReview: true,
    })
    : pass('hot.stale_followup', CATEGORY.HOT, 'No Hot lead is overdue or stale.'));
  out.push(waitingOnUs.length
    ? finding({
      id: 'hot.waiting_on_us', category: CATEGORY.HOT,
      severity: SEVERITY.INFO, status: STATUS.PASS,
      summary: `${waitingOnUs.length} Hot lead(s) are waiting on us to respond.`,
      affected: waitingOnUs.length, sample: waitingOnUs,
      classification: 'operational',
    })
    : pass('hot.waiting_on_us', CATEGORY.HOT, 'No Hot lead is waiting on us.'));
  return out;
}

// ── 6. STAGE SEQUENCES ──────────────────────────────────────────────────────

function sequenceChecks({ boardLeads, sequencesEnabled = false, now = new Date() }, index) {
  const out = [];
  if (!sequencesEnabled) {
    out.push(disabled('sequence.feature_flag', CATEGORY.SEQUENCE,
      'Stage sequences are intentionally disabled (STAGE_SEQUENCES_ENABLED is off). Nothing can send; this is configuration, not a fault.',
      { enabled: false }));
  } else {
    out.push(pass('sequence.feature_flag', CATEGORY.SEQUENCE, 'Stage sequences are enabled.', { enabled: true }));
  }

  const stuck = [];
  for (const board of boardLeads) {
    const leadId = index.boardToLead.get(board.id);
    const activities = leadId ? (index.activityByLead.get(leadId) || []) : [];
    const state = evaluateStageSequence({
      boardLead: board, activities, now, featureEnabled: sequencesEnabled,
    });
    // A sequence that is stopped or completed but still reports itself as
    // eligible would be a real contradiction in the state machine.
    if ([SEQUENCE_STATUS.STOPPED, SEQUENCE_STATUS.COMPLETED].includes(state.status) && state.eligible) {
      stuck.push({ boardId: board.id, sequenceId: state.sequenceId, status: state.status });
    }
  }
  out.push(stuck.length
    ? finding({
      id: 'sequence.stopped_but_eligible', category: CATEGORY.SEQUENCE,
      severity: SEVERITY.CRITICAL, status: STATUS.FAIL,
      summary: `${stuck.length} stopped or completed sequence(s) still report themselves as send-eligible.`,
      affected: stuck.length, sample: stuck,
      classification: 'automation_risk', requiresHumanReview: true,
    })
    : pass('sequence.stopped_but_eligible', CATEGORY.SEQUENCE,
      'No stopped or completed sequence is still send-eligible.'));
  return out;
}

// ── 7. CALENDAR ─────────────────────────────────────────────────────────────

function calendarChecks({
  calendarSyncEnabled = false, bookingCalendarId = '', appointmentScheduleId = '',
  calendarSyncState = null, now = new Date(), staleCheckpointDays = 2,
} = {}) {
  const out = [];
  if (!calendarSyncEnabled) {
    out.push(disabled('calendar.sync_flag', CATEGORY.CALENDAR,
      'Google Calendar booking sync is intentionally disabled. No bookings are read or written; this is configuration, not a fault.',
      { enabled: false, bookingCalendarId: Boolean(bookingCalendarId), appointmentScheduleId: Boolean(appointmentScheduleId) }));
    return out;
  }

  // Enabled but unconfigured is serious: the pin exists precisely to stop
  // bookings from an unrelated schedule entering the pipeline.
  const missing = [];
  if (!bookingCalendarId) missing.push('GOOGLE_BOOKING_CALENDAR_ID');
  if (!appointmentScheduleId) missing.push('GOOGLE_BOOKING_APPOINTMENT_SCHEDULE_ID');
  out.push(missing.length
    ? finding({
      id: 'calendar.configuration', category: CATEGORY.CALENDAR,
      severity: SEVERITY.CRITICAL, status: STATUS.FAIL,
      summary: `Calendar sync is ENABLED but required configuration is missing: ${missing.join(', ')}. Without a pinned schedule the detector would accept bookings from any schedule on the calendar.`,
      affected: missing.length, sample: missing.map(key => ({ missing: key })),
      classification: 'automation_risk', requiresHumanReview: true,
    })
    : pass('calendar.configuration', CATEGORY.CALENDAR, 'Calendar sync is enabled and fully configured.'));

  const checkpoint = calendarSyncState || {};
  const lastAt = isoOrNull(checkpoint.lastSyncAt);
  if (!checkpoint.syncToken && !lastAt) {
    out.push(finding({
      id: 'calendar.checkpoint', category: CATEGORY.CALENDAR,
      severity: SEVERITY.WARNING, status: STATUS.FAIL,
      summary: 'Calendar sync is enabled but no sync checkpoint exists yet. Either it has never run, or its state was lost.',
      classification: 'operational', requiresHumanReview: true,
    }));
  } else {
    const ageDays = lastAt ? daysBetween(now, lastAt) : null;
    out.push(ageDays !== null && ageDays > staleCheckpointDays
      ? finding({
        id: 'calendar.checkpoint', category: CATEGORY.CALENDAR,
        severity: SEVERITY.WARNING, status: STATUS.FAIL,
        summary: `Calendar sync last succeeded ${ageDays} day(s) ago, beyond the ${staleCheckpointDays}-day threshold. Bookings may not be reaching the CRM.`,
        affected: 1, evidence: { lastSyncAt: lastAt, ageDays },
        classification: 'operational', requiresHumanReview: true,
      })
      : pass('calendar.checkpoint', CATEGORY.CALENDAR, 'Calendar sync checkpoint is current.', { lastSyncAt: lastAt, ageDays }));
  }

  if (checkpoint.lastError) {
    out.push(finding({
      id: 'calendar.last_error', category: CATEGORY.CALENDAR,
      severity: SEVERITY.WARNING, status: STATUS.FAIL,
      summary: 'The most recent calendar sync recorded an error.',
      affected: 1, evidence: { lastError: String(checkpoint.lastError).slice(0, 300) },
      classification: 'operational', requiresHumanReview: true,
    }));
  }
  return out;
}

// ── 8. CAMPAIGN ATTRIBUTION ─────────────────────────────────────────────────

function attributionChecks({ activities = [], measuredVersions = [] }) {
  const out = [];
  const registered = new Set(Object.keys(CAMPAIGN_VERSIONS || {}));
  const unknownVersions = new Map();
  const malformed = [];

  for (const row of activities) {
    const type = String(row.eventType || '');
    if (!/_sent$/.test(type)) continue;
    let attribution;
    try {
      attribution = attributionFromActivity(row);
    } catch (_) {
      malformed.push({ eventId: row.eventId, reason: 'attribution metadata could not be parsed' });
      continue;
    }
    const version = attribution.campaignVersion || LEGACY_UNKNOWN;
    // legacy_unknown is VALID history, never a fault: most sends predate the
    // registry existing at all.
    if (version === LEGACY_UNKNOWN) continue;
    if (!registered.has(version)) {
      const bucket = unknownVersions.get(version) || [];
      bucket.push({ eventId: row.eventId, version });
      unknownVersions.set(version, bucket);
    }
  }

  out.push(unknownVersions.size
    ? finding({
      id: 'attribution.unregistered_version', category: CATEGORY.ATTRIBUTION,
      severity: SEVERITY.CRITICAL, status: STATUS.FAIL,
      summary: `${unknownVersions.size} campaign version(s) appear on sends but are not in the immutable registry. Measured analytics cannot be trusted for them.`,
      affected: [...unknownVersions.values()].reduce((sum, rows) => sum + rows.length, 0),
      sample: [...unknownVersions.keys()].map(version => ({ version })),
      classification: 'automation_risk', requiresHumanReview: true,
    })
    : pass('attribution.unregistered_version', CATEGORY.ATTRIBUTION,
      'Every explicit campaign version on a send is registered. (legacy_unknown is valid history and is not counted.)'));

  out.push(malformed.length
    ? finding({
      id: 'attribution.malformed_metadata', category: CATEGORY.ATTRIBUTION,
      severity: SEVERITY.WARNING, status: STATUS.FAIL,
      summary: `${malformed.length} send activity(ies) carry unparseable attribution metadata.`,
      affected: malformed.length, sample: malformed,
      classification: 'data_quality', requiresHumanReview: true,
    })
    : pass('attribution.malformed_metadata', CATEGORY.ATTRIBUTION, 'All send attribution metadata parses cleanly.'));

  // Acquisition must never be rewritten by a later touch.
  const acquisitionByLead = new Map();
  const conflicts = [];
  for (const row of activities) {
    if (String(row.eventType || '') !== 'pipeline_promoted') continue;
    const meta = parseMetadata(row.metadata);
    const version = meta.acquisitionCampaignVersion;
    if (!version) continue;
    const key = String(row.sourceLeadId || row.leadId || '');
    const existing = acquisitionByLead.get(key);
    if (existing && existing !== version) {
      conflicts.push({ leadId: key, from: existing, to: version });
    } else if (!existing) {
      acquisitionByLead.set(key, version);
    }
  }
  out.push(conflicts.length
    ? finding({
      id: 'attribution.acquisition_conflict', category: CATEGORY.ATTRIBUTION,
      severity: SEVERITY.CRITICAL, status: STATUS.FAIL,
      summary: `${conflicts.length} lead(s) have conflicting acquisition attribution. Acquisition is immutable; a later campaign must never overwrite it.`,
      affected: conflicts.length, sample: conflicts,
      classification: 'automation_risk', requiresHumanReview: true,
    })
    : pass('attribution.acquisition_conflict', CATEGORY.ATTRIBUTION, 'No lead has conflicting acquisition attribution.'));

  return out;
}

// ── 9. FUNNEL RECONCILIATION (consumed, never rebuilt) ──────────────────────

function funnelChecks({ funnel = null }) {
  const out = [];
  if (!funnel || !funnel.reconciliation) {
    out.push(finding({
      id: 'funnel.reconciliation', category: CATEGORY.FUNNEL,
      severity: SEVERITY.INFO, status: STATUS.NOT_APPLICABLE,
      summary: 'No funnel snapshot was supplied, so reconciliation was not evaluated.',
      classification: 'operational',
    }));
    return out;
  }
  const rec = funnel.reconciliation;
  const broken = [];
  if (rec.repliesPartition === false) broken.push('reply categories do not partition the replied total');
  if (rec.stagesMatchLeadIds === false) broken.push('a stage count does not match its contributing lead ids');
  out.push(broken.length
    ? finding({
      id: 'funnel.reconciliation', category: CATEGORY.FUNNEL,
      severity: SEVERITY.CRITICAL, status: STATUS.FAIL,
      summary: `Funnel reconciliation failed: ${broken.join('; ')}. A displayed number cannot be traced to the leads behind it.`,
      affected: broken.length, sample: broken.map(reason => ({ reason })),
      classification: 'data_quality', requiresHumanReview: true,
    })
    : pass('funnel.reconciliation', CATEGORY.FUNNEL, 'Funnel reply partition and stage/lead-id reconciliation both hold.'));

  const outside = rec.outsideFunnel || { total: 0, byStage: {} };
  out.push(outside.total
    ? finding({
      id: 'funnel.outside_cohort', category: CATEGORY.FUNNEL,
      severity: SEVERITY.INFO, status: STATUS.PASS,
      summary: `${outside.total} of ${rec.boardLeadsTotal} pipeline opportunities sit outside the cold-outreach cohort. This is expected disclosure, not a reconciliation failure — it stops funnel totals being read as company-wide totals.`,
      affected: outside.total, evidence: { byStage: outside.byStage },
      classification: 'historical',
    })
    : pass('funnel.outside_cohort', CATEGORY.FUNNEL, 'Every pipeline opportunity is inside the cold-outreach cohort.'));

  // Measured cohort contamination: a measured campaign must only ever contain
  // explicitly stamped sends.
  const versions = (funnel.facets && funnel.facets.versions) || [];
  const contaminated = measuredContamination(funnel, versions);
  out.push(contaminated
    ? finding({
      id: 'funnel.measured_contamination', category: CATEGORY.FUNNEL,
      severity: SEVERITY.CRITICAL, status: STATUS.FAIL,
      summary: contaminated,
      affected: 1, classification: 'automation_risk', requiresHumanReview: true,
    })
    : pass('funnel.measured_contamination', CATEGORY.FUNNEL,
      'The measured cohort contains only explicitly attributed sends.'));
  return out;
}

function measuredContamination(funnel, versions) {
  // Historical send state is admitted to lifetime/legacy only. If a measured
  // view ever reports historical rows, attribution has leaked.
  const filters = funnel.filters || {};
  const measured = filters.version && ![LEGACY_UNKNOWN, 'lifetime', 'all_measured'].includes(filters.version);
  if (!measured) return null;
  const historical = (funnel.eventCounts || {}).historicalSendStates || 0;
  if (historical > 0) {
    return `The measured cohort "${filters.version}" includes ${historical} historical send-state row(s), which carry no explicit attribution.`;
  }
  return null;
}

// ── 10. ACTIVITY / EVENT INTEGRITY ──────────────────────────────────────────

function activityChecks({ activities = [] }) {
  const out = [];
  // inspectActivityIntegrity already owns this definition.
  let report = null;
  try {
    report = inspectActivityIntegrity(activities);
  } catch (_) {
    report = null;
  }

  const seen = new Map();
  const duplicates = [];
  for (const row of activities) {
    const eventId = String(row.eventId || '').trim();
    if (!eventId) continue;
    if (seen.has(eventId)) duplicates.push({ eventId, count: seen.get(eventId) + 1 });
    seen.set(eventId, (seen.get(eventId) || 0) + 1);
  }
  out.push(duplicates.length
    ? finding({
      id: 'activity.duplicate_event_id', category: CATEGORY.ACTIVITY,
      severity: SEVERITY.CRITICAL, status: STATUS.FAIL,
      summary: `${duplicates.length} duplicate activity event id(s). The canonical timeline is append-only and event ids must be unique, or replay protection is unsound.`,
      affected: duplicates.length, sample: duplicates,
      classification: 'automation_risk', requiresHumanReview: true,
    })
    : pass('activity.duplicate_event_id', CATEGORY.ACTIVITY, 'Every activity event id is unique.'));

  const malformed = activities
    .filter(row => {
      const raw = row.metadata;
      if (raw === undefined || raw === null || raw === '') return false;
      try { JSON.parse(raw); return false; } catch (_) { return true; }
    })
    .map(row => ({ eventId: row.eventId, eventType: row.eventType }));
  out.push(malformed.length
    ? finding({
      id: 'activity.malformed_metadata', category: CATEGORY.ACTIVITY,
      severity: SEVERITY.WARNING, status: STATUS.FAIL,
      summary: `${malformed.length} activity row(s) carry metadata that is not valid JSON.`,
      affected: malformed.length, sample: malformed,
      classification: 'data_quality', requiresHumanReview: true,
    })
    : pass('activity.malformed_metadata', CATEGORY.ACTIVITY, 'All activity metadata parses as JSON.'));

  const missingTimestamp = activities
    .filter(row => !isoOrNull(row.occurredAt))
    .map(row => ({ eventId: row.eventId, eventType: row.eventType }));
  out.push(missingTimestamp.length
    ? finding({
      id: 'activity.missing_timestamp', category: CATEGORY.ACTIVITY,
      severity: SEVERITY.WARNING, status: STATUS.FAIL,
      summary: `${missingTimestamp.length} activity row(s) have no usable timestamp, so they cannot be ordered.`,
      affected: missingTimestamp.length, sample: missingTimestamp,
      classification: 'data_quality',
    })
    : pass('activity.missing_timestamp', CATEGORY.ACTIVITY, 'Every activity row has a usable timestamp.'));

  if (report && Number(report.issues || 0) > 0) {
    out.push(finding({
      id: 'activity.integrity_report', category: CATEGORY.ACTIVITY,
      severity: SEVERITY.WARNING, status: STATUS.FAIL,
      summary: `The canonical activity integrity inspector reported ${report.issues} issue(s).`,
      affected: Number(report.issues), evidence: report,
      classification: 'data_quality', requiresHumanReview: true,
    }));
  }
  return out;
}

// ── AGGREGATION ─────────────────────────────────────────────────────────────

/**
 * Overall health. Deterministic and deliberately blunt:
 *   any critical -> critical
 *   else any warning -> warning
 *   else healthy
 * Informational findings never degrade health on their own, which is what keeps
 * a CRM full of legacy data from permanently reporting amber.
 */
function overallHealth(findings = []) {
  if (findings.some(item => item.severity === SEVERITY.CRITICAL)) return SEVERITY.CRITICAL;
  if (findings.some(item => item.severity === SEVERITY.WARNING)) return SEVERITY.WARNING;
  return SEVERITY.HEALTHY;
}

/**
 * Run every check. Any check that throws is reported as a finding rather than
 * taking the endpoint down — a diagnostic layer that can crash the CRM it is
 * diagnosing would be worse than useless.
 */
function buildCrmHealth(input = {}) {
  const now = (() => { try { return input.now ? new Date(input.now) : new Date(); } catch (_) { return new Date(); } })();
  // Copying the input is itself a place that can throw — a getter on the caller's
  // object runs here, outside any per-check handler. Copy field by field so one
  // bad property cannot take the whole diagnostic endpoint down.
  const context = { now };
  const copyErrors = [];
  for (const key of Object.keys(input || {})) {
    if (key === 'now') continue;
    try { context[key] = input[key]; } catch (error) { copyErrors.push({ key, message: error.message }); }
  }
  const index = buildIndex(context);
  // Hand every check the same sanitised collections the index was built from.
  const clean = value => (Array.isArray(value) ? value : []).filter(Boolean);
  context.leads = clean(context.leads);
  context.boardLeads = clean(context.boardLeads);
  context.activities = clean(context.activities);
  context.replyRecords = clean(context.replyRecords);
  const findings = [];

  for (const { key, message } of copyErrors) {
    findings.push(finding({
      id: `input.${key}_unreadable`, category: 'input',
      severity: SEVERITY.WARNING, status: STATUS.FAIL,
      summary: `Health input "${key}" could not be read: ${message}. Checks depending on it report unknown rather than healthy.`,
      classification: 'operational', requiresHumanReview: true,
    }));
  }

  const groups = [
    ['identity', () => identityChecks(context, index)],
    ['reply', () => replyChecks(context, index)],
    ['outreach', () => outreachChecks(context, index)],
    ['manual_hold', () => holdChecks(context, index)],
    ['pipeline', () => pipelineChecks(context, index)],
    ['hot', () => hotChecks(context, index)],
    ['sequence', () => sequenceChecks(context, index)],
    ['calendar', () => calendarChecks(context)],
    ['attribution', () => attributionChecks(context)],
    ['funnel', () => funnelChecks(context)],
    ['activity', () => activityChecks(context)],
  ];

  for (const [name, run] of groups) {
    try {
      findings.push(...run());
    } catch (error) {
      findings.push(finding({
        id: `${name}.check_failed`, category: name,
        severity: SEVERITY.WARNING, status: STATUS.FAIL,
        summary: `The ${name} health check could not complete: ${error.message}. Its result is unknown rather than healthy.`,
        classification: 'operational', requiresHumanReview: true,
      }));
    }
  }

  const bySeverity = { critical: 0, warning: 0, info: 0, healthy: 0 };
  const byCategory = {};
  for (const item of findings) {
    bySeverity[item.severity] = (bySeverity[item.severity] || 0) + 1;
    byCategory[item.category] = byCategory[item.category] || { critical: 0, warning: 0, info: 0, healthy: 0 };
    byCategory[item.category][item.severity] += 1;
  }

  const notable = findings
    .filter(item => item.severity !== SEVERITY.HEALTHY)
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.id.localeCompare(b.id));

  return {
    overall: overallHealth(findings),
    generatedAt: now.toISOString(),
    checksRun: findings.length,
    bySeverity, byCategory,
    findings: notable,
    healthy: findings.filter(item => item.severity === SEVERITY.HEALTHY).map(item => item.id),
  };
}

module.exports = {
  SEVERITY, SEVERITY_RANK, CATEGORY, STATUS, SAMPLE_LIMIT,
  buildCrmHealth, overallHealth, finding,
  identityChecks, replyChecks, outreachChecks, holdChecks,
  pipelineChecks, hotChecks, sequenceChecks, calendarChecks,
  attributionChecks, funnelChecks, activityChecks, buildIndex,
};
