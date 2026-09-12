'use strict';
/**
 * outreach-state.js — Stage 3 operational outreach state access layer.
 * ─────────────────────────────────────────────────────────────────────────────
 * One place that knows how ColdEmail operational state is stored. Google Sheets
 * remains authoritative; this mirrors the resulting row to Supabase after a
 * Sheets write has already succeeded, and nothing reads from it for an
 * operational decision until a cutover is separately approved.
 *
 * The design constraints are Stage 1's, for the same reason — this sits beside
 * the system that sends email to real people:
 *
 *   * Optional. Unconfigured means every call is a cheap no-op.
 *   * Non-blocking. The mirror functions never throw and never reject; the
 *     authoritative write already happened and there is nothing to handle.
 *   * Idempotent. lead_id is the primary key and every write is an upsert.
 *   * Lossless. Fields are mirrored as the exact strings the sheet holds,
 *     because the runtime compares them as strings.
 *
 * ── THE PARTIAL-ROW HAZARD, AND THE GUARD THAT EXISTS FOR IT ────────────────
 *
 * ColdEmail is read at two different widths, and only one of them is a whole
 * lead:
 *
 *   readLeads()            reads A:X and sets all 24 COLUMNS keys — complete.
 *   findColdEmailTwins()   reads A:U and projects NINE fields — partial.
 *
 * A twin carries nine fields and is missing fifteen — contactName, city,
 * tradeType, website, reviewCount, rating, tier, siteContext, campaign,
 * campaign_notes, enrichment_attempted, leadNiche, emailTemplateId,
 * routingRequired and intendedCampaignVersion. Upserting one as if it were a
 * whole row would write '' over all fifteen, TWELVE of them behaviour-critical:
 * it would silently destroy campaign identity, niche, the template and
 * readiness gate, and the routing guard for that lead. That is precisely the
 * class of fail-open defect this codebase keeps finding, so it is refused
 * structurally rather than by convention:
 *
 *   mirrorOutreachLeads()      demands a COMPLETE row and reports any lead that
 *                              is not, instead of blanking its columns.
 *   mirrorOutreachLeadFields() writes a NARROW patch — lead_id plus exactly the
 *                              columns the caller actually changed.
 *
 * Completeness is judged by key PRESENCE, not by truthiness, because '' is a
 * legitimate ColdEmail value and absence is not. That distinguishes the two
 * readers exactly, with no list of trusted call sites to keep in sync.
 *
 * A patch is a correct upsert: PostgREST builds its ON CONFLICT column list
 * from the payload keys, so columns absent from the body are left untouched on
 * an existing row.
 *
 * ── WHY THERE IS NO WRITE PATH HERE YET ─────────────────────────────────────
 *
 * ColdEmail has no concurrency control today — writes are last-writer-wins on a
 * cell range, made safe only by the accident that a single cron process writes
 * narrow ranges. Row-level upserts remove that accidental protection, so moving
 * write authority needs compare-and-set on `revision`. The column exists;
 * nothing uses it yet, and this module deliberately does not pretend otherwise.
 */

const { mirrorConfig } = require('./supabase-mirror');

const TABLE = 'outreach_leads';
const REQUEST_TIMEOUT_MS = 5000;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 250;

/**
 * The ColdEmail column order (outreach-agent.js COLUMNS, A:X) mapped to its
 * Supabase column. Order matters: it is asserted against COLUMNS by the tests,
 * so adding a sheet column without extending this fails loudly.
 */
