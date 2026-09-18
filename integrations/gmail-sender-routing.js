'use strict';

const {
  parseRegistry, withDefaultInboxes, parseRuntimeOverlay, applySenderRuntime,
} = require('./gmail-inbox-registry');
const { DEFAULT_INBOX_DAILY_LIMIT, DEFAULT_INBOX_PER_RUN_LIMIT } = require('./gmail-sender-capacity');

function parseMetadata(value) {
  try { return value && typeof value === 'object' ? value : JSON.parse(String(value || '{}')); }
  catch (_) { return {}; }
}

function configuredSenders(env = process.env) {
  const primary = {
    id: 'primary', email: String(env.FROM_EMAIL || '').trim().toLowerCase(),
    tokenEnv: 'GMAIL_TOKEN_JSON', oauthClient: 'primary', status: 'active',
    provider: 'gmail', observerEnabled: true,
    dailyLimit: Number(env.GMAIL_PRIMARY_DAILY_LIMIT || DEFAULT_INBOX_DAILY_LIMIT),
    perRunLimit: Number(env.GMAIL_PRIMARY_PER_RUN_LIMIT || DEFAULT_INBOX_PER_RUN_LIMIT),
    credentialConfigured: Boolean(env.GMAIL_TOKEN_JSON),
  };
  const secondary = withDefaultInboxes(parseRegistry(env.GMAIL_INBOX_REGISTRY_JSON || '[]')).map(entry => ({
    ...entry, oauthClient: 'secondary', provider: 'gmail',
    perRunLimit: Number(entry.perRunLimit || DEFAULT_INBOX_PER_RUN_LIMIT),
    observerEnabled: entry.observerEnabled !== false,
    credentialConfigured: Boolean(env[entry.tokenEnv]),
  }));
  const senders = [primary, ...secondary].map(sender => ({
    ...sender,
    sendEligible: sender.status === 'active' && sender.dailyLimit > 0 && sender.credentialConfigured,
  }));
  return applySenderRuntime(senders, parseRuntimeOverlay(env.GMAIL_SENDER_RUNTIME_JSON || '[]'));
}

function observableSenders(senders = []) {
  return (senders || []).filter(sender => sender
    && sender.observerEnabled !== false
    && sender.credentialConfigured);
}

function allowedForLead(sender, lead = {}) {
  const niche = String(lead.leadNiche || lead.tradeType || '').toLowerCase();
  // An explicit operator choice is available to staffing as well as dental.
  // Unassigned legacy non-dental traffic retains its existing primary route.
  if (niche.includes('staffing')) return sender.sendEligible;
  if (niche.includes('dent')) return sender.sendEligible;
  return sender.id === 'primary' && sender.sendEligible;
}

// The canonical activity events that carry immutable sender attribution. Named
// so the read-only visibility layer reads the SAME list this resolver does and
// the two cannot drift; the membership itself is unchanged.
const SENDER_ATTRIBUTED_EVENTS = Object.freeze([
  'sender_evidence_reconciled',
  'initial_email_sent', 'follow_up_sent', 'sequence_step_sent',
  'booking_link_sent', 'human_response_sent',
]);

function activityBelongsToLead(row, lead) {
  if (!String(lead.id || '').trim()) return false;
  if (row.sourceLeadId) return String(row.sourceLeadId) === String(lead.id);
  return String(row.leadId || '') === `CE-${lead.id}`;
}

