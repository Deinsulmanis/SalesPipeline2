'use strict';

/**
 * Industrial Staffing V2 lead profile: the structured sourcing record a V2 lead
 * carries from import onward.
 *
 * Storage: the lead's existing `campaign_notes` column holds the profile as JSON
 * (schema `staffing_v2_lead_profile_v1`). That column already exists in BOTH
 * stores — the ColdEmail sheet (column R) and Supabase `outreach_leads` — and
 * every full-row write and mirror carries it, so the two stores never disagree
 * about whether the profile exists. This is the same mechanism managed clients
 * use (clients/lead-profile.js); no new column or migration is needed.
 *
 * The first-class lead columns stay what they always were (company, email,
 * contactName, campaign, template, version, …). Everything the experiment needs
 * — buyer cohort and randomization, ICP lane and band, scores, gate statuses,
 * provenance, Apollo IDs, and Touch 1's roles + market — lives in the profile,
 * typed, under the sourcing system's own snake_case names, and is recoverable
 * in SQL with `campaign_notes::jsonb ->> '<field>'`.
 *
 * Integrity: the import seals each profile with `profile_digest`, a SHA-256 of
 * its canonical form (see profileDigest). Every read verifies it, so the
 * renderer, queue validation and send selection all see either the profile the
 * import wrote or nothing. A profile that is oversized, is not valid JSON, has
 * the wrong schema, an unexpected or missing field, a wrongly typed value, or a
 * digest that does not match reads as `staffing_v2_profile_integrity_failed`.
 * It is never repaired or reconstructed: V2 Touch 1 refuses to render and the
 * lead is held.
 */

const crypto = require('node:crypto');

const SCHEMA = 'staffing_v2_lead_profile_v1';
// The largest profile the import stores, and the largest a read accepts. A full
// V2_READY record serializes to about 2,600 characters, so 30,000 leaves ten
// times that for long evidence and source text. It stays well under the 50,000
// characters Sheets allows in one cell, and refusing beyond it keeps a runaway
// field from filling a cell the dashboard and the mirror read on every pass.
// Oversized records are refused, never truncated.
const MAX_STAFFING_V2_PROFILE_CHARS = 30000;
const PROFILE_INTEGRITY_FAILED = 'staffing_v2_profile_integrity_failed';
// Present in every serialized profile (it is written first), so even a profile
// that has since been corrupted still identifies its lead as V2.
const SCHEMA_MARKER = `"schema":"${SCHEMA}"`;

const ENUMS = Object.freeze({
  icp_lane: Object.freeze(['TIER_A_STAFFING', 'TIER_B_RECRUITING']),
  icp_priority_band: Object.freeze(['PRIORITY_A', 'PRIORITY_B', 'REVIEW', 'REJECT']),
  buyer_cohort: Object.freeze(['P1A_OWNER_EXEC', 'P1B_REVENUE', 'P2_COMMERCIAL', 'P3_BRANCH_COMMERCIAL',
    'P4_OPERATIONS_COMMERCIAL', 'NOT_A_BUYER']),
  buyer_priority: Object.freeze(['P1', 'P2', 'P3', 'P4', 'NONE']),
  buyer_family: Object.freeze(['OWNER_EXEC', 'REVENUE', 'COMMERCIAL', 'BRANCH', 'OPERATIONS',
    'RECRUITING_DELIVERY', 'INTERNAL_SUPPORT', 'OTHER']),
  buyer_assignment_method: Object.freeze(['RANDOMIZED_P1A', 'RANDOMIZED_P1B', 'FALLBACK_P1A', 'FALLBACK_P1B',
    'ONLY_P1A', 'ONLY_P1B', 'P2_FALLBACK', 'P3_REVIEW', 'P4_REVIEW', 'NO_VALID_BUYER']),
  staffing_model: Object.freeze(['TEMP_CONTRACT_CORE', 'MIXED_WITH_INDUSTRIAL_LINE', 'RECRUITING_DIRECT_HIRE',
    'WEAK_ADJACENT', 'UNKNOWN']),
  vertical: Object.freeze(['SKILLED_TRADE_INDUSTRIAL', 'WAREHOUSE_LOGISTICS_LIGHT_INDUSTRIAL', 'BROADER_TECHNICAL',
    'NOT_APPROVED']),
  vertical_sublane: Object.freeze(['TRADES_CONSTRUCTION_PROJECT', 'MANUFACTURING_MACHINING_MAINTENANCE',
    'WAREHOUSE_LOGISTICS_LIGHT_INDUSTRIAL', 'OTHER_INDUSTRIAL']),
  specialty_tags: Object.freeze(['OIL_GAS', 'MARINE_SHIPYARD', 'SHUTDOWN_TURNAROUND']),
  company_fit_status: Object.freeze(['ICP_CONFIRMED', 'ICP_REVIEW', 'ICP_REJECT']),
  copy_readiness_status: Object.freeze(['ROLE_MARKET_VERIFIED', 'ROLE_MARKET_INCOMPLETE', 'ROLE_MARKET_FAILED']),
  buyer_status: Object.freeze(['BUYER_CONFIRMED', 'BUYER_REVIEW', 'BUYER_REJECT']),
  email_readiness_status: Object.freeze(['EMAIL_READY', 'EMAIL_CATCH_ALL', 'EMAIL_HOLD', 'EMAIL_REJECT']),
  v2_status: Object.freeze(['V2_READY', 'V2_REVIEW', 'V2_REJECT']),
  gate_status: Object.freeze(['PASS', 'FAIL', 'PENDING', 'NOT_REVEALED']),
  catch_all_status: Object.freeze(['Y', 'N', 'UNKNOWN']),
  reveal_result: Object.freeze(['MATCHED_EMAIL', 'MATCHED_NO_EMAIL', 'UNMATCHED', 'ERROR', 'NOT_ATTEMPTED']),
});

