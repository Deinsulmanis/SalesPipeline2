'use strict';

/**
 * Managed-client import batches: the server-side intake for a lead list that
 * arrives as data rather than through the dashboard upload.
 *
 * A batch is a row in public.client_lead_import_batches (service role only):
 * the client, its campaign and the rows. The server claims `pending` batches
 * and runs each through importClientLeads — the same validation, duplicate
 * protection, suppression and persistence as the dashboard import — then
 * records the result on the batch. `staged` batches are never processed; an
 * operator reviews and promotes them to `pending`.
 *
 * Claiming is a conditional update (pending → processing), so two processes
 * never import the same batch. A crash mid-import leaves it `processing`; it
 * is not retried automatically. Re-running it is safe anyway (already-written
 * rows come back as duplicates), but that is an operator decision.
 */

const { mirrorConfig } = require('../supabase-mirror');

const TABLE = 'client_lead_import_batches';
const REQUEST_TIMEOUT_MS = 30000;
const eq = value => `eq.${encodeURIComponent(String(value))}`;

function createImportBatchStore({ env = process.env, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const config = mirrorConfig(env);
  async function request(method, query, body, prefer = '') {
    if (!config.enabled) throw Object.assign(new Error(`import batches unavailable: ${config.reason || 'supabase not configured'}`), { code: 'import_batches_unavailable' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${config.url}/rest/v1/${TABLE}?${query}`, {
        method,
        headers: {
          apikey: config.key, Authorization: `Bearer ${config.key}`, Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(prefer ? { Prefer: prefer } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      if (!response.ok) throw Object.assign(new Error(`${TABLE} ${method} HTTP ${response.status}`), { code: 'import_batches_request_failed' });
      const raw = await response.text();
      return raw ? JSON.parse(raw) : [];
    } finally { clearTimeout(timer); }
  }
  return {
    enabled: config.enabled,
    listPendingIds: async () => (await request('GET', 'select=batch_id&status=eq.pending&order=created_at.asc&limit=5')).map(row => row.batch_id),
    // Conditional: only a still-pending batch is claimed, and only by one caller.
    claim: async batchId => (await request('PATCH', `batch_id=${eq(batchId)}&status=eq.pending&select=*`,
      { status: 'processing', claimed_at: new Date().toISOString() }, 'return=representation'))[0] || null,
    finish: (batchId, { status, result = null, error = null }) => request('PATCH', `batch_id=${eq(batchId)}&status=eq.processing`,
      { status, result, error, finished_at: new Date().toISOString() }, 'return=minimal'),
    listForClient: async clientId => request('GET', `select=batch_id,client_id,campaign_id,row_count,status,submitted_by,result,error,created_at,claimed_at,finished_at&client_id=${eq(clientId)}&order=created_at.desc&limit=50`),
  };
}

function createMemoryImportBatchStore(batches = []) {
  const rows = batches.map(batch => ({ status: 'pending', ...batch }));
  return {
    enabled: true, rows,
    listPendingIds: async () => rows.filter(row => row.status === 'pending').map(row => row.batch_id),
    claim: async batchId => {
      const row = rows.find(item => item.batch_id === batchId && item.status === 'pending');
      if (!row) return null;
      row.status = 'processing';
      return { ...row };
    },
    finish: async (batchId, { status, result = null, error = null }) => {
      const row = rows.find(item => item.batch_id === batchId && item.status === 'processing');
      if (row) Object.assign(row, { status, result, error });
    },
    listForClient: async clientId => rows.filter(row => row.client_id === clientId),
  };
}

// What a batch keeps of an import result: counts, refusals and written ids —
// enough to reconcile, nothing about leads it did not touch.
function batchResult(result) {
  return {
    received: result.received, accepted: result.accepted, rejected: result.rejected, duplicates: result.duplicates,
    written: result.written, refusalsByCode: result.refusalsByCode, refusals: (result.refusals || []).slice(0, 1000),
    writtenLeads: result.leads || [], mirror: result.mirror || null, emailUniqueness: result.emailUniqueness,
  };
}

/** Claim and import every pending batch, one at a time. Never throws. */
async function processPendingImportBatches({ store, importLeads, log = console } = {}) {
  const outcomes = [];
  if (!store?.enabled) return outcomes;
  let ids = [];
  try { ids = await store.listPendingIds(); } catch (error) { log.error(`[import-batches] list failed: ${error.message}`); return outcomes; }
  for (const id of ids) {
    let batch = null;
    try { batch = await store.claim(id); } catch (error) { log.error(`[import-batches] claim ${id} failed: ${error.message}`); continue; }
    if (!batch) continue;
    try {
      const rows = typeof batch.rows === 'string' ? JSON.parse(batch.rows) : batch.rows;
      const result = await importLeads({ clientId: batch.client_id, campaignId: batch.campaign_id, rows });
      await store.finish(id, { status: 'done', result: batchResult(result) });
      log.log(JSON.stringify({ event: 'client_import_batch_done', batch_id: id, client_id: result.clientId, received: result.received, written: result.written, rejected: result.rejected }));
      outcomes.push({ id, status: 'done', written: result.written, rejected: result.rejected });
    } catch (error) {
      log.error(JSON.stringify({ event: 'client_import_batch_failed', batch_id: id, code: error.code || 'error', error: error.message }));
      try { await store.finish(id, { status: 'failed', error: `${error.code || 'error'}: ${error.message}`.slice(0, 1000) }); } catch (_) { /* stays processing; reported above */ }
      outcomes.push({ id, status: 'failed', error: error.message });
    }
  }
  return outcomes;
}

module.exports = { createImportBatchStore, createMemoryImportBatchStore, processPendingImportBatches, batchResult, TABLE };
