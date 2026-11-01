'use strict';

// Observation has no sender, stage writer, enrollment capability or model API.
// Canonical evidence is committed before any subsequent automation evaluation.
const { headerValue, parseAddr, firstPlainText, firstHtmlText, decodeBodies, matchMailboxMessages, providerRead, isManagedLead } = require('./gmail-mailbox-observer');
const { classifyReplyText } = require('./canonical-reply');
const { uniqueSuppressions, suppressionForCanonical, inboundAlreadyEvaluated } = require('./inbound-reply-guard');
const { eventTypeFor, stripQuotedReply } = require('./reply-reconciliation');
const { planOutboundActivity } = require('./human-outbound');
const { providerMessageId } = require('./canonical-sends');
const { resolveLeadClient } = require('./clients/ownership');
const { getClient } = require('./clients/registry');
const { managedReplyNeedsHandler } = require('./clients/reply-pipeline');
const { DELIVERY_CLASS, LATER_TOUCH_BLOCKING_CLASSES, DELIVERY_DEFERRED_EVENT, DELIVERY_FAILED_EVENT } = require('./delivery-status');
const norm = value => String(value || '').trim().toLowerCase();

const HUMAN_REPLY_TEXT_LIMIT = 1500;
const SENDER_AUTH_FAILURE_EVENT = 'sender_auth_delivery_failure';
const COLD_SEND_EVENTS = new Set(['initial_email_sent', 'follow_up_sent', 'sequence_step_sent']);

// The cold send a delivery notice answers: the latest send to this lead before
// the notice, preferring the notice's own thread. Cisco and Trend Micro notices
// start a new thread, so the thread alone cannot name it.
function originalDelivery(leadRows = [], message, noticeAt) {
  const rowMeta = row => { try { return typeof row.metadata === 'object' ? row.metadata || {} : JSON.parse(row.metadata || '{}'); } catch (_) { return {}; } };
  const sends = leadRows.filter(row => COLD_SEND_EVENTS.has(String(row.eventType || '')))
    .map(row => ({ row, data: rowMeta(row), at: Date.parse(row.occurredAt || '') }))
    .filter(item => Number.isFinite(item.at) && item.at <= noticeAt)
    .sort((a, b) => b.at - a.at);
  const found = sends.find(item => String(item.data.gmailThreadId || '') === String(message.threadId || '')) || sends[0];
  if (!found) return null;
  const step = found.row.eventType === 'initial_email_sent' ? 1 : Number(found.data.step ?? found.data.sequenceStep);
  return { gmailMessageId: providerMessageId(found.row) || '', gmailThreadId: String(found.data.gmailThreadId || ''),
    sentAt: found.row.occurredAt, ...(Number.isInteger(step) && step >= 1 ? { step } : {}) };
}

// What a delivery notice literally said, and which send it was about.
function deliveryFields(verdict = {}, original, noticeFrom) {
  return { deliveryClass: verdict.category || null, bounceType: verdict.bounceType ?? null,
    dsnAction: verdict.action || null, dsnStatus: verdict.status || null, enhancedCode: verdict.enhancedCode || null,
    smtpCode: verdict.smtpCode || null, diagnostic: verdict.diagnostic || null, remoteMta: verdict.remoteMta || null,
    finalFailure: Boolean(verdict.final), noticeFromDomain: String(noticeFrom || '').split('@')[1] || null,
    ...(original ? { originalGmailMessageId: original.gmailMessageId, originalGmailThreadId: original.gmailThreadId,
      originalSendAt: original.sentAt, ...(original.step ? { step: original.step } : {}) } : {}) };
}

// The words the sender actually wrote, and the ONLY text a reply classifier may
// read. text/plain when the client sent it; otherwise the text/html part, cut
// at its quote markup before it becomes text (iPhone Mail sends HTML alone).
// The snippet is a last resort: a flattened preview that can run into the quote,
// so it is stripped the same way. The provider message is never modified — it
// stays in Gmail, addressed by the gmailMessageId every event carries.
function ownReplyText(payload, snippet = '') {
  let raw = '';
  try { raw = firstPlainText(payload) || firstHtmlText(payload) || decodeBodies(payload) || ''; } catch (_) { raw = ''; }
  return stripQuotedReply(raw || snippet || '');
}

