'use strict';

const crypto = require('crypto');

// Explicit provider-boundary send authorization (EC-1).
//
// SENDING_ENABLED remains a required gate. It is no longer sufficient.
// A process that inherits production Gmail/Sheets credentials still cannot
// send unless it is independently identified as the intended production sender.
//
// The repository does not record the production value of RAILWAY_ENVIRONMENT
// (it is only tested for presence). Do NOT hardcode "production". Operators
// must set SEND_AUTHORIZED_ENV to the exact RAILWAY_ENVIRONMENT value of the
// intended sender service, then confirm that value before any deploy.
//
// Required conjunction — every item fail-closed, no default allow:
//   1. SENDING_ENABLED=true
//   2. SEND_AUTHORIZED_ENV is non-empty
//   3. RAILWAY_ENVIRONMENT equals SEND_AUTHORIZED_ENV
//   4. SEND_AUTHORIZED_TOKEN is non-empty
//   5. SEND_WORKER_ROLE=outreach-sender
//   6. SEND_LOCK_ENABLED=true (authorized production sender cannot use the
//      pre-activation unlocked path)
//
// Confirm before production deploy (do not set from this change):
//   SEND_AUTHORIZED_ENV   = <exact production RAILWAY_ENVIRONMENT>
//   SEND_AUTHORIZED_TOKEN = <secret present only on the intended sender>
//   SEND_WORKER_ROLE      = outreach-sender
//
// Reasons never include secret values.

const SENDING_ENABLED_VAR = 'SENDING_ENABLED';
const AUTHORIZED_ENV_VAR = 'SEND_AUTHORIZED_ENV';
const AUTHORIZED_TOKEN_VAR = 'SEND_AUTHORIZED_TOKEN';
const WORKER_ROLE_VAR = 'SEND_WORKER_ROLE';
const RAILWAY_ENV_VAR = 'RAILWAY_ENVIRONMENT';
const LOCK_ENABLED_VAR = 'SEND_LOCK_ENABLED';
const REQUIRED_WORKER_ROLE = 'outreach-sender';

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

function sendAuthorization(env = process.env) {
  const sendingEnabled = String(env[SENDING_ENABLED_VAR] || '') === 'true';
  if (!sendingEnabled) {
    return { allowed: false, code: 'sending_disabled', reason: 'sending is disabled' };
  }

  const expectedEnv = String(env[AUTHORIZED_ENV_VAR] || '').trim();
  if (!expectedEnv) {
    return {
      allowed: false, code: 'send_unauthorized',
      reason: `${AUTHORIZED_ENV_VAR} is not configured`,
    };
  }

  const actualEnv = String(env[RAILWAY_ENV_VAR] || '').trim();
  if (!actualEnv) {
    return {
      allowed: false, code: 'send_unauthorized',
      reason: `${RAILWAY_ENV_VAR} is not set`,
    };
  }
  if (!timingSafeEqualString(actualEnv, expectedEnv)) {
    return {
      allowed: false, code: 'send_unauthorized',
      reason: 'process is not the authorized send environment',
    };
  }

  const token = String(env[AUTHORIZED_TOKEN_VAR] || '').trim();
  if (!token) {
    return {
      allowed: false, code: 'send_unauthorized',
      reason: `${AUTHORIZED_TOKEN_VAR} is not configured`,
    };
  }

  const role = String(env[WORKER_ROLE_VAR] || '').trim();
  if (!timingSafeEqualString(role, REQUIRED_WORKER_ROLE)) {
    return {
      allowed: false, code: 'send_unauthorized',
      reason: `${WORKER_ROLE_VAR} is not ${REQUIRED_WORKER_ROLE}`,
    };
  }

  if (String(env[LOCK_ENABLED_VAR] || '').trim().toLowerCase() !== 'true') {
    return {
      allowed: false, code: 'send_lock_required',
      reason: 'authorized sender requires SEND_LOCK_ENABLED=true',
    };
  }

  return { allowed: true, code: '', reason: '' };
}

function assertSendAuthorized(env = process.env) {
  const verdict = sendAuthorization(env);
  if (!verdict.allowed) {
    const error = new Error(verdict.reason);
    error.code = verdict.code;
    throw error;
  }
  return verdict;
}

module.exports = {
  SENDING_ENABLED_VAR, AUTHORIZED_ENV_VAR, AUTHORIZED_TOKEN_VAR, WORKER_ROLE_VAR,
  RAILWAY_ENV_VAR, LOCK_ENABLED_VAR, REQUIRED_WORKER_ROLE,
  sendAuthorization, assertSendAuthorized,
};
