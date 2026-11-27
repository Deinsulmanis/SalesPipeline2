'use strict';

/**
 * Campaign 4 "HOLD Company Test" lead profile: the sealed record of a HOLD-test
 * lead, stored in `campaign_notes` (as Campaign 3 does) with its own schema
 * `hold_company_test_profile_v1`.
 *
 * Its own schema, not Campaign 3's, so a Campaign 4 lead can never be read,
 * rendered, attributed or counted as Campaign 3 (and the reverse): every
 * Campaign 3 check looks for `staffing_v4_lead_profile_v1`, every Campaign 4
 * check for this marker.
 *
 * It carries Campaign 3's selection record: the SELECTED Email 1 variant (chosen
 * server side by staffing-v4-copy.js selectV4Variant, copy v2), its validated
 * variables and the evidence it rests on. A lead whose evidence supports no
 * variant is never written (the import refuses it), so nothing is held here.
 *
 * Written once, by the Campaign 4 import; every read verifies the SHA-256
 * digest. No other writer may change it (staffing-campaign.js
 * campaign4CampaignNotesRefusal). `var_first_name`, `var_company`,
 * `company_domain` and `hq_state` are the names the reply alert and the
 * sample-list flow already read from campaign_notes.
 */

const crypto = require('node:crypto');
// Campaign 4 sends Campaign 3's copy v2 exactly (owner decision 2026-11-27):
// the same six Email 1 variants, chosen by the same selector, and the same
// Emails 2 and 3. Only copy v2 exists for Campaign 4; there is no franchise form.
const { VARIANTS, V1_VARIABLE_NAMES, V2_VARIABLE_NAMES } = require('./staffing-v4-copy');
const C4_COPY_VERSIONS = Object.freeze(['v2']);
const C4_VARIABLE_NAMES = Object.freeze([...V1_VARIABLE_NAMES, ...V2_VARIABLE_NAMES]);
const COPY_STATUSES = Object.freeze(['SELECTED']);

const C4_SCHEMA = 'hold_company_test_profile_v1';
const C4_SCHEMA_MARKER = `"schema":"${C4_SCHEMA}"`;
const C4_PROFILE_INTEGRITY_FAILED = 'campaign_4_profile_integrity_failed';
const MAX_CHARS = 20000;
const REVIEW_STATUSES = Object.freeze(['REVIEW_READY', 'SEND_READY']);

const FIELD_TYPES = Object.freeze({
  campaign_id: 'text', company: 'text', company_domain: 'text', contact_name: 'text', email: 'text',
  hq_state: 'text', hold_reason: 'text', source: 'text', gate_run: 'text',
  contact_status: 'text', review_status: 'text', copy_version: 'text',
  copy_status: 'text', copy_variant: 'text',
  ...Object.fromEntries(C4_VARIABLE_NAMES.map(name => [`var_${name}`, 'text'])),
  evidence_kind: 'text', evidence_url: 'text', evidence_quote: 'text', evidence_observed_at: 'text',
  selection_considered: 'list', selector_version: 'text',
  sourcing_run_id: 'text', imported_at: 'text',
});
const CHECKS = Object.freeze({
  text: value => typeof value === 'string',
  list: value => Array.isArray(value) && value.every(item => typeof item === 'string'),
});
const C4_FIELDS = Object.freeze(Object.keys(FIELD_TYPES));
const DIGESTED = Object.freeze(['schema', ...C4_FIELDS].sort());
const STORED = new Set([...DIGESTED, 'profile_digest']);

function c4ProfileDigest(profile) {
  const pairs = DIGESTED.map(key => {
    if (!Object.prototype.hasOwnProperty.call(profile, key) || profile[key] === undefined) throw new Error(`Campaign 4 profile is missing ${key}`);
    return [key, profile[key]];
  });
  return crypto.createHash('sha256').update(JSON.stringify(pairs), 'utf8').digest('hex');
}

function serializeC4Profile(profile) {
  const ordered = { schema: C4_SCHEMA };
  for (const field of C4_FIELDS) {
    if (!CHECKS[FIELD_TYPES[field]](profile[field])) throw new Error(`Campaign 4 profile field ${field} must be ${FIELD_TYPES[field]}`);
    ordered[field] = profile[field];
  }
  ordered.profile_digest = c4ProfileDigest(ordered);
  const json = JSON.stringify(ordered);
  if (json.length > MAX_CHARS) throw new Error(`Campaign 4 profile is ${json.length} characters; the limit is ${MAX_CHARS}`);
  return json;
}

const notesOf = lead => String(lead?.campaign_notes ?? lead?.campaignNotes ?? '');

function hasC4ProfileMarker(lead = {}) {
  return notesOf(lead).includes(C4_SCHEMA_MARKER);
}

/** The lead's verified Campaign 4 profile, or why it is unusable. Never throws, never repairs. */
function readC4Profile(lead = {}, { campaignId } = {}) {
  const notes = notesOf(lead).trim();
  if (!notes.includes(C4_SCHEMA_MARKER)) return { ok: false, reason: 'no Campaign 4 profile' };
  const failed = detail => ({ ok: false, reason: C4_PROFILE_INTEGRITY_FAILED, detail });
  if (notes.length > MAX_CHARS) return failed('profile is oversized');
  let parsed;
  try { parsed = JSON.parse(notes); } catch (_) { return failed('profile is not valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.schema !== C4_SCHEMA) return failed('profile has the wrong schema');
  const unexpected = Object.keys(parsed).filter(key => !STORED.has(key));
  if (unexpected.length) return failed(`unexpected field(s): ${unexpected.slice(0, 5).join(', ')}`);
  const missing = DIGESTED.filter(key => !Object.prototype.hasOwnProperty.call(parsed, key));
  if (missing.length) return failed(`missing field(s): ${missing.slice(0, 5).join(', ')}`);
  const mistyped = C4_FIELDS.filter(field => !CHECKS[FIELD_TYPES[field]](parsed[field]));
  if (mistyped.length) return failed(`wrongly typed field(s): ${mistyped.slice(0, 5).join(', ')}`);
  if (!/^[0-9a-f]{64}$/.test(String(parsed.profile_digest || '')) || c4ProfileDigest(parsed) !== parsed.profile_digest) {
    return failed('profile digest does not match its contents');
  }
  if (!REVIEW_STATUSES.includes(parsed.review_status)) return failed('profile has an unknown review status');
  if (!C4_COPY_VERSIONS.includes(parsed.copy_version)) return failed('profile has an unknown copy version');
  if (!COPY_STATUSES.includes(parsed.copy_status) || !VARIANTS.includes(parsed.copy_variant)) return failed('profile has no selected copy variant');
  if (campaignId && parsed.campaign_id !== campaignId) return failed('profile names another campaign');
  const vars = Object.fromEntries(C4_VARIABLE_NAMES.map(name => [name, parsed[`var_${name}`]]).filter(([, value]) => value));
  return { ok: true, profile: parsed, vars, copyVersion: parsed.copy_version, variant: parsed.copy_variant };
}

module.exports = {
  C4_SCHEMA, C4_SCHEMA_MARKER, C4_PROFILE_INTEGRITY_FAILED, C4_FIELDS, REVIEW_STATUSES, C4_COPY_VERSIONS, C4_VARIABLE_NAMES,
  c4ProfileDigest, serializeC4Profile, hasC4ProfileMarker, readC4Profile,
};