// What a person actually wrote, from the Gmail message itself: the text/plain
// part only — never the HTML part or the snippet, which can carry the quoted
// thread — quote-stripped exactly as inbound replies are. '' when there is no
// readable plain text; the human evidence is recorded either way.
function humanReplyText(payload) {
  let text = '';
  try { text = stripQuotedReply(firstPlainText(payload)); } catch (_) { text = ''; }
  return { text: text.slice(0, HUMAN_REPLY_TEXT_LIMIT), truncated: text.length > HUMAN_REPLY_TEXT_LIMIT };
}
const meta = row => { try { return typeof row.metadata === 'object' ? row.metadata : JSON.parse(row.metadata || '{}'); } catch (_) { return {}; } };
const addresses = text => String(text || '').split(',').map(parseAddr).filter(Boolean);

async function planMailboxEvents({ observation, gmail, leads, activities, senderInboxId, senderEmail, now = new Date() }) {
  const events = [];
  const suppressions = [];
  const replies = [];
  const ignored = [];
  const existing = new Set(activities.map(row => String(row.eventId)));
  const byId = new Map(leads.map(lead => [String(lead.id), lead]));
  const emailBuckets = new Map();
  for (const lead of leads) emailBuckets.set(norm(lead.email), [...(emailBuckets.get(norm(lead.email)) || []), lead]);
  const leadsByEmail = new Map([...emailBuckets].filter(([email, rows]) => email && rows.length === 1).map(([email, rows]) => [email, rows[0]]));
  const existingActivitiesByLead = new Map(leads.map(lead => [lead.id, activities.filter(row => row.sourceLeadId === lead.id || row.leadId === `CE-${lead.id}`)]));
  const inboundEvent = /reply|meeting_requested|email_bounced/;
  const threadHasCrmInbound = (threadId, lead, at) => {
    const mine = existingActivitiesByLead.get(lead.id) || [];
    return mine.some(row => {
      if (!inboundEvent.test(String(row.eventType || ''))) return false;
      const data = meta(row);
      if (String(data.gmailThreadId || '') !== String(threadId || '')) return false;
      const when = Date.parse(row.occurredAt || data.receivedAt || '');
      return Number.isFinite(when) && when < at;
    });
  };
  const batchInboundBefore = (threadId, leadEmail, at) => [...observation.messages].some(item =>
    item.threadId === threadId && Number(item.internalDate) < at
    && !(item.labelIds || []).includes('SENT')
    && parseAddr(headerValue(item.payload, 'From')) === norm(leadEmail));
  const threadCache = new Map();
  const plannedDeliveries = new Set();
  const add = event => { if (!existing.has(event.eventId)) { events.push(event); existing.add(event.eventId); } };
  // The first outreach timestamp is authoritative for matching, not the most
  // recent follow-up: a later send must never hide an earlier unseen reply.
  const matchLeads = leads.map(lead => {
    const times = [lead.lastEmailedAt, ...(existingActivitiesByLead.get(lead.id) || [])
      .filter(row => ['initial_email_sent','follow_up_sent','booking_link_sent'].includes(row.eventType)).map(row => row.occurredAt)]
      .map(Date.parse).filter(Number.isFinite);
    return { ...lead, lastEmailedAt: times.length ? new Date(Math.min(...times)).toISOString() : '' };
  });
  for (const message of [...observation.messages].sort((a,b) => Number(a.internalDate) - Number(b.internalDate))) {
    if ((message.labelIds || []).includes('DRAFT')) { ignored.push({ id: message.id, reason: 'draft' }); continue; }
    const at = Number(message.internalDate);
    if (!message.id || !Number.isFinite(at) || at <= 0) throw new Error('Gmail message missing canonical identity/timestamp');
    const occurredAt = new Date(at).toISOString();
    const from = parseAddr(headerValue(message.payload, 'From'));
    const rfcMessageId = headerValue(message.payload, 'Message-ID');
    if ((message.labelIds || []).includes('SENT') && from === norm(senderEmail)) {
      const to = [...addresses(headerValue(message.payload, 'To')), ...addresses(headerValue(message.payload, 'Cc'))];
      const matches = [...new Set(to.map(email => leadsByEmail.get(email)).filter(Boolean))];
      if (matches.length > 1) throw new Error(`Ambiguous outbound CRM identity for Gmail message ${message.id}`);
      const lead = matches[0];
      if (!lead) { ignored.push({ id: message.id, reason: 'unmatched_outbound' }); continue; }
      const mine = existingActivitiesByLead.get(lead.id) || [];
      // Already recorded under the canonical provider id, whichever key the
      // writer used — cold steps, warm replies and earlier observations use
      // gmailMessageId, stage-sequence sends use providerMessageId.
      if (mine.some(row => providerMessageId(row) === message.id)) continue;
      const priorInbound = threadHasCrmInbound(message.threadId, lead, at)
        || batchInboundBefore(message.threadId, lead.email, at);
      // Fetch the Gmail thread only when CRM and this batch cannot prove a prior
      // inbound. Incremental history already delivered the new outbound message.
      if (!priorInbound && !threadCache.has(message.threadId)) {
        const response = await providerRead('users.threads.get', { userId: 'me', id: message.threadId, format: 'metadata', metadataHeaders: ['From'] }, params => gmail.users.threads.get(params), { mailboxId: senderInboxId, feature: 'gmail_history_observer' });
        threadCache.set(message.threadId, response.data.messages || []);
      }
      const threadInbound = priorInbound || (threadCache.get(message.threadId) || []).some(item => Number(item.internalDate) < at
        && parseAddr(headerValue(item.payload, 'From')) === norm(lead.email));
      const plan = planOutboundActivity({ id: message.id, threadId: message.threadId, to,
        subject: headerValue(message.payload, 'Subject'), sentAt: occurredAt }, {
        leadsByEmail, existingActivitiesByLead, threadsWithInbound: new Set(threadInbound ? [message.threadId] : []),
      });
      if (plan.activity) {
        const reply = humanReplyText(message.payload);
        add({ ...plan.activity, content: reply.text, metadata: JSON.stringify({ ...plan.activity.metadata,
          senderInboxId, rfcMessageId, recoveredDuringOutage: observation.recovered,
          contentCapture: reply.text ? 'quote_stripped_plain_text' : 'unavailable',
          contentTruncated: reply.truncated }) });
      } else ignored.push({ id: message.id, reason: plan.outcome });
      continue;
    }
    const matched = matchMailboxMessages([message], { leads: matchLeads, activities, senderInboxId, senderEmail });
    const authFailures = matched.senderAuthFailures || new Map();
    const deliveryNotices = matched.deliveryNotices || new Map();
    if (!matched.replies.size && !matched.bounces.size && !authFailures.size && !deliveryNotices.size) { ignored.push({ id: message.id, reason: 'unmatched_or_irrelevant' }); continue; }
    // Our domain failed SPF/DKIM/DMARC: an infrastructure fact about the sender.
    // No suppression — the recipient is not disproven and stays recoverable.
    for (const [leadId, { verdict }] of authFailures) {
      const lead = byId.get(String(leadId));
      add({ eventId: `gmail-sender-auth:${senderInboxId}:${message.id}:${leadId}`, leadId: `CE-${lead.id}`, sourceLeadId: lead.id,
        email: lead.email, company: lead.company, eventType: SENDER_AUTH_FAILURE_EVENT, occurredAt, content: '',
        subject: headerValue(message.payload, 'Subject'),
        metadata: JSON.stringify({ provider: 'gmail', gmailMessageId: message.id, gmailThreadId: message.threadId,
          senderInboxId, rfcMessageId, deliveryClass: verdict.category, dsnAction: verdict.action || null,
          dsnStatus: verdict.status || null, finalFailure: verdict.final, recipientSuppressed: false,
          recoveredDuringOutage: observation.recovered, autoSendAllowed: false, requiresHumanAttention: true }) });
    }
    for (const [leadId] of matched.bounces) {
      const lead = byId.get(String(leadId));
      const eventId = `gmail-bounce:${senderInboxId}:${message.id}:${leadId}`;
      const mine = existingActivitiesByLead.get(lead.id) || [];
      const original = originalDelivery(mine, message, at);
      suppressions.push({ email: lead.email, reason: 'bounce', company: lead.company });
      // Two gateways can report the same failed delivery. One bounce row each.
      const deliveryKey = `email_bounced:${lead.id}:${original?.gmailMessageId || message.id}`;
      const reported = plannedDeliveries.has(deliveryKey) || (original && mine.some(row => row.eventType === 'email_bounced'
        && Date.parse(row.occurredAt || '') >= Date.parse(original.sentAt || '')));
      plannedDeliveries.add(deliveryKey);
      if (reported && isManagedLead(lead)) continue;
      add({ eventId, leadId: `CE-${lead.id}`, sourceLeadId: lead.id, email: lead.email, company: lead.company,
        eventType: 'email_bounced', occurredAt, content: '', subject: headerValue(message.payload, 'Subject'),
        metadata: JSON.stringify({ provider: 'gmail', gmailMessageId: message.id, gmailThreadId: message.threadId,
          senderInboxId, rfcMessageId, ...deliveryFields(matched.bounceVerdicts?.get(leadId), original, from),
          recipientSuppressed: true, deliveryKey, recoveredDuringOutage: observation.recovered, autoSendAllowed: false }) });
    }
    // Delays, final temporary failures and policy refusals are facts about one
    // delivery, not about the mailbox, so they never suppress. One row per
    // delivery and outcome: Gmail repeats a delay notice for days.
    for (const [leadId, { verdict }] of deliveryNotices) {
      const lead = byId.get(String(leadId));
      const original = originalDelivery(existingActivitiesByLead.get(lead.id) || [], message, at);
      const deferred = verdict.category === DELIVERY_CLASS.TEMPORARY_PROVIDER_DELAY;
      const deliveryKey = `${verdict.category}:${lead.id}:${original?.gmailMessageId || message.id}:${verdict.enhancedCode || 'nocode'}`;
      const blocksLaterTouches = LATER_TOUCH_BLOCKING_CLASSES.has(verdict.category);
      add({ eventId: `gmail-delivery:${senderInboxId}:${deliveryKey}`, leadId: `CE-${lead.id}`, sourceLeadId: lead.id,
        email: lead.email, company: lead.company, eventType: deferred ? DELIVERY_DEFERRED_EVENT : DELIVERY_FAILED_EVENT,
        occurredAt, content: '', subject: headerValue(message.payload, 'Subject'),
        metadata: JSON.stringify({ provider: 'gmail', gmailMessageId: message.id, gmailThreadId: message.threadId,
          senderInboxId, rfcMessageId, ...deliveryFields(verdict, original, from), recipientSuppressed: false,
          blocksLaterTouches, deliveryKey, recoveredDuringOutage: observation.recovered, autoSendAllowed: false,
          requiresHumanAttention: blocksLaterTouches }) });
    }
    for (const [leadId] of matched.replies) {
      const lead = byId.get(String(leadId));
      const text = ownReplyText(message.payload, message.snippet);
      const canonical = classifyReplyText(text, { currentEmail: lead.email, subject: headerValue(message.payload,'Subject'), now: occurredAt, year: new Date(at).getUTCFullYear() });
      const suppression = suppressionForCanonical(canonical, lead);
      if (suppression) suppressions.push(suppression);
      const eventId = `gmail-reply:${message.id}`;
      const already = existing.has(eventId) || activities.some(row => meta(row).gmailMessageId === message.id && /reply|meeting_requested/.test(row.eventType));
      const evaluated = inboundAlreadyEvaluated(activities, message.id);
      const historical = observation.recovered || new Date(now).getTime() - at > 90 * 60000;
      if (!already) {
        const event = { eventId, leadId: `CE-${lead.id}`, sourceLeadId: lead.id, email: lead.email, company: lead.company,
          eventType: canonical.reason === 'unsubscribe_request' ? 'unsubscribe_reply' : eventTypeFor(canonical.state), occurredAt,
          subject: headerValue(message.payload,'Subject'), content: text.slice(0, 1500),
          metadata: JSON.stringify({ provider: 'gmail', senderInboxId, gmailMessageId: message.id,
            gmailThreadId: message.threadId, rfcMessageId, from, matchedColdEmailId: lead.id, receivedAt: occurredAt,
            canonicalState: canonical.state, subtype: canonical.subtype, reason: canonical.reason,
            genuineHuman: canonical.genuineHuman, confidence: canonical.confidence, classifierVersion: canonical.classifierVersion,
            returnDate: canonical.returnDate, revisitDate: canonical.revisitDate, proposedEmail: canonical.proposedEmail,
            suppliedContact: canonical.suppliedContact || null,
            recoveredDuringOutage: historical, responsePending: !historical,
            requiresHumanAttention: historical && canonical.genuineHuman !== false,
            autoSendAllowed: false, identityMutationAllowed: false }) };
        add(event);
      }
      // Recovery and CHECK_ONLY must still classify through this path. An
      // already-persisted opt-out/rejection is re-queued so terminal CRM
      // mutations cannot be skipped just because the Gmail event exists.
      const terminal = canonical.reason === 'unsubscribe_request'
        || (canonical.state === 'negative' && canonical.reason === 'explicit_rejection');
      const owner = resolveLeadClient(lead);
      const managed = owner.ok && getClient(owner.clientId).replyPolicy?.mode === 'managed';
      const needsManaged = managed && managedReplyNeedsHandler(activities, message.id, owner.clientId);
      if ((!already && !evaluated) || terminal || needsManaged) {
        replies.push({ leadId, message, historical, canonical, alreadyRecorded: already || evaluated });
      }
    }
  }
  for (const missing of observation.unavailable || []) {
    add({ eventId: `gmail-unavailable:${senderInboxId}:${missing.id}`, leadId: '', sourceLeadId: '', email: '', company: '',
      eventType: 'gmail_observation_gap', occurredAt: new Date(now).toISOString(), subject: '', content: '',
      metadata: JSON.stringify({ ...missing, provider: 'gmail', senderInboxId, gmailMessageId: missing.id,
        gmailThreadId: missing.threadId, autoSendAllowed: false, requiresHumanAttention: true }) });
  }
  if (observation.recovered) add({
    eventId: `gmail-catchup:${senderInboxId}:${observation.anchor}`, leadId: '', sourceLeadId: '', email: '', company: '',
    eventType: 'gmail_observation_recovered', occurredAt: new Date(now).toISOString(), subject: '', content: '',
    metadata: JSON.stringify({ senderInboxId, from: observation.from, anchor: observation.anchor,
      nextHistoryId: observation.nextHistoryId, discovered: observation.discoveredCount, examined: observation.messagesInspected,
      unavailable: observation.unavailable, ignored: ignored.length,
      crmEvents: events.filter(event => event.sourceLeadId).map(event => ({ eventId: event.eventId, leadId: event.sourceLeadId, type: event.eventType })),
      autoSendAllowed: false }),
  });
  return { events, suppressions: uniqueSuppressions(suppressions), replies, ignored };
}

async function commitObservation({ observation, plan, appendEvent, appendEvents, suppress, checkpoint, activities }) {
  // Capabilities intentionally exclude sending. A partial failure throws before
  // the checkpoint. The caller must persist unhealthy against the OLD cursor.
  for (const item of plan.suppressions) await suppress(item);
  if (appendEvents && plan.events.length) {
    await appendEvents(plan.events);
    activities.push(...plan.events);
  } else {
    for (const event of plan.events) {
      await appendEvent(event);
      activities.push(event);
    }
  }
  await checkpoint(observation);
  return { persisted: plan.events.length, suppressed: plan.suppressions.length };
}

module.exports = { planMailboxEvents, commitObservation, humanReplyText, ownReplyText, HUMAN_REPLY_TEXT_LIMIT, SENDER_AUTH_FAILURE_EVENT };
