'use strict';
/**
 * cold-delivery-policy.js — TEMPORARY deliverability gate for cold outreach.
 * ─────────────────────────────────────────────────────────────────────────────
 * October 2026: Microsoft puts every ScaleLab sender in Junk (SCL 5) even with
 * SPF/DKIM/DMARC passing, while Google-hosted recipients still get Inbox from
 * three of the five inboxes. Until Microsoft recovers, cold mail goes only:
 *
 *   to   a recipient whose mailbox is POSITIVELY Google-hosted (MX evidence or
 *        gmail.com/googlemail.com), and
 *   from a sender in the Gmail-healthy pool, which must ALSO already be
 *        send-eligible (this never activates or un-pauses anything) and not
 *        on the sender hold list (SURBL-listed domain, Gmail Spam placement), and
 *   at   no more than COLD_INBOX_DAILY_CAP per inbox (a ceiling: never raises),
 *        and no more than its own static ceiling in COLD_INBOX_DAILY_CAPS
 *        (production: scalelabaiteam:30 — a maximum, not a target; no ramp).
 *
 * Everything else is HELD — derived on every evaluation, never written to the
 * lead. A held lead keeps its stage, step, history, reply and suppression state
 * exactly; turning the policy off makes it eligible again with no repair.
 * Classification fails closed: a lookup error, timeout, missing MX, gateway or
 * anything ambiguous is UNKNOWN, and UNKNOWN is never GOOGLE.
 *
 * Configuration (the provider and pool defaults ARE the temporary policy; the
 * cap is applied only when COLD_INBOX_DAILY_CAP is set):
 *   RECIPIENT_PROVIDER_POLICY   google_only (default) | off
 *                               any other value → google_only (fails closed)
 *   COLD_SENDER_POOL            comma-separated inbox ids
 *                               default primary,scalelabaiteam
 *                               "all" → no pool restriction
 *   COLD_SENDER_HOLDS           id:reason pairs that may never cold-send, even
 *                               when pooled and send-eligible. Default:
 *                               tryscalelabai and deniels_tryscalelabai
 *                               (tryscalelabai.ca on SURBL ABUSE) and deniels
 *                               (Gmail Spam placement). "none" lifts them;
 *                               anything unparseable keeps the defaults.
 *   COLD_INBOX_DAILY_CAPS       id:n pairs, a static ceiling for just those
 *                               inboxes (production: scalelabaiteam:30). Unset
 *                               or "none" → none; a malformed pair is ignored.
 *                               Never raises, never ramps, touches no other inbox.
 *   COLD_INBOX_DAILY_CAP        integer ceiling per inbox (production: 30)
 *                               unset or "off" → configured caps unchanged;
 *                               set but unparseable → 30
 *   RECIPIENT_PROVIDER_DNS_SERVERS  optional comma-separated resolver IPs
 *   RECIPIENT_PROVIDER_CACHE_TTL_MS optional, default 24h for a classification
 *
 * Rollback once Microsoft placement recovers: set RECIPIENT_PROVIDER_POLICY=off,
 * COLD_SENDER_POOL=all and COLD_INBOX_DAILY_CAP=off (or the wanted number) in
 * Railway. No lead data needs to change.
 */

const dnsPromises = require('node:dns').promises;
const { domainToASCII } = require('node:url');

