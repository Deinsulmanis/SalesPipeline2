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
 * Thread consistency: a v4 send records its mode, role and site in the ledger
 * (reservation and send metadata). Every later touch of that lead uses the
 * values its FIRST v4 outbound row recorded, so a later classification edit
 * can never change an open thread. A lead with no entry resolves to hold:
 * v4 sends only after a lead has been classified. Pure apart from the
 * one-time data load.
 */

const DATA = require('./data/jole-personalization-v4.json');
const { COPY_VERSION_V4, SENDABLE_MODES, PERSONALIZATION_MODES } = require('./jole-copy');

const LEADS = Object.freeze(DATA.leads || {});
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

// The mode/role/site the lead's first v4 outbound row recorded, or null.
function pinnedFromLedger(lead, activities) {
  const rows = (Array.isArray(activities) ? activities : [])
    .filter(row => isMine(lead, row) && OUTBOUND_EVIDENCE.test(String(row.eventType || '')))
    .sort((a, b) => (Date.parse(a.occurredAt) || 0) - (Date.parse(b.occurredAt) || 0));
  const first = rows.find(row => metadataOf(row).copyVersion === COPY_VERSION_V4 && metadataOf(row).personalizationMode);
  if (!first) return null;
  const meta = metadataOf(first);
  return {
    mode: meta.personalizationMode, role: meta.personalizationRole || null, location: meta.personalizationSite || null,
    secondaryRole: null, source: 'ledger', reason: 'mode recorded by the first v4 send',
  };
}

/**
 * The personalization a v4 render of this lead must use:
 * { mode, role, location, secondaryRole, reason, source }.
 */
function jolePersonalizationFor(lead = {}, activities = []) {
  const pinned = pinnedFromLedger(lead, activities);
  if (pinned) return pinned;
  const entry = joleClassificationFor(lead);
  if (!entry) return { mode: 'hold', role: null, location: null, secondaryRole: null, source: 'none', reason: 'not classified for Jole v4 personalization' };
  return {
    mode: entry.mode, role: entry.role || null, location: entry.location || null,
    secondaryRole: entry.secondaryRole || null, source: 'classification', reason: entry.reason || '',
    // Strings the lower modes must never print (the claims the audit could not support).
    forbiddenRoles: entry.mode === 'general_craft' ? (entry.unsupportedRoles || []) : [],
    forbiddenLocations: entry.mode === 'exact' ? [] : (entry.unsupportedLocations || []),
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
  JOLE_PERSONALIZATION_DATA: DATA, joleClassificationFor, jolePersonalizationFor, joleSelectionHold, joleFollowUpHold,
  setJoleClassificationForTests,
};
