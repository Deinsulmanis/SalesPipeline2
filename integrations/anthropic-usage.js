'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Anthropic = require('@anthropic-ai/sdk');

const FEATURES = Object.freeze({
  cold_personalization: 'cold_personalization',
  site_research: 'site_research',
  reply_classification: 'reply_classification',
  reply_question_answer: 'reply_question_answer',
  positive_reply_classification: 'positive_reply_classification',
  staffing_personalization: 'staffing_personalization',
  dental_personalization: 'dental_personalization',
  roofing_personalization: 'roofing_personalization',
  roofing_reply_classification: 'roofing_reply_classification',
  intent_classification: 'intent_classification',
  staffing_conversation_agent_shadow: 'staffing_conversation_agent_shadow',
  other: 'other',
});

const CRITICAL_FEATURES = new Set([
  FEATURES.reply_classification,
  FEATURES.reply_question_answer,
  FEATURES.positive_reply_classification,
  FEATURES.roofing_reply_classification,
  FEATURES.intent_classification,
]);

const TRACKED = Symbol('anthropic-tracked');
const USAGE_TZ = 'America/Vancouver';
const RETENTION_DAYS = 14;
const DEFAULT_WARN = 2_000_000;
const DEFAULT_HARD = 0;
const MAX_MEMORY_ROWS = 20_000;
const MAX_ATTEMPTS = 2;

const TOKEN_BUDGET_EXCEEDED = 'TOKEN_BUDGET_EXCEEDED';

let memory = [];
let testConfig = null;
let warnState = { day: '', logged: false, sinceLog: 0 };
let pgPool = null;
let pgReady = null;
let pruneCounter = 0;
let sleepFn = ms => new Promise(resolve => setTimeout(resolve, ms));

function knownFeature(value) {
  const tag = String(value || '').trim();
  return FEATURES[tag] || FEATURES.other;
}

function isCriticalFeature(feature) {
  return CRITICAL_FEATURES.has(knownFeature(feature));
}

function dayKey(date = new Date(), timeZone = USAGE_TZ) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function shiftDay(yyyyMmDd, deltaDays) {
  const [year, month, day] = String(yyyyMmDd).split('-').map(Number);
  const utc = Date.UTC(year, month - 1, day + deltaDays);
  return new Date(utc).toISOString().slice(0, 10);
}

function parseDateToken(value) {
  const text = String(value || '').trim();
  if (!text || text === 'today') return dayKey();
  if (text === 'yesterday') return shiftDay(dayKey(), -1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const error = new Error('date must be today, yesterday, or YYYY-MM-DD');
    error.code = 'INVALID_DATE';
    throw error;
  }
  return text;
}

function numberEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function warnLimit() {
  if (testConfig && testConfig.warn != null) return testConfig.warn;
  return numberEnv('ANTHROPIC_DAILY_TOKEN_WARN', DEFAULT_WARN);
}

function hardLimit() {
  if (testConfig && testConfig.hardLimit != null) return testConfig.hardLimit;
  return numberEnv('ANTHROPIC_DAILY_TOKEN_HARD_LIMIT', DEFAULT_HARD);
}

function usageDir() {
  if (testConfig && Object.prototype.hasOwnProperty.call(testConfig, 'dir')) return testConfig.dir;
  if (process.env.ANTHROPIC_USAGE_DIR) return process.env.ANTHROPIC_USAGE_DIR;
  if (process.env.NODE_TEST_CONTEXT) return null;
  return path.join(__dirname, '..', 'data', 'anthropic-usage');
}

function databaseUrl() {
  if (testConfig && Object.prototype.hasOwnProperty.call(testConfig, 'databaseUrl')) return testConfig.databaseUrl;
  if (process.env.NODE_TEST_CONTEXT && !process.env.ANTHROPIC_USAGE_DATABASE_URL) return '';
  return String(process.env.ANTHROPIC_USAGE_DATABASE_URL || process.env.SEND_LOCK_DATABASE_URL || '').trim();
}

function intOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function usageFromResponse(response) {
  const usage = response && response.usage;
  if (!usage || typeof usage !== 'object') {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      totalTokens: 0,
    };
  }
  const inputTokens = intOrZero(usage.input_tokens);
  const outputTokens = intOrZero(usage.output_tokens);
  const cacheCreationInputTokens = intOrZero(usage.cache_creation_input_tokens);
  const cacheReadInputTokens = intOrZero(usage.cache_read_input_tokens);
  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    totalTokens: inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens,
  };
}

function normalizeRecord(row = {}) {
  const tokens = usageFromResponse({ usage: {
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    cache_creation_input_tokens: row.cacheCreationInputTokens,
    cache_read_input_tokens: row.cacheReadInputTokens,
  } });
  const occurredAt = row.occurredAt || new Date().toISOString();
  const feature = knownFeature(row.feature);
  return {
    occurredAt,
    day: row.day || dayKey(new Date(occurredAt)),
    model: String(row.model || '').trim() || 'unknown',
    feature,
    operation: String(row.operation || '').trim() || 'messages.create',
    campaign: String(row.campaign || '').trim() || null,
    leadId: String(row.leadId || '').trim() || null,
    messageId: String(row.messageId || '').trim() || null,
    threadId: String(row.threadId || '').trim() || null,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    cacheCreationInputTokens: tokens.cacheCreationInputTokens,
    cacheReadInputTokens: tokens.cacheReadInputTokens,
    totalTokens: tokens.totalTokens,
    latencyMs: Number.isFinite(Number(row.latencyMs)) ? Math.max(0, Math.floor(Number(row.latencyMs))) : null,
    success: row.success === true,
    retryNumber: intOrZero(row.retryNumber),
    errorCode: row.success === true ? null : String(row.errorCode || 'unknown_error').slice(0, 120),
  };
}

function maybeWarn(totalTokens) {
  const warn = warnLimit();
  if (!warn || totalTokens < warn) return;
  const today = dayKey();
  if (warnState.day !== today) {
    warnState = { day: today, logged: false, sinceLog: 0 };
  }
  warnState.sinceLog += 1;
  if (warnState.logged && warnState.sinceLog < 50) return;
  warnState.logged = true;
  warnState.sinceLog = 0;
  console.warn(JSON.stringify({
    event: 'anthropic_daily_token_warn',
    day: today,
    totalTokens,
    warn,
    hardLimit: hardLimit() || null,
  }));
}

function todayTokenTotal(day = dayKey()) {
  return memory.filter(row => row.day === day && row.success).reduce((sum, row) => sum + row.totalTokens, 0);
}

function tokenBudgetError(feature, total, limit) {
  const error = new Error(`Anthropic daily token hard limit reached (${total}/${limit})`);
  error.code = TOKEN_BUDGET_EXCEEDED;
  error.feature = knownFeature(feature);
  error.failClosed = !isCriticalFeature(feature);
  error.routeToHuman = isCriticalFeature(feature);
  return error;
}

function gateModelCall(feature) {
  const limit = hardLimit();
  if (!limit) {
    maybeWarn(todayTokenTotal());
    return { allowed: true };
  }
  const total = todayTokenTotal();
  maybeWarn(total);
  if (total < limit) return { allowed: true };
  throw tokenBudgetError(feature, total, limit);
}

