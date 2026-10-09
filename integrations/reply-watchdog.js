'use strict';

// Deterministic check over the existing observer/activity ledger. No Gmail IO.
const { LEGACY_REPLY_EVENT_TYPES } = require('./canonical-reply');
const { replyDecisionsByKey } = require('./reply-decision');
const { tenantOf } = require('./clients/email-scope');

const ALERT_EVENT = 'reply_watchdog_alert';
const DEFAULT_THRESHOLD_MS = 10 * 60 * 1000;
// Start with the audited 2026-10-08 production window; older imported reply
// history predates per-message decisions and is reported by legacy checks.
const DEFAULT_SINCE = '2026-10-08T00:00:00.000Z';
const keyOf = value => String(value || '').replace(/^CE-/, '');
const metadataOf = row => {
  if (row?.metadata && typeof row.metadata === 'object') return row.metadata;
  try { return JSON.parse(row?.metadata || '{}') || {}; } catch (_) { return {}; }
};
const timeOf = row => Date.parse(row?.occurredAt || '') || 0;

function orphanedHumanReplies({ leads = [], activities = [], now = new Date(),
  since = DEFAULT_SINCE, thresholdMs = DEFAULT_THRESHOLD_MS } = {}) {
  const current = new Date(now).getTime();
  const start = since ? Date.parse(since) : 0;
  if (!Number.isFinite(current) || !Number.isFinite(start)) throw new Error('Invalid reply watchdog time');
  const byId = new Map(leads.map(lead => [String(lead.id), lead]));
  const decisions = replyDecisionsByKey(activities);
  const eventIds = new Set(activities.map(row => String(row.eventId || '')));
  const activityByLead = new Map();
  for (const item of activities) {
    const id = keyOf(item.sourceLeadId || item.leadId);
    if (!activityByLead.has(id)) activityByLead.set(id, []);
    activityByLead.get(id).push(item);
  }
  const seen = new Set();
  const orphans = [];
  for (const row of activities) {
    if (!LEGACY_REPLY_EVENT_TYPES.includes(String(row.eventType || ''))) continue;
    const meta = metadataOf(row);
    const messageId = String(meta.gmailMessageId || row.providerMessageId || '').trim();
    const leadId = keyOf(row.sourceLeadId || row.leadId);
    const lead = byId.get(leadId);
    const clientId = lead && tenantOf(lead);
    const receivedAt = timeOf(row);
    if (!lead || !clientId || !messageId || !receivedAt || receivedAt < start
      || current - receivedAt < thresholdMs) continue;
    const key = `${clientId}:${leadId}:${messageId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const state = String(meta.canonicalState || '');
    if (meta.genuineHuman === false || state === 'automated_reply'
      || ['out_of_office_reply', 'negative_reply', 'unsubscribe_reply'].includes(row.eventType)) continue;
    const decision = decisions.get(`${leadId}:${messageId}`);
    const decidedKind = String(decision?.finalClassification || '');
    if (['UNSUBSCRIBE', 'NOT_INTERESTED', 'OUT_OF_OFFICE'].includes(decidedKind)) continue;
    const threadId = String(meta.gmailThreadId || row.providerThreadId || '');
    const responses = (activityByLead.get(leadId) || []).filter(item =>
      timeOf(item) >= receivedAt && item !== row);
    const manual = responses.some(item => item.eventType === 'human_response_sent'
      && (!threadId || !String(metadataOf(item).gmailThreadId || item.providerThreadId || '')
        || String(metadataOf(item).gmailThreadId || item.providerThreadId) === threadId));
    const sent = ['sent', 'already_sent'].includes(decision?.executionStatus)
      || responses.some(item => ['booking_link_sent', 'question_auto_answer_sent'].includes(item.eventType)
        && String(metadataOf(item).inboundMessageId || '') === messageId);
    // A recorded route is durable evidence that the review mutation succeeded.
    // The in-memory lead passed by the running observer may still have its old
    // stage immediately after that write; failed or unreported execution alone
    // is never treated as a successful escalation.
    const waiting = Boolean(decision && (decision.executionStatus === 'routed_to_human'
      || (['blocked', 'failed'].includes(decision.executionStatus)
        && decision.fallbackAction === 'HUMAN_REVIEW')));
    if (manual || sent || waiting) continue;
    const senderInboxId = String(meta.senderInboxId || row.senderInboxId || lead.senderInboxId || '');
    const alertId = `reply-orphan:${clientId}:${senderInboxId || 'unknown'}:${leadId}:${messageId}`;
    orphans.push({ leadId, company: lead.company, clientId, senderInboxId,
      messageId, receivedAt: new Date(receivedAt).toISOString(), alertId,
      alreadyAlerted: eventIds.has(alertId),
      reason: decision ? `decision ended ${decision.executionStatus || 'without execution'} without a recorded response or review`
        : 'genuine inbound has no reply decision, response, or human review' });
  }
  return orphans;
}

function watchdogAlertEvent(orphan, at = new Date()) {
  return { eventId: orphan.alertId, leadId: `CE-${orphan.leadId}`,
    sourceLeadId: orphan.leadId, company: orphan.company, eventType: ALERT_EVENT,
    occurredAt: new Date(at).toISOString(), subject: 'Urgent: inbound reply lacks a disposition', content: '',
    metadata: JSON.stringify({ clientId: orphan.clientId, senderInboxId: orphan.senderInboxId,
      gmailMessageId: orphan.messageId, receivedAt: orphan.receivedAt, priority: 'urgent',
      reason: orphan.reason }) };
}

module.exports = { ALERT_EVENT, DEFAULT_SINCE, DEFAULT_THRESHOLD_MS, orphanedHumanReplies, watchdogAlertEvent };
