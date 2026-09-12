'use strict';
/**
 * outreach-dual-read.js — Stage 3D dual-read parity measurement.
 * ─────────────────────────────────────────────────────────────────────────────
 * In `dual` mode the authoritative Google Sheets read still produces the result
 * the application uses. This reads the SAME state from Supabase alongside it,
 * compares the two, and records what it found. It is measurement only: nothing
 * here returns a value to an automation decision, and no caller may branch on
 * its output.
 *
 * WHY A PROBE RATHER THAN A COMPARISON INSIDE EACH READ PATH
 *
 * There are two read chokepoints for ColdEmail state — loadOutreachDataset() in
 * server.js for the UI, and readLeads(snapshot.coldEmail) in outreach-agent.js
 * for every automation decision. Both already hold the whole corpus. Comparing
 * the corpus once per chokepoint is a single Supabase request; comparing
 * per-request or per-lead would be N+1 against a table that is about to serve
 * production reads, and would make dual mode measurably more expensive than
 * the thing it is validating.
 *
 * So the probe is throttled, bounded, and fire-and-forget. A dual run that
 * cannot reach Supabase records a read failure and changes nothing.
 *
 * COMPARING ONLY WHAT THE SOURCE ACTUALLY LOADED
 *
 * The dashboard snapshot deliberately does NOT load column P (siteContext) — it
 * reads A:O and Q:X and leaves P blank. Comparing that blank against the real
 * value in Supabase would report ~1776 mismatches that are an artefact of the
 * projection, not a divergence in the data. Each caller therefore declares the
 * field set it genuinely loaded, and fields outside that set are not compared.
 *
 * That is the opposite of normalising away a meaningful difference: it is
 * refusing to invent one. A field the source never read cannot disagree.
 */

const {
  SHEET_FIELDS, NONCRITICAL_FIELDS, listOutreachLeads, compareOutreachLead,
} = require('./outreach-state');

// One probe per chokepoint per window. Dual mode is a measurement, not a load test.
const PROBE_INTERVAL_MS = 5 * 60 * 1000;
// A row whose mirror is older than this is stale enough to be worth counting.
const STALE_AFTER_MS = 60 * 60 * 1000;
const MAX_RECENT = 20;
const MAX_SAMPLE_IDS = 25;

/** The dashboard reads A:O and Q:X, so column P never arrives. */
const DASHBOARD_OMITTED_FIELDS = Object.freeze(['siteContext']);

function emptyCounters() {
  return {
    probes: 0, leadsCompared: 0, exact: 0,
    missing: 0, extra: 0, criticalMismatches: 0, noncriticalMismatches: 0,
    duplicateIds: 0, duplicateEmails: 0,
    readFailures: 0, staleRows: 0, fallbacks: 0,
  };
}

const diagnostics = {
  startedAt: new Date().toISOString(),
  lastProbeAt: null,
  byLabel: new Map(),
  recent: [],
  totals: emptyCounters(),
};

const lastProbeAtByLabel = new Map();

function bucket(label) {
  if (!diagnostics.byLabel.has(label)) {
    diagnostics.byLabel.set(label, { ...emptyCounters(), lastProbeAt: null, mirrorLagMs: null });
  }
  return diagnostics.byLabel.get(label);
}

function note(entry) {
  diagnostics.recent.unshift(entry);
  if (diagnostics.recent.length > MAX_RECENT) diagnostics.recent.length = MAX_RECENT;
}

/** Read the whole mirror as a Map, paging so a large tab is not one request. */
async function readMirrorCorpus(options = {}) {
  const byId = new Map();
  const rows = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const page = await listOutreachLeads({ limit: PAGE, offset, ...options });
    if (!page.ok) return { ok: false, byId, rows, reason: page.reason };
    for (const lead of page.leads) byId.set(lead.id, lead);
    for (const row of page.rows || []) rows.push(row);
    if (page.leads.length < PAGE) break;
  }
  return { ok: true, byId, rows, reason: 'ok' };
}

/**
 * Compare an authoritative corpus against the mirror.
 *
 * @param sheetLeads  complete ColdEmail rows, as the authoritative read produced
 * @param comparable  the fields the source genuinely loaded; anything outside
 *                    this set is not compared, because it cannot disagree
 */
function compareCorpus(sheetLeads, mirrorById, comparable) {
  const fields = new Set(comparable);
  const result = {
    leadsCompared: sheetLeads.length, exact: 0, missing: 0, extra: 0,
    criticalMismatches: 0, noncriticalMismatches: 0,
    duplicateIds: 0, duplicateEmails: 0,
    byField: new Map(), missingIds: [], criticalIds: [], extraIds: [],
  };

  const seenIds = new Set();
  const seenEmails = new Set();
  for (const lead of sheetLeads) {
    if (seenIds.has(lead.id)) result.duplicateIds++;
    seenIds.add(lead.id);
    const normalized = String(lead.email || '').trim().toLowerCase();
    if (normalized) {
      if (seenEmails.has(normalized)) result.duplicateEmails++;
      seenEmails.add(normalized);
    }

    const mirrored = mirrorById.get(lead.id);
    if (!mirrored) {
      result.missing++;
      if (result.missingIds.length < MAX_SAMPLE_IDS) result.missingIds.push(lead.id);
      continue;
    }
    const verdict = compareOutreachLead(lead, mirrored);
    const critical = verdict.critical.filter(field => fields.has(field));
    const noncritical = verdict.noncritical.filter(field => fields.has(field));
    for (const field of [...critical, ...noncritical]) {
      result.byField.set(field, (result.byField.get(field) || 0) + 1);
    }
    if (critical.length) {
      result.criticalMismatches++;
      if (result.criticalIds.length < MAX_SAMPLE_IDS) {
        result.criticalIds.push({ id: lead.id, fields: critical });
      }
    } else if (noncritical.length) {
      result.noncriticalMismatches++;
    } else {
      result.exact++;
    }
  }

  for (const id of mirrorById.keys()) {
    if (seenIds.has(id)) continue;
    result.extra++;
    if (result.extraIds.length < MAX_SAMPLE_IDS) result.extraIds.push(id);
  }
  return result;
}

