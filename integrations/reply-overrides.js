'use strict';
/**
 * reply-overrides.js — human decisions that outrank derivation. PURE.
 * ─────────────────────────────────────────────────────────────────────────────
 * Two DIFFERENT decisions live here, and keeping them apart is the point:
 *
 *   classification override  "the classifier read this message wrong"
 *   action override          "the reading is right, but do something else"
 *
 * Collapsing them would force a lie. "The classifier correctly says Needs
 * Human, but I want to revisit this in two weeks" is an operational decision,
 * and expressing it by re-labelling the reply would corrupt reply analytics to
 * change a diary entry. So an action override never touches classification, and
 * a classification override never invents a follow-up.
 *
 * Both are append-only records. Nothing here edits Gmail, rewrites a canonical
 * reconciliation event, or deletes history — an override is a NEW statement
 * layered on top of evidence that stays exactly where it was, which is what
 * makes it auditable and reversible.
 */

const { REPLY_STATE, NEEDS_HUMAN_REASON, malformedEmailReason } = require('./canonical-reply');
const { REPLY_ACTION } = require('./reply-operations');

const OVERRIDE_KIND = Object.freeze({
  CLASSIFICATION: 'reply_classification_override',
  ACTION: 'next_action_override',
  CONTACT_CHANGE: 'contact_change_decision',
});

const OVERRIDE_STATUS = Object.freeze({ ACTIVE: 'active', REVERSED: 'reversed' });

const CONTACT_DECISION = Object.freeze({
  PROPOSED: 'proposed', APPROVED: 'approved', REJECTED: 'rejected',
});

const VALID_STATES = new Set(Object.values(REPLY_STATE));
const VALID_ACTIONS = new Set(Object.values(REPLY_ACTION));

const nowIso = () => new Date().toISOString();

/**
 * Build a classification override record.
 *
 * Records what it replaced as well as what it asserts, so the disagreement
 * between a human and the classifier stays inspectable rather than becoming
 * the only surviving story.
 */
function buildClassificationOverride({
  leadId, providerMessageId = null, previousState, previousReason = null,
  state, reason, by = null, at = nowIso(), note = '',
} = {}) {
  if (!leadId) return { ok: false, error: 'a classification override needs a lead' };
  if (!VALID_STATES.has(state)) {
    return { ok: false, error: `"${state}" is not a canonical reply state` };
  }
  if (!String(reason || '').trim()) {
    return { ok: false, error: 'a classification override must say why' };
  }
  return {
    ok: true,
    record: {
      kind: OVERRIDE_KIND.CLASSIFICATION, status: OVERRIDE_STATUS.ACTIVE,
      leadId, providerMessageId,
      previous: { state: previousState || null, reason: previousReason || null },
      next: { state, reason: reason.trim() },
      by, at, note: String(note || '').slice(0, 500),
    },
  };
}

/**
 * Build an operational action override.
 *
 * Deliberately CANNOT express a classification. A human deferring a lead for
 * two weeks is not making a claim about what the prospect wrote.
 */
function buildActionOverride({
  leadId, action, reason, dueAt = null, waitingOn = null, owner = null,
  by = null, at = nowIso(), note = '',
} = {}) {
  if (!leadId) return { ok: false, error: 'an action override needs a lead' };
  if (!VALID_ACTIONS.has(action)) {
    return { ok: false, error: `"${action}" is not a known operational action` };
  }
  if (!String(reason || '').trim()) {
    return { ok: false, error: 'an action override must say why' };
  }
  if (dueAt && !Number.isFinite(Date.parse(dueAt))) {
    return { ok: false, error: `"${dueAt}" is not a parseable date` };
  }
  return {
    ok: true,
    record: {
      kind: OVERRIDE_KIND.ACTION, status: OVERRIDE_STATUS.ACTIVE,
      leadId, action, reason: reason.trim(),
      dueAt: dueAt ? new Date(dueAt).toISOString() : null,
      waitingOn, owner, by, at, note: String(note || '').slice(0, 500),
    },
  };
}

/** Reversal is a new record, never a deletion — the original stays readable. */
function reverseOverride(record, { by = null, at = nowIso(), reason = '' } = {}) {
  if (!record) return { ok: false, error: 'nothing to reverse' };
  return {
    ok: true,
    record: { ...record, status: OVERRIDE_STATUS.REVERSED,
      reverses: record.overrideId || record.eventId || null, reversedBy: by, reversedAt: at,
      reversalReason: String(reason || '').slice(0, 500) },
  };
}

/**
 * The ACTIVE override of each kind for a lead, newest wins.
 *
 * Reversed records are skipped but never removed, so the audit trail survives.
 */