const PROVIDER = Object.freeze({ GOOGLE: 'GOOGLE', MICROSOFT: 'MICROSOFT', OTHER: 'OTHER', UNKNOWN: 'UNKNOWN' });
const HOLD_REASON = Object.freeze({
  MICROSOFT: 'recipient_provider_microsoft',
  OTHER: 'recipient_provider_other',
  UNKNOWN: 'recipient_provider_unknown',
});
const POLICY = Object.freeze({ GOOGLE_ONLY: 'google_only', OFF: 'off' });
const DEFAULT_COLD_SENDER_POOL = Object.freeze(['primary', 'scalelabaiteam']);
// Senders that may not cold-send at all, whatever the pool or their status says.
// Lifting one needs the listing removed AND a fresh placement test, then an
// explicit COLD_SENDER_HOLDS change or a deploy — never an automatic expiry.
const DEFAULT_COLD_SENDER_HOLDS = Object.freeze({
  tryscalelabai: 'sender_domain_surbl_listed',
  deniels_tryscalelabai: 'sender_domain_surbl_listed',
  deniels: 'sender_gmail_placement_spam',
});
const DEFAULT_COLD_INBOX_DAILY_CAP = 30;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const NO_MX_TTL_MS = 60 * 60 * 1000;
const FAILURE_TTL_MS = 10 * 60 * 1000;
const LOOKUP_TIMEOUT_MS = 8000;
const ADMISSION_CONCURRENCY = 20;

const GOOGLE_CONSUMER = new Set(['gmail.com', 'googlemail.com']);
const MICROSOFT_CONSUMER = /^(?:hotmail|outlook|live|windowslive)\.[a-z]{2,3}(?:\.[a-z]{2})?$|^(?:msn|passport)\.com$/;

const GOOGLE_MX = [
  /^(?:alt\d+\.)?aspmx\.l\.google\.com$/,
  /^aspmx\d*\.googlemail\.com$/,
  /^smtp\.google\.com$/,
  /^(?:alt\d+\.)?gmail-smtp-in\.l\.google\.com$/,
  // Google Workspace's MX-based domain-verification record, published beside
  // the real Google MX set; it is Google's own host, not a second provider.
  /^[a-z0-9]+\.mx-verification\.google\.com$/,
];
const MICROSOFT_MX = [
  /\.mail\.protection\.outlook\.com$/,
  /\.olc\.protection\.outlook\.com$/,
  /\.mail\.eo\.outlook\.com$/,
  /\.mail\.protection\.office365\.us$/,
  /\.mx\.microsoft$/,
  /^mx\d*\.hotmail\.com$/,
];
// Security gateways hide the final mailbox provider: never GOOGLE from these.
const GATEWAY_MX = /(?:^|\.)(?:pphosted\.com|ppe-hosted\.com|mimecast\.com|mimecast-offshore\.com|mimecast\.co\.za|barracudanetworks\.com|messagelabs\.com|iphmx\.com|mailcontrol\.com|sophos\.com|trendmicro\.(?:com|eu)|fireeyecloud\.com|mailguard\.com\.au|securence\.com|spamtitan\.com|mxthunder\.com|hornetsecurity\.com|antispamcloud\.com|everycloudtech\.com|electric\.net|mx\.cloudflare\.net|in\.mailroute\.net|mailanyone\.net|zixmail\.net|appriver\.com|exclaimer\.net|codetwo\.com)$/;
// Positively identified mailbox providers that are neither Google nor Microsoft.
const OTHER_MX = /(?:^|\.)(?:secureserver\.net|zoho\.(?:com|eu|in)|zohomail\.com|yahoodns\.net|icloud\.com|messagingengine\.com|protonmail\.ch|emailsrvr\.com|ovh\.net|kundenserver\.de|ionos\.(?:com|de)|privateemail\.com|hostinger\.com|titan\.email|yandex\.(?:net|ru)|mail\.ru|gmx\.net|web\.de|namecheaphosting\.com|registrar-servers\.com|1and1\.com|mailgun\.org|amazonaws\.com|rackspace\.com)$/;

const norm = value => String(value || '').trim().toLowerCase();

function recipientProviderPolicy(env = process.env) {
  return norm(env.RECIPIENT_PROVIDER_POLICY) === POLICY.OFF ? POLICY.OFF : POLICY.GOOGLE_ONLY;
}

function coldSenderPool(env = process.env) {
  const raw = norm(env.COLD_SENDER_POOL);
  if (raw === 'all') return null;
  const ids = raw ? raw.split(',').map(item => item.trim()).filter(Boolean) : [...DEFAULT_COLD_SENDER_POOL];
  return new Set(ids);
}

