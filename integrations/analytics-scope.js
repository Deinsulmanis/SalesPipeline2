'use strict';

/**
 * analytics-scope.js — which records an analytics number is allowed to count.
 * PURE. The one place "active" and "historical" are defined for reporting.
 *
 *   ACTIVE      the live outreach operation. A lead counts only when it is
 *               neither archived nor in a retired offer — the SAME test every
 *               send gate and the Archive use (lead-archive outreachBlockForLead),
 *               so retiring an offer or archiving a lead removes it from active
 *               analytics with no analytics change at all.
 *   HISTORICAL  every lead ever contacted, archived and retired included. Only
 *               views that say "historical / all time" may use it.
 *
 * Activity belongs to the scope of its lead. Mailbox-level and board-only
 * events (no ColdEmail lead) are not cold-outreach activity and are never in
 * the active scope.
 */

const { outreachBlockForLead, RETIRED_OFFERS } = require('./lead-archive');
const { CAMPAIGN_VERSIONS } = require('./campaign-versions');
const { retractedBounceEventIds } = require('./delivery-status');

const ANALYTICS_SCOPE = Object.freeze({ ACTIVE: 'active', HISTORICAL: 'historical' });
const REPORTING_TIMEZONE = 'America/Vancouver';

function parseAnalyticsScope(value) {
  return String(value || '').trim().toLowerCase() === ANALYTICS_SCOPE.HISTORICAL
    ? ANALYTICS_SCOPE.HISTORICAL : ANALYTICS_SCOPE.ACTIVE;
}

/** A lead of the live outreach operation: not archived, offer not retired. */
function isActiveOutreachLead(lead) {
  return Boolean(lead && typeof lead === 'object' && String(lead.id || '').trim()) && !outreachBlockForLead(lead);
}

function scopeLeads(leads = [], scope = ANALYTICS_SCOPE.ACTIVE) {
  return parseAnalyticsScope(scope) === ANALYTICS_SCOPE.HISTORICAL
    ? leads.slice() : leads.filter(isActiveOutreachLead);
}

/** The ColdEmail lead an activity row belongs to, or ''. */
function activityLeadKey(row = {}) {
  return String(row.sourceLeadId || row.source_lead_id || '').trim()
    || String(row.leadId || row.lead_id || '').replace(/^CE-/, '').trim();
}

/** Rows whose lead is in `leads` (by exact id). */
function activitiesForLeads(activities = [], leads = []) {
  const ids = new Set(leads.map(lead => String(lead.id || '').trim()).filter(Boolean));
  return activities.filter(row => ids.has(activityLeadKey(row)));
}

/**
 * Campaign versions that can still send: active (or approved) and not in a
 * retired offer's family. Derived, never listed by hand, so the default
 * analytics campaign follows the offers that are actually live.
 */
function liveCampaignVersions() {
  const retiredFamilies = new Set(RETIRED_OFFERS.map(offer => offer.family));
  return Object.values(CAMPAIGN_VERSIONS)
    .filter(version => ['active', 'approved'].includes(version.status) && !retiredFamilies.has(version.family))
    .map(version => version.id);
}

/** The default campaign for "Current campaign" views, or '' when none is live. */
function currentLiveCampaignVersion() {
  return liveCampaignVersions()[0] || '';
}

/**
 * numerator ÷ denominator as a percentage, or null when the denominator is
 * zero, missing or not finite. A rate with nothing to divide by is unknown —
 * never 0%, NaN or Infinity.
 */
function safePercent(numerator, denominator) {
  const n = Number(numerator);
  const d = Number(denominator);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return null;
  return n / d * 100;
}

function vancouverDay(value) {
  const at = new Date(value || '');
  return Number.isFinite(at.getTime()) ? at.toLocaleDateString('en-CA', { timeZone: REPORTING_TIMEZONE }) : '';
}

const COLD_SEND_TYPES = new Set(['initial_email_sent', 'follow_up_sent']);
const INBOUND_PATTERN = /(reply|meeting_requested)/;

function parseMetadata(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '{}')); } catch (_) { return {}; }
}

/**
 * Per-inbox performance of the ACTIVE outreach operation.
 *
 *   firstSends / followUps   provider-confirmed cold sends (Gmail message id),
 *                            counted once per message; reservations, failures,
 *                            manual replies and stage sequences are not sends
 *   sentToday                the same, Vancouver day of `now`, for active leads
 *   repliedLeads             leads with an inbound message observed on the inbox
 *   bouncedLeads             leads with a bounce attributed to the inbox
 *   queued / inSequence      active workload assigned to the inbox
 *
 * replyCategoryByLead maps a lead to its canonical reply category so
 * genuine/positive use the same classification as every other surface.
 */
