require('dotenv').config();
const express    = require('express');
const { google } = require('googleapis');
const { spawn }  = require('child_process');
const path       = require('path');
const cron       = require('node-cron');
const crypto     = require('crypto');
// Junk classifier shared with check-leads.js (CLI) and outreach-agent.js —
// PLACEHOLDER / MALFORMED / THIRD_PARTY / BLANK / CLEAN. One source of truth.
const { classify: classifyLeadEmail } = require('./check-leads');

const app = express();
app.use(express.json({ limit: '10mb' }));

// ── PROPOSAL OPEN TRACKING (public — no auth) ─────────────────────────────────
const BOT_PATTERNS = /curl|wget|python|java|go-http|axios|node-fetch|spider|crawler|bot|preview|scan|mimecast|barracuda|proofpoint|cloudmark|symantec/i;

app.get('/p', (req, res) => {
  // String() guards against ?company=a&company=b, which Express parses as an array.
  const companyParam = String(req.query.company ?? '').trim();
  const company = companyParam || 'Unknown';
  const niche   = req.query.niche   || 'Unknown';
  const id      = req.query.id      || '';
  const ua      = req.headers['user-agent'] || '';

  // Forward the incoming query params (company, contact, niche, …) to the
  // proposal page so it renders personalized content instead of "your business".
  // 'id' is an internal tracking param only and is not forwarded.
  const proposalBase = process.env.PROPOSAL_URL || 'https://scalelabaireceptionistproposal.netlify.app';
  let dest = proposalBase;
  try {
    const url = new URL(proposalBase);
    const fwd = new URLSearchParams(req.query);
    fwd.delete('id');
    url.search = fwd.toString();
    dest = url.toString();
  } catch (e) {
    console.warn(`[/p] Could not build redirect params, using base URL: ${e.message}`);
  }

  const clientIp    = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip;
  const BLOCKED_IPS = ['75.155.151.158'];
  if (BLOCKED_IPS.includes(clientIp)) {
    console.log(`[/p] Skipping own IP: ${clientIp} — ${company}`);
    return res.redirect(302, dest);
  }

  if (BOT_PATTERNS.test(ua)) {
    console.warn(`[/p] Bot skipped — company: ${company}, ua: ${ua}`);
    return res.redirect(302, dest);
  }

  // An open with no resolvable company can never be matched back to a lead, so
  // it would only inflate the dashboard's Opens total. Redirect the visitor,
  // log the URL so stale links in circulation can be traced, but write nothing.
  if (!companyParam || companyParam.toLowerCase() === 'unknown') {
    console.warn(`[/p] No resolvable company — not logging open. url: ${req.originalUrl} ip: ${clientIp}`);
    return res.redirect(302, dest);
  }

  const row = [new Date().toISOString(), company, niche, id, clientIp, ua];

  sheets().spreadsheets.values.append({
    spreadsheetId:   SPREADSHEET_ID,
    range:           'ProposalOpens!A:F',
    valueInputOption:'RAW',
    insertDataOption:'INSERT_ROWS',
    requestBody:     { values: [row] },
  }).catch(e => console.error('[/p] Sheet write failed:', e.message));

  res.redirect(302, dest);
});

// Verbatim copy of cleanCompanyName() from outreach-agent.js (cuts at the
// first " - " or "|"). MUST stay in sync: the old query-param links carried
// the CLEANED name, so the token route must log and forward the same value or
// open-tracking attribution and the page's displayed name would change.
function cleanCompanyName(raw) {
  if (!raw) return '';
  const pipIdx  = raw.indexOf('|');
  const dashIdx = raw.indexOf(' - ');
  let cutAt = raw.length;
  if (pipIdx  !== -1) cutAt = Math.min(cutAt, pipIdx);
  if (dashIdx !== -1) cutAt = Math.min(cutAt, dashIdx);
  return raw.slice(0, cutAt).trim() || raw.trim();
}

// Token used in short proposal links: sha1(lead id), first 10 hex chars.
// MUST stay in sync with proposalToken() in outreach-agent.js.
const proposalToken = id => crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 10);

