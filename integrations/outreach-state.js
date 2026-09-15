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

/**
 * May the agent re-state the WHOLE corpus to Supabase from its cycle snapshot?
 *
 * Only in dual mode with Sheets authoritative. There the snapshot was read from
 * Sheets, which is the truth, so re-stating it each cycle is the self-healing
 * mirror Stages 3B–3D relied on.
 *
 * Anywhere else it is a lost update. In primary mode the snapshot is read from
 * Supabase at the START of the cycle and upserted afterwards, over whatever sends,
 * replies and human actions committed in between — a MANUAL HOLD applied mid-cycle
 * is written straight back out. It also leaves `revision` untouched, so
 * compare-and-set cannot see that it happened. With Supabase authoritative, a
 * Sheets snapshot is a lagging copy and must never overwrite the canonical row.
 */
function snapshotMirrorAllowed(env = process.env) {
  return outreachStateMode(env) === 'dual' && outreachWriteAuthority(env) === 'sheets';
}

/**
 * The agent's once-per-cycle whole-corpus mirror, behind snapshotMirrorAllowed().
 * Fire-and-forget, like the wrapper it calls. Reports whether it started, so the
 * gate is observable rather than assumed.
 */
function mirrorCycleSnapshotInBackground(leads, options = {}) {
  const env = options.env || process.env;
  if (!snapshotMirrorAllowed(env)) {
    return { started: false, reason: `mode=${outreachStateMode(env)} writes=${outreachWriteAuthority(env)}` };
  }
  mirrorOutreachLeadsInBackground(leads, options);
  return { started: true, reason: 'dual mode with Sheets authoritative' };
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

// A top-level PostgREST filter takes EVERYTHING after `eq.` as the literal value;
// it does not unquote. Wrapping the value in double quotes asked for a lead_id
// that literally begins and ends with a quote character, matched no row, and made
// every canonical read report "lead not found in Supabase" — so no canonical
// write could land. Quoting was not an escape either: `&` still split the value
// into a second query parameter.
//
// Percent-encoding is the whole escape. `&`, `#` and `%` cannot end the value,
// `+` is not decoded as a space, and PostgREST receives the exact literal.
const eqFilter = value => `eq.${encodeURIComponent(String(value))}`;

// Inside an in.(...) list, and only there, PostgREST DOES parse double quotes:
// they delimit an element that contains a comma or a parenthesis.
const quote = value => `"${String(value).split('"').join('')}"`;

async function getOutreachLeadById(id, options = {}) {
  if (!String(id || '').trim()) return { ok: false, lead: null, reason: 'no lead id supplied' };
  const result = await selectLeads(`select=*&lead_id=${eqFilter(id)}&limit=1`, options);
  return { ...result, lead: result.ok ? (result.leads[0] || null) : null };
}

async function getOutreachLeadByEmail(email, options = {}) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return { ok: false, lead: null, reason: 'no email supplied' };
  const result = await selectLeads(`select=*&email_normalized=${eqFilter(normalized)}&limit=1`, options);
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
  casConflicts: 0, conflictRetries: 0, conflictRefusals: 0, safetyMarkersKept: 0,
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
    casConflicts: 0, conflictRetries: 0, conflictRefusals: 0, safetyMarkersKept: 0,
    lastMutationAt: null, lastMirrorFailureAt: null, lastMirrorFailureReason: null,
    maxMirrorLatencyMs: 0, recent: [],
  });
}

// ── Stage 3F: compare-and-set, and who wins a conflict ──────────────────────
//
// Once Supabase is canonical, two workers can touch one lead at the same instant.
// ColdEmail never had protection against that — writes were last-writer-wins on a
// cell range, made safe only by the accident that a single cron process wrote
// narrow ranges. Row-level upserts remove that accident, so the protection has to
// arrive with the authority.
//
// The mechanism is optimistic concurrency on `revision`:
//
//   read revision N
//   PATCH ... WHERE lead_id = X AND revision = N   SET <patch>, revision = N+1
//   zero rows affected  ->  somebody else wrote first
//
// Zero rows is NOT a failure to retry blindly. It means the row moved under us,
// and whether our intent is still valid depends on what it moved to. A retry that
// simply re-applied the patch would be last-write-wins with extra steps — and
// would, for example, let a queued follow-up overwrite a MANUAL HOLD that a human
// applied one second earlier.
//
// So a conflict reloads the canonical row and asks a precedence question. The
// rules below are not new policy; they are the existing business rules about who
// owns a lead, applied at the moment two writers disagree:
//
//   human and terminal state outrank automation
//   a reply outranks send progression
//   suppression and unsubscribe outrank everything

