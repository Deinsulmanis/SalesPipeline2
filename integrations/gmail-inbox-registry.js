'use strict';

const { google } = require('googleapis');

const STATUSES = new Set(['warming', 'active', 'paused']);

function parseRegistry(raw = process.env.GMAIL_INBOX_REGISTRY_JSON || '[]') {
  let entries;
  try { entries = JSON.parse(raw || '[]'); } catch (_) { throw new Error('GMAIL_INBOX_REGISTRY_JSON must be valid JSON'); }
  if (!Array.isArray(entries)) throw new Error('GMAIL_INBOX_REGISTRY_JSON must be a JSON array');
  const seenIds = new Set();
  const seenEmails = new Set();
  return entries.map((entry, index) => {
    const id = String(entry?.id || '').trim();
    const email = String(entry?.email || '').trim().toLowerCase();
    const status = String(entry?.status || 'warming').trim().toLowerCase();
    const tokenEnv = String(entry?.tokenEnv || '').trim();
    const dailyLimit = Number(entry?.dailyLimit ?? 0);
    if (!id || !/^[a-z0-9_-]+$/i.test(id)) throw new Error(`Gmail inbox entry ${index + 1} has an invalid id`);
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error(`Gmail inbox ${id} has an invalid email`);
    if (!STATUSES.has(status)) throw new Error(`Gmail inbox ${id} has an invalid status`);
    if (tokenEnv === 'GMAIL_TOKEN_JSON') throw new Error(`Gmail inbox ${id} cannot reuse the live primary token variable`);
    if (!/^GMAIL_[A-Z0-9_]+_TOKEN_JSON$/.test(tokenEnv)) throw new Error(`Gmail inbox ${id} has an invalid tokenEnv`);
    if (!Number.isInteger(dailyLimit) || dailyLimit < 0) throw new Error(`Gmail inbox ${id} has an invalid dailyLimit`);
    if (status === 'warming' && dailyLimit !== 0) throw new Error(`Gmail inbox ${id} must have dailyLimit 0 while warming`);
    if (seenIds.has(id) || seenEmails.has(email)) throw new Error(`Duplicate Gmail inbox entry: ${id}`);
    seenIds.add(id); seenEmails.add(email);
    return Object.freeze({ id, email, status, tokenEnv, dailyLimit });
  });
}

function publicRegistry(entries, env = process.env) {
  return entries.map(entry => ({
    id: entry.id, email: entry.email, status: entry.status, dailyLimit: entry.dailyLimit,
    credentialConfigured: Boolean(env[entry.tokenEnv]), sendEligible: entry.status === 'active' && entry.dailyLimit > 0 && Boolean(env[entry.tokenEnv]),
  }));
}

function assertDormant(entry) {
  if (entry.status !== 'warming' || entry.dailyLimit !== 0) throw new Error(`${entry.email} is not locked in warming mode`);
  return true;
}

function credentialsFor(entry, env = process.env) {
  const raw = env[entry.tokenEnv];
  if (!raw) throw new Error(`${entry.tokenEnv} is not configured`);
  let credentials;
  try { credentials = JSON.parse(raw); } catch (_) { throw new Error(`${entry.tokenEnv} must contain valid token JSON`); }
  if (!credentials.refresh_token) throw new Error(`${entry.tokenEnv} is missing a refresh_token`);
  return credentials;
}

async function verifyInbox(entry, options = {}) {
  const env = options.env || process.env;
  const auth = options.auth || new google.auth.OAuth2(env.GMAIL_SECONDARY_GOOGLE_CLIENT_ID, env.GMAIL_SECONDARY_GOOGLE_CLIENT_SECRET, env.GMAIL_SECONDARY_GOOGLE_REDIRECT_URI);
  auth.setCredentials(credentialsFor(entry, env));
  const gmail = options.gmail || google.gmail({ version: 'v1', auth });
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const authenticatedEmail = String(profile.data.emailAddress || '').toLowerCase();
  if (authenticatedEmail !== entry.email) throw new Error(`Credential belongs to ${authenticatedEmail || 'an unknown account'}, not ${entry.email}`);
  return { email: entry.email, status: entry.status, dailyLimit: entry.dailyLimit, credentialConfigured: true, identityVerified: true, sendEligible: entry.status === 'active' && entry.dailyLimit > 0 };
}

module.exports = { parseRegistry, publicRegistry, assertDormant, credentialsFor, verifyInbox };
