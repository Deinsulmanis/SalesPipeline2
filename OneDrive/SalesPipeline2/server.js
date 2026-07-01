require('dotenv').config();
const express    = require('express');
const { google } = require('googleapis');
const { spawn }  = require('child_process');
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
// Agent bookkeeping columns (R:T) — read-only in the Leads GET, never written by dashboard routes
const AGENT_COLS      = ['emailStatus', 'lastEmailedAt', 'emailStep'];
const AGENT_READ_RANGE = `${SHEET_NAME}!A:T`;

// ── COLD EMAIL SHEET ──────────────────────────────────────────────────────────
const CE_SHEET_NAME = 'ColdEmail';
const CE_COLUMNS    = [
  'id','company','contactName','email','city','tradeType','website',
  'stage','emailStatus','lastEmailedAt','emailStep','notes',
  'reviewCount','rating','tier','siteContext',                        // M N O P
];
const CE_COL_RANGE  = `${CE_SHEET_NAME}!A:P`;

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

// In-memory row index for ColdEmail sheet
const ceRowMap = new Map();
let ceSheetIdCache = null;

// ── AGENT RUNNER STATE ────────────────────────────────────────────────────────

const LOG_CAP    = 300;
const agentState = { running: false, dryRun: true, startedAt: null, log: [], exitCode: null };
let   agentChild = null;

function agentPushLine(line) {
  agentState.log.push({ ts: new Date().toISOString(), line });
  if (agentState.log.length > LOG_CAP) agentState.log.shift();
}

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
        range:         AGENT_READ_RANGE,   // A:T — includes agent bookkeeping cols R:T
      });
      const rows = resp.data.values || [];
      rowMap.clear();
      return rows.slice(1).map((row, idx) => {
        const lead = {};
        COLUMNS.forEach((col, i) => { lead[col] = row[i] || ''; });
        AGENT_COLS.forEach((col, i) => { lead[col] = row[17 + i] || ''; });
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

// ── COLD EMAIL HELPERS ────────────────────────────────────────────────────────

async function ensureColdEmailSheet() {
  const s  = sheets();
  const ss = await s.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existing = ss.data.sheets.find(sh => sh.properties.title === CE_SHEET_NAME);
  if (!existing) {
    const addResp = await s.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: CE_SHEET_NAME } } }] },
    });
    ceSheetIdCache = addResp.data.replies[0].addSheet.properties.sheetId;
    await s.spreadsheets.values.update({
      spreadsheetId:   SPREADSHEET_ID,
      range:           `${CE_SHEET_NAME}!A1`,
      valueInputOption:'RAW',
      requestBody:     { values: [CE_COLUMNS] },
    });
    console.log('[ColdEmail] Sheet created with headers');
  } else {
    ceSheetIdCache = existing.properties.sheetId;
    const hResp = await s.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range:         `${CE_SHEET_NAME}!A1:P1`,
    });
    const existingHdr = hResp.data.values?.[0] || [];
    // Repair if header is missing, wrong, or shorter than CE_COLUMNS (new columns added)
    if (existingHdr[0] !== 'id' || existingHdr.length < CE_COLUMNS.length) {
      await s.spreadsheets.values.update({
        spreadsheetId:   SPREADSHEET_ID,
        range:           `${CE_SHEET_NAME}!A1`,
        valueInputOption:'RAW',
        requestBody:     { values: [CE_COLUMNS] },
      });
      console.log('[ColdEmail] Header repaired/extended to include new columns');
    }
  }
}

async function findCERow(id) {
  if (ceRowMap.has(id)) return ceRowMap.get(id);
  const resp = await sheets().spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range:         CE_COL_RANGE,
  });
  (resp.data.values || []).forEach((row, i) => {
    if (i > 0 && row[0]) ceRowMap.set(row[0], i + 1);
  });
  return ceRowMap.get(id) || null;
}

// ── COLD EMAIL ROUTES ─────────────────────────────────────────────────────────