function appendJsonl(row) {
  const dir = usageDir();
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${row.day}.jsonl`);
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
  pruneCounter += 1;
  if (pruneCounter % 50 === 0) pruneFiles(dir);
}

function pruneFiles(dir) {
  const cutoff = shiftDay(dayKey(), -RETENTION_DAYS);
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
      if (name.slice(0, 10) < cutoff) fs.unlinkSync(path.join(dir, name));
    }
  } catch (_) { /* retention is best-effort */ }
}

async function ensurePg() {
  const url = databaseUrl();
  if (!url) return null;
  if (pgPool) return pgPool;
  if (pgReady) return pgReady;
  pgReady = (async () => {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: url,
      max: 2,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 4000,
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS anthropic_usage_events (
        id bigserial primary key,
        occurred_at timestamptz not null,
        model text not null,
        feature text not null,
        operation text,
        campaign text,
        lead_id text,
        message_id text,
        thread_id text,
        input_tokens integer not null default 0,
        output_tokens integer not null default 0,
        cache_creation_input_tokens integer not null default 0,
        cache_read_input_tokens integer not null default 0,
        total_tokens integer not null default 0,
        latency_ms integer,
        success boolean not null,
        retry_number integer not null default 0,
        error_code text
      )`);
    await pool.query('CREATE INDEX IF NOT EXISTS anthropic_usage_events_occurred_at_idx ON anthropic_usage_events (occurred_at)');
    pgPool = pool;
    return pool;
  })().catch(error => {
    pgReady = null;
    console.warn(JSON.stringify({
      event: 'anthropic_usage_pg_unavailable',
      error: String(error.message || error).slice(0, 200),
    }));
    return null;
  });
  return pgReady;
}

