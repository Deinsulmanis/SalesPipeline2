'use strict';
/**
 * reconciliation-writer.js — apply an ALREADY-REVIEWED reconciliation plan.
 * ─────────────────────────────────────────────────────────────────────────────
 * This is the only component in Phase 2.1 that can change production, so it is
 * built to be as small and as boring as possible. It does exactly one thing:
 * append canonical reply activities that a human has already reviewed and
 * approved, keyed by Gmail message id.
 *
 * WHAT IT CANNOT DO — by construction, not by convention
 *
 * The writer is handed exactly one capability: an `appendActivity` function.
 * It has no Sheets client, no Gmail client, no sender, no promotion policy, no
 * suppression list. There is therefore no code path through which it could
 * rewrite a [REPLY: ...] tag, change a lead's email, alter MANUAL HOLD, touch
 * suppression, promote or demote an opportunity, send mail, rewrite campaign
 * attribution, or modify Calendar state — those systems are simply not reachable
 * from here. Tests assert the absence rather than trusting the comment.
 *
 * THE APPROVED-SET GATE
 *
 * A plan is regenerated from live production immediately before applying, which
 * means it can legitimately differ from the plan a human reviewed — a new reply
 * may have arrived, a lead may have been edited. Applying a DIFFERENT set than
 * the one approved would silently exceed the authorisation given, so the writer
 * compares the regenerated plan against an explicit manifest of approved lead
 * ids and Gmail message ids and ABORTS on any drift. It never resolves the
 * difference itself.
 *
 * Nothing is written unless `apply: true` is passed explicitly. The default is
 * a dry run, so an ordinary invocation cannot mutate anything.
 */

const { RECONCILE_STATUS } = require('./reply-reconciliation');
const { malformedEmailReason } = require('./canonical-reply');

const WRITE_OUTCOME = Object.freeze({
  WRITTEN: 'written',
  SKIPPED_EXISTING: 'skipped_existing',   // provider message already recorded
  DRY_RUN: 'dry_run',                     // would have written
});

const ABORT_REASON = Object.freeze({
  PLAN_DRIFT: 'plan_drift',               // regenerated plan != approved manifest
  UNAPPROVED_LEAD: 'unapproved_lead',
  UNAPPROVED_MESSAGE: 'unapproved_message',
  DUPLICATE_MESSAGE_ID: 'duplicate_message_id',
  MALFORMED_IDENTITY: 'malformed_identity',
  AMBIGUOUS_IDENTITY: 'ambiguous_identity',
  NOT_PROPOSED: 'not_proposed',
});

class ReconciliationAbort extends Error {
  constructor(reason, detail) {
    super(`reconciliation aborted (${reason}): ${detail}`);
    this.reason = reason;
    this.detail = detail;
    this.aborted = true;
  }
}

const sortedUnique = values => [...new Set(values)].sort();

/**
 * Reduce a plan to the comparable shape a human signed off on: which leads, and
 * which Gmail messages. Everything else may legitimately vary (wording of a
 * summary, ordering) without meaning the approval no longer applies.
 */
function planManifest(plans = []) {
  const proposed = plans.filter(plan => plan.status === RECONCILE_STATUS.PROPOSED);
  return {
    leadIds: sortedUnique(proposed.map(plan => plan.leadId)),
    messageIds: sortedUnique(proposed.flatMap(plan =>
      (plan.proposedEvents || []).map(event => event.metadata.gmailMessageId))),
  };
}

/**
 * Does the freshly-generated plan still match what was approved?
 *
 * Returns a diff rather than a boolean, because "what changed" is the thing an
 * operator needs to see before deciding whether to re-review.
 */
