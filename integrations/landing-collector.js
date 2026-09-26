'use strict';

/**
 * Pure helpers for the staffing landing-page collector (landing-collector-route.js).
 *
 * The browser reaches the collector same-origin, through a Netlify signed
 * forwarding rule (/staffing/api/lp -> /api/landing/e). Requests without a
 * valid Netlify signature are dropped, so a direct hit on this host counts
 * for nothing.
 *
 * Nothing here reads or keeps cookies, Referer, raw user agents or IPs. The
 * client IP is used transiently as a rate-limit key and never stored.
 */

const crypto = require('node:crypto');
const { TOKEN_PATTERN, landingTokenHash } = require('./landing-link-token');
const { RATE_LIMIT, RETRY_BUFFER, PROXY_SIGNATURE_SKEW_SECONDS, INTERNAL_MARK_TTL_SECONDS } = require('./landing-attribution-config');

const ALLOWED_ORIGINS = Object.freeze(['https://scalelabai.ca', 'https://www.scalelabai.ca']);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CTA_LOCATIONS = Object.freeze(['nav', 'hero', 'video', 'video_end', 'final', 'unknown']);

const base64url = buffer => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64url = text => Buffer.from(String(text).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const safeEqual = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

/**
 * Verify Netlify's x-nf-sign header (HS256 JWS) for a production forward of
 * this site. Returns { ok, reason, claims }.
 */
function verifyNetlifySignature(header, { secret, siteId, nowSeconds = Math.floor(Date.now() / 1000), skewSeconds = PROXY_SIGNATURE_SKEW_SECONDS } = {}) {
  if (!secret || !siteId) return { ok: false, reason: 'collector signing is not configured' };
  const parts = String(header || '').split('.');
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return { ok: false, reason: 'missing or malformed signature' };
  let protectedHeader;
  let claims;
  try {
    protectedHeader = JSON.parse(fromBase64url(parts[0]).toString('utf8'));
    claims = JSON.parse(fromBase64url(parts[1]).toString('utf8'));
  } catch (_) { return { ok: false, reason: 'unparseable signature' }; }
  if (protectedHeader?.alg !== 'HS256') return { ok: false, reason: 'unexpected signature algorithm' };
  const expected = base64url(crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest());
  if (!safeEqual(expected, parts[2])) return { ok: false, reason: 'bad signature' };
  if (claims?.iss !== 'netlify') return { ok: false, reason: 'unexpected issuer' };
  if (claims?.netlify_id !== siteId) return { ok: false, reason: 'unexpected site' };
  if (claims?.deploy_context !== 'production') return { ok: false, reason: 'not a production deploy' };
  if (!Number.isFinite(claims?.exp) || claims.exp < nowSeconds - skewSeconds) return { ok: false, reason: 'expired signature' };
  return { ok: true, reason: 'ok', claims };
}

function originAllowed(origin) {
  return ALLOWED_ORIGINS.includes(String(origin || ''));
}

/** Coarse, non-identifying user-agent classes. The raw string is not kept. */
function classifyUserAgent(userAgent = '') {
  const ua = String(userAgent || '').slice(0, 512);
  const match = (pattern) => ua.match(pattern);
  let browser = 'other';
  let major = null;
  const edge = match(/Edg(?:e|A|iOS)?\/(\d+)/);
  const chrome = match(/(?:Chrome|CriOS|HeadlessChrome)\/(\d+)/);
  const firefox = match(/(?:Firefox|FxiOS)\/(\d+)/);
  const safari = match(/Version\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari\//);
  if (edge) { browser = 'edge'; major = Number(edge[1]); }
  else if (firefox) { browser = 'firefox'; major = Number(firefox[1]); }
  else if (chrome) { browser = 'chrome'; major = Number(chrome[1]); }
  else if (safari) { browser = 'safari'; major = Number(safari[1]); }
  const os = /iPhone|iPad|iPod/.test(ua) ? 'ios'
    : /Android/.test(ua) ? 'android'
      : /Windows NT/.test(ua) ? 'windows'
        : /Mac OS X|Macintosh/.test(ua) ? 'macos'
          : /CrOS/.test(ua) ? 'chromeos'
            : /Linux/.test(ua) ? 'linux' : 'other';
  const deviceClass = /iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua)) ? 'tablet'
    : /Mobi|iPhone|iPod|Android/.test(ua) ? 'mobile' : 'desktop';
  return {
    browser, major: Number.isFinite(major) && major > 0 && major < 1000 ? major : null, os, deviceClass,
    headless: /HeadlessChrome|Headless|PhantomJS|Electron\//.test(ua),
    declaredBot: /bot\b|crawl|spider|slurp|preview|scanner|monitor|fetch|curl|wget|python|java\/|go-http|axios|node-fetch/i.test(ua),
  };
}

