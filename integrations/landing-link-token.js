'use strict';

/**
 * Opaque staffing landing-page link tokens, one per link issuance.
 *
 *   issuance_key = "<send action id>|staffing_landing"
 *   token        = base64url(HMAC-SHA256(key[v], CONTEXT + issuance_key))[:16 bytes]
 *
 * 22 URL-safe characters, 128 bits, non-sequential and not reversible without
 * the key. The token carries nothing decodable and is never authentication:
 * the backend stores only its SHA-256 hash.
 *
 * Deterministic on purpose. The send engine re-renders a message to compare it
 * with the locked copy, recovers sends from Gmail by a deterministic
 * Message-ID and never resends an ambiguous attempt. A token derived from the
 * send's own action id renders identically on every retry and recovery, with
 * no database read before the send.
 *
 * PINNING. The first attempt at an action decides whether its link is tracked
 * and with which key version; that decision is written into the attempt's
 * reservation metadata before any provider call. Every later render of the
 * same action (retry, re-render check, recovery) reads the pin first, so key
 * rotation or a flag change can never give one logical send two different
 * URLs. A pinned key version missing from the key ring blocks the send: the
 * token is never re-derived with a different key.
 */

const crypto = require('node:crypto');
const { STAFFING_LANDING_PAGE_URL } = require('./staffing-campaign');
const { FLAG, SECRET, flagEnabled } = require('./landing-attribution-config');

const LINK_SLOT = 'staffing_landing';
const TOKEN_BYTES = 16;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const DERIVATION_CONTEXT = 'scalelab/landing-link/v1\0';
const MIN_KEY_BYTES = 32;

const LANDING_LINK_SOURCE = Object.freeze({ FOLLOWUP_2: 'followup_2', POSITIVE_REPLY: 'positive_reply' });
const PLAN_STATUS = Object.freeze({ UNTRACKED: 'untracked', TRACKED: 'tracked', BLOCKED: 'blocked' });

const base64url = buffer => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const parseMetadata = value => {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '{}')); } catch (_) { return {}; }
};

