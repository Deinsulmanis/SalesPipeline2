'use strict';

/**
 * Industrial Staffing V4 lead profile: the sealed record of a lead's V4 tag,
 * demand score, review status and SELECTED Email 1 variant.
 *
 * Storage: the lead's existing `campaign_notes` column (both Supabase
 * `outreach_leads` and the ColdEmail sheet carry it), as JSON with schema
 * `staffing_v4_lead_profile_v1` — the same mechanism V2 and managed clients
 * use, so no new column or migration is needed. `copy_variant` is the
 * persisted variant; the original `v4_tag`, `demand_score` and the evidence the
 * variant rests on are kept beside it, unchanged.
 *
 * Stability: the profile is written once, by the V4 import, and every read
 * verifies its SHA-256 digest. No other writer may change it
 * (staffing-campaign.js staffingV4CampaignNotesRefusal), so the variant a
 * sequence started with is the variant every later touch, preview and audit
 * sees. A profile that fails verification reads as integrity_failed and
 * nothing renders: it is never repaired or re-selected silently.
 *
 * `review_status` is REVIEW_READY at import and is never advanced by code here;
 * only SEND_READY may send, and only once V4 itself is live.
 */

const crypto = require('node:crypto');
const { VARIANTS, VARIABLE_NAMES } = require('./staffing-v4-copy');

const SCHEMA = 'staffing_v4_lead_profile_v1';
const SCHEMA_MARKER = `"schema":"${SCHEMA}"`;
const PROFILE_INTEGRITY_FAILED = 'staffing_v4_profile_integrity_failed';
const MAX_CHARS = 20000;
const SELECTOR_VERSION = 'v4_variant_selector_2026_11_20';

const REVIEW_STATUSES = Object.freeze(['REVIEW_READY', 'SEND_READY', 'HOLD']);
const COPY_STATUSES = Object.freeze(['SELECTED', 'HOLD']);

const VAR_FIELDS = Object.freeze(VARIABLE_NAMES.map(name => `var_${name}`));
const FIELD_TYPES = Object.freeze({
  company: 'text', company_domain: 'text', contact_name: 'text', email: 'text',
  v4_tag: 'text', demand_score: 'int', signal_priority: 'text', ad_class: 'text',
  contact_status: 'text', review_status: 'text',
  copy_status: 'text', copy_variant: 'text',
  ...Object.fromEntries(VAR_FIELDS.map(field => [field, 'text'])),
  evidence_kind: 'text', evidence_url: 'text', evidence_quote: 'text', evidence_observed_at: 'text',
  selection_considered: 'list', hold_reasons: 'list',
  selector_version: 'text', selected_at: 'text', sourcing_run_id: 'text',
});
const FIELDS = Object.freeze(Object.keys(FIELD_TYPES));
const DIGESTED = Object.freeze(['schema', ...FIELDS].sort());
const STORED = new Set([...DIGESTED, 'profile_digest']);

const CHECKS = Object.freeze({
  text: value => typeof value === 'string',
  int: value => value === null || Number.isInteger(value),
  list: value => Array.isArray(value) && value.every(item => typeof item === 'string'),
});

function profileDigest(profile) {
  const pairs = DIGESTED.map(key => {
    if (!Object.prototype.hasOwnProperty.call(profile, key) || profile[key] === undefined) {
      throw new Error(`staffing V4 profile is missing ${key}`);
    }
    return [key, profile[key]];
  });
  return crypto.createHash('sha256').update(JSON.stringify(pairs), 'utf8').digest('hex');
}

/**
 * Builds the profile record from a lead's sourcing row and its selection
 * (staffing-v4-copy selectV4Variant). Pure. The review status is always
 * REVIEW_READY: becoming SEND_READY is a separate, explicit owner decision.
 */
