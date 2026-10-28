'use strict';

/**
 * Jole v4 evidence-aware personalization: which claims a lead's copy may make.
 *
 * The classification (data/jole-personalization-v4.json) is reviewed,
 * source-controlled data built from the 2026-10-21 1,000-lead re-audit. One
 * entry per lead id, no contact details:
 *
 *   mode               exact | role_only | general_craft | hold
 *   role, location     the verified values the mode may name (null otherwise)
 *   evidenceUrl, evidenceCheckedAt, evidenceStatus, reason
 *
 * followUpHolds names already-contacted leads (any copy version) whose next
 * touch would repeat a claim the audit found false; their follow-ups never send.
 *
 * Freshness: exact and role_only claim current hiring, so their evidence
 * (evidenceCheckedAt: the latest valid check of the cited posting) must be at
 * most 30 days old when Touch 1 renders. Older evidence fails downward to
 * general_craft, which claims no current opening. A thread already started
 * keeps its recorded mode on Touches 2 and 3, whose wording is conditional.
 *
 * Thread consistency: a v4 or v5 send records its mode, role and site in the
 * ledger (reservation and send metadata). Every later touch of that lead uses
 * the values its FIRST such outbound row recorded, so a later classification
 * edit can never change an open thread. A v2 or v3 thread, which recorded no
 * mode, continues on v5 with exactly the role and site its Touch 1 subject
 * proves, or is held. An untouched lead with no entry resolves to hold: it
 * sends only after it has been classified. v5 uses this same classification.
 * Pure apart from the one-time data load.
 */

const DATA = require('./data/jole-personalization-v4.json');
const { COPY_VERSION, COPY_VERSION_V3, COPY_VERSION_V4, COPY_VERSION_V5, SENDABLE_MODES, PERSONALIZATION_MODES } = require('./jole-copy');
const { readLeadProfile } = require('./lead-profile');

// Versions whose sends record a personalization mode (v5 reuses v4's classification).
const EVIDENCE_AWARE_VERSIONS = Object.freeze([COPY_VERSION_V4, COPY_VERSION_V5]);
// The Touch 1 subject a v2 or v3 thread was sent with, from the role and site it named.
const LEGACY_SUBJECTS = Object.freeze({
  [COPY_VERSION]: (role, location) => `${role} — ${location}`,
  [COPY_VERSION_V3]: (role, location) => `${role} | ${location}`,
});

const LEADS = Object.freeze(DATA.leads || {});
const FRESHNESS_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const FOLLOW_UP_HOLDS = Object.freeze(DATA.followUpHolds || {});

const OUTBOUND_EVIDENCE = /(?:email_sent|follow_up_sent|sequence_step_sent|booking_link_sent|human_response_sent|send_reserved|send_uncertain)/;
const metadataOf = row => {
  if (row?.metadata && typeof row.metadata === 'object') return row.metadata;
  try { return JSON.parse(row?.metadata || '{}') || {}; } catch (_) { return {}; }
};
const normalizeEmail = value => String(value || '').trim().toLowerCase();
const isMine = (lead, row) => (row.sourceLeadId ? row.sourceLeadId === lead.id
  : row.leadId ? [lead.id, `CE-${lead.id}`].includes(row.leadId) : normalizeEmail(row.email) === normalizeEmail(lead.email));

let classificationOverride = null;
/**
 * Tests only: classify fixture leads. value: { [leadId]: entry } and/or a
 * '*' function (lead) => entry for any lead not listed; null restores the
 * reviewed data file.
 */
function setJoleClassificationForTests(value) {
  classificationOverride = value || null;
}

/** The reviewed classification entry for a lead id, or null. */
function joleClassificationFor(lead = {}) {
  const id = String(lead.id || '').trim();
  const entry = classificationOverride
    ? (classificationOverride[id] || (typeof classificationOverride['*'] === 'function' ? classificationOverride['*'](lead) : null))
    : LEADS[id];
  return entry && PERSONALIZATION_MODES.includes(entry.mode) ? entry : null;
}

// This lead's outbound ledger rows, oldest first, without reservations whose
// failure (nothing delivered) was recorded.
function outboundRows(lead, activities) {
  const rows = (Array.isArray(activities) ? activities : []).filter(row => isMine(lead, row));
  const failed = new Set(rows.filter(row => /_send_failed$/.test(String(row.eventType || '')))
    .map(row => metadataOf(row).reservationEventId).filter(Boolean));
  return rows.filter(row => OUTBOUND_EVIDENCE.test(String(row.eventType || '')) && !failed.has(row.eventId))
    .sort((a, b) => (Date.parse(a.occurredAt) || 0) - (Date.parse(b.occurredAt) || 0));
}

