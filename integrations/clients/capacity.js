'use strict';

/**
 * Client-level send capacity, between the global system ceilings and the
 * existing campaign / sender / window limits:
 *
 *   GLOBAL SYSTEM CAP → CLIENT CAP → CAMPAIGN CAP → SENDER CAP → WINDOW CAP
 *
 * This module decides only the first two layers. The global ceilings keep
 * being enforced by the existing send path; the numbers here are the same ones,
 * so the client layer can only ever be MORE restrictive, never less.
 *
 * Per client (client-configs.js `capacity`):
 *   dailyCap / windowCap        null = no client cap (ScaleLab today)
 *   reservedDaily / Window      capacity held back from OTHER clients
 *
 * Effective remaining for client C, per day and per window:
 *   min( global remaining − Σ unused reservations of other SENDING clients,
 *        C's cap − C's sends )
 *
 * A client that cannot send (disabled, inactive, not env-authorized) has zero
 * capacity whatever the numbers say, and its reservation holds nothing back.
 */

const { getClient, listClients, resolveClientId } = require('./registry');
const { clientSendBlock } = require('./send-policy');
const { tenantOf } = require('./email-scope');

const SUCCESSFUL_SEND_EVENTS = Object.freeze(['initial_email_sent', 'follow_up_sent', 'sequence_step_sent', 'booking_link_sent']);

const nonNegative = value => Math.max(0, value);

/**
 * Successful sends today per client, from the activity ledger. A send whose
 * lead is unknown or unowned counts against the default client: every send
 * before managed clients existed was ScaleLab's, and uncertainty must never
 * turn a real send into free capacity.
 */
function clientSendCountsToday(activities = [], { dayKey, leadsById = new Map(), timeZone = 'America/Vancouver', defaultClientId } = {}) {
  const fallback = defaultClientId || listClients().find(client => client.isDefault).id;
  const counts = new Map();
  const seen = new Set();
  for (const row of activities || []) {
    if (!SUCCESSFUL_SEND_EVENTS.includes(String(row.eventType || ''))) continue;
    const day = row.occurredAt ? new Date(row.occurredAt).toLocaleDateString('en-CA', { timeZone }) : '';
    if (dayKey && day !== dayKey) continue;
    const key = String(row.eventId || `${row.leadId}:${row.eventType}:${row.occurredAt}`);
    if (seen.has(key)) continue;
    seen.add(key);
    const leadId = String(row.sourceLeadId || '').trim() || String(row.leadId || '').replace(/^CE-/, '');
    const lead = leadsById.get(leadId);
    const client = (lead && tenantOf(lead)) || fallback;
    counts.set(client, (counts.get(client) || 0) + 1);
  }
  return counts;
}

/**
 * @param globalDailyLimit   remaining-day ceiling for the whole service
 * @param globalWindowLimit  per-window ceiling for the whole service
 * @param sentTodayByClient  Map clientId → successful sends today
 * @param configs            optional Map clientId → capacity (tests); defaults to the registry
 */
// sendBlock defaults to the real client send switch; tests inject one to model
// a client whose sending has been enabled, without touching the registry.
function createClientCapacityState({
  globalDailyLimit, globalWindowLimit, sentTodayByClient = new Map(), configs = null, env = process.env,
  sendBlock = clientSendBlock,
} = {}) {
  const capacities = new Map(listClients().map(client => [client.id, { ...client.capacity }]));
  if (configs) for (const [id, cfg] of configs) capacities.set(id, { ...capacities.get(id), ...cfg });
  const dailyUsed = new Map([...sentTodayByClient].map(([id, n]) => [id, Number(n) || 0]));
  return {
    globalDailyLimit: Number(globalDailyLimit), globalWindowLimit: Number(globalWindowLimit),
    dailyUsed, windowUsed: new Map(), capacities, env, sendBlock,
    dailyTotal: [...dailyUsed.values()].reduce((sum, n) => sum + n, 0), windowTotal: 0,
  };
}

function heldBackFor(state, clientId, kind) {
  let held = 0;
  for (const [otherId, cfg] of state.capacities) {
    if (otherId === clientId) continue;
    if (state.sendBlock(otherId, state.env)) continue;   // a client that cannot send reserves nothing
    const reserved = kind === 'daily' ? cfg.reservedDaily : cfg.reservedWindow;
    const used = (kind === 'daily' ? state.dailyUsed : state.windowUsed).get(otherId) || 0;
    held += nonNegative((reserved || 0) - used);
  }
  return held;
}

