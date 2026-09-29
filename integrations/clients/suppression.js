'use strict';

/**
 * SuppressionScope — global first, then client.
 *
 *   GLOBAL  the existing Suppression tab and sticky note tags
 *           (pipeline-state.js sendSuppressionReason). Unsubscribe, bounce,
 *           compliance, universal do-not-contact. Applies to every client and
 *           is evaluated exactly as before this change.
 *   CLIENT  client_suppressions rows for one client: that client's current
 *           customers, active opportunities, protected relationships and
 *           company exclusions. A row for one client never blocks another.
 *
 * Entries match on the normalized email, the email's domain, or a company key.
 * Evaluation is pure; loading the entries is the store's job, and an
 * unavailable store is a refusal decided by the caller (see
 * evaluateClientSuppression).
 */

const { sendSuppressionReason } = require('../pipeline-state');
const { getClient, resolveClientId } = require('./registry');

const MATCH_TYPES = Object.freeze(['email', 'domain', 'company']);

const normalizeEmail = value => String(value || '').trim().toLowerCase();

function emailDomain(email) {
  const value = normalizeEmail(email);
  const at = value.lastIndexOf('@');
  return at > 0 ? value.slice(at + 1) : '';
}

// Lowercase, strip punctuation and common legal suffixes, collapse spaces.
function companyKey(value) {
  return String(value || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(inc|incorporated|llc|l l c|ltd|limited|corp|corporation|co|company|lp|llp|plc|the)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function normalizeDomain(value) {
  return String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
}

function normalizeMatchValue(matchType, value) {
  if (matchType === 'email') return normalizeEmail(value);
  if (matchType === 'domain') return normalizeDomain(value);
  if (matchType === 'company') return companyKey(value);
  return '';
}

/** Validated, normalized client suppression entry, or throws. */
function buildClientSuppression({ clientId, matchType, value, reason = '', source = 'operator', createdBy = '' } = {}) {
  const resolved = resolveClientId(clientId);
  if (!resolved.ok) throw Object.assign(new Error(resolved.reason), { code: resolved.code });
  if (!MATCH_TYPES.includes(matchType)) throw Object.assign(new Error(`matchType must be one of ${MATCH_TYPES.join(', ')}`), { code: 'invalid_match_type' });
  const matchValue = normalizeMatchValue(matchType, value);
  if (!matchValue) throw Object.assign(new Error('a suppression value is required'), { code: 'invalid_match_value' });
  if (matchType === 'email' && !/^\S+@\S+\.\S+$/.test(matchValue)) throw Object.assign(new Error('invalid email'), { code: 'invalid_match_value' });
  return {
    client_id: resolved.clientId, match_type: matchType, match_value: matchValue,
    reason: String(reason || '').slice(0, 500), source: String(source || '').slice(0, 100),
    created_by: String(createdBy || '').slice(0, 200), active: true,
  };
}

/** The lookup keys a lead can be suppressed under. */
function suppressionKeys(lead = {}) {
  return {
    email: normalizeEmail(lead.email),
    domain: emailDomain(lead.email) || normalizeDomain(lead.website),
    company: companyKey(lead.company),
  };
}

/** The first active client entry of THIS client that matches the lead, or null. */
function clientSuppressionMatch(lead, clientId, entries = []) {
  const keys = suppressionKeys(lead);
  for (const entry of entries || []) {
    if (!entry || entry.active === false) continue;
    if (String(entry.client_id || '') !== clientId) continue;   // another client's entry never applies
    const key = keys[entry.match_type];
    if (key && key === entry.match_value) return entry;
  }
  return null;
}

/**
 * Global → client, in that order. Returns null when sendable, else
 * { scope, code, reason }.
 *
 * clientEntries: { available: boolean, entries: [] } from the store. An
 * unavailable store refuses clients that require it; for a client that does not
 * (the default client, whose exclusions cannot exist until the store is
 * enabled) it is skipped.
 */
function evaluateScopedSuppression(lead, { clientId, suppressedEmails = new Set(), clientEntries = null } = {}) {
  const global = sendSuppressionReason(lead, { suppressedEmails });
  if (global) return { scope: 'global', code: 'global', reason: global };
  const client = getClient(clientId);
  if (!clientEntries || clientEntries.available !== true) {
    if (clientEntries?.error) {
      return { scope: 'client', code: 'client_suppression_unavailable', reason: `client suppression list unreadable: ${clientEntries.error}` };
    }
    if (client.sending.clientSuppressionRequired) {
      return { scope: 'client', code: 'client_suppression_unavailable', reason: `${client.displayName} requires the client suppression list, which is not available` };
    }
    return null;
  }
  const match = clientSuppressionMatch(lead, client.id, clientEntries.entries);
  if (match) {
    return { scope: 'client', code: 'client_suppressed', reason: `${client.displayName} ${match.match_type} exclusion${match.reason ? ` (${match.reason})` : ''}` };
  }
  return null;
}

module.exports = {
  MATCH_TYPES, normalizeEmail, emailDomain, companyKey, normalizeDomain, normalizeMatchValue,
  buildClientSuppression, suppressionKeys, clientSuppressionMatch, evaluateScopedSuppression,
};