async function persistPg(row) {
  const pool = await ensurePg();
  if (!pool) return;
  await pool.query(
    `INSERT INTO anthropic_usage_events (
       occurred_at, model, feature, operation, campaign, lead_id, message_id, thread_id,
       input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
       total_tokens, latency_ms, success, retry_number, error_code
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      row.occurredAt, row.model, row.feature, row.operation, row.campaign, row.leadId, row.messageId, row.threadId,
      row.inputTokens, row.outputTokens, row.cacheCreationInputTokens, row.cacheReadInputTokens,
      row.totalTokens, row.latencyMs, row.success, row.retryNumber, row.errorCode,
    ],
  );
  if (pruneCounter % 50 === 1) {
    await pool.query(
      `DELETE FROM anthropic_usage_events WHERE occurred_at < NOW() - ($1 || ' days')::interval`,
      [String(RETENTION_DAYS)],
    );
  }
}

async function recordUsage(partial) {
  const row = normalizeRecord(partial);
  memory.push(row);
  if (memory.length > MAX_MEMORY_ROWS) memory = memory.slice(-Math.floor(MAX_MEMORY_ROWS * 0.75));
  try { appendJsonl(row); } catch (error) {
    console.warn(JSON.stringify({ event: 'anthropic_usage_file_write_failed', error: String(error.message || error).slice(0, 200) }));
  }
  try { await persistPg(row); } catch (error) {
    console.warn(JSON.stringify({ event: 'anthropic_usage_pg_write_failed', error: String(error.message || error).slice(0, 200) }));
  }
  return row;
}

function errorCodeOf(error) {
  if (!error) return 'unknown_error';
  if (error.code) return String(error.code).slice(0, 120);
  if (error.status) return `http_${error.status}`;
  return String(error.message || 'unknown_error').slice(0, 120);
}

function isRetryable(error) {
  if (!error || error.code === TOKEN_BUDGET_EXCEEDED) return false;
  const status = Number(error.status || error.error?.status || error.statusCode);
  if (status === 429 || status === 408 || status === 409) return true;
  if (status >= 500 && status < 600) return true;
  return /ECONNRESET|ETIMEDOUT|socket hang up|network/i.test(String(error.message || ''));
}

async function trackedCreate(send, input, context = {}) {
  const feature = knownFeature(context.feature);
  const model = String(input?.model || context.model || '').trim() || 'unknown';
  const maxAttempts = Math.max(1, Math.min(context.maxAttempts || MAX_ATTEMPTS, 3));
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const started = Date.now();
    try {
      gateModelCall(feature);
      const response = await send(input);
      await recordUsage({
        ...context,
        feature,
        model,
        success: true,
        retryNumber: attempt - 1,
        latencyMs: Date.now() - started,
        inputTokens: response?.usage?.input_tokens,
        outputTokens: response?.usage?.output_tokens,
        cacheCreationInputTokens: response?.usage?.cache_creation_input_tokens,
        cacheReadInputTokens: response?.usage?.cache_read_input_tokens,
      });
      return response;
    } catch (error) {
      lastError = error;
      const failedClosed = error && error.code === TOKEN_BUDGET_EXCEEDED;
      await recordUsage({
        ...context,
        feature,
        model,
        success: false,
        retryNumber: attempt - 1,
        latencyMs: Date.now() - started,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        errorCode: errorCodeOf(error),
      });
      if (failedClosed || !isRetryable(error) || attempt === maxAttempts) throw error;
      await sleepFn(250 * attempt);
    }
  }
  throw lastError;
}

function wrapCreateMessage(send, baseContext = {}) {
  if (typeof send !== 'function') throw new Error('createMessage is required');
  if (send[TRACKED]) {
    const nested = async (input, extra = {}) => send(input, { ...baseContext, ...extra });
    nested[TRACKED] = true;
    return nested;
  }
  const tracked = async (input, extra = {}) => trackedCreate(send, input, { ...baseContext, ...extra });
  tracked[TRACKED] = true;
  return tracked;
}

function createTrackedAnthropic({ apiKey, timeout = 60000, defaultContext = {} } = {}) {
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout });
  return {
    messages: {
      create: wrapCreateMessage(input => client.messages.create(input), defaultContext),
    },
  };
}

function inRange(row, from, to) {
  return row.day >= from && row.day <= to;
}

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const id = row[key] || '(none)';
    const cur = map.get(id) || {
      key: id, requests: 0, successes: 0, failures: 0,
      inputTokens: 0, outputTokens: 0, totalTokens: 0, maxInputTokens: 0,
    };
    cur.requests += 1;
    if (row.success) cur.successes += 1;
    else cur.failures += 1;
    cur.inputTokens += row.inputTokens;
    cur.outputTokens += row.outputTokens;
    cur.totalTokens += row.totalTokens;
    if (row.inputTokens > cur.maxInputTokens) cur.maxInputTokens = row.inputTokens;
    map.set(id, cur);
  }
  return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

function summarizeRows(rows, { date, from, to } = {}) {
  const totals = rows.reduce((acc, row) => {
    acc.requests += 1;
    if (row.success) acc.successes += 1;
    else acc.failures += 1;
    acc.inputTokens += row.inputTokens;
    acc.outputTokens += row.outputTokens;
    acc.cacheCreationInputTokens += row.cacheCreationInputTokens;
    acc.cacheReadInputTokens += row.cacheReadInputTokens;
    acc.totalTokens += row.totalTokens;
    if (row.inputTokens > acc.maxInputTokens) acc.maxInputTokens = row.inputTokens;
    return acc;
  }, {
    inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
    totalTokens: 0, requests: 0, successes: 0, failures: 0, maxInputTokens: 0,
  });
  const denom = totals.requests || 1;
  return {
    date: date || (from === to ? from : null),
    from,
    to,
    totals: {
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheCreationInputTokens: totals.cacheCreationInputTokens,
      cacheReadInputTokens: totals.cacheReadInputTokens,
      totalTokens: totals.totalTokens,
      requests: totals.requests,
      successes: totals.successes,
      failures: totals.failures,
    },
    averages: {
      inputTokensPerRequest: totals.requests ? totals.inputTokens / denom : 0,
      outputTokensPerRequest: totals.requests ? totals.outputTokens / denom : 0,
    },
    maxInputTokensPerRequest: totals.maxInputTokens,
    byFeature: groupBy(rows, 'feature'),
    byModel: groupBy(rows, 'model'),
    byCampaign: groupBy(rows, 'campaign'),
    highestTokenOperations: [...rows]
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .slice(0, 10)
      .map(row => ({
        occurredAt: row.occurredAt,
        feature: row.feature,
        operation: row.operation,
        model: row.model,
        campaign: row.campaign,
        leadId: row.leadId,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        totalTokens: row.totalTokens,
        success: row.success,
        retryNumber: row.retryNumber,
      })),
    limits: {
      warn: warnLimit() || null,
      hardLimit: hardLimit() || null,
      todayTokens: todayTokenTotal(),
    },
  };
}

function listUsageRecords() {
  return memory.slice();
}

function loadFiles(from, to) {
  const dir = usageDir();
  if (!dir || !fs.existsSync(dir)) return [];
  const rows = [];
  for (const name of fs.readdirSync(dir)) {
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
    const day = name.slice(0, 10);
    if (day < from || day > to) continue;
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(normalizeRecord(JSON.parse(line))); } catch (_) { /* skip bad line */ }
    }
  }
  return rows;
}

async function loadPg(from, to) {
  const pool = await ensurePg();
  if (!pool) return [];
  const result = await pool.query(
    `SELECT occurred_at AS "occurredAt", model, feature, operation, campaign,
            lead_id AS "leadId", message_id AS "messageId", thread_id AS "threadId",
            input_tokens AS "inputTokens", output_tokens AS "outputTokens",
            cache_creation_input_tokens AS "cacheCreationInputTokens",
            cache_read_input_tokens AS "cacheReadInputTokens",
            total_tokens AS "totalTokens", latency_ms AS "latencyMs",
            success, retry_number AS "retryNumber", error_code AS "errorCode"
       FROM anthropic_usage_events
      WHERE occurred_at >= $1::date
        AND occurred_at < ($2::date + interval '1 day')
      ORDER BY occurred_at ASC`,
    [from, to],
  );
  return result.rows.map(row => normalizeRecord(row));
}

function mergeRecords(groups) {
  const seen = new Set();
  const merged = [];
  for (const group of groups) {
    for (const row of group) {
      const key = `${row.occurredAt}|${row.feature}|${row.operation}|${row.leadId}|${row.retryNumber}|${row.success}|${row.totalTokens}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(row);
    }
  }
  return merged;
}