// Token-style proposal links: /p/<token> (additive — the query-param route
// above keeps serving links already in circulation). Resolves the token to the
// lead by hashing column A, logs the open with the SAME cleaned company the
// old links carried (attribution preserved), then 302s to the Netlify page
// with identical query params — the page itself is untouched.
//
// FALLBACK: an unresolvable token (unknown, sheet error, lead deleted) must
// never show the prospect an error page — it degrades to the bare proposal
// page and logs the failure.
app.get('/p/:token', async (req, res) => {
  const token    = String(req.params.token || '').trim();
  const ua       = req.headers['user-agent'] || '';
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip;
  const BLOCKED_IPS  = ['75.155.151.158'];
  const proposalBase = process.env.PROPOSAL_URL || 'https://scalelabaireceptionistproposal.netlify.app';

  let dest = proposalBase;   // bare page — the guaranteed-safe landing
  let lead = null;

  try {
    const resp = await sheets().spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range:         `${CE_SHEET_NAME}!A:F`,   // A=id B=company C=contactName F=tradeType
    });
    const rows = (resp.data.values || []).slice(1);
    const hit  = rows.find(r => r[0] && proposalToken(r[0]) === token);
    if (hit) {
      lead = { id: hit[0], company: cleanCompanyName(hit[1] || ''), contactName: hit[2] || '', tradeType: hit[5] || '' };
      const url = new URL(proposalBase);
      const fwd = new URLSearchParams();
      if (lead.company)     fwd.set('company', lead.company);
      if (lead.contactName) fwd.set('contact', lead.contactName);
      if (lead.tradeType)   fwd.set('niche',   lead.tradeType);
      url.search = fwd.toString();
      dest = url.toString();
    } else {
      console.warn(`[/p/:token] Unknown token "${token}" — redirecting to bare page. ip: ${clientIp}`);
    }
  } catch (e) {
    console.warn(`[/p/:token] Resolution failed for "${token}": ${e.message} — redirecting to bare page.`);
  }

  if (!lead) return res.redirect(302, dest);

  if (BLOCKED_IPS.includes(clientIp)) {
    console.log(`[/p/:token] Skipping own IP: ${clientIp} — ${lead.company}`);
    return res.redirect(302, dest);
  }
  if (BOT_PATTERNS.test(ua)) {
    console.warn(`[/p/:token] Bot skipped — company: ${lead.company}, ua: ${ua}`);
    return res.redirect(302, dest);
  }

  const row = [new Date().toISOString(), lead.company, lead.tradeType || 'Unknown', lead.id, clientIp, ua];
  sheets().spreadsheets.values.append({
    spreadsheetId:   SPREADSHEET_ID,
    range:           'ProposalOpens!A:F',
    valueInputOption:'RAW',
    insertDataOption:'INSERT_ROWS',
    requestBody:     { values: [row] },
  }).catch(e => console.error('[/p/:token] Sheet write failed:', e.message));

  res.redirect(302, dest);
});

// ── DEMO PLAY TRACKING (public — no auth) ──────────────────────────────────────
// Fired as a tracking pixel from the proposal page when the demo audio actually
// plays — a stronger intent signal than an open. Deliberately writes to its OWN
// tab (DemoPlays), NOT ProposalOpens: that sheet feeds getOpenTriggeredLeads()
// and the warm-follow-up trigger, and mixing a second event type into it would
// risk a demo play being counted as an open and firing a warm send on a false
// signal. Same guard shape as /p (IP block, bot UA, empty/Unknown company) —
// bot/self-traffic matters even more here since this is meant to be high-intent.
app.get('/demo-played', (req, res) => {
  const companyParam = String(req.query.company ?? '').trim();
  const company = companyParam || 'Unknown';
  const niche   = req.query.niche || 'Unknown';
  const ua      = req.headers['user-agent'] || '';
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip;

  // Always a no-op pixel response — nothing renders, nothing for the page to
  // read, so there's no failure mode visible to the visitor either way.
  const sendPixel = () => res.status(204).end();

  const BLOCKED_IPS = ['75.155.151.158'];
  if (BLOCKED_IPS.includes(clientIp)) {
    console.log(`[/demo-played] Skipping own IP: ${clientIp} — ${company}`);
    return sendPixel();
  }

  if (BOT_PATTERNS.test(ua)) {
    console.warn(`[/demo-played] Bot skipped — company: ${company}, ua: ${ua}`);
    return sendPixel();
  }

  if (!companyParam || companyParam.toLowerCase() === 'unknown') {
    console.warn(`[/demo-played] No resolvable company — not logging. url: ${req.originalUrl} ip: ${clientIp}`);
    return sendPixel();
  }

  const row = [new Date().toISOString(), company, niche, clientIp, ua];

  sheets().spreadsheets.values.append({
    spreadsheetId:   SPREADSHEET_ID,
    range:           'DemoPlays!A:E',
    valueInputOption:'RAW',
    insertDataOption:'INSERT_ROWS',
    requestBody:     { values: [row] },
  }).catch(e => console.error('[/demo-played] Sheet write failed:', e.message));

  sendPixel();
});