function coldSenderHolds(env = process.env) {
  const raw = norm(env.COLD_SENDER_HOLDS);
  if (raw === 'none') return new Map();
  const defaults = new Map(Object.entries(DEFAULT_COLD_SENDER_HOLDS));
  if (!raw) return defaults;
  const pairs = raw.split(',').map(item => item.trim()).filter(Boolean).map(item => item.split(':').map(part => part.trim()));
  if (!pairs.length || pairs.some(([id, reason, extra]) => !id || !reason || extra !== undefined)) return defaults;
  return new Map(pairs);
}

// Explicit setting: unset (or "off") leaves every configured cap exactly as it
// is. A set but unparseable value fails safe to the 30/day temporary ceiling.
function coldInboxDailyCap(env = process.env) {
  const raw = norm(env.COLD_INBOX_DAILY_CAP);
  if (!raw || raw === 'off') return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_COLD_INBOX_DAILY_CAP;
}

// Static per-inbox maximums beside COLD_INBOX_DAILY_CAP. No ramp: the value is
// the maximum from the moment it is set and never changes on its own.
function coldInboxDailyCaps(env = process.env) {
  const caps = new Map();
  const raw = norm(env.COLD_INBOX_DAILY_CAPS);
  if (!raw || raw === 'none') return caps;
  for (const pair of raw.split(',').map(item => item.trim()).filter(Boolean)) {
    const [id, value, extra] = pair.split(':').map(part => part.trim());
    const cap = Number(value);
    if (id && extra === undefined && /^\d+$/.test(value || '') && Number.isInteger(cap)) caps.set(id, cap);
  }
  return caps;
}

/** The lowest ceiling that applies to one inbox, or null. PURE. */
function senderDailyCeiling(senderId, env = process.env) {
  const ceilings = [coldInboxDailyCap(env), coldInboxDailyCaps(env).get(senderId)].filter(value => Number.isInteger(value));
  return ceilings.length ? Math.min(...ceilings) : null;
}

/** Apply the per-inbox ceilings. Never raises a limit. PURE. */
function applyColdInboxCap(senders = [], env = process.env) {
  return senders.map(sender => {
    const cap = senderDailyCeiling(sender.id, env);
    const configured = Number(sender.dailyLimit);
    if (cap === null || !Number.isFinite(configured) || configured <= cap) return sender;
    return { ...sender, dailyLimit: cap, configuredDailyLimit: configured };
  });
}

/** The lowercase ASCII recipient domain, or '' when the address is malformed. */
function recipientDomain(email) {
  const text = norm(email);
  const at = text.lastIndexOf('@');
  if (at <= 0 || at === text.length - 1 || text.indexOf('@') !== at) return '';
  const ascii = domainToASCII(text.slice(at + 1).replace(/\.$/, ''));
  if (!ascii || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(ascii) || ascii.split('.').some(label => !label || label.startsWith('-') || label.endsWith('-'))) return '';
  return ascii;
}

/** Classify a domain from its MX hosts. PURE; no DNS. */
function classifyMxHosts(domain, mxRecords) {
  const hosts = (mxRecords || []).map(record => norm(record && (record.exchange ?? record)).replace(/\.$/, '')).filter(Boolean);
  // RFC 7505 null MX ("." / empty exchange) or no records: nowhere to deliver.
  if (!hosts.length) return { provider: PROVIDER.UNKNOWN, reason: 'no_mx', mxHosts: [] };
  const kind = host => GATEWAY_MX.test(host) ? 'gateway'
    : GOOGLE_MX.some(pattern => pattern.test(host)) ? 'google'
      : MICROSOFT_MX.some(pattern => pattern.test(host)) ? 'microsoft'
        : OTHER_MX.test(host) ? 'other' : 'unrecognized';
  const kinds = new Set(hosts.map(kind));
  if (kinds.has('gateway')) return { provider: PROVIDER.UNKNOWN, reason: 'security_gateway', mxHosts: hosts };
  if (kinds.size === 1 && kinds.has('google')) return { provider: PROVIDER.GOOGLE, reason: 'google_mx', mxHosts: hosts };
  if (kinds.size === 1 && kinds.has('microsoft')) return { provider: PROVIDER.MICROSOFT, reason: 'microsoft_mx', mxHosts: hosts };
  if (kinds.size === 1 && kinds.has('other')) return { provider: PROVIDER.OTHER, reason: 'other_provider_mx', mxHosts: hosts };
  if (kinds.size > 1) return { provider: PROVIDER.UNKNOWN, reason: 'mixed_mx', mxHosts: hosts };
  return { provider: PROVIDER.UNKNOWN, reason: 'unrecognized_mx', mxHosts: hosts };
}

