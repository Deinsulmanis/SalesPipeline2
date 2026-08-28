'use strict';
/**
 * reply-reconciliation.js — recover historical reply evidence. PURE.
 * ─────────────────────────────────────────────────────────────────────────────
 * Production carries 22 reply-bearing leads whose only evidence is a
 * `[REPLY: ...]` tag written by a process that no longer exists, plus zero
 * canonical reply activities, because canonical ingestion only went live on
 * 2026-08-27. The original Gmail messages are still there. This module turns
 * those messages back into canonical evidence.
 *
 * It is a PLANNER, not a writer. Every function returns a proposal; nothing
 * here touches Gmail, Sheets, a lead, a hold, or a suppression list. The caller
 * decides whether a plan is ever applied, and a human authorises that.
 *
 * THREE RULES SHAPE EVERYTHING BELOW
 *
 * 1. Fail closed on identity. A message is reconciled only when its sender
 *    address EXACTLY matches the lead's normalized address. No company-name
 *    matching, no domain guessing, no "probably the same person". If identity
 *    cannot be established, the record is skipped and reported — an unreconciled
 *    lead is a known gap, whereas a wrongly-matched one is a silent lie.
 *
 * 2. Never overwrite history. A legacy tag is preserved on the proposed event
 *    even when the classifier disagrees with it. Disagreement is DATA: it tells
 *    us the old classifier was wrong about Glamore, and that record is worth
 *    keeping. The point is not to make dashboard numbers look cleaner.
 *
 * 3. Idempotent by provider identity. The proposed event id is derived from the
 *    Gmail message id, and a message already present in the activity log is
 *    skipped. Running reconciliation twice must change nothing the second time.
 */

const {
  REPLY_STATE, EVIDENCE_SOURCE, GENUINE_HUMAN_STATES, CLASSIFIER_VERSION,
  classifyReplyText, isUsableReplyIdentity, malformedEmailReason, legacyTagsFrom,
  stateFromLegacyTag,
} = require('./canonical-reply');

// Outcomes of planning ONE lead. Every one is reportable; none is a silent drop.
const RECONCILE_STATUS = Object.freeze({
  PROPOSED: 'proposed',                 // a canonical event would be created
  ALREADY_RECONCILED: 'already_reconciled', // provider evidence already stored
  NO_GMAIL_EVIDENCE: 'no_gmail_evidence',   // nothing found for this identity
  IDENTITY_UNUSABLE: 'identity_unusable',   // malformed/ambiguous — fail closed
  IDENTITY_MISMATCH: 'identity_mismatch',   // messages exist but not from this lead
  NO_MESSAGE_BODY: 'no_message_body',       // found, but nothing to classify
});

const norm = value => String(value || '').trim().toLowerCase();

/**
 * Keep only the sender's OWN words, discarding the quoted thread beneath them.
 *
 * This matters more than it looks. A real historical message ran 8,075
 * characters, of which 2,150 were the prospect's reply and the rest was OUR
 * cold email quoted underneath. Classifying the whole blob meant classifying
 * our own copy, and three leads whose legacy tag correctly said "positive"
 * came back "negative" purely from that contamination.
 */
function stripQuotedReply(text) {
  const body = String(text || '').split('\r\n').join('\n');
  const markers = [
    /^\s*On .{0,200}wrote:\s*$/m,          // Gmail / Apple Mail
    /^\s*-{2,}\s*Original Message\s*-{2,}/im,
    /^\s*From:\s.+$/m,                     // Outlook block
    /^\s*_{10,}\s*$/m,                     // Outlook divider
    /^\s*Sent from my /m,
    /^>/m,                                  // classic quote prefix
  ];
  let cut = body.length;
  for (const marker of markers) {
    const match = marker.exec(body);
    if (match && match.index < cut) cut = match.index;
  }
  return body.slice(0, cut).trim();
}

/**
 * Last-resort text for HTML-only messages. Several historical autoresponders
 * carry no text/plain part at all, and returning '' for those would report
 * "no message body" for a message we can plainly read.
 */
function htmlToText(html) {
  const NEWLINE = '\n';
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, NEWLINE)
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, NEWLINE)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, NEWLINE + NEWLINE)
    .trim();
}

/** The text actually worth classifying: own words first, HTML as fallback. */
function classifiableText(message = {}) {
  const fromPlain = stripQuotedReply(message.body || '');
  if (fromPlain) return fromPlain;
  const fromHtml = stripQuotedReply(htmlToText(message.html || ''));
  return fromHtml;
}

/** `gmail-reply:<messageId>` — the same identity the live writer uses. */
const reconciledEventId = messageId => `gmail-reply:${String(messageId || '').trim()}`;

