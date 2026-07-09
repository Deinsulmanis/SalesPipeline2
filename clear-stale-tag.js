/**
 * One-shot cleanup: clear stale '[REPLY: Interested]' tags.
 *
 * A lead tagged Interested but sitting in an Unsubscribed stage is a
 * contradiction — it means the classifier tagged it (historically it defaulted
 * to INTERESTED on any API failure) and a human later corrected the stage by
 * hand, leaving the tag behind to inflate the campaign panel's Interested count.
 *
 * Previews by default. Nothing is written unless you pass --apply.
 *
 *   node -r dotenv/config clear-stale-tag.js           # dry run, shows matches
 *   node -r dotenv/config clear-stale-tag.js --apply   # writes the correction
 */

require('dotenv').config();
const { google } = require('googleapis');
const fs   = require('fs');
const path = require('path');

const TOKEN_PATH     = path.join(__dirname, 'token.json');
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME     = 'ColdEmail';

const APPLY = process.argv.includes('--apply');

const TAG           = '[REPLY: Interested]';
const STALE_STAGES  = ['Unsubscribed', 'Unsub'];   // dashboard writes the former, the agent the latter
const CORRECTED_NOTE = '[Manually corrected — stale Interested tag cleared]';

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI,
);

function loadToken() {
  if (process.env.GMAIL_TOKEN_JSON) {
    oauth2Client.setCredentials(JSON.parse(process.env.GMAIL_TOKEN_JSON));
    return;
  }
  if (!fs.existsSync(TOKEN_PATH)) throw new Error('token.json not found — authenticate via the dashboard first.');
  oauth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')));
}

const sheets = () => google.sheets({ version: 'v4', auth: oauth2Client });

async function run() {
  if (!SPREADSHEET_ID) throw new Error('SPREADSHEET_ID missing from .env');
  loadToken();

  const resp = await sheets().spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range:         `${SHEET_NAME}!A:R`,
  });
  const rows = resp.data.values || [];

  // Column indices: B=company(1) D=email(3) H=stage(7) L=notes(11)
  const targets = [];
  rows.slice(1).forEach((row, idx) => {
    const stage = row[7]  || '';
    const notes = row[11] || '';
    if (notes.includes(TAG) && STALE_STAGES.includes(stage)) {
      targets.push({ rowNum: idx + 2, company: row[1] || '—', email: row[3] || '—', stage, notes });
    }
  });

  if (!targets.length) {
    console.log('No stale Interested tags found. Nothing to do.');
    return;
  }

  console.log(`${APPLY ? 'Clearing' : 'Would clear'} ${targets.length} stale tag(s):\n`);
  for (const t of targets) {
    console.log(`  row ${t.rowNum}: ${t.company} (${t.email})`);
    console.log(`    stage : ${t.stage}`);
    console.log(`    notes : ${JSON.stringify(t.notes)}`);
    console.log(`    ->      ${JSON.stringify(CORRECTED_NOTE)}`);
  }

  if (!APPLY) {
    console.log('\nDry run — nothing written. Re-run with --apply to commit these changes.');
    return;
  }

  for (const t of targets) {
    await sheets().spreadsheets.values.update({
      spreadsheetId:    SPREADSHEET_ID,
      range:            `${SHEET_NAME}!L${t.rowNum}`,
      valueInputOption: 'RAW',
      requestBody:      { values: [[CORRECTED_NOTE]] },
    });
    console.log(`  ✓ row ${t.rowNum} cleared`);
  }

  console.log(`\nCleanup complete: ${targets.length} row(s) corrected.`);
}

run().catch(e => {
  console.error('[FATAL]', e.message);
  process.exit(1);
});