/** How far behind the mirror is, and how many rows are stale. */
function measureLag(rows, now = Date.now()) {
  let newest = null;
  let stale = 0;
  for (const row of rows) {
    const at = Date.parse(row.mirrored_at || '');
    if (!Number.isFinite(at)) continue;
    if (newest === null || at > newest) newest = at;
    if (now - at > STALE_AFTER_MS) stale++;
  }
  return { mirrorLagMs: newest === null ? null : Math.max(0, now - newest), staleRows: stale };
}

/**
 * Run one dual-read comparison. NEVER throws — a dual-mode probe that fails is
 * a diagnostic gap, not an application error.
 *
 * @returns the comparison, or null when it did not run.
 */
async function probeOutreachParity(sheetLeads, {
  label = 'unknown', comparable = SHEET_FIELDS, force = false,
  now = Date.now(), env = process.env, logger = console,
} = {}) {
  try {
    if (!Array.isArray(sheetLeads) || !sheetLeads.length) return null;
    const last = lastProbeAtByLabel.get(label) || 0;
    if (!force && now - last < PROBE_INTERVAL_MS) return null;
    lastProbeAtByLabel.set(label, now);

    const mirror = await readMirrorCorpus({ env });
    const slot = bucket(label);
    slot.probes++;
    diagnostics.totals.probes++;
    const at = new Date(now).toISOString();
    slot.lastProbeAt = at;
    diagnostics.lastProbeAt = at;

    if (!mirror.ok) {
      slot.readFailures++;
      diagnostics.totals.readFailures++;
      note({ at, label, outcome: 'read_failure', reason: mirror.reason });
      return null;
    }

    const comparison = compareCorpus(sheetLeads, mirror.byId, comparable);
    const lag = measureLag(mirror.rows, now);
    for (const key of ['leadsCompared', 'exact', 'missing', 'extra',
      'criticalMismatches', 'noncriticalMismatches', 'duplicateIds', 'duplicateEmails']) {
      slot[key] = comparison[key];
      diagnostics.totals[key] += comparison[key];
    }
    slot.staleRows = lag.staleRows;
    slot.mirrorLagMs = lag.mirrorLagMs;
    diagnostics.totals.staleRows = lag.staleRows;

    note({
      at, label, outcome: comparison.criticalMismatches ? 'critical_mismatch' : 'clean',
      leadsCompared: comparison.leadsCompared, exact: comparison.exact,
      missing: comparison.missing, extra: comparison.extra,
      critical: comparison.criticalMismatches, noncritical: comparison.noncriticalMismatches,
      mirrorLagMs: lag.mirrorLagMs, staleRows: lag.staleRows,
      // Lead ids and field NAMES only. Field values are prospect data.
      criticalSample: comparison.criticalIds.slice(0, 5),
      missingSample: comparison.missingIds.slice(0, 5),
    });

    if (comparison.criticalMismatches) {
      logger.warn(`[stage3-dual] ${label}: ${comparison.criticalMismatches} critical mismatch(es) `
        + `across ${comparison.leadsCompared} lead(s). Google Sheets served the result; `
        + 'Supabase is not eligible for a read cutover until this is zero.');
    }
    return comparison;
  } catch (error) {
    bucket(label).readFailures++;
    diagnostics.totals.readFailures++;
    note({ at: new Date(now).toISOString(), label, outcome: 'probe_error',
      reason: (error && error.message) || 'unknown' });
    return null;
  }
}

/** Fire-and-forget, for a caller that must not wait on measurement. */
function probeOutreachParityInBackground(sheetLeads, options = {}) {
  try {
    const result = probeOutreachParity(sheetLeads, options);
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch { /* a probe may never disturb its caller */ }
}

function recordFallback(label, reason) {
  bucket(label).fallbacks++;
  diagnostics.totals.fallbacks++;
  note({ at: new Date().toISOString(), label, outcome: 'fallback', reason });
}

/** Everything the Stage 3 parity endpoint reports. No secrets, no field values. */
function stage3ParitySnapshot(mode) {
  const byLabel = {};
  for (const [label, slot] of diagnostics.byLabel) byLabel[label] = { ...slot };
  return {
    mode,
    startedAt: diagnostics.startedAt,
    lastProbeAt: diagnostics.lastProbeAt,
    probeIntervalMs: PROBE_INTERVAL_MS,
    staleAfterMs: STALE_AFTER_MS,
    totals: { ...diagnostics.totals },
    byLabel,
    recent: diagnostics.recent.slice(0, MAX_RECENT),
  };
}

/** Test seam. */
function resetStage3Diagnostics() {
  diagnostics.startedAt = new Date().toISOString();
  diagnostics.lastProbeAt = null;
  diagnostics.byLabel.clear();
  diagnostics.recent.length = 0;
  diagnostics.totals = emptyCounters();
  lastProbeAtByLabel.clear();
}

module.exports = {
  PROBE_INTERVAL_MS, STALE_AFTER_MS, DASHBOARD_OMITTED_FIELDS, NONCRITICAL_FIELDS,
  readMirrorCorpus, compareCorpus, measureLag,
  probeOutreachParity, probeOutreachParityInBackground,
  recordFallback, stage3ParitySnapshot, resetStage3Diagnostics,
};