// The mode/role/site the lead's first v4 or v5 outbound row recorded, or null.
function pinnedFromLedger(lead, activities) {
  const first = outboundRows(lead, activities)
    .find(row => EVIDENCE_AWARE_VERSIONS.includes(metadataOf(row).copyVersion) && metadataOf(row).personalizationMode);
  if (!first) return null;
  const meta = metadataOf(first);
  return {
    mode: meta.personalizationMode, role: meta.personalizationRole || null, location: meta.personalizationSite || null,
    secondaryRole: null, source: 'ledger', reason: `mode recorded by the first ${meta.copyVersion} send`,
  };
}

/**
 * A v2 or v3 thread recorded no mode. Its Touch 1 named the profile's first
 * role and its hiring site, and its subject was exactly "role — site" (v2) or
 * "role | site" (v3). When the recorded subject proves those values, later
 * touches keep exactly that claim (exact mode) and nothing new. When it does
 * not, the thread is held. Null for any other lead.
 */
function pinnedFromThreadOrigin(lead, activities) {
  const touch1 = outboundRows(lead, activities).find(row => row.eventType === 'initial_email_sent');
  if (!touch1) return null;
  const version = metadataOf(touch1).copyVersion || COPY_VERSION;
  if (!LEGACY_SUBJECTS[version]) return null;
  const profile = readLeadProfile(lead)?.personalization || {};
  const role = String((profile.roles || [])[0] || '').trim();
  const location = String(profile.location || '').trim();
  if (!role || !location || String(touch1.subject || '').trim() !== LEGACY_SUBJECTS[version](role, location)) {
    return { mode: 'hold', role: null, location: null, secondaryRole: null, source: 'thread_origin',
      reason: `${version} thread: its recorded Touch 1 subject does not prove the role and site it named` };
  }
  return { mode: 'exact', role, location, secondaryRole: null, source: 'thread_origin',
    reason: `${version} thread: Touch 1 named ${role} in ${location}` };
}

/**
 * The personalization a v4 render of this lead must use:
 * { mode, role, location, secondaryRole, reason, source }.
 */
/** Is this entry's current-hiring evidence at most 30 days old at `now`? */
function evidenceFresh(entry, now = Date.now()) {
  const checked = Date.parse(entry?.evidenceCheckedAt || '');
  return Number.isFinite(checked) && now - checked <= FRESHNESS_DAYS * DAY_MS;
}

function jolePersonalizationFor(lead = {}, activities = [], { now = Date.now() } = {}) {
  const pinned = pinnedFromLedger(lead, activities) || pinnedFromThreadOrigin(lead, activities);
  if (pinned) return pinned;
  const entry = joleClassificationFor(lead);
  if (!entry) return { mode: 'hold', role: null, location: null, secondaryRole: null, source: 'none', reason: 'not classified for Jole v4 personalization' };
  // Fail downward: a current-hiring claim needs evidence checked within 30 days.
  const stale = ['exact', 'role_only'].includes(entry.mode) && !evidenceFresh(entry, now);
  const mode = stale ? 'general_craft' : entry.mode;
  return {
    mode, role: ['exact', 'role_only'].includes(mode) ? entry.role || null : null,
    location: mode === 'exact' ? entry.location || null : null,
    secondaryRole: mode === 'exact' ? entry.secondaryRole || null : null, source: 'classification',
    reason: stale ? `evidence checked ${entry.evidenceCheckedAt || 'never'} is older than ${FRESHNESS_DAYS} days; ${entry.mode} fell to general_craft` : entry.reason || '',
    // Strings the lower modes must never print (the claims the evidence cannot support).
    forbiddenRoles: mode === 'general_craft' ? [...new Set([...(entry.unsupportedRoles || []), entry.role].filter(Boolean))] : [],
    forbiddenLocations: mode === 'exact' ? [] : [...new Set([...(entry.unsupportedLocations || []), entry.location].filter(Boolean))],
  };
}

/** Why an untouched lead may not start a v4 sequence ('' when it may). */
function joleSelectionHold(lead = {}) {
  const entry = joleClassificationFor(lead);
  if (!entry) return 'not classified for Jole v4 personalization';
  return SENDABLE_MODES.includes(entry.mode) ? '' : `Jole personalization hold: ${entry.reason || 'held for review'}`;
}

/** Why a contacted lead's next follow-up may not send ('' when it may). */
function joleFollowUpHold(lead = {}) {
  const hold = (classificationOverride ? classificationOverride.followUpHolds || {} : FOLLOW_UP_HOLDS)[String(lead.id || '').trim()];
  return hold ? `Jole follow-up hold: ${hold.reason}` : '';
}

module.exports = {
  JOLE_PERSONALIZATION_DATA: DATA, FRESHNESS_DAYS, evidenceFresh, joleClassificationFor, jolePersonalizationFor, joleSelectionHold, joleFollowUpHold,
  setJoleClassificationForTests,
};
