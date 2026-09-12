'use strict';

// Canonical facts for the demo-pair -> booking-link workflow.  This module is
// deliberately pure: it can be used by the sender, API and tests without
// importing outreach-agent.js (which executes a worker when required).
const DEMO_PAIR_EVENT = 'demo_pair_played';
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

function demoPairEventFor(lead, activities = []) {
  return activitiesForLead(lead, activities)
    .filter(row => String(row.eventType || '') === DEMO_PAIR_EVENT)
    .sort((a, b) => String(b.occurredAt || '').localeCompare(String(a.occurredAt || '')))[0] || null;
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
  BOOKING_LINK_EVENT,
  activityMatchesLead,
  activitiesForLead,
  demoPairEventFor,
  bookingLinkEventFor,
  hasUndeliveredDemoPair,
  demoPairEventId,
  qualifyingDemoPair,
  buildDemoPairActivity,
  planIntentObservation,
};