async function queryAnthropicUsage(query = {}) {
  const from = parseDateToken(query.from || query.date || 'today');
  const to = parseDateToken(query.to || query.from || query.date || 'today');
  if (to < from) {
    const error = new Error('to must be on or after from');
    error.code = 'INVALID_DATE';
    throw error;
  }
  const date = query.date && !query.from && !query.to ? from : (from === to ? from : null);
  const memoryRows = memory.filter(row => inRange(row, from, to));
  const fileRows = loadFiles(from, to);
  let pgRows = [];
  try { pgRows = await loadPg(from, to); } catch (_) { pgRows = []; }
  const rows = mergeRecords([memoryRows, fileRows, pgRows]);
  return summarizeRows(rows, { date, from, to });
}

function resetAnthropicUsage() {
  memory = [];
  testConfig = null;
  warnState = { day: '', logged: false, sinceLog: 0 };
  pruneCounter = 0;
}

function setAnthropicUsageConfigForTests(config) {
  testConfig = config ? { ...config } : null;
}

function setSleepForTests(fn) {
  sleepFn = fn || (ms => new Promise(resolve => setTimeout(resolve, ms)));
}

async function closeAnthropicUsageStore() {
  if (pgPool) {
    const pool = pgPool;
    pgPool = null;
    pgReady = null;
    await pool.end().catch(() => {});
  }
}

module.exports = {
  FEATURES,
  CRITICAL_FEATURES,
  TOKEN_BUDGET_EXCEEDED,
  USAGE_TZ,
  RETENTION_DAYS,
  DEFAULT_WARN,
  DEFAULT_HARD,
  knownFeature,
  isCriticalFeature,
  dayKey,
  wrapCreateMessage,
  createTrackedAnthropic,
  recordUsage,
  queryAnthropicUsage,
  summarizeRows,
  listUsageRecords,
  todayTokenTotal,
  gateModelCall,
  resetAnthropicUsage,
  setAnthropicUsageConfigForTests,
  setSleepForTests,
  closeAnthropicUsageStore,
};
