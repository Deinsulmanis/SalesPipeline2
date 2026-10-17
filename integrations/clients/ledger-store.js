'use strict';

/**
 * Persistence for the managed-client ledger and client-scoped suppression.
 *
 *   createSupabaseLedgerStore()  PostgREST against the tables in
 *                                supabase/migrations/20260930000000_client_ledger.sql
 *   createMemoryLedgerStore()    the same contract in memory, enforcing the same
 *                                composite (id, client_id) keys, for tests and
 *                                the safe end-to-end dry run
 *
 * ISOLATION. Every read takes a clientId and sends `client_id=eq.<id>` to the
 * database, so another client's rows never leave Postgres; every row that comes
 * back is checked again before it is returned. Writes carry client_id and the
 * database's composite foreign keys refuse a meeting or clarification attached
 * to another client's opportunity.
 *
 * ENABLEMENT. The Supabase store is live only with the Supabase connection AND
 * CLIENT_LEDGER_ENABLED=true (set after the migration is applied). Disabled, the
 * ledger reports `available: false` and client suppression is unavailable —
 * which refuses sending for any client that requires it (every managed client).
 */

const { mirrorConfig } = require('../supabase-mirror');
const { resolveClientId } = require('./registry');
const { suppressionKeys } = require('./suppression');

const REQUEST_TIMEOUT_MS = 5000;
const ENABLE_VAR = 'CLIENT_LEDGER_ENABLED';
const TABLES = Object.freeze({
  opportunities: 'client_opportunities', meetings: 'client_meetings', clarifications: 'client_clarifications',
  suppressions: 'client_suppressions', events: 'client_ledger_events',
});

class LedgerStoreError extends Error {
  constructor(code, message) { super(message); this.name = 'LedgerStoreError'; this.code = code; }
}

function requireClientId(clientId) {
  const resolved = resolveClientId(clientId);
  if (!resolved.ok) throw new LedgerStoreError(resolved.code, resolved.reason);
  return resolved.clientId;
}

function onlyClient(rows, clientId, table) {
  for (const row of rows || []) {
    if (row.client_id !== clientId) throw new LedgerStoreError('client_isolation_violation', `${table} returned a row for another client`);
  }
  return rows || [];
}

function ledgerStoreConfig(env = process.env) {
  const supabase = mirrorConfig(env);
  if (!supabase.enabled) return { enabled: false, reason: supabase.reason || 'supabase not configured' };
  if (String(env[ENABLE_VAR] || '').trim().toLowerCase() !== 'true') return { enabled: false, reason: `${ENABLE_VAR} is not true` };
  return { enabled: true, url: supabase.url, key: supabase.key };
}

const eq = value => `eq.${encodeURIComponent(String(value))}`;