const int = (value, min, max) => (Number.isInteger(value) && value >= min && value <= max ? value : undefined);
const oneOf = (value, allowed) => (allowed.includes(value) ? value : undefined);
const bool = value => (typeof value === 'boolean' ? value : undefined);

// The only events and properties the collector accepts. Anything else is dropped.
const EVENT_PROPS = Object.freeze({
  page_load: { visible: bool, prerendered: bool, navigation: v => oneOf(v, ['navigate', 'reload', 'back_forward', 'prerender']) },
  visible: {},
  engaged_10s: {},
  interaction: { kind: v => oneOf(v, ['pointer', 'touch', 'key', 'wheel']) },
  scroll_input: { count: v => int(v, 0, 100000), px: v => int(v, 0, 10000000) },
  scroll_depth: { pct: v => oneOf(v, [25, 50, 75, 90]), mode: v => oneOf(v, ['input', 'jump']) },
  video_visible: {},
  video_playing: {},
  video_25: {},
  video_50: {},
  video_75: {},
  video_complete: {},
  meeting_section_visible: {},
  booking_cta_click: { cta_location: v => oneOf(v, CTA_LOCATIONS) },
  booking_dialog_open: { cta_location: v => oneOf(v, CTA_LOCATIONS) },
  booking_embed_loaded: {},
  booking_new_tab: { cta_location: v => oneOf(v, CTA_LOCATIONS) },
  page_summary: {
    visible_ms: v => int(v, 0, 86400000), max_scroll_pct: v => int(v, 0, 100),
    scroll_events: v => int(v, 0, 1000000), max_jump_px: v => int(v, 0, 10000000),
  },
});

function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object' || !Object.prototype.hasOwnProperty.call(EVENT_PROPS, raw.n)) return null;
  const seq = int(raw.s, 0, 100000);
  if (seq === undefined) return null;
  const props = {};
  const source = raw.p && typeof raw.p === 'object' && !Array.isArray(raw.p) ? raw.p : {};
  for (const [key, check] of Object.entries(EVENT_PROPS[raw.n])) {
    const value = check(source[key]);
    if (value !== undefined) props[key] = value;
  }
  return {
    event_name: raw.n, seq, client_ms: int(raw.ms, 0, 86400000) ?? null,
    is_trusted: bool(raw.tr) ?? null, user_activated: bool(raw.ua) ?? null, props,
  };
}

/**
 * Validate one collector request body. Returns
 *   { ok: false, reason }
 *   { ok: true, kind: 'mark', code }
 *   { ok: true, kind: 'events', collect: false, reason }       (valid but not collected)
 *   { ok: true, kind: 'events', collect: true, payload }       (landing_ingest input, minus UA fields)
 */
function normalizeCollectorRequest(text) {
  let body;
  try { body = JSON.parse(String(text || '')); } catch (_) { return { ok: false, reason: 'not JSON' }; }
  if (!body || typeof body !== 'object' || body.v !== 1) return { ok: false, reason: 'unsupported version' };
  if (body.kind === 'mark') {
    return typeof body.code === 'string' && body.code.length <= 200 ? { ok: true, kind: 'mark', code: body.code } : { ok: false, reason: 'bad mark code' };
  }
  if (body.kind !== 'events') return { ok: false, reason: 'unknown kind' };
  if (!UUID_V4.test(String(body.sid || '')) || !UUID_V4.test(String(body.plid || ''))) return { ok: false, reason: 'bad session ids' };
  const token = body.t === null || body.t === undefined ? null : body.t;
  if (token !== null && !(typeof token === 'string' && TOKEN_PATTERN.test(token))) return { ok: false, reason: 'bad token format' };
  if (!Array.isArray(body.ev) || !body.ev.length || body.ev.length > RATE_LIMIT.maxEventsPerRequest) return { ok: false, reason: 'bad event batch' };
  const isInternal = body.internal === true;
  // Anonymous visitors stay GA4-only: no token and not internal means nothing to attribute.
  if (!token && !isInternal) return { ok: true, kind: 'events', collect: false, reason: 'no token' };
  const events = body.ev.map(normalizeEvent).filter(Boolean);
  if (!events.length) return { ok: false, reason: 'no accepted events' };
  return {
    ok: true, kind: 'events', collect: true,
    payload: {
      token_hash: token ? landingTokenHash(token) : null,
      session_id: String(body.sid).toLowerCase(),
      page_load_id: String(body.plid).toLowerCase(),
      is_internal: isInternal,
      is_debug: isInternal && body.debug === true,
      webdriver: body.wd === true,
      viewport_bucket: oneOf(body.vp, ['m', 't', 'd']) ?? null,
      events,
    },
  };
}

