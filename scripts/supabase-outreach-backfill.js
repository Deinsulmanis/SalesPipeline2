#!/usr/bin/env node
'use strict';
/**
 * supabase-outreach-backfill.js — reconcile outreach_leads against ColdEmail.
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads the authoritative ColdEmail tab (A:X) and upserts each row into the
 * Supabase outreach_leads mirror by lead id, then reports field-by-field parity.
 *
 * DRY RUN IS THE DEFAULT. Writing requires --apply, explicitly.
 *
 * What it will never do, by construction rather than by care:
 *
 *   * mutate Google Sheets — it authenticates with the spreadsheets.READONLY
 *     scope, so a write would be refused by Google even if the code asked
 *   * send email — it never loads the agent or any Gmail client
 *   * change Pipeline state or trigger automation — it touches one table
 *
 * Safe to run repeatedly: lead_id is the primary key and every write is an
 * upsert, so a second run converges instead of duplicating.
 *
 *   node scripts/supabase-outreach-backfill.js              # dry run
 *   node scripts/supabase-outreach-backfill.js --apply      # write the mirror
 *   node scripts/supabase-outreach-backfill.js --verify     # parity only, no write
 *   node scripts/supabase-outreach-backfill.js --verify --show=20
 */

require('dotenv').config();
const { google } = require('googleapis');
const { mirrorConfig } = require('../integrations/supabase-mirror');
const {
  TABLE, SHEET_FIELDS, NONCRITICAL_FIELDS,
  mirrorOutreachLeads, listOutreachLeads, countOutreachLeads, compareOutreachLead,
} = require('../integrations/outreach-state');

const SHEET_NAME = 'ColdEmail';
const READ_RANGE = `${SHEET_NAME}!A:X`;

const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const hit = argv.find(item => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const APPLY = flag('apply');
const VERIFY_ONLY = flag('verify');
const LIMIT = Number(value('limit', 0)) || 0;
const BATCH = Math.max(1, Math.min(500, Number(value('batch', 250)) || 250));
const SHOW = Math.max(0, Number(value('show', 10)) || 10);

/**
 * The authoritative read. READ ONLY scope — the backfill cannot write to the
 * authoritative store even by accident: Google itself refuses the call.
 *
 * The projection deliberately mirrors outreach-agent.js readLeads(): every one
 * of the 24 COLUMNS keys is set, so each row is a COMPLETE lead and passes the
 * partial-row guard in outreach-state.
 */
async function readColdEmailLeads() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: READ_RANGE,
  });
  const rows = response.data.values || [];
  return rows.slice(1).map((row, index) => {
    const lead = { _row: index + 2 };            // 1-based, after the header
    SHEET_FIELDS.forEach((field, i) => { lead[field] = row[i] || ''; });
    return lead;
  }).filter(lead => lead.id);
}

/** Read the whole mirror, paging so a large tab is not one giant request. */
async function readMirror() {
  const byId = new Map();
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const page = await listOutreachLeads({ limit: PAGE, offset });
    if (!page.ok) return { ok: false, byId, reason: page.reason };
    for (const lead of page.leads) byId.set(lead.id, lead);
    if (page.leads.length < PAGE) break;
  }
  return { ok: true, byId, reason: 'ok' };
}

/**
 * Parity report. Counts divergence per field so a systematic mapping error
 * looks different from a handful of rows that changed mid-run.
 */
function report(sheetLeads, mirrorById) {
  const missing = [];
  const criticalRows = [];
  const noncriticalRows = [];
  const byField = new Map();

  for (const lead of sheetLeads) {
    const verdict = compareOutreachLead(lead, mirrorById.get(lead.id) || null);
    if (!verdict.present) { missing.push(lead.id); continue; }
    for (const field of [...verdict.critical, ...verdict.noncritical]) {
      byField.set(field, (byField.get(field) || 0) + 1);
    }
    if (verdict.critical.length) criticalRows.push({ id: lead.id, fields: verdict.critical });
    else if (verdict.noncritical.length) noncriticalRows.push({ id: lead.id, fields: verdict.noncritical });
  }

  const sheetIds = new Set(sheetLeads.map(lead => lead.id));
  const orphaned = [...mirrorById.keys()].filter(id => !sheetIds.has(id));

  return { missing, orphaned, criticalRows, noncriticalRows, byField };
}

