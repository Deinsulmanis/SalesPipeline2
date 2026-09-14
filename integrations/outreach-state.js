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
 * ── THE MUTATION PATH, AND WHERE AUTHORITY LIVES ────────────────────────────
 *
 * applyLeadChange() below is the single canonical way to mutate operational
 * lead state. Today it writes Google Sheets first and then brings the mirror
 * current in the same call, because Sheets is still authoritative. At 3F the
 * authority flips inside that one function — Supabase compare-and-set on
 * `revision`, Sheets demoted to a secondary mirror — and no call site changes.
 *
 * `revision` exists in the schema and is deliberately UNUSED while Sheets is
 * authoritative: compare-and-set against a column nothing increments would be
 * ceremony, not safety. ColdEmail has no concurrency control today either —
 * writes are last-writer-wins on a cell range, made safe only by the accident
 * that a single cron process writes narrow ranges — so the protection has to
 * arrive together with the authority, not before it.
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

/**
 * WHERE CANONICAL WRITES GO. Separate from the read mode on purpose: the read
 * cutover (3E) and the write-authority cutover (3F) are different risks and must
 * be deployable, observable and reversible independently.
 *
 *   sheets   — Google Sheets is canonical; Supabase is a mirror kept current by
 *              applyLeadChange. A read that falls back to Sheets falls back to
 *              TRUTH, so a fallback is safe for every caller.
 *   supabase — Supabase is canonical; Sheets is a secondary mirror that may lag.
 *              A read that falls back to Sheets now falls back to a STALE copy,
 *              so automation must fail closed instead.
 *
 * That inversion is the whole reason this is its own function rather than a
 * fourth value of the read mode: the safety of a fallback depends on who owns
 * writes, not on where reads are served from.
 */
function outreachWriteAuthority(env = process.env) {
  return String(env.SUPABASE_OUTREACH_WRITES || '').trim().toLowerCase() === 'supabase'
    ? 'supabase' : 'sheets';
}

/**
 * May a read that failed against Supabase fall back to Google Sheets?
 *
 * @param surface 'ui' for reporting/display, 'automation' for anything that can
 *                decide a send, a sequence step, routing or ownership.
 */
