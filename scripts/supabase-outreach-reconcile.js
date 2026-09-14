#!/usr/bin/env node
'use strict';
/**
 * supabase-outreach-reconcile.js — repair the Google Sheets mirror from Supabase.
 * ─────────────────────────────────────────────────────────────────────────────
 * The reverse of supabase-outreach-backfill.js. Once Supabase is canonical, a
 * Sheets mirror write can fail without rolling anything back — that is the whole
 * point of a secondary mirror — so Sheets can drift. This brings it back.
 *
 * It is also step 2 of the rollback procedure. After 3F, `SUPABASE_OUTREACH_WRITES`
 * back to `sheets` is NOT a rollback on its own: Supabase may hold state Sheets
 * never received, and flipping authority to a stale store would resurrect old
 * values for every lead that changed since the drift began. Reconcile FIRST,
 * verify parity, and only then move authority.
 *
 * DRY RUN IS THE DEFAULT. Writing requires --apply, explicitly.
 *
 * What it will never do:
 *   * send email — it never loads the agent or any Gmail client
 *   * write to Supabase — Supabase is the source here and is only read
 *   * touch a lead whose Sheets row already matches
 *   * create rows — a lead in Supabase with no Sheets row is REPORTED, not
 *     appended, because inventing a row number is how a write lands on the
 *     wrong lead
 *
 *   node scripts/supabase-outreach-reconcile.js            # dry run
 *   node scripts/supabase-outreach-reconcile.js --apply    # repair Sheets
 *   node scripts/supabase-outreach-reconcile.js --verify   # parity only
 */

require('dotenv').config();
const { google } = require('googleapis');
const { mirrorConfig } = require('../integrations/supabase-mirror');
const {
  SHEET_FIELDS, NONCRITICAL_FIELDS, readOutreachCorpus, compareOutreachLead,
  columnLetterFor,
} = require('../integrations/outreach-state');

const SHEET_NAME = 'ColdEmail';
const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const hit = argv.find(item => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const APPLY = flag('apply');
const VERIFY_ONLY = flag('verify');
const SHOW = Math.max(0, Number(value('show', 10)) || 10);
const BATCH = Math.max(1, Math.min(200, Number(value('batch', 100)) || 100));

/** Read-write only when applying; read-only otherwise, enforced by scope. */
function sheetsClient(readOnly) {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}'),
    scopes: [readOnly
      ? 'https://www.googleapis.com/auth/spreadsheets.readonly'
      : 'https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function readSheetLeads(sheets) {
  const rows = (await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SPREADSHEET_ID, range: `${SHEET_NAME}!A:X`,
  })).data.values || [];
  const byId = new Map();
  rows.slice(1).forEach((row, index) => {
    const lead = { _row: index + 2 };
    SHEET_FIELDS.forEach((field, i) => { lead[field] = row[i] || ''; });
    if (lead.id) byId.set(lead.id, lead);
  });
  return byId;
}

async function main() {
  const config = mirrorConfig();
  if (!config.enabled) {
    console.error(`Supabase is not configured: ${config.reason}`);
    process.exitCode = 2; return;
  }
  const mode = VERIFY_ONLY ? 'VERIFY (no writes)' : APPLY ? 'APPLY (repairs Google Sheets)' : 'DRY RUN (no writes)';
  console.log(`supabase-outreach-reconcile — ${mode}`);
  console.log('  direction: Supabase (canonical) -> Google Sheets (mirror)\n');

  const canonical = await readOutreachCorpus();
  if (!canonical.ok) {
    console.error(`Could not read the canonical corpus: ${canonical.reason}`);
    process.exitCode = 1; return;
  }
  const sheets = sheetsClient(!APPLY || VERIFY_ONLY);
  const sheetById = await readSheetLeads(sheets);

  console.log(`  Supabase leads : ${canonical.leads.length}`);
  console.log(`  Sheets leads   : ${sheetById.size}`);

  const drifted = [];
  const absent = [];
  const byField = new Map();
  for (const lead of canonical.leads) {
    const sheetLead = sheetById.get(lead.id);
    if (!sheetLead) { absent.push(lead.id); continue; }
    // compareOutreachLead(sheet, mirror) — here the MIRROR is Sheets, so the
    // arguments are reversed relative to the backfill: Supabase is the truth.
    const verdict = compareOutreachLead(lead, sheetLead);
    const fields = [...verdict.critical, ...verdict.noncritical].filter(f => f !== '<missing from supabase>');
    if (!fields.length) continue;
    for (const field of fields) byField.set(field, (byField.get(field) || 0) + 1);
    drifted.push({ id: lead.id, row: sheetLead._row, fields, lead });
  }

  const extra = [...sheetById.keys()].filter(id => !canonical.leads.some(l => l.id === id));

  console.log(`\n── drift ───────────────────────────────────────────────`);
  console.log(`  in sync                 ${canonical.leads.length - drifted.length - absent.length}`);
  console.log(`  drifted (Sheets behind) ${drifted.length}`);
  console.log(`  absent from Sheets      ${absent.length}  (reported, never appended)`);
  console.log(`  extra in Sheets         ${extra.length}  (not in Supabase)`);
  if (byField.size) {
    console.log('\n  drift by field:');
    for (const [field, count] of [...byField.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`   ${NONCRITICAL_FIELDS.includes(field) ? ' ' : '*'} ${field.padEnd(26)} ${count}`);
    }
  }
  // Lead ids and field NAMES only. Values are prospect data.
  for (const row of drifted.slice(0, SHOW)) console.log(`    drift : ${row.id} row ${row.row}  ${row.fields.join(', ')}`);
  for (const id of absent.slice(0, SHOW)) console.log(`    absent: ${id}`);
  for (const id of extra.slice(0, SHOW)) console.log(`    extra : ${id}`);

  if (APPLY && !VERIFY_ONLY && drifted.length) {
    let repaired = 0;
    for (let i = 0; i < drifted.length; i += BATCH) {
      const slice = drifted.slice(i, i + BATCH);
      const data = [];
      for (const row of slice) {
        for (const field of row.fields) {
          data.push({
            range: `${SHEET_NAME}!${columnLetterFor(field)}${row.row}`,
            values: [[String(row.lead[field] ?? '')]],
          });
        }
      }
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: process.env.SPREADSHEET_ID,
        requestBody: { valueInputOption: 'RAW', data },
      });
      repaired += slice.length;
      console.log(`  [${Math.min(i + BATCH, drifted.length)}/${drifted.length}] repaired ${slice.length} lead(s)`);
    }
    console.log(`\n  repaired ${repaired} lead(s). Re-run with --verify to confirm.`);
  } else if (!VERIFY_ONLY && drifted.length) {
    console.log(`\n  DRY RUN: would repair ${drifted.length} lead(s) by writing only the drifted cells. Re-run with --apply.`);
  }

  const blocking = drifted.length + absent.length;
  console.log(`\n  VERDICT: ${blocking === 0
    ? 'SHEETS MIRROR IN SYNC — every canonical lead matches its Sheets row.'
    : `${blocking} lead(s) need repair.`}`);
  process.exitCode = blocking === 0 || (!APPLY && !VERIFY_ONLY) ? 0 : 1;
}

main().catch(error => {
  console.error(`supabase-outreach-reconcile failed: ${error.message}`);
  process.exitCode = 1;
});
