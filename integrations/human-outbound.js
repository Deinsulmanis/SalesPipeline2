'use strict';
/**
 * human-outbound.js — make manual Gmail replies visible to the CRM. PURE.
 * ─────────────────────────────────────────────────────────────────────────────
 * THE GAP THIS CLOSES
 *
 * The canonical event `human_response_sent` already existed and was already
 * consumed correctly: deriveNextAction reads it as `humanTouchAt` (which is
 * what flips a lead to waiting-on-prospect), and the sequence engine treats it
 * as human intervention and stops. The vocabulary and every consumer were
 * built.
 *
 * Nothing ever wrote it from Gmail. The single writer was the CRM's own "Log
 * response" button, and production contains ZERO such rows — because in
 * practice people answer prospects from their inbox, not from the CRM. So six
 * real manual replies existed in Gmail while the CRM believed nobody had
 * answered, and automation was reasoning from a conversation it could not see.
 *
 * This module observes those messages and turns them into canonical evidence.
 * It is a PLANNER: it returns proposed activities and writes nothing.
 *
 * THREE RULES
 *
 * 1. An outbound message is NOT a reply. It is written as `human_response_sent`
 *    and never as any *_reply type, so reply classification, the funnel and
 *    campaign attribution are untouched. We are recording that WE spoke, not
 *    inventing something the prospect said.
 *
 * 2. Identity is provider-backed or it does not happen. A message matches a
 *    lead by exact recipient address, or by Gmail THREAD — the thread is the
 *    provider's own statement that these messages are one conversation, which
 *    is how a reply sent to a supplied decision-maker address still attaches to
 *    the right lead without any fuzzy matching.
 *
 * 3. Matching a thread is not adopting an address. A message to a
 *    decision-maker address is conversation evidence only; the lead's canonical
 *    identity is untouched and nothing may auto-send to that address.
 */

const { malformedEmailReason } = require('./canonical-reply');

const HUMAN_OUTBOUND_EVENT = 'human_response_sent';

const MATCH = Object.freeze({
  EXACT_RECIPIENT: 'exact_recipient',   // sent straight to the lead's address
  PROVIDER_THREAD: 'provider_thread',   // same Gmail thread as known lead activity
  NONE: 'none',
});

const OUTCOME = Object.freeze({
  PROPOSED: 'proposed',
  ALREADY_RECORDED: 'already_recorded',
  NO_MATCH: 'no_match',                 // not a known lead — deliberately ignored
  UNUSABLE_IDENTITY: 'unusable_identity',
  NOT_A_RESPONSE: 'not_a_response',     // an opener, not an answer to anything
});

const norm = value => String(value || '').trim().toLowerCase();

/** `gmail-outbound:<messageId>` — provider identity, so replay is a no-op. */
const outboundEventId = messageId => `gmail-outbound:${String(messageId || '').trim()}`;

/**
 * Match one sent message to a lead.
 *
 * Exact recipient first, then Gmail thread. Nothing else — no company names, no
 * domains, no contact names. A message we cannot attribute is reported and
 * skipped, because attaching it to the wrong conversation would be worse than
 * not seeing it at all.
 */
function matchOutbound(message = {}, { leadsByEmail = new Map(), leadIdByThread = new Map() } = {}) {
  for (const recipient of (message.to || [])) {
    const lead = leadsByEmail.get(norm(recipient));
    if (lead) return { leadId: lead.id, lead, via: MATCH.EXACT_RECIPIENT, matchedOn: norm(recipient) };
  }
  const threadLead = leadIdByThread.get(String(message.threadId || ''));
  if (threadLead) {
    return {
      leadId: threadLead.id, lead: threadLead, via: MATCH.PROVIDER_THREAD,
      matchedOn: String(message.threadId || ''),
      // The address we actually wrote to, when it is not the lead's own. This
      // is evidence, never a proposal to change identity.
      sentToOtherAddress: (message.to || []).map(norm).find(to => to !== norm(threadLead.email)) || null,
    };
  }
  return { leadId: null, lead: null, via: MATCH.NONE };
}

/**
 * Plan the canonical activity for one sent message.
 *
 * `existingActivities` is the whole activity log for the matched lead, used for
 * idempotency: a message already recorded proposes nothing.
 */
