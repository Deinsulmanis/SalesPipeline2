'use strict';
const { SHEET_FIELDS, outreachWriteAuthority, getOutreachLeadById } = require('../outreach-state');

// No initialization, header repair, mirroring, dashboard loaders or write scope.
// Read the write authority, avoiding stale mirrors when evaluating history.
async function readLead(id, { env = process.env, getSupabase = getOutreachLeadById, readSheet } = {}) {
  if (outreachWriteAuthority(env) === 'supabase') {
    const result = await getSupabase(id, { env });
    if (!result.ok) throw new Error('LEAD_READ_FAILED');
    return result.lead || null;
  }
  if (!readSheet) {
    readSheet = async () => {
      const { google } = require('googleapis');
      const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
      const result = await google.sheets({ version: 'v4', auth }).spreadsheets.values.get({
        spreadsheetId: env.SPREADSHEET_ID, range: 'ColdEmail!A:X',
      }, { timeout: 15000 });
      return result.data.values || [];
    };
  }
  try {
    const rows = await readSheet();
    const matches = rows.slice(1).filter(r => r[0] === id);
    if (matches.length > 1) throw new Error('duplicate');
    return matches.length ? Object.fromEntries(SHEET_FIELDS.map((f, i) => [f, matches[0][i] || ''])) : null;
  } catch { throw new Error('LEAD_READ_FAILED'); }
}
module.exports = { readLead };
