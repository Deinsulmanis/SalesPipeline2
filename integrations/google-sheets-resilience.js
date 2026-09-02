'use strict';

const DEFAULT_DELAYS_MS = Object.freeze([5000, 15000, 40000]);
const wrappedClients = new WeakSet();

function statusOf(error) {
  return Number(error?.response?.status || error?.code || error?.status || 0);
}

function isReadQuotaError(error) {
  const message = String(error?.message || error?.response?.data?.error?.message || '').toLowerCase();
  return statusOf(error) === 429
    || message.includes('read requests per minute per user')
    || (message.includes('quota') && message.includes('read'));
}

function retryAfterMs(error) {
  const headers = error?.response?.headers || {};
  const raw = typeof headers.get === 'function' ? headers.get('retry-after') : headers['retry-after'];
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

async function retrySheetsRead(operation, options = {}) {
  const {
    label = 'Sheets read',
    delaysMs = DEFAULT_DELAYS_MS,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    logger = console,
  } = options;
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!isReadQuotaError(error) || attempt >= delaysMs.length) throw error;
      const configured = Number(delaysMs[attempt]) || 0;
      const delay = Math.max(configured, retryAfterMs(error));
      attempt += 1;
      logger.warn?.(`[Sheets quota] ${label} attempt ${attempt}/${delaysMs.length + 1} deferred ${Math.ceil(delay / 1000)}s after 429`);
      await sleep(delay);
    }
  }
}

function wrapSheetsReadClient(client, options = {}) {
  if (!client?.spreadsheets || wrappedClients.has(client)) return client;
  const wrap = (target, method, label) => {
    if (!target || typeof target[method] !== 'function') return;
    const original = target[method].bind(target);
    target[method] = params => retrySheetsRead(() => original(params), { ...options, label });
  };
  wrap(client.spreadsheets, 'get', 'spreadsheets.get');
  wrap(client.spreadsheets.values, 'get', 'values.get');
  wrap(client.spreadsheets.values, 'batchGet', 'values.batchGet');
  wrappedClients.add(client);
  return client;
}

module.exports = {
  DEFAULT_DELAYS_MS,
  isReadQuotaError,
  retryAfterMs,
  retrySheetsRead,
  wrapSheetsReadClient,
};