const NO_MX_CODES = new Set(['ENODATA', 'ENOTFOUND']);

function defaultResolveMx(env = process.env) {
  const servers = norm(env.RECIPIENT_PROVIDER_DNS_SERVERS).split(',').map(item => item.trim()).filter(Boolean);
  const resolver = new dnsPromises.Resolver({ timeout: 4000, tries: 2 });
  if (servers.length) resolver.setServers(servers);
  return domain => resolver.resolveMx(domain);
}

/**
 * A domain-level classification cache. One lookup per domain per TTL; one
 * in-flight lookup per domain at a time. A failed or expired lookup is never
 * served as GOOGLE: failures are cached briefly as UNKNOWN and then retried.
 */
function createProviderClassifier({ resolveMx, now = () => Date.now(), ttlMs, logger = console, env = process.env } = {}) {
  const lookup = resolveMx || defaultResolveMx(env);
  const positiveTtl = Number(ttlMs ?? env.RECIPIENT_PROVIDER_CACHE_TTL_MS) > 0 ? Number(ttlMs ?? env.RECIPIENT_PROVIDER_CACHE_TTL_MS) : DEFAULT_TTL_MS;
  const cache = new Map();
  const inflight = new Map();
  const stats = { hits: 0, misses: 0, lookups: 0, failures: 0, byProvider: {} };

  function remember(domain, verdict, ttl, source) {
    const classifiedAt = now();
    const entry = { domain, ...verdict, source, classifiedAt: new Date(classifiedAt).toISOString(), expiresAt: classifiedAt + ttl };
    cache.set(domain, entry);
    stats.byProvider[entry.provider] = (stats.byProvider[entry.provider] || 0) + 1;
    logger.log(JSON.stringify({ event: 'recipient_provider_classified', domain, provider: entry.provider,
      reason: entry.reason, source, mxHosts: entry.mxHosts || [], cache: 'miss' }));
    return entry;
  }

  async function lookUp(domain) {
    stats.lookups++;
    let timer;
    try {
      const records = await Promise.race([
        lookup(domain),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('MX lookup timed out'), { code: 'ETIMEOUT' })), LOOKUP_TIMEOUT_MS); }),
      ]);
      const verdict = classifyMxHosts(domain, records);
      return remember(domain, verdict, verdict.reason === 'no_mx' ? NO_MX_TTL_MS : positiveTtl, 'mx');
    } catch (error) {
      const code = String(error && error.code || 'ELOOKUP');
      if (NO_MX_CODES.has(code)) return remember(domain, { provider: PROVIDER.UNKNOWN, reason: 'no_mx', mxHosts: [] }, NO_MX_TTL_MS, 'mx');
      stats.failures++;
      return remember(domain, { provider: PROVIDER.UNKNOWN, reason: `lookup_failed:${code}`, mxHosts: [] }, FAILURE_TTL_MS, 'mx_error');
    } finally { clearTimeout(timer); }
  }

  /** Classify the recipient of `email`. Never throws; fails closed to UNKNOWN. */
  async function classify(email) {
    const domain = recipientDomain(email);
    if (!domain) return { domain: '', provider: PROVIDER.UNKNOWN, reason: 'malformed_address', source: 'syntax', mxHosts: [], cache: 'none' };
    if (GOOGLE_CONSUMER.has(domain)) return { domain, provider: PROVIDER.GOOGLE, reason: 'google_consumer_domain', source: 'domain', mxHosts: [], cache: 'none' };
    if (MICROSOFT_CONSUMER.test(domain)) return { domain, provider: PROVIDER.MICROSOFT, reason: 'microsoft_consumer_domain', source: 'domain', mxHosts: [], cache: 'none' };
    const cached = cache.get(domain);
    if (cached && cached.expiresAt > now()) { stats.hits++; return { ...cached, cache: 'hit' }; }
    stats.misses++;
    if (!inflight.has(domain)) inflight.set(domain, lookUp(domain).finally(() => inflight.delete(domain)));
    try { return { ...(await inflight.get(domain)), cache: 'miss' }; }
    catch (_) { return { domain, provider: PROVIDER.UNKNOWN, reason: 'lookup_failed:EUNEXPECTED', source: 'mx_error', mxHosts: [], cache: 'miss' }; }
  }

  /** Cached verdict only — no lookup. Missing or expired is UNKNOWN. */
  function peek(email) {
    const domain = recipientDomain(email);
    if (!domain) return { domain: '', provider: PROVIDER.UNKNOWN, reason: 'malformed_address', source: 'syntax', cache: 'none' };
    if (GOOGLE_CONSUMER.has(domain)) return { domain, provider: PROVIDER.GOOGLE, reason: 'google_consumer_domain', source: 'domain', cache: 'none' };
    if (MICROSOFT_CONSUMER.test(domain)) return { domain, provider: PROVIDER.MICROSOFT, reason: 'microsoft_consumer_domain', source: 'domain', cache: 'none' };
    const cached = cache.get(domain);
    if (cached && cached.expiresAt > now()) return { ...cached, cache: 'hit' };
    return { domain, provider: PROVIDER.UNKNOWN, reason: 'not_classified', source: 'cache', cache: 'miss' };
  }

  return { classify, peek, stats: () => ({ ...stats, byProvider: { ...stats.byProvider }, cached: cache.size }) };
}

