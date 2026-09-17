'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const fs = require('node:fs');

// Official Gmail API quota units:
// https://developers.google.com/workspace/gmail/api/reference/quota
// Per-user-per-project ceiling (projects from May 2026): 6,000 units/minute.
const QUOTA_UNITS = Object.freeze({
  'users.getProfile': 1,
  'users.history.list': 2,
  'users.messages.list': 5,
  'users.messages.get': 20,
  'users.messages.send': 100,
  'users.messages.modify': 5,
  'users.threads.get': 40,
  'users.threads.list': 10,
  'users.labels.list': 1,
  'users.labels.get': 1,
});
const UNITS_PER_MINUTE_PER_USER = 6000;
const USAGE_FILE = process.env.GMAIL_USAGE_FILE || '/tmp/gmail-usage.json';
const MAX_CONCURRENCY_PER_MAILBOX = Math.max(1, Number(process.env.GMAIL_MAILBOX_MAX_CONCURRENCY || 1) || 1);
const QUOTA_RETRY_DELAYS_MS = Object.freeze([1000, 4000, 12000]);
const BACKOFF_CAP_MS = 15 * 60 * 1000;
const OPTIONAL_FEATURES = new Set(['human_outbound', 'late_reply', 'reply_check_legacy', 'reconciliation', 'bounce_check', 'other']);
const REQUIRED_FEATURES = new Set(['gmail_history_observer', 'send_provider']);

const featureStore = new AsyncLocalStorage();
const mailboxStore = new AsyncLocalStorage();

const events = [];
const MAX_EVENTS = 4000;
const backoffByMailbox = new Map();
const chains = new Map();
const inFlight = new Map();
const skippedOptional = [];
const followUpsBlocked = [];

const norm = value => String(value || '').trim().toLowerCase();
const statusOf = error => Number(error?.response?.status || error?.code);
const unitsOf = method => QUOTA_UNITS[method] || 5;

function isRateLimited(error) {
  const status = statusOf(error);
  if (status === 429) return true;
  const reason = String(error?.errors?.[0]?.reason || error?.response?.data?.error?.errors?.[0]?.reason || '');
  const message = String(error?.message || error?.response?.data?.error?.message || '');
  if (status === 403 && /quota|rate limit|user rate|rateLimitExceeded|userRateLimitExceeded/i.test(`${reason} ${message}`)) {
    return true;
  }
  return /rateLimitExceeded|userRateLimitExceeded/i.test(reason);
}

function retryAfterMs(error) {
  const header = error?.response?.headers?.['retry-after'] || error?.response?.headers?.['Retry-After'];
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(BACKOFF_CAP_MS, seconds * 1000);
  return null;
}

function currentFeature() { return featureStore.getStore() || null; }
function currentMailbox() { return mailboxStore.getStore() || null; }
function runWithGmailFeature(feature, fn) { return featureStore.run(feature, fn); }
function runWithGmailMailbox(mailboxId, fn) { return mailboxStore.run(mailboxId, fn); }

function recordEvent(entry) {
  events.push(entry);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  try {
    fs.writeFileSync(USAGE_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), events: events.slice(-1500) }));
  } catch (_) { /* ephemeral observability; never fail a Gmail call for this */ }
}

function recordGmailRequest(partial) {
  const now = partial.at || new Date().toISOString();
  const method = String(partial.method || 'unknown');
  const entry = {
    at: now, mailbox: String(partial.mailbox || currentMailbox() || 'unknown'),
    method, feature: String(partial.feature || currentFeature() || 'other'),
    status: partial.status, latencyMs: Number(partial.latencyMs || 0),
    retryAttempt: Number(partial.retryAttempt || 0),
    rateLimited: Boolean(partial.rateLimited),
    units: unitsOf(method),
    skippedDueToBackoff: Boolean(partial.skippedDueToBackoff),
    messagesDiscovered: Number(partial.messagesDiscovered || 0),
    messagesFetched: Number(partial.messagesFetched || 0),
    messagesDeduplicated: Number(partial.messagesDeduplicated || 0),
  };
  recordEvent(entry);
  return entry;
}

