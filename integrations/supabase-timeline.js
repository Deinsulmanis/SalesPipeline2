'use strict';
/**
 * supabase-timeline.js — Stage 2 canonical activity reader. READ-ONLY.
 * ─────────────────────────────────────────────────────────────────────────────
 * Stage 1 mirrors canonical activity into crm_events. Stage 2 asks whether that
 * mirror can SERVE the activity rows the timeline is built from. It answers the
 * narrow question only: this module returns canonical activity rows in the exact
 * shape the ColdCallActivity sheet returns them, so it can be substituted for
 * that one argument and nothing else.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not build the timeline. buildActivityTimeline() merges three sources —
 * stored activity, events DERIVED from current lead state (lead.created,
 * lastEmailedAt/emailStep), and open/demo signals from other sheets. Only the
 * first is mirrored. Replacing the whole timeline with `select * from crm_events`
 * would silently drop the other two, so the substitution point is the activity
 * argument and the projection logic above it is untouched.
 *
 * It never writes. Every request is a GET.
 *
 * THE CONTENT LIMITATION, STATED IN CODE RATHER THAN IN A COMMENT
 *
 * Stage 1 mirrors identifiers and metadata but NOT `content`, which holds email
 * bodies and reply text. The timeline renders content, so a Supabase-served
 * activity row is not a complete substitute today. Every result therefore
 * carries contentAvailable:false, and supabaseMayServeTimeline() refuses to
 * promote Supabase to primary while any returned event would have had content.
 * That is what stops a cutover from quietly blanking 388 message bodies.
 */

const { mirrorConfig, TABLE } = require('./supabase-mirror');

const REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_LIMIT = 500;

// Event types whose canonical rows carry body text. Derived from the writers
// that populate `content`; used to refuse an unsafe cutover, never to fabricate.
const CONTENT_BEARING_TYPES = Object.freeze(new Set([
  'initial_email_sent', 'follow_up_sent', 'sequence_step_sent', 'booking_link_sent',
  'demo_pair_played', 'conversation_note', 'next_action_override',
  'unsubscribe_reply', 'needs_human_reply', 'positive_reply', 'negative_reply',
  'question_reply', 'late_reply', 'wrong_person_reply', 'out_of_office_reply',
  'human_response_sent',
]));

/**
 * Stage 2 mode. Defaults to 'off' so merely deploying this changes nothing.
 *   off     — Sheets only; the reader is never called
 *   dual    — Sheets serves the user; Supabase is read alongside for parity
 *   primary — Supabase serves, Sheets is the fallback (gated, see below)
 */
function timelineMode(env = process.env) {
  const raw = String(env.SUPABASE_TIMELINE_MODE || '').trim().toLowerCase();
  return ['dual', 'primary'].includes(raw) ? raw : 'off';
}

const textOrEmpty = value => (value === null || value === undefined ? '' : String(value));

/**
 * crm_events row → canonical activity row, in ColdCallActivity's own shape.
 *
 * `content` comes back as '' because it was never mirrored. That is why the
 * result is marked incomplete rather than presented as equivalent.
 */
function toCanonicalActivity(row = {}) {
  return {
    eventId: textOrEmpty(row.event_id),
    leadId: textOrEmpty(row.lead_id),
    sourceLeadId: textOrEmpty(row.source_lead_id),
    email: textOrEmpty(row.email),
    company: textOrEmpty(row.company),
    eventType: textOrEmpty(row.event_type),
    occurredAt: row.occurred_at ? new Date(row.occurred_at).toISOString() : '',
    subject: textOrEmpty(row.subject),
    content: '',
    metadata: JSON.stringify(row.metadata ?? {}),
  };
}

/**
 * Deterministic order: by instant, then by event id. The tie-break matters —
 * bulk writes share a timestamp, and without it two equally valid orderings
 * would read as a parity failure.
 */
function sortCanonical(rows, order = 'asc') {
  const direction = order === 'desc' ? -1 : 1;
  return rows.slice().sort((a, b) => {
    const x = Date.parse(a.occurredAt || '');
    const y = Date.parse(b.occurredAt || '');
    const ax = Number.isFinite(x) ? x : null;
    const by = Number.isFinite(y) ? y : null;
    if (ax !== by) {
      if (ax === null) return 1;          // unknown time sorts last, either direction
      if (by === null) return -1;
      return (ax - by) * direction;
    }
    return String(a.eventId).localeCompare(String(b.eventId)) * direction;
  });
}