function printReport(result, sheetCount, mirrorCount) {
  const { missing, orphaned, criticalRows, noncriticalRows, byField } = result;
  const clean = sheetCount - missing.length - criticalRows.length - noncriticalRows.length;

  console.log('\n── parity ──────────────────────────────────────────────');
  console.log(`  ColdEmail rows        ${sheetCount}`);
  console.log(`  outreach_leads rows   ${mirrorCount === null ? '(unknown)' : mirrorCount}`);
  console.log(`  clean                 ${clean}`);
  console.log(`  missing from mirror   ${missing.length}`);
  console.log(`  CRITICAL mismatches   ${criticalRows.length}`);
  console.log(`  noncritical only      ${noncriticalRows.length}`);
  console.log(`  orphaned in mirror    ${orphaned.length}  (in Supabase, not in the sheet)`);

  if (byField.size) {
    console.log('\n  divergence by field:');
    for (const [field, count] of [...byField.entries()].sort((a, b) => b[1] - a[1])) {
      const tag = NONCRITICAL_FIELDS.includes(field) ? '  ' : ' *';
      console.log(`   ${tag} ${field.padEnd(26)} ${count}`);
    }
    console.log('      (* = behaviour-critical; a critical mismatch blocks cutover)');
  }

  // Lead ids only. Field VALUES are prospect data and are not printed.
  const sample = (label, rows) => {
    if (!rows.length || !SHOW) return;
    console.log(`\n  ${label} (first ${Math.min(SHOW, rows.length)} of ${rows.length}):`);
    for (const row of rows.slice(0, SHOW)) {
      console.log(`    ${typeof row === 'string' ? row : `${row.id}  ${row.fields.join(', ')}`}`);
    }
  };
  sample('missing from mirror', missing);
  sample('CRITICAL mismatches', criticalRows);
  sample('noncritical mismatches', noncriticalRows);
  sample('orphaned in mirror', orphaned);

  const blocking = missing.length + criticalRows.length + orphaned.length;
  console.log(`\n  VERDICT: ${blocking === 0
    ? 'PARITY CLEAN — every ColdEmail row is mirrored with all critical fields equal.'
    : `NOT AT PARITY — ${blocking} row(s) block a cutover.`}`);
  return blocking === 0;
}

async function main() {
  const config = mirrorConfig();
  if (!config.enabled) {
    console.error(`Supabase is not configured: ${config.reason}`);
    process.exitCode = 2;
    return;
  }
  if (!process.env.SPREADSHEET_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    console.error('SPREADSHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON are required.');
    process.exitCode = 2;
    return;
  }

  const mode = VERIFY_ONLY ? 'VERIFY (no writes)' : APPLY ? 'APPLY (writes the mirror)' : 'DRY RUN (no writes)';
  console.log(`supabase-outreach-backfill — ${mode}`);
  console.log(`  target table: ${TABLE}`);

  const sheetLeads = await readColdEmailLeads();
  const selected = LIMIT ? sheetLeads.slice(0, LIMIT) : sheetLeads;
  console.log(`  ColdEmail: ${sheetLeads.length} lead row(s)${LIMIT ? `, limited to ${selected.length}` : ''}`);

  // Duplicate ids would make lead_id-keyed parity meaningless — the second row
  // silently overwrites the first. Surface it rather than mirroring a lie.
  const seen = new Map();
  const duplicates = [];
  for (const lead of selected) {
    if (seen.has(lead.id)) duplicates.push(lead.id);
    else seen.set(lead.id, lead);
  }
  if (duplicates.length) {
    console.log(`\n  WARNING: ${duplicates.length} duplicate lead id(s) in ColdEmail. `
      + 'The mirror keeps the LAST row for each; parity will report the rest as mismatched.');
    if (SHOW) console.log(`    ${[...new Set(duplicates)].slice(0, SHOW).join(', ')}`);
  }

  if (APPLY && !VERIFY_ONLY) {
    let mirrored = 0;
    let failed = 0;
    let skipped = 0;
    for (let i = 0; i < selected.length; i += BATCH) {
      const batch = selected.slice(i, i + BATCH);
      const result = await mirrorOutreachLeads(batch);
      mirrored += result.mirrored;
      failed += result.failed;
      skipped += result.skipped;
      console.log(`  [${Math.min(i + BATCH, selected.length)}/${selected.length}] `
        + `mirrored ${result.mirrored}, failed ${result.failed}, skipped ${result.skipped}`);
      if (result.skipped && result.skippedDetail.length) {
        console.log(`      skip reason: ${result.skippedDetail[0].problem}`);
      }
    }
    console.log(`\n  wrote ${mirrored}, failed ${failed}, skipped ${skipped}`);
  } else if (!VERIFY_ONLY) {
    console.log(`\n  DRY RUN: would upsert ${selected.length} row(s) into ${TABLE}. Re-run with --apply.`);
  }

  const mirror = await readMirror();
  if (!mirror.ok) {
    console.error(`\n  Could not read the mirror for parity: ${mirror.reason}`);
    process.exitCode = 1;
    return;
  }
  const total = await countOutreachLeads();
  const clean = printReport(report(selected, mirror.byId), selected.length, total.ok ? total.count : null);

  // A dry run has not written anything, so "not at parity" is the expected
  // state and must not read as a failure.
  process.exitCode = clean || (!APPLY && !VERIFY_ONLY) ? 0 : 1;
}

main().catch(error => {
  console.error(`supabase-outreach-backfill failed: ${error.message}`);
  process.exitCode = 1;
});
