'use strict';

/**
 * Server-side calls to the landing attribution functions in the Supabase
 * outreach project (supabase/migrations/*_landing_link_attribution.sql).
 *
 * Same connection rules as the activity mirror: SUPABASE_URL plus the
 * server-only secret key, https except for a loopback stand-in. Every call has
 * a hard timeout and NEVER throws: it returns { ok, status, data, error }.
 * Only HTTP status codes reach logs, because a response body can echo the
 * values that were sent.
 */

const { mirrorConfig } = require('./supabase-mirror');
const { TIMEOUT_MS } = require('./landing-attribution-config');

async function callRpc(name, payload, { env = process.env, timeoutMs = TIMEOUT_MS.issuance, fetchImpl = fetch } = {}) {
  const config = mirrorConfig(env);
  if (!config.enabled) return { ok: false, status: 0, data: null, error: config.reason };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${config.url}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: config.key, Authorization: `Bearer ${config.key}`,
        'Content-Type': 'application/json', Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, status: response.status, data: null, error: `HTTP ${response.status}` };
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { return { ok: false, status: response.status, data: null, error: 'unparseable response' }; }
    return { ok: true, status: response.status, data, error: null };
  } catch (error) {
    return { ok: false, status: 0, data: null, error: error?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : (error?.message || 'request failed') };
  } finally {
    clearTimeout(timer);
  }
}

/** Insert the issuance if absent; returns the stored row either way. */
function issueLandingLink(record, options = {}) {
  return callRpc('landing_issue_link', { p: record }, { timeoutMs: TIMEOUT_MS.issuance, ...options });
}

/** Mark an issuance sent with its provider ids. Returns the row, or null data when unknown. */
function markLandingLinkSent(update, options = {}) {
  return callRpc('landing_mark_link_sent', { p: update }, { timeoutMs: TIMEOUT_MS.markSent, ...options });
}

module.exports = { callRpc, issueLandingLink, markLandingLinkSent };