const FIELD_MAP = Object.freeze({
  id: 'lead_id', company: 'company', contactName: 'contact_name', email: 'email',
  city: 'city', tradeType: 'trade_type', website: 'website', stage: 'stage',
  emailStatus: 'email_status', lastEmailedAt: 'last_emailed_at', emailStep: 'email_step',
  notes: 'notes', reviewCount: 'review_count', rating: 'rating', tier: 'tier',
  siteContext: 'site_context', campaign: 'campaign', campaign_notes: 'campaign_notes',
  enrichment_attempted: 'enrichment_attempted', leadNiche: 'lead_niche',
  senderInboxId: 'sender_inbox_id', emailTemplateId: 'email_template_id',
  routingRequired: 'routing_required', intendedCampaignVersion: 'intended_campaign_version',
});
const SHEET_FIELDS = Object.freeze(Object.keys(FIELD_MAP));

/**
 * Parity classification. CRITICAL is anything that can change what the system
 * DOES — send eligibility, sender, campaign, routing, cadence, hold. A critical
 * mismatch blocks cutover; a noncritical one is reported and does not.
 *
 * From the Stage 3A field inventory: 21 of 24 are behaviour-critical.
 */
const NONCRITICAL_FIELDS = Object.freeze(['reviewCount', 'campaign_notes', 'enrichment_attempted']);
const CRITICAL_FIELDS = Object.freeze(SHEET_FIELDS.filter(f => !NONCRITICAL_FIELDS.includes(f)));

/**
 * Stage 3 mode. Defaults to 'off', so deploying this changes nothing.
 *   off     — Sheets only; Supabase is neither read nor written
 *   dual    — Sheets authoritative; Supabase mirrored and compared
 *   primary — Supabase serves operational state (NOT approved; no reader honours
 *             it yet, and it is listed here only so the value is not silently
 *             coerced to 'dual' by a typo)
 */
function outreachStateMode(env = process.env) {
  const raw = String(env.SUPABASE_OUTREACH_MODE || '').trim().toLowerCase();
  return ['dual', 'primary'].includes(raw) ? raw : 'off';
}

const text = value => (value === null || value === undefined ? '' : String(value));