// ── HOT-LEAD ENGAGEMENT TRACKING (public — no auth) ────────────────────────────
// Fired as a tracking pixel from the proposal page when a visitor hits 100%
// scroll OR 120s of active time — whichever comes first, and only once (the
// page enforces the once-per-view rule; this route just records what it's told).
// Writes to its OWN tab (ProposalEngaged), NOT ProposalOpens or DemoPlays: those
// feed getOpenTriggeredLeads() and the warm-follow-up trigger, and mixing a
// third event type into either would risk a false warm-send trigger. Same guard
// shape as /p and /demo-played (IP block, bot UA, empty/Unknown company).
app.get('/engaged', (req, res) => {
  const companyParam = String(req.query.company ?? '').trim();
  const company = companyParam || 'Unknown';
  const niche   = req.query.niche  || 'Unknown';
  const signal  = req.query.signal || 'unknown';
  const ua      = req.headers['user-agent'] || '';
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip;

  const sendPixel = () => res.status(204).end();

  const BLOCKED_IPS = ['75.155.151.158'];
  if (BLOCKED_IPS.includes(clientIp)) {
    console.log(`[/engaged] Skipping own IP: ${clientIp} — ${company}`);
    return sendPixel();
  }

  if (BOT_PATTERNS.test(ua)) {
    console.warn(`[/engaged] Bot skipped — company: ${company}, ua: ${ua}`);
    return sendPixel();
  }

  if (!companyParam || companyParam.toLowerCase() === 'unknown') {
    console.warn(`[/engaged] No resolvable company — not logging. url: ${req.originalUrl} ip: ${clientIp}`);
    return sendPixel();
  }

  const row = [new Date().toISOString(), company, niche, signal, clientIp, ua];

  sheets().spreadsheets.values.append({
    spreadsheetId:   SPREADSHEET_ID,
    range:           'ProposalEngaged!A:F',
    valueInputOption:'RAW',
    insertDataOption:'INSERT_ROWS',
    requestBody:     { values: [row] },
  }).catch(e => console.error('[/engaged] Sheet write failed:', e.message));

  sendPixel();
});

// ── DASHBOARD ACCESS CONTROL ──────────────────────────────────────────────────
// HTTP Basic Auth applied globally — covers static files and all API routes.
// Set DASHBOARD_USER and DASHBOARD_PASSWORD in .env / Railway env vars.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const b64    = header.startsWith('Basic ') ? header.slice(6) : '';
  const [user, pass] = Buffer.from(b64, 'base64').toString().split(':');
  if (user === process.env.DASHBOARD_USER && pass === process.env.DASHBOARD_PASSWORD) {
    return next();
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="ScaleLab Pipeline"');
  res.status(401).send('Unauthorized');
}
app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

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
  'campaign','campaign_notes',                                        // Q R
  'enrichment_attempted',                                             // S
];
const CE_COL_RANGE  = `${CE_SHEET_NAME}!A:S`;

// ── SERVICE ACCOUNT AUTH ──────────────────────────────────────────────────────
// Credentials are read from an env var (JSON string) — no key file on disk.
// GoogleAuth mints and auto-refreshes access tokens internally.

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

function sheets() {
  return google.sheets({ version: 'v4', auth });
}

// Compatibility shim — call sites are unchanged; token management is now internal.
const withAuth = fn => fn();

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

// Shared launcher for the outreach-agent subprocess. extraEnv overrides the
// agent's mode (DRY_RUN / CHECK_ONLY). All three triggers — UI, the 4-hour send
// cron and the 30-minute check-only cron — funnel through here and share
// agentState, so agentState.running is a single mutual-exclusion flag across all.
function startAgentProcess(extraEnv, dryRun) {
  agentState.running   = true;
  agentState.dryRun    = dryRun;
  agentState.startedAt = new Date().toISOString();
  agentState.log       = [];
  agentState.exitCode  = null;

  const child = spawn('node', ['outreach-agent.js'], {
    cwd: __dirname,
    env: { ...process.env, ...extraEnv },
  });
  agentChild = child;

  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);

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
}

function spawnAgent(dryRun) {
  startAgentProcess({ DRY_RUN: dryRun ? 'true' : 'false' }, dryRun);
}

