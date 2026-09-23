'use strict';

const {
  providerRead, isRateLimited, statusOf, persistedGmailMessageIds,
  getMailboxBackoff, signalMailboxBackoff, QUOTA_RETRY_DELAYS_MS,
} = require('./gmail-api-guard');

const DAEMON_FROM = /mailer-daemon|postmaster/i;
const AUTOMATED_FROM = /mailer-daemon|postmaster|no-?reply|do-?not-?reply/i;
const PERMANENT_FAILURE = /permanent|address not found|no such (?:user|mailbox|address|recipient)|user unknown|does(?: not|n['’]?t) exist|mailbox (?:full|unavailable|is full)|recipient (?:rejected|not found|address rejected)|account (?:has been )?(?:disabled|closed|suspended)|\b55[013456]\b|\b5\.\d\.\d\b/i;
const TRANSIENT_FAILURE = /delivery (?:is )?incomplete|will (?:retry|keep trying|try again)|temporar(?:y|ily)|being delayed|greylist|\b4\.\d\.\d\b/i;

const norm = value => String(value || '').trim().toLowerCase();
const OVERLAP_MS = 5 * 60 * 1000;
const STALE_MS = 90 * 60 * 1000;

function headerValue(payload, name) {
  const wanted = norm(name);
  return (payload?.headers || []).find(item => norm(item.name) === wanted)?.value || '';
}

function parseAddr(value) {
  const match = /<([^>]+)>/.exec(value || '');
  return norm(match ? match[1] : value);
}

const EMAIL_TOKEN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

function extractedEmails(text) {
  const found = new Set();
  String(text || '').replace(EMAIL_TOKEN, match => {
    found.add(norm(match));
    return match;
  });
  return found;
}

function bounceMentionsRecipient(text, email) {
  const wanted = norm(email);
  if (!wanted) return false;
  return extractedEmails(text).has(wanted);
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
        if (!email || !Number.isFinite(afterMs) || occurredMs <= afterMs || !bounceMentionsRecipient(allText, email)) continue;
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

async function listChangedIds(gmail, { historyId, maxPages = 20, readOpts } = {}) {
  const ids = new Set();
  const stubs = new Map();
  let pageToken;
  let pages = 0;
  // Do NOT adopt Gmail's latest historyId until every page of this window has
  // been read. A partial listing that stored HEAD would permanently skip the
  // unread pages — including after a 403 quota error.
  let nextHistoryId = historyId || null;
  if (historyId) {
    do {
      const response = await providerRead('users.history.list', { userId: 'me', startHistoryId: historyId,
        maxResults: 500, pageToken, historyTypes: ['messageAdded'] }, params => gmail.users.history.list(params), readOpts);
      for (const history of response.data.history || []) {
        for (const change of history.messagesAdded || []) {
          if (change.message?.id) { ids.add(change.message.id); stubs.set(change.message.id, change.message); }
        }
      }
      pageToken = response.data.nextPageToken;
      pages += 1;
      if (!pageToken) nextHistoryId = response.data.historyId || nextHistoryId;
    } while (pageToken && pages < maxPages);
    if (pageToken) throw new Error(`Gmail History exceeded the ${maxPages}-page safety bound; checkpoint was not advanced`);
    return { ids: [...ids], stubs, nextHistoryId, mode: 'history', pages };
  }
  // Safe bootstrap establishes "from now onward" and deliberately returns no
  // messages. Replaying even a seven-day lookback could mutate or answer a
  // historical conversation merely because this code was deployed.
  const profile = await providerRead('users.getProfile', { userId: 'me' }, params => gmail.users.getProfile(params), readOpts);
  return { ids: [], nextHistoryId: profile.data.historyId || null, mode: 'bootstrap', pages: 0 };
}

async function listCatchup(gmail, { lastSuccessfulObservationAt, maxPages = 20, senderEmail, log = () => {}, readOpts } = {}) {
  const since = Date.parse(lastSuccessfulObservationAt || '');
  if (!Number.isFinite(since)) throw new Error('Mailbox recovery requires persisted lastSuccessfulObservationAt; checkpoint was not advanced');
  // Anchor BEFORE the search. Changes during pagination (including imported old
  // messages) are covered by the History bridge and subsequent incremental run.
  const profile = await providerRead('users.getProfile', { userId: 'me' }, params => gmail.users.getProfile(params), readOpts);
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
      includeSpamTrash: true, maxResults: 500, pageToken }, params => gmail.users.messages.list(params), readOpts);
    for (const stub of response.data.messages || []) stubs.set(stub.id, stub);
    pageToken = response.data.nextPageToken; pages++;
  } while (pageToken && pages < maxPages);
  if (pageToken) throw new Error('Mailbox catch-up exceeded page safety bound; checkpoint was not advanced');
  const bridge = await listChangedIds(gmail, { historyId: anchor, maxPages, readOpts });
  for (const [id, stub] of bridge.stubs) stubs.set(id, stub);
  return { ids: [...stubs.keys()], stubs, nextHistoryId: bridge.nextHistoryId,
    mode: 'catchup', pages: pages + bridge.pages, from, anchor };
}

