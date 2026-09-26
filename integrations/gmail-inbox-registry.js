'use strict';

const { google } = require('googleapis');
const { DEFAULT_INBOX_DAILY_LIMIT, DEFAULT_INBOX_PER_RUN_LIMIT } = require('./gmail-sender-capacity');

const STATUSES = new Set(['warming', 'ready', 'active', 'paused', 'error']);

// scalelabaiteam.com exists only for US staffing-agency outreach. It is
// staffing-only by identity, not just by flag, so a GMAIL_INBOX_REGISTRY_JSON
// override that omits staffingOnly can never widen it to other niches.
const STAFFING_ONLY_SENDER_IDS = Object.freeze(['scalelabaiteam']);
const STAFFING_ONLY_SENDER_EMAILS = Object.freeze(['deins@scalelabaiteam.com']);

function isStaffingOnlySender(sender = {}) {
  return sender?.staffingOnly === true
    || STAFFING_ONLY_SENDER_IDS.includes(String(sender?.id || '').trim())
    || STAFFING_ONLY_SENDER_EMAILS.includes(String(sender?.email || '').trim().toLowerCase());
}

const DEFAULT_SECONDARY_INBOXES = Object.freeze([
  Object.freeze({
    id: 'scalelabaiteam',
    email: 'deins@scalelabaiteam.com',
    status: 'warming',
    tokenEnv: 'GMAIL_SCALELABAITEAM_TOKEN_JSON',
    dailyLimit: DEFAULT_INBOX_DAILY_LIMIT,
    perRunLimit: DEFAULT_INBOX_PER_RUN_LIMIT,
    observerEnabled: true,
    staffingOnly: true,
  }),
  // New mailbox on the established scalelabai.ca domain. Smartlead warms it
  // independently; campaign sends use this Gmail sender only after the
  // operator activates it behind the healthy-observer gate. Conservative
  // caps: 20/day (raised from 10 on 2026-09-24) spread at 2 per window, so the
  // ten weekday windows are its whole day. Raise them by hand.
  Object.freeze({
    id: 'deniels',
    email: 'deniels@scalelabai.ca',
    status: 'warming',
    tokenEnv: 'GMAIL_DENIELS_TOKEN_JSON',
    dailyLimit: 20,
    perRunLimit: 2,
    observerEnabled: true,
  }),
  // Second mailbox on tryscalelabai.ca, same pattern and caps as deniels:
  // 20/day (raised from 10 on 2026-09-24) at 2 per window.
  Object.freeze({
    id: 'deniels_tryscalelabai',
    email: 'deniels@tryscalelabai.ca',
    status: 'warming',
    tokenEnv: 'GMAIL_DENIELS_TRYSCALELABAI_TOKEN_JSON',
    dailyLimit: 20,
    perRunLimit: 2,
    observerEnabled: true,
  }),
]);

function parseEntry(entry, index, seenIds, seenEmails) {
  const id = String(entry?.id || '').trim();
  const email = String(entry?.email || '').trim().toLowerCase();
  const status = String(entry?.status || 'warming').trim().toLowerCase();
  const tokenEnv = String(entry?.tokenEnv || '').trim();
  const dailyLimit = Number(entry?.dailyLimit ?? 0);
  const perRunLimit = Number(entry?.perRunLimit ?? DEFAULT_INBOX_PER_RUN_LIMIT);
  const observerEnabled = entry?.observerEnabled !== false;
  const staffingOnly = entry?.staffingOnly === true;
  if (!id || !/^[a-z0-9_-]+$/i.test(id)) throw new Error(`Gmail inbox entry ${index + 1} has an invalid id`);
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error(`Gmail inbox ${id} has an invalid email`);
  if (!STATUSES.has(status)) throw new Error(`Gmail inbox ${id} has an invalid status`);
  if (tokenEnv === 'GMAIL_TOKEN_JSON') throw new Error(`Gmail inbox ${id} cannot reuse the live primary token variable`);
  if (!/^GMAIL_[A-Z0-9_]+_TOKEN_JSON$/.test(tokenEnv)) throw new Error(`Gmail inbox ${id} has an invalid tokenEnv`);
  if (!Number.isInteger(dailyLimit) || dailyLimit < 0) throw new Error(`Gmail inbox ${id} has an invalid dailyLimit`);
  if (!Number.isInteger(perRunLimit) || perRunLimit < 0) throw new Error(`Gmail inbox ${id} has an invalid perRunLimit`);
  if (seenIds.has(id) || seenEmails.has(email)) throw new Error(`Duplicate Gmail inbox entry: ${id}`);
  seenIds.add(id); seenEmails.add(email);
  return Object.freeze({
    id, email, status, tokenEnv, dailyLimit, perRunLimit, observerEnabled, provider: 'gmail',
    ...(staffingOnly ? { staffingOnly } : {}),
  });
}