// The sourcing record's fields (the V2 skill's reference.md §1 data model plus
// the Apollo execution spec's experiment fields, and the derived contact_name).
// Typed: `list` fields are arrays (pipe-separated text is accepted), `int`
// fields integers, everything else trimmed text.
const FIELD_TYPES = Object.freeze({
  // identity
  company: 'text', company_domain: 'text', first_name: 'text', last_name: 'text', contact_name: 'text',
  email: 'text', job_title: 'text', apollo_person_id: 'text', apollo_organization_id: 'text',
  city: 'text', state: 'text', country: 'text', employee_count: 'int',
  // campaign
  campaign_id: 'text', template_id: 'text',
  // buyer
  buyer_cohort: 'text', buyer_priority: 'text', buyer_family: 'text', buyer_evidence: 'text',
  alternate_buyers: 'list', buyer_assignment_method: 'text', buyer_randomization_bucket: 'text',
  // ICP
  icp_lane: 'text', icp_priority_band: 'text', staffing_model: 'text', vertical: 'text',
  vertical_sublane: 'text', specialty_tags: 'list',
  // personalization
  roles: 'list', market: 'text', roles_evidence: 'text', market_evidence: 'text',
  role_market_evidence_source: 'text',
  // scoring
  staffing_model_score: 'int', vertical_score: 'int', buyer_score: 'int', evidence_score: 'int',
  economics_score: 'int', company_profile_score: 'int', email_quality_score: 'int',
  pre_reveal_subtotal: 'int', total_icp_score: 'int',
  // status / quality
  company_fit_status: 'text', copy_readiness_status: 'text', buyer_status: 'text',
  email_readiness_status: 'text', v2_status: 'text', hard_gate_status: 'text',
  pre_reveal_gate_status: 'text', post_reveal_gate_status: 'text', hard_gate_failures: 'list',
  qualification_reason: 'text', review_flags: 'list', email_status: 'text', catch_all_status: 'text',
  // provenance
  sourcing_run_id: 'text', source_batch: 'text', search_stream: 'list', source_query: 'text',
  source: 'text', source_url_or_reference: 'text', source_checked_at: 'text',
  reveal_attempted: 'text', reveal_attempted_at: 'text', reveal_result: 'text', reveal_credit_cost: 'int',
  // duplicate / compliance
  duplicate_status: 'text', suppression_status: 'text',
});
const FIELDS = Object.freeze(Object.keys(FIELD_TYPES));

const text = value => (value === null || value === undefined ? '' : String(value).trim());

function toList(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  const raw = text(value);
  return raw ? raw.split('|').map(part => part.trim()).filter(Boolean) : [];
}

/** An integer, null for blank, or NaN for anything that is not a whole number. */
function toInt(value) {
  if (value === null || value === undefined || text(value) === '') return null;
  const raw = text(value);
  return /^-?\d+$/.test(raw) ? Number(raw) : NaN;
}

/** The record's fields, typed. Unknown keys are reported, never silently kept or dropped. */
function normalizeRecord(record = {}) {
  const profile = {};
  for (const field of FIELDS) {
    const type = FIELD_TYPES[field];
    const value = record[field];
    profile[field] = type === 'list' ? toList(value) : type === 'int' ? toInt(value) : text(value);
  }
  const unknown = Object.keys(record).filter(key => !Object.prototype.hasOwnProperty.call(FIELD_TYPES, key));
  return { profile, unknown };
}

// What the digest covers: everything that defines the lead's V2 sourcing and
// import state — the schema, the import identity and every sourcing field.
// Left out: the digest itself and imported_at, the import clock, so a record's
// digest depends only on the record and can be recomputed from the run artifact.
const IMPORT_META = Object.freeze(['import_schema', 'import_key', 'imported_at']);
const DIGESTED_KEYS = Object.freeze(['schema', 'import_schema', 'import_key', ...FIELDS].sort());
const STORED_KEYS = new Set([...DIGESTED_KEYS, 'imported_at', 'profile_digest']);
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/**
 * SHA-256 (hex) of the profile's canonical form: a JSON array of [key, value]
 * pairs for exactly DIGESTED_KEYS, in code-point key order. Values are what the
 * profile holds — trimmed text, integers or null, arrays of text — so
 * JSON.stringify writes each one in exactly one way. A covered key that is
 * missing throws rather than digesting as null.
 */