// How many Gmail message reads one recovery pass may spend. The livelock this
// bounds: a 45-hour backlog needs more `users.messages.get` calls than Gmail's
// per-user-per-minute cost budget allows, so the pass died, the checkpoint
// never advanced, and the next pass re-ran the identical oversized scan.
//
// Deliberately well under the ceiling rather than as large as possible, because
// the observer shares that quota with the reply and outbound passes running in
// the same minute. Recovery taking several scheduled passes is the intended
// trade: correctness first, drained-instantly second.
const RECOVERY_READ_BUDGET = Number(process.env.GMAIL_RECOVERY_READ_BUDGET || 120);

// Gmail message ids are hex and increase over time, so ascending id order is a
// deterministic total order over the same catch-up query. That is what makes a
// high-water mark meaningful: "everything at or below this id is proven", and a
// later pass resumes strictly above it. Re-processing is harmless (canonical
// event ids are idempotent); skipping is not, which is why the order must not
// depend on Gmail's own paging order.
const byIdAscending = (a, b) => (String(a).length - String(b).length) || String(a).localeCompare(String(b));

async function observeMailbox({ gmail, leads = [], activities = [], senderInboxId, senderEmail, historyId = null,
  lastSuccessfulObservationAt = null, previousHealth = null, maxPages = 20, now = new Date(), log = () => {},
  recovery = null, readBudget = RECOVERY_READ_BUDGET, sleep = undefined, knownMessageIds = null }) {
  // Injectable so tests exercise the real retry path without wall-clock waits.
  const readOpts = {
    mailboxId: senderInboxId, feature: 'gmail_history_observer',
    ...(sleep ? { sleep, jitter: false } : {}),
  };
  const knownIds = knownMessageIds instanceof Set ? knownMessageIds : persistedGmailMessageIds(activities);
  let listed;
  // Catch-up is ONLY for an invalid/expired History cursor, or a recovery already
  // in flight. Quota 403 and a stale checkpoint with a still-valid historyId must
  // retry incrementally — a broad rescan is what exhausted the per-user minute.
  void previousHealth;
  let recovered = false;
  try {
    listed = await listChangedIds(gmail, { historyId, maxPages, readOpts });
  } catch (error) {
    if (isRateLimited(error)) {
      const backoff = getMailboxBackoff(senderInboxId, now) || signalMailboxBackoff(senderInboxId, error, { now });
      log('gmail_quota_backoff', { historyId, until: backoff?.until, ...error.observerDetails });
      throw error;
    }
    if (!historyId || statusOf(error) !== 404 || error.observerDetails?.action !== 'users.history.list') throw error;
    log('history_cursor_invalid', { historyId, ...error.observerDetails });
    recovered = true;
    listed = { ids: [], stubs: new Map() };
  }
  // A recovery already in flight keeps its ORIGINAL source timestamp and target
  // anchor. Re-deriving them each pass would move the goalposts and could skip
  // mail that arrived between passes.
  const resuming = Boolean(recovery && recovery.active && recovery.since);
  if (resuming) recovered = true;
  let recoveryState = resuming
    ? { active: true, since: recovery.since, anchor: recovery.anchor || null,
        processedThroughId: recovery.processedThroughId || null, processed: Number(recovery.processed || 0) }
    : null;

  if (recovered) {
    try {
      const catchup = await listCatchup(gmail, {
        lastSuccessfulObservationAt: resuming ? recoveryState.since : lastSuccessfulObservationAt,
        maxPages, senderEmail, log, readOpts,
      });
      for (const [id, stub] of listed.stubs || []) if (!catchup.stubs.has(id)) catchup.stubs.set(id, stub);
      listed = { ...catchup, ids: [...catchup.stubs.keys()] };
      if (!recoveryState) {
        recoveryState = { active: true, since: catchup.from, anchor: catchup.anchor,
          processedThroughId: null, processed: 0 };
        log('mailbox_recovery_started', { since: catchup.from, anchor: catchup.anchor, discovered: listed.ids.length });
      } else {
        // Keep the ORIGINAL anchor: it is the head this recovery is racing to.
        recoveryState.anchor = recoveryState.anchor || catchup.anchor;
        log('mailbox_recovery_resumed', { since: recoveryState.since, anchor: recoveryState.anchor,
          processedThroughId: recoveryState.processedThroughId, discovered: listed.ids.length });
      }
    } catch (error) { log('mailbox_catchup_failed', { message: error.message, ...error.observerDetails }); throw error; }
  }

  // Ordered so a high-water is meaningful, and resumed strictly above it.
  let queue = [...listed.ids].sort(byIdAscending);
  const remainingBefore = recoveryState && recoveryState.processedThroughId
    ? queue.filter(id => byIdAscending(id, recoveryState.processedThroughId) > 0)
    : queue;
  if (recoveryState) queue = remainingBefore;

  // Bounded ONLY while recovering. A healthy incremental pass is small by
  // definition and must not be truncated, or steady-state mail would stall.
  const budget = recoveryState ? Math.max(1, Number(readBudget) || 1) : queue.length;
  const slice = queue.slice(0, budget);
  const sliceTruncated = Boolean(recoveryState) && queue.length > slice.length;

  const messages = [];
  const unavailable = [];
  // The high-water only moves across ids this pass genuinely resolved — fetched,
  // already persisted, or explicitly represented as a provider gap. It is a
  // PROPOSAL: the caller persists it only after the canonical events commit.
  let provenThroughId = recoveryState ? recoveryState.processedThroughId : null;
  let quotaBackoff = null;
  let messagesFetched = 0;
  let messagesDeduplicated = 0;
  // One thread recovery per thread per pass. Every vanished message in a thread
  // recovers the same thread, and refetching it per message turned a handful of
  // deleted messages into a full-thread read storm that exhausted the per-user
  // Gmail quota on every pass, so the mailbox could never advance its cursor.
  const recoveredThreads = new Map();
  for (const id of slice) {
    if (knownIds.has(id)) {
      messagesDeduplicated += 1;
      provenThroughId = id;
      continue;
    }
    try {
      const response = await providerRead('users.messages.get', { userId: 'me', id, format: 'full' }, params => gmail.users.messages.get(params), readOpts);
      messages.push(response.data);
      messagesFetched += 1;
    } catch (error) {
      // Quota is not a mailbox failure and must not discard proven progress.
      // Stop issuing reads, keep what is proven, and let the caller bank it.
      if (isRateLimited(error)) {
        const signaled = getMailboxBackoff(senderInboxId, now) || signalMailboxBackoff(senderInboxId, error, { now });
        quotaBackoff = { reason: 'gmail_quota', at: new Date(now).toISOString(),
          until: signaled?.until || '', message: String(error.message || '').slice(0, 200) };
        log('gmail_quota_backoff', { processedThroughId: provenThroughId,
          remaining: queue.length - messages.length, until: quotaBackoff.until, recovery: Boolean(recoveryState) });
        // The failed id is NOT proven. Recovery resumes strictly above the last
        // proven id; incremental history keeps the START cursor so the unread
        // window is retried. Never adopt Gmail's HEAD after a quota stop.
        break;
      }
      if (statusOf(error) !== 404) throw error;
      const threadId = listed.stubs?.get(id)?.threadId;
      // A vanished resource is NOT an expired cursor. Preserve the provider
      // tombstone and attempt thread recovery; never report it as zero events.
      let threadRecovered = false;
      if (threadId && recoveredThreads.has(threadId)) {
        threadRecovered = recoveredThreads.get(threadId);
      } else if (threadId) {
        try {
          const thread = await providerRead('users.threads.get', { userId: 'me', id: threadId, format: 'full' }, params => gmail.users.threads.get(params), readOpts);
          messages.push(...thread.data.messages || []); threadRecovered = true;
        } catch (threadError) { if (statusOf(threadError) !== 404) throw threadError; }
        recoveredThreads.set(threadId, threadRecovered);
      }
      unavailable.push({ id, threadId: threadId || '', status: 404, threadRecovered,
        classification: 'provider_resource_unavailable', contentRecoverable: false });
      log('mailbox_resource_unavailable', { id, threadId, threadRecovered });
    }
    // Resolved either way: fetched, or recorded as a gap. A missing resource is
    // proven-handled, which is what stops it being retried forever.
    provenThroughId = id;
  }
  const unique = [...new Map(messages.map(message => [message.id, message])).values()];

  let recoveryResult = null;
  if (recoveryState) {
    const stopped = sliceTruncated || Boolean(quotaBackoff);
    const processed = recoveryState.processed + slice.length - (quotaBackoff ? slice.length - messages.length - unavailable.length : 0);
    recoveryResult = {
      ...recoveryState, processedThroughId: provenThroughId, processed,
      // Complete only when the queue is exhausted with no forced stop. The
      // caller then closes the race against `anchor` and returns to History.
      complete: !stopped,
      backoff: quotaBackoff,
      remaining: Math.max(0, queue.length - slice.length) + (quotaBackoff ? slice.length - (messages.length + unavailable.length) : 0),
    };
    log(recoveryResult.complete ? 'mailbox_recovery_caught_up' : 'mailbox_recovery_slice_completed',
      { processedThroughId: provenThroughId, processed, remaining: recoveryResult.remaining,
        backoff: Boolean(quotaBackoff) });
  }

  // Incremental quota is the same contract as recovery: keep what is proven,
  // do not adopt HEAD, mark the run incomplete so the next pass retries the
  // unresolved window from the last persisted cursor.
  const historyIncomplete = Boolean(quotaBackoff) && !recoveryState;
  const trustworthy = !historyIncomplete && (!recoveryResult || recoveryResult.complete);

  return { ...listed,
    nextHistoryId: historyIncomplete ? (historyId || listed.nextHistoryId) : listed.nextHistoryId,
    recovered: Boolean(recovered), messages: unique, unavailable,
    messagesInspected: unique.length, discoveredCount: listed.ids.length,
    messagesFetched, messagesDeduplicated,
    recovery: recoveryResult, historyIncomplete, quotaBackoff,
    observerHealth: !trustworthy ? (quotaBackoff ? 'unhealthy_quota' : 'unhealthy_incomplete') : 'healthy',
    // While a recovery is still in flight — or an incremental history read was
    // cut short by quota — the mailbox has NOT reached a trustworthy point.
    trustworthy,
    ...matchMailboxMessages(unique, { leads, activities, senderInboxId, senderEmail }) };
}

module.exports = { headerValue, parseAddr, decodeBodies, firstPlainText, matchMailboxMessages,
  bounceMentionsRecipient, extractedEmails, listChangedIds, listCatchup, observeMailbox, providerRead, isRateLimited,
  OVERLAP_MS, STALE_MS, RECOVERY_READ_BUDGET, byIdAscending, persistedGmailMessageIds };