function buildStaffingV4Profile({ row = {}, selection, selectedAt, sourcingRunId = '' }) {
  if (!selection || !COPY_STATUSES.includes(selection.status)) throw new Error('V4 profile needs a variant selection');
  const vars = selection.vars || {};
  const evidence = selection.evidence || {};
  const profile = {
    company: String(row.company || ''), company_domain: String(row.company_domain || ''),
    contact_name: String(row.contact_name || ''), email: String(row.email || '').trim().toLowerCase(),
    v4_tag: String(row.v4_tag || ''),
    demand_score: Number.isInteger(Number(row.demand_score)) && String(row.demand_score) !== '' ? Number(row.demand_score) : null,
    signal_priority: String(row.signal_priority || ''), ad_class: String(row.ad_class || ''),
    contact_status: String(row.contact_status || ''),
    review_status: selection.status === 'SELECTED' ? 'REVIEW_READY' : 'HOLD',
    copy_status: selection.status, copy_variant: selection.variant || '',
    ...Object.fromEntries(VARIABLE_NAMES.map(name => [`var_${name}`, typeof vars[name] === 'string' ? vars[name] : ''])),
    evidence_kind: selection.variant || '', evidence_url: String(evidence.url || ''),
    evidence_quote: String(evidence.quote || evidence.text || '').slice(0, 600),
    evidence_observed_at: String(evidence.lastSeen || evidence.observedAt || evidence.announcedAt || evidence.appointedAt || ''),
    selection_considered: (selection.considered || []).map(item => `${item.variant}: ${item.outcome} (${item.detail})`),
    hold_reasons: [...(selection.holds || [])],
    selector_version: SELECTOR_VERSION, selected_at: String(selectedAt || ''), sourcing_run_id: String(sourcingRunId || ''),
  };
  return profile;
}

function serializeStaffingV4Profile(profile) {
  const ordered = { schema: SCHEMA };
  for (const field of FIELDS) ordered[field] = profile[field];
  ordered.profile_digest = profileDigest(ordered);
  const json = JSON.stringify(ordered);
  if (json.length > MAX_CHARS) throw new Error(`staffing V4 profile is ${json.length} characters; the limit is ${MAX_CHARS}`);
  return json;
}

const notesOf = lead => String(lead?.campaign_notes ?? lead?.campaignNotes ?? '');

function hasStaffingV4ProfileMarker(lead = {}) {
  return notesOf(lead).includes(SCHEMA_MARKER);
}

/** The lead's verified V4 profile, or why it is unusable. Never throws, never repairs. */
function readStaffingV4Profile(lead = {}) {
  const notes = notesOf(lead).trim();
  if (!notes.includes(SCHEMA_MARKER)) return { ok: false, reason: 'no staffing V4 profile' };
  const failed = detail => ({ ok: false, reason: PROFILE_INTEGRITY_FAILED, detail });
  if (notes.length > MAX_CHARS) return failed('profile is oversized');
  let parsed;
  try { parsed = JSON.parse(notes); } catch (_) { return failed('profile is not valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.schema !== SCHEMA) return failed('profile has the wrong schema');
  const unexpected = Object.keys(parsed).filter(key => !STORED.has(key));
  if (unexpected.length) return failed(`unexpected field(s): ${unexpected.slice(0, 5).join(', ')}`);
  const missing = DIGESTED.filter(key => !Object.prototype.hasOwnProperty.call(parsed, key));
  if (missing.length) return failed(`missing field(s): ${missing.slice(0, 5).join(', ')}`);
  const mistyped = FIELDS.filter(field => !CHECKS[FIELD_TYPES[field]](parsed[field]));
  if (mistyped.length) return failed(`wrongly typed field(s): ${mistyped.slice(0, 5).join(', ')}`);
  if (!/^[0-9a-f]{64}$/.test(String(parsed.profile_digest || '')) || profileDigest(parsed) !== parsed.profile_digest) {
    return failed('profile digest does not match its contents');
  }
  if (!REVIEW_STATUSES.includes(parsed.review_status) || !COPY_STATUSES.includes(parsed.copy_status)) return failed('profile has an unknown status');
  if (parsed.copy_status === 'SELECTED' && !VARIANTS.includes(parsed.copy_variant)) return failed('profile has an unknown copy variant');
  if (parsed.copy_status === 'HOLD' && parsed.review_status === 'SEND_READY') return failed('a held profile cannot be send ready');
  const vars = Object.fromEntries(VARIABLE_NAMES.map(name => [name, parsed[`var_${name}`]]).filter(([, value]) => value));
  return { ok: true, profile: parsed, vars };
}

module.exports = {
  SCHEMA, SCHEMA_MARKER, PROFILE_INTEGRITY_FAILED, SELECTOR_VERSION, REVIEW_STATUSES, COPY_STATUSES, FIELDS,
  profileDigest, buildStaffingV4Profile, serializeStaffingV4Profile, hasStaffingV4ProfileMarker, readStaffingV4Profile,
};