function sheetsFallbackAllowed(surface, env = process.env) {
  if (outreachWriteAuthority(env) === 'sheets') {
    // Sheets still receives every canonical write, so it cannot be behind.
    return { allowed: true, reason: 'sheets-is-canonical' };
  }
  // Supabase is canonical. Sheets is a mirror and may lag by an unknown amount.
  if (surface === 'ui') return { allowed: true, reason: 'ui-read-may-show-lagged-mirror' };
  return { allowed: false, reason: 'automation-must-not-decide-from-a-lagging-mirror' };
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
 * The WHOLE operational corpus as complete ColdEmail rows, ordered by lead id.
 *
 * One paged scan, never a query per lead: both read chokepoints hold the entire
 * corpus already, and turning that into N requests would make a read cutover
 * slower than the thing it replaces.
 *
 * `_row` is deliberately NOT set from the mirror. sheet_row is advisory and goes
 * stale the moment a delete shifts rows, and a stale row number lands a write on
 * the WRONG lead. Callers that write resolve the row themselves, as resolveRow()
 * and findCERow() already do.
 */
async function readOutreachCorpus({ env = process.env, pageSize = 1000 } = {}) {
  const leads = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await listOutreachLeads({ limit: pageSize, offset, env });
    if (!page.ok) return { ok: false, leads: [], reason: page.reason };
    for (const lead of page.leads) leads.push(lead);
    if (page.leads.length < pageSize) break;
  }
  return { ok: true, leads, reason: 'ok' };
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

// ── the canonical mutation abstraction (Stage 3 Phase A) ────────────────────
//
// Every live operational ColdEmail mutation goes through applyLeadChange().
// Today it writes Google Sheets first, because Sheets is still authoritative,
// and then brings the Supabase mirror current in the same call. At 3F the
// authority flips INSIDE this function — Supabase compare-and-set on `revision`
// first, Sheets demoted to a secondary mirror — and no call site changes.
//
// That single-conversion property is the whole point. There are 31 ColdEmail
// write sites; converting them twice, in the system that emails real prospects,
// would be the riskiest way to reach the same end state.
//
// WHY A PATCH AND NOT A REFETCHED FULL ROW
//
// The obvious alternative is to re-read the whole row after writing and mirror
// that. It costs an extra Sheets read per mutation against a quota that is
// already this system's binding constraint, and it reintroduces exactly the
// partial-row hazard the Stage 3B guard exists to prevent: whatever the re-read
// projects becomes the mirrored truth, and a narrow projection would blank
// fields it never loaded.
//
// A patch cannot do that. PostgREST builds its ON CONFLICT column list from the
// payload keys, so mirroring {stage} touches `stage` and nothing else. Fields
// the mutation did not change are already correct in the mirror and are left
// alone. Narrow in, narrow out.

/** ColdEmail column letter for a field: A..X, in CE_COLUMNS order. */
function columnLetterFor(field) {
  const index = SHEET_FIELDS.indexOf(field);
  if (index === -1) throw new Error(`unknown ColdEmail field: ${field}`);
  return String.fromCharCode(65 + index);
}

const writeDiagnostics = {
  startedAt: new Date().toISOString(),
  mutations: 0, mirrored: 0, mirrorFailures: 0,
  lastMutationAt: null, lastMirrorFailureAt: null, lastMirrorFailureReason: null,
  maxMirrorLatencyMs: 0, recent: [],
};
const MAX_WRITE_RECENT = 20;

function noteWrite(entry) {
  writeDiagnostics.recent.unshift(entry);
  if (writeDiagnostics.recent.length > MAX_WRITE_RECENT) writeDiagnostics.recent.length = MAX_WRITE_RECENT;
}

function outreachWriteDiagnostics() {
  return { ...writeDiagnostics, recent: writeDiagnostics.recent.slice(0, MAX_WRITE_RECENT) };
}

function resetOutreachWriteDiagnostics() {
  Object.assign(writeDiagnostics, {
    startedAt: new Date().toISOString(),
    mutations: 0, mirrored: 0, mirrorFailures: 0,
    lastMutationAt: null, lastMirrorFailureAt: null, lastMirrorFailureReason: null,
    maxMirrorLatencyMs: 0, recent: [],
  });
}

/**
 * Apply one operational change to a lead.
 *
 * @param leadId   canonical ColdEmail id — the mirror's primary key
 * @param patch    {field: value} in ColdEmail field names; exactly the cells to write
 * @param row      1-based ColdEmail sheet row (resolved by the caller, as today)
 * @param sheetsClient  the caller's authenticated Google client. Passed in rather
 *                 than imported so this module keeps no Google dependency — the
 *                 same constraint the Stage 3 tests assert.
 * @param extraData additional {range, values} written in the SAME batch, for
 *                 mutations whose atomicity spans sheets (a contact change must
 *                 land the new address and its MANUAL HOLD together, or an
 *                 intermediate state could mail the new address).
 *
 * Sheets is authoritative: a Sheets failure THROWS, exactly as before, so
 * callers keep their current error behaviour. The mirror never throws — the
 * operational action is already committed and Sheets still holds the truth.
 */
async function applyLeadChange(leadId, patch, {
  row, sheetsClient, spreadsheetId, extraData = [],
  sheetName = 'ColdEmail', valueInputOption = 'RAW',
  env = process.env, logger = console,
} = {}) {
  const id = String(leadId || '').trim();
  if (!id) throw new Error('applyLeadChange requires a lead id');
  if (!sheetsClient || !spreadsheetId) throw new Error('applyLeadChange requires a Sheets client and spreadsheetId');
  const fields = Object.keys(patch || {});
  if (!fields.length && !extraData.length) throw new Error('applyLeadChange requires at least one field');

  const parsedRow = Number(row);
  if (fields.length && !Number.isInteger(parsedRow)) {
    throw new Error(`applyLeadChange requires a resolved sheet row for lead ${id}`);
  }
  // Unknown names are refused before anything is written, so a typo cannot put
  // a value in the wrong column or mirror nothing while looking healthy.
  const unknown = fields.filter(field => !Object.prototype.hasOwnProperty.call(FIELD_MAP, field));
  if (unknown.length) throw new Error(`unknown ColdEmail field(s): ${unknown.join(', ')}`);

  const data = [
    ...fields.map(field => ({
      range: `${sheetName}!${columnLetterFor(field)}${parsedRow}`,
      values: [[patch[field] === null || patch[field] === undefined ? '' : String(patch[field])]],
    })),
    ...extraData,
  ];

  // 1. AUTHORITATIVE WRITE. Throws on failure, as every call site expects today.
  await sheetsClient.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption, data },
  });

  writeDiagnostics.mutations++;
  writeDiagnostics.lastMutationAt = new Date().toISOString();

  // 2. BRING THE MIRROR CURRENT. Awaited, so a read cutover can rely on
  //    read-your-writes; bounded and non-throwing, so a Supabase problem can
  //    never undo or obscure an action Sheets has already committed.
  let mirrored = false;
  let mirrorReason = 'skipped';
  if (fields.length && outreachStateMode(env) !== 'off') {
    const started = Date.now();
    const result = await mirrorOutreachLeadFields(id, patch, { env, logger });
    const latency = Date.now() - started;
    if (latency > writeDiagnostics.maxMirrorLatencyMs) writeDiagnostics.maxMirrorLatencyMs = latency;
    mirrored = result.mirrored === 1;
    mirrorReason = result.reason;
    if (mirrored) {
      writeDiagnostics.mirrored++;
    } else {
      writeDiagnostics.mirrorFailures++;
      writeDiagnostics.lastMirrorFailureAt = new Date().toISOString();
      writeDiagnostics.lastMirrorFailureReason = mirrorReason;
      // Say plainly what is still true, so this never reads as a lost mutation.
      logger.warn(`[outreach-state] lead ${id}: Sheets write COMMITTED, mirror deferred (${mirrorReason}). `
        + 'Google Sheets remains authoritative; re-run the Stage 3 backfill to reconcile.');
    }
    noteWrite({ at: writeDiagnostics.lastMutationAt, leadId: id, fields, mirrored, reason: mirrorReason, latencyMs: latency });
  } else {
    noteWrite({ at: writeDiagnostics.lastMutationAt, leadId: id, fields, mirrored: false, reason: mirrorReason, latencyMs: 0 });
  }

  // `ok` reports the AUTHORITATIVE outcome, which has already succeeded by the
  // time we are here. `mirrored` is reported separately and is never conflated
  // with it: a deferred mirror is not a failed mutation, and a committed
  // mutation must never be reported as current in Supabase when it is not.
  return { ok: true, leadId: id, fields, mirrored, mirrorReason };
}

