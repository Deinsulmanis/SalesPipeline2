'use strict';

const DAEMON_FROM = /mailer-daemon|postmaster/i;
const AUTOMATED_FROM = /mailer-daemon|postmaster|no-?reply|do-?not-?reply/i;
const PERMANENT_FAILURE = /permanent|address not found|no such (?:user|mailbox|address|recipient)|user unknown|does(?: not|n['’]?t) exist|mailbox (?:full|unavailable|is full)|recipient (?:rejected|not found|address rejected)|account (?:has been )?(?:disabled|closed|suspended)|\b55[013456]\b|\b5\.\d\.\d\b/i;
const TRANSIENT_FAILURE = /delivery (?:is )?incomplete|will (?:retry|keep trying|try again)|temporar(?:y|ily)|being delayed|greylist|\b4\.\d\.\d\b/i;

const norm = value => String(value || '').trim().toLowerCase();
const OVERLAP_MS = 5 * 60 * 1000;
const STALE_MS = 90 * 60 * 1000;
const statusOf = error => Number(error?.response?.status || error?.code);

// Gmail rate-limits per user per minute and answers 429, or 403 with a quota
// reason. Neither says anything is wrong with the mailbox — they say "slow
// down" — so treating them as failures is what stranded the primary observer:
// a stale checkpoint means a large catch-up, a large catch-up trips the
// per-minute ceiling, the whole observation throws, the checkpoint stays put,
// and the next pass re-runs the same oversized scan into the same wall. The
// backlog could never drain.
//
// Bounded on purpose. Four attempts with exponential backoff is enough to ride
// out a per-minute ceiling; anything longer would hold a pass open indefinitely
// and turn one degraded mailbox into a stuck process.
const QUOTA_RETRY_DELAYS_MS = Object.freeze([1000, 4000, 12000]);
const isRateLimited = error => {
  const status = statusOf(error);
  if (status === 429) return true;
  // 403 is overloaded: quota exhaustion is retryable, a permissions problem is
  // not, and retrying the latter would be pointless traffic against a mailbox
  // that will never answer.
  return status === 403 && /quota|rate limit|user rate/i.test(String(error?.message || ''));
};

async function providerRead(action, params, read, { sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await read(params); }
    catch (error) {
      if (isRateLimited(error) && attempt < QUOTA_RETRY_DELAYS_MS.length) {
        await sleep(QUOTA_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      // Deliberately omit the request object: googleapis attaches OAuth headers.
      error.observerDetails = {
        action, params, status: statusOf(error), message: error.message,
        rateLimited: isRateLimited(error), attempts: attempt + 1,
      };
      throw error;
    }
  }
}

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
  const byId = new Map((leads || []).map(lead => [String(lead.id), lead]));
  const conflicts = new Set();
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
    if (norm(metadata.senderInboxId) !== norm(senderInboxId)) continue;
    const threadId = String(metadata.gmailThreadId || '').trim();
    const sourceLeadId = String(row.sourceLeadId || '').trim() || String(row.leadId || '').replace(/^CE-/, '');
    const lead = byId.get(sourceLeadId);
    if (threadId && lead) {
      if (byThread.has(threadId) && byThread.get(threadId).id !== lead.id) conflicts.add(threadId);
      else byThread.set(threadId, lead);
    }
  }
  for (const threadId of conflicts) byThread.delete(threadId);
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
    const direct = byEmail.get(fromAddr) || [];
    if (direct.length > 1) throw new Error(`Ambiguous inbound CRM identity for Gmail message ${message.id}`);
    if (byThread.has(message.threadId) && direct.length === 1 && byThread.get(message.threadId).id !== direct[0].id) {
      throw new Error(`Conflicting inbound CRM thread for Gmail message ${message.id}`);
    }
    if (AUTOMATED_FROM.test(fromAddr) && !direct.length && !byThread.has(message.threadId)) continue;
    const lead = byThread.get(message.threadId) || (direct.length === 1 ? direct[0] : null);
    if (!lead) continue;
    const afterMs = Date.parse(lead.lastEmailedAt || '');
    if (!Number.isFinite(afterMs) || occurredMs <= afterMs) continue;
    const prior = replies.get(lead.id);
    if (!prior || Number(prior.internalDate || 0) < occurredMs) replies.set(lead.id, message);
  }
  return { replies, bounces };
}

async function listChangedIds(gmail, { historyId, maxPages = 20 } = {}) {
  const ids = new Set();
  const stubs = new Map();
  let pageToken;
  let pages = 0;
  let nextHistoryId = historyId || null;
  if (historyId) {
    do {
      const response = await providerRead('users.history.list', { userId: 'me', startHistoryId: historyId,
        maxResults: 500, pageToken }, params => gmail.users.history.list(params));
      nextHistoryId = response.data.historyId || nextHistoryId;
      for (const history of response.data.history || []) {
        for (const change of [...(history.messagesAdded || []), ...(history.labelsAdded || []), ...(history.labelsRemoved || [])]) {
          if (change.message?.id) { ids.add(change.message.id); stubs.set(change.message.id, change.message); }
        }
      }
      pageToken = response.data.nextPageToken;
      pages += 1;
    } while (pageToken && pages < maxPages);
    if (pageToken) throw new Error(`Gmail History exceeded the ${maxPages}-page safety bound; checkpoint was not advanced`);
    return { ids: [...ids], stubs, nextHistoryId, mode: 'history', pages };
  }
  // Safe bootstrap establishes "from now onward" and deliberately returns no
  // messages. Replaying even a seven-day lookback could mutate or answer a
  // historical conversation merely because this code was deployed.
  const profile = await providerRead('users.getProfile', { userId: 'me' }, params => gmail.users.getProfile(params));
  return { ids: [], nextHistoryId: profile.data.historyId || null, mode: 'bootstrap', pages: 0 };
}

