'use strict';

/**
 * Internal, server-side client reporting.
 *
 * The caller hands in the whole corpus it already read once; this module
 * scopes it to ONE client before counting anything, so a client view is built
 * only from that client's records and nothing of another client leaves the
 * server. Ledger rows come from a store query that is itself filtered by
 * client_id.
 */

const { getClient } = require('./registry');
const { leadsForClient, resolveSenderClient, resolveLeadClient } = require('./ownership');
const { clientSendState } = require('./send-policy');
const { campaignsForClient, campaignSendable, clientCampaign } = require('./campaigns');
const { MEETING_STATUS, billingSummary, withBilling, CLARIFICATION_STATUS } = require('./ledger');
const { REPLY_EVENT_TYPE } = require('./reply-pipeline');
const { sendSuppressionReason } = require('../pipeline-state');

const SEND_EVENTS = new Set(['initial_email_sent', 'follow_up_sent', 'sequence_step_sent']);
const LEGACY_REPLY_SENTIMENT = Object.freeze({
  positive_reply: 'positive', question_reply: 'positive', meeting_requested: 'positive',
  negative_reply: 'negative', unsubscribe_reply: 'unsubscribe', wrong_person_reply: 'neutral',
  needs_human_reply: 'neutral', late_reply: 'neutral',
});

const text = value => String(value == null ? '' : value).trim();
function meta(row) {
  try { return typeof row.metadata === 'object' && row.metadata ? row.metadata : JSON.parse(row.metadata || '{}'); } catch (_) { return {}; }
}

function activityLeadId(row) {
  if (row.sourceLeadId) return text(row.sourceLeadId);
  const id = text(row.leadId);
  return id.startsWith('CE-') ? id.slice(3) : id;
}

function leadMetrics(leads, { routedLeadReady, env }) {
  const sent = lead => Number(lead.emailStep || 0) > 0 || ['emailed', 'done', 'replied'].includes(text(lead.emailStatus).toLowerCase());
  return {
    imported: leads.length,
    approved: leads.filter(lead => text(lead.intendedCampaignVersion) && text(lead.emailTemplateId) && text(lead.senderInboxId)).length,
    routingReady: leads.filter(lead => routedLeadReady(lead, env).ok).length,
    queued: leads.filter(lead => text(lead.stage) === 'Queued' && !text(lead.emailStatus)).length,
    sent: leads.filter(sent).length,
  };
}

/**
 * Build the internal overview for one client.
 *
 * @param clientId   a registered client id (unknown ids throw)
 * @param leads      the full corpus; scoped here, server side
 * @param activities the activity ledger; scoped by lead membership
 * @param senders    configured senders
 * @param ledger     { available, opportunities, meetings, clarifications } for THIS client
 */
