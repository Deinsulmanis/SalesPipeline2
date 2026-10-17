'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const {
  verifyNetlifySignature, originAllowed, classifyUserAgent, normalizeCollectorRequest,
  CollectorRateLimiter, IngestRetryBuffer, mintInternalMarkCode, verifyInternalMarkCode,
} = require('../integrations/landing-collector');
const { registerLandingCollectorRoute, registerLandingInternalMarkRoutes } = require('../integrations/landing-collector-route');
const { landingTokenHash } = require('../integrations/landing-link-token');
const { createRequireAuth } = require('../integrations/dashboard-auth');

const SECRET = 'proxy-signing-secret-for-tests-0123456789';
const SITE = '010e32a7-2fed-4882-bcc9-62004863bc16';
const MARK_SECRET = 'internal-mark-secret-for-tests-0123456789';
const NOW = 1790316000;
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function sign(claims = {}, { secret = SECRET, alg = 'HS256' } = {}) {
  const head = b64({ alg, typ: 'JWT' });
  const body = b64({ iss: 'netlify', netlify_id: SITE, deploy_context: 'production', site_url: 'https://scalelabai.ca', exp: NOW + 300, ...claims });
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${head}.${body}.${sig}`;
}
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv';
const SID = '3b241101-e2bb-4255-8caf-4136c566a962';
const PLID = '9f1c7e2a-5b3d-4c8e-a1f0-2d4b6e8a0c13';
const eventsBody = (over = {}) => ({ v: 1, kind: 'events', t: TOKEN, sid: SID, plid: PLID, vp: 'd', ev: [{ n: 'page_load', s: 1, ms: 40, p: { visible: true } }], ...over });

test('Netlify signature: only a valid production forward of this site passes', () => {
  const opts = { secret: SECRET, siteId: SITE, nowSeconds: NOW };
  assert.equal(verifyNetlifySignature(sign(), opts).ok, true);
  assert.equal(verifyNetlifySignature(sign({ exp: NOW - 20 }), opts).ok, true, 'inside the clock skew');
  const refused = {
    wrongSecret: sign({}, { secret: 'other' }), alg: sign({}, { alg: 'none' }), site: sign({ netlify_id: 'x' }),
    preview: sign({ deploy_context: 'deploy-preview' }), expired: sign({ exp: NOW - 600 }), issuer: sign({ iss: 'someone' }),
    malformed: 'abc', empty: '',
  };
  for (const [name, header] of Object.entries(refused)) assert.equal(verifyNetlifySignature(header, opts).ok, false, name);
  assert.equal(verifyNetlifySignature(sign(), { nowSeconds: NOW }).ok, false, 'unconfigured');
});

test('origin allowlist and user-agent classes', () => {
  assert.ok(originAllowed('https://scalelabai.ca') && originAllowed('https://www.scalelabai.ca'));
  for (const bad of ['', 'null', 'https://evil.example', 'http://scalelabai.ca']) assert.equal(originAllowed(bad), false);
  const chrome = classifyUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36');
  assert.deepEqual(chrome, { browser: 'chrome', major: 140, os: 'windows', deviceClass: 'desktop', headless: false, declaredBot: false });
  const headless = classifyUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36');
  assert.deepEqual([headless.browser, headless.headless, headless.os], ['chrome', true, 'linux']);
  const iphone = classifyUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1');
  assert.deepEqual([iphone.browser, iphone.os, iphone.deviceClass], ['safari', 'ios', 'mobile']);
  assert.equal(classifyUserAgent('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)').deviceClass, 'tablet');
  assert.equal(classifyUserAgent('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/140.0 Safari/537.36 Edg/140.0').browser, 'edge');
  assert.equal(classifyUserAgent('curl/8.4.0').declaredBot, true);
});

test('request schema: strict ids, token format, event and property allowlists', () => {
  assert.equal(normalizeCollectorRequest('{nope').ok, false);
  assert.equal(normalizeCollectorRequest(JSON.stringify({ v: 2 })).ok, false);
  assert.equal(normalizeCollectorRequest(JSON.stringify(eventsBody({ sid: 'not-a-uuid' }))).ok, false);
  assert.equal(normalizeCollectorRequest(JSON.stringify(eventsBody({ t: 'short' }))).ok, false);
  assert.equal(normalizeCollectorRequest(JSON.stringify(eventsBody({ ev: Array.from({ length: 21 }, (_, s) => ({ n: 'visible', s })) }))).ok, false);
  const anonymous = normalizeCollectorRequest(JSON.stringify(eventsBody({ t: null })));
  assert.deepEqual([anonymous.ok, anonymous.collect], [true, false]);
  const internalNoToken = normalizeCollectorRequest(JSON.stringify(eventsBody({ t: null, internal: true, debug: true })));
  assert.deepEqual([internalNoToken.collect, internalNoToken.payload.token_hash, internalNoToken.payload.is_internal, internalNoToken.payload.is_debug], [true, null, true, true]);
  const debugWithoutInternal = normalizeCollectorRequest(JSON.stringify(eventsBody({ debug: true })));
  assert.equal(debugWithoutInternal.payload.is_debug, false);
  const mixed = normalizeCollectorRequest(JSON.stringify(eventsBody({ ev: [
    { n: 'page_load', s: 1, p: { visible: true, email: 'x@y.z', extra: 1 } },
    { n: 'not_an_event', s: 2 },
    { n: 'scroll_depth', s: 3, p: { pct: 33, mode: 'jump' } },
    { n: 'interaction', s: 4, tr: true, ua: true, p: { kind: 'pointer' } },
    { n: 'booking_cta_click', s: 5, tr: true, p: { cta_location: 'hero' } },
  ] })));
  assert.equal(mixed.payload.token_hash, landingTokenHash(TOKEN));
  assert.deepEqual(mixed.payload.events.map(e => e.event_name), ['page_load', 'scroll_depth', 'interaction', 'booking_cta_click']);
  assert.deepEqual(mixed.payload.events[0].props, { visible: true });
  assert.deepEqual(mixed.payload.events[1].props, { mode: 'jump' });
  assert.deepEqual([mixed.payload.events[2].is_trusted, mixed.payload.events[2].user_activated], [true, true]);
  assert.equal(JSON.stringify(mixed.payload).includes(TOKEN), false, 'the raw token never leaves the collector');
  assert.deepEqual(normalizeCollectorRequest(JSON.stringify({ v: 1, kind: 'mark', code: 'abc' })), { ok: true, kind: 'mark', code: 'abc' });
});

test('rate limiter: per-client minute window and a global per-second ceiling', () => {
  let now = 0;
  const limiter = new CollectorRateLimiter({ perClientPerMinute: 3, globalPerSecond: 5, now: () => now });
  assert.deepEqual([1, 2, 3, 4].map(() => limiter.allow('a')), [true, true, true, false]);
  assert.deepEqual([limiter.allow('b'), limiter.allow('c'), limiter.allow('d')], [true, true, false], 'global ceiling');
  now = 61000;
  assert.equal(limiter.allow('a'), true, 'window reset');
});

test('retry buffer: bounded, retries transient failures once, drops the rest', async () => {
  let now = 0;
  const buffer = new IngestRetryBuffer({ maxItems: 2, maxAttempts: 2, maxAgeMs: 1000, now: () => now });
  buffer.add({ n: 1 }); buffer.add({ n: 2 }); buffer.add({ n: 3 });
  assert.deepEqual(buffer.items.map(i => i.payload.n), [2, 3]);
  const seen = [];
  await buffer.drain(async p => { seen.push(p.n); return { ok: false, status: 0 }; });
  assert.deepEqual(seen, [2, 3]);
  assert.equal(buffer.items.length, 0, 'second attempt is the last');
  buffer.add({ n: 4 }); now = 5000;
  await buffer.drain(async () => { throw new Error('must not be called for an expired item'); });
  assert.equal(buffer.items.length, 0);
});

test('internal mark codes: short-lived, single use, signed, purpose-bound', () => {
  const { code, expiresAt } = mintInternalMarkCode({ secret: MARK_SECRET, nowSeconds: NOW });
  assert.match(code, /^v1\.\d{10}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(expiresAt, new Date((NOW + 300) * 1000).toISOString());
  const used = new Map();
  assert.equal(verifyInternalMarkCode(code, { secret: MARK_SECRET, used, nowSeconds: NOW + 10 }).ok, true);
  assert.equal(verifyInternalMarkCode(code, { secret: MARK_SECRET, used, nowSeconds: NOW + 11 }).reason, 'already used');
  const fresh = mintInternalMarkCode({ secret: MARK_SECRET, nowSeconds: NOW }).code;
  assert.equal(verifyInternalMarkCode(fresh, { secret: MARK_SECRET, used: new Map(), nowSeconds: NOW + 301 }).reason, 'expired');
  assert.equal(verifyInternalMarkCode(fresh, { secret: 'wrong', used: new Map(), nowSeconds: NOW }).reason, 'bad signature');
  assert.equal(verifyInternalMarkCode(fresh.replace(/\.\d{10}\./, `.${NOW + 9999}.`), { secret: MARK_SECRET, used: new Map(), nowSeconds: NOW }).reason, 'bad signature');
  assert.equal(verifyInternalMarkCode('sl-internal', { secret: MARK_SECRET, used: new Map(), nowSeconds: NOW }).reason, 'malformed code');
  assert.throws(() => mintInternalMarkCode({}), /not configured/);
});

async function withApp(configure, run) {
  const app = express();
  const collector = configure(app);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try { await run(`http://127.0.0.1:${server.address().port}`, collector); } finally { await new Promise(resolve => server.close(resolve)); }
}
const ENABLED = { LANDING_COLLECTOR_ENABLED: 'true', LANDING_PROXY_SIGNING_SECRET: SECRET, LANDING_PROXY_SITE_ID: SITE, LANDING_INTERNAL_MARK_SECRET: MARK_SECRET };
const silent = { warn() {}, log() {}, error() {} };
const post = (base, body, headers = {}) => fetch(`${base}/api/landing/e`, {
  method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: { 'content-type': 'text/plain;charset=UTF-8', origin: 'https://scalelabai.ca', 'x-nf-sign': sign(), 'x-nf-client-connection-ip': '2001:db8::1', ...headers },
});