function planOutboundActivity(message = {}, context = {}) {
  const { existingActivitiesByLead = new Map(), threadsWithInbound = new Set() } = context;
  const match = matchOutbound(message, context);
  const base = {
    gmailMessageId: message.id || null, gmailThreadId: message.threadId || null,
    sentAt: message.sentAt || null, to: (message.to || []).map(norm),
  };

  if (!match.leadId) {
    return { ...base, outcome: OUTCOME.NO_MATCH, match: MATCH.NONE, activity: null,
      reason: 'no lead matches this recipient or thread' };
  }
  const identityIssue = malformedEmailReason(match.lead.email);
  if (identityIssue) {
    return { ...base, outcome: OUTCOME.UNUSABLE_IDENTITY, match: match.via, activity: null,
      leadId: match.leadId, reason: `matched lead has an unusable identity: ${identityIssue}` };
  }
  if (!message.id) {
    return { ...base, outcome: OUTCOME.NO_MATCH, match: match.via, activity: null,
      leadId: match.leadId, reason: 'the message carries no provider id, so it cannot be recorded safely' };
  }

  // `human_response_sent` means we ANSWERED someone. A message in a thread the
  // prospect never wrote into is not an answer — it is an opener, and almost
  // always one the sender itself produced.
  //
  // This check exists because the first version of this module did not have it
  // and proposed a "human response" for every automated cold email in the
  // mailbox. That would have marked the entire cold campaign as personally
  // answered, flipped those leads to waiting-on-prospect, and silently stopped
  // outreach. The thread carrying an inbound message is the provider's own
  // evidence that a conversation exists.
  if (!threadsWithInbound.has(String(message.threadId || ''))) {
    return { ...base, outcome: OUTCOME.NOT_A_RESPONSE, match: match.via, activity: null,
      leadId: match.leadId, company: match.lead.company || '',
      reason: 'no inbound message exists in this thread, so this is an outbound opener rather than a response' };
  }

  const eventId = outboundEventId(message.id);
  const existing = existingActivitiesByLead.get(match.leadId) || [];
  const already = existing.some(row => {
    if (String(row.eventId || '') === eventId) return true;
    try { return String(JSON.parse(row.metadata || '{}').gmailMessageId || '') === String(message.id); }
    catch (_) { return false; }
  });
  if (already) {
    return { ...base, outcome: OUTCOME.ALREADY_RECORDED, match: match.via, activity: null,
      leadId: match.leadId, company: match.lead.company || '', reason: 'already recorded' };
  }

  return {
    ...base,
    outcome: OUTCOME.PROPOSED, match: match.via,
    leadId: match.leadId, company: match.lead.company || '',
    sentToOtherAddress: match.sentToOtherAddress || null,
    activity: {
      eventId,
      leadId: `CE-${match.lead.id}`, sourceLeadId: match.lead.id,
      // The lead's CANONICAL address, not whoever we happened to write to.
      email: match.lead.email, company: match.lead.company || '',
      eventType: HUMAN_OUTBOUND_EVENT,
      occurredAt: message.sentAt || '',
      subject: message.subject || '',
      // No body is copied: the canonical fact is that we responded and when.
      content: '',
      metadata: {
        provider: 'gmail',
        direction: 'outbound', actor: 'human',
        trigger: 'gmail_outbound_ingestion',
        gmailMessageId: message.id,
        gmailThreadId: message.threadId || '',
        sentAt: message.sentAt || '',
        matchedColdEmailId: match.lead.id,
        matchedVia: match.via,
        matchedOn: match.matchedOn || null,
        // Present only when we wrote to a different address than the lead's —
        // a decision-maker contact, typically. Evidence ONLY: it must never
        // become the canonical identity or an automatic send target.
        sentToOtherAddress: match.sentToOtherAddress || null,
        identityMutationAllowed: false,
        autoSendAllowed: false,
        // This is OUR message. Nothing here may be read as a prospect reply.
        isProspectReply: false,
      },
    },
  };
}

/** Plan a whole ingestion pass and summarise it. Writes nothing. */
function planHumanOutboundIngestion(messages = [], context = {}) {
  // Deduplicate WITHIN the batch as well as against stored history. A provider
  // listing can return the same message twice across pages, and planning each
  // one independently would emit two activities sharing an event id.
  const seenInBatch = new Set();
  const plans = messages.map(message => {
    const id = String(message && message.id || '');
    if (id && seenInBatch.has(id)) {
      return {
        gmailMessageId: id, gmailThreadId: message.threadId || null,
        sentAt: message.sentAt || null, to: (message.to || []),
        outcome: OUTCOME.ALREADY_RECORDED, match: MATCH.NONE, activity: null,
        reason: 'this provider message already appears earlier in the same batch',
      };
    }
    const plan = planOutboundActivity(message, context);
    if (id && plan.outcome === OUTCOME.PROPOSED) seenInBatch.add(id);
    return plan;
  });
  const byOutcome = {};
  for (const plan of plans) byOutcome[plan.outcome] = (byOutcome[plan.outcome] || 0) + 1;
  const proposed = plans.filter(plan => plan.outcome === OUTCOME.PROPOSED);
  // One activity per provider message, so a replay of the same pass is a no-op.
  const ids = proposed.map(plan => plan.activity.eventId);
  return {
    plans, byOutcome,
    proposedCount: proposed.length,
    leadsTouched: [...new Set(proposed.map(plan => plan.leadId))].length,
    duplicateEventIds: ids.length - new Set(ids).size,
    applied: false, mutatesProduction: false,
  };
}

/**
 * The latest human outbound instant for a lead, from canonical activity.
 * This is what makes a manual reply visible to ownership without any
 * out-of-band flag.
 */
function latestHumanOutboundAt(activities = []) {
  const times = activities
    .filter(row => String(row.eventType || '') === HUMAN_OUTBOUND_EVENT)
    .map(row => Date.parse(row.occurredAt || ''))
    .filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

module.exports = {
  HUMAN_OUTBOUND_EVENT, MATCH, OUTCOME,
  outboundEventId, matchOutbound, planOutboundActivity,
  planHumanOutboundIngestion, latestHumanOutboundAt,
};
