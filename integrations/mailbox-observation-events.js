'use strict';

// Observation has no sender, stage writer, enrollment capability or model API.
// Canonical evidence is committed before any subsequent automation evaluation.
const { headerValue, parseAddr, firstPlainText, decodeBodies, matchMailboxMessages, providerRead } = require('./gmail-mailbox-observer');
const { classifyReplyText } = require('./canonical-reply');
const { uniqueSuppressions, suppressionForCanonical, inboundAlreadyEvaluated } = require('./inbound-reply-guard');
const { eventTypeFor, stripQuotedReply } = require('./reply-reconciliation');
const { planOutboundActivity } = require('./human-outbound');
const norm = value => String(value || '').trim().toLowerCase();
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
      if (mine.some(row => meta(row).gmailMessageId === message.id)) continue;
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
      if (plan.activity) add({ ...plan.activity, metadata: JSON.stringify({ ...plan.activity.metadata,
        senderInboxId, rfcMessageId, recoveredDuringOutage: observation.recovered }) });
      else ignored.push({ id: message.id, reason: plan.outcome });
      continue;
    }
    const matched = matchMailboxMessages([message], { leads: matchLeads, activities, senderInboxId, senderEmail });
    if (!matched.replies.size && !matched.bounces.size) { ignored.push({ id: message.id, reason: 'unmatched_or_irrelevant' }); continue; }
    for (const [leadId] of matched.bounces) {
      const lead = byId.get(String(leadId));
      const eventId = `gmail-bounce:${senderInboxId}:${message.id}:${leadId}`;
      suppressions.push({ email: lead.email, reason: 'bounce', company: lead.company });
      add({ eventId, leadId: `CE-${lead.id}`, sourceLeadId: lead.id, email: lead.email, company: lead.company,
        eventType: 'email_bounced', occurredAt, content: '', subject: headerValue(message.payload, 'Subject'),
        metadata: JSON.stringify({ provider: 'gmail', gmailMessageId: message.id, gmailThreadId: message.threadId,
          senderInboxId, rfcMessageId, recoveredDuringOutage: observation.recovered, autoSendAllowed: false }) });
    }
    for (const [leadId] of matched.replies) {
      const lead = byId.get(String(leadId));
      const text = stripQuotedReply(firstPlainText(message.payload) || decodeBodies(message.payload) || message.snippet || '');
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
      if ((!already && !evaluated) || terminal) {
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

module.exports = { planMailboxEvents, commitObservation };