function senderEvidence(lead = {}, activities = []) {
  const ids = new Set();
  if (lead.senderInboxId && (Number(lead.emailStep || 0) > 0 || String(lead.emailStatus || '').trim())) ids.add(String(lead.senderInboxId).trim());
  for (const row of activities) {
    if (!SENDER_ATTRIBUTED_EVENTS.includes(String(row.eventType || ''))) continue;
    if (!activityBelongsToLead(row, lead)) continue;
    const id = String(parseMetadata(row.metadata).senderInboxId || '').trim();
    if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * The sender ids proven by an actual delivered message, as opposed to the
 * assignment persisted on the lead row before anything was sent.
 *
 * Read-only, and deliberately separate from senderEvidence(): the send path's
 * behaviour depends on the union, while the UI needs to tell an operator
 * whether a sender is a recorded fact or still only an intention.
 */
function sentSenderEvidence(lead = {}, activities = []) {
  const ids = new Set();
  for (const row of activities) {
    if (!SENDER_ATTRIBUTED_EVENTS.includes(String(row.eventType || ''))) continue;
    if (!activityBelongsToLead(row, lead)) continue;
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

function chooseSender({
  lead, activities = [], senders = [], sendsToday = new Map(),
  windowRemainingBySender = null, step = 1,
} = {}) {
  const pinned = pinnedSenderId(lead, activities);
  if (pinned) {
    const sender = senders.find(item => item.id === pinned);
    if (!sender) throw new Error(`pinned sender ${pinned} is not configured`);
    if (!allowedForLead(sender, lead)) throw new Error(`pinned sender ${pinned} is not delivery eligible`);
    if ((sendsToday.get(sender.id) || 0) >= sender.dailyLimit) return { sender: null, reason: 'pinned sender daily limit reached', pinned: true };
    if (windowRemainingBySender && (windowRemainingBySender.get(sender.id) || 0) <= 0) {
      return { sender: null, reason: 'pinned sender scheduled-window limit reached', pinned: true };
    }
    return { sender, pinned: true };
  }
  if (Number(step) > 1) throw new Error(`follow-up has no proven sender ownership for lead ${lead.id}`);
  // Queue selection is an instruction, not delivered-message evidence. Honour
  // it for step 1; only a successful send may establish ownership for step 2.
  const assigned = String(lead.senderInboxId || '').trim();
  if (assigned) {
    const sender = senders.find(item => item.id === assigned);
    if (!sender) throw new Error(`assigned sender ${assigned} is not configured`);
    if (!allowedForLead(sender, lead)) throw new Error(`assigned sender ${assigned} is not delivery eligible`);
    if ((sendsToday.get(sender.id) || 0) >= sender.dailyLimit) return { sender: null, reason: 'assigned sender daily limit reached', pinned: false };
    if (windowRemainingBySender && (windowRemainingBySender.get(sender.id) || 0) <= 0) {
      return { sender: null, reason: 'assigned sender scheduled-window limit reached', pinned: false };
    }
    return { sender, pinned: false, assigned: true };
  }
  if (String(lead.routingRequired).toLowerCase() === 'true'
    || String(lead.leadNiche || lead.tradeType || '').toLowerCase().includes('staffing')) {
    throw new Error('required sender assignment is missing');
  }
  const candidates = senders.filter(sender => allowedForLead(sender, lead)
    && (sendsToday.get(sender.id) || 0) < sender.dailyLimit
    && (!windowRemainingBySender || (windowRemainingBySender.get(sender.id) || 0) > 0));
  candidates.sort((a, b) => (sendsToday.get(a.id) || 0) - (sendsToday.get(b.id) || 0) || a.id.localeCompare(b.id));
  return candidates.length ? { sender: candidates[0], pinned: false } : { sender: null, reason: 'no eligible sender capacity', pinned: false };
}

const SUCCESSFUL_SEND_EVENTS = Object.freeze([
  'initial_email_sent', 'follow_up_sent', 'sequence_step_sent', 'booking_link_sent',
]);

function senderCountsToday(activities = [], dayKey) {
  const counts = new Map();
  const seen = new Set();
  for (const row of activities) {
    if (!SUCCESSFUL_SEND_EVENTS.includes(String(row.eventType || ''))) continue;
    const occurredDay = row.occurredAt ? new Date(row.occurredAt).toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' }) : '';
    if (dayKey && occurredDay !== dayKey) continue;
    const eventKey = String(row.eventId || `${row.leadId}:${row.eventType}:${row.occurredAt}:${row.metadata || ''}`);
    if (seen.has(eventKey)) continue;
    seen.add(eventKey);
    // Historical activity predates multi-inbox attribution. Those sends came
    // from the only mailbox that existed at the time, so count them against the
    // primary sender instead of turning legacy successful sends into free quota.
    const id = String(parseMetadata(row.metadata).senderInboxId || 'primary').trim() || 'primary';
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

function successfulSendCountToday(activities = [], dayKey) {
  let count = 0;
  const seen = new Set();
  for (const row of activities) {
    if (!SUCCESSFUL_SEND_EVENTS.includes(String(row.eventType || ''))) continue;
    const occurredDay = row.occurredAt
      ? new Date(row.occurredAt).toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' }) : '';
    if (dayKey && occurredDay !== dayKey) continue;
    const eventKey = String(row.eventId || `${row.leadId}:${row.eventType}:${row.occurredAt}:${row.metadata || ''}`);
    if (seen.has(eventKey)) continue;
    seen.add(eventKey);
    count++;
  }
  return count;
}

module.exports = {
  SUCCESSFUL_SEND_EVENTS, configuredSenders, observableSenders, allowedForLead, senderEvidence,
  sentSenderEvidence, SENDER_ATTRIBUTED_EVENTS, pinnedSenderId, chooseSender,
  senderCountsToday, successfulSendCountToday,
};