const TERMINAL_STAGES = Object.freeze(['unsubscribed', 'unsub']);
const SENDING_STATUSES = Object.freeze(['queued', 'emailed', 'sent']);
const MANUAL_HOLD_MARKER = '[MANUAL HOLD]';
const MAX_CAS_ATTEMPTS = 3;

/**
 * Would applying `patch` to the reloaded `current` row overwrite state that
 * outranks it? Returns a refusal reason, or null when the retry is safe.
 *
 * Deliberately conservative: it answers "is this still safe", not "is this still
 * useful". A refused mutation is reported to the caller, never silently dropped.
 */
function conflictRefusal(current, patch) {
  const stage = String(current.stage || '').toLowerCase();
  const status = String(current.emailStatus || '').toLowerCase();
  const notes = String(current.notes || '');

  const wantsStage = Object.prototype.hasOwnProperty.call(patch, 'stage');
  const wantsStatus = Object.prototype.hasOwnProperty.call(patch, 'emailStatus');
  const nextStage = String(patch.stage || '').toLowerCase();
  const nextStatus = String(patch.emailStatus || '').toLowerCase();

  // A human took the lead while we were working. Automation may still annotate
  // notes, but it may not move the lead's stage or sending status underneath them.
  if (notes.includes(MANUAL_HOLD_MARKER) && (wantsStage || wantsStatus)
    && !String(patch.notes || '').includes(MANUAL_HOLD_MARKER)) {
    return 'lead is under MANUAL HOLD; human ownership outranks automation';
  }

  // Terminal means terminal. Nothing may walk a lead back out of unsubscribed.
  if (TERMINAL_STAGES.includes(stage) && wantsStage && !TERMINAL_STAGES.includes(nextStage)) {
    return `lead is terminal (${current.stage}); automation may not reopen it`;
  }

  // A reply landed while a send was being prepared. The reply owns the lead now,
  // so a send-progression status must not overwrite it.
  if (status === 'replied' && wantsStatus && SENDING_STATUSES.includes(nextStatus)) {
    return 'a reply arrived first; send progression may not overwrite replied state';
  }

  return null;
}

// ── safety markers in notes ─────────────────────────────────────────────────
//
// Notes are written whole. A writer that read a lead and built its notes from
// that copy erases any marker that landed after its read: a MANUAL HOLD a human
// applied, an unsubscribe, a bounce. Compare-and-set does not catch it when the
// writer's own canonical read already sees the marker — the revision is current,
// only the VALUE is stale — and the conflict rules above refuse stage and status
// changes under a hold, not a notes-only write.
//
// So on EVERY attempt a notes patch is checked against the canonical notes it
// replaces, and a safety marker present there is kept. The mutation still lands:
// refusing it would drop a reply or a bounce record on the floor. It just cannot
// lift the suppression.
//
// The markers are pipeline-state's SEND_SUPPRESSION_TAGS, asserted equal by the
// tests; this module takes no dependency on it. '[BOUNCED' is a prefix there, so
// '[BOUNCED]' and '[BOUNCED: Smartlead]' are both kept verbatim.
//
// Only a hold is a pause a human chose. Resume removes it by passing
// releaseMarkers: ['[MANUAL HOLD]']; opt-out and bounce cannot be released here.
const SAFETY_NOTE_MARKERS = Object.freeze(['[REPLY: Unsubscribed]', '[BOUNCED', MANUAL_HOLD_MARKER]);
const RELEASABLE_NOTE_MARKERS = Object.freeze([MANUAL_HOLD_MARKER]);

/** The marker exactly as it appears in `notes`, or null. Detection ignores case. */
function markerIn(notes, marker) {
  const haystack = String(notes || '');
  const at = haystack.toLowerCase().indexOf(marker.toLowerCase());
  if (at === -1) return null;
  if (marker.endsWith(']')) return haystack.slice(at, at + marker.length);
  const close = haystack.indexOf(']', at);
  return close === -1 ? haystack.slice(at) : haystack.slice(at, close + 1);
}

/**
 * The notes to write so that no safety marker in the canonical notes is lost.
 * PURE. `kept` lists the markers put back into the value.
 *
 * A marker counts as carried when the next value holds it verbatim or in the
 * exact form the send-time check looks for — never a case variant that check
 * would not recognise.
 */
