'use strict';

const crypto = require('crypto');

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  const len = Math.max(left.length, right.length, 1);
  const paddedLeft = Buffer.alloc(len);
  const paddedRight = Buffer.alloc(len);
  left.copy(paddedLeft);
  right.copy(paddedRight);
  return crypto.timingSafeEqual(paddedLeft, paddedRight) && left.length === right.length;
}

function credentialsConfigured(user, password) {
  return String(user || '').length > 0 && String(password || '').length > 0;
}

function credentialsMatch({ suppliedUser, suppliedPass, expectedUser, expectedPass }) {
  // Blank or missing expected credentials must never authenticate, including
  // the `'' === ''` case when both env vars are empty.
  if (!credentialsConfigured(expectedUser, expectedPass)) return false;
  const userOk = timingSafeEqualString(suppliedUser, expectedUser);
  const passOk = timingSafeEqualString(suppliedPass, expectedPass);
  return userOk && passOk;
}

function decodeBasicAuth(header) {
  const value = String(header || '');
  if (!value.startsWith('Basic ')) return { user: '', pass: '' };
  const decoded = Buffer.from(value.slice(6), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon === -1) return { user: decoded, pass: '' };
  return { user: decoded.slice(0, colon), pass: decoded.slice(colon + 1) };
}

function clientKey(req) {
  // Railway's edge always overwrites X-Real-IP with the connecting client IP
  // and HTTP apps are not reachable except through that proxy. Do not key on
  // X-Forwarded-For: Railway appends the connecting IP, so the leftmost value
  // is client-controlled. Express req.ip is also X-Forwarded-For-derived when
  // trust proxy is enabled, so the TCP peer is the fallback instead.
  const realIp = String(req.headers?.['x-real-ip'] || '').trim();
  if (realIp) return realIp;
  return String(req.socket?.remoteAddress || req.connection?.remoteAddress || req.ip || 'unknown');
}

function createAuthAttemptGuard({
  windowMs = 10 * 60 * 1000,
  maxFailures = 10,
  blockMs = 10 * 60 * 1000,
  now = () => Date.now(),
} = {}) {
  const attempts = new Map();

  function prune(key) {
    const rec = attempts.get(key);
    if (!rec) return null;
    const expiredWindow = rec.resetAt && now() >= rec.resetAt;
    const expiredBlock = !rec.blockedUntil || now() >= rec.blockedUntil;
    if (expiredWindow && expiredBlock) {
      attempts.delete(key);
      return null;
    }
    return rec;
  }

  function inspect(key) {
    const rec = prune(key);
    if (rec && rec.blockedUntil && now() < rec.blockedUntil) {
      return { blocked: true, retryAfterSec: Math.max(1, Math.ceil((rec.blockedUntil - now()) / 1000)) };
    }
    return { blocked: false, retryAfterSec: 0 };
  }

  function recordFailure(key) {
    const rec = prune(key) || { count: 0, resetAt: now() + windowMs, blockedUntil: 0 };
    rec.count += 1;
    if (rec.count >= maxFailures) rec.blockedUntil = now() + blockMs;
    attempts.set(key, rec);
    return inspect(key);
  }

  function recordSuccess(key) {
    attempts.delete(key);
  }

  return { inspect, recordFailure, recordSuccess };
}

function createRequireAuth(options = {}) {
  const getUser = options.getUser || (() => process.env.DASHBOARD_USER);
  const getPassword = options.getPassword || (() => process.env.DASHBOARD_PASSWORD);
  const guard = options.guard || createAuthAttemptGuard(options.attemptGuard);
  const bypass = options.bypass || (() => false);

  return function requireAuth(req, res, next) {
    if (bypass(req)) return next();
    const key = clientKey(req);
    const limited = guard.inspect(key);
    if (limited.blocked) {
      res.setHeader('Retry-After', String(limited.retryAfterSec));
      return res.status(429).send('Too many authentication attempts');
    }
    const { user, pass } = decodeBasicAuth(req.headers?.authorization || '');
    if (credentialsMatch({
      suppliedUser: user,
      suppliedPass: pass,
      expectedUser: getUser(),
      expectedPass: getPassword(),
    })) {
      guard.recordSuccess(key);
      return next();
    }
    const after = guard.recordFailure(key);
    if (after.blocked) {
      res.setHeader('Retry-After', String(after.retryAfterSec));
      return res.status(429).send('Too many authentication attempts');
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="ScaleLab Pipeline"');
    return res.status(401).send('Unauthorized');
  };
}

module.exports = {
  timingSafeEqualString,
  credentialsConfigured,
  credentialsMatch,
  decodeBasicAuth,
  clientKey,
  createAuthAttemptGuard,
  createRequireAuth,
};
