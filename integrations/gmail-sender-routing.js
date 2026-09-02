'use strict';

const { parseRegistry } = require('./gmail-inbox-registry');

function parseMetadata(value) {
  try { return value && typeof value === 'object' ? value : JSON.parse(String(value || '{}')); }
  catch (_) { return {}; }
}

function configuredSenders(env = process.env) {
  const primary = {
    id: 'primary', email: String(env.FROM_EMAIL || '').trim().toLowerCase(),
    tokenEnv: 'GMAIL_TOKEN_JSON', oauthClient: 'primary', status: 'active',
    dailyLimit: Number(env.GMAIL_PRIMARY_DAILY_LIMIT || env.DAILY_SEND_LIMIT || 40),
    credentialConfigured: Boolean(env.GMAIL_TOKEN_JSON),
  };
  const secondary = parseRegistry(env.GMAIL_INBOX_REGISTRY_JSON || '[]').map(entry => ({
    ...entry, oauthClient: 'secondary', credentialConfigured: Boolean(env[entry.tokenEnv]),
  }));
  return [primary, ...secondary].map(sender => ({
    ...sender,
    sendEligible: sender.status === 'active' && sender.dailyLimit > 0 && sender.credentialConfigured,
  }));
}

function allowedForLead(sender, lead = {}) {
  const niche = String(lead.leadNiche || lead.tradeType || '').toLowerCase();
  if (niche.includes('dent')) return sender.sendEligible;
  return sender.id === 'primary' && sender.sendEligible;
}

function senderEvidence(lead = {}, activities = []) {
  const ids = new Set();
  if (lead.senderInboxId && (Number(lead.emailStep || 0) > 0 || String(lead.emailStatus || '').trim())) ids.add(String(lead.senderInboxId).trim());
  for (const row of activities) {
    if (!['initial_email_sent','follow_up_sent','sequence_step_sent','booking_link_sent','human_response_sent'].includes(String(row.eventType || ''))) continue;
    if (String(row.sourceLeadId || '') !== String(lead.id || '') && String(row.leadId || '') !== `CE-${lead.id}`) continue;
    const id = String(parseMetadata(row.metadata).senderInboxId || '').trim();
    if (id) ids.add(id);
  }
  return [...ids];
}

function pinnedSenderId(lead, activities) {
  const ids = senderEvidence(lead, activities);
  if (ids.length > 1) throw new Error(`sender ownership conflict for lead ${lead.id}`);
  return ids[0] || '';
}

function chooseSender({ lead, activities = [], senders = [], sendsToday = new Map(), step = 1 } = {}) {
  const pinned = pinnedSenderId(lead, activities);
  if (pinned) {
    const sender = senders.find(item => item.id === pinned);
    if (!sender) throw new Error(`pinned sender ${pinned} is not configured`);
    if (!allowedForLead(sender, lead)) throw new Error(`pinned sender ${pinned} is not delivery eligible`);
    if ((sendsToday.get(sender.id) || 0) >= sender.dailyLimit) return { sender: null, reason: 'pinned sender daily limit reached', pinned: true };
    return { sender, pinned: true };
  }
  if (Number(step) > 1) throw new Error(`follow-up has no proven sender ownership for lead ${lead.id}`);
  const candidates = senders.filter(sender => allowedForLead(sender, lead)
    && (sendsToday.get(sender.id) || 0) < sender.dailyLimit);
  candidates.sort((a, b) => (sendsToday.get(a.id) || 0) - (sendsToday.get(b.id) || 0) || a.id.localeCompare(b.id));
  return candidates.length ? { sender: candidates[0], pinned: false } : { sender: null, reason: 'no eligible sender capacity', pinned: false };
}

function senderCountsToday(activities = [], dayKey) {
  const counts = new Map();
  for (const row of activities) {
    if (!['initial_email_sent','follow_up_sent','sequence_step_sent','booking_link_sent'].includes(String(row.eventType || ''))) continue;
    const occurredDay = row.occurredAt ? new Date(row.occurredAt).toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' }) : '';
    if (dayKey && occurredDay !== dayKey) continue;
    const id = String(parseMetadata(row.metadata).senderInboxId || '').trim();
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

module.exports = { configuredSenders, allowedForLead, senderEvidence, pinnedSenderId, chooseSender, senderCountsToday };
