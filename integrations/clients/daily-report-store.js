'use strict';

const { mirrorConfig } = require('../supabase-mirror');

const TABLE = 'client_daily_reports';
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
function requireJole(clientId, date) {
  if (clientId !== 'jole' || !validDate(date)) {
    throw Object.assign(new Error('Jole report and ISO date required'), { code: 'client_isolation_violation' });
  }
}

function createSupabaseDailyReportStore({ env = process.env, fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const config = mirrorConfig(env);
  const enabled = config.enabled && String(env.CLIENT_DAILY_REPORT_ENABLED || '').toLowerCase() === 'true';
  async function request(method, query, body) {
    if (!enabled) throw Object.assign(new Error('Daily report storage is unavailable'), { code: 'report_unavailable' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${config.url}/rest/v1/${TABLE}?${query}`, {
        method, signal: controller.signal,
        headers: { apikey: config.key, Authorization: `Bearer ${config.key}`, Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' } : {}) },
        ...(body ? { body: JSON.stringify([body]) } : {}),
      });
      if (!response.ok) throw new Error(`Report store HTTP ${response.status}`);
      const raw = await response.text();
      return raw ? JSON.parse(raw) : [];
    } finally { clearTimeout(timer); }
  }
  return {
    enabled,
    async get(clientId, date) {
      requireJole(clientId, date);
      const rows = await request('GET', `select=*&client_id=eq.jole&report_date=eq.${date}&limit=1`);
      if (rows.some(row => row.client_id !== 'jole' || row.report_date !== date)) {
        throw Object.assign(new Error('Report store returned another tenant/date'), { code: 'client_isolation_violation' });
      }
      return rows[0] || null;
    },
    async insertIfAbsent(row) {
      requireJole(row?.client_id, row?.report_date);
      return request('POST', 'on_conflict=client_id,report_date', row);
    },
  };
}

function createMemoryDailyReportStore() {
  const reports = new Map();
  return {
    enabled: true,
    async get(clientId, date) { requireJole(clientId, date); return structuredClone(reports.get(`${clientId}/${date}`) || null); },
    async insertIfAbsent(row) {
      requireJole(row?.client_id, row?.report_date);
      const key = `${row.client_id}/${row.report_date}`;
      if (!reports.has(key)) reports.set(key, structuredClone(row));
    },
  };
}

module.exports = { createSupabaseDailyReportStore, createMemoryDailyReportStore };