test('collector route: silent 204s, one ingest per valid batch, nothing identifying in the payload', async () => {
  const calls = [];
  const ingest = async payload => { calls.push(payload); return { ok: true, status: 200 }; };
  await withApp(app => registerLandingCollectorRoute(app, { env: ENABLED, ingest, nowMs: () => NOW * 1000, logger: silent }), async (base, collector) => {
    const ok = await post(base, eventsBody(), {
      cookie: '_ga=GA1.1.123.456; _ga_MGQJVCVWFZ=GS2.1.s1', referer: `https://scalelabai.ca/staffing/?t=${TOKEN}`,
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('set-cookie'), null);
    assert.equal(calls.length, 1);
    const serialised = JSON.stringify(calls[0]);
    for (const secret of [TOKEN, '_ga', 'GA1.1', '2001:db8', 'referer', 'Mozilla/5.0']) assert.equal(serialised.includes(secret), false, secret);
    assert.deepEqual([calls[0].ua_browser, calls[0].ua_major, calls[0].device_class], ['chrome', 140, 'desktop']);
    for (const [headers, label] of [[{ 'x-nf-sign': '' }, 'unsigned'], [{ 'x-nf-sign': sign({ deploy_context: 'deploy-preview' }) }, 'preview'], [{ origin: 'https://evil.example' }, 'origin']]) {
      assert.equal((await post(base, eventsBody(), headers)).status, 204, label);
    }
    assert.equal((await post(base, eventsBody({ t: null }))).status, 204);
    assert.equal((await post(base, '{"v":1,"kind":"events","padding":"' + 'x'.repeat(3000) + '"}')).status, 204, 'oversized body');
    assert.equal(calls.length, 1, 'no other request reached ingest');
    assert.deepEqual([collector.counters.unsigned, collector.counters.badOrigin, collector.counters.notCollected], [2, 1, 1]);
  });
});

test('collector route: disabled flag is a no-op; transient failures queue one retry, permanent ones do not', async () => {
  let calls = 0;
  await withApp(app => registerLandingCollectorRoute(app, { env: { ...ENABLED, LANDING_COLLECTOR_ENABLED: 'false' }, ingest: async () => { calls += 1; return { ok: true }; }, nowMs: () => NOW * 1000, logger: silent }), async base => {
    assert.equal((await post(base, eventsBody())).status, 204);
  });
  assert.equal(calls, 0);
  const results = [{ ok: false, status: 0, error: 'timeout after 1000ms' }, { ok: false, status: 400, error: 'HTTP 400' }];
  await withApp(app => registerLandingCollectorRoute(app, { env: ENABLED, ingest: async () => results.shift(), nowMs: () => NOW * 1000, logger: silent }), async (base, collector) => {
    assert.equal((await post(base, eventsBody())).status, 204);
    assert.equal(collector.retry.items.length, 1);
    assert.equal((await post(base, eventsBody({ plid: '1f1c7e2a-5b3d-4c8e-a1f0-2d4b6e8a0c13' }))).status, 204);
    assert.equal(collector.retry.items.length, 1, 'a 400 is not retried');
  });
});

test('collector route: a verified mark code is the only non-204 answer, once', async () => {
  await withApp(app => registerLandingCollectorRoute(app, { env: ENABLED, ingest: async () => ({ ok: true }), nowMs: () => NOW * 1000, logger: silent }), async base => {
    const { code } = mintInternalMarkCode({ secret: MARK_SECRET, nowSeconds: NOW });
    const first = await post(base, { v: 1, kind: 'mark', code });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { marked: true });
    assert.equal(first.headers.get('cache-control'), 'no-store');
    assert.equal((await post(base, { v: 1, kind: 'mark', code })).status, 204);
    assert.equal((await post(base, { v: 1, kind: 'mark', code: 'guess' })).status, 204);
  });
});

