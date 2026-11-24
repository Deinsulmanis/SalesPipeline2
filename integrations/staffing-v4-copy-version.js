'use strict';

/**
 * Industrial Campaign 3: which copy version renders a lead's touches.
 *
 * Owner rule (copy change 2026-11-24): a lead whose Email 1 went out on the
 * v1 copy finishes its sequence on the v1 Emails 2 and 3; every lead whose
 * Email 1 sends after the v2 deploy gets v2 for all three touches. The version
 * is pinned per lead, in this order:
 *
 *   1. A profile sealed under v2 (copy_version in campaign_notes): that version.
 *   2. The send ledger's Email 1 for the lead's current sequence: the version
 *      that send (or its reservation) recorded as `staffingCopyVersion`. A
 *      Campaign 3 Email 1 recorded before v2 existed carries none, so it is v1.
 *   3. No Email 1 in the ledger: a row that shows any send (emailStep,
 *      emailStatus or lastEmailedAt) is v1; a row never sent is v2, the
 *      current version.
 *
 * Callers on the send path pass the activity ledger, so the version a thread
 * started on is read from what was actually sent. Callers without it (queue
 * validation, previews) only ever render leads that have not sent Email 1, for
 * which rule 3 gives the same answer. Pure.
 */

const { COPY_VERSIONS, CURRENT_COPY_VERSION } = require('./staffing-v4-copy');

const LEDGER_EVENTS = Object.freeze(['initial_email_sent', 'follow_up_sent', 'ordinary_send_reserved']);
const LEGACY_VERSION = 'v1';

function parseMetadata(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}'); } catch (_) { return {}; }
}

function rowLeadId(row = {}) {
  if (row.sourceLeadId) return String(row.sourceLeadId);
  const leadId = String(row.leadId || '');
  if (leadId.startsWith('CE-')) return leadId.slice(3);
  return String(parseMetadata(row.metadata).leadId || '');
}

function rowStep(row = {}) {
  if (row.eventType === 'initial_email_sent') return 1;
  const meta = parseMetadata(row.metadata);
  const step = Number(meta.sequenceStep ?? meta.step ?? row.sequenceStep);
  return Number.isInteger(step) ? step : null;
}

/** The copy version one ledger row recorded; a row from before v2 recorded none and is v1. */
function recordedStaffingCopyVersion(row = {}) {
  const value = String(parseMetadata(row.metadata).staffingCopyVersion || '');
  return COPY_VERSIONS.includes(value) ? value : LEGACY_VERSION;
}

/** Email 1 evidence for the lead's current sequence: the latest live step-1 send or reservation. */
function email1Evidence(lead = {}, activities = []) {
  const id = String(lead.id || '');
  if (!id || !Array.isArray(activities)) return null;
  const mine = activities.filter(row => rowLeadId(row) === id);
  const failed = new Set(mine.filter(row => row.eventType === 'ordinary_send_failed')
    .map(row => parseMetadata(row.metadata).reservationEventId).filter(Boolean));
  const step1 = mine.filter(row => LEDGER_EVENTS.includes(String(row.eventType || ''))
    && rowStep(row) === 1 && !failed.has(row.eventId));
  if (!step1.length) return null;
  // A confirmed send outranks its reservation; then the latest wins.
  const at = row => Date.parse(row.occurredAt || '') || 0;
  return step1.sort((a, b) => (b.eventType !== 'ordinary_send_reserved') - (a.eventType !== 'ordinary_send_reserved') || at(b) - at(a))[0];
}

const rowShowsASend = lead => Number(lead.emailStep ?? lead.email_step) > 0
  || Boolean(String(lead.emailStatus ?? lead.email_status ?? '').trim())
  || Boolean(String(lead.lastEmailedAt ?? lead.last_emailed_at ?? '').trim());

/**
 * { copyVersion, reason } for a Campaign 3 lead. `sealedCopyVersion` comes from
 * staffing-v4-profile.js readStaffingV4Profile ('' for pre-v2 profiles).
 */
function resolveV4CopyVersion(lead = {}, activities, { sealedCopyVersion = '' } = {}) {
  if (sealedCopyVersion) {
    if (!COPY_VERSIONS.includes(sealedCopyVersion)) throw new Error(`unknown V4 copy version ${sealedCopyVersion}`);
    return { copyVersion: sealedCopyVersion, reason: 'sealed_at_import' };
  }
  const evidence = email1Evidence(lead, activities);
  if (evidence) return { copyVersion: recordedStaffingCopyVersion(evidence), reason: 'email_1_recorded_version' };
  if (rowShowsASend(lead)) return { copyVersion: LEGACY_VERSION, reason: 'contacted_before_v2' };
  return { copyVersion: CURRENT_COPY_VERSION, reason: 'email_1_not_sent' };
}

module.exports = { resolveV4CopyVersion, recordedStaffingCopyVersion, email1Evidence, LEGACY_VERSION };
