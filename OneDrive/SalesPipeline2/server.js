require('dotenv').config();
const express    = require('express');
const { google } = require('googleapis');
const fs         = require('fs');
const path       = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const TOKEN_PATH     = path.join(__dirname, 'token.json');
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME     = 'Leads';
const COL_RANGE      = `${SHEET_NAME}!A:Q`;
const COLUMNS        = [
  'id','type','first','last','brokerage','tradeType','company',
  'city','cityTrade','phone','email','website',
  'stage','priority','followup','notes','created',
];

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI,
);

// ── TOKEN HELPERS ─────────────────────────────────────────────────────────────

function saveToken(newTokens) {
  const existing = fs.existsSync(TOKEN_PATH)
    ? JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'))
    : {};
  // Merge so refresh_token is never lost when Google omits it on a refresh
  const merged = { ...existing, ...newTokens };
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged));
  return merged;
}

// Persist any auto-refreshed access tokens back to disk
oauth2Client.on('tokens', tokens => {
  console.log('[Auth] Token event — saving refreshed credentials');
  saveToken(tokens);
});

// Read token.json and arm oauth2Client before every Sheets call
function loadToken() {
  if (!fs.existsSync(TOKEN_PATH)) return false;
  try {
    const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    oauth2Client.setCredentials(tokens);
    return true;
  } catch (e) {
    console.error('[Auth] Failed to load token.json:', e.message);
    return false;
  }
}

function isTokenError(e) {
  const status = e?.response?.status || e?.code;
  const msg    = (e?.message || '').toLowerCase();
  return (
    status === 401 ||
    msg.includes('invalid_grant') ||
    msg.includes('token has been expired') ||
    msg.includes('invalid credentials') ||
    msg.includes('unauthorized')
  );
}

// Run a Sheets call; on auth failure refresh once and retry.
// Throws { isAuthError: true } if refresh also fails.
async function withAuth(fn) {
  loadToken(); // always re-read from disk (survives restarts)
  try {
    return await fn();
  } catch (e) {
    if (!isTokenError(e)) throw e;

    console.error('[Auth] Token error on API call:', e.message);
    console.log('[Auth] Attempting refresh with refresh_token...');

    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      oauth2Client.setCredentials(credentials);
      saveToken(credentials);
      console.log('[Auth] Refresh succeeded — retrying request');
      return await fn();
    } catch (refreshErr) {
      console.error('[Auth] Refresh failed:', refreshErr.message);
      const err = new Error('unauthenticated');
      err.isAuthError = true;
      throw err;
    }
  }
}

function sheets() {
  return google.sheets({ version: 'v4', auth: oauth2Client });
}

// In-memory row index: lead.id → 1-based sheet row number
const rowMap = new Map();
let sheetIdCache = null;

// ── AUTH ROUTES ───────────────────────────────────────────────────────────────

app.get('/auth/google', (_req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt:      'consent',    // forces a fresh refresh_token every time
    scope: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.readonly',
    ],
  });
  res.redirect(url);
});

app.get('/oauth2callback', async (req, res) => {
  try {
    const { tokens } = await oauth2Client.getToken(req.query.code);
    if (!tokens.refresh_token) {
      console.warn('[Auth] WARNING: refresh_token missing from callback — user may need to revoke & re-auth');
    } else {
      console.log('[Auth] refresh_token received and saved');
    }
    oauth2Client.setCredentials(tokens);
    saveToken(tokens); // saveToken (not writeFile) so we never stomp a prior refresh_token
    res.redirect('/');
  } catch (e) {
    console.error('[Auth] OAuth callback error:', e.message);
    res.status(500).send('OAuth error: ' + e.message);
  }
});

app.get('/auth/signout', (_req, res) => {
  if (fs.existsSync(TOKEN_PATH)) fs.unlinkSync(TOKEN_PATH);
  oauth2Client.setCredentials({});
  rowMap.clear();
  sheetIdCache = null;
  res.redirect('/');
});

app.get('/auth/status', (_req, res) => {
  res.json({ authenticated: fs.existsSync(TOKEN_PATH) });
});

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────

// Quick gate: no token file at all → 401 immediately (no disk hit for Sheets)
function requireAuth(req, res, next) {
  if (!fs.existsSync(TOKEN_PATH)) return res.status(401).json({ error: 'unauthenticated' });
  next();
}

// ── SHEET HELPERS ─────────────────────────────────────────────────────────────