// Check-only pass: real sheet writes (reply/bounce detection), no sends.
// Guards on agentState.running so it never spawns a second concurrent process
// while a full run is already going.
function spawnAgentCheckOnly() {
  if (agentState.running) {
    console.log('[cron] Agent already running — skipping check-only pass this tick');
    return;
  }
  startAgentProcess({ DRY_RUN: 'false', CHECK_ONLY: 'true' }, false);
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
      range:         `${CE_SHEET_NAME}!A1:S1`,
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

app.get('/api/proposalOpens', requireAuth, async (_req, res) => {
  try {
    const resp = await sheets().spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'ProposalOpens!A:F',
    });
    const rows = resp.data.values || [];
    res.json(rows.slice(1).map(row => ({
      timestamp: row[0] || '',
      company:   row[1] || '',
      niche:     row[2] || '',
      id:        row[3] || '',
      ip:        row[4] || '',
      userAgent: row[5] || '',
    })));
  } catch (e) {
    console.error('[ProposalOpens GET]', e.message);
    res.json([]);
  }
});

app.post('/api/coldemail/import', requireAuth, async (req, res) => {
  const { rows, campaign, campaign_notes } = req.body || {};
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'body.rows must be an array' });
  if (!campaign) console.warn('[ColdEmail Import] No campaign name provided — defaulting to "unlabeled"');
  const campaignName  = (campaign || 'unlabeled').trim();
  const campaignNotes = (campaign_notes || '').trim();
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
      let duplicates = 0;
      let invalid    = 0;
      let junk       = 0;
      for (const row of rows) {
        const email = (row.email || '').toLowerCase().trim();
        if (!email) { invalid++; continue; }
        // Junk choke point: placeholder dummies, phone-bleed addresses and
        // third-party tracking domains are rejected at the door — they either
        // guarantee a bounce or deliver to the wrong company entirely.
        const verdict = classifyLeadEmail(email);
        if (verdict !== 'CLEAN') {
          junk++;
          console.warn(`[ColdEmail Import] rejected ${verdict}: ${email} (${row.company || '—'})`);
          continue;
        }
        if (existingEmails.has(email)) { duplicates++; continue; }
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
          campaign: campaignName, campaign_notes: campaignNotes,
          enrichment_attempted: '',   // never attempted — enrich-names.js will pick these up
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
      return { imported: toAdd.length, duplicates, invalid, junk };
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
  // Same choke point as the CSV import: validate format and reject junk,
  // then dedupe against the sheet — this path previously had neither, so a
  // manual add could create a second sendable row for an existing address.
  const email = (lead.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'email required' });
  const verdict = classifyLeadEmail(email);
  if (verdict !== 'CLEAN') {
    return res.status(400).json({ error: `email rejected as ${verdict}` });
  }
  const vals = [CE_COLUMNS.map(col => lead[col] !== undefined ? String(lead[col]) : '')];
  try {
    await withAuth(async () => {
      const existing = await sheets().spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range:         `${CE_SHEET_NAME}!D:D`,   // email column
      });
      const dupe = (existing.data.values || []).slice(1)
        .some(r => (r[0] || '').toLowerCase().trim() === email);
      if (dupe) {
        const err = new Error('a lead with this email already exists');
        err.isDuplicate = true;
        throw err;
      }
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
    if (e.isDuplicate) return res.status(409).json({ error: e.message });
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
        range:           `${CE_SHEET_NAME}!A${rowNum}:S${rowNum}`,
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
  spawnAgent(dryRun);
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

app.post('/api/enrich/names', requireAuth, (_req, res) => {
  const child = spawn('node', ['enrich-names.js'], {
    cwd: __dirname,
    env: { ...process.env, DRY_RUN: 'false' },
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  res.json({ started: true });
});

if (process.env.RAILWAY_ENVIRONMENT) {
  cron.schedule('0 */4 * * *', () => {
    console.log('[cron] Triggering scheduled outreach agent run...');
    if (agentState.running) {
      console.log('[cron] Agent already running — skipping this tick');
      return;
    }
    spawnAgent(false);
  }, {
    timezone: 'America/Vancouver',
  });
  console.log('[cron] Outreach agent scheduled: every 4 hours (Vancouver time)');

  // :15/:45, never :00 — the old */30 fired on the 4-hour boundary six times a
  // day, racing the full-send cron for the agentState.running guard; whichever
  // lost was silently skipped that tick (a check-only win cost a whole send
  // window). Offset schedules cannot collide.
  cron.schedule('15,45 * * * *', () => {
    console.log('[cron] Running check-only pass...');
    spawnAgentCheckOnly();
  }, {
    timezone: 'America/Vancouver',
  });
  console.log('[cron] Check-only pass scheduled: :15 and :45 every hour');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ScaleLab Pipeline → http://localhost:${PORT}`));