test('dashboard mark endpoint: authenticated, short-lived code, clear link', async () => {
  const deny = (req, res, next) => (req.get('authorization') === 'ok' ? next() : res.status(401).end());
  await withApp(app => registerLandingInternalMarkRoutes(app, deny, { env: ENABLED, nowMs: () => NOW * 1000 }), async base => {
    assert.equal((await fetch(`${base}/api/landing/internal-mark`)).status, 401);
    const response = await fetch(`${base}/api/landing/internal-mark`, { headers: { authorization: 'ok' } });
    const data = await response.json();
    assert.match(data.url, /^https:\/\/scalelabai\.ca\/staffing\/#sl-mark=v1\./);
    assert.equal(data.clearUrl, 'https://scalelabai.ca/staffing/#sl-mark=off');
    assert.equal(verifyInternalMarkCode(data.url.split('#sl-mark=')[1], { secret: MARK_SECRET, used: new Map(), nowSeconds: NOW }).ok, true);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(`${base}/api/landing/collector-health`, { headers: { authorization: 'ok' } })).status, 200);
  });
  await withApp(app => registerLandingInternalMarkRoutes(app, (req, res, next) => next(), { env: {} }), async base => {
    assert.equal((await fetch(`${base}/api/landing/internal-mark`)).status, 503);
  });
});

