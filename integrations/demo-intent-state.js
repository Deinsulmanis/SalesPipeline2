'use strict';

// Canonical facts for the demo-pair -> booking-link workflow.  This module is
// deliberately pure: it can be used by the sender, API and tests without
// importing outreach-agent.js (which executes a worker when required).
const DEMO_PAIR_EVENT = 'demo_pair_played';
// A pair that should never have been written — company-name fan-out attributed
// one listening session to several locations of one brand. The false event is
// SUPERSEDED rather than deleted: the timeline keeps the evidence of what
// happened, and every reader below agrees on what is still true.
const DEMO_PAIR_RETRACTED_EVENT = 'demo_pair_retracted';
const BOOKING_LINK_EVENT = 'booking_link_sent';

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function bareLeadId(value) {
  return String(value || '').trim().replace(/^CE-/, '');
}

function activityMatchesLead(row = {}, lead = {}) {
  const id = bareLeadId(lead.id);
  const rowIds = [row.leadId, row.sourceLeadId].map(bareLeadId);
  const email = normalizeEmail(lead.email);
  return Boolean((id && rowIds.includes(id)) || (email && normalizeEmail(row.email) === email));
}

function activitiesForLead(lead, activities = []) {
  return activities.filter(row => activityMatchesLead(row, lead));
}

function parseMetadata(row = {}) {
  try { return JSON.parse(row.metadata || '{}') || {}; } catch (_e) { return {}; }
}

/**
 * The pair events in `rows` that have not been retracted.
 *
 * A retraction names the event id it cancels, so it can only ever supersede the
 * exact pair it was written for — never a later, legitimate one. `rows` must
 * already be scoped to a single lead.
 */
function activeDemoPairEvents(rows = []) {
  const retracted = new Set((rows || [])
    .filter(row => String(row.eventType || '') === DEMO_PAIR_RETRACTED_EVENT)
    .map(row => String(parseMetadata(row).retractsEventId || ''))
    .filter(Boolean));
  return (rows || []).filter(row => String(row.eventType || '') === DEMO_PAIR_EVENT
    && !retracted.has(String(row.eventId || '')));
}

/** The lead's current pair, or null once it has been retracted. */
function demoPairEventFor(lead, activities = []) {
  return activeDemoPairEvents(activitiesForLead(lead, activities))
    .sort((a, b) => String(b.occurredAt || '').localeCompare(String(a.occurredAt || '')))[0] || null;
}

/**
 * Has this lead EVER had a pair, retracted or not?
 *
 * Creation asks this rather than demoPairEventFor, because a retraction empties
 * the active pair and an emptied pair looks exactly like a lead that never had
 * one — which would make the next pass write the false event all over again.
 */
function hasDemoPairHistory(lead, activities = []) {
  return activitiesForLead(lead, activities)
    .some(row => String(row.eventType || '') === DEMO_PAIR_EVENT);
}

function bookingLinkEventFor(lead, activities = []) {
  return activitiesForLead(lead, activities)
    .filter(row => String(row.eventType || '') === BOOKING_LINK_EVENT)
    .sort((a, b) => String(b.occurredAt || '').localeCompare(String(a.occurredAt || '')))[0] || null;
}

function hasUndeliveredDemoPair(lead, activities = []) {
  return Boolean(demoPairEventFor(lead, activities) && !bookingLinkEventFor(lead, activities));
}

function demoPairEventId(lead) {
  const id = bareLeadId(lead && lead.id);
  if (!id) throw new Error('demo-pair event requires a stable lead id');
  return `demo-pair:${id}`;
}

function qualifyingDemoPair(play = {}) {
  if (Number(play.intro || 0) < 1 || Number(play.demo || 0) < 1) return null;
  const introPlayedAt = String(play.introPlayedAt || '');
  const demoPlayedAt = String(play.demoPlayedAt || '');
  const occurredAt = String(play.last || [introPlayedAt, demoPlayedAt].filter(Boolean).sort().at(-1) || '');
  if (!occurredAt) return null;
  return { introPlayedAt, demoPlayedAt, occurredAt };
}