/**
 * Has this provider message already been recorded? Checked against the existing
 * activity log so a second run proposes nothing.
 */
function alreadyRecorded(messageId, activities = []) {
  const eventId = reconciledEventId(messageId);
  return activities.some(row => {
    if (String(row.eventId || '') === eventId) return true;
    try {
      return String(JSON.parse(row.metadata || '{}').gmailMessageId || '') === String(messageId);
    } catch (_) { return false; }
  });
}

/**
 * Plan the reconciliation of ONE lead from already-fetched Gmail messages.
 *
 * @param lead        the ColdEmail row
 * @param messages    inbound messages, each { id, threadId, from, subject, body, receivedAt }
 * @param activities  that lead's existing canonical activities
 */
function planLeadReconciliation(lead = {}, messages = [], activities = []) {
  const leadEmail = norm(lead.email);
  const legacyTags = legacyTagsFrom(lead.notes);
  const legacyTag = legacyTags[0] || null;
  const legacyMapped = legacyTag ? stateFromLegacyTag(legacyTag) : null;

  const base = {
    leadId: lead.id, company: lead.company || '', email: lead.email || '',
    legacyTag, legacyState: legacyMapped ? legacyMapped.state : null,
  };

  // RULE 1 — identity first. A malformed address cannot have received our mail,
  // so nothing attributed to it can be trusted, whatever Gmail returns.
  const identityIssue = malformedEmailReason(lead.email);
  if (identityIssue) {
    return {
      ...base, status: RECONCILE_STATUS.IDENTITY_UNUSABLE,
      reason: `lead identity is unusable: ${identityIssue}`,
      identityIssue, proposedEvent: null,
    };
  }

  // Only messages whose sender EXACTLY matches this lead may be used.
  const exact = messages.filter(message => norm(message.from) === leadEmail);
  if (!messages.length) {
    return {
      ...base, status: RECONCILE_STATUS.NO_GMAIL_EVIDENCE,
      reason: 'no inbound Gmail message exists for this address',
      proposedEvent: null,
    };
  }
  if (!exact.length) {
    return {
      ...base, status: RECONCILE_STATUS.IDENTITY_MISMATCH,
      reason: `${messages.length} message(s) found, but none is from the lead's exact address`,
      proposedEvent: null,
    };
  }

  // EVERY exact-match message is reconciled, not just one.
  //
  // Keeping only the newest message loses real history. One lead first replied
  // "we will review and forward to our office manager" and later supplied that
  // manager's address; collapsing to the newest message threw away the
  // forwarded-to-decision-maker signal entirely. Each Gmail message already has
  // its own id, so one event per message stays naturally idempotent.
  const ordered = [...exact].sort((a, b) =>
    String(a.receivedAt || '').localeCompare(String(b.receivedAt || '')));

  const classified = ordered.map(message => {
    const text = classifiableText(message);
    return {
      message, text,
      result: classifyReplyText(text, {
        subject: message.subject || '', currentEmail: lead.email,
        year: message.receivedAt ? new Date(message.receivedAt).getUTCFullYear() : null,
      }),
    };
  }).filter(entry => String(entry.text || '').trim());

  if (!classified.length) {
    return {
      ...base, status: RECONCILE_STATUS.NO_MESSAGE_BODY,
      reason: 'messages were found but none carries readable text to classify',
      proposedEvent: null, proposedEvents: [],
    };
  }

  const fresh = classified.filter(entry => !alreadyRecorded(entry.message.id, activities));
  if (!fresh.length) {
    return {
      ...base, status: RECONCILE_STATUS.ALREADY_RECONCILED,
      reason: `canonical evidence already exists for all ${classified.length} message(s)`,
      messageCount: classified.length, proposedEvent: null, proposedEvents: [],
    };
  }

  // The lead's REPRESENTATIVE state: the most recent genuine human message,
  // falling back to the most recent message of any kind. This is what analytics
  // reads; the per-message events below preserve the whole conversation.
  const newestFirst = [...classified].reverse();
  const representative = newestFirst.find(entry => GENUINE_HUMAN_STATES.includes(entry.result.state))
    || newestFirst[0];
  const result = representative.result;

  // RULE 2 — the legacy classification travels WITH the new one, and the
  // disagreement is stated explicitly rather than quietly resolved.
  const disagreement = legacyMapped && legacyMapped.state !== result.state
    ? { legacyState: legacyMapped.state, canonicalState: result.state, legacyTag }
    : null;

  const buildEvent = entry => ({
    eventId: reconciledEventId(entry.message.id),
    leadId: `CE-${lead.id}`, sourceLeadId: lead.id, email: lead.email,
    company: lead.company || '',
    eventType: eventTypeFor(entry.result.state),
    occurredAt: entry.message.receivedAt || '',
    subject: entry.message.subject || '',
    metadata: {
      provider: 'gmail',
      gmailMessageId: entry.message.id,
      gmailThreadId: entry.message.threadId || '',
      receivedAt: entry.message.receivedAt || '',
      matchedColdEmailId: lead.id,
      canonicalState: entry.result.state,
      subtype: entry.result.subtype || null,
      reason: entry.result.reason || null,
      classifierVersion: entry.result.classifierVersion || CLASSIFIER_VERSION,
      confidence: entry.result.confidence || null,
      evidenceSignals: entry.result.signals || [],
      genuineHuman: entry.result.genuineHuman,
      returnDate: entry.result.returnDate || null,
      proposedEmail: entry.result.proposedEmail || null,
      identityMutationAllowed: false,
      // Provenance: RECOVERED, not observed live, so an audit can tell them apart.
      source: 'historical_reconciliation',
      legacyTag: legacyTag || null,
      legacyState: legacyMapped ? legacyMapped.state : null,
      supersedesLegacyTag: Boolean(disagreement) && entry === representative,
      isRepresentative: entry === representative,
    },
  });

  const proposedEvents = fresh.map(buildEvent);
  return {
    ...base,
    status: RECONCILE_STATUS.PROPOSED,
    reason: `provider-backed evidence recovered from ${proposedEvents.length} original Gmail message(s)`,
    canonicalState: result.state,
    subtype: result.subtype || null,
    classificationReason: result.reason || null,
    genuineHuman: result.genuineHuman,
    disagreement,
    messageCount: classified.length,
    providerMessageId: representative.message.id,
    // Every message's classification, oldest first — the conversation, kept.
    messageStates: classified.map(entry => ({
      gmailMessageId: entry.message.id,
      receivedAt: entry.message.receivedAt || '',
      canonicalState: entry.result.state,
      subtype: entry.result.subtype || null,
      reason: entry.result.reason || null,
      genuineHuman: entry.result.genuineHuman,
    })),
    proposedEvents,
    proposedEvent: proposedEvents.find(event => event.metadata.isRepresentative) || proposedEvents[0],
  };
}