/**
 * Prospecting / unsolicited outreach vs conversational warm traffic.
 *
 * Stage-sequence follow-ups are prospecting even though their purpose string
 * is 'sequence'. A reply to an existing conversation (purpose === 'warm') is
 * not. Unknown or missing purpose fails closed as prospecting so a new call
 * site cannot silently skip the recipient-provider gate.
 */
function isProspectingSend(purpose) {
  return norm(purpose) !== 'warm';
}

/** Recipient side of the policy. PURE. */
function providerVerdict(classification, env = process.env) {
  if (recipientProviderPolicy(env) === POLICY.OFF) return { allowed: true, code: '', policy: POLICY.OFF, provider: classification?.provider || PROVIDER.UNKNOWN };
  const provider = classification?.provider;
  if (provider === PROVIDER.GOOGLE) return { allowed: true, code: '', policy: POLICY.GOOGLE_ONLY, provider };
  const code = provider === PROVIDER.MICROSOFT ? HOLD_REASON.MICROSOFT
    : provider === PROVIDER.OTHER ? HOLD_REASON.OTHER : HOLD_REASON.UNKNOWN;
  return { allowed: false, code, policy: POLICY.GOOGLE_ONLY, provider: provider || PROVIDER.UNKNOWN,
    reason: `recipient provider ${provider || PROVIDER.UNKNOWN} (${classification?.reason || 'unclassified'}) is held by the google_only policy` };
}

