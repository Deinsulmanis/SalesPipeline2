'use strict';

const DEFAULT_LATE_REPLY_LOOKBACK_DAYS = 60;
const DEFAULT_LATE_REPLY_BATCH_LIMIT = 75;
const OUTBOUND_EVENT_TYPES = new Set(['initial_email_sent', 'follow_up_sent']);

const LATE_REPLY_LABELS = Object.freeze({
  QUESTION: 'Question — needs review',
  INTERESTED: 'Interested — needs review',
  MEETING_REQUEST: 'Meeting requested — needs review',
  NOT_INTERESTED: 'Not interested',
  UNSUBSCRIBE: 'Unsubscribed',
  OUT_OF_OFFICE: 'Out of office',
  WRONG_PERSON: 'Wrong person — needs review',
  NEEDS_HUMAN: 'Needs human review',
});

const CANONICAL_REPLY_NOTES = Object.freeze({
  QUESTION: '[REPLY: Question — late, needs review]',
  INTERESTED: '[REPLY: Interested]',
  MEETING_REQUEST: '[REPLY: Meeting Requested]',
  NOT_INTERESTED: '[REPLY: Not Interested]',
  UNSUBSCRIBE: '[REPLY: Unsubscribed]',
  OUT_OF_OFFICE: '[REPLY: OOO — late]',
  WRONG_PERSON: '[REPLY: Wrong Person — late, needs review]',
  NEEDS_HUMAN: '[REPLY: Needs human]',
});

function parseMetadata(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '{}')); } catch (_) { return {}; }
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
}

function latestOutboundReferences(activities = []) {
  const refs = new Map();
  for (const row of activities) {
    if (!OUTBOUND_EVENT_TYPES.has(String(row.eventType || ''))) continue;
    const leadId = String(row.sourceLeadId || row.leadId || '').replace(/^CE-/, '').trim();
    const metadata = parseMetadata(row.metadata);
    const threadId = String(metadata.gmailThreadId || '').trim();
    const messageId = String(metadata.gmailMessageId || '').trim();
    if (!leadId || !threadId || !messageId) continue;
    const occurredAt = String(row.occurredAt || '');
    const current = refs.get(leadId);
    if (!current || occurredAt > current.occurredAt) refs.set(leadId, { threadId, messageId, occurredAt });
  }
  return refs;
}

function existingLateReplyEventIds(activities = []) {
  return new Set(activities
    .filter(row => row.eventType === 'late_reply' && row.eventId)
    .map(row => String(row.eventId)));
}

function lateReplyEventId(messageId) {
  return `gmail-reply:${String(messageId || '').trim()}`;
}