// Canonical state -> the activity event type already in use, so reconciled
// events join the existing vocabulary rather than inventing a parallel one.
function eventTypeFor(state) {
  switch (state) {
    case REPLY_STATE.POSITIVE: return 'positive_reply';
    case REPLY_STATE.NEGATIVE: return 'negative_reply';
    case REPLY_STATE.NEEDS_HUMAN: return 'needs_human_reply';
    case REPLY_STATE.AUTOMATED_REPLY: return 'out_of_office_reply';
    case REPLY_STATE.CONTACT_CHANGE_REVIEW: return 'wrong_person_reply';
    default: return 'needs_human_reply';
  }
}

/**
 * Plan a whole reconciliation run and summarise how analytics WOULD move.
 * Returns a report; applying it is a separate, human-authorised decision.
 */
function planReconciliation(entries = []) {
  const plans = entries.map(entry =>
    planLeadReconciliation(entry.lead, entry.messages || [], entry.activities || []));

  const byStatus = {};
  for (const plan of plans) byStatus[plan.status] = (byStatus[plan.status] || 0) + 1;

  const proposed = plans.filter(plan => plan.status === RECONCILE_STATUS.PROPOSED);
  const proposedEventCount = proposed.reduce((sum, plan) => sum + (plan.proposedEvents || []).length, 0);
  const disagreements = proposed.filter(plan => plan.disagreement);

  // Projected canonical partition, counting only what evidence supports.
  const projected = { positive: 0, negative: 0, needs_human: 0, automated_reply: 0, contact_change_review: 0, unknown: 0 };
  for (const plan of plans) {
    if (plan.status === RECONCILE_STATUS.PROPOSED) projected[plan.canonicalState] += 1;
    else projected.unknown += 1;
  }
  const genuine = proposed.filter(plan => plan.genuineHuman).length;

  return {
    plans, byStatus,
    proposedCount: proposed.length,
    proposedEventCount,
    disagreementCount: disagreements.length,
    disagreements: disagreements.map(plan => ({
      leadId: plan.leadId, company: plan.company, ...plan.disagreement,
    })),
    projected,
    projectedGenuineReplies: genuine,
    // Explicitly stated so nobody mistakes a plan for a write.
    applied: false,
    mutatesProduction: false,
  };
}

module.exports = {
  RECONCILE_STATUS, planLeadReconciliation, planReconciliation,
  stripQuotedReply, htmlToText, classifiableText,
  reconciledEventId, alreadyRecorded, eventTypeFor,
};
