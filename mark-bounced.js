/**
 * One-time cleanup: mark known-bounced addresses as Done.
 * Run once via: node -r dotenv/config mark-bounced.js
 */

require('dotenv').config();
const { google } = require('googleapis');
const fs   = require('fs');
const path = require('path');

const TOKEN_PATH     = path.join(__dirname, 'token.json');
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME     = 'ColdEmail';

const KNOWN_BOUNCED = [
  'user@domain.com',
  '1k2info@gumdocs.com',
  'dev@studiothink.com',
  'columbiainfo@mrcbc.ca',
];

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

const COLUMNS = [
  'id','company','contactName','email','city','tradeType','website',
  'stage','emailStatus','lastEmailedAt','emailStep','notes',
  'reviewCount','rating','tier','siteContext','campaign','campaign_notes',
];

// Durable global suppression list (see outreach-agent.js / server.js). A manual
// CLI bounce must land here too, else it survives re-import only by luck of its
// row not being deleted — the exact fragility the tab exists to remove.
const SUPPRESSION_SHEET  = 'Suppression';
const SUPPRESSION_HEADER = ['email','reason','company','suppressedAt','source'];

async function ensureSuppressionSheet() {
  const s  = sheets();
  const ss = await s.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  if (ss.data.sheets.find(sh => sh.properties.title === SUPPRESSION_SHEET)) return;
  await s.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: SUPPRESSION_SHEET } } }] },
  });
  await s.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID, range: `${SUPPRESSION_SHEET}!A1`,
    valueInputOption: 'RAW', requestBody: { values: [SUPPRESSION_HEADER] },
  });
  console.log('[Suppression] tab created with headers');
}

// Reads existing suppressed emails (tolerant: empty set on any failure).
async function loadSuppressedEmails() {
  try {
    const r = await sheets().spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID, range: `${SUPPRESSION_SHEET}!A:A`,
    });
    return new Set((r.data.values || []).slice(1).map(row => (row[0] || '').toLowerCase().trim()).filter(Boolean));
  } catch (_e) { return new Set(); }
}

// Appends one email to the tab. Idempotent against `known` (no duplicate rows
// across re-runs or overlap with an earlier migration).
async function addSuppression(email, company, known) {
  const e = (email || '').toLowerCase().trim();
  if (!e || known.has(e)) return false;
  await sheets().spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID, range: `${SUPPRESSION_SHEET}!A:E`,
    valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[e, 'bounce', company || '', new Date().toISOString(), 'manual-bounce-cli']] },
  });
  known.add(e);
  return true;
}

async function run() {
  if (!SPREADSHEET_ID) throw new Error('SPREADSHEET_ID missing from .env');
  loadToken();

  const resp = await sheets().spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range:         `${SHEET_NAME}!A:R`,
  });
  const rows  = resp.data.values || [];
  const leads = rows.slice(1).map((row, idx) => {
    const lead = { _row: idx + 2 };
    COLUMNS.forEach((c, i) => { lead[c] = row[i] || ''; });
    return lead;
  }).filter(l => l.id);

  const bounceSet = new Set(KNOWN_BOUNCED.map(e => e.toLowerCase().trim()));
  const targets   = leads.filter(l => bounceSet.has((l.email || '').toLowerCase().trim()));

  if (!targets.length) {
    console.log('No matching leads found for known-bounced list.');
    return;
  }

  await ensureSuppressionSheet();
  const suppressed = await loadSuppressedEmails();

  console.log(`Found ${targets.length} lead(s) to mark as bounced:\n`);
  let addedToTab = 0;
  for (const lead of targets) {
    const newNotes = lead.notes
      ? `[BOUNCED - manual cleanup] ${lead.notes}`
      : '[BOUNCED - manual cleanup]';
    console.log(`  Marking: ${lead.email} (${lead.company || '—'}) — row ${lead._row}`);
    await sheets().spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        valueInputOption: 'RAW',
        data: [
          { range: `${SHEET_NAME}!H${lead._row}`, values: [['Done']] },
          { range: `${SHEET_NAME}!I${lead._row}`, values: [['done']] },
          { range: `${SHEET_NAME}!L${lead._row}`, values: [[newNotes]] },
        ],
      },
    });
    // Durable opt-out: also record on the global Suppression tab.
    if (await addSuppression(lead.email, lead.company, suppressed)) addedToTab++;
    console.log(`  ✓ Done`);
  }

  console.log(`\nCleanup complete: ${targets.length} lead(s) marked, ${addedToTab} newly added to the Suppression tab.`);
}

run().catch(e => {
  console.error('[FATAL]', e.message);
  process.exit(1);
});