app.get('/api/coldemail', requireAuth, async (_req, res) => {
  try {
    const leads = await withAuth(async () => {
      await ensureColdEmailSheet();
      const resp = await sheets().spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range:         CE_COL_RANGE,
      });
      const rows = resp.data.values || [];
      ceRowMap.clear();
      return rows.slice(1).map((row, idx) => {
        const lead = {};
        CE_COLUMNS.forEach((col, i) => { lead[col] = row[i] || ''; });
        lead.created = parseInt(lead.created) || Date.now();
        if (lead.id) ceRowMap.set(lead.id, idx + 2);
        return lead;
      }).filter(l => l.id);
    });
    res.json(leads);
  } catch (e) {
    if (e.isAuthError) return res.status(401).json({ error: 'unauthenticated' });
    console.error('[ColdEmail GET]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/coldemail/import', requireAuth, async (req, res) => {
  const rows = req.body;
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'body must be an array' });
  try {
    const result = await withAuth(async () => {
      await ensureColdEmailSheet();
      const existing = await sheets().spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range:         `${CE_SHEET_NAME}!D:D`,   // email column
      });
      const existingEmails = new Set(
        (existing.data.values || []).slice(1)
          .map(r => (r[0] || '').toLowerCase().trim()).filter(Boolean)
      );
      const now   = Date.now();
      const toAdd = [];
      let skipped = 0;
      for (const row of rows) {
        const email = (row.email || '').toLowerCase().trim();
        if (!email || existingEmails.has(email)) { skipped++; continue; }
        existingEmails.add(email);
        const id   = now.toString(36) + Math.random().toString(36).slice(2);
        const lead = {
          id, company: row.company || '', contactName: row.contactName || '',
          email: row.email || '', city: row.city || '', tradeType: row.tradeType || '',
          website: row.website || '', stage: 'Import',
          emailStatus: '', lastEmailedAt: '', emailStep: '',
          notes: row.notes || '',
          reviewCount: row.reviewCount || '', rating: row.rating || '',
          tier: row.tier || '',         siteContext: row.siteContext || '',
        };
        toAdd.push(CE_COLUMNS.map(col => String(lead[col] ?? '')));
      }
      if (toAdd.length > 0) {
        await sheets().spreadsheets.values.append({
          spreadsheetId:   SPREADSHEET_ID,
          range:           CE_COL_RANGE,
          valueInputOption:'RAW',
          insertDataOption:'INSERT_ROWS',
          requestBody:     { values: toAdd },
        });
        ceRowMap.clear();
      }
      return { added: toAdd.length, skipped };
    });
    res.json(result);
  } catch (e) {
    if (e.isAuthError) return res.status(401).json({ error: 'unauthenticated' });
    console.error('[ColdEmail Import]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/coldemail', requireAuth, async (req, res) => {
  const lead = req.body;
  const vals = [CE_COLUMNS.map(col => lead[col] !== undefined ? String(lead[col]) : '')];
  try {
    await withAuth(async () => {
      const resp = await sheets().spreadsheets.values.append({
        spreadsheetId:   SPREADSHEET_ID,
        range:           CE_COL_RANGE,
        valueInputOption:'RAW',
        insertDataOption:'INSERT_ROWS',
        requestBody:     { values: vals },
      });
      const m = (resp.data.updates?.updatedRange || '').match(/!A(\d+)/);
      if (m) ceRowMap.set(lead.id, parseInt(m[1]));
    });
    res.json({ ok: true });
  } catch (e) {
    if (e.isAuthError) return res.status(401).json({ error: 'unauthenticated' });
    console.error('[ColdEmail POST]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/coldemail/:id', requireAuth, async (req, res) => {
  const lead = req.body;
  const vals = [CE_COLUMNS.map(col => lead[col] !== undefined ? String(lead[col]) : '')];
  try {
    const rowNum = await withAuth(() => findCERow(req.params.id));
    if (!rowNum) return res.status(404).json({ error: 'not found' });
    await withAuth(async () => {
      await sheets().spreadsheets.values.update({
        spreadsheetId:   SPREADSHEET_ID,
        range:           `${CE_SHEET_NAME}!A${rowNum}:P${rowNum}`,
        valueInputOption:'RAW',
        requestBody:     { values: vals },
      });
    });
    res.json({ ok: true });
  } catch (e) {
    if (e.isAuthError) return res.status(401).json({ error: 'unauthenticated' });
    console.error('[ColdEmail PUT]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/coldemail/:id', requireAuth, async (req, res) => {
  try {
    const rowNum = await withAuth(() => findCERow(req.params.id));
    if (!rowNum) return res.status(404).json({ error: 'not found' });
    if (ceSheetIdCache === null) await withAuth(() => ensureColdEmailSheet());
    await withAuth(async () => {
      await sheets().spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          requests: [{
            deleteDimension: {
              range: {
                sheetId:    ceSheetIdCache,
                dimension:  'ROWS',
                startIndex: rowNum - 1,
                endIndex:   rowNum,
              },
            },
          }],
        },
      });
    });
    ceRowMap.delete(req.params.id);
    ceRowMap.forEach((r, lid) => { if (r > rowNum) ceRowMap.set(lid, r - 1); });
    res.json({ ok: true });
  } catch (e) {
    if (e.isAuthError) return res.status(401).json({ error: 'unauthenticated' });
    console.error('[ColdEmail DELETE]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/coldemail/:id/promote', requireAuth, async (req, res) => {
  try {
    await withAuth(async () => {
      const ceResp = await sheets().spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range:         CE_COL_RANGE,
      });
      const ceRows = ceResp.data.values || [];
      let ceRowNum = null;
      let ceLead   = null;
      for (let i = 1; i < ceRows.length; i++) {
        if (ceRows[i][0] === req.params.id) {
          ceRowNum = i + 1;
          ceLead   = {};
          CE_COLUMNS.forEach((c, j) => { ceLead[c] = ceRows[i][j] || ''; });
          break;
        }
      }
      if (!ceLead) { res.status(404).json({ error: 'not found' }); return; }

      const parts = (ceLead.contactName || '').trim().split(/\s+/);
      const first = parts[0] || '';
      const last  = parts.slice(1).join(' ') || '';
      const newId = Date.now().toString(36) + Math.random().toString(36).slice(2);
      const leadsLead = {
        id: newId, type: 'trade', first, last, brokerage: '',
        tradeType: ceLead.tradeType || '', company: ceLead.company || '',
        city: ceLead.city || '', cityTrade: ceLead.city || '',
        phone: '', email: ceLead.email || '', website: ceLead.website || '',
        stage: 'new', priority: 'cold', followup: '',
        notes: ceLead.notes || '', created: String(Date.now()),
      };
      await sheets().spreadsheets.values.append({
        spreadsheetId:   SPREADSHEET_ID,
        range:           COL_RANGE,
        valueInputOption:'RAW',
        insertDataOption:'INSERT_ROWS',
        requestBody:     { values: [COLUMNS.map(col => String(leadsLead[col] ?? ''))] },
      });
      // Mark ColdEmail row stage = Promoted (col H)
      await sheets().spreadsheets.values.update({
        spreadsheetId:   SPREADSHEET_ID,
        range:           `${CE_SHEET_NAME}!H${ceRowNum}`,
        valueInputOption:'RAW',
        requestBody:     { values: [['Promoted']] },
      });
      ceRowMap.delete(req.params.id);
    });
    res.json({ ok: true });
  } catch (e) {
    if (e.isAuthError) return res.status(401).json({ error: 'unauthenticated' });
    console.error('[ColdEmail Promote]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── AGENT ROUTES ─────────────────────────────────────────────────────────────

app.post('/api/agent/run', requireAuth, (req, res) => {
  if (agentState.running) return res.status(409).json({ error: 'already running' });

  const dryRun = req.body.dryRun !== false; // default true
  agentState.running   = true;
  agentState.dryRun    = dryRun;
  agentState.startedAt = new Date().toISOString();
  agentState.log       = [];
  agentState.exitCode  = null;

  const child = spawn('node', ['outreach-agent.js'], {
    cwd: __dirname,
    env: { ...process.env, DRY_RUN: dryRun ? 'true' : 'false' },
  });
  agentChild = child;

  let outBuf = '', errBuf = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    outBuf += chunk;
    const lines = outBuf.split('\n');
    outBuf = lines.pop();
    lines.forEach(l => agentPushLine(l));
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    errBuf += chunk;
    const lines = errBuf.split('\n');
    errBuf = lines.pop();
    lines.filter(Boolean).forEach(l => agentPushLine('[stderr] ' + l));
  });

  child.on('exit', code => {
    if (outBuf) { agentPushLine(outBuf); outBuf = ''; }
    if (errBuf) { agentPushLine('[stderr] ' + errBuf); errBuf = ''; }
    agentState.running  = false;
    agentState.exitCode = code;
    agentChild = null;
  });

  res.json({ started: true, dryRun });
});

app.post('/api/agent/stop', requireAuth, (_req, res) => {
  if (agentChild) agentChild.kill('SIGTERM');
  res.json({ stopped: true });
});

app.get('/api/agent/status', requireAuth, (_req, res) => {
  res.json({
    running:   agentState.running,
    dryRun:    agentState.dryRun,
    startedAt: agentState.startedAt,
    log:       agentState.log,
    exitCode:  agentState.exitCode,
  });
});

app.listen(3000, () => console.log('ScaleLab Pipeline → http://localhost:3000'));
