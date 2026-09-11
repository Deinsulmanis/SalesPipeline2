'use strict';
/**
 * supabase-timeline-hybrid.js — Stage 2F hybrid canonical activity read.
 * ─────────────────────────────────────────────────────────────────────────────
 * Stage 2 proved the Supabase mirror is in exact parity with Sheets for
 * everything it holds. It does not hold `content` — email bodies and reply text
 * — and Stage 1 excluded that deliberately. Rather than reverse that privacy
 * decision, this reads metadata from Supabase and hydrates only the bodies it
 * actually needs from the existing authoritative source.
 *
 *   Supabase metadata  →  hydrate content for the events that can carry it
 *                      →  hand the SAME canonical activity array to the SAME
 *                         buildActivityTimeline projection
 *
 * WHY THIS IS A REAL SAVING AND NOT A SHELL GAME
 *
 * 757 of 1048 leads with activity (72%) have no content-bearing event at all.
 * For those the Sheets tab is never opened. The existing reader pulls the whole
 * ~1,772-row tab on every single request — readIntegrationRows is uncached — so
 * skipping it is the entire point. For the remaining 28% hybrid costs the same
 * one read the old path already paid, never more.
 *
 * WHY TYPE, NOT A STORED FLAG
 *
 * Hydration triggers on event TYPE. Type over-triggers slightly (291 leads vs
 * the 251 that truly hold text) and that is the safe direction: it can cause an
 * unnecessary read, never a missing body. Recording "has content" in Supabase
 * would be a schema change in service of an optimisation worth 40 leads.
 *
 * FAILURE IS ALWAYS A REFUSAL, NEVER A GUESS
 *
 * Every path that cannot fully reproduce the authoritative activity array
 * returns ok:false with a bounded reason. A partially hydrated timeline is
 * never returned as success, because a blank body reads as "they wrote nothing"
 * rather than "we could not load it".
 */

const { readCanonicalTimeline, CONTENT_BEARING_TYPES, sortCanonical } = require('./supabase-timeline');

const FALLBACK = Object.freeze({
  SUPABASE_UNAVAILABLE: 'SUPABASE_UNAVAILABLE',
  MIRROR_INCOMPLETE: 'MIRROR_INCOMPLETE',
  HYDRATION_CONTENT_MISSING: 'HYDRATION_CONTENT_MISSING',
  HYDRATION_IDENTITY_UNRESOLVED: 'HYDRATION_IDENTITY_UNRESOLVED',
  HYDRATION_QUERY_FAILED: 'HYDRATION_QUERY_FAILED',
  HYBRID_PARITY_FAILED: 'HYBRID_PARITY_FAILED',
  DUPLICATE_EVENT_ID: 'DUPLICATE_EVENT_ID',
  ORDERING_MISMATCH: 'ORDERING_MISMATCH',
});

const idOf = row => String(row && row.eventId || '').trim();
const belongsToLead = (row, { sourceLeadId, leadId, email }) => {
  const source = String(row.sourceLeadId || '').trim();
  const board = String(row.leadId || '').trim();
  const address = String(row.email || '').trim().toLowerCase();
  return (sourceLeadId && source === sourceLeadId)
    || (leadId && board === leadId)
    || (Boolean(email) && address === String(email).trim().toLowerCase());
};

/**
 * Canonical activity for one lead, metadata from Supabase and bodies hydrated
 * from the authoritative source only where an event could carry one.
 *
 * @param loadAuthoritativeActivities async () => canonical rows (the existing
 *        Sheets reader). Injected, so this module never reaches into server
 *        internals and can be tested without either store.
 * @returns { ok, activities, hydrated, sheetsConsulted, fallbackReason, detail }
 *          NEVER throws.
 */