function buildClientOverview({
  clientId, leads = [], activities = [], senders = [], suppressedEmails = new Set(),
  ledger = { available: false }, env = process.env, routedLeadReady,
}) {
  const client = getClient(clientId);
  const mine = leadsForClient(leads, client.id);
  const ids = new Set(mine.map(lead => lead.id));
  const conflicted = leads.filter(lead => !resolveLeadClient(lead).ok).length;
  const myActivities = activities.filter(row => ids.has(activityLeadId(row)));

  const sends = myActivities.filter(row => SEND_EVENTS.has(text(row.eventType)));
  const bounces = myActivities.filter(row => text(row.eventType) === 'email_bounced');
  const replies = { total: 0, positive: 0, neutral: 0, negative: 0, unsubscribe: 0, automated: 0 };
  const seenMessages = new Set();
  for (const row of myActivities) {
    const type = text(row.eventType);
    const data = meta(row);
    let sentiment = null;
    if (type === REPLY_EVENT_TYPE) sentiment = data.sentiment || 'neutral';
    else if (LEGACY_REPLY_SENTIMENT[type]) sentiment = LEGACY_REPLY_SENTIMENT[type];
    if (!sentiment) continue;
    const key = data.gmailMessageId || row.eventId;
    if (seenMessages.has(key)) continue;
    seenMessages.add(key);
    if (sentiment === 'automated') { replies.automated += 1; continue; }
    replies.total += 1;
    replies[sentiment] = (replies[sentiment] || 0) + 1;
  }

  const clientSenders = senders.filter(sender => {
    const owner = resolveSenderClient(sender);
    return owner.ok && owner.clientId === client.id;
  }).map(sender => ({
    id: sender.id, email: sender.email, status: sender.status, sendEligible: Boolean(sender.sendEligible),
    dailyLimit: sender.dailyLimit, credentialConfigured: Boolean(sender.credentialConfigured),
  }));

  // Per-campaign performance from the same scoped leads, activities and ledger.
  const repliedLeads = new Set(myActivities.filter(row => text(row.eventType) === REPLY_EVENT_TYPE || LEGACY_REPLY_SENTIMENT[text(row.eventType)])
    .map(activityLeadId));
  const meetingLeads = new Map();
  for (const row of (ledger.available ? ledger.meetings || [] : []).filter(item => item.client_id === client.id)) {
    meetingLeads.set(row.lead_id, (meetingLeads.get(row.lead_id) || 0) + 1);
  }
  const sendState = clientSendState(client.id, env);
  const campaigns = client.isDefault ? [] : campaignsForClient(client.id).map(campaign => {
    const sendable = campaignSendable(campaign);
    // By id or campaign version, case-insensitively (the catalog resolver).
    const inCampaign = mine.filter(lead => clientCampaign(text(lead.intendedCampaignVersion) || text(lead.campaign))?.id === campaign.id);
    const ids = new Set(inCampaign.map(lead => lead.id));
    const blockers = [
      ...(sendable.ok ? [] : [sendable.reason]),
      ...(sendState.sendingEnabled ? [] : [sendState.blockReason]),
      ...(clientSenders.length ? [] : ['no sending inbox is configured for this client']),
    ];
    return {
      id: campaign.id, number: campaign.number, label: campaign.label, status: campaign.status,
      emailTemplateId: campaign.emailTemplateId, leadType: campaign.leadType, icp: campaign.icp,
      leads: inCampaign.length,
      queued: inCampaign.filter(lead => text(lead.stage) === 'Queued' && !text(lead.emailStatus)).length,
      sent: sends.filter(row => ids.has(activityLeadId(row))).length,
      replies: [...repliedLeads].filter(id => ids.has(id)).length,
      meetings: [...meetingLeads].filter(([id]) => ids.has(id)).reduce((sum, [, n]) => sum + n, 0),
      assignedSenders: new Set(inCampaign.map(lead => text(lead.senderInboxId)).filter(Boolean)).size,
      sendable: sendable.ok, ...(sendable.ok ? {} : { blockedBy: sendable.reason }),
      ready: blockers.length === 0, readinessBlockers: blockers,
    };
  });

  let pipeline = null;
  let billing = null;
  if (client.reporting?.ledger) {
    if (ledger.available) {
      const meetings = (ledger.meetings || []).filter(row => row.client_id === client.id).map(row => withBilling(row, client));
      const opportunities = (ledger.opportunities || []).filter(row => row.client_id === client.id);
      const clarifications = (ledger.clarifications || []).filter(row => row.client_id === client.id);
      const status = s => meetings.filter(row => row.meeting_status === s).length;
      const heldStates = [MEETING_STATUS.HELD, MEETING_STATUS.QUALIFIED_HELD, MEETING_STATUS.DISQUALIFIED_HELD];
      pipeline = {
        available: true,
        opportunities: opportunities.length,
        qualifyingConversations: opportunities.filter(row => row.conversation_status === 'qualification_in_progress').length,
        awaitingClarification: clarifications.filter(row => row.status === CLARIFICATION_STATUS.OPEN).length,
        meetingsBooked: meetings.length,
        meetingsHeld: meetings.filter(row => heldStates.includes(row.meeting_status)).length,
        qualifiedHeld: status(MEETING_STATUS.QUALIFIED_HELD),
        disqualifiedHeld: status(MEETING_STATUS.DISQUALIFIED_HELD),
        noShow: status(MEETING_STATUS.NO_SHOW),
        cancelled: status(MEETING_STATUS.CANCELLED),
        upcoming: meetings.filter(row => [MEETING_STATUS.BOOKED, MEETING_STATUS.RESCHEDULED].includes(row.meeting_status)).length,
      };
      billing = { available: true, ...billingSummary(meetings, client) };
    } else {
      pipeline = { available: false, reason: ledger.reason || 'client ledger is not available' };
      billing = { available: false, model: client.billing.model, configuredFeeCents: client.billing.performanceFeeCents || 0, currency: client.billing.currency || null };
    }
  }

  return {
    client: {
      clientId: client.id, displayName: client.displayName, active: client.active, platformAccess: client.platformAccess,
      lifecycleStatus: client.lifecycleStatus, onboarding: client.onboarding ? { ...client.onboarding } : null,
    },
    sending: clientSendState(client.id, env),
    leads: leadMetrics(mine, { routedLeadReady, env }),
    deliverability: {
      sends: sends.length,
      bounced: bounces.length,
      // Gmail gives no delivery receipt; "delivered" is sends minus observed bounces.
      deliveredEstimate: Math.max(0, sends.length - bounces.length),
      suppressed: mine.filter(lead => sendSuppressionReason(lead, { suppressedEmails })).length,
      senders: clientSenders,
    },
    replies,
    pipeline,
    billing,
    campaigns,
    // Leads whose own fields name two clients belong to no client view.
    ownershipConflicts: conflicted,
  };
}

module.exports = { buildClientOverview, activityLeadId };
