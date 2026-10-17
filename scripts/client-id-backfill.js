#!/usr/bin/env node
'use strict';

/**
 * Ownership backfill for the Sheets mirror (ColdEmail column Y), after
 * supabase/migrations/20260930010000_outreach_leads_client_id.sql.
 *
 *   node scripts/client-id-backfill.js           # dry run: report only (default)
 *   node scripts/client-id-backfill.js --apply   # write column Y where safe
 *
 * Dry run uses the read-only Sheets scope. --apply refuses unless the plan has
 * zero mismatches, conflicts and missing rows, re-reads column A immediately
 * before writing and refuses if any row moved, and writes ONE range update of
 * column Y only (one Sheets write). It never touches Supabase, never sends,
 * and prints ids and counts, never email addresses.
 *
 * Run outside send windows with no agent pass running.
 */

require('dotenv').config();
const { google } = require('googleapis');
const { mirrorConfig } = require('../integrations/supabase-mirror');
const { parseGoogleServiceAccountJson } = require('../integrations/google-service-account');
const { fromOutreachLeadRow, columnLetterFor, SHEET_FIELDS } = require('../integrations/outreach-state');
const { planClientIdBackfill } = require('../integrations/clients/ownership-backfill');

const APPLY = process.argv.includes('--apply');
const SHEET = 'ColdEmail';
const PAGE = 1000;

async function readStore() {
  const config = mirrorConfig();
  if (!config.enabled) throw new Error(`Supabase is not configured: ${config.reason}`);
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const response = await fetch(`${config.url}/rest/v1/outreach_leads?select=*&order=lead_id.asc&limit=${PAGE}&offset=${offset}`, {
      headers: { apikey: config.key, Authorization: `Bearer ${config.key}`, Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`outreach_leads HTTP ${response.status}`);
    const page = await response.json();
    if (page.length && !Object.prototype.hasOwnProperty.call(page[0], 'client_id')) {
      throw new Error('outreach_leads has no client_id column: apply 20260930010000 first');
    }
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows.map(fromOutreachLeadRow);
}

function sheetsClient(scope) {
  const credentials = parseGoogleServiceAccountJson(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({ credentials, scopes: [scope] });
  return google.sheets({ version: 'v4', auth });
}

async function readSheet(sheets) {
  const lastColumn = columnLetterFor('clientId');
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.SPREADSHEET_ID, range: `${SHEET}!A:${lastColumn}` });
  return (response.data.values || []).slice(1).map((row, index) => ({
    ...Object.fromEntries(SHEET_FIELDS.map((field, i) => [field, row[i] || ''])), _row: index + 2,
  }));
}

async function main() {
  const scope = APPLY ? 'https://www.googleapis.com/auth/spreadsheets' : 'https://www.googleapis.com/auth/spreadsheets.readonly';
  const sheets = sheetsClient(scope);
  const [storeLeads, sheetLeads] = await Promise.all([readStore(), readSheet(sheets)]);
  const plan = planClientIdBackfill({ sheetLeads, storeLeads });
  console.log(JSON.stringify({ mode: APPLY ? 'apply' : 'dry-run', ...plan, writes: plan.writes.length }, null, 2));
  if (!APPLY) return;
  if (plan.refuse) { console.error('Refusing: resolve mismatches, conflicts and missing rows first.'); process.exitCode = 2; return; }
  if (!plan.writes.length) { console.log('Nothing to write.'); return; }

  // Re-read ids immediately before writing; any movement refuses.
  const ids = (await sheets.spreadsheets.values.get({ spreadsheetId: process.env.SPREADSHEET_ID, range: `${SHEET}!A:A` })).data.values || [];
  const byRow = new Map(sheetLeads.map(lead => [lead._row, lead]));
  for (const write of plan.writes) {
    if (String(ids[write.row - 1]?.[0] || '') !== write.id) throw new Error(`row ${write.row} moved since planning; nothing written`);
  }
  const column = columnLetterFor('clientId');
  const lastRow = Math.max(...sheetLeads.map(lead => lead._row));
  const fills = new Map(plan.writes.map(write => [write.row, write.clientId]));
  const values = [];
  for (let row = 2; row <= lastRow; row += 1) values.push([fills.get(row) || (byRow.get(row)?.clientId || '')]);
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.SPREADSHEET_ID, range: `${SHEET}!${column}2:${column}${lastRow}`,
    valueInputOption: 'RAW', requestBody: { values },
  });
  console.log(`Wrote ${plan.writes.length} owner cell(s) in column ${column}. Re-run without --apply to verify.`);
}

main().catch(error => { console.error(`[client-id-backfill] ${error.message}`); process.exitCode = 1; });
