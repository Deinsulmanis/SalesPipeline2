'use strict';

/**
 * Server-side view models for a managed client's dashboard workspaces (Inbox,
 * Settings). Each takes data ALREADY scoped to one client, or scopes it here
 * before shaping anything, so nothing of another client reaches the browser.
 */

const { getClient, publicClient } = require('./registry');
const { resolveSenderClient } = require('./ownership');
const { clientSendState } = require('./send-policy');
const { REPLY_EVENT_TYPE } = require('./reply-pipeline');
const { createClientCapacityState, clientCapacityVerdict, clientSendCountsToday } = require('./capacity');
const { activityLeadId } = require('./reporting');

const text = value => String(value == null ? '' : value).trim();
function meta(row) {
  try { return typeof row.metadata === 'object' && row.metadata ? row.metadata : JSON.parse(row.metadata || '{}'); } catch (_) { return {}; }
}

/** Only this client's inboxes. An inbox with no declared client is ScaleLab's. */
function filterInboxesForClient(inboxes = [], clientId) {
  const client = getClient(clientId);
  return (inboxes || []).filter(inbox => {
    const owner = resolveSenderClient(inbox);
    return owner.ok && owner.clientId === client.id;
  });
}

/**
 * The client's conversations: every classified reply on the client's leads,
 * newest first, with the lead, the reply state and any open clarification.
 * @param leads   the client's leads only
 */
function buildClientInbox({ clientId, leads = [], activities = [], ledger = { available: false } }) {
  const client = getClient(clientId);
  const byId = new Map(leads.map(lead => [text(lead.id), lead]));
  const opportunityByLead = new Map((ledger.opportunities || []).filter(row => row.client_id === client.id).map(row => [row.lead_id, row]));
  const clarificationsByLead = new Map();
  for (const row of (ledger.clarifications || []).filter(item => item.client_id === client.id && item.status === 'open')) {
    if (!clarificationsByLead.has(row.lead_id)) clarificationsByLead.set(row.lead_id, []);
    clarificationsByLead.get(row.lead_id).push({ id: row.clarification_id, question: row.question, topics: row.topics || [] });
  }
  const conversations = [];
  for (const row of activities) {
    if (text(row.eventType) !== REPLY_EVENT_TYPE) continue;
    const leadId = activityLeadId(row);
    const lead = byId.get(leadId);
    if (!lead) continue;                       // not this client's lead
    const data = meta(row);
    if (data.clientId && data.clientId !== client.id) continue;
    conversations.push({
      leadId, company: text(lead.company), contactName: text(lead.contactName), email: text(lead.email),
      campaign: text(data.campaignId) || text(lead.intendedCampaignVersion), receivedAt: row.occurredAt || '',
      workflowState: text(data.workflowState), sentiment: text(data.sentiment),
      conversationStatus: opportunityByLead.get(leadId)?.conversation_status || text(data.conversationStatus),
      excerpt: text(row.content).slice(0, 280), subject: text(row.subject),
      openClarifications: clarificationsByLead.get(leadId) || [],
    });
  }
  conversations.sort((a, b) => Date.parse(b.receivedAt || 0) - Date.parse(a.receivedAt || 0));
  const awaiting = [...clarificationsByLead.values()].reduce((sum, list) => sum + list.length, 0);
  return {
    clientId: client.id, total: conversations.length, awaitingClarification: awaiting,
    ledgerAvailable: Boolean(ledger.available), conversations: conversations.slice(0, 200),
  };
}

/**
 * Client status, client send capacity and the client's own sending inboxes.
 * @param inboxes      the server's inbox status rows (all clients); scoped here
 * @param global       { dailyLimit, windowLimit } — the service ceilings
 */
function buildClientSettings({ clientId, leads = [], activities = [], inboxes = [], global = {}, env = process.env, now = new Date() }) {
  const client = getClient(clientId);
  const dayKey = now.toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });
  const leadsById = new Map(leads.map(lead => [lead.id, lead]));
  const sentTodayByClient = clientSendCountsToday(activities, { dayKey, leadsById });
  const capacityState = createClientCapacityState({
    globalDailyLimit: Number(global.dailyLimit) || 0, globalWindowLimit: Number(global.windowLimit) || 0,
    sentTodayByClient, env,
  });
  const verdict = clientCapacityVerdict(capacityState, client.id);
  const clientInboxes = filterInboxesForClient(inboxes, client.id).map(inbox => ({
    id: inbox.id, email: inbox.email, domain: text(inbox.email).split('@')[1] || '',
    clientId: client.id, status: inbox.status, sendEligible: Boolean(inbox.sendEligible),
    dailyLimit: inbox.dailyLimit, perRunLimit: inbox.perRunLimit, sentToday: inbox.sentToday ?? 0,
    remainingToday: inbox.remainingToday ?? null, credentialConfigured: Boolean(inbox.credentialConfigured),
    identityVerified: Boolean(inbox.identityVerified), observerHealth: inbox.observerHealth || 'unavailable',
    lastObserverSuccessAt: inbox.observer?.lastSuccessfulAt || null, observerError: inbox.observer?.lastError || null,
    activationBlockers: inbox.controls?.activationBlockers || [],
    allowedCampaignIds: inbox.allowedCampaignIds || (client.senderPolicy ? [...client.senderPolicy.allowedCampaignIds] : null),
    hardDailyCap: client.senderPolicy?.maxDailyPerInbox ?? null,
    configuredDailyLimit: inbox.configuredDailyLimit ?? null,
    policyBlockers: inbox.policyBlockers || [],
  }));
  const view = publicClient(client);
  return {
    clientId: client.id,
    status: {
      lifecycleStatus: view.lifecycleStatus, active: view.active, onboarding: view.onboarding,
      activation: view.activation, platformAccess: view.platformAccess,
    },
    sending: clientSendState(client.id, env),
    capacity: {
      dailyCap: client.capacity.dailyCap, windowCap: client.capacity.windowCap,
      reservedDaily: client.capacity.reservedDaily, reservedWindow: client.capacity.reservedWindow,
      sentToday: sentTodayByClient.get(client.id) || 0,
      remainingToday: verdict.allowed ? (verdict.remaining === Infinity ? null : verdict.remaining) : 0,
      blockedBy: verdict.allowed ? null : verdict.code,
      globalDailyLimit: capacityState.globalDailyLimit, globalWindowLimit: capacityState.globalWindowLimit,
    },
    senderPolicy: view.senderPolicy,
    // This server does not verify DNS; SPF/DKIM/DMARC are shown as unknown, never invented.
    domainAuthentication: { checked: false },
    inboxes: clientInboxes,
  };
}

module.exports = { filterInboxesForClient, buildClientInbox, buildClientSettings };
