'use strict';

const DAEMON_FROM = /mailer-daemon|postmaster/i;
const AUTOMATED_FROM = /mailer-daemon|postmaster|no-?reply|do-?not-?reply/i;
const PERMANENT_FAILURE = /permanent|address not found|no such (?:user|mailbox|address|recipient)|user unknown|does(?: not|n['’]?t) exist|mailbox (?:full|unavailable|is full)|recipient (?:rejected|not found|address rejected)|account (?:has been )?(?:disabled|closed|suspended)|\b55[013456]\b|\b5\.\d\.\d\b/i;
const TRANSIENT_FAILURE = /delivery (?:is )?incomplete|will (?:retry|keep trying|try again)|temporar(?:y|ily)|being delayed|greylist|\b4\.\d\.\d\b/i;

const norm = value => String(value || '').trim().toLowerCase();

function headerValue(payload, name) {
  const wanted = norm(name);
  return (payload?.headers || []).find(item => norm(item.name) === wanted)?.value || '';
}

function parseAddr(value) {
  const match = /<([^>]+)>/.exec(value || '');
  return norm(match ? match[1] : value);
}

function decodeBodies(payload) {
  const chunks = [];
  const walk = part => {
    if (!part) return;
    for (const child of part.parts || []) walk(child);
    if (part.body?.data && (!part.mimeType || part.mimeType.startsWith('text/') || part.mimeType.startsWith('message/'))) {
      chunks.push(Buffer.from(part.body.data, 'base64url').toString('utf8'));
    }
  };
  walk(payload);
  return chunks.join('\n');
}

function firstPlainText(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }
  for (const child of payload.parts || []) {
    const text = firstPlainText(child);
    if (text) return text;
  }
  if (!payload.mimeType && payload.body?.data) return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  return '';
}

function candidateIndexes(leads, activities, senderInboxId) {
  const byEmail = new Map();
  const byThread = new Map();
  for (const lead of leads || []) {
    const email = norm(lead.email);
    if (!email) continue;
    const rows = byEmail.get(email) || [];
    rows.push(lead);
    byEmail.set(email, rows);
  }
  for (const row of activities || []) {
    let metadata;
    try { metadata = JSON.parse(row.metadata || '{}'); } catch (_) { continue; }
    if (norm(metadata.senderInboxId || 'primary') !== norm(senderInboxId)) continue;
    const threadId = String(metadata.gmailThreadId || '').trim();
    const sourceLeadId = String(row.sourceLeadId || '').trim() || String(row.leadId || '').replace(/^CE-/, '');
    const lead = (leads || []).find(item => String(item.id) === sourceLeadId);
    if (threadId && lead && !byThread.has(threadId)) byThread.set(threadId, lead);
  }
  return { byEmail, byThread };
}

function matchMailboxMessages(messages, { leads = [], activities = [], senderInboxId, senderEmail }) {
  const { byEmail, byThread } = candidateIndexes(leads, activities, senderInboxId);
  const replies = new Map();
  const bounces = new Map();
  for (const message of messages || []) {
    if ((message.labelIds || []).includes('SENT')) continue;
    const fromAddr = parseAddr(headerValue(message.payload, 'From'));
    if (!fromAddr || fromAddr === norm(senderEmail)) continue;
    const occurredMs = Number(message.internalDate || 0);
    const allText = decodeBodies(message.payload);
    if (DAEMON_FROM.test(fromAddr)) {
      for (const lead of leads) {
        const email = norm(lead.email);
        const afterMs = Date.parse(lead.lastEmailedAt || '');
        if (!email || !Number.isFinite(afterMs) || occurredMs <= afterMs || !allText.toLowerCase().includes(email)) continue;
        if (TRANSIENT_FAILURE.test(allText) && !PERMANENT_FAILURE.test(allText)) continue;
        if (PERMANENT_FAILURE.test(allText)) bounces.set(lead.id, message);
      }
      continue;
    }
    if (AUTOMATED_FROM.test(fromAddr)) continue;
    const direct = byEmail.get(fromAddr) || [];
    const lead = byThread.get(message.threadId) || (direct.length === 1 ? direct[0] : null);
    if (!lead) continue;
    const afterMs = Date.parse(lead.lastEmailedAt || '');
    if (!Number.isFinite(afterMs) || occurredMs <= afterMs) continue;
    const prior = replies.get(lead.id);
    if (!prior || Number(prior.internalDate || 0) < occurredMs) replies.set(lead.id, message);
  }
  return { replies, bounces };
}

async function listChangedIds(gmail, { historyId, lookbackDays = 7, maxPages = 10 } = {}) {
  const ids = new Set();
  let pageToken;
  let pages = 0;
  let nextHistoryId = historyId || null;
  if (historyId) {
    do {
      const response = await gmail.users.history.list({ userId: 'me', startHistoryId: historyId,
        historyTypes: ['messageAdded'], maxResults: 500, pageToken });
      nextHistoryId = response.data.historyId || nextHistoryId;
      for (const history of response.data.history || []) {
        for (const added of history.messagesAdded || []) if (added.message?.id) ids.add(added.message.id);
      }
      pageToken = response.data.nextPageToken;
      pages += 1;
    } while (pageToken && pages < maxPages);
    if (pageToken) throw new Error(`Gmail History exceeded the ${maxPages}-page safety bound; checkpoint was not advanced`);
    return { ids: [...ids], nextHistoryId, mode: 'history', pages };
  }
  // Safe bootstrap establishes "from now onward" and deliberately returns no
  // messages. Replaying even a seven-day lookback could mutate or answer a
  // historical conversation merely because this code was deployed.
  const profile = await gmail.users.getProfile({ userId: 'me' });
  return { ids: [], nextHistoryId: profile.data.historyId || null, mode: 'bootstrap', pages: 0 };
}

async function observeMailbox({ gmail, leads, activities, senderInboxId, senderEmail, historyId = null,
  lookbackDays = 7, maxPages = 10 }) {
  let listed;
  try {
    listed = await listChangedIds(gmail, { historyId, lookbackDays, maxPages });
  } catch (error) {
    if (!historyId || Number(error?.response?.status || error?.code) !== 404) throw error;
    listed = await listChangedIds(gmail, { historyId: null, lookbackDays, maxPages });
    listed.mode = 'bootstrap_after_stale_history';
  }
  const messages = [];
  for (const id of listed.ids) {
    const response = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    messages.push(response.data);
  }
  return { ...listed, messagesInspected: messages.length,
    ...matchMailboxMessages(messages, { leads, activities, senderInboxId, senderEmail }) };
}

module.exports = { headerValue, parseAddr, decodeBodies, firstPlainText, matchMailboxMessages,
  listChangedIds, observeMailbox };
