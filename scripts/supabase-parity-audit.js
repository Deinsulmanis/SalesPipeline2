#!/usr/bin/env node
'use strict';
/**
 * supabase-parity-audit.js — Stage 2 parity evidence. READ-ONLY, both sides.
 * ─────────────────────────────────────────────────────────────────────────────
 * Compares the authoritative ColdCallActivity sheet against the Supabase
 * crm_events mirror by canonical event id, and reports every category of
 * divergence separately. Counts alone are not evidence: two sets can be the
 * same size and still hold different events, so identity drives everything.
 *
 * Authenticates to Google with the READONLY scope and issues only GETs to
 * PostgREST, so neither store can be mutated even by mistake.
 *
 *   node scripts/supabase-parity-audit.js <outputDir>
 */
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { google } = require('googleapis');
const { COLD_CALL_ACTIVITY_SHEET, COLD_CALL_ACTIVITY_HEADER } = require('../integrations/cold-call-pipeline');
const { mirrorConfig, toCrmEvent, describeUnmirrorable } = require('../integrations/supabase-mirror');

const PAGE = 1000;
// content is deliberately never mirrored (email bodies); mirrored_at is when the
// mirror observed the row, not a business fact. Neither is a parity signal.
const COMPARED = ['lead_id', 'source_lead_id', 'email', 'company', 'event_type', 'occurred_at',
  'subject', 'campaign_version', 'campaign_family', 'copy_version', 'sender_inbox_id',
  'provider_message_id', 'provider_thread_id', 'sequence_id', 'sequence_step', 'metadata'];

/** Stable stringify so jsonb key reordering is not read as a difference. */
function stable(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Same instant compares equal regardless of offset spelling or precision. */
function sameInstant(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const x = Date.parse(a), y = Date.parse(b);
  return Number.isFinite(x) && Number.isFinite(y) && x === y;
}

function fieldsDiffer(canonical, mirrored) {
  const diffs = [];
  for (const field of COMPARED) {
    const a = canonical[field], b = mirrored[field];
    if (field === 'occurred_at') { if (!sameInstant(a, b)) diffs.push(field); continue; }
    if (field === 'metadata') { if (stable(a ?? {}) !== stable(b ?? {})) diffs.push(field); continue; }
    // null and absent are the same statement; '' was already normalised to null.
    const left = a === undefined ? null : a;
    const right = b === undefined ? null : b;
    if (stable(left) !== stable(right)) diffs.push(field);
  }
  return diffs;
}

async function readSheetActivity() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SPREADSHEET_ID, range: `${COLD_CALL_ACTIVITY_SHEET}!A:J`,
  });
  const values = response.data.values || [];
  return values.slice(1).map((row, index) => {
    const record = { _row: index + 2 };
    COLD_CALL_ACTIVITY_HEADER.forEach((key, i) => { record[key] = row[i] || ''; });
    return record;
  });
}

async function readAllMirrored(config) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const url = `${config.endpoint}?select=*&order=event_id.asc&limit=${PAGE}&offset=${offset}`;
    const response = await fetch(url, {
      headers: { apikey: config.key, Authorization: `Bearer ${config.key}` },
    });
    if (!response.ok) throw new Error(`PostgREST HTTP ${response.status}`);
    const page = await response.json();
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