function buildDemoPairActivity(lead, play, { timelineLeadId = '', campaign = '', campaignVersion = '' } = {}) {
  const pair = qualifyingDemoPair(play);
  if (!pair) throw new Error('demo-pair activity requires verified intro and demo plays');
  const sourceLeadId = bareLeadId(lead.id);
  return {
    eventId: demoPairEventId(lead),
    leadId: timelineLeadId || `CE-${sourceLeadId}`,
    sourceLeadId,
    email: String(lead.email || '').trim(),
    company: String(lead.company || '').trim(),
    eventType: DEMO_PAIR_EVENT,
    occurredAt: pair.occurredAt,
    subject: '',
    content: '',
    metadata: JSON.stringify({
      trigger: 'verified_demo_pair',
      introPlayedAt: pair.introPlayedAt,
      demoPlayedAt: pair.demoPlayedAt,
      senderInboxId: String(lead.senderInboxId || ''),
      campaign: String(campaign || lead.campaign || ''),
      campaignVersion: String(campaignVersion || lead.campaignVersion || ''),
    }),
  };
}

/**
 * Supersede a pair that was attributed to the wrong lead.
 *
 * Deliberately demanding: it must name the exact event it cancels and say why,
 * because a retraction is a claim that recorded prospect behaviour did not
 * happen. Replay-safe — the id is derived from the event being retracted, so
 * running the repair twice proposes the same row.
 */
function buildDemoPairRetraction(lead, pairEvent = {}, { reason = '', retractedAt = '', evidence = {} } = {}) {
  const retractsEventId = String(pairEvent.eventId || '').trim();
  if (!retractsEventId) throw new Error('a retraction requires the event id it supersedes');
  const why = String(reason || '').trim();
  if (!why) throw new Error('a retraction requires a stated reason');
  const occurredAt = String(retractedAt || '').trim();
  if (!occurredAt) throw new Error('a retraction requires the instant it was retracted at');
  const sourceLeadId = bareLeadId(lead.id);
  return {
    eventId: `retract:${retractsEventId}`,
    leadId: String(pairEvent.leadId || `CE-${sourceLeadId}`),
    sourceLeadId,
    email: String(lead.email || '').trim(),
    company: String(lead.company || '').trim(),
    eventType: DEMO_PAIR_RETRACTED_EVENT,
    occurredAt,
    subject: '',
    content: '',
    metadata: JSON.stringify({
      trigger: 'attribution_retraction',
      retractsEventId,
      retractedPairOccurredAt: String(pairEvent.occurredAt || ''),
      reason: why,
      ...evidence,
    }),
  };
}

function planIntentObservation(candidates = [], senders = []) {
  const eligible = new Map(senders.filter(sender => sender.sendEligible)
    .map(sender => [String(sender.id || ''), sender]));
  const groups = new Map();
  const blocked = [];
  for (const lead of candidates) {
    const senderId = String(lead.senderInboxId || '').trim();
    if (!senderId || !eligible.has(senderId)) {
      blocked.push({ lead, reason: senderId ? 'sender_unavailable' : 'sender_proof_missing' });
      continue;
    }
    const bucket = groups.get(senderId) || [];
    bucket.push(lead);
    groups.set(senderId, bucket);
  }
  return { groups, blocked, providerWorkRequired: groups.size > 0 };
}

module.exports = {
  DEMO_PAIR_EVENT,
  DEMO_PAIR_RETRACTED_EVENT,
  BOOKING_LINK_EVENT,
  activityMatchesLead,
  activitiesForLead,
  activeDemoPairEvents,
  demoPairEventFor,
  hasDemoPairHistory,
  bookingLinkEventFor,
  hasUndeliveredDemoPair,
  demoPairEventId,
  qualifyingDemoPair,
  buildDemoPairActivity,
  buildDemoPairRetraction,
  planIntentObservation,
};
