'use strict';

/**
 * Staffing landing-page collector and internal-browser marking.
 *
 * PUBLIC  POST /api/landing/e
 *   Registered before the global JSON parser and dashboard authentication, with
 *   its own 2 KB text parser. The browser reaches it as
 *   https://scalelabai.ca/staffing/api/lp through Netlify's signed forwarding
 *   rule. Off unless LANDING_COLLECTOR_ENABLED is exactly "true".
 *
 *   validate -> one landing_ingest call (1 s timeout) -> 204 either way.
 *   Transient failures go to a small bounded retry buffer; nothing depends on
 *   it, and the page is best-effort by design. The only non-204 answer is a
 *   verified internal-mark code: 200 {"marked":true}.
 *
 * DASHBOARD (authenticated)
 *   GET /api/landing/internal-mark        a short-lived code + the staffing URL
 *   GET /api/landing/collector-health     counters only
 */

const express = require('express');
const { STAFFING_LANDING_PAGE_URL } = require('./staffing-campaign');
const { FLAG, SECRET, SETTING, RATE_LIMIT, RETRY_BUFFER, flagEnabled } = require('./landing-attribution-config');
const {
  verifyNetlifySignature, originAllowed, classifyUserAgent, normalizeCollectorRequest,
  CollectorRateLimiter, IngestRetryBuffer, isTransientFailure, mintInternalMarkCode, verifyInternalMarkCode,
} = require('./landing-collector');
const store = require('./landing-attribution-store');

const COLLECTOR_PATH = '/api/landing/e';
const PUBLIC_PATH = '/staffing/api/lp';

function createCollector({ env = process.env, ingest = store.ingestLandingEvents, nowMs = () => Date.now(), logger = console } = {}) {
  const limiter = new CollectorRateLimiter({ now: nowMs });
  const retry = new IngestRetryBuffer({ now: nowMs });
  const usedMarks = new Map();
  const counters = {
    received: 0, disabled: 0, unsigned: 0, badOrigin: 0, rateLimited: 0, invalid: 0, notCollected: 0,
    ingested: 0, ingestFailed: 0, retried: 0, marked: 0, markRefused: 0,
  };

  async function handle(req, res) {
    counters.received += 1;
    const done = () => res.status(204).end();
    if (!flagEnabled(FLAG.COLLECTOR, env)) { counters.disabled += 1; return done(); }
    const signature = verifyNetlifySignature(req.get('x-nf-sign'), {
      secret: env[SECRET.PROXY_SIGNING], siteId: env[SETTING.PROXY_SITE_ID], nowSeconds: Math.floor(nowMs() / 1000),
    });
    if (!signature.ok) { counters.unsigned += 1; return done(); }
    if (!originAllowed(req.get('origin'))) { counters.badOrigin += 1; return done(); }
    // Netlify overwrites this header, and the signature proves the request came through Netlify.
    if (!limiter.allow(req.get('x-nf-client-connection-ip'))) { counters.rateLimited += 1; return done(); }
    const request = normalizeCollectorRequest(req.body);
    if (!request.ok) { counters.invalid += 1; return done(); }

    if (request.kind === 'mark') {
      const verdict = verifyInternalMarkCode(request.code, {
        secret: env[SECRET.INTERNAL_MARK], used: usedMarks, nowSeconds: Math.floor(nowMs() / 1000),
      });
      if (!verdict.ok) { counters.markRefused += 1; return done(); }
      counters.marked += 1;
      return res.status(200).set('Cache-Control', 'no-store').json({ marked: true });
    }

    if (!request.collect) { counters.notCollected += 1; return done(); }
    const ua = classifyUserAgent(req.get('user-agent'));
    const payload = {
      ...request.payload,
      ua_browser: ua.browser, ua_major: ua.major, ua_os: ua.os, device_class: ua.deviceClass,
      ua_headless: ua.headless, ua_declared_bot: ua.declaredBot,
    };
    const result = await ingest(payload);
    if (result?.ok) counters.ingested += 1;
    else {
      counters.ingestFailed += 1;
      if (isTransientFailure(result)) retry.add(payload);
      // Status only: a response body can echo the submitted values.
      logger.warn(`[landing-collector] ingest failed (${result?.error || 'unknown'})${isTransientFailure(result) ? '; queued for one retry' : ''}`);
    }
    return done();
  }

  async function drainRetries() {
    if (!retry.items.length) return;
    const before = retry.items.length;
    await retry.drain(async payload => {
      const result = await ingest(payload);
      if (result?.ok) counters.ingested += 1;
      return result;
    });
    counters.retried += before;
  }

  return {
    handle, drainRetries, counters, retry,
    health: () => ({
      enabled: flagEnabled(FLAG.COLLECTOR, env),
      signingConfigured: Boolean(env[SECRET.PROXY_SIGNING] && env[SETTING.PROXY_SITE_ID]),
      internalMarkingConfigured: Boolean(env[SECRET.INTERNAL_MARK]),
      counters: { ...counters },
      retryBuffer: { pending: retry.items.length, dropped: retry.dropped, maxItems: RETRY_BUFFER.maxItems },
    }),
  };
}

/** PUBLIC route. Call before app.use(express.json(...)) and app.use(requireAuth). */
function registerLandingCollectorRoute(app, options = {}) {
  const collector = createCollector(options);
  app.post(COLLECTOR_PATH,
    express.text({ type: () => true, limit: RATE_LIMIT.maxBodyBytes }),
    (req, res, next) => collector.handle(req, res).catch(next),
    // Oversized or unreadable bodies, and any unexpected error: same silent answer.
    (error, req, res, _next) => { if (!res.headersSent) res.status(204).end(); });
  const timer = setInterval(() => { collector.drainRetries().catch(() => {}); }, RETRY_BUFFER.intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return collector;
}

/** AUTHENTICATED dashboard routes. Call after app.use(requireAuth). */
function registerLandingInternalMarkRoutes(app, requireAuth, { env = process.env, collector = null, nowMs = () => Date.now() } = {}) {
  app.get('/api/landing/internal-mark', requireAuth, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!env[SECRET.INTERNAL_MARK]) return res.status(503).json({ error: `${SECRET.INTERNAL_MARK} is not configured` });
    const { code, expiresAt } = mintInternalMarkCode({ secret: env[SECRET.INTERNAL_MARK], nowSeconds: Math.floor(nowMs() / 1000) });
    return res.json({
      url: `${STAFFING_LANDING_PAGE_URL}#sl-mark=${code}`,
      clearUrl: `${STAFFING_LANDING_PAGE_URL}#sl-mark=off`,
      expiresAt,
      collectorEnabled: flagEnabled(FLAG.COLLECTOR, env),
    });
  });
  app.get('/api/landing/collector-health', requireAuth, (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(collector ? collector.health() : { enabled: flagEnabled(FLAG.COLLECTOR, env), registered: false });
  });
}

module.exports = { COLLECTOR_PATH, PUBLIC_PATH, createCollector, registerLandingCollectorRoute, registerLandingInternalMarkRoutes };
