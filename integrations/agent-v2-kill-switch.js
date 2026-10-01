'use strict';

/**
 * Agent v2 runtime kill switch.
 *
 * Execution needs BOTH the configured AGENT_V2_EXECUTION_ENABLED flag and this
 * switch ARMED. The switch is one row in Supabase
 * (public.agent_v2_runtime_control, migration 20261001000000), read live with
 * no cache immediately before execution, so disarming takes effect on the next
 * check with no code change, deploy or restart. Shadow evaluation and the
 * legacy reply path never read it.
 *
 * Fail closed: missing configuration, an HTTP or network error, a timeout, an
 * unexpected payload, a missing row, armed without an expiry, or an expired
 * arm all read as DISARMED.
 */

const CONTROL_ID = 'agent_v2_execution';
const MAX_ARM_DAYS = 15;
const READ_TIMEOUT_MS = 4000;

function supabaseConfig(env) {
  const url = String(env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = String(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  return url && key ? { url, key } : null;
}

function headers(config, extra = {}) {
  return { apikey: config.key, Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json', ...extra };
}

function disarmed(code, extra = {}) {
  return Object.freeze({ readable: false, armed: false, code, armedUntil: null, updatedBy: null,
    updatedAt: null, reason: null, version: null, ...extra });
}

async function withTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetchImpl(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

/** Interpret one control row. PURE. */
function interpretControlRow(row, now = new Date()) {
  if (!row || typeof row !== 'object' || row.id !== CONTROL_ID || typeof row.armed !== 'boolean')
    return disarmed('kill_switch_row_invalid', { readable: true });
  const base = { readable: true, armedUntil: row.armed_until || null, updatedBy: row.updated_by || null,
    updatedAt: row.updated_at || null, reason: row.reason || null, version: Number(row.version) || null };
  if (!row.armed) return Object.freeze({ ...base, armed: false, code: 'kill_switch_disarmed' });
  const until = Date.parse(row.armed_until || '');
  if (!Number.isFinite(until)) return Object.freeze({ ...base, armed: false, code: 'kill_switch_no_expiry' });
  if (until <= new Date(now).getTime()) return Object.freeze({ ...base, armed: false, code: 'kill_switch_expired' });
  return Object.freeze({ ...base, armed: true, code: 'kill_switch_armed' });
}

/** Read the switch live. Never throws; every failure is DISARMED. */
async function readAgentV2KillSwitch({ env = process.env, fetchImpl = globalThis.fetch, now = new Date(),
  timeoutMs = READ_TIMEOUT_MS } = {}) {
  const config = supabaseConfig(env);
  if (!config) return disarmed('kill_switch_unconfigured');
  if (typeof fetchImpl !== 'function') return disarmed('kill_switch_unavailable');
  let response;
  try {
    response = await withTimeout(fetchImpl, `${config.url}/rest/v1/agent_v2_runtime_control?id=eq.${CONTROL_ID}`
      + '&select=id,armed,armed_until,reason,updated_by,updated_at,version', { method: 'GET', headers: headers(config) }, timeoutMs);
  } catch (error) {
    return disarmed(error?.name === 'AbortError' ? 'kill_switch_timeout' : 'kill_switch_unreachable');
  }
  if (!response || !response.ok) return disarmed(`kill_switch_http_${Number(response?.status) || 0}`);
  let rows;
  try { rows = await response.json(); } catch (_) { return disarmed('kill_switch_payload_invalid'); }
  if (!Array.isArray(rows)) return disarmed('kill_switch_payload_invalid');
  if (rows.length === 0) return disarmed('kill_switch_missing', { readable: true });
  if (rows.length !== 1) return disarmed('kill_switch_payload_invalid');
  return interpretControlRow(rows[0], now);
}

/** Validate a requested change. PURE. '' when acceptable. */
function validateKillSwitchChange({ armed, armedUntil, reason, by }, now = new Date()) {
  if (typeof armed !== 'boolean') return 'armed must be true or false';
  if (!String(by || '').trim()) return 'the person making the change must be named';
  if (!String(reason || '').trim()) return 'a reason is required';
  if (armed) {
    const until = Date.parse(armedUntil || '');
    const nowMs = new Date(now).getTime();
    if (!Number.isFinite(until) || until <= nowMs) return 'arming needs a future armedUntil';
    if (until > nowMs + MAX_ARM_DAYS * 24 * 3600 * 1000) return `arming may not exceed ${MAX_ARM_DAYS} days`;
  }
  return '';
}

/** Change the switch through the audited database function. */
async function setAgentV2KillSwitch({ armed, armedUntil = null, reason, by, expectedVersion = null,
  env = process.env, fetchImpl = globalThis.fetch, now = new Date() } = {}) {
  const invalid = validateKillSwitchChange({ armed, armedUntil, reason, by }, now);
  if (invalid) return { ok: false, code: 'kill_switch_change_invalid', reason: invalid };
  const config = supabaseConfig(env);
  if (!config) return { ok: false, code: 'kill_switch_unconfigured' };
  let response;
  try {
    response = await withTimeout(fetchImpl, `${config.url}/rest/v1/rpc/agent_v2_set_runtime_control`, {
      method: 'POST', headers: headers(config),
      body: JSON.stringify({ p_armed: armed, p_armed_until: armed ? new Date(armedUntil).toISOString() : null,
        p_reason: String(reason).trim().slice(0, 500), p_changed_by: String(by).trim().slice(0, 120),
        p_expected_version: expectedVersion }),
    }, READ_TIMEOUT_MS);
  } catch (_) { return { ok: false, code: 'kill_switch_unreachable' }; }
  if (!response.ok) return { ok: false, code: `kill_switch_http_${response.status}` };
  // Report what is now stored, read back independently.
  const state = await readAgentV2KillSwitch({ env, fetchImpl, now });
  return { ok: state.readable && state.armed === armed, state };
}

module.exports = { CONTROL_ID, MAX_ARM_DAYS, readAgentV2KillSwitch, interpretControlRow,
  validateKillSwitchChange, setAgentV2KillSwitch };