/**
 * Apply changes to SEVERAL leads in ONE Sheets batch.
 *
 * Queueing selected leads is a single user action and must stay a single write:
 * looping applyLeadChange() would turn it into N round trips and N chances to
 * half-apply. The mirror is likewise sent as one batch.
 *
 * @param changes [{ leadId, patch, row }]
 */
async function applyLeadChanges(changes, {
  sheetsClient, spreadsheetId, extraData = [],
  sheetName = 'ColdEmail', valueInputOption = 'RAW',
  env = process.env, logger = console,
} = {}) {
  const list = Array.isArray(changes) ? changes : [];
  if (!list.length && !extraData.length) throw new Error('applyLeadChanges requires at least one change');
  if (!sheetsClient || !spreadsheetId) throw new Error('applyLeadChanges requires a Sheets client and spreadsheetId');

  const data = [...extraData];
  for (const change of list) {
    const id = String(change.leadId || '').trim();
    if (!id) throw new Error('applyLeadChanges requires a lead id for every change');
    const parsedRow = Number(change.row);
    if (!Number.isInteger(parsedRow)) throw new Error(`applyLeadChanges requires a resolved sheet row for lead ${id}`);
    const fields = Object.keys(change.patch || {});
    const unknown = fields.filter(field => !Object.prototype.hasOwnProperty.call(FIELD_MAP, field));
    if (unknown.length) throw new Error(`unknown ColdEmail field(s): ${unknown.join(', ')}`);
    for (const field of fields) {
      const value = change.patch[field];
      data.push({
        range: `${sheetName}!${columnLetterFor(field)}${parsedRow}`,
        values: [[value === null || value === undefined ? '' : String(value)]],
      });
    }
  }

  // AUTHORITATIVE WRITE. One batch, one failure mode, throws as before.
  await sheetsClient.spreadsheets.values.batchUpdate({
    spreadsheetId, requestBody: { valueInputOption, data },
  });
  writeDiagnostics.mutations += list.length;
  writeDiagnostics.lastMutationAt = new Date().toISOString();

  let mirrored = 0;
  let reason = 'skipped';
  if (list.length && outreachStateMode(env) !== 'off') {
    const started = Date.now();
    const results = await Promise.all(list.map(change =>
      mirrorOutreachLeadFields(change.leadId, change.patch, { env, logger })));
    const latency = Date.now() - started;
    if (latency > writeDiagnostics.maxMirrorLatencyMs) writeDiagnostics.maxMirrorLatencyMs = latency;
    mirrored = results.filter(r => r.mirrored === 1).length;
    const failed = results.length - mirrored;
    writeDiagnostics.mirrored += mirrored;
    reason = failed ? (results.find(r => r.mirrored !== 1) || {}).reason || 'mirror failed' : 'ok';
    if (failed) {
      writeDiagnostics.mirrorFailures += failed;
      writeDiagnostics.lastMirrorFailureAt = new Date().toISOString();
      writeDiagnostics.lastMirrorFailureReason = reason;
      logger.warn(`[outreach-state] ${failed} of ${list.length} lead(s): Sheets write COMMITTED, mirror deferred (${reason}). `
        + 'Google Sheets remains authoritative; re-run the Stage 3 backfill to reconcile.');
    }
    noteWrite({ at: writeDiagnostics.lastMutationAt, leadId: `${list.length} leads`,
      fields: Object.keys(list[0].patch || {}), mirrored: mirrored === list.length, reason, latencyMs: latency });
  }
  return { ok: true, count: list.length, mirrored, mirrorReason: reason };
}

module.exports = {
  TABLE, FIELD_MAP, SHEET_FIELDS, CRITICAL_FIELDS, NONCRITICAL_FIELDS,
  outreachStateMode, outreachWriteAuthority, sheetsFallbackAllowed,
  readOutreachCorpus, isCompleteLead, missingFields, describeUnmirrorable,
  toOutreachLeadRow, toOutreachLeadPatch, fromOutreachLeadRow,
  mirrorOutreachLeads, mirrorOutreachLeadFields,
  mirrorOutreachLeadsInBackground, mirrorOutreachLeadFieldsInBackground,
  getOutreachLeadById, getOutreachLeadByEmail, batchGetOutreachLeads,
  listOutreachLeads, countOutreachLeads, compareOutreachLead,
  applyLeadChange, applyLeadChanges, columnLetterFor,
  outreachWriteDiagnostics, resetOutreachWriteDiagnostics,
};
