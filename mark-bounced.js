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

  console.log(`Found ${targets.length} lead(s) to mark as bounced:\n`);
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
    console.log(`  ✓ Done`);
  }

  console.log(`\nCleanup complete: ${targets.length} lead(s) marked.`);
}

run().catch(e => {
  console.error('[FATAL]', e.message);
  process.exit(1);
});
