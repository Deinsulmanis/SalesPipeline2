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
const { buildReplyMetrics } = require('./reply-analytics');
const { STAFFING_CAMPAIGN } = require('./staffing-campaign');
const { ACTIVE_CAMPAIGN_VERSION } = require('./campaign-versions');
const {
  REPORTING_TIMEZONE,
  CONFIRMED_SEND_TYPES,
  classifySendEvent,
  vancouverDay,
  eventKey,
  providerMessageId,
  providerName,
  sourceLeadId,
  groupCount,
  classifyReplyEvent,
  canonicalSendRows,
  dashboardSendRows,
  buildConfirmedSendActivity,
  canonicalReplyMessages,
  canonicalMeetingLeads,
  uniqueCanonicalBounces,
  canonicalDelivered,
  bouncedLeadIds,
  classifyCrmSendAgainstProvider,
  buildCanonicalDigest,
  compareSourceLag,
  recentReportingDays,
  countsForDay,
  parseMetadata,
  attributionFromActivity,
  LEGACY_UNKNOWN,
} = require('./canonical-sends');

const FUNNEL_METRIC_DEFINITIONS = Object.freeze({
  sent: {
    numerator: 'unique leads with a qualifying send in the selected campaign cohort',
    denominator: null,
    include: 'initial_email_sent, follow_up_sent, booking_link_sent, sequence_step_sent attributed to the selected campaign version; lifetime also includes historical send-state leads with no activity',
    exclude: 'ordinary_send_reserved, sequence_send_reserved, ordinary_send_failed, sequence_send_failed, other campaign versions',
  },
  replied: {
    numerator: 'unique sent-cohort leads with a genuine inbound reply event (positive, negative, needs_human, unclassified)',
    denominator: 'sent',
    include: 'canonical inbound reply activity on a lead already in the sent cohort, including Gmail observer replies without replyTouch',
    exclude: 'automated_reply, out_of_office, contact_change_review, unknown/evidence-free, explicit other-version replyTouch',
  },
  positive: {
    numerator: 'unique sent-cohort leads whose canonical reply category is positive or meeting_requested',
    denominator: 'sent (sentToPositive) or replied (replyToPositive)',
    include: 'positive_reply, meeting_requested, INTERESTED/MEETING_REQUEST classification',
    exclude: 'needs_human, negative, unsubscribe, automated, unknown',
  },
  qualified: {
    numerator: 'unique sent-cohort leads promoted to Hot (pipeline_promoted toStage=hot, or acquisition-matched hot+)',
    denominator: 'positive (positiveToHot)',
    include: 'pipeline_promoted to hot with matching acquisitionCampaignVersion; lifetime may use board stage hot/call_booked/closed_won',
    exclude: 'lost-from-any-stage without a Hot event; other-campaign acquisition',
  },
  meeting: {
    numerator: 'unique sent-cohort leads with a call_booked event (or lifetime board meetingAt on a booked+ stage)',
    denominator: 'hot (hotToCallBooked)',
    include: 'call_booked once per lead',
    exclude: 'meeting_rescheduled, meeting_cancelled, duplicate calendar sync of the same lead, staffing vs dental mismatch',
  },
  show: {
    numerator: 'unique sent-cohort leads with meeting_completed',
    denominator: 'callBooked (callBookedToHeld) or callHeld+noShow (showRate)',
    include: 'meeting_completed',
    exclude: 'meeting_no_show is the complementary show-rate term, not a show; cancellation is not a show',
  },
  won: {
    numerator: 'unique sent-cohort leads whose board stage is closed_won with matching acquisition',
    denominator: 'callHeld (callHeldToWon) or sent (sentToWon)',
    include: 'board closed_won on a lead that entered the sent cohort',
    exclude: 'closed_won board rows that never mapped to a qualifying outreach send (outsideFunnel)',
  },
});

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
    if (!CONFIRMED_SEND_TYPES.includes(type) && !['positive_reply', 'meeting_requested', 'late_reply', 'question_reply', 'negative_reply', 'unsubscribe_reply', 'wrong_person_reply', 'needs_human_reply', 'out_of_office_reply', 'sender_evidence_reconciled'].includes(type)) continue;
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