async function ensureHeader() {
  const s    = sheets();
  const resp = await s.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range:         `${SHEET_NAME}!A1:Q1`,
  });
  if (!resp.data.values?.[0]?.[0] || resp.data.values[0][0] !== 'id') {
    await s.spreadsheets.values.update({
      spreadsheetId:   SPREADSHEET_ID,
      range:           `${SHEET_NAME}!A1`,
      valueInputOption:'RAW',
      requestBody:     { values: [COLUMNS] },
    });
  }
  if (sheetIdCache === null) {
    const ss    = await s.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const sheet = ss.data.sheets.find(sh => sh.properties.title === SHEET_NAME);
    sheetIdCache = sheet ? sheet.properties.sheetId : 0;
  }
}

async function findRow(id) {
  if (rowMap.has(id)) return rowMap.get(id);
  const resp = await sheets().spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range:         COL_RANGE,
  });
  (resp.data.values || []).forEach((row, i) => {
    if (i > 0 && row[0]) rowMap.set(row[0], i + 1);
  });
  return rowMap.get(id) || null;
}

// ── API ROUTES ────────────────────────────────────────────────────────────────

app.get('/api/leads', requireAuth, async (_req, res) => {
  try {
    const leads = await withAuth(async () => {
      await ensureHeader();
      const resp = await sheets().spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range:         COL_RANGE,
      });
      const rows = resp.data.values || [];
      rowMap.clear();
      return rows.slice(1).map((row, idx) => {
        const lead = {};
        COLUMNS.forEach((col, i) => { lead[col] = row[i] || ''; });
        lead.created = parseInt(lead.created) || Date.now();
        if (lead.id) rowMap.set(lead.id, idx + 2);
        return lead;
      }).filter(l => l.id);
    });
    res.json(leads);
  } catch (e) {
    if (e.isAuthError) return res.status(401).json({ error: 'unauthenticated' });
    console.error('[Leads GET]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/leads', requireAuth, async (req, res) => {
  const lead = req.body;
  const vals = [COLUMNS.map(col => lead[col] !== undefined ? String(lead[col]) : '')];
  try {
    await withAuth(async () => {
      const resp = await sheets().spreadsheets.values.append({
        spreadsheetId:   SPREADSHEET_ID,
        range:           COL_RANGE,
        valueInputOption:'RAW',
        insertDataOption:'INSERT_ROWS',
        requestBody:     { values: vals },
      });
      const m = (resp.data.updates?.updatedRange || '').match(/!A(\d+)/);
      if (m) rowMap.set(lead.id, parseInt(m[1]));
    });
    res.json({ ok: true });
  } catch (e) {
    if (e.isAuthError) return res.status(401).json({ error: 'unauthenticated' });
    console.error('[Leads POST]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/leads/:id', requireAuth, async (req, res) => {
  const lead   = req.body;
  const vals   = [COLUMNS.map(col => lead[col] !== undefined ? String(lead[col]) : '')];
  try {
    const rowNum = await withAuth(() => findRow(req.params.id));
    if (!rowNum) return res.status(404).json({ error: 'not found' });
    await withAuth(async () => {
      await sheets().spreadsheets.values.update({
        spreadsheetId:   SPREADSHEET_ID,
        range:           `${SHEET_NAME}!A${rowNum}:Q${rowNum}`,
        valueInputOption:'RAW',
        requestBody:     { values: vals },
      });
    });
    res.json({ ok: true });
  } catch (e) {
    if (e.isAuthError) return res.status(401).json({ error: 'unauthenticated' });
    console.error('[Leads PUT]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/leads/:id', requireAuth, async (req, res) => {
  try {
    const rowNum = await withAuth(() => findRow(req.params.id));
    if (!rowNum) return res.status(404).json({ error: 'not found' });
    if (sheetIdCache === null) await withAuth(() => ensureHeader());
    await withAuth(async () => {
      await sheets().spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          requests: [{
            deleteDimension: {
              range: {
                sheetId:    sheetIdCache,
                dimension:  'ROWS',
                startIndex: rowNum - 1,
                endIndex:   rowNum,
              },
            },
          }],
        },
      });
    });
    rowMap.delete(req.params.id);
    rowMap.forEach((r, lid) => { if (r > rowNum) rowMap.set(lid, r - 1); });
    res.json({ ok: true });
  } catch (e) {
    if (e.isAuthError) return res.status(401).json({ error: 'unauthenticated' });
    console.error('[Leads DELETE]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(3000, () => console.log('ScaleLab Pipeline → http://localhost:3000'));