function parseRegistry(raw = process.env.GMAIL_INBOX_REGISTRY_JSON || '[]') {
  let entries;
  try { entries = JSON.parse(raw || '[]'); } catch (_) { throw new Error('GMAIL_INBOX_REGISTRY_JSON must be valid JSON'); }
  if (!Array.isArray(entries)) throw new Error('GMAIL_INBOX_REGISTRY_JSON must be a JSON array');
  const seenIds = new Set();
  const seenEmails = new Set();
  return entries.map((entry, index) => parseEntry(entry, index, seenIds, seenEmails));
}

function withDefaultInboxes(entries = []) {
  const seenIds = new Set(entries.map(entry => entry.id));
  const seenEmails = new Set(entries.map(entry => entry.email));
  const extras = [];
  for (const def of DEFAULT_SECONDARY_INBOXES) {
    if (seenIds.has(def.id) || seenEmails.has(def.email)) continue;
    extras.push(parseEntry(def, entries.length + extras.length, seenIds, seenEmails));
  }
  return [...entries, ...extras];
}

function sendEligibleFor(entry, env = process.env) {
  const credentialConfigured = entry.id === 'primary'
    ? Boolean(env.GMAIL_TOKEN_JSON || entry.credentialConfigured)
    : Boolean(env[entry.tokenEnv] || entry.credentialConfigured);
  return entry.status === 'active' && entry.dailyLimit > 0 && credentialConfigured;
}

function publicRegistry(entries, env = process.env) {
  return entries.map(entry => ({
    id: entry.id, email: entry.email, status: entry.status,
    dailyLimit: entry.dailyLimit, perRunLimit: entry.perRunLimit ?? DEFAULT_INBOX_PER_RUN_LIMIT,
    observerEnabled: entry.observerEnabled !== false, provider: 'gmail',
    credentialConfigured: Boolean(env[entry.tokenEnv]),
    sendEligible: sendEligibleFor(entry, env),
  }));
}

function assertDormant(entry) {
  if (entry.status !== 'warming' || sendEligibleFor(entry, {})) {
    throw new Error(`${entry.email} is not locked in warming mode`);
  }
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
  return verifyMailboxAccess({
    gmail, expectedEmail: entry.email,
    result: {
      status: entry.status, dailyLimit: entry.dailyLimit, perRunLimit: entry.perRunLimit,
      credentialConfigured: true, observerEnabled: entry.observerEnabled !== false,
      sendEligible: entry.status === 'active' && entry.dailyLimit > 0,
    },
  });
}

async function verifyMailboxAccess({ gmail, expectedEmail, result = {} } = {}) {
  if (!gmail || !expectedEmail) throw new Error('Gmail client and expected mailbox identity are required');
  const profile = await gmail.users.getProfile({ userId: 'me' });
  const authenticatedEmail = String(profile.data.emailAddress || '').trim().toLowerCase();
  const expected = String(expectedEmail).trim().toLowerCase();
  if (authenticatedEmail !== expected) throw new Error(`Credential belongs to ${authenticatedEmail || 'an unknown account'}, not ${expected}`);
  const listed = await gmail.users.messages.list({ userId: 'me', maxResults: 1 });
  const first = listed.data.messages?.[0];
  if (first?.id) {
    await gmail.users.messages.get({ userId: 'me', id: first.id, format: 'metadata', metadataHeaders: ['From', 'To'] });
  }
  return {
    email: expected, authenticated: true, identityVerified: true,
    messageListAccess: true, messageGetAccess: first?.id ? true : null,
    ...result,
  };
}

function parseRuntimeOverlay(raw = process.env.GMAIL_SENDER_RUNTIME_JSON || '[]') {
  if (!raw) return [];
  let rows;
  try { rows = JSON.parse(raw); } catch (_) { throw new Error('GMAIL_SENDER_RUNTIME_JSON must be valid JSON'); }
  if (!Array.isArray(rows)) throw new Error('GMAIL_SENDER_RUNTIME_JSON must be a JSON array');
  return rows.map((row, index) => {
    const id = String(row?.id || row?.senderInboxId || '').trim();
    const status = String(row?.status || '').trim().toLowerCase();
    if (!id) throw new Error(`Gmail sender runtime row ${index + 1} has an invalid id`);
    if (status && !STATUSES.has(status)) throw new Error(`Gmail sender runtime ${id} has an invalid status`);
    return { id, status };
  }).filter(row => row.status);
}

function applySenderRuntime(senders = [], overlay = []) {
  const byId = new Map((overlay || []).map(row => [String(row.id || '').trim(), row]));
  return senders.map(sender => {
    const patch = byId.get(sender.id);
    if (!patch) return sender;
    const status = String(patch.status || sender.status).trim().toLowerCase();
    return {
      ...sender,
      status,
      sendEligible: status === 'active' && sender.dailyLimit > 0 && sender.credentialConfigured,
    };
  });
}

module.exports = {
  STATUSES, DEFAULT_SECONDARY_INBOXES, STAFFING_ONLY_SENDER_IDS, isStaffingOnlySender,
  parseRegistry, withDefaultInboxes, publicRegistry, assertDormant,
  credentialsFor, verifyInbox, verifyMailboxAccess, sendEligibleFor,
  parseRuntimeOverlay, applySenderRuntime,
};
