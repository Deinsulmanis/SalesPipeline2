'use strict';
// Supabase storage for the ScaleLab reply queue (fast reply mode). Server-side
// secret key; RLS denies anon/authenticated. Every transition is a
// compare-and-set on the current value, so two workers never both act.
const { mirrorConfig } = require('./supabase-mirror');

const TABLE = 'scalelab_reply_queue';

function createReplyQueueStore({ env = process.env, fetchImpl = global.fetch } = {}) {
  const config = mirrorConfig(env);
  if (!config.enabled) throw new Error('reply queue database unavailable');
  const headers = { apikey: config.key, Authorization: 'Bearer ' + config.key, 'Content-Type': 'application/json' };
  async function request(method, query, body, prefer) {
    const response = await fetchImpl(`${config.url}/rest/v1/${TABLE}?${new URLSearchParams(query)}`, {
      method, headers: { ...headers, ...(prefer ? { Prefer: prefer } : {}) }, signal: AbortSignal.timeout(8000),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`reply queue storage returned ${response.status}`);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('invalid reply queue storage response');
    return rows;
  }
  const get = async actionId => (await request('GET', { action_id: 'eq.' + actionId, limit: '1' }))[0] || null;
  return {
    get,
    /** Insert once per routed reply; an existing row is returned unchanged. */
    async enqueue(row) {
      const [saved] = await request('POST', { on_conflict: 'action_id' }, { client_id: 'scalelab', ...row },
        'resolution=ignore-duplicates,return=representation');
      return saved || get(row.action_id);
    },
    async listPending(limit = 100) {
      return request('GET', { status: 'eq.pending', order: 'received_at.desc', limit: String(limit) });
    },
    async listAlertsDue(now) {
      return request('GET', { alert_status: 'in.(pending,queued)', or: `(alert_send_after.is.null,alert_send_after.lte.${now.toISOString()})`,
        order: 'received_at.asc', limit: '50' });
    },
    /** Compare-and-set: only applies when `expect` still matches. Returns the row or null. */
    async transition(actionId, expect, patch) {
      const query = { action_id: 'eq.' + actionId };
      for (const [key, value] of Object.entries(expect)) query[key] = value === null ? 'is.null' : 'eq.' + value;
      const [row] = await request('PATCH', query, { ...patch, updated_at: new Date().toISOString() }, 'return=representation');
      return row || null;
    },
  };
}

module.exports = { createReplyQueueStore, TABLE };