test('collector path: every method but POST is a bare 405 before dashboard auth; nothing else changes', async () => {
  const calls = [];
  let smartlead = 0;
  await withApp(app => {
    // The same order as server.js, with the real dashboard authentication.
    app.post('/api/webhooks/smartlead', express.raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
      smartlead += 1;
      res.status(Buffer.isBuffer(req.body) ? 200 : 500).end();
    });
    const collector = registerLandingCollectorRoute(app, { env: ENABLED, ingest: async payload => { calls.push(payload); return { ok: true }; }, nowMs: () => NOW * 1000, logger: silent });
    app.use(express.json({ limit: '10mb' }));
    app.use(createRequireAuth({ getUser: () => 'operator', getPassword: () => 'correct horse battery staple' }));
    registerLandingInternalMarkRoutes(app, (req, res, next) => next(), { env: ENABLED, nowMs: () => NOW * 1000, collector });
    app.get('/api/leads', (req, res) => res.json({ leads: [] }));
    app.post('/api/echo', (req, res) => res.json({ parsed: req.body }));
    return collector;
  }, async base => {
    for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      for (const suffix of ['/api/landing/e', '/api/landing/e/?x=1']) {
        const response = await fetch(`${base}${suffix}`, { method });
        assert.equal(response.status, 405, `${method} ${suffix}`);
        assert.equal(response.headers.get('allow'), 'POST');
        assert.equal(response.headers.get('www-authenticate'), null, `${method} must not challenge`);
        assert.equal(response.headers.get('set-cookie'), null);
        assert.equal(await response.text(), '');
      }
    }
    assert.equal((await post(base, eventsBody())).status, 204, 'POST still reaches the collector');
    assert.equal(calls.length, 1);

    const leads = await fetch(`${base}/api/leads`);
    assert.equal(leads.status, 401, 'dashboard paths stay protected');
    assert.match(leads.headers.get('www-authenticate'), /^Basic /);
    assert.equal((await fetch(`${base}/api/landing/internal-mark`)).status, 401);
    assert.equal((await fetch(`${base}/api/landing/collector-health`)).status, 401);
    const basic = `Basic ${Buffer.from('operator:correct horse battery staple').toString('base64')}`;
    assert.equal((await fetch(`${base}/api/leads`, { headers: { authorization: basic } })).status, 200);
    const echo = await fetch(`${base}/api/echo`, { method: 'POST', body: '{"a":1}', headers: { authorization: basic, 'content-type': 'application/json' } });
    assert.deepEqual(await echo.json(), { parsed: { a: 1 } }, 'the JSON parser still applies after the collector');
    const hook = await fetch(`${base}/api/webhooks/smartlead`, { method: 'POST', body: '{"event":"x"}', headers: { 'content-type': 'application/json' } });
    assert.equal(hook.status, 200, 'Smartlead still receives its raw body without auth');
    assert.equal(smartlead, 1);
  });
});

test('server.js: Smartlead webhook and collector before the JSON parser and dashboard auth; mark routes after auth', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
  const smartlead = server.indexOf("app.post('/api/webhooks/smartlead', express.raw(");
  const collector = server.indexOf('registerLandingCollectorRoute(app)');
  const json = server.indexOf("app.use(express.json({ limit: '10mb' }))");
  const auth = server.indexOf('app.use(requireAuth);');
  const mark = server.indexOf('registerLandingInternalMarkRoutes(app, requireAuth');
  assert.ok(smartlead > 0 && smartlead < collector && collector < json && json < auth && auth < mark);
});
