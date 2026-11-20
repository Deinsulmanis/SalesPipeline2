'use strict';

// Inbound ownership is a property of the conversation, never today's outbound
// assignment. Outbound consistency checks remain unchanged.
const { resolveLeadClient, resolveSenderClient } = require('./clients/ownership');
const { leadsInEmailScope } = require('./clients/email-scope');
const { delegatedMailbox } = require('./clients/sender-delegation');
const { activityBelongsToLead } = require('./lead-activity');
const SEND_EVENTS = new Set(['initial_email_sent', 'follow_up_sent', 'sequence_step_sent',
  'booking_link_sent', 'human_response_sent', 'sender_evidence_reconciled']);
const metadata = row => {
  try { return row?.metadata && typeof row.metadata === 'object' ? row.metadata : JSON.parse(row?.metadata || '{}'); }
  catch (_) { return {}; }
};

function hasMailboxEvidence(lead, senderInboxId, activities = []) {
  const owner = resolveLeadClient(lead);
  if (!owner.ok) return false;
  return activities.some(row => {
    const data = metadata(row);
    if (!activityBelongsToLead(row, lead) || String(data.senderInboxId || '') !== senderInboxId) return false;
    if (data.clientId && data.clientId !== owner.clientId) return false;
    return SEND_EVENTS.has(row.eventType)
      && Boolean(data.gmailMessageId || data.providerMessageId || row.providerMessageId || data.gmailThreadId);
  });
}

function mailboxLeadScope(leads = [], sender = {}, activities = []) {
  const owner = resolveSenderClient(sender);
  if (!owner.ok) return [];
  if (!delegatedMailbox(sender)) return leadsInEmailScope(leads, owner.clientId);
  const byId = new Map(leads.map(lead => [String(lead.id), lead]));
  const proven = new Set();
  for (const row of activities) {
    if (!SEND_EVENTS.has(row.eventType)) continue;
    const data = metadata(row);
    if (String(data.senderInboxId || '') !== sender.id
      || !(data.gmailMessageId || data.providerMessageId || row.providerMessageId || data.gmailThreadId)) continue;
    const id = String(row.sourceLeadId || row.leadId || '').replace(/^CE-/, '');
    const lead = byId.get(id);
    const historicalOwner = lead && resolveLeadClient(lead);
    if (historicalOwner?.ok && (!data.clientId || data.clientId === historicalOwner.clientId)) proven.add(id);
  }
  return leads.filter(lead => {
    const historyOwner = resolveLeadClient(lead);
    return historyOwner.ok
      && ['scalelab', 'jole'].includes(historyOwner.clientId)
      && proven.has(String(lead.id));
  });
}

function activityClient(row, { leads = [], senders = [] } = {}) {
  const data = metadata(row);
  const id = String(row.sourceLeadId || row.leadId || '').replace(/^CE-/, '');
  const lead = leads instanceof Map ? leads.get(id) : leads.find(item => String(item.id) === id);
  const owner = lead && resolveLeadClient(lead);
  if (owner && !owner.ok) return '';
  if (data.clientId && owner && data.clientId !== owner.clientId) return '';
  if (owner?.ok) return owner.clientId;
  if (data.clientId) return ['scalelab', 'jole'].includes(data.clientId) ? data.clientId : '';
  const sender = senders.find(item => item.id === String(data.senderInboxId || ''));
  // Only permanently dedicated mailboxes retain the legacy fallback. A moved
  // mailbox with missing ownership is unowned, never its current tenant.
  if (!sender || delegatedMailbox(sender)) return '';
  const resolved = resolveSenderClient(sender);
  return resolved.ok ? resolved.clientId : '';
}

function clientActivityScope(activities, clientId, context) {
  const leads = context.leads instanceof Map ? context.leads : new Map((context.leads || []).map(lead => [String(lead.id), lead]));
  return activities.filter(row => activityClient(row, { ...context, leads }) === clientId);
}

module.exports = { metadata, hasMailboxEvidence, mailboxLeadScope, activityClient, clientActivityScope };