function signalMailboxBackoff(mailboxId, error, { now = new Date(), attempt = 0 } = {}) {
  const id = String(mailboxId || '').trim();
  if (!id) return null;
  const previous = backoffByMailbox.get(id);
  const streak = (previous && Date.parse(previous.until) > now.getTime() ? previous.streak : 0) + 1;
  const retryAfter = retryAfterMs(error);
  const exp = Math.min(BACKOFF_CAP_MS, (30000 * (2 ** Math.min(streak - 1, 6))) + Math.floor(Math.random() * 1000));
  const waitMs = retryAfter != null ? Math.max(retryAfter, 1000) : exp;
  const until = new Date(now.getTime() + waitMs).toISOString();
  const state = {
    mailboxId: id, until, startedAt: new Date(now).toISOString(),
    reason: 'gmail_quota', streak, attempt,
    message: String(error?.message || '').slice(0, 200),
  };
  backoffByMailbox.set(id, state);
  recordEvent({
    at: state.startedAt, mailbox: id, method: 'mailbox.backoff', feature: currentFeature() || 'gmail_history_observer',
    status: statusOf(error) || 403, latencyMs: 0, retryAttempt: attempt, rateLimited: true, units: 0,
  });
  return state;
}

function hydrateMailboxBackoff(mailboxId, until, { now = new Date(), reason = 'gmail_quota' } = {}) {
  const id = String(mailboxId || '').trim();
  const untilMs = Date.parse(until || '');
  if (!id || !Number.isFinite(untilMs) || untilMs <= new Date(now).getTime()) return null;
  const state = { mailboxId: id, until: new Date(untilMs).toISOString(), startedAt: new Date(now).toISOString(), reason, streak: 1, attempt: 0, message: '' };
  backoffByMailbox.set(id, state);
  return state;
}

function getMailboxBackoff(mailboxId, now = new Date()) {
  const state = backoffByMailbox.get(String(mailboxId || '').trim());
  if (!state) return null;
  if (Date.parse(state.until) <= new Date(now).getTime()) {
    backoffByMailbox.delete(String(mailboxId || '').trim());
    return null;
  }
  return state;
}

function clearMailboxBackoff(mailboxId) {
  backoffByMailbox.delete(String(mailboxId || '').trim());
}

function shouldSkipOptionalGmail(mailboxId, feature, now = new Date()) {
  const backoff = getMailboxBackoff(mailboxId, now);
  if (!backoff) return false;
  const name = String(feature || currentFeature() || 'other');
  if (REQUIRED_FEATURES.has(name) && name === 'gmail_history_observer') return false;
  if (REQUIRED_FEATURES.has(name) && name === 'send_provider') return false;
  skippedOptional.push({ at: new Date(now).toISOString(), mailbox: String(mailboxId), feature: name, until: backoff.until });
  return true;
}

function recordFollowUpBlocked(mailboxId, leadId, reason) {
  followUpsBlocked.push({
    at: new Date().toISOString(), mailbox: String(mailboxId || ''), leadId: String(leadId || ''),
    reason: String(reason || 'observer_stale_followup'),
  });
}

function retryDelayMs(attempt, error, { jitter = true } = {}) {
  const retryAfter = retryAfterMs(error);
  if (retryAfter != null) return retryAfter;
  const base = QUOTA_RETRY_DELAYS_MS[Math.min(attempt, QUOTA_RETRY_DELAYS_MS.length - 1)];
  if (!jitter) return base;
  return base + Math.floor(Math.random() * Math.max(250, Math.floor(base * 0.2)));
}

function enqueueMailbox(mailboxId, fn) {
  const id = String(mailboxId || 'unknown');
  const prev = chains.get(id) || Promise.resolve();
  const running = prev.catch(() => {}).then(async () => {
    inFlight.set(id, (inFlight.get(id) || 0) + 1);
    try { return await fn(); }
    finally { inFlight.set(id, Math.max(0, (inFlight.get(id) || 1) - 1)); }
  });
  chains.set(id, running.catch(() => {}));
  return running;
}

