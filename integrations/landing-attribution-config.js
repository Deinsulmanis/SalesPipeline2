'use strict';

/**
 * Staffing landing-link attribution: every flag, secret name, retention period,
 * timeout and window in one place. Read at call time from the environment, like
 * send-lock-config, so a Railway variable change needs no code change.
 *
 * Every feature is OFF unless its flag is exactly "true":
 *   LANDING_LINK_TRACKING_ENABLED  new staffing link issuances carry ?t=<token>
 *   LANDING_COLLECTOR_ENABLED      the public collector accepts landing-page events
 *   LANDING_RECONCILER_ENABLED     the scheduled backfill / resolution / retention job runs
 *
 * Tracking also needs a valid key ring. A flag without its secrets is reported
 * as disabled with a reason; it never half-works.
 */

const FLAG = Object.freeze({
  TRACKING: 'LANDING_LINK_TRACKING_ENABLED',
  COLLECTOR: 'LANDING_COLLECTOR_ENABLED',
  RECONCILER: 'LANDING_RECONCILER_ENABLED',
});

const SECRET = Object.freeze({
  // JSON object of version -> base64 key, e.g. {"1":"<44 base64 chars>"}.
  TOKEN_KEYS: 'LANDING_LINK_TOKEN_KEYS',
  TOKEN_ACTIVE_VERSION: 'LANDING_LINK_TOKEN_ACTIVE_VERSION',
  // Shared with Netlify's signed forwarding rule (x-nf-sign, HS256).
  PROXY_SIGNING: 'LANDING_PROXY_SIGNING_SECRET',
  // HMAC key for the dashboard's short-lived internal-browser codes.
  INTERNAL_MARK: 'LANDING_INTERNAL_MARK_SECRET',
});

const SETTING = Object.freeze({
  // Netlify site id the signed forwarding rule must carry (netlify_id claim).
  PROXY_SITE_ID: 'LANDING_PROXY_SITE_ID',
  // Recipients on these domains are ScaleLab's own test leads.
  TEST_EMAIL_DOMAINS: 'LANDING_TEST_EMAIL_DOMAINS',
});

const DEFAULT_TEST_EMAIL_DOMAINS = Object.freeze(['scalelabai.ca', 'tryscalelabai.ca']);

// Retention in days. Passed to landing_apply_retention() by the reconciler,
// so these constants are the only place the periods are defined.
const RETENTION_DAYS = Object.freeze({
  eventsAndSessions: 395,     // 13 months
  issuances: 730,             // 24 months
  unresolvedSessions: 7,      // token never matched an issuance
  internalAndDebug: 30,       // marked internal browsers and debug sessions
});

const TIMEOUT_MS = Object.freeze({
  ingest: 1000,               // one landing_ingest attempt per collector request
  issuance: 2000,             // landing_issue_link before a tracked send
  markSent: 2000,             // landing_mark_link_sent after a tracked send
  reconcile: 5000,            // each reconciler call
});

// Bounded retry for transient ingest failures only. Never the only copy of an
// acknowledged event's durability story: the page is best-effort by design.
const RETRY_BUFFER = Object.freeze({ maxItems: 200, maxAttempts: 2, maxAgeMs: 120000, intervalMs: 15000 });

const RATE_LIMIT = Object.freeze({ perClientPerMinute: 60, globalPerSecond: 20, maxEventsPerRequest: 20, maxBodyBytes: 2048 });

// Netlify signs each forwarded request for about five minutes.
const PROXY_SIGNATURE_SKEW_SECONDS = 30;
const INTERNAL_MARK_TTL_SECONDS = 300;

// Booking attribution windows used by the landing_booking_attribution view.
// The SQL literals are checked against these values by the test suite.
const ATTRIBUTION_WINDOW = Object.freeze({ ctaBeforeBookingMinutes: 120, engagedSessionLookbackDays: 30 });

// Backfill looks this far back for canonical sends that carry a landing link.
const RECONCILE_LOOKBACK_DAYS = 30;

const isTrue = value => String(value || '').trim().toLowerCase() === 'true';

function flagEnabled(name, env = process.env) {
  return isTrue(env[name]);
}

function reconcilerEnabled(env = process.env) {
  return flagEnabled(FLAG.RECONCILER, env);
}

function testEmailDomains(env = process.env) {
  const raw = String(env[SETTING.TEST_EMAIL_DOMAINS] || '').trim();
  if (!raw) return DEFAULT_TEST_EMAIL_DOMAINS;
  return Object.freeze(raw.split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
}

function isTestRecipient(email, env = process.env) {
  const domain = String(email || '').trim().toLowerCase().split('@')[1] || '';
  return Boolean(domain) && testEmailDomains(env).includes(domain);
}

module.exports = {
  FLAG, SECRET, SETTING, DEFAULT_TEST_EMAIL_DOMAINS,
  RETENTION_DAYS, TIMEOUT_MS, RETRY_BUFFER, RATE_LIMIT,
  PROXY_SIGNATURE_SKEW_SECONDS, INTERNAL_MARK_TTL_SECONDS,
  ATTRIBUTION_WINDOW, RECONCILE_LOOKBACK_DAYS,
  flagEnabled, reconcilerEnabled, testEmailDomains, isTestRecipient,
};