/**
 * { allowed, remaining, code, reason, clientId } — the client layer's verdict.
 * code names the binding limit when refused.
 */
function clientCapacityVerdict(state, clientId) {
  const resolved = resolveClientId(clientId);
  if (!resolved.ok) return { allowed: false, remaining: 0, code: resolved.code, reason: resolved.reason, clientId };
  const id = resolved.clientId;
  const blocked = state.sendBlock(id, state.env);
  if (blocked) return { allowed: false, remaining: 0, code: blocked.code, reason: blocked.reason, clientId: id };
  const cfg = state.capacities.get(id) || getClient(id).capacity;
  const layers = [
    ['global_daily_cap', 'service daily ceiling reached', nonNegative(state.globalDailyLimit - state.dailyTotal)],
    ['reserved_for_other_clients', 'remaining daily capacity is reserved for other clients',
      nonNegative(state.globalDailyLimit - state.dailyTotal - heldBackFor(state, id, 'daily'))],
    ['client_daily_cap', `${getClient(id).displayName} daily cap reached`,
      cfg.dailyCap === null ? Infinity : nonNegative(cfg.dailyCap - (state.dailyUsed.get(id) || 0))],
    ['global_window_cap', 'service window ceiling reached', nonNegative(state.globalWindowLimit - state.windowTotal)],
    ['reserved_for_other_clients', 'remaining window capacity is reserved for other clients',
      nonNegative(state.globalWindowLimit - state.windowTotal - heldBackFor(state, id, 'window'))],
    ['client_window_cap', `${getClient(id).displayName} window cap reached`,
      cfg.windowCap === null ? Infinity : nonNegative(cfg.windowCap - (state.windowUsed.get(id) || 0))],
  ];
  const binding = layers.reduce((min, layer) => (layer[2] < min[2] ? layer : min));
  const remaining = binding[2];
  if (remaining <= 0) return { allowed: false, remaining: 0, code: binding[0], reason: binding[1], clientId: id };
  return { allowed: true, remaining, code: '', reason: '', clientId: id };
}

/** Record one successful provider send for a client. Refuses if the verdict does. */
function consumeClientCapacity(state, clientId) {
  const verdict = clientCapacityVerdict(state, clientId);
  if (!verdict.allowed) throw Object.assign(new Error(verdict.reason), { code: verdict.code });
  const id = verdict.clientId;
  state.dailyUsed.set(id, (state.dailyUsed.get(id) || 0) + 1);
  state.windowUsed.set(id, (state.windowUsed.get(id) || 0) + 1);
  state.dailyTotal += 1;
  state.windowTotal += 1;
  return clientCapacityVerdict(state, id);
}

/**
 * Record a send that ALREADY happened. Never throws: the provider has accepted
 * the message, and accounting must not turn a delivered send into an error.
 * An unowned lead's send counts against the default client (never free).
 */
function recordClientSend(state, clientId) {
  const resolved = resolveClientId(clientId);
  const id = resolved.ok ? resolved.clientId : listClients().find(client => client.isDefault).id;
  state.dailyUsed.set(id, (state.dailyUsed.get(id) || 0) + 1);
  state.windowUsed.set(id, (state.windowUsed.get(id) || 0) + 1);
  state.dailyTotal += 1;
  state.windowTotal += 1;
}

function clientCapacitySnapshot(state) {
  return Object.fromEntries([...state.capacities.keys()].map(id => {
    const verdict = clientCapacityVerdict(state, id);
    return [id, {
      sentToday: state.dailyUsed.get(id) || 0, sentThisWindow: state.windowUsed.get(id) || 0,
      remaining: verdict.remaining === Infinity ? null : verdict.remaining,
      allowed: verdict.allowed, ...(verdict.allowed ? {} : { blockedBy: verdict.code }),
    }];
  }));
}

module.exports = {
  SUCCESSFUL_SEND_EVENTS, clientSendCountsToday, createClientCapacityState,
  clientCapacityVerdict, consumeClientCapacity, recordClientSend, clientCapacitySnapshot,
};
