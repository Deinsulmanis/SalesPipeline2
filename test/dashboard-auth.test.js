'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  timingSafeEqualString, credentialsConfigured, credentialsMatch, decodeBasicAuth,
  clientKey, createAuthAttemptGuard, createRequireAuth,
} = require('../integrations/dashboard-auth');

test('blank or missing dashboard credentials never match', () => {
  assert.equal(credentialsConfigured('', 'secret'), false);
  assert.equal(credentialsConfigured('admin', ''), false);
  assert.equal(credentialsConfigured(undefined, undefined), false);
  assert.equal(credentialsMatch({
    suppliedUser: '', suppliedPass: '', expectedUser: '', expectedPass: '',
  }), false);
  assert.equal(credentialsMatch({
    suppliedUser: 'admin', suppliedPass: 'secret', expectedUser: '', expectedPass: '',
  }), false);
});

test('credential comparison is timing-safe and requires both sides', () => {
  assert.equal(timingSafeEqualString('abc', 'abc'), true);
  assert.equal(timingSafeEqualString('abc', 'ab'), false);
  assert.equal(timingSafeEqualString('abc', 'abd'), false);
  assert.equal(credentialsMatch({
    suppliedUser: 'admin', suppliedPass: 'secret', expectedUser: 'admin', expectedPass: 'secret',
  }), true);
  assert.equal(credentialsMatch({
    suppliedUser: 'admin', suppliedPass: 'wrong', expectedUser: 'admin', expectedPass: 'secret',
  }), false);
});

test('Basic Auth decoding keeps passwords that contain a colon', () => {
  const header = `Basic ${Buffer.from('admin:foo:bar').toString('base64')}`;
  assert.deepEqual(decodeBasicAuth(header), { user: 'admin', pass: 'foo:bar' });
  assert.deepEqual(decodeBasicAuth(''), { user: '', pass: '' });
});

test('repeated failures block the client without external infrastructure', () => {
  let now = 1_000;
  const guard = createAuthAttemptGuard({ maxFailures: 3, windowMs: 10_000, blockMs: 5_000, now: () => now });
  assert.equal(guard.inspect('1.1.1.1').blocked, false);
  assert.equal(guard.recordFailure('1.1.1.1').blocked, false);
  assert.equal(guard.recordFailure('1.1.1.1').blocked, false);
  const blocked = guard.recordFailure('1.1.1.1');
  assert.equal(blocked.blocked, true);
  assert.ok(blocked.retryAfterSec >= 1);
  now += 4_000;
  assert.equal(guard.inspect('1.1.1.1').blocked, true);
  now += 2_000;
  assert.equal(guard.inspect('1.1.1.1').blocked, false);
});

test('blank env credentials never grant HTTP access, including empty Basic Auth', () => {
  const requireAuth = createRequireAuth({ getUser: () => '', getPassword: () => '' });
  let nextCalled = false;
  const req = { path: '/', ip: '10.0.0.1', headers: { authorization: `Basic ${Buffer.from(':').toString('base64')}` } };
  const res = mockRes();
  requireAuth(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body, 'Unauthorized');
});

test('valid credentials pass and a throttled client is refused closed', () => {
  let now = 0;
  const requireAuth = createRequireAuth({
    getUser: () => 'admin',
    getPassword: () => 'secret',
    attemptGuard: { maxFailures: 2, windowMs: 60_000, blockMs: 60_000, now: () => now },
  });
  const okReq = {
    path: '/', socket: { remoteAddress: '10.0.0.8' },
    headers: { authorization: `Basic ${Buffer.from('admin:secret').toString('base64')}` },
  };
  const okRes = mockRes();
  let allowed = false;
  requireAuth(okReq, okRes, () => { allowed = true; });
  assert.equal(allowed, true);

  const badReq = {
    path: '/', socket: { remoteAddress: '10.0.0.9' },
    headers: { authorization: `Basic ${Buffer.from('admin:wrong').toString('base64')}` },
  };
  requireAuth(badReq, mockRes(), () => {});
  const blockedRes = mockRes();
  let blockedNext = false;
  requireAuth(badReq, blockedRes, () => { blockedNext = true; });
  assert.equal(blockedNext, false);
  assert.equal(blockedRes.statusCode, 429);
  assert.ok(Number(blockedRes.headers['Retry-After']) >= 1);
});