function activeOverrides(records = [], leadId) {
  const history = records
    .filter(row => row && row.leadId === leadId)
    .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  const reversedIds = new Set(history.filter(row => row.status === OVERRIDE_STATUS.REVERSED)
    .map(row => row.reverses).filter(Boolean));
  const mine = history.filter(row => row.status === OVERRIDE_STATUS.ACTIVE
    && !reversedIds.has(row.overrideId || row.eventId));
  const latest = kind => [...mine].reverse().find(row => row.kind === kind) || null;
  const classification = latest(OVERRIDE_KIND.CLASSIFICATION);
  const action = latest(OVERRIDE_KIND.ACTION);
  return {
    // Shaped for canonical-reply.resolveReplyState, which already understands
    // a manual override at the top of its precedence.
    classification: classification
      ? { state: classification.next.state, reason: classification.next.reason,
        by: classification.by, at: classification.at,
        overrideId: classification.overrideId || classification.eventId || null }
      : null,
    action: action
      ? { action: action.action, reason: action.reason, dueAt: action.dueAt,
        waitingOn: action.waitingOn, owner: action.owner, by: action.by, at: action.at,
        overrideId: action.overrideId || action.eventId || null }
      : null,
    history,
  };
}

// ── CONTACT CHANGE APPROVAL ─────────────────────────────────────────────────

/**
 * May this proposed address become the lead's canonical identity?
 *
 * Fails CLOSED on every conflict. Until approval the old identity remains
 * canonical and the proposal is evidence only — approving is the single moment
 * an identity may change, and it is a human action, never a derived one.
 *
 * Note what this does NOT do: it does not resume automation. Phase 2.3 owns
 * that, and an approved address must not quietly restart a cold sequence.
 */
function evaluateContactChange({
  leadId, currentEmail, proposedEmail,
  leads = [], boardLeads = [], suppressedEmails = new Set(),
  providerEvidence = null,
} = {}) {
  const conflicts = [];
  const proposed = String(proposedEmail || '').trim().toLowerCase();
  const current = String(currentEmail || '').trim().toLowerCase();

  if (!leadId) conflicts.push('no lead specified');
  if (!proposed) conflicts.push('no proposed address');

  // 1. It must be a usable address at all — the same rule the sender uses.
  const malformed = proposed ? malformedEmailReason(proposed) : 'no proposed address';
  if (proposed && malformed) conflicts.push(`proposed address is unusable: ${malformed}`);

  // 2. It must not already belong to a different ColdEmail lead.
  const duplicates = leads.filter(row =>
    String(row.email || '').trim().toLowerCase() === proposed && String(row.id) !== String(leadId));
  if (duplicates.length) {
    conflicts.push(`proposed address already belongs to ${duplicates.length} other ColdEmail lead(s)`);
  }

  // 3. It must not be suppressed — approving would hand automation an address
  //    someone opted out of.
  if (proposed && suppressedEmails.has(proposed)) {
    conflicts.push('proposed address is on the suppression list');
  }

  // 4. It must not collide with a board opportunity mapped elsewhere.
  const boardConflicts = boardLeads.filter(row =>
    String(row.email || '').trim().toLowerCase() === proposed
    && String(row.id || '').replace(/^CE-/, '') !== String(leadId));
  if (boardConflicts.length) {
    conflicts.push(`proposed address is claimed by ${boardConflicts.length} pipeline opportunity(ies)`);
  }

  // 5. There must be provider evidence behind the proposal.
  if (!providerEvidence || !providerEvidence.gmailMessageId) {
    conflicts.push('no provider-backed evidence supports this proposal');
  }

  if (proposed && proposed === current) conflicts.push('the proposed address is already canonical');

  return {
    ok: conflicts.length === 0,
    leadId, currentEmail: current, proposedEmail: proposed,
    conflicts,
    // Stated explicitly so no caller can mistake evaluation for permission.
    identityMutationAllowed: conflicts.length === 0,
    automationResumeAllowed: false,
  };
}

/**
 * Record an approve/reject decision. Approval carries the permission to change
 * identity; rejection carries none, and both are audit events either way.
 */
function buildContactChangeDecision({
  leadId, decision, currentEmail, proposedEmail, evaluation = null,
  by = null, at = nowIso(), reason = '',
} = {}) {
  if (![CONTACT_DECISION.APPROVED, CONTACT_DECISION.REJECTED].includes(decision)) {
    return { ok: false, error: `"${decision}" is not an approve/reject decision` };
  }
  if (decision === CONTACT_DECISION.APPROVED && (!evaluation || !evaluation.ok)) {
    return { ok: false, error: 'approval requires a clean conflict evaluation — fail closed' };
  }
  return {
    ok: true,
    record: {
      kind: OVERRIDE_KIND.CONTACT_CHANGE, status: OVERRIDE_STATUS.ACTIVE,
      leadId, decision,
      previousEmail: String(currentEmail || '').trim().toLowerCase(),
      proposedEmail: String(proposedEmail || '').trim().toLowerCase(),
      conflicts: evaluation ? evaluation.conflicts : [],
      identityMutationAllowed: decision === CONTACT_DECISION.APPROVED,
      // Approving an address never restarts outreach. Phase 2.3 decides that.
      automationResumeAllowed: false,
      by, at, reason: String(reason || '').slice(0, 500),
    },
  };
}

module.exports = {
  OVERRIDE_KIND, OVERRIDE_STATUS, CONTACT_DECISION,
  buildClassificationOverride, buildActionOverride, reverseOverride, activeOverrides,
  evaluateContactChange, buildContactChangeDecision,
};
