'use strict';

const ENABLED_VAR = 'SEND_LOCK_ENABLED';
const URL_VAR = 'SEND_LOCK_DATABASE_URL';
const LEASE_VAR = 'SEND_LOCK_LEASE_SECONDS';
const DEFAULT_LEASE_SECONDS = 300;

function sendLockEnabled(env = process.env) {
  return String(env[ENABLED_VAR] || '').trim().toLowerCase() === 'true';
}

function sendLockDatabaseUrl(env = process.env) {
  return String(env[URL_VAR] || '').trim();
}

function sendLockLeaseSeconds(env = process.env) {
  const parsed = Number(env[LEASE_VAR]);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LEASE_SECONDS;
  return Math.min(Math.floor(parsed), 3600);
}

function sendLockConfig(env = process.env) {
  const enabled = sendLockEnabled(env);
  const url = sendLockDatabaseUrl(env);
  return {
    enabled,
    configured: Boolean(url),
    leaseSeconds: sendLockLeaseSeconds(env),
    urlVar: URL_VAR,
  };
}

module.exports = {
  ENABLED_VAR, URL_VAR, LEASE_VAR, DEFAULT_LEASE_SECONDS,
  sendLockEnabled, sendLockDatabaseUrl, sendLockLeaseSeconds, sendLockConfig,
};