function preserveSafetyMarkers(canonicalNotes, nextNotes, { releaseMarkers = [] } = {}) {
  const next = nextNotes === null || nextNotes === undefined ? '' : String(nextNotes);
  const kept = [];
  for (const marker of SAFETY_NOTE_MARKERS) {
    const present = markerIn(canonicalNotes, marker);
    if (!present || next.includes(marker) || next.includes(present)) continue;
    if (RELEASABLE_NOTE_MARKERS.includes(marker) && releaseMarkers.includes(marker)) continue;
    kept.push(present);
  }
  return { notes: kept.length ? [...kept, next].filter(Boolean).join(' ') : next, kept };
}

const headersForWrite = (config, extra = {}) => ({
  apikey: config.key, Authorization: `Bearer ${config.key}`,
  'Content-Type': 'application/json', ...extra,
});

/** Read the canonical row plus its revision. */
async function readCanonicalLead(id, { env = process.env } = {}) {
  const config = mirrorConfig(env);
  if (!config.enabled) return { ok: false, reason: config.reason };
  try {
    const response = await request(
      `${config.url}/rest/v1/${TABLE}?select=*&lead_id=${eqFilter(id)}&limit=1`,
      { headers: headersForWrite(config) });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    const rows = await response.json();
    if (!rows.length) return { ok: false, reason: 'lead not found in Supabase' };
    return { ok: true, lead: fromOutreachLeadRow(rows[0]), revision: Number(rows[0].revision) };
  } catch (error) {
    return { ok: false, reason: (error && error.message) || 'unreachable' };
  }
}

/**
 * One compare-and-set attempt. Returns {applied, rows} or a reason.
 * Atomic by construction: every field in the patch and the revision bump land in
 * a single UPDATE, so no other worker can observe a half-applied transition.
 */
async function casAttempt(id, patch, revision, { env = process.env }) {
  const config = mirrorConfig(env);
  const body = { ...patch, revision: revision + 1, updated_at: new Date().toISOString() };
  try {
    const response = await request(
      `${config.url}/rest/v1/${TABLE}?lead_id=${eqFilter(id)}&revision=eq.${revision}`,
      {
        method: 'PATCH',
        headers: headersForWrite(config, { Prefer: 'return=representation' }),
        body: JSON.stringify(body),
      });
    if (!response.ok) return { applied: false, reason: `HTTP ${response.status}` };
    const rows = await response.json();
    // Zero rows means the WHERE clause did not match: the revision moved.
    return { applied: rows.length > 0, rows };
  } catch (error) {
    return { applied: false, reason: (error && error.message) || 'unreachable' };
  }
}

/**
 * Apply a patch to the canonical Supabase row under optimistic concurrency.
 *
 * NEVER last-write-wins. On conflict it reloads, re-evaluates against the
 * precedence rules above, and only retries when the intent is still safe.
 */
