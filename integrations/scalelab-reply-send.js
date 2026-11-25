'use strict';
// Reply screen actions: Send, Save to Gmail drafts, Dismiss. Owner-initiated
// only; nothing here runs on a timer. Send goes through the final gate
// (purpose human_reply), a durable reservation, same inbox and same Gmail
// thread, and never resends on an uncertain outcome. All I/O is injected.
const { evaluateFreshSendSafety } = require('./send-safety-revalidate');
const { hasPlaceholder, replyHeaders, buildReplyRaw } = require('./scalelab-fast-reply');
const { outboundEventId } = require('./human-outbound');

const refused = (code, reason) => ({ ok: false, code, reason: reason || code });
const headerOf = (message, name) => (message?.payload?.headers || []).find(h => String(h.name).toLowerCase() === name.toLowerCase())?.value || '';

/** The inbound message must still be the newest in the thread, and its headers give the threading chain. */
async function threadContext(gmail, row) {
  const thread = (await gmail.users.threads.get({ userId: 'me', id: row.thread_id, format: 'metadata',
    metadataHeaders: ['Message-ID', 'References', 'Subject', 'From', 'To'] })).data;
  const messages = [...(thread.messages || [])].sort((a, b) => Number(a.internalDate || 0) - Number(b.internalDate || 0));
  const inbound = messages.find(m => m.id === row.message_id);
  if (!inbound) return refused('inbound_not_in_thread', 'the prospect message is no longer in this Gmail thread');
  const latest = messages[messages.length - 1];
  if (latest.id !== inbound.id) return refused('newer_thread_activity', 'a newer message arrived in this thread; reload before sending');
  const headers = replyHeaders({ inboundMessageId: headerOf(inbound, 'Message-ID'), references: headerOf(inbound, 'References') });
  return { ok: true, subject: headerOf(inbound, 'Subject'), ...headers };
}

/**
 * deps: { store, readLead(leadId) -> { lead, current, suppressedEmails }, sender, gmail,
 *   withGmailProviderSend, confirmReservation, ownership(lead, sender), recordActivity(event),
 *   ensureHold(lead), env, now }
 */
async function sendFromReplyScreen({ actionId, draftText, deps }) {
  const { store, sender, gmail } = deps;
  const text = String(draftText || '').replace(/\r/g, '').trim();
  if (!text) return refused('empty_draft');
  if (hasPlaceholder(text)) return refused('placeholder_present', 'replace every [FILL: ...] before sending');
  const row = await store.get(actionId);
  if (!row || row.status !== 'pending') return refused('not_pending', 'this reply is no longer pending');
  if (!sender || sender.id !== row.mailbox_id) return refused('sender_unavailable', 'the original inbox is not available');

  const fresh = await deps.readLead(row.lead_id);
  if (!fresh?.current || fresh.current.id !== row.lead_id) return refused('identity_changed', 'lead not found');
  const gate = evaluateFreshSendSafety(fresh.lead || fresh.current, fresh.current, fresh.suppressedEmails || new Set(),
    { purpose: 'human_reply', senderInboxId: sender.id, env: deps.env || process.env });
  if (!gate.allowed) return refused(gate.code, gate.reason);

  const ctx = await threadContext(gmail, row);
  if (!ctx.ok) return ctx;
  const raw = buildReplyRaw({ fromEmail: sender.email, fromName: sender.fromName || '', to: fresh.current.email,
    subject: ctx.subject, body: text, inReplyTo: ctx.inReplyTo, references: ctx.references });

  const claimed = await store.transition(actionId, { status: 'pending' }, { status: 'sending', draft_text: text });
  if (!claimed) return refused('not_pending', 'another send is already in progress');
  const sendAction = { actionId: `human-reply:${actionId}`, leadId: row.lead_id, actionType: 'gmail_human_reply',
    provider: 'gmail', ownership: deps.ownership(fresh.current, sender) };
  let result;
  try {
    result = await deps.withGmailProviderSend({ lead: fresh.current, sender, sendAction,
      run: () => gmail.users.messages.send({ userId: 'me', requestBody: { raw, threadId: row.thread_id } }) });
  } catch (error) {
    const status = Number(error.code || error.status || error.response?.status);
    if (error.code === 'send_lock_reserved' || error.existing) {
      return refused('already_reserved', 'a send for this reply already exists; check the Gmail thread');
    }
    if (status >= 400 && status < 500) {
      // Definite refusal before delivery: back to pending so the owner can retry.
      await store.transition(actionId, { status: 'sending' }, { status: 'pending' }).catch(() => null);
      return refused('provider_rejected', `Gmail refused the send (${status})`);
    }
    // Uncertain: never resend automatically. The row stays 'sending' for review.
    return refused('outcome_uncertain', 'the send outcome is uncertain; check the Gmail thread before trying again');
  }
  const data = result?.data || result || {};
  await deps.confirmReservation(sendAction.actionId).catch(() => null);
  const now = (deps.now || (() => new Date()))().toISOString();
  await store.transition(actionId, { status: 'sending' }, { status: 'sent', sent_message_id: data.id || null, handled_at: now });
  await deps.recordActivity({ eventId: outboundEventId(data.id), leadId: `CE-${row.lead_id}`, sourceLeadId: row.lead_id,
    email: fresh.current.email, company: fresh.current.company || '', eventType: 'human_response_sent', occurredAt: now,
    subject: ctx.subject, content: '', metadata: JSON.stringify({ provider: 'gmail', direction: 'outbound', actor: 'human',
      trigger: 'reply_screen', gmailMessageId: data.id || null, gmailThreadId: data.threadId || row.thread_id,
      senderInboxId: sender.id, replyActionId: actionId, inboundMessageId: row.message_id }) });
  await deps.ensureHold(fresh.current);
  return { ok: true, gmailMessageId: data.id || null };
}