function profileDigest(profile = {}) {
  const pairs = DIGESTED_KEYS.map(key => {
    if (!Object.prototype.hasOwnProperty.call(profile, key) || profile[key] === undefined) {
      throw new Error(`staffing V2 profile is missing ${key}`);
    }
    return [key, profile[key]];
  });
  return crypto.createHash('sha256').update(JSON.stringify(pairs), 'utf8').digest('hex');
}

/** The serialized profile, schema first, digest last. Throws when it cannot be stored whole. */
function serializeStaffingV2Profile(profile, meta = {}) {
  const extra = Object.keys(meta).filter(key => !IMPORT_META.includes(key));
  if (extra.length) throw new Error(`unknown staffing V2 profile metadata: ${extra.join(', ')}`);
  const ordered = { schema: SCHEMA, ...meta };
  for (const field of FIELDS) ordered[field] = profile[field];
  ordered.profile_digest = profileDigest(ordered);
  const json = JSON.stringify(ordered);
  if (!json.startsWith(`{${SCHEMA_MARKER}`)) throw new Error('staffing V2 profile must begin with its schema');
  if (json.length > MAX_STAFFING_V2_PROFILE_CHARS) {
    throw Object.assign(new Error(`staffing V2 profile is ${json.length} characters; the limit is ${MAX_STAFFING_V2_PROFILE_CHARS}`), { code: 'profile_too_large' });
  }
  return json;
}

const isText = value => typeof value === 'string';
const TYPE_CHECKS = Object.freeze({
  text: isText,
  list: value => Array.isArray(value) && value.every(isText),
  int: value => value === null || Number.isInteger(value),
});

const notesOf = lead => String(lead?.campaign_notes ?? lead?.campaignNotes ?? '');

/** Does this lead carry a V2 profile, readable or not? Marks it V2 for routing. */
function hasStaffingV2ProfileMarker(lead = {}) {
  return notesOf(lead).includes(SCHEMA_MARKER);
}

/**
 * The lead's V2 profile, verified against its digest, or why it is unusable.
 * Never throws, never repairs: anything but the exact profile the import sealed
 * is `staffing_v2_profile_integrity_failed`, with a `detail` for operators.
 */
function readStaffingV2Profile(lead = {}) {
  const notes = notesOf(lead).trim();
  if (!notes.includes(SCHEMA_MARKER)) return { ok: false, reason: 'no staffing V2 profile' };
  const failed = detail => ({ ok: false, reason: PROFILE_INTEGRITY_FAILED, detail });
  if (notes.length > MAX_STAFFING_V2_PROFILE_CHARS) return failed(`profile exceeds ${MAX_STAFFING_V2_PROFILE_CHARS} characters`);
  let parsed;
  try { parsed = JSON.parse(notes); } catch (_) { return failed('profile is not valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.schema !== SCHEMA) {
    return failed('profile has the wrong schema');
  }
  const unexpected = Object.keys(parsed).filter(key => !STORED_KEYS.has(key));
  if (unexpected.length) return failed(`profile has unexpected field(s): ${unexpected.slice(0, 5).join(', ')}`);
  const missing = DIGESTED_KEYS.filter(key => !Object.prototype.hasOwnProperty.call(parsed, key));
  if (missing.length) return failed(`profile is missing field(s): ${missing.slice(0, 5).join(', ')}`);
  if (!isText(parsed.profile_digest) || !DIGEST_PATTERN.test(parsed.profile_digest)) return failed('profile has no digest');
  if (profileDigest(parsed) !== parsed.profile_digest) return failed('profile digest does not match its contents');
  const mistyped = FIELDS.filter(field => !TYPE_CHECKS[FIELD_TYPES[field]](parsed[field]));
  if (mistyped.length || ['import_schema', 'import_key'].some(key => !isText(parsed[key]))) {
    return failed(`profile has wrongly typed field(s): ${mistyped.slice(0, 5).join(', ') || 'import identity'}`);
  }
  const roles = Array.isArray(parsed.roles) ? parsed.roles.map(text).filter(Boolean) : [];
  const market = text(parsed.market);
  if (!roles.length) return { ok: false, reason: 'staffing V2 profile has no roles' };
  if (!market) return { ok: false, reason: 'staffing V2 profile has no market' };
  return { ok: true, profile: { ...parsed, roles, market } };
}

/**
 * Touch 1's {{roles}}: one to three stored roles in their stored order,
 * "welders", "welders and pipefitters", "welders, pipefitters and electricians".
 */
function staffingV2RolesText(roles = []) {
  const list = roles.map(text).filter(Boolean);
  if (list.length <= 1) return list[0] || '';
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

module.exports = {
  SCHEMA, SCHEMA_MARKER, MAX_STAFFING_V2_PROFILE_CHARS, PROFILE_INTEGRITY_FAILED,
  DIGESTED_KEYS, ENUMS, FIELD_TYPES, FIELDS,
  normalizeRecord, profileDigest, serializeStaffingV2Profile, hasStaffingV2ProfileMarker, readStaffingV2Profile,
  staffingV2RolesText, toList, toInt,
};