async function gmailRequest({
  method, params, send, mailboxId, feature, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  jitter = true, now = new Date(),
} = {}) {
  const mailbox = String(mailboxId || currentMailbox() || 'unknown');
  const feat = String(feature || currentFeature() || 'other');
  const started = Date.now();
  if (OPTIONAL_FEATURES.has(feat) && shouldSkipOptionalGmail(mailbox, feat, now)) {
    const error = new Error(`optional Gmail feature ${feat} skipped — mailbox ${mailbox} is in quota backoff`);
    error.skippedDueToBackoff = true;
    recordGmailRequest({
      mailbox, method, feature: feat, status: 'skipped', latencyMs: 0, retryAttempt: 0,
      rateLimited: false, skippedDueToBackoff: true, at: new Date(now).toISOString(),
    });
    throw error;
  }
  return enqueueMailbox(mailbox, async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await send(params);
        recordGmailRequest({
          mailbox, method, feature: feat, status: 200, latencyMs: Date.now() - started,
          retryAttempt: attempt, rateLimited: false, at: new Date().toISOString(),
        });
        return result;
      } catch (error) {
        if (error?.skippedDueToBackoff) throw error;
        const rateLimited = isRateLimited(error);
        recordGmailRequest({
          mailbox, method, feature: feat, status: statusOf(error) || 'error',
          latencyMs: Date.now() - started, retryAttempt: attempt, rateLimited,
          at: new Date().toISOString(),
        });
        if (rateLimited && attempt < QUOTA_RETRY_DELAYS_MS.length) {
          await sleep(retryDelayMs(attempt, error, { jitter }));
          continue;
        }
        if (rateLimited) signalMailboxBackoff(mailbox, error, { now: new Date(), attempt });
        error.observerDetails = {
          action: method, params, status: statusOf(error), message: error.message,
          rateLimited, attempts: attempt + 1, mailbox, feature: feat,
        };
        throw error;
      }
    }
  });
}

function wrapMethod(target, path, mailboxId, feature) {
  const name = path.split('.').pop();
  const original = target[name];
  if (typeof original !== 'function' || original.__gmailInstrumented) return;
  const wrapped = function wrappedGmailMethod(params) {
    return gmailRequest({
      method: path, params, mailboxId, feature: feature || currentFeature() || 'other',
      send: next => original.call(this, next || params),
    });
  };
  wrapped.__gmailInstrumented = true;
  target[name] = wrapped;
}

function wrapGmail(gmail, { mailboxId, feature } = {}) {
  if (!gmail?.users) return gmail;
  const users = gmail.users;
  wrapMethod(users, 'users.getProfile', mailboxId, feature);
  if (users.history) wrapMethod(users.history, 'users.history.list', mailboxId, feature);
  if (users.messages) {
    wrapMethod(users.messages, 'users.messages.list', mailboxId, feature);
    wrapMethod(users.messages, 'users.messages.get', mailboxId, feature);
    wrapMethod(users.messages, 'users.messages.send', mailboxId, feature);
    wrapMethod(users.messages, 'users.messages.modify', mailboxId, feature);
  }
  if (users.threads) {
    wrapMethod(users.threads, 'users.threads.get', mailboxId, feature);
    wrapMethod(users.threads, 'users.threads.list', mailboxId, feature);
  }
  if (users.labels) {
    wrapMethod(users.labels, 'users.labels.list', mailboxId, feature);
    wrapMethod(users.labels, 'users.labels.get', mailboxId, feature);
  }
  return gmail;
}

async function providerRead(action, params, read, opts = {}) {
  return gmailRequest({
    method: action, params, send: read,
    mailboxId: opts.mailboxId || currentMailbox(),
    feature: opts.feature || currentFeature() || 'gmail_history_observer',
    sleep: opts.sleep, jitter: opts.jitter === true ? true : opts.jitter === false ? false : !opts.sleep,
    now: opts.now,
  });
}

function windowEvents(ms, nowMs) {
  return events.filter(entry => {
    const at = Date.parse(entry.at);
    return Number.isFinite(at) && nowMs - at <= ms;
  });
}

function summarize(rows) {
  const byMethod = {};
  let units = 0; let retries = 0; let rateLimited = 0; let fetched = 0; let discovered = 0; let deduped = 0;
  for (const row of rows) {
    byMethod[row.method] = (byMethod[row.method] || 0) + 1;
    units += Number(row.units || 0);
    if (Number(row.retryAttempt || 0) > 0) retries += 1;
    if (row.rateLimited) rateLimited += 1;
    fetched += Number(row.messagesFetched || 0);
    discovered += Number(row.messagesDiscovered || 0);
    deduped += Number(row.messagesDeduplicated || 0);
  }
  return {
    requests: rows.length, units, byMethod, retries, rateLimited,
    messagesFetched: fetched, messagesDiscovered: discovered, messagesDeduplicated: deduped,
  };
}

