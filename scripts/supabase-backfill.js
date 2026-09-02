#!/usr/bin/env node
'use strict';
/**
 * supabase-backfill.js — reconcile the Supabase mirror against Google Sheets.
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads canonical activity from the authoritative ColdCallActivity sheet and
 * upserts it into crm_events by deterministic event id.
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
 * It is safe to run repeatedly: event_id is the primary key and every write is
 * an upsert, so a second run converges instead of duplicating.
 *
 *   node scripts/supabase-backfill.js                 # dry run, whole sheet
 *   node scripts/supabase-backfill.js --limit=500     # dry run, first 500
 *   node scripts/supabase-backfill.js --apply         # write
 *   node scripts/supabase-backfill.js --apply --batch=200
 */

require('dotenv').config();
const { google } = require('googleapis');
const { COLD_CALL_ACTIVITY_SHEET, COLD_CALL_ACTIVITY_HEADER } = require('../integrations/cold-call-pipeline');
const {
  mirrorConfig, toCrmEvent, describeUnmirrorable, mirrorEvents,
} = require('../integrations/supabase-mirror');

const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const hit = argv.find(item => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const APPLY = flag('apply');
const LIMIT = Number(value('limit', 0)) || 0;
const BATCH = Math.max(1, Math.min(500, Number(value('batch', 200)) || 200));

async function readCanonicalActivities() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}'),
    // READ ONLY. The backfill cannot write to the authoritative store even by
    // accident: Google itself refuses the call.
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `${COLD_CALL_ACTIVITY_SHEET}!A:J`,
  });
  const rows = response.data.values || [];
  return rows.slice(1).map(row => {
    const activity = {};
    COLD_CALL_ACTIVITY_HEADER.forEach((field, index) => { activity[field] = row[index] || ''; });
    return activity;
  });
}

/** Which of these event ids the mirror already holds. Read-only. */
async function alreadyMirrored(config, eventIds) {
  const found = new Set();
  for (let index = 0; index < eventIds.length; index += 100) {
    const slice = eventIds.slice(index, index + 100);
    const list = slice.map(id => `"${String(id).replace(/"/g, '')}"`).join(',');
    const response = await fetch(`${config.endpoint}?select=event_id&event_id=in.(${encodeURIComponent(list)})`, {
      headers: { apikey: config.key, Authorization: `Bearer ${config.key}` },
    });
    if (!response.ok) throw new Error(`lookup failed: HTTP ${response.status}`);
    for (const row of await response.json()) found.add(row.event_id);
  }
  return found;
}

(async () => {
  const config = mirrorConfig();
  console.log(APPLY ? '=== APPLY ===' : '=== DRY RUN — no writes ===');
  if (!config.enabled) {
    console.error(`Supabase is not configured: ${config.reason}.`);
    console.error('Set SUPABASE_URL and SUPABASE_SECRET_KEY, then re-run.');
    process.exit(1);
  }

  const activities = await readCanonicalActivities();
  const scoped = LIMIT ? activities.slice(0, LIMIT) : activities;
  console.log(`canonical activities read from Google Sheets : ${activities.length}`);
  if (LIMIT) console.log(`limited to                                   : ${scoped.length}`);

  const malformed = [];
  const usable = [];
  const seen = new Set();
  const duplicatesInSheet = [];
  for (const activity of scoped) {
    const problem = describeUnmirrorable(activity);
    if (problem) { malformed.push({ eventId: activity.eventId || '(none)', eventType: activity.eventType || '(none)', problem }); continue; }
    // The sheet is append-only and can legitimately hold the same event twice;
    // upserting both is harmless but reporting it is more honest.
    if (seen.has(activity.eventId)) { duplicatesInSheet.push(activity.eventId); continue; }
    seen.add(activity.eventId);
    usable.push(activity);
  }

  const existing = await alreadyMirrored(config, usable.map(activity => activity.eventId));
  const toInsert = usable.filter(activity => !existing.has(activity.eventId));

  console.log(`representable                                : ${usable.length}`);
  console.log(`already mirrored                             : ${existing.size}`);
  console.log(`would insert                                 : ${toInsert.length}`);
  console.log(`duplicate ids within the sheet               : ${duplicatesInSheet.length}`);
  console.log(`malformed / not safely representable         : ${malformed.length}`);

  if (malformed.length) {
    console.log('\nnot representable:');
    for (const item of malformed.slice(0, 20)) {
      console.log(`  • ${item.eventId} [${item.eventType}] — ${item.problem}`);
    }
    if (malformed.length > 20) console.log(`  … and ${malformed.length - 20} more`);
  }

  // What attribution the historical data actually carries. Useful before a
  // real backfill, and a reminder that nulls here are the truth, not a gap to
  // be filled in.
  const withAttribution = key => toInsert.filter(activity => toCrmEvent(activity)[key] !== null).length;
  if (toInsert.length) {
    console.log('\nattribution present on the rows that would insert:');
    for (const key of ['sender_inbox_id', 'campaign_version', 'provider_message_id', 'provider_thread_id', 'sequence_id']) {
      console.log(`  ${key.padEnd(20)} ${withAttribution(key)} / ${toInsert.length}`);
    }
  }

  if (!APPLY) {
    console.log('\nDRY RUN — nothing was written to Supabase and nothing was read from or written to Google Sheets beyond the read above.');
    return;
  }
  if (!toInsert.length) {
    console.log('\nNothing to insert. The mirror is already reconciled.');
    return;
  }

  let mirrored = 0;
  let failed = 0;
  for (let index = 0; index < toInsert.length; index += BATCH) {
    const batch = toInsert.slice(index, index + BATCH);
    const result = await mirrorEvents(batch, { logger: { log() {}, warn: console.warn } });
    mirrored += result.mirrored;
    failed += result.failed;
    console.log(`  batch ${Math.floor(index / BATCH) + 1}: mirrored ${result.mirrored}, failed ${result.failed}`);
  }
  console.log(`\nmirrored ${mirrored}, failed ${failed}. Google Sheets was never modified.`);
  if (failed) process.exitCode = 1;
})().catch(error => {
  // Never print the error object: a fetch failure can carry request headers.
  console.error('Backfill failed:', error.message);
  process.exit(1);
});