/** Fixed-window per-client limit plus a global per-second ceiling. In memory only. */
class CollectorRateLimiter {
  constructor({ perClientPerMinute = RATE_LIMIT.perClientPerMinute, globalPerSecond = RATE_LIMIT.globalPerSecond, now = () => Date.now() } = {}) {
    Object.assign(this, { perClientPerMinute, globalPerSecond, now, clients: new Map(), globalWindow: 0, globalCount: 0 });
  }

  allow(clientKey) {
    const at = this.now();
    const second = Math.floor(at / 1000);
    if (second !== this.globalWindow) { this.globalWindow = second; this.globalCount = 0; }
    if (this.globalCount >= this.globalPerSecond) return false;
    const minute = Math.floor(at / 60000);
    const key = String(clientKey || 'unknown');
    const entry = this.clients.get(key);
    if (!entry || entry.minute !== minute) {
      if (this.clients.size > 10000) this.clients.clear();
      this.clients.set(key, { minute, count: 1 });
    } else {
      if (entry.count >= this.perClientPerMinute) return false;
      entry.count += 1;
    }
    this.globalCount += 1;
    return true;
  }
}

/** Bounded, short-lived retry for transient ingest failures. Oldest items drop first. */
class IngestRetryBuffer {
  constructor({ maxItems = RETRY_BUFFER.maxItems, maxAttempts = RETRY_BUFFER.maxAttempts, maxAgeMs = RETRY_BUFFER.maxAgeMs, now = () => Date.now() } = {}) {
    Object.assign(this, { maxItems, maxAttempts, maxAgeMs, now, items: [], dropped: 0 });
  }

  add(payload) {
    this.items.push({ payload, attempts: 1, addedAt: this.now() });
    while (this.items.length > this.maxItems) { this.items.shift(); this.dropped += 1; }
  }

  /** Retry each item once more; keep only transient failures still inside the limits. */
  async drain(ingest) {
    const pending = this.items;
    this.items = [];
    for (const item of pending) {
      if (this.now() - item.addedAt > this.maxAgeMs || item.attempts >= this.maxAttempts) { this.dropped += 1; continue; }
      const result = await ingest(item.payload);
      item.attempts += 1;
      if (!result?.ok && isTransientFailure(result) && item.attempts < this.maxAttempts) this.items.push(item);
      else if (!result?.ok) this.dropped += 1;
    }
    return { remaining: this.items.length, dropped: this.dropped };
  }
}

function isTransientFailure(result) {
  const status = Number(result?.status || 0);
  return status === 0 || status === 429 || status >= 500;
}

// ── Internal-browser marking ────────────────────────────────────────────────
// The authenticated dashboard mints a short-lived, single-purpose code:
//   v1.<exp>.<nonce>.<hmac>   hmac = HMAC-SHA256(secret, "landing_internal_mark|v1|exp|nonce")
// The staffing page receives it in the URL fragment and posts it to the
// collector, which verifies it once. Single use is enforced in memory (one
// replica); a process restart inside the five-minute window could accept a
// replay of a code that only ever existed in the operator's own browser.
const MARK_PURPOSE = 'landing_internal_mark';
const MARK_PATTERN = /^v1\.(\d{10})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

function markSignature(secret, exp, nonce) {
  return base64url(crypto.createHmac('sha256', secret).update(`${MARK_PURPOSE}|v1|${exp}|${nonce}`).digest());
}

function mintInternalMarkCode({ secret, nowSeconds = Math.floor(Date.now() / 1000), ttlSeconds = INTERNAL_MARK_TTL_SECONDS, nonce = base64url(crypto.randomBytes(16)) } = {}) {
  if (!secret) throw new Error('internal marking is not configured');
  const exp = nowSeconds + ttlSeconds;
  return { code: `v1.${exp}.${nonce}.${markSignature(secret, exp, nonce)}`, expiresAt: new Date(exp * 1000).toISOString() };
}

function verifyInternalMarkCode(code, { secret, used, nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  if (!secret) return { ok: false, reason: 'internal marking is not configured' };
  const match = MARK_PATTERN.exec(String(code || ''));
  if (!match) return { ok: false, reason: 'malformed code' };
  const [, expText, nonce, signature] = match;
  const exp = Number(expText);
  if (!safeEqual(markSignature(secret, exp, nonce), signature)) return { ok: false, reason: 'bad signature' };
  if (exp < nowSeconds) return { ok: false, reason: 'expired' };
  if (used) {
    for (const [key, expiry] of used) if (expiry < nowSeconds) used.delete(key);
    if (used.has(nonce)) return { ok: false, reason: 'already used' };
    used.set(nonce, exp);
  }
  return { ok: true, reason: 'ok' };
}

module.exports = {
  ALLOWED_ORIGINS, EVENT_PROPS, CTA_LOCATIONS,
  verifyNetlifySignature, originAllowed, classifyUserAgent, normalizeCollectorRequest,
  CollectorRateLimiter, IngestRetryBuffer, isTransientFailure,
  mintInternalMarkCode, verifyInternalMarkCode,
};
