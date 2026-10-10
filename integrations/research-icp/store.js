'use strict';
const { mirrorConfig } = require('../supabase-mirror');
const TABLE = 'research_icp_runs';
function createStore({ env = process.env, fetchImpl = global.fetch } = {}) {
  async function request(query = '', method = 'GET', body) {
    const cfg = mirrorConfig(env);
    if (!cfg.enabled) throw new Error('RESEARCH_STORAGE_UNAVAILABLE');
    try {
      const response = await fetchImpl(`${cfg.url}/rest/v1/${TABLE}${query}`, {
        method, signal: AbortSignal.timeout(5000),
        headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error('storage');
      return await response.json();
    } catch { throw new Error('RESEARCH_STORAGE_UNAVAILABLE'); }
  }
  return {
    async start(row) {
      const rows = await request('', 'POST', row);
      if (!Array.isArray(rows) || rows[0]?.run_id !== row.run_id) throw new Error('RESEARCH_STORAGE_UNAVAILABLE');
    },
    async finish(id, row) {
      const rows = await request(`?run_id=eq.${encodeURIComponent(id)}&status=eq.running`, 'PATCH', row);
      if (!Array.isArray(rows) || rows.length !== 1 || rows[0].run_id !== id) throw new Error('RESEARCH_STORAGE_UNAVAILABLE');
    },
    async get(id) { return (await request(`?run_id=eq.${encodeURIComponent(id)}&limit=1`))[0] || null; },
    async list({ leadId, campaignId, limit = 20 } = {}) {
      const query = new URLSearchParams({ order: 'started_at.desc', limit: String(Math.max(1, Math.min(50, limit))) });
      if (leadId) query.set('lead_id', `eq.${leadId}`);
      if (campaignId) query.set('campaign_id', `eq.${campaignId}`);
      return request(`?${query}`);
    },
  };
}
module.exports = { TABLE, createStore };
