'use strict';

/**
 * Read-only analytics integrity.
 *
 * Compares dashboard totals against canonical provider-confirmed evidence.
 * Never writes. Never sends. Never mutates CRM, Sheets, Gmail, or Supabase.
 *
 * Canonical rules (one event type, one source, counted once):
 *   confirmed send  — successful send activity with a provider message id
 *   reserved/failed — ordinary_send_reserved / *_failed never count as sends
 *   unconfirmed     — send-typed rows without provider id; reported, not canonical
 *   inbound reply   — unique Gmail/Smartlead message id; unique lead for rates
 *   meeting booked  — unique lead with call_booked (reschedule is not a new meeting)
 *
 * Reporting timezone: America/Vancouver.
 */

const { inspectActivityIntegrity } = require('./activity-timeline');
const { buildReplyMetrics, buildReplyRecords, GENUINE_REPLY_CATEGORIES } = require('./reply-analytics');
const { attributionFromActivity, parseMetadata, LEGACY_UNKNOWN, ACTIVE_CAMPAIGN_VERSION } = require('./campaign-versions');
const { STAFFING_CAMPAIGN } = require('./staffing-campaign');

const REPORTING_TIMEZONE = 'America/Vancouver';

const CONFIRMED_SEND_TYPES = Object.freeze([
  'initial_email_sent', 'follow_up_sent', 'booking_link_sent', 'sequence_step_sent',
]);
const SEND_TYPE_SET = new Set(CONFIRMED_SEND_TYPES);
const RESERVED_TYPES = new Set(['ordinary_send_reserved', 'sequence_send_reserved']);
const FAILED_TYPES = new Set(['ordinary_send_failed', 'sequence_send_failed']);
const REPLY_MESSAGE_TYPES = new Set([
  'positive_reply', 'meeting_requested', 'late_reply', 'question_reply',
  'negative_reply', 'unsubscribe_reply', 'wrong_person_reply',
  'needs_human_reply', 'out_of_office_reply',
]);

function vancouverDay(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleDateString('en-CA', { timeZone: REPORTING_TIMEZONE });
}

function eventKey(row) {
  return String(row.eventId || `${row.leadId || row.sourceLeadId}:${row.eventType}:${row.occurredAt}`);
}

function providerMessageId(row) {
  const meta = parseMetadata(row.metadata);
  return String(meta.gmailMessageId || meta.providerMessageId || '').trim();
}

function providerName(row) {
  const meta = parseMetadata(row.metadata);
  const named = String(meta.provider || '').trim().toLowerCase();
  if (named) return named;
  const id = String(row.eventId || '');
  if (id.startsWith('gmail:') || id.startsWith('gmail-')) return 'gmail';
  if (id.startsWith('smartlead:') || named === 'smartlead') return 'smartlead';
  return named || 'unknown';
}

function sourceLeadId(row) {
  return String(row.sourceLeadId || '').trim() || String(row.leadId || '').replace(/^CE-/, '').trim();
}

/**
 * Classify one activity row for send counting.
 * reserved / failed / ignored never enter canonical or dashboard send totals.
 * confirmed = send type + provider message id.
 * unconfirmed = send type without provider message id (sent_unconfirmed).
 */
function classifySendEvent(row = {}) {
  const type = String(row.eventType || '');
  if (RESERVED_TYPES.has(type)) return 'reserved';
  if (FAILED_TYPES.has(type)) return 'failed';
  if (!SEND_TYPE_SET.has(type)) return 'ignored';
  return providerMessageId(row) ? 'confirmed' : 'unconfirmed';
}