function terminalExclusionReason(lead, suppressedEmails = new Set()) {
  if (String(lead.emailStatus || '').trim().toLowerCase() !== 'done') return 'not_terminal';
  if (!validEmail(lead.email)) return 'invalid_email';
  const notes = String(lead.notes || '');
  const lateReplyPending = /\[LATE REPLY:/i.test(notes);
  if ((/\[REPLY:\s*Unsubscribed\]/i.test(notes) || /^unsub(?:scribed)?$/i.test(String(lead.stage || '').trim())) && !lateReplyPending) return 'unsubscribed';
  if (/\[BOUNCED/i.test(notes)) return 'bounced';
  if (suppressedEmails.has(normalizeEmail(lead.email))) return 'suppressed';
  return '';
}

function selectLateReplyCandidates(leads = [], activities = [], options = {}) {
  const nowMs = options.now ? new Date(options.now).getTime() : Date.now();
  const lookbackDays = positiveInteger(options.lookbackDays, DEFAULT_LATE_REPLY_LOOKBACK_DAYS);
  const batchLimit = positiveInteger(options.batchLimit, DEFAULT_LATE_REPLY_BATCH_LIMIT);
  const cutoffMs = nowMs - lookbackDays * 24 * 60 * 60 * 1000;
  const suppressedEmails = options.suppressedEmails || new Set();
  const refs = latestOutboundReferences(activities);
  const stats = { terminal: 0, insideLookback: 0, usableIdentity: 0, eligible: 0 };
  const candidates = [];

  for (const lead of leads) {
    if (String(lead.emailStatus || '').trim().toLowerCase() !== 'done') continue;
    stats.terminal++;
    const sentMs = new Date(lead.lastEmailedAt || '').getTime();
    if (!Number.isFinite(sentMs) || sentMs < cutoffMs || sentMs > nowMs) continue;
    stats.insideLookback++;
    const ref = refs.get(String(lead.id || '').trim());
    if (!ref) continue;
    stats.usableIdentity++;
    if (terminalExclusionReason(lead, suppressedEmails)) continue;
    candidates.push({ lead, outbound: ref });
  }

  candidates.sort((a, b) => String(b.lead.lastEmailedAt).localeCompare(String(a.lead.lastEmailedAt)));
  stats.eligible = candidates.length;
  return { candidates: candidates.slice(0, batchLimit), stats, lookbackDays, batchLimit };
}

function prependUniqueNote(notes, note) {
  const current = String(notes || '');
  return current.includes(note) ? current : `${note}${current ? `\n${current}` : ''}`;
}

function lateReplyNotes(notes, classification) {
  const canonical = CANONICAL_REPLY_NOTES[classification] || CANONICAL_REPLY_NOTES.NEEDS_HUMAN;
  const label = LATE_REPLY_LABELS[classification] || LATE_REPLY_LABELS.NEEDS_HUMAN;
  return prependUniqueNote(prependUniqueNote(notes, canonical), `[LATE REPLY: ${label}]`);
}

function buildLateReplyActivity(lead, message, classification) {
  const messageId = String(message.messageId || '').trim();
  return {
    eventId: lateReplyEventId(messageId),
    leadId: `CE-${lead.id}`,
    sourceLeadId: String(lead.id || ''),
    email: normalizeEmail(lead.email),
    company: String(lead.company || ''),
    eventType: 'late_reply',
    occurredAt: String(message.occurredAt || new Date().toISOString()),
    subject: String(message.subject || ''),
    content: String(message.body || message.snippet || '').trim().slice(0, 1500),
    metadata: JSON.stringify({
      classification,
      gmailMessageId: messageId,
      gmailThreadId: String(message.threadId || ''),
      rfcMessageId: String(message.rfcMessageId || ''),
      fromAddr: String(message.fromAddr || ''),
      detectedAfterSequence: true,
      priorEmailStatus: String(lead.emailStatus || ''),
      requiresHumanAttention: classification !== 'OUT_OF_OFFICE',
    }),
  };
}

async function processLateReply({ lead, message, classify, existingEventIds, writeNotes, addSuppression, recordActivity }) {
  if (!lead || !message?.messageId) return { status: 'invalid' };
  const eventId = lateReplyEventId(message.messageId);
  if (existingEventIds.has(eventId)) {
    // Recovery path: the activity may have committed immediately before a
    // transient suppression write failed. The row tag already blocks sends;
    // this retry restores the durable, email-keyed suppression record.
    if (/\[REPLY:\s*Unsubscribed\]/i.test(String(lead.notes || ''))) await addSuppression(lead);
    return { status: 'duplicate', eventId };
  }

  const replyText = String(message.body || message.snippet || '').trim();
  const classification = await classify(lead.company, replyText);
  const safeClassification = LATE_REPLY_LABELS[classification] ? classification : 'NEEDS_HUMAN';
  const notes = lateReplyNotes(lead.notes, safeClassification);

  // This deliberately writes only notes. It never changes stage, emailStatus,
  // lastEmailedAt, emailStep, routing, or any scheduling field.
  await writeNotes(lead, notes);
  lead.notes = notes;

  const activity = buildLateReplyActivity(lead, message, safeClassification);
  await recordActivity(activity);
  existingEventIds.add(eventId);
  if (safeClassification === 'UNSUBSCRIBE') await addSuppression(lead);
  return { status: 'recorded', classification: safeClassification, activity };
}

module.exports = {
  DEFAULT_LATE_REPLY_LOOKBACK_DAYS,
  DEFAULT_LATE_REPLY_BATCH_LIMIT,
  LATE_REPLY_LABELS,
  latestOutboundReferences,
  existingLateReplyEventIds,
  lateReplyEventId,
  terminalExclusionReason,
  selectLateReplyCandidates,
  lateReplyNotes,
  buildLateReplyActivity,
  processLateReply,
};