/** A timestamp Postgres accepts, or null. Never a substituted "now". */
function isoOrNull(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function intOrNull(value) {
  const raw = String(value === null || value === undefined ? '' : value).trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

/**
 * Which of the 24 ColdEmail fields this object does not carry.
 * Key presence, not truthiness: '' is a real value, absent is not.
 */
function missingFields(lead = {}) {
  return SHEET_FIELDS.filter(field => !Object.prototype.hasOwnProperty.call(lead, field));
}

/** True only for an object shaped like a full A:X read. */
function isCompleteLead(lead = {}) {
  return missingFields(lead).length === 0;
}

/**
 * Why this lead cannot be mirrored as a whole row, or null.
 * Returned rather than thrown: a mirror never interrupts its caller.
 */
function describeUnmirrorable(lead = {}) {
  if (!lead || typeof lead !== 'object') return 'not a lead object';
  if (!String(lead.id || '').trim()) return 'missing lead id';
  const missing = missingFields(lead);
  if (missing.length) {
    const shown = missing.slice(0, 4).join(', ') + (missing.length > 4 ? ', …' : '');
    return `partial row — ${missing.length} field(s) absent (${shown}); `
      + 'use mirrorOutreachLeadFields for a narrow write';
  }
  return null;
}

/** ColdEmail row -> outreach_leads row. Values preserved verbatim. */
function toOutreachLeadRow(lead = {}, { sheetRow = null, now = new Date() } = {}) {
  const stamp = now.toISOString();
  const row = {};
  for (const [field, column] of Object.entries(FIELD_MAP)) row[column] = text(lead[field]);
  // Derived, for indexing only; the text columns above stay the source of truth.
  row.last_emailed_at_ts = isoOrNull(lead.lastEmailedAt);
  row.email_step_int = intOrNull(lead.emailStep);
  const parsedRow = Number(sheetRow === null || sheetRow === undefined ? lead._row : sheetRow);
  row.sheet_row = Number.isInteger(parsedRow) ? parsedRow : null;
  row.updated_at = stamp;
  row.mirrored_at = stamp;
  return row;
}

/**
 * A narrow patch: lead_id plus exactly the fields named. Unknown field names are
 * refused rather than dropped, so a typo at a call site surfaces here instead of
 * mirroring nothing and looking healthy.
 */
function toOutreachLeadPatch(id, fields = {}, { now = new Date() } = {}) {
  const leadId = String(id || '').trim();
  if (!leadId) throw new Error('toOutreachLeadPatch requires a lead id');
  const names = Object.keys(fields);
  const unknown = names.filter(field => !Object.prototype.hasOwnProperty.call(FIELD_MAP, field));
  if (unknown.length) throw new Error(`unknown ColdEmail field(s): ${unknown.join(', ')}`);
  if (!names.length) throw new Error('toOutreachLeadPatch requires at least one field');

  const stamp = now.toISOString();
  const patch = { lead_id: leadId, updated_at: stamp, mirrored_at: stamp };
  for (const field of names) {
    patch[FIELD_MAP[field]] = text(fields[field]);
    // Keep the derived columns consistent with the text column they come from,
    // so a patched cadence value cannot leave a stale index behind.
    if (field === 'lastEmailedAt') patch.last_emailed_at_ts = isoOrNull(fields[field]);
    if (field === 'emailStep') patch.email_step_int = intOrNull(fields[field]);
  }
  return patch;
}

/** outreach_leads row -> ColdEmail shape, exactly as the runtime expects it. */
function fromOutreachLeadRow(row = {}) {
  const lead = {};
  for (const [field, column] of Object.entries(FIELD_MAP)) lead[field] = text(row[column]);
  return lead;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function request(url, options, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

const headersFor = (config, extra = {}) => ({
  apikey: config.key, Authorization: `Bearer ${config.key}`,
  'Content-Type': 'application/json', ...extra,
});

/**
 * POST an upsert batch. Returns a reason string on failure, null on success.
 * Only the HTTP status is recorded — a PostgREST error body can echo submitted
 * values, and those are prospect details.
 */
async function upsert(rows, { env, logger, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const config = mirrorConfig(env);
  const endpoint = `${config.url}/rest/v1/${TABLE}`;
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await request(endpoint, {
        method: 'POST',
        headers: headersFor(config, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify(rows),
      }, timeoutMs);
      if (response.ok) return null;
      lastError = `HTTP ${response.status}`;
      if (response.status < 500 && response.status !== 409) break;
    } catch (error) {
      lastError = error && error.name === 'AbortError'
        ? `timeout after ${timeoutMs}ms`
        : (error && error.message) || 'request failed';
    }
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
  }
  (logger || console).warn(`[outreach-state] deferred ${rows.length} lead row(s) — ${lastError}. `
    + 'Google Sheets is unaffected; re-run the Stage 3 backfill to reconcile.');
  return lastError;
}

/**
 * Mirror COMPLETE lead rows. NEVER throws, NEVER rejects.
 * Anything that is not a whole A:X row is skipped and reported, never blanked.
 */
async function mirrorOutreachLeads(leads, { env = process.env, logger = console } = {}) {
  const input = Array.isArray(leads) ? leads : [leads];
  const config = mirrorConfig(env);
  const empty = { enabled: false, attempted: 0, mirrored: 0, skipped: 0, failed: 0, skippedDetail: [] };
  if (!config.enabled) return { ...empty, reason: config.reason };
  if (!input.length) return { ...empty, enabled: true, reason: 'nothing to mirror' };

  const rows = [];
  const skippedDetail = [];
  for (const lead of input) {
    const problem = describeUnmirrorable(lead);
    if (problem) skippedDetail.push({ id: (lead && lead.id) || null, problem });
    else rows.push(toOutreachLeadRow(lead));
  }
  if (skippedDetail.length) {
    (logger || console).warn(`[outreach-state] skipped ${skippedDetail.length} lead(s): ${skippedDetail[0].problem}`);
  }
  if (!rows.length) {
    return { ...empty, enabled: true, skipped: skippedDetail.length, skippedDetail, reason: 'no complete leads to mirror' };
  }

  // A large batch is chunked: one oversized request that times out loses every
  // row in it, and the backfill would rather lose a slice than a tab.
  const CHUNK = 500;
  let failed = 0;
  let reason = 'ok';
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const error = await upsert(chunk, { env, logger, timeoutMs: chunk.length > 50 ? 20000 : REQUEST_TIMEOUT_MS });
    if (error) { failed += chunk.length; reason = error; }
  }
  return {
    enabled: true, attempted: rows.length, mirrored: rows.length - failed,
    skipped: skippedDetail.length, skippedDetail, failed, reason,
  };
}

/**
 * Mirror a NARROW change — the columns a single-column writer actually wrote.
 * NEVER throws, NEVER rejects: a bad field name is reported, not raised, because
 * callers sit immediately after an authoritative Sheets write.
 */
async function mirrorOutreachLeadFields(id, fields, { env = process.env, logger = console } = {}) {
  const config = mirrorConfig(env);
  if (!config.enabled) return { enabled: false, mirrored: 0, failed: 0, reason: config.reason };
  let patch;
  try {
    patch = toOutreachLeadPatch(id, fields);
  } catch (error) {
    const reason = (error && error.message) || 'invalid patch';
    (logger || console).warn(`[outreach-state] refused patch: ${reason}`);
    return { enabled: true, mirrored: 0, failed: 0, reason };
  }
  const error = await upsert([patch], { env, logger });
  return error
    ? { enabled: true, mirrored: 0, failed: 1, reason: error }
    : { enabled: true, mirrored: 1, failed: 0, reason: 'ok', fields: Object.keys(fields) };
}

/** Fire-and-forget wrappers for the authoritative write paths. */
function inBackground(promiseFactory, logger) {
  try {
    const result = promiseFactory();
    if (result && typeof result.catch === 'function') {
      result.catch(error => {
        (logger || console).warn(`[outreach-state] background mirror failed: ${(error && error.message) || 'unknown error'}`);
      });
    }
  } catch (error) {
    (logger || console).warn(`[outreach-state] background mirror could not start: ${(error && error.message) || 'unknown error'}`);
  }
}

function mirrorOutreachLeadsInBackground(leads, options = {}) {
  inBackground(() => mirrorOutreachLeads(leads, options), options.logger);
}

function mirrorOutreachLeadFieldsInBackground(id, fields, options = {}) {
  inBackground(() => mirrorOutreachLeadFields(id, fields, options), options.logger);
}

// ── reads (parity only until a cutover is approved) ─────────────────────────

async function selectLeads(query, { env = process.env, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const config = mirrorConfig(env);
  if (!config.enabled) return { ok: false, leads: [], rows: [], reason: config.reason };
  try {
    const response = await request(`${config.url}/rest/v1/${TABLE}?${query}`,
      { headers: headersFor(config) }, timeoutMs);
    if (!response.ok) return { ok: false, leads: [], rows: [], reason: `HTTP ${response.status}` };
    const rows = await response.json();
    return { ok: true, leads: rows.map(fromOutreachLeadRow), rows, reason: 'ok' };
  } catch (error) {
    const reason = error && error.name === 'AbortError' ? 'timeout' : (error && error.message) || 'unreachable';
    return { ok: false, leads: [], rows: [], reason };
  }
}

// PostgREST quotes a filter value with double quotes; stripping them keeps a
// value containing one from terminating the literal and altering the query.
const quote = value => `"${String(value).split('"').join('')}"`;

async function getOutreachLeadById(id, options = {}) {
  if (!String(id || '').trim()) return { ok: false, lead: null, reason: 'no lead id supplied' };
  const result = await selectLeads(`select=*&lead_id=eq.${quote(id)}&limit=1`, options);
  return { ...result, lead: result.ok ? (result.leads[0] || null) : null };
}

async function getOutreachLeadByEmail(email, options = {}) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return { ok: false, lead: null, reason: 'no email supplied' };
  const result = await selectLeads(`select=*&email_normalized=eq.${quote(normalized)}&limit=1`, options);
  return { ...result, lead: result.ok ? (result.leads[0] || null) : null };
}

/** One request for many leads, so a directory page is never N queries. */
async function batchGetOutreachLeads(ids, options = {}) {
  const list = [...new Set((ids || []).map(id => String(id || '').trim()).filter(Boolean))];
  if (!list.length) return { ok: true, byId: new Map(), reason: 'no lead ids supplied' };
  const result = await selectLeads(
    `select=*&lead_id=in.(${list.map(quote).join(',')})&limit=${list.length}`,
    { ...options, timeoutMs: 15000 });
  if (!result.ok) return { ok: false, byId: new Map(), reason: result.reason };
  return { ok: true, byId: new Map(result.leads.map(lead => [lead.id, lead])), reason: 'ok' };
}

/** A page of the mirror, ordered so paging is stable. */
async function listOutreachLeads({ limit = 1000, offset = 0, ...options } = {}) {
  const size = Math.max(1, Math.min(Number(limit) || 1000, 5000));
  const from = Math.max(0, Number(offset) || 0);
  return selectLeads(`select=*&order=lead_id.asc&limit=${size}&offset=${from}`,
    { ...options, timeoutMs: 20000 });
}

async function countOutreachLeads({ env = process.env } = {}) {
  const config = mirrorConfig(env);
  if (!config.enabled) return { ok: false, count: null, reason: config.reason };
  try {
    const response = await request(`${config.url}/rest/v1/${TABLE}?select=lead_id`,
      { method: 'HEAD', headers: headersFor(config, { Prefer: 'count=exact' }) });
    if (!response.ok) return { ok: false, count: null, reason: `HTTP ${response.status}` };
    const count = Number((response.headers.get('content-range') || '').split('/')[1]);
    return { ok: true, count: Number.isFinite(count) ? count : null, reason: 'ok' };
  } catch (error) {
    return { ok: false, count: null, reason: (error && error.message) || 'unreachable' };
  }
}

/**
 * Field-by-field parity between the authoritative sheet row and the mirror.
 *
 * Normalises only what is genuinely non-semantic: null and absent are the same
 * statement, and both become ''. Nothing else is normalised — a null sender and
 * 'tryscalelabai' are not the same thing, and trimming or case-folding a value
 * the runtime compares exactly would hide a real divergence.
 */
function compareOutreachLead(sheetLead = {}, mirroredLead = null) {
  if (!mirroredLead) {
    return { present: false, critical: ['<missing from supabase>'], noncritical: [], clean: false };
  }
  const critical = [];
  const noncritical = [];
  for (const field of SHEET_FIELDS) {
    if (text(sheetLead[field]) === text(mirroredLead[field])) continue;
    (NONCRITICAL_FIELDS.includes(field) ? noncritical : critical).push(field);
  }
  return { present: true, critical, noncritical, clean: !critical.length && !noncritical.length };
}

module.exports = {
  TABLE, FIELD_MAP, SHEET_FIELDS, CRITICAL_FIELDS, NONCRITICAL_FIELDS,
  outreachStateMode, isCompleteLead, missingFields, describeUnmirrorable,
  toOutreachLeadRow, toOutreachLeadPatch, fromOutreachLeadRow,
  mirrorOutreachLeads, mirrorOutreachLeadFields,
  mirrorOutreachLeadsInBackground, mirrorOutreachLeadFieldsInBackground,
  getOutreachLeadById, getOutreachLeadByEmail, batchGetOutreachLeads,
  listOutreachLeads, countOutreachLeads, compareOutreachLead,
};