function createSupabaseLedgerStore({ env = process.env, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const config = ledgerStoreConfig(env);

  async function request(method, table, query = '', body, prefer = '') {
    if (!config.enabled) throw new LedgerStoreError('ledger_unavailable', `client ledger is disabled: ${config.reason}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${config.url}/rest/v1/${table}${query ? `?${query}` : ''}`, {
        method,
        headers: {
          apikey: config.key, Authorization: `Bearer ${config.key}`, Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(prefer ? { Prefer: prefer } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      // Only the status reaches callers: a response body can echo row values.
      if (!response.ok) throw new LedgerStoreError(response.status === 409 ? 'ledger_conflict' : 'ledger_request_failed', `${table} ${method} HTTP ${response.status}`);
      const raw = await response.text();
      return raw ? JSON.parse(raw) : [];
    } catch (error) {
      if (error instanceof LedgerStoreError) throw error;
      throw new LedgerStoreError('ledger_request_failed', error?.name === 'AbortError' ? `${table} timeout after ${timeoutMs}ms` : `${table} request failed`);
    } finally {
      clearTimeout(timer);
    }
  }

  const select = async (table, clientId, filters = '') => {
    const id = requireClientId(clientId);
    return onlyClient(await request('GET', table, `select=*&client_id=${eq(id)}${filters}`), id, table);
  };
  const getOne = async (table, key, clientId, value) => (await select(table, clientId, `&${key}=${eq(value)}&limit=1`))[0] || null;
  const upsert = (table, row, onConflict) => request('POST', table, `on_conflict=${onConflict}`, [row], 'resolution=merge-duplicates,return=minimal');
  const insert = (table, row) => request('POST', table, '', [row], 'return=minimal');
  const patch = (table, key, row) => request('PATCH', table,
    `${key}=${eq(row[key])}&client_id=${eq(requireClientId(row.client_id))}`, row, 'return=minimal');

  return {
    kind: 'supabase',
    enabled: config.enabled,
    reason: config.enabled ? '' : config.reason,
    getOpportunity: (clientId, id) => getOne(TABLES.opportunities, 'opportunity_id', clientId, id),
    upsertOpportunity: row => upsert(TABLES.opportunities, row, 'opportunity_id'),
    listOpportunities: (clientId, { conversationStatus } = {}) => select(TABLES.opportunities, clientId,
      `${conversationStatus ? `&conversation_status=${eq(conversationStatus)}` : ''}&order=updated_at.desc&limit=1000`),
    getMeeting: (clientId, id) => getOne(TABLES.meetings, 'meeting_id', clientId, id),
    insertMeeting: row => insert(TABLES.meetings, row),
    updateMeeting: row => patch(TABLES.meetings, 'meeting_id', row),
    listMeetings: clientId => select(TABLES.meetings, clientId, '&order=scheduled_for.desc&limit=1000'),
    getClarification: (clientId, id) => getOne(TABLES.clarifications, 'clarification_id', clientId, id),
    insertClarification: row => insert(TABLES.clarifications, row),
    updateClarification: row => patch(TABLES.clarifications, 'clarification_id', row),
    listClarifications: (clientId, { opportunityId, status } = {}) => select(TABLES.clarifications, clientId,
      `${opportunityId ? `&opportunity_id=${eq(opportunityId)}` : ''}${status ? `&status=${eq(status)}` : ''}&order=created_at.desc&limit=1000`),
    appendEvent: row => request('POST', TABLES.events, 'on_conflict=event_id', [row], 'resolution=ignore-duplicates,return=minimal'),
    listEvents: (clientId, { limit = 200 } = {}) => select(TABLES.events, clientId, `&order=occurred_at.desc&limit=${Math.min(Number(limit) || 200, 1000)}`),

    /**
     * Client suppression entries that could match this lead. Never throws:
     * { available: true, entries } or { available: false, error? }.
     */
    async clientSuppressionsFor(clientId, lead) {
      if (!config.enabled) return { available: false, reason: config.reason };
      try {
        const id = requireClientId(clientId);
        const keys = suppressionKeys(lead);
        const ors = Object.entries(keys).filter(([, value]) => value)
          .map(([type, value]) => `and(match_type.eq.${type},match_value.eq.${JSON.stringify(value)})`);
        if (!ors.length) return { available: true, entries: [] };
        const rows = await select(TABLES.suppressions, id, `&active=is.true&or=(${encodeURIComponent(ors.join(','))})`);
        return { available: true, entries: rows };
      } catch (error) {
        return { available: false, error: error.message || 'client suppression read failed' };
      }
    },
    listClientSuppressions: clientId => select(TABLES.suppressions, clientId, '&order=created_at.desc&limit=1000'),
    addClientSuppression: row => upsert(TABLES.suppressions, row, 'client_id,match_type,match_value'),
    deactivateClientSuppression: (clientId, matchType, matchValue) => request('PATCH', TABLES.suppressions,
      `client_id=${eq(requireClientId(clientId))}&match_type=${eq(matchType)}&match_value=${eq(matchValue)}`,
      { active: false, updated_at: new Date().toISOString() }, 'return=minimal'),
  };
}

/** Same contract in memory, enforcing the database's composite keys. */
function createMemoryLedgerStore({ available = true } = {}) {
  const tables = {
    opportunities: new Map(), meetings: new Map(), clarifications: new Map(),
    suppressions: new Map(), events: new Map(),
  };
  const clone = row => (row ? JSON.parse(JSON.stringify(row)) : null);
  const scoped = (map, clientId) => [...map.values()].filter(row => row.client_id === requireClientId(clientId)).map(clone);
  const getScoped = (map, clientId, id) => {
    const row = map.get(id);
    return row && row.client_id === requireClientId(clientId) ? clone(row) : null;
  };
  // client_meetings / client_clarifications (opportunity_id, client_id)
  //   REFERENCES client_opportunities (opportunity_id, client_id)
  const assertParent = row => {
    const parent = tables.opportunities.get(row.opportunity_id);
    if (!parent || parent.client_id !== row.client_id) {
      throw new LedgerStoreError('client_isolation_violation', 'foreign key (opportunity_id, client_id) has no matching opportunity for this client');
    }
  };
  const guardUnavailable = () => { if (!available) throw new LedgerStoreError('ledger_unavailable', 'client ledger is disabled'); };
  const suppressionKey = row => `${row.client_id}|${row.match_type}|${row.match_value}`;

  return {
    kind: 'memory', enabled: available, tables,
    async getOpportunity(clientId, id) { guardUnavailable(); return getScoped(tables.opportunities, clientId, id); },
    async upsertOpportunity(row) {
      guardUnavailable(); requireClientId(row.client_id);
      const existing = tables.opportunities.get(row.opportunity_id);
      if (existing && existing.client_id !== row.client_id) throw new LedgerStoreError('client_isolation_violation', 'opportunity belongs to another client');
      tables.opportunities.set(row.opportunity_id, clone(row));
    },
    async listOpportunities(clientId) { guardUnavailable(); return scoped(tables.opportunities, clientId); },
    async getMeeting(clientId, id) { guardUnavailable(); return getScoped(tables.meetings, clientId, id); },
    async insertMeeting(row) {
      guardUnavailable(); requireClientId(row.client_id); assertParent(row);
      if (tables.meetings.has(row.meeting_id)) throw new LedgerStoreError('ledger_conflict', 'meeting already exists');
      tables.meetings.set(row.meeting_id, clone(row));
    },
    async updateMeeting(row) {
      guardUnavailable(); assertParent(row);
      const existing = tables.meetings.get(row.meeting_id);
      if (!existing || existing.client_id !== row.client_id) throw new LedgerStoreError('client_isolation_violation', 'meeting belongs to another client');
      tables.meetings.set(row.meeting_id, clone(row));
    },
    async listMeetings(clientId) { guardUnavailable(); return scoped(tables.meetings, clientId); },
    async getClarification(clientId, id) { guardUnavailable(); return getScoped(tables.clarifications, clientId, id); },
    async insertClarification(row) {
      guardUnavailable(); requireClientId(row.client_id); assertParent(row);
      tables.clarifications.set(row.clarification_id, clone(row));
    },
    async updateClarification(row) {
      guardUnavailable(); assertParent(row);
      const existing = tables.clarifications.get(row.clarification_id);
      if (!existing || existing.client_id !== row.client_id) throw new LedgerStoreError('client_isolation_violation', 'clarification belongs to another client');
      tables.clarifications.set(row.clarification_id, clone(row));
    },
    async listClarifications(clientId, { opportunityId, status } = {}) {
      guardUnavailable();
      return scoped(tables.clarifications, clientId)
        .filter(row => (!opportunityId || row.opportunity_id === opportunityId) && (!status || row.status === status));
    },
    async appendEvent(row) { guardUnavailable(); requireClientId(row.client_id); if (!tables.events.has(row.event_id)) tables.events.set(row.event_id, clone(row)); },
    async listEvents(clientId) { guardUnavailable(); return scoped(tables.events, clientId); },
    async clientSuppressionsFor(clientId, lead) {
      if (!available) return { available: false, reason: 'client ledger is disabled' };
      const keys = suppressionKeys(lead);
      const entries = scoped(tables.suppressions, clientId)
        .filter(row => row.active !== false && keys[row.match_type] && keys[row.match_type] === row.match_value);
      return { available: true, entries };
    },
    async listClientSuppressions(clientId) { guardUnavailable(); return scoped(tables.suppressions, clientId); },
    async addClientSuppression(row) { guardUnavailable(); requireClientId(row.client_id); tables.suppressions.set(suppressionKey(row), clone({ ...row, active: true })); },
    async deactivateClientSuppression(clientId, matchType, matchValue) {
      guardUnavailable();
      const key = suppressionKey({ client_id: requireClientId(clientId), match_type: matchType, match_value: matchValue });
      const row = tables.suppressions.get(key);
      if (row) tables.suppressions.set(key, { ...row, active: false });
    },
  };
}

let defaultStore = null;
/** The process-wide Supabase ledger store (config read once). */
function getLedgerStore(env = process.env) {
  if (!defaultStore) defaultStore = createSupabaseLedgerStore({ env });
  return defaultStore;
}
function setLedgerStoreForTests(store) { defaultStore = store; }

module.exports = {
  ENABLE_VAR, TABLES, LedgerStoreError, ledgerStoreConfig,
  createSupabaseLedgerStore, createMemoryLedgerStore, getLedgerStore, setLedgerStoreForTests,
};