async function getJson(url, config, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { apikey: config.key, Authorization: `Bearer ${config.key}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

const quote = value => `"${String(value).split('"').join('')}"`;

/**
 * Canonical activity for one lead, from the mirror.
 *
 * Matches the same three identities the application matches on — source lead
 * id, board lead id, email — because a row may carry any of them.
 *
 * NEVER throws: returns { ok: false, reason } so a caller can fall back. An
 * unreachable Supabase must never be read as "this lead has no history".
 */
async function readCanonicalTimeline({
  sourceLeadId = '', leadId = '', email = '',
  limit = DEFAULT_LIMIT, order = 'asc', env = process.env,
} = {}) {
  const config = mirrorConfig(env);
  if (!config.enabled) return { ok: false, events: [], source: 'supabase', reason: config.reason, contentAvailable: false };

  const identities = [];
  if (sourceLeadId) identities.push(`source_lead_id.eq.${quote(sourceLeadId)}`);
  if (leadId) identities.push(`lead_id.eq.${quote(leadId)}`);
  if (email) identities.push(`email.eq.${quote(String(email).trim().toLowerCase())}`);
  if (!identities.length) {
    return { ok: false, events: [], source: 'supabase', reason: 'no lead identity supplied', contentAvailable: false };
  }
  const url = `${config.url}/rest/v1/${TABLE}`
    + `?select=*&or=(${identities.join(',')})`
    + `&order=occurred_at.asc.nullslast,event_id.asc&limit=${Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, 5000))}`;
  try {
    const rows = await getJson(url, config);
    const events = sortCanonical(rows.map(toCanonicalActivity), order);
    return {
      ok: true, events, source: 'supabase', reason: 'ok',
      // Stated per result, not assumed by the caller.
      contentAvailable: false,
      contentBearingCount: events.filter(e => CONTENT_BEARING_TYPES.has(e.eventType)).length,
    };
  } catch (error) {
    const reason = error && error.name === 'AbortError' ? `timeout after ${REQUEST_TIMEOUT_MS}ms` : (error && error.message) || 'unreachable';
    return { ok: false, events: [], source: 'supabase', reason, contentAvailable: false };
  }
}

/** Batch variant, so N leads cost one request rather than N. */
async function readCanonicalTimelines({ sourceLeadIds = [], limit = 5000, env = process.env } = {}) {
  const config = mirrorConfig(env);
  const ids = [...new Set(sourceLeadIds.map(id => String(id || '').trim()).filter(Boolean))];
  if (!config.enabled) return { ok: false, byLead: new Map(), reason: config.reason };
  if (!ids.length) return { ok: true, byLead: new Map(), reason: 'no lead ids supplied' };
  const url = `${config.url}/rest/v1/${TABLE}`
    + `?select=*&source_lead_id=in.(${ids.map(quote).join(',')})`
    + `&order=occurred_at.asc.nullslast,event_id.asc&limit=${Math.max(1, Math.min(Number(limit) || 5000, 20000))}`;
  try {
    const rows = await getJson(url, config, 15000);
    const byLead = new Map();
    for (const row of rows) {
      const key = String(row.source_lead_id || '');
      if (!byLead.has(key)) byLead.set(key, []);
      byLead.get(key).push(toCanonicalActivity(row));
    }
    for (const [key, list] of byLead) byLead.set(key, sortCanonical(list));
    return { ok: true, byLead, reason: 'ok' };
  } catch (error) {
    const reason = error && error.name === 'AbortError' ? 'timeout' : (error && error.message) || 'unreachable';
    return { ok: false, byLead: new Map(), reason };
  }
}

/**
 * Parity between the authoritative activity rows and the mirrored ones.
 *
 * `content` is excluded from the comparison and reported separately: it is a
 * known, deliberate non-mirrored field, and folding it into "mismatch" would
 * bury the real question — whether anything ELSE diverged — under 388 expected
 * differences.
 */
function compareTimelines(authoritative = [], mirrored = []) {
  const left = new Map(authoritative.map(row => [String(row.eventId || ''), row]));
  const right = new Map(mirrored.map(row => [String(row.eventId || ''), row]));
  const missing = [], extra = [], mismatched = [];
  let exact = 0;
  for (const [id, row] of left) {
    const other = right.get(id);
    if (!other) { missing.push(id); continue; }
    const fields = [];
    if (String(row.eventType || '') !== other.eventType) fields.push('eventType');
    const a = Date.parse(row.occurredAt || ''), b = Date.parse(other.occurredAt || '');
    if ((Number.isFinite(a) ? a : null) !== (Number.isFinite(b) ? b : null)) fields.push('occurredAt');
    if (String(row.subject || '') !== other.subject) fields.push('subject');
    if (String(row.sourceLeadId || '') !== other.sourceLeadId) fields.push('sourceLeadId');
    if (String(row.leadId || '') !== other.leadId) fields.push('leadId');
    if (fields.length) mismatched.push({ eventId: id, fields });
    else exact++;
  }
  for (const id of right.keys()) if (!left.has(id)) extra.push(id);

  const authoritativeOrder = sortCanonical(authoritative).map(r => String(r.eventId || ''));
  const mirroredOrder = sortCanonical(mirrored).map(r => String(r.eventId || ''));
  const orderMatches = missing.length === 0 && extra.length === 0
    && authoritativeOrder.join('|') === mirroredOrder.join('|');

  const contentOnly = authoritative.filter(row => String(row.content || '').trim()).length;
  return {
    authoritativeCount: left.size, mirroredCount: right.size,
    exact, missing, extra, mismatched, orderMatches,
    contentBearingAuthoritative: contentOnly,
    // Parity of everything Stage 1 actually mirrors.
    parityClean: missing.length === 0 && extra.length === 0 && mismatched.length === 0 && orderMatches,
  };
}

/**
 * May Supabase serve this timeline as primary?
 *
 * Refuses whenever the answer would be visibly worse than Sheets: an
 * unsuccessful read, or a result where a rendered field (content) would be
 * lost. This is the guard that keeps an empty or partial mirror from replacing
 * a good authoritative answer.
 */
function supabaseMayServeTimeline(result, { authoritativeCount = null } = {}) {
  if (!result || !result.ok) return { allowed: false, reason: result?.reason || 'supabase read failed' };
  if (result.contentBearingCount > 0 && result.contentAvailable === false) {
    return { allowed: false, reason: `content is not mirrored; ${result.contentBearingCount} event(s) would lose body text` };
  }
  if (Number.isFinite(authoritativeCount) && authoritativeCount > 0 && result.events.length === 0) {
    return { allowed: false, reason: 'mirror returned no events while the authoritative store has some' };
  }
  return { allowed: true, reason: 'ok' };
}

module.exports = {
  CONTENT_BEARING_TYPES, DEFAULT_LIMIT, timelineMode, toCanonicalActivity, sortCanonical,
  readCanonicalTimeline, readCanonicalTimelines, compareTimelines, supabaseMayServeTimeline,
};
