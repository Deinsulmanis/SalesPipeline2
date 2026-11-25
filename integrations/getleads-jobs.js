'use strict';
// GetLeads job-postings client (search_jobs over the hosted MCP endpoint).
// One call at a time per process: GetLeads rejects concurrent queries with
// 503 "too many concurrent queries", so every call is queued behind the last
// and retried with backoff. Free jobs quota only; no plan-credit tools here.

const DEFAULT_URL = 'https://app.getleads.io/api/mcp';
const BACKOFF_MS = [2000, 5000, 10000, 20000];
const REQUEST_TIMEOUT_MS = 60000;
const JOB_FUNCTIONS = ['Manufacturing', 'Skilled Trades & Maintenance', 'Supply Chain & Logistics'];

function codedError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

const retryable = error => error.code === 'getleads_busy' || error.code === 'getleads_timeout'
  || (error.status >= 500 && error.status < 600);

function createGetLeadsJobsClient({ env = process.env, fetchImpl = global.fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), backoff = BACKOFF_MS } = {}) {
  const apiKey = String(env.GETLEADS_API_KEY || '').trim();
  const url = String(env.GETLEADS_MCP_URL || DEFAULT_URL).trim();
  let session = null;
  let nextId = 1;
  let queue = Promise.resolve();

  async function post(payload) {
    if (!apiKey) throw codedError('getleads_unconfigured', 'GETLEADS_API_KEY is not set');
    let response;
    try {
      response = await fetchImpl(url, { method: 'POST', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream', ...(session ? { 'Mcp-Session-Id': session } : {}) },
        body: JSON.stringify(payload) });
    } catch (error) {
      throw codedError(/timeout|abort/i.test(error.name || '') ? 'getleads_timeout' : 'getleads_network', error.message);
    }
    const text = await response.text();
    const sid = response.headers?.get?.('Mcp-Session-Id');
    if (sid) session = sid;
    if (response.status === 503 || /too many concurrent|admission timeout/i.test(text)) {
      throw codedError('getleads_busy', 'GetLeads is busy (concurrent query limit)');
    }
    if (!response.ok) {
      const error = codedError('getleads_http', `GetLeads returned ${response.status}`);
      error.status = response.status;
      throw error;
    }
    if (!text) return null;
    const body = /^(?:event|data):/.test(text)
      ? text.split(/\r?\n/).find(line => line.startsWith('data:'))?.slice(5).trim() : text;
    return JSON.parse(body);
  }

  async function ensureSession() {
    if (session) return;
    await post({ jsonrpc: '2.0', id: nextId++, method: 'initialize', params: {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'salespipeline-jobs', version: '1.0' } } });
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async function callOnce(args) {
    await ensureSession();
    const reply = await post({ jsonrpc: '2.0', id: nextId++, method: 'tools/call',
      params: { name: 'search_jobs', arguments: args } });
    if (reply?.error) {
      if (/session/i.test(JSON.stringify(reply.error))) session = null;
      throw codedError(/concurrent/i.test(JSON.stringify(reply.error)) ? 'getleads_busy' : 'getleads_rpc_error',
        String(reply.error.message || 'GetLeads RPC error').slice(0, 200));
    }
    const result = reply?.result;
    const content = result?.content?.[0]?.text;
    if (result?.isError) {
      throw codedError(/concurrent|admission/i.test(String(content)) ? 'getleads_busy' : 'getleads_tool_error',
        String(content || 'search_jobs failed').slice(0, 200));
    }
    const parsed = JSON.parse(content || 'null');
    if (!parsed || !Array.isArray(parsed.data)) throw codedError('getleads_invalid_response', 'search_jobs returned no data array');
    return parsed;
  }

  async function withBackoff(args) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await callOnce(args);
      } catch (error) {
        if (!retryable(error) || attempt >= backoff.length) throw error;
        await sleep(backoff[attempt]);
      }
    }
  }

  /** Open hands-on postings for one employer domain, posted within `days`. */
  function searchCompanyJobs(domain, { now = new Date(), days = 30, limit = 50 } = {}) {
    const since = new Date(new Date(now).getTime() - days * 86400000).toISOString().slice(0, 10);
    const args = { company_domain: String(domain || '').trim().toLowerCase(), country: 'US', status: 'open',
      posted_since: since, job_functions: JOB_FUNCTIONS, limit };
    if (!args.company_domain) return Promise.reject(codedError('getleads_invalid_domain', 'domain is required'));
    const run = queue.then(() => withBackoff(args));
    queue = run.catch(() => {});
    return run;
  }

  /**
   * Companies with open hands-on postings in one city (group_by company).
   * The city filter is a word match, so callers verify the state per company.
   */
  function searchCityEmployers(city, { now = new Date(), days = 30, limit = 50 } = {}) {
    const since = new Date(new Date(now).getTime() - days * 86400000).toISOString().slice(0, 10);
    const args = { city: String(city || '').trim(), country: 'US', status: 'open', posted_since: since,
      job_functions: JOB_FUNCTIONS, group_by: 'company', limit };
    if (!args.city) return Promise.reject(codedError('getleads_invalid_city', 'city is required'));
    const run = queue.then(() => withBackoff(args));
    queue = run.catch(() => {});
    return run;
  }

  return { searchCompanyJobs, searchCityEmployers, configured: Boolean(apiKey) };
}

module.exports = { createGetLeadsJobsClient, JOB_FUNCTIONS, DEFAULT_URL };