test('an untrusted X-Forwarded-For value cannot bypass the failure throttle', () => {
  const requireAuth = createRequireAuth({
    getUser: () => 'admin',
    getPassword: () => 'secret',
    attemptGuard: { maxFailures: 2, windowMs: 60_000, blockMs: 60_000 },
  });
  const peer = { remoteAddress: '100.64.0.10' };
  const bad = `Basic ${Buffer.from('admin:wrong').toString('base64')}`;
  assert.equal(clientKey({
    socket: peer, ip: '1.1.1.1',
    headers: { 'x-forwarded-for': '8.8.8.8', 'x-real-ip': '203.0.113.9' },
  }), clientKey({
    socket: peer, ip: '9.9.9.9',
    headers: { 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '203.0.113.9' },
  }));
  requireAuth({
    path: '/', socket: peer,
    headers: { authorization: bad, 'x-forwarded-for': '8.8.8.8', 'x-real-ip': '203.0.113.9' },
  }, mockRes(), () => {});
  const blockedRes = mockRes();
  let blockedNext = false;
  requireAuth({
    path: '/', socket: peer,
    headers: { authorization: bad, 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '203.0.113.9' },
  }, blockedRes, () => { blockedNext = true; });
  assert.equal(blockedNext, false);
  assert.equal(blockedRes.statusCode, 429);
});

test('readiness-token bypass remains independent of Basic Auth throttling', () => {
  const requireAuth = createRequireAuth({
    getUser: () => 'admin',
    getPassword: () => 'secret',
    attemptGuard: { maxFailures: 1, windowMs: 60_000, blockMs: 60_000 },
    bypass: req => req.path.startsWith('/api/internal/gmail-')
      && req.headers.authorization === 'Bearer ready',
  });
  const peer = { remoteAddress: '10.0.0.4' };
  requireAuth({
    path: '/', socket: peer,
    headers: { authorization: `Basic ${Buffer.from('admin:wrong').toString('base64')}` },
  }, mockRes(), () => {});
  let allowed = false;
  requireAuth({
    path: '/api/internal/gmail-status', socket: peer,
    headers: { authorization: 'Bearer ready' },
  }, mockRes(), () => { allowed = true; });
  assert.equal(allowed, true);
  const blockedRes = mockRes();
  requireAuth({
    path: '/', socket: peer,
    headers: { authorization: `Basic ${Buffer.from('admin:secret').toString('base64')}` },
  }, blockedRes, () => {});
  assert.equal(blockedRes.statusCode, 429);
});

test('server.js uses the fail-closed dashboard auth helper', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const helper = fs.readFileSync(path.join(__dirname, '..', 'integrations', 'dashboard-auth.js'), 'utf8');
  assert.match(server, /createRequireAuth\(/);
  assert.doesNotMatch(server, /user === process\.env\.DASHBOARD_USER && pass === process\.env\.DASHBOARD_PASSWORD/);
  assert.match(helper, /x-real-ip/);
  assert.doesNotMatch(helper, /headers\?\.\[.x-forwarded-for.\]/i);
  assert.match(server, /bypass: req => req\.path\.startsWith\('\/api\/internal\/gmail-'\)/);
});

function mockRes() {
  const res = { headers: {}, statusCode: 200, body: '' };
  res.setHeader = (key, value) => { res.headers[key] = value; };
  res.status = code => { res.statusCode = code; return res; };
  res.send = body => { res.body = body; return res; };
  return res;
}