async function readTimelineHybrid({
  sourceLeadId = '', leadId = '', email = '',
  loadAuthoritativeActivities, env = process.env,
} = {}) {
  const identity = { sourceLeadId: String(sourceLeadId || '').trim(), leadId: String(leadId || '').trim(), email };
  const mirror = await readCanonicalTimeline({ ...identity, env });
  if (!mirror.ok) {
    return { ok: false, activities: [], hydrated: 0, sheetsConsulted: false,
      fallbackReason: FALLBACK.SUPABASE_UNAVAILABLE, detail: mirror.reason };
  }

  const events = mirror.events;
  const ids = events.map(idOf);
  if (ids.some(id => !id)) {
    return { ok: false, activities: [], hydrated: 0, sheetsConsulted: false,
      fallbackReason: FALLBACK.MIRROR_INCOMPLETE, detail: 'a mirrored event has no id' };
  }
  if (new Set(ids).size !== ids.length) {
    return { ok: false, activities: [], hydrated: 0, sheetsConsulted: false,
      fallbackReason: FALLBACK.DUPLICATE_EVENT_ID, detail: 'duplicate event id in the mirror' };
  }

  // Nothing here can carry a body, so the mirror alone is a complete answer.
  const needing = events.filter(event => CONTENT_BEARING_TYPES.has(event.eventType));
  if (!needing.length) {
    return { ok: true, activities: sortCanonical(events, 'desc'), hydrated: 0,
      sheetsConsulted: false, fallbackReason: null, detail: 'no content-bearing events' };
  }

  if (typeof loadAuthoritativeActivities !== 'function') {
    return { ok: false, activities: [], hydrated: 0, sheetsConsulted: false,
      fallbackReason: FALLBACK.HYDRATION_QUERY_FAILED, detail: 'no content source supplied' };
  }

  let authoritative;
  try {
    authoritative = await loadAuthoritativeActivities();
  } catch (error) {
    return { ok: false, activities: [], hydrated: 0, sheetsConsulted: true,
      fallbackReason: FALLBACK.HYDRATION_QUERY_FAILED, detail: String(error && error.message || 'content lookup failed') };
  }
  if (!Array.isArray(authoritative)) {
    return { ok: false, activities: [], hydrated: 0, sheetsConsulted: true,
      fallbackReason: FALLBACK.HYDRATION_QUERY_FAILED, detail: 'content source returned no rows' };
  }

  // Join on canonical event id only. Never timestamp, subject or position.
  const byId = new Map();
  const ambiguous = [];
  for (const row of authoritative) {
    const id = idOf(row);
    if (!id) continue;
    if (byId.has(id)) { ambiguous.push(id); continue; }
    byId.set(id, row);
  }
  if (ambiguous.length) {
    return { ok: false, activities: [], hydrated: 0, sheetsConsulted: true,
      fallbackReason: FALLBACK.HYDRATION_IDENTITY_UNRESOLVED,
      detail: `${ambiguous.length} duplicate id(s) in the content source` };
  }

  let hydrated = 0;
  const merged = [];
  for (const event of events) {
    if (!CONTENT_BEARING_TYPES.has(event.eventType)) { merged.push(event); continue; }
    const row = byId.get(idOf(event));
    if (!row) {
      // The body exists somewhere we cannot see. Refuse rather than blank it.
      return { ok: false, activities: [], hydrated: 0, sheetsConsulted: true,
        fallbackReason: FALLBACK.HYDRATION_CONTENT_MISSING,
        detail: `no authoritative row for ${idOf(event)}` };
    }
    const content = String(row.content ?? '');
    if (content) hydrated++;
    merged.push({ ...event, content });
  }

  // The mirror must not be missing events the authoritative source has for this
  // lead — that would be a silently shorter history, the worst failure mode.
  const authoritativeForLead = authoritative.filter(row => belongsToLead(row, identity) && idOf(row));
  const mirrorIds = new Set(ids);
  const absent = authoritativeForLead.filter(row => !mirrorIds.has(idOf(row)));
  if (absent.length) {
    return { ok: false, activities: [], hydrated: 0, sheetsConsulted: true,
      fallbackReason: FALLBACK.MIRROR_INCOMPLETE,
      detail: `${absent.length} authoritative event(s) absent from the mirror` };
  }

  return { ok: true, activities: sortCanonical(merged, 'desc'), hydrated,
    sheetsConsulted: true, fallbackReason: null, detail: 'hydrated' };
}

/**
 * May the hybrid result serve this timeline?
 *
 * Replaces the Stage 2 content blocker: the question is no longer "does any
 * event carry content" but "was every body we needed actually reproduced".
 */
function hybridMayServeTimeline(result, { authoritativeCount = null } = {}) {
  if (!result || !result.ok) {
    return { allowed: false, reason: result?.fallbackReason || FALLBACK.SUPABASE_UNAVAILABLE };
  }
  if (Number.isFinite(authoritativeCount)) {
    if (authoritativeCount > 0 && result.activities.length === 0) {
      return { allowed: false, reason: FALLBACK.MIRROR_INCOMPLETE };
    }
    if (result.activities.length !== authoritativeCount) {
      return { allowed: false, reason: FALLBACK.HYBRID_PARITY_FAILED };
    }
  }
  return { allowed: true, reason: 'ok' };
}

/**
 * Final-result parity: the hybrid activity array against the authoritative one.
 * Compares content too — this is the check the Stage 2 metadata comparison
 * could not make.
 */
function compareHybridActivities(authoritative = [], hybrid = []) {
  const left = new Map(authoritative.map(row => [idOf(row), row]));
  const right = new Map(hybrid.map(row => [idOf(row), row]));
  const missing = [], extra = [], mismatched = [], contentMismatched = [];
  let exact = 0;
  for (const [id, row] of left) {
    const other = right.get(id);
    if (!other) { missing.push(id); continue; }
    const fields = [];
    if (String(row.eventType || '') !== String(other.eventType || '')) fields.push('eventType');
    const a = Date.parse(row.occurredAt || ''), b = Date.parse(other.occurredAt || '');
    if ((Number.isFinite(a) ? a : null) !== (Number.isFinite(b) ? b : null)) fields.push('occurredAt');
    if (String(row.subject || '') !== String(other.subject || '')) fields.push('subject');
    if (String(row.sourceLeadId || '') !== String(other.sourceLeadId || '')) fields.push('sourceLeadId');
    // Byte-exact content, newlines and unicode included.
    if (String(row.content ?? '') !== String(other.content ?? '')) { fields.push('content'); contentMismatched.push(id); }
    if (fields.length) mismatched.push({ eventId: id, fields });
    else exact++;
  }
  for (const id of right.keys()) if (!left.has(id)) extra.push(id);
  const order = list => sortCanonical(list, 'desc').map(idOf).join('|');
  const orderMatches = missing.length === 0 && extra.length === 0 && order(authoritative) === order(hybrid);
  return {
    authoritativeCount: left.size, hybridCount: right.size, exact,
    missing, extra, mismatched, contentMismatched, orderMatches,
    parityClean: missing.length === 0 && extra.length === 0 && mismatched.length === 0 && orderMatches,
  };
}

module.exports = { FALLBACK, readTimelineHybrid, hybridMayServeTimeline, compareHybridActivities };
