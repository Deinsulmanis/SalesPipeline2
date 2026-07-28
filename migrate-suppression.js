#!/usr/bin/env node
/**
 * migrate-suppression.js — one-time (idempotent) backfill of the global
 * Suppression tab from existing per-row opt-out tags.
 *
 * Scans ColdEmail for any row whose notes carry '[REPLY: Unsubscribed]' or
 * '[BOUNCED', and records that address on the Suppression tab (email, reason,
 * company, suppressedAt, source='migration'). The tab is the durable, email-
 * keyed opt-out record checked at both import (server.js) and send
 * (outreach-agent.js), so an opt-out survives its ColdEmail row being deleted.
 *
 * Idempotent: emails already on the tab are skipped, so re-running is safe.
 * Read-only against ColdEmail; only ever APPENDS to Suppression.
 *
 *   node migrate-suppression.js            # perform the backfill
 *   node migrate-suppression.js --dry      # report what it would add, write nothing
 */
'use strict';
require('dotenv').config();
const { google } = require('googleapis');

const DRY = process.argv.includes('--dry');
const CE_SHEET  = 'ColdEmail';
const SUP_SHEET = 'Suppression';
const SUP_HEADER = ['email', 'reason', 'company', 'suppressedAt', 'source'];
const norm = e => (e || '').toLowerCase().trim();

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

(async () => {
  const s = google.sheets({ version: 'v4', auth });
  const SID = process.env.SPREADSHEET_ID;

  // Ensure the Suppression tab exists (create + header if missing).
  const ss = await s.spreadsheets.get({ spreadsheetId: SID });
  const hasTab = ss.data.sheets.some(sh => sh.properties.title === SUP_SHEET);
  if (!hasTab) {
    if (DRY) { console.log(`[dry] would create the "${SUP_SHEET}" tab`); }
    else {
      await s.spreadsheets.batchUpdate({ spreadsheetId: SID, requestBody: { requests: [{ addSheet: { properties: { title: SUP_SHEET } } }] } });
      await s.spreadsheets.values.update({ spreadsheetId: SID, range: `${SUP_SHEET}!A1`, valueInputOption: 'RAW', requestBody: { values: [SUP_HEADER] } });
      console.log(`Created "${SUP_SHEET}" tab with headers`);
    }
  }

  // Existing suppression emails (dedup target).
  let existing = new Set();
  if (hasTab) {
    const r = await s.spreadsheets.values.get({ spreadsheetId: SID, range: `${SUP_SHEET}!A:A` });
    existing = new Set((r.data.values || []).slice(1).map(row => norm(row[0])).filter(Boolean));
  }
  console.log(`Suppression tab currently holds ${existing.size} email(s).`);

  // Scan ColdEmail for tagged rows (email col D=3, company B=1, notes L=11).
  const ce = await s.spreadsheets.values.get({ spreadsheetId: SID, range: `${CE_SHEET}!A:S` });
  const rows = (ce.data.values || []).slice(1);
  const toAdd = [];
  const seenThisRun = new Set();
  let taggedRows = 0;
  for (const row of rows) {
    const email = norm(row[3]);
    const notes = row[11] || '';
    const unsub = notes.includes('[REPLY: Unsubscribed]');
    const bounce = notes.includes('[BOUNCED');
    if (!unsub && !bounce) continue;
    taggedRows++;
    if (!email || existing.has(email) || seenThisRun.has(email)) continue;
    seenThisRun.add(email);
    toAdd.push([email, unsub ? 'unsubscribe' : 'bounce', row[1] || '', new Date().toISOString(), 'migration']);
  }

  console.log(`ColdEmail rows carrying an opt-out tag: ${taggedRows}`);
  console.log(`New emails to add to Suppression: ${toAdd.length}` + (toAdd.length ? '' : ' (already fully migrated)'));
  toAdd.forEach(r => console.log(`   + ${r[0].padEnd(38)} ${r[1].padEnd(12)} ${r[2]}`));

  if (!toAdd.length) { console.log('\nNothing to migrate.'); return; }
  if (DRY) { console.log('\n[dry] no rows written.'); return; }

  await s.spreadsheets.values.append({
    spreadsheetId: SID, range: `${SUP_SHEET}!A:E`,
    valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: toAdd },
  });

  // Verify.
  const after = await s.spreadsheets.values.get({ spreadsheetId: SID, range: `${SUP_SHEET}!A:A` });
  const afterSet = new Set((after.data.values || []).slice(1).map(row => norm(row[0])).filter(Boolean));
  const allPresent = toAdd.every(r => afterSet.has(r[0]));
  console.log(`\nAppended ${toAdd.length}. Suppression tab now holds ${afterSet.size} email(s).`);
  console.log(allPresent ? '✅ All migrated emails verified present.' : '⚠️ Some migrated emails not found on re-read — inspect.');
})().catch(e => { console.error('[FATAL]', e.stack); process.exit(1); });