async function applyCanonicalChange(id, patch, { env = process.env, logger = console, expectedState = null, releaseMarkers = [] } = {}) {
  const column = {};
  for (const [field, value] of Object.entries(patch)) {
    column[FIELD_MAP[field]] = value === null || value === undefined ? '' : String(value);
    if (field === 'lastEmailedAt') column.last_emailed_at_ts = isoOrNull(value);
    if (field === 'emailStep') column.email_step_int = intOrNull(value);
  }

  let conflicts = 0;
  for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt++) {
    const current = await readCanonicalLead(id, { env });
    if (!current.ok) return { ok: false, conflicts, reason: current.reason };

    // Queue/enrollment validates a snapshot before requesting a transition.
    // Refuse if ANY validated field moved, including before the first CAS read.
    if (expectedState && SHEET_FIELDS.some(field => Object.hasOwn(expectedState, field)
      && String(current.lead[field] ?? '') !== String(expectedState[field] ?? ''))) {
      return { ok: false, refused: true, conflicts, reason: 'validated lead state changed; refresh and review before queueing' };
    }

    if (attempt > 1) {
      // Re-evaluate against what actually landed, not against what we assumed.
      const refusal = conflictRefusal(current.lead, patch);
      if (refusal) {
        writeDiagnostics.conflictRefusals++;
        logger.warn(`[outreach-state] lead ${id}: mutation REFUSED after conflict — ${refusal}. `
          + 'No write was made; the newer state stands.');
        return { ok: false, refused: true, conflicts, reason: refusal };
      }
    }

    // Every attempt, not only retries: a notes value built from an older read
    // must not lift a suppression that is in canonical state now.
    const safe = Object.prototype.hasOwnProperty.call(patch, 'notes')
      ? preserveSafetyMarkers(current.lead.notes, patch.notes, { releaseMarkers })
      : { notes: null, kept: [] };
    const attemptColumns = safe.kept.length ? { ...column, notes: safe.notes } : column;

    const result = await casAttempt(id, attemptColumns, current.revision, { env });
    if (result.applied) {
      if (conflicts) writeDiagnostics.conflictRetries += conflicts;
      if (safe.kept.length) {
        writeDiagnostics.safetyMarkersKept += safe.kept.length;
        // Marker names only: notes carry prospect detail and are never logged.
        logger.warn(`[outreach-state] lead ${id}: a notes write would have removed ${safe.kept.join(', ')}; `
          + 'kept it. Safety state in canonical notes outranks a value built from an older read.');
      }
      return { ok: true, conflicts, revision: current.revision + 1,
        keptMarkers: safe.kept, notes: safe.kept.length ? safe.notes : undefined };
    }
    if (result.reason) return { ok: false, conflicts, reason: result.reason };
    conflicts++;
    writeDiagnostics.casConflicts++;
  }
  return { ok: false, conflicts, reason: `lost ${MAX_CAS_ATTEMPTS} compare-and-set races` };
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
  expectedState = null,
  releaseMarkers = [],
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

  // ── Stage 3F: Supabase canonical ──────────────────────────────────────────
  // The authority flip lives here and nowhere else. No call site changes.
  if (outreachWriteAuthority(env) === 'supabase') {
    const canonical = await applyCanonicalChange(id, patch, { env, logger, expectedState, releaseMarkers });
    if (!canonical.ok) {
      // A refusal is a CORRECT outcome, not a transport failure: the lead moved
      // to state that outranks this mutation. Either way the caller asked for a
      // change that did not happen, so it must not continue as if it had —
      // failing closed is the documented preference on these paths.
      const error = new Error(canonical.refused
        ? `outreach mutation refused for ${id}: ${canonical.reason}`
        : `canonical outreach write failed for ${id}: ${canonical.reason}`);
      error.refused = Boolean(canonical.refused);
      error.conflicts = canonical.conflicts;
      throw error;
    }
    writeDiagnostics.mutations++;
    writeDiagnostics.lastMutationAt = new Date().toISOString();

    // Sheets is now the SECONDARY mirror. Its failure must not roll back a
    // committed canonical write, must not restore Sheets authority, and must not
    // affect send eligibility — it is recorded, and repaired by reconciliation.
    // Sheets mirrors what COMMITTED. A safety marker kept above must reach the
    // secondary copy too, or Sheets would show a held lead as unheld.
    const notesRange = `${sheetName}!${columnLetterFor('notes')}${parsedRow}`;
    const mirrorData = canonical.keptMarkers && canonical.keptMarkers.length
      ? data.map(entry => (entry.range === notesRange ? { ...entry, values: [[canonical.notes]] } : entry))
      : data;
    let sheetsMirrored = false;
    let sheetsReason = 'ok';
    try {
      await sheetsClient.spreadsheets.values.batchUpdate({
        spreadsheetId, requestBody: { valueInputOption, data: mirrorData },
      });
      sheetsMirrored = true;
      writeDiagnostics.mirrored++;
    } catch (error) {
      sheetsReason = (error && error.message) || 'sheets mirror failed';
      writeDiagnostics.mirrorFailures++;
      writeDiagnostics.lastMirrorFailureAt = new Date().toISOString();
      writeDiagnostics.lastMirrorFailureReason = sheetsReason;
      logger.warn(`[outreach-state] lead ${id}: Supabase write COMMITTED, Sheets mirror deferred `
        + `(${sheetsReason}). Supabase remains authoritative; run the Stage 3 reconciliation to repair Sheets.`);
    }
    noteWrite({ at: writeDiagnostics.lastMutationAt, leadId: id, fields,
      mirrored: sheetsMirrored, reason: sheetsReason, latencyMs: 0,
      authority: 'supabase', conflicts: canonical.conflicts, revision: canonical.revision });
    return { ok: true, leadId: id, fields, mirrored: sheetsMirrored, mirrorReason: sheetsReason,
      authority: 'supabase', conflicts: canonical.conflicts, revision: canonical.revision,
      keptMarkers: canonical.keptMarkers || [] };
  }

  // ── Sheets canonical (Stage 3B–3E) ────────────────────────────────────────
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
  snapshotMirrorAllowed, mirrorCycleSnapshotInBackground,
  getOutreachLeadById, getOutreachLeadByEmail, batchGetOutreachLeads,
  listOutreachLeads, countOutreachLeads, compareOutreachLead,
  applyLeadChange, applyLeadChanges, columnLetterFor,
  applyCanonicalChange, conflictRefusal, readCanonicalLead, MAX_CAS_ATTEMPTS,
  preserveSafetyMarkers, SAFETY_NOTE_MARKERS,
  outreachWriteDiagnostics, resetOutreachWriteDiagnostics,
};