/** Sender side of the policy: pool membership AND existing send-eligibility. PURE. */
function coldSenderVerdict(sender, env = process.env) {
  if (!sender || !sender.id) return { allowed: false, code: 'sender_unavailable', reason: 'no sender' };
  if (sender.sendEligible !== true) return { allowed: false, code: 'sender_not_send_eligible', reason: `${sender.id} is not send-eligible (${sender.status || 'unknown'})` };
  const hold = coldSenderHolds(env).get(sender.id);
  if (hold) return { allowed: false, code: 'sender_cold_hold', holdReason: hold, reason: `${sender.id} may not cold-send (${hold})` };
  const pool = coldSenderPool(env);
  if (pool && !pool.has(sender.id)) return { allowed: false, code: 'sender_not_in_cold_pool', reason: `${sender.id} is not in the Gmail-healthy cold sender pool` };
  return { allowed: true, code: '' };
}

/** Final cold authorization: sender verdict AND recipient verdict. PURE. */
function coldDeliveryVerdict({ sender, classification, env = process.env }) {
  const senderVerdict = coldSenderVerdict(sender, env);
  if (!senderVerdict.allowed) return { ...senderVerdict, layer: 'sender' };
  const recipient = providerVerdict(classification, env);
  if (!recipient.allowed) return { ...recipient, layer: 'recipient', domain: classification?.domain || '' };
  return { allowed: true, code: '', layer: 'authorized', provider: recipient.provider, policy: recipient.policy };
}

/**
 * Admission for a batch of candidates: one classification per domain, then the
 * recipient verdict per lead. Returns allowed ids and held leads with reasons.
 */
/** Read-only description of the live policy. IDs and statuses only — no secrets. */
function describeColdDeliveryPolicy(senders = [], env = process.env) {
  const pool = coldSenderPool(env);
  const holds = coldSenderHolds(env);
  return {
    event: 'cold_delivery_policy',
    policy: recipientProviderPolicy(env),
    coldSenderPool: pool ? [...pool] : 'all',
    coldSenderHolds: Object.fromEntries(holds),
    coldInboxDailyCap: coldInboxDailyCap(env),
    coldInboxDailyCaps: Object.fromEntries(coldInboxDailyCaps(env)),
    senders: (senders || []).map(sender => ({
      id: sender.id,
      email: sender.email || '',
      status: sender.status,
      sendEligible: sender.sendEligible === true,
      dailyLimit: sender.dailyLimit,
      perRunLimit: sender.perRunLimit,
      inColdPool: !pool || pool.has(sender.id),
      coldHold: holds.get(sender.id) || null,
    })),
  };
}

async function admitByRecipientProvider(leads, classifier, env = process.env) {
  const allowed = new Set();
  const held = [];
  if (recipientProviderPolicy(env) === POLICY.OFF) {
    for (const lead of leads || []) allowed.add(lead.id);
    return { allowed, held };
  }
  const byEmail = new Map();
  const emails = [...new Set((leads || []).map(lead => norm(lead.email)))];
  // Bounded concurrency; the classifier also collapses same-domain lookups.
  for (let i = 0; i < emails.length; i += ADMISSION_CONCURRENCY) {
    await Promise.all(emails.slice(i, i + ADMISSION_CONCURRENCY).map(async email => {
      byEmail.set(email, await classifier.classify(email));
    }));
  }
  for (const lead of leads || []) {
    const classification = byEmail.get(norm(lead.email));
    const verdict = providerVerdict(classification, env);
    if (verdict.allowed) allowed.add(lead.id);
    else held.push({ leadId: lead.id, domain: classification?.domain || '', provider: verdict.provider, holdReason: verdict.code, classification: classification?.reason });
  }
  return { allowed, held };
}

module.exports = {
  PROVIDER, HOLD_REASON, POLICY, DEFAULT_COLD_SENDER_POOL, DEFAULT_COLD_SENDER_HOLDS,
  DEFAULT_COLD_INBOX_DAILY_CAP, recipientProviderPolicy, coldSenderPool, coldSenderHolds, coldInboxDailyCap,
  coldInboxDailyCaps, senderDailyCeiling, applyColdInboxCap,
  recipientDomain, classifyMxHosts, createProviderClassifier, isProspectingSend, providerVerdict,
  coldSenderVerdict, coldDeliveryVerdict, describeColdDeliveryPolicy, admitByRecipientProvider,
};