const csv = (rows, columns) => [columns.join(','),
  ...rows.map(row => columns.map(c => {
    const value = String(row[c] ?? '');
    return /[",\n]/.test(value) ? `"${value.split('"').join('""')}"` : value;
  }).join(','))].join('\n');

async function run(outDir) {
  if (!outDir) throw new Error('An output directory is required');
  const config = mirrorConfig();
  if (!config.enabled) throw new Error(`Supabase mirror is not configured: ${config.reason}`);

  const canonicalRows = await readSheetActivity();
  const mirroredRows = await readAllMirrored(config);

  // ── canonical side: identity, representability, duplicates ───────────────
  const malformed = [];
  const canonicalById = new Map();
  const canonicalDuplicates = [];
  for (const row of canonicalRows) {
    const problem = describeUnmirrorable(row);
    if (problem) { malformed.push({ row: row._row, eventId: row.eventId || '', eventType: row.eventType || '', problem }); continue; }
    const id = String(row.eventId).trim();
    if (canonicalById.has(id)) { canonicalDuplicates.push({ eventId: id, row: row._row, firstRow: canonicalById.get(id)._row }); continue; }
    canonicalById.set(id, row);
  }

  const mirroredById = new Map();
  const mirroredDuplicates = [];
  for (const row of mirroredRows) {
    if (mirroredById.has(row.event_id)) { mirroredDuplicates.push({ eventId: row.event_id }); continue; }
    mirroredById.set(row.event_id, row);
  }

  // ── compare ──────────────────────────────────────────────────────────────
  const missing = [], extra = [], mismatches = [];
  let exact = 0;
  for (const [id, row] of canonicalById) {
    const mirrored = mirroredById.get(id);
    if (!mirrored) {
      missing.push({ eventId: id, eventType: row.eventType, occurredAt: row.occurredAt,
        sourceLeadId: row.sourceLeadId, leadId: row.leadId, email: row.email, sheetRow: row._row });
      continue;
    }
    const diffs = fieldsDiffer(toCrmEvent(row), mirrored);
    if (diffs.length) mismatches.push({ eventId: id, eventType: row.eventType, fields: diffs.join('|'), sheetRow: row._row });
    else exact++;
  }
  for (const [id, row] of mirroredById) {
    if (!canonicalById.has(id)) extra.push({ eventId: id, eventType: row.event_type, occurredAt: row.occurred_at, mirroredAt: row.mirrored_at });
  }

  const newest = list => list.map(v => Date.parse(v || '')).filter(Number.isFinite).sort((a, b) => b - a)[0];
  const newestCanonical = newest(canonicalRows.map(r => r.occurredAt));
  const newestMirrored = newest(mirroredRows.map(r => r.occurred_at));

  const summary = {
    generatedAt: new Date().toISOString(),
    canonicalRows: canonicalRows.length,
    canonicalRepresentable: canonicalById.size,
    malformedCanonical: malformed.length,
    canonicalDuplicateIds: canonicalDuplicates.length,
    mirroredRows: mirroredRows.length,
    mirroredDuplicateIds: mirroredDuplicates.length,
    exactMatches: exact,
    missingFromSupabase: missing.length,
    extraInSupabase: extra.length,
    payloadMismatches: mismatches.length,
    newestCanonicalAt: newestCanonical ? new Date(newestCanonical).toISOString() : null,
    newestMirroredAt: newestMirrored ? new Date(newestMirrored).toISOString() : null,
    lagSeconds: newestCanonical && newestMirrored ? Math.round((newestCanonical - newestMirrored) / 1000) : null,
    parityClean: missing.length === 0 && extra.length === 0 && mismatches.length === 0
      && mirroredDuplicates.length === 0,
  };

  fs.mkdirSync(outDir, { recursive: true });
  const write = (name, rows, columns) => {
    if (!rows.length) return null;
    const file = path.join(outDir, name);
    fs.writeFileSync(file, csv(rows, columns));
    return file;
  };
  fs.writeFileSync(path.join(outDir, 'stage2-parity-summary.json'), JSON.stringify(summary, null, 2));
  write('stage2-missing-events.csv', missing, ['eventId', 'eventType', 'occurredAt', 'sourceLeadId', 'leadId', 'email', 'sheetRow']);
  write('stage2-extra-events.csv', extra, ['eventId', 'eventType', 'occurredAt', 'mirroredAt']);
  write('stage2-payload-mismatches.csv', mismatches, ['eventId', 'eventType', 'fields', 'sheetRow']);
  write('stage2-malformed-events.csv', malformed, ['row', 'eventId', 'eventType', 'problem']);

  // Per-type coverage, so a whole event class that never mirrors is obvious.
  const byType = new Map();
  for (const [id, row] of canonicalById) {
    const type = row.eventType || '(none)';
    const entry = byType.get(type) || { eventType: type, canonical: 0, mirrored: 0, missing: 0 };
    entry.canonical++;
    if (mirroredById.has(id)) entry.mirrored++; else entry.missing++;
    byType.set(type, entry);
  }
  const coverage = [...byType.values()].sort((a, b) => b.missing - a.missing || b.canonical - a.canonical);
  fs.writeFileSync(path.join(outDir, 'stage2-event-parity.csv'), csv(coverage, ['eventType', 'canonical', 'mirrored', 'missing']));

  console.log(JSON.stringify(summary, null, 2));
  console.log('\n=== COVERAGE BY EVENT TYPE ===');
  for (const row of coverage) {
    console.log(`  ${String(row.canonical).padStart(5)} canonical  ${String(row.mirrored).padStart(5)} mirrored  ${String(row.missing).padStart(5)} missing  ${row.eventType}`);
  }
  return { summary, coverage, missing, extra, mismatches, malformed };
}

if (require.main === module) run(process.argv[2]).catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { run, fieldsDiffer, sameInstant, stable, COMPARED };