function chartReconcile(sendActivity, confirmed) {
  if (!Array.isArray(sendActivity) || !sendActivity.length) {
    return { chart14DayTotal: 0, chartDelta: 0, chartCompared: false };
  }
  const dates = new Set(sendActivity.map(row => row.date).filter(Boolean));
  const canonicalInWindow = confirmed.filter(row => dates.has(vancouverDay(row.occurredAt))).length;
  const chart14DayTotal = sendActivity.reduce((sum, row) => sum + (Number(row.count) || 0), 0);
  return { chart14DayTotal, chartDelta: chart14DayTotal - canonicalInWindow, chartCompared: true };
}

function integrityStatus({ sends, replies, meetings, duplicates, attribution, sourceLag }) {
  const abs = value => Math.abs(Number(value) || 0);
  if (!attribution.isolated) return 'critical';
  if (abs(sends.delta) > 0 || (sends.chartCompared && abs(sends.chartDelta) > 0) || abs(meetings.delta) > 0) return 'critical';
  if ((duplicates.sendProviderIds || 0) > 0) return 'critical';
  if (abs(replies.delta) > 0) return 'warning';
  if ((sends.unconfirmed || 0) > 0) return 'warning';
  if (sourceLag && sourceLag.status && !['same', 'unavailable'].includes(sourceLag.status)) return 'warning';
  return 'healthy';
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
  const chart = chartReconcile(sendActivity, sends.confirmed);

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
  const bounces = uniqueCanonicalBounces({ leads, activities, suppressedEmails: input.suppressedEmails || [] });

  const canonicalSends = sends.confirmed.length;
  const canonicalReplyLeadCount = replyLeads.size;
  const canonicalMeetings = meetings.booked.size;

  const now = input.now || Date.now();
  const reportingDays = recentReportingDays(now);
  const days = reportingDays.map(item => ({
    ...item,
    ...countsForDay(activities, item.day),
    dashboardSends: (sendActivity.find(row => row.date === item.day)?.count) ?? countsForDay(activities, item.day).canonicalSends,
  }));
  for (const day of days) day.sendDelta = day.dashboardSends - day.canonicalSends;

  let sourceLag = { status: 'unavailable', note: 'crm_events sample not supplied' };
  if (Array.isArray(input.crmEvents)) {
    const sinceDay = reportingDays.map(item => item.day).sort()[0] || '';
    sourceLag = compareSourceLag(activities, input.crmEvents, { sinceDay });
  }

  const digestPreview = buildCanonicalDigest({
    day: vancouverDay(now),
    activities,
    leads,
  });

  const report = {
    timezone: REPORTING_TIMEZONE,
    generatedAt: new Date(now).toISOString(),
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
      chart14DayTotal: chart.chart14DayTotal,
      chartDelta: chart.chartDelta,
      chartCompared: chart.chartCompared,
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
    sourceLag,
    bounce: {
      unique: bounces.length,
      delivered: canonicalDelivered({ leads, activities, suppressedEmails: input.suppressedEmails || [] }),
      confirmedSends: canonicalSends,
    },
    attribution: {
      staffingInDental,
      dentalInStaffing,
      isolated: staffingInDental === 0 && dentalInStaffing === 0,
    },
    funnel: {
      conversionsExceeding100: exceeding,
      repliesPartition: funnelLifetime ? funnelLifetime.reconciliation?.repliesPartition : null,
      definitions: FUNNEL_METRIC_DEFINITIONS,
    },
    days,
    digest: {
      note: 'Daily digest emailsSent and replies.total are canonical confirmed send events and inbound reply events on the Vancouver day. Integrity does not regenerate DailyDigest (that write is out of scope).',
      preview: digestPreview,
    },
  };
  report.status = integrityStatus(report);
  report.duplicates = report.duplicates;
  report.unattributed = report.unattributed;
  return report;
}

function delta(canonical, dashboard) {
  return Number(dashboard || 0) - Number(canonical || 0);
}

module.exports = {
  REPORTING_TIMEZONE,
  CONFIRMED_SEND_TYPES,
  FUNNEL_METRIC_DEFINITIONS,
  classifySendEvent,
  vancouverDay,
  eventKey,
  providerMessageId,
  canonicalSendRows,
  dashboardSendRows,
  buildConfirmedSendActivity,
  canonicalReplyMessages,
  canonicalMeetingLeads,
  uniqueCanonicalBounces,
  canonicalDelivered,
  bouncedLeadIds,
  classifyCrmSendAgainstProvider,
  buildCanonicalDigest,
  compareSourceLag,
  recentReportingDays,
  integrityStatus,
  buildAnalyticsIntegrity,
  attributionBreakdown,
  conversionsExceeding100,
  delta,
};