function buildSenderAnalytics({ leads = [], activities = [], senders = [], replyCategoryByLead = new Map(), now = new Date() } = {}) {
  const active = leads.filter(isActiveOutreachLead);
  const activeIds = new Set(active.map(lead => lead.id));
  const today = vancouverDay(now);
  const rows = new Map(senders.map(sender => [sender.id, {
    id: sender.id, email: sender.email || '', dailyLimit: Number(sender.dailyLimit) || 0,
    staffingOnly: Boolean(sender.staffingOnly), status: sender.status || '',
    firstSends: 0, followUps: 0, sentToday: 0,
    repliedLeads: new Set(), genuineReplyLeads: new Set(), positiveLeads: new Set(), bouncedLeads: new Set(),
    queued: 0, inSequence: 0,
  }]));
  const seenMessages = new Set();
  const retractedBounces = retractedBounceEventIds(activities);
  for (const row of activities) {
    const leadId = activityLeadKey(row);
    if (!activeIds.has(leadId)) continue;
    const meta = parseMetadata(row.metadata);
    const senderId = String(meta.senderInboxId || row.senderInboxId || row.sender_inbox_id || '').trim();
    const entry = rows.get(senderId);
    if (!entry) continue;
    const type = String(row.eventType || row.event_type || '');
    if (COLD_SEND_TYPES.has(type)) {
      const messageId = String(meta.gmailMessageId || meta.providerMessageId || '').trim();
      if (!messageId || seenMessages.has(messageId)) continue;
      seenMessages.add(messageId);
      if (type === 'initial_email_sent') entry.firstSends++; else entry.followUps++;
      if (vancouverDay(row.occurredAt) === today) entry.sentToday++;
    } else if (INBOUND_PATTERN.test(type)) {
      entry.repliedLeads.add(leadId);
      const category = replyCategoryByLead.get(leadId);
      if (['positive', 'negative', 'needs_human', 'unclassified'].includes(category)) entry.genuineReplyLeads.add(leadId);
      if (category === 'positive') entry.positiveLeads.add(leadId);
    } else if (type === 'email_bounced') {
      if (retractedBounces.has(String(row.eventId || ''))) continue;
      entry.bouncedLeads.add(leadId);
    }
  }
  for (const lead of active) {
    const entry = rows.get(String(lead.senderInboxId || '').trim());
    if (!entry) continue;
    if (lead.stage === 'Queued' && !String(lead.emailStatus || '').trim()) entry.queued++;
    if (String(lead.emailStatus || '').toLowerCase() === 'emailed') entry.inSequence++;
  }
  const result = [...rows.values()].map(entry => {
    const sends = entry.firstSends + entry.followUps;
    return {
      id: entry.id, email: entry.email, status: entry.status, dailyLimit: entry.dailyLimit, staffingOnly: entry.staffingOnly,
      sentToday: entry.sentToday, remainingToday: Math.max(0, entry.dailyLimit - entry.sentToday),
      firstSends: entry.firstSends, followUps: entry.followUps, sends,
      repliedLeads: entry.repliedLeads.size, genuineReplyLeads: entry.genuineReplyLeads.size,
      positiveLeads: entry.positiveLeads.size, bouncedLeads: entry.bouncedLeads.size,
      queued: entry.queued, inSequence: entry.inSequence,
      genuineReplyRate: safePercent(entry.genuineReplyLeads.size, entry.firstSends - entry.bouncedLeads.size),
      bounceRate: safePercent(entry.bouncedLeads.size, entry.firstSends),
    };
  });
  const totals = result.reduce((sum, row) => {
    for (const key of ['dailyLimit', 'sentToday', 'firstSends', 'followUps', 'sends', 'repliedLeads', 'genuineReplyLeads',
      'positiveLeads', 'bouncedLeads', 'queued', 'inSequence']) sum[key] = (sum[key] || 0) + row[key];
    return sum;
  }, {});
  return { scope: ANALYTICS_SCOPE.ACTIVE, day: today, senders: result, totals };
}

module.exports = {
  ANALYTICS_SCOPE, REPORTING_TIMEZONE, parseAnalyticsScope, isActiveOutreachLead, scopeLeads,
  activityLeadKey, activitiesForLeads, liveCampaignVersions, currentLiveCampaignVersion,
  safePercent, vancouverDay, buildSenderAnalytics,
};