async function listCatchup(gmail, { lastSuccessfulObservationAt, maxPages = 20, senderEmail, log = () => {} }) {
  const since = Date.parse(lastSuccessfulObservationAt || '');
  if (!Number.isFinite(since)) throw new Error('Mailbox recovery requires persisted lastSuccessfulObservationAt; checkpoint was not advanced');
  // Anchor BEFORE the search. Changes during pagination (including imported old
  // messages) are covered by the History bridge and subsequent incremental run.
  const profile = await providerRead('users.getProfile', { userId: 'me' }, params => gmail.users.getProfile(params));
  if (norm(profile.data.emailAddress) !== norm(senderEmail)) throw new Error('Mailbox identity mismatch; checkpoint was not advanced');
  const anchor = profile.data.historyId;
  if (!anchor) throw new Error('Gmail profile has no History cursor');
  const from = new Date(since - OVERLAP_MS).toISOString();
  const q = `after:${Math.floor((since - OVERLAP_MS) / 1000)}`;
  log('mailbox_catchup_started', { from, anchor, q });
  const stubs = new Map();
  let pageToken; let pages = 0;
  do {
    const response = await providerRead('users.messages.list', { userId: 'me', q,
      includeSpamTrash: true, maxResults: 500, pageToken }, params => gmail.users.messages.list(params));
    for (const stub of response.data.messages || []) stubs.set(stub.id, stub);
    pageToken = response.data.nextPageToken; pages++;
  } while (pageToken && pages < maxPages);
  if (pageToken) throw new Error('Mailbox catch-up exceeded page safety bound; checkpoint was not advanced');
  const bridge = await listChangedIds(gmail, { historyId: anchor, maxPages });
  for (const [id, stub] of bridge.stubs) stubs.set(id, stub);
  return { ids: [...stubs.keys()], stubs, nextHistoryId: bridge.nextHistoryId,
    mode: 'catchup', pages: pages + bridge.pages, from, anchor };
}

async function observeMailbox({ gmail, leads = [], activities = [], senderInboxId, senderEmail, historyId = null,
  lastSuccessfulObservationAt = null, previousHealth = null, maxPages = 20, now = new Date(), log = () => {} }) {
  let listed;
  let recovered = previousHealth === 'unavailable' || (lastSuccessfulObservationAt
    && new Date(now).getTime() - Date.parse(lastSuccessfulObservationAt) > STALE_MS);
  try {
    listed = await listChangedIds(gmail, { historyId, maxPages });
  } catch (error) {
    if (!historyId || statusOf(error) !== 404 || error.observerDetails?.action !== 'users.history.list') throw error;
    log('history_cursor_invalid', { historyId, ...error.observerDetails });
    recovered = true;
    listed = { ids: [], stubs: new Map() };
  }
  if (recovered) {
    try {
      const catchup = await listCatchup(gmail, { lastSuccessfulObservationAt, maxPages, senderEmail, log });
      for (const [id, stub] of listed.stubs || []) if (!catchup.stubs.has(id)) catchup.stubs.set(id, stub);
      listed = { ...catchup, ids: [...catchup.stubs.keys()] };
    } catch (error) { log('mailbox_catchup_failed', { message: error.message, ...error.observerDetails }); throw error; }
  }
  const messages = [];
  const unavailable = [];
  for (const id of listed.ids) {
    try {
      const response = await providerRead('users.messages.get', { userId: 'me', id, format: 'full' }, params => gmail.users.messages.get(params));
      messages.push(response.data);
    } catch (error) {
      if (statusOf(error) !== 404) throw error;
      const threadId = listed.stubs?.get(id)?.threadId;
      // A vanished resource is NOT an expired cursor. Preserve the provider
      // tombstone and attempt thread recovery; never report it as zero events.
      let threadRecovered = false;
      if (threadId) {
        try {
          const thread = await providerRead('users.threads.get', { userId: 'me', id: threadId, format: 'full' }, params => gmail.users.threads.get(params));
          messages.push(...thread.data.messages || []); threadRecovered = true;
        } catch (threadError) { if (statusOf(threadError) !== 404) throw threadError; }
      }
      unavailable.push({ id, threadId: threadId || '', status: 404, threadRecovered,
        classification: 'provider_resource_unavailable', contentRecoverable: false });
      log('mailbox_resource_unavailable', { id, threadId, threadRecovered });
    }
  }
  const unique = [...new Map(messages.map(message => [message.id, message])).values()];
  return { ...listed, recovered: Boolean(recovered), messages: unique, unavailable,
    messagesInspected: unique.length, discoveredCount: listed.ids.length,
    ...matchMailboxMessages(unique, { leads, activities, senderInboxId, senderEmail }) };
}

module.exports = { headerValue, parseAddr, decodeBodies, firstPlainText, matchMailboxMessages,
  listChangedIds, listCatchup, observeMailbox, providerRead, OVERLAP_MS, STALE_MS };