/** Key ring from the environment. Problems are reported, never thrown. */
function parseLandingKeyring(env = process.env) {
  const keys = new Map();
  const raw = String(env[SECRET.TOKEN_KEYS] || '').trim();
  const fail = error => Object.freeze({ keys, activeVersion: null, error });
  if (!raw) return fail(`${SECRET.TOKEN_KEYS} is not set`);
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { return fail(`${SECRET.TOKEN_KEYS} is not valid JSON`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail(`${SECRET.TOKEN_KEYS} must be a JSON object of version -> base64 key`);
  for (const [version, encoded] of Object.entries(parsed)) {
    if (!/^[1-9]\d{0,3}$/.test(version)) return fail(`key version "${version}" must be a positive integer`);
    const key = Buffer.from(String(encoded || ''), 'base64');
    if (key.length < MIN_KEY_BYTES || key.toString('base64').replace(/=+$/, '') !== String(encoded).replace(/=+$/, '')) {
      return fail(`key version ${version} must be at least ${MIN_KEY_BYTES} bytes of base64`);
    }
    keys.set(Number(version), key);
  }
  if (!keys.size) return fail(`${SECRET.TOKEN_KEYS} has no keys`);
  const active = Number(String(env[SECRET.TOKEN_ACTIVE_VERSION] || '').trim());
  if (!keys.has(active)) return fail(`${SECRET.TOKEN_ACTIVE_VERSION} must name a version in ${SECRET.TOKEN_KEYS}`);
  return Object.freeze({ keys, activeVersion: active, error: null });
}

/**
 * Whether NEW issuances are tracked. The key ring is returned even when the
 * flag is off, so a pinned retry of an earlier tracked action still renders
 * its original URL.
 */
function landingTrackingState(env = process.env) {
  const keyring = parseLandingKeyring(env);
  if (!flagEnabled(FLAG.TRACKING, env)) return Object.freeze({ enabled: false, reason: `${FLAG.TRACKING} is not true`, keyring });
  if (keyring.error) return Object.freeze({ enabled: false, reason: keyring.error, keyring });
  return Object.freeze({ enabled: true, reason: 'ok', keyring });
}

function landingIssuanceKey(actionId) {
  const id = String(actionId || '').trim();
  if (!id) throw new Error('landing link issuance requires a send action id');
  return `${id}|${LINK_SLOT}`;
}

function deriveLandingToken({ issuanceKey, keyVersion, keyring }) {
  const key = keyring?.keys?.get(Number(keyVersion));
  if (!key) throw new Error(`landing link key version ${keyVersion} is not in the key ring`);
  const digest = crypto.createHmac('sha256', key).update(DERIVATION_CONTEXT + issuanceKey).digest();
  return base64url(digest.subarray(0, TOKEN_BYTES));
}

function isLandingToken(value) {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

/** SHA-256 of the token, lowercase hex. The only form the backend stores. */
function landingTokenHash(token) {
  if (!isLandingToken(token)) throw new Error('not a landing link token');
  return crypto.createHash('sha256').update(token).digest('hex');
}

function trackedLandingUrl(token) {
  if (!isLandingToken(token)) throw new Error('not a landing link token');
  return `${STAFFING_LANDING_PAGE_URL}?t=${token}`;
}

/** Earlier attempts at one ordinary cold step, as parsed metadata. */
function coldStepPriorAttempts(activities = [], leadId, step) {
  return (activities || []).filter(row => {
    if (!row) return false;
    const metadata = parseMetadata(row.metadata);
    if (row.eventType === 'ordinary_send_reserved') return metadata.leadId === leadId && Number(metadata.step) === Number(step);
    if (row.eventType === 'follow_up_sent') return String(row.sourceLeadId || '') === String(leadId) && Number(metadata.step) === Number(step);
    return false;
  }).map(row => parseMetadata(row.metadata));
}

/** Earlier attempts at one warm-reply action, as parsed metadata. */
function warmReplyPriorAttempts(activities = [], actionId) {
  return (activities || []).filter(row => row && (
    (row.eventType === 'prospect_reply_reserved' && parseMetadata(row.metadata).actionId === actionId)
    || (row.eventType === 'booking_link_sent' && row.eventId === actionId)))
    .map(row => parseMetadata(row.metadata));
}

function plan(status, fields = {}) {
  const { token = null, url = null, ...visible } = fields;
  const result = { status, tracked: status === PLAN_STATUS.TRACKED, ...visible };
  // Never enumerable: a plan can be logged or serialised without leaking the link.
  Object.defineProperty(result, 'token', { value: token, enumerable: false });
  Object.defineProperty(result, 'url', { value: url, enumerable: false });
  return Object.freeze(result);
}

/**
 * Decide one action's landing link. Pure: the same inputs always give the same
 * answer, which is what lets the send path re-render and compare.
 *
 * @param actionId       deterministic send action id
 * @param source         LANDING_LINK_SOURCE value
 * @param priorAttempts  parsed metadata of this action's earlier reservations/sends
 * @param tracking       landingTrackingState()
 */
function planLandingLink({ actionId, source, priorAttempts = [], tracking }) {
  const issuanceKey = landingIssuanceKey(actionId);
  const pins = priorAttempts.map(metadata => metadata?.landingLink || null);
  const keyring = tracking?.keyring;

  if (!pins.length) {
    if (!tracking?.enabled) return plan(PLAN_STATUS.UNTRACKED, { issuanceKey, source, pinned: false, reason: tracking?.reason || 'tracking disabled' });
    return trackedPlan({ issuanceKey, source, keyVersion: keyring.activeVersion, keyring, pinned: false });
  }

  const pinned = pins.filter(Boolean);
  if (!pinned.length) {
    // Every earlier attempt went out (or was reserved) with the plain URL.
    return plan(PLAN_STATUS.UNTRACKED, { issuanceKey, source, pinned: true, reason: 'first attempt was untracked' });
  }
  if (pinned.length !== pins.length) {
    return plan(PLAN_STATUS.BLOCKED, { issuanceKey, source, pinned: true, reason: 'earlier attempts disagree on whether the landing link is tracked' });
  }
  const versions = new Set(pinned.map(pin => Number(pin.keyVersion)));
  const keys = new Set(pinned.map(pin => String(pin.issuanceKey || '')));
  if (pinned.some(pin => pin.tracked !== true) || versions.size !== 1 || keys.size !== 1) {
    return plan(PLAN_STATUS.BLOCKED, { issuanceKey, source, pinned: true, reason: 'earlier attempts disagree on the landing link key version' });
  }
  if (!keys.has(issuanceKey)) {
    return plan(PLAN_STATUS.BLOCKED, { issuanceKey, source, pinned: true, reason: 'pinned landing link belongs to a different issuance' });
  }
  const [keyVersion] = versions;
  if (!keyring?.keys?.has(keyVersion)) {
    return plan(PLAN_STATUS.BLOCKED, { issuanceKey, source, pinned: true, keyVersion, reason: `pinned landing link key version ${keyVersion} is not in the key ring` });
  }
  return trackedPlan({ issuanceKey, source, keyVersion, keyring, pinned: true });
}

function trackedPlan({ issuanceKey, source, keyVersion, keyring, pinned }) {
  const token = deriveLandingToken({ issuanceKey, keyVersion, keyring });
  return plan(PLAN_STATUS.TRACKED, {
    issuanceKey, source, keyVersion, pinned, reason: pinned ? 'pinned by earlier attempt' : 'new tracked issuance',
    tokenHash: landingTokenHash(token), token, url: trackedLandingUrl(token),
  });
}

/** The pin written into reservation and send metadata. Null for untracked plans. */
function landingLinkMetadata(landingPlan) {
  if (!landingPlan?.tracked) return null;
  return { issuanceKey: landingPlan.issuanceKey, keyVersion: landingPlan.keyVersion, source: landingPlan.source, tracked: true };
}

/** Why a stored issuance row disagrees with this plan, or '' when it matches. */
function issuanceConflict(landingPlan, storedRow) {
  if (!landingPlan?.tracked || !storedRow) return '';
  if (String(storedRow.issuance_key) !== landingPlan.issuanceKey) return 'stored issuance has a different issuance key';
  if (Number(storedRow.token_key_version) !== Number(landingPlan.keyVersion)) {
    return `stored issuance uses key version ${storedRow.token_key_version}, this render uses ${landingPlan.keyVersion}`;
  }
  if (String(storedRow.token_hash) !== landingPlan.tokenHash) return 'stored issuance has a different token hash';
  return '';
}

module.exports = {
  LINK_SLOT, TOKEN_PATTERN, LANDING_LINK_SOURCE, PLAN_STATUS,
  parseLandingKeyring, landingTrackingState, landingIssuanceKey, deriveLandingToken,
  isLandingToken, landingTokenHash, trackedLandingUrl,
  coldStepPriorAttempts, warmReplyPriorAttempts,
  planLandingLink, landingLinkMetadata, issuanceConflict,
};