/** Save the (possibly edited) draft into Gmail drafts in the same thread. Nothing is sent. */
async function saveToGmailDrafts({ actionId, draftText, deps }) {
  const { store, sender, gmail } = deps;
  const text = String(draftText || '').replace(/\r/g, '').trim();
  if (!text) return refused('empty_draft');
  const row = await store.get(actionId);
  if (!row || row.status !== 'pending') return refused('not_pending', 'this reply is no longer pending');
  if (!sender || sender.id !== row.mailbox_id) return refused('sender_unavailable', 'the original inbox is not available');
  const fresh = await deps.readLead(row.lead_id);
  if (!fresh?.current) return refused('identity_changed', 'lead not found');
  const ctx = await threadContext(gmail, row);
  if (!ctx.ok) return ctx;
  const raw = buildReplyRaw({ fromEmail: sender.email, fromName: sender.fromName || '', to: fresh.current.email,
    subject: ctx.subject, body: text, inReplyTo: ctx.inReplyTo, references: ctx.references });
  const response = await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw, threadId: row.thread_id } } });
  const now = (deps.now || (() => new Date()))().toISOString();
  await store.transition(actionId, { status: 'pending' }, { status: 'gmail_draft', draft_text: text, handled_at: now,
    gmail_draft_id: response?.data?.id || null });
  return { ok: true, gmailDraftId: response?.data?.id || null };
}

async function dismissReply({ actionId, deps }) {
  const row = await deps.store.transition(actionId, { status: 'pending' }, { status: 'dismissed',
    handled_at: (deps.now || (() => new Date()))().toISOString() });
  return row ? { ok: true } : refused('not_pending', 'this reply is no longer pending');
}

async function saveDraftText({ actionId, draftText, deps }) {
  const row = await deps.store.transition(actionId, { status: 'pending' }, { draft_text: String(draftText || '').slice(0, 8000),
    draft_source: 'owner_edit', draft_updated_at: (deps.now || (() => new Date()))().toISOString() });
  return row ? { ok: true } : refused('not_pending', 'this reply is no longer pending');
}

module.exports = { threadContext, sendFromReplyScreen, saveToGmailDrafts, dismissReply, saveDraftText };