function loadPersistedEvents() {
  try {
    const parsed = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    return Array.isArray(parsed.events) ? parsed.events : [];
  } catch (_) { return []; }
}

function gmailUsageSnapshot({ now = new Date(), mailboxes = [] } = {}) {
  const nowMs = new Date(now).getTime();
  const merged = [...loadPersistedEvents(), ...events];
  const seen = new Set();
  const unique = [];
  for (const row of merged.reverse()) {
    const key = `${row.at}|${row.mailbox}|${row.method}|${row.status}|${row.retryAttempt}|${row.feature}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
  unique.reverse();
  const last5m = unique.filter(row => nowMs - Date.parse(row.at) <= 5 * 60 * 1000);
  const lastHour = unique.filter(row => nowMs - Date.parse(row.at) <= 60 * 60 * 1000);
  const ids = [...new Set([...mailboxes, ...unique.map(row => row.mailbox)].filter(id => id && id !== 'unknown'))];
  const perMailbox = ids.map(mailbox => {
    const rows5 = last5m.filter(row => row.mailbox === mailbox);
    const rowsH = lastHour.filter(row => row.mailbox === mailbox);
    const backoff = getMailboxBackoff(mailbox, now);
    return {
      mailbox,
      backoff: Boolean(backoff),
      backoffUntil: backoff?.until || '',
      requestsLast5m: summarize(rows5),
      requestsLastHour: summarize(rowsH),
      optionalScansSkipped: skippedOptional.filter(row => row.mailbox === mailbox).length,
      followUpsBlocked: followUpsBlocked.filter(row => row.mailbox === mailbox).length,
    };
  });
  return {
    updatedAt: new Date(now).toISOString(),
    unitsPerMinutePerUser: UNITS_PER_MINUTE_PER_USER,
    quotaUnits: QUOTA_UNITS,
    totals: { last5m: summarize(last5m), lastHour: summarize(lastHour) },
    optionalScansSkipped: skippedOptional.slice(-50),
    followUpsBlocked: followUpsBlocked.slice(-50),
    mailboxes: perMailbox,
  };
}

function resetGmailUsageForTests() {
  events.length = 0;
  skippedOptional.length = 0;
  followUpsBlocked.length = 0;
  backoffByMailbox.clear();
  chains.clear();
  inFlight.clear();
}

function persistedGmailMessageIds(activities = []) {
  const ids = new Set();
  for (const row of activities || []) {
    const eventId = String(row.eventId || '');
    if (eventId.startsWith('gmail-reply:')) ids.add(eventId.slice('gmail-reply:'.length));
    if (eventId.startsWith('gmail-outbound:')) ids.add(eventId.slice('gmail-outbound:'.length));
    try {
      const metadata = typeof row.metadata === 'object' && row.metadata
        ? row.metadata : JSON.parse(String(row.metadata || '{}'));
      for (const key of ['gmailMessageId', 'providerMessageId']) {
        if (metadata[key]) ids.add(String(metadata[key]));
      }
    } catch (_) { /* malformed metadata cannot unsafely skip a fetch */ }
  }
  return ids;
}

module.exports = {
  QUOTA_UNITS, UNITS_PER_MINUTE_PER_USER, QUOTA_RETRY_DELAYS_MS, MAX_CONCURRENCY_PER_MAILBOX,
  isRateLimited, statusOf, unitsOf, retryAfterMs,
  runWithGmailFeature, runWithGmailMailbox, currentFeature, currentMailbox,
  recordGmailRequest, gmailRequest, providerRead, wrapGmail,
  signalMailboxBackoff, hydrateMailboxBackoff, getMailboxBackoff, clearMailboxBackoff,
  shouldSkipOptionalGmail, recordFollowUpBlocked,
  gmailUsageSnapshot, resetGmailUsageForTests, persistedGmailMessageIds,
  OPTIONAL_FEATURES, REQUIRED_FEATURES,
};