function compareToApproved(plans, approved = {}) {
  const actual = planManifest(plans);
  const expectedLeads = sortedUnique(approved.leadIds || []);
  const expectedMessages = sortedUnique(approved.messageIds || []);
  const missing = (expected, got) => expected.filter(id => !got.includes(id));
  const added = (expected, got) => got.filter(id => !expected.includes(id));

  const diff = {
    leadsMissing: missing(expectedLeads, actual.leadIds),
    leadsAdded: added(expectedLeads, actual.leadIds),
    messagesMissing: missing(expectedMessages, actual.messageIds),
    messagesAdded: added(expectedMessages, actual.messageIds),
  };
  diff.matches = !diff.leadsMissing.length && !diff.leadsAdded.length
    && !diff.messagesMissing.length && !diff.messagesAdded.length;
  return { actual, expected: { leadIds: expectedLeads, messageIds: expectedMessages }, diff };
}

/**
 * Apply a reviewed plan.
 *
 * @param plans              regenerated plans, straight from production
 * @param approved           { leadIds, messageIds } — the reviewed manifest
 * @param existingActivities activities already stored, for idempotency
 * @param appendActivity     async (record) => void. THE ONLY CAPABILITY.
 * @param apply              must be exactly true to write anything
 */
async function applyReconciliation({
  plans = [], approved = {}, existingActivities = [],
  appendActivity = null, apply = false,
} = {}) {
  // ── PHASE 1: VALIDATE EVERYTHING BEFORE WRITING ANYTHING ─────────────────
  //
  // Validation is a separate pass on purpose. An earlier version checked each
  // event as it wrote, which meant a plan with a duplicate message in position
  // two had already written position one before it aborted — a partial write
  // from a run that reports failure. Nothing is appended now until the whole
  // plan has passed every gate.
  const proposed = plans.filter(plan => plan.status === RECONCILE_STATUS.PROPOSED);

  // Structural integrity first: these are defects in the plan itself, and would
  // be defects whatever an operator had approved.
  const seenMessageIds = new Set();
  for (const plan of proposed) {
    const identityIssue = malformedEmailReason(plan.email);
    if (identityIssue) {
      throw new ReconciliationAbort(ABORT_REASON.MALFORMED_IDENTITY,
        `lead ${plan.leadId} has an unusable identity: ${identityIssue}`);
    }
    for (const event of plan.proposedEvents || []) {
      const messageId = String(event.metadata.gmailMessageId || '');
      if (!messageId) {
        throw new ReconciliationAbort(ABORT_REASON.AMBIGUOUS_IDENTITY,
          `lead ${plan.leadId} has an event with no provider message id`);
      }
      if (seenMessageIds.has(messageId)) {
        throw new ReconciliationAbort(ABORT_REASON.DUPLICATE_MESSAGE_ID,
          `Gmail message ${messageId} appears more than once in the plan`);
      }
      seenMessageIds.add(messageId);
    }
  }

  // Provider messages already recorded anywhere in the activity log.
  const recorded = new Set();
  for (const row of existingActivities) {
    const id = String(row.eventId || '');
    if (id.startsWith('gmail-reply:')) recorded.add(id.slice('gmail-reply:'.length));
    try {
      const messageId = JSON.parse(row.metadata || '{}').gmailMessageId;
      if (messageId) recorded.add(String(messageId));
    } catch (_) { /* malformed metadata is reported by health, not repaired here */ }
  }

  // ALREADY DONE is not DRIFT.
  //
  // Once a plan has been applied, the planner reports its leads as
  // "already_reconciled" rather than "proposed", so the regenerated manifest is
  // legitimately empty. Comparing that against the approved manifest would read
  // as drift and abort — which is safe but wrong, because it tells an operator
  // "someone changed the set" when the truth is "this is finished". A replay
  // has to be able to say so.
  const approvedMessageIds = sortedUnique(approved.messageIds || []);
  const fullyApplied = approvedMessageIds.length > 0
    && approvedMessageIds.every(id => recorded.has(id));
  if (fullyApplied && !planManifest(plans).messageIds.length) {
    return {
      applied: Boolean(apply),
      alreadyComplete: true,
      comparison: compareToApproved(plans, approved),
      results: approvedMessageIds.map(messageId => ({ messageId, outcome: WRITE_OUTCOME.SKIPPED_EXISTING })),
      written: 0,
      skippedExisting: approvedMessageIds.length,
      wouldWrite: 0,
      leadsTouched: sortedUnique(approved.leadIds || []).length,
    };
  }

  // Then authorisation: is this still the set a human reviewed?
  const comparison = compareToApproved(plans, approved);
  if (!comparison.diff.matches) {
    throw new ReconciliationAbort(ABORT_REASON.PLAN_DRIFT,
      `regenerated plan differs from the approved set — `
      + `leads +${comparison.diff.leadsAdded.length}/-${comparison.diff.leadsMissing.length}, `
      + `messages +${comparison.diff.messagesAdded.length}/-${comparison.diff.messagesMissing.length}. `
      + `Re-review before applying.`);
  }

  const approvedLeads = new Set(comparison.expected.leadIds);
  const approvedMessages = new Set(comparison.expected.messageIds);
  for (const plan of proposed) {
    if (!approvedLeads.has(plan.leadId)) {
      throw new ReconciliationAbort(ABORT_REASON.UNAPPROVED_LEAD,
        `lead ${plan.leadId} is not in the approved set`);
    }
    for (const event of plan.proposedEvents || []) {
      if (!approvedMessages.has(String(event.metadata.gmailMessageId))) {
        throw new ReconciliationAbort(ABORT_REASON.UNAPPROVED_MESSAGE,
          `Gmail message ${event.metadata.gmailMessageId} is not in the approved set`);
      }
    }
  }

  if (apply && typeof appendActivity !== 'function') {
    throw new ReconciliationAbort(ABORT_REASON.NOT_PROPOSED,
      'apply was requested but no appendActivity capability was provided');
  }

  // ── PHASE 2: WRITE ───────────────────────────────────────────────────────
  const results = [];
  for (const plan of proposed) {
    for (const event of plan.proposedEvents || []) {
      const messageId = String(event.metadata.gmailMessageId);
      if (recorded.has(messageId)) {
        results.push({ leadId: plan.leadId, messageId, outcome: WRITE_OUTCOME.SKIPPED_EXISTING });
        continue;
      }
      if (!apply) {
        results.push({ leadId: plan.leadId, messageId, outcome: WRITE_OUTCOME.DRY_RUN });
        continue;
      }
      // The stored shape is IDENTICAL to live ingestion, plus provenance, so
      // downstream code never needs to know which path produced an event.
      await appendActivity({
        eventId: event.eventId,
        leadId: event.leadId,
        sourceLeadId: event.sourceLeadId,
        email: event.email,
        company: event.company,
        eventType: event.eventType,
        occurredAt: event.occurredAt,
        subject: event.subject,
        // Message bodies are deliberately NOT copied: the canonical evidence is
        // the classification plus the provider ids, and the original text
        // remains retrievable from Gmail.
        content: '',
        metadata: JSON.stringify({
          ...event.metadata,
          source: 'historical_reconciliation',
          identityMutationAllowed: false,
          reconciledAt: new Date().toISOString(),
        }),
      });
      recorded.add(messageId);
      results.push({ leadId: plan.leadId, messageId, outcome: WRITE_OUTCOME.WRITTEN });
    }
  }

  const count = outcome => results.filter(row => row.outcome === outcome).length;
  return {
    applied: Boolean(apply),
    comparison,
    results,
    written: count(WRITE_OUTCOME.WRITTEN),
    skippedExisting: count(WRITE_OUTCOME.SKIPPED_EXISTING),
    wouldWrite: count(WRITE_OUTCOME.DRY_RUN),
    leadsTouched: sortedUnique(results.map(row => row.leadId)).length,
  };
}

module.exports = {
  WRITE_OUTCOME, ABORT_REASON, ReconciliationAbort,
  planManifest, compareToApproved, applyReconciliation,
};