function uniqueBy(rows, keyFn) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = keyFn(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function groupCount(rows, keyFn) {
  const groups = {};
  for (const row of rows) {
    const key = keyFn(row) || '(blank)';
    groups[key] = (groups[key] || 0) + 1;
  }
  return groups;
}

function classifyReplyEvent(row = {}) {
  const type = String(row.eventType || '');
  if (type === 'unsubscribe_reply') return 'unsubscribe';
  if (type === 'negative_reply') return 'negative';
  if (type === 'positive_reply' || type === 'meeting_requested') return 'positive';
  if (type === 'out_of_office_reply') return 'out_of_office';
  if (type === 'wrong_person_reply') return 'wrong_person';
  if (type === 'needs_human_reply' || type === 'question_reply' || type === 'late_reply') return 'needs_human';
  return 'other';
}

function canonicalSendRows(activities = []) {
  const confirmed = [];
  const unconfirmed = [];
  const reserved = [];
  const failed = [];
  const seenEvents = new Set();
  for (const row of activities) {
    const key = eventKey(row);
    if (seenEvents.has(key)) continue;
    seenEvents.add(key);
    const kind = classifySendEvent(row);
    if (kind === 'confirmed') confirmed.push(row);
    else if (kind === 'unconfirmed') unconfirmed.push(row);
    else if (kind === 'reserved') reserved.push(row);
    else if (kind === 'failed') failed.push(row);
  }
  const confirmedOnce = uniqueBy(confirmed, row => providerMessageId(row) || eventKey(row));
  return { confirmed: confirmedOnce, unconfirmed, reserved, failed };
}

function dashboardSendRows(activities = []) {
  const rows = [];
  const seen = new Set();
  for (const row of activities) {
    if (!SEND_TYPE_SET.has(String(row.eventType || ''))) continue;
    const key = eventKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    const sentAt = new Date(row.occurredAt);
    if (!Number.isFinite(sentAt.getTime())) continue;
    rows.push(row);
  }
  return rows;
}

function canonicalReplyMessages(activities = []) {
  const rows = [];
  const seenEvents = new Set();
  for (const row of activities) {
    if (!REPLY_MESSAGE_TYPES.has(String(row.eventType || ''))) continue;
    const key = eventKey(row);
    if (seenEvents.has(key)) continue;
    seenEvents.add(key);
    rows.push(row);
  }
  return uniqueBy(rows, row => providerMessageId(row) || eventKey(row));
}

function canonicalMeetingLeads(activities = []) {
  const booked = new Set();
  const rescheduled = new Set();
  const cancelled = new Set();
  const noShow = new Set();
  const completed = new Set();
  for (const row of activities) {
    const id = sourceLeadId(row);
    if (!id) continue;
    const type = String(row.eventType || '');
    if (type === 'call_booked') booked.add(id);
    else if (type === 'meeting_rescheduled') rescheduled.add(id);
    else if (type === 'meeting_cancelled') cancelled.add(id);
    else if (type === 'meeting_no_show') noShow.add(id);
    else if (type === 'meeting_completed') completed.add(id);
  }
  return { booked, rescheduled, cancelled, noShow, completed };
}

function attributionBreakdown(rows) {
  return {
    byDate: groupCount(rows, row => vancouverDay(row.occurredAt)),
    byInbox: groupCount(rows, row => String(parseMetadata(row.metadata).senderInboxId || '').trim() || '(unknown)'),
    byCampaign: groupCount(rows, row => {
      const attribution = attributionFromActivity(row);
      return attribution.campaignVersion || LEGACY_UNKNOWN;
    }),
    bySequenceStep: groupCount(rows, row => {
      const attribution = attributionFromActivity(row);
      const meta = parseMetadata(row.metadata);
      const sequence = attribution.sequenceId || meta.sequenceId || String(row.eventType || '');
      const step = attribution.sequenceStep ?? meta.step ?? '';
      return `${sequence}:${step}`;
    }),
    byProvider: groupCount(rows, providerName),
  };
}

function conversionsExceeding100(conversions = {}) {
  return Object.entries(conversions)
    .filter(([, value]) => typeof value === 'number' && Number.isFinite(value) && value > 100)
    .map(([key, value]) => ({ key, value }));
}

function latestEvidenceTime(activities = []) {
  let latest = '';
  for (const row of activities) {
    const type = String(row.eventType || '');
    if (!SEND_TYPE_SET.has(type) && !REPLY_MESSAGE_TYPES.has(type) && type !== 'sender_evidence_reconciled') continue;
    const at = String(row.occurredAt || '');
    if (at > latest) latest = at;
  }
  return latest || null;
}

function duplicateEmailLeads(leads = []) {
  const byEmail = new Map();
  for (const lead of leads) {
    const email = String(lead.email || '').trim().toLowerCase();
    if (!email) continue;
    const ids = byEmail.get(email) || [];
    ids.push(String(lead.id || ''));
    byEmail.set(email, ids);
  }
  return [...byEmail.entries()].filter(([, ids]) => new Set(ids.filter(Boolean)).size > 1)
    .map(([email, ids]) => ({ email, leadIds: [...new Set(ids)] }));
}

function bounceMismatch({ leads = [], activities = [] }) {
  const bouncedEvents = new Set();
  for (const row of activities) {
    if (String(row.eventType || '') !== 'email_bounced') continue;
    const id = sourceLeadId(row);
    if (id) bouncedEvents.add(id);
  }
  const eventWithoutTag = [];
  const tagWithoutEvent = [];
  for (const lead of leads) {
    const id = String(lead.id || '');
    const tagged = /\[BOUNCED/i.test(String(lead.notes || ''));
    const evented = bouncedEvents.has(id);
    if (evented && !tagged) eventWithoutTag.push(id);
    if (tagged && !evented) tagWithoutEvent.push(id);
  }
  return { eventWithoutTagCount: eventWithoutTag.length, tagWithoutEventCount: tagWithoutEvent.length };
}

/**
 * Build the integrity report. Pure: input snapshot in, JSON out.
 */
function buildAnalyticsIntegrity(input = {}) {
  const leads = input.leads || [];
  const activities = input.activities || [];
  const metrics = input.metrics || buildReplyMetrics(leads, {
    activitiesByLeadId: input.activitiesByLeadId,
    classificationsByLeadId: input.classificationsByLeadId,
    evidenceByLeadId: input.evidenceByLeadId,
  });
  const sendActivity = input.sendActivity || [];
  const funnelLifetime = input.funnelLifetime || null;
  const dentalFunnel = input.dentalFunnel || null;
  const staffingFunnel = input.staffingFunnel || null;

  const sends = canonicalSendRows(activities);
  const dashboardSendEvents = dashboardSendRows(activities);
  const dashboardSendTotal = dashboardSendEvents.length;

  const providerClaimants = new Map();
  for (const row of dashboardSendEvents.concat(canonicalReplyMessages(activities))) {
    const pid = providerMessageId(row);
    if (!pid) continue;
    const set = providerClaimants.get(pid) || new Set();
    set.add(providerName(row));
    providerClaimants.set(pid, set);
  }
  const doubleAttributed = [...providerClaimants.entries()]
    .filter(([, set]) => set.size > 1)
    .map(([pid]) => pid);

  const replyMessages = canonicalReplyMessages(activities);
  const replyLeads = new Set(replyMessages.map(sourceLeadId).filter(Boolean));
  const dashboardReplyLeads = Number(metrics.inboundMessages || metrics.totalReplies || 0);

  const meetings = canonicalMeetingLeads(activities);
  const dashboardMeetings = funnelLifetime ? Number(funnelLifetime.counts.callBooked || 0) : meetings.booked.size;

  const integrity = inspectActivityIntegrity(activities, new Set(leads.map(lead => String(lead.id || '')).filter(Boolean)));
  const twins = duplicateEmailLeads(leads);

  const unattributedSends = sends.confirmed.filter(row => {
    const attribution = attributionFromActivity(row);
    return !attribution.campaignVersion || attribution.campaignVersion === LEGACY_UNKNOWN;
  });
  const unattributedReplies = replyMessages.filter(row => !sourceLeadId(row));

  const staffingSent = new Set(staffingFunnel ? (staffingFunnel.stageLeadIds?.sent || []) : []);
  const dentalSent = new Set(dentalFunnel ? (dentalFunnel.stageLeadIds?.sent || []) : []);
  // Funnel responses strip stageLeadIds. Fall back to attribution on confirmed sends.
  let staffingInDental = 0;
  let dentalInStaffing = 0;
  if (staffingSent.size || dentalSent.size) {
    staffingInDental = [...staffingSent].filter(id => dentalSent.has(id)).length;
    dentalInStaffing = [...dentalSent].filter(id => staffingSent.has(id)).length;
  } else {
    for (const row of sends.confirmed) {
      const attribution = attributionFromActivity(row);
      const family = String(attribution.campaignFamily || '');
      const version = String(attribution.campaignVersion || '');
      const dentalVersion = ACTIVE_CAMPAIGN_VERSION.dental_ai_receptionist;
      const staffingVersion = STAFFING_CAMPAIGN.id;
      if (family === 'industrial_staffing' && version === dentalVersion) staffingInDental++;
      if (family === 'dental_ai_receptionist' && version === staffingVersion) dentalInStaffing++;
    }
  }

  const bounce = bounceMismatch({ leads, activities });
  const exceeding = conversionsExceeding100(funnelLifetime?.conversions || {});

  const canonicalSends = sends.confirmed.length;
  const canonicalReplyLeadCount = replyLeads.size;
  const canonicalMeetings = meetings.booked.size;

  return {
    timezone: REPORTING_TIMEZONE,
    generatedAt: new Date(input.now || Date.now()).toISOString(),
    latestReconciliationTime: latestEvidenceTime(activities),
    leadSource: input.leadSource || 'unknown',
    activitySource: 'google_sheets_cold_call_activity',
    outreachMode: input.outreachMode || null,
    writeAuthority: input.writeAuthority || null,
    sends: {
      canonical: canonicalSends,
      dashboard: dashboardSendTotal,
      delta: dashboardSendTotal - canonicalSends,
      unconfirmed: sends.unconfirmed.length,
      reserved: sends.reserved.length,
      failed: sends.failed.length,
      chart14DayTotal: sendActivity.reduce((sum, row) => sum + (Number(row.count) || 0), 0),
      ...attributionBreakdown(sends.confirmed),
    },
    replies: {
      canonical: canonicalReplyLeadCount,
      canonicalMessages: replyMessages.length,
      dashboard: dashboardReplyLeads,
      delta: dashboardReplyLeads - canonicalReplyLeadCount,
      genuineDashboard: Number(metrics.genuineReplies || 0),
      byClassification: groupCount(replyMessages, classifyReplyEvent),
    },
    meetings: {
      canonical: canonicalMeetings,
      dashboard: dashboardMeetings,
      delta: dashboardMeetings - canonicalMeetings,
      rescheduled: meetings.rescheduled.size,
      cancelled: meetings.cancelled.size,
      noShow: meetings.noShow.size,
      completed: meetings.completed.size,
    },
    duplicateEventCount: integrity.duplicateActivityIds.length
      + integrity.duplicateSendIds.length + integrity.duplicateReplyIds.length,
    unattributedEventCount: unattributedSends.length + unattributedReplies.length,
    sourceMismatchCount: doubleAttributed.length + bounce.eventWithoutTagCount,
    duplicates: {
      activityIds: integrity.duplicateActivityIds.length,
      sendProviderIds: integrity.duplicateSendIds.length,
      replyProviderIds: integrity.duplicateReplyIds.length,
      twinEmails: twins.length,
      gmailSmartleadSharedIds: doubleAttributed.length,
    },
    unattributed: {
      sendsWithoutCampaignVersion: unattributedSends.length,
      repliesWithoutLead: unattributedReplies.length,
    },
    sourceMismatch: {
      mixedLeadAndActivityStores: input.leadSource === 'supabase' || input.leadSource === 'sheets-fallback',
      bounceEventWithoutTag: bounce.eventWithoutTagCount,
      bounceTagWithoutEvent: bounce.tagWithoutEventCount,
      gmailSmartleadDoubleAttribute: doubleAttributed.length,
      note: 'Funnel and stats read ColdCallActivity from Google Sheets even when outreach leads come from Supabase. Events are not unioned, so the same send is not double-counted across stores.',
    },
    attribution: {
      staffingInDental,
      dentalInStaffing,
      isolated: staffingInDental === 0 && dentalInStaffing === 0,
    },
    funnel: {
      conversionsExceeding100: exceeding,
      repliesPartition: funnelLifetime ? funnelLifetime.reconciliation?.repliesPartition : null,
    },
    digest: {
      note: 'Daily digest emailsSent is lead-based lastEmailedAt; the send chart is message-based confirmed+unconfirmed send activity. Integrity does not regenerate the digest (that write is out of scope).',
    },
  };
}

function delta(canonical, dashboard) {
  return Number(dashboard || 0) - Number(canonical || 0);
}

module.exports = {
  REPORTING_TIMEZONE,
  CONFIRMED_SEND_TYPES,
  classifySendEvent,
  vancouverDay,
  canonicalSendRows,
  dashboardSendRows,
  canonicalReplyMessages,
  canonicalMeetingLeads,
  buildAnalyticsIntegrity,
  conversionsExceeding100,
  delta,
};
