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
// Scanner-detonation filtering for ProposalOpens, shared verbatim with
// outreach-agent.js's warm-follow-up gating — one definition, no drift.
const { annotateOpens } = require('./open-filter');
const { SmartleadClient } = require('./integrations/smartlead-client');
const { SmartleadOutreachProvider } = require('./integrations/outreach-providers');
const { verifySignature, verifySharedSecret, normalizeEvent } = require('./integrations/smartlead-events');
const { leadEligibility } = require('./integrations/outreach-policy');
const { buildEventKey, buildMappingKey, mappingMatchesEvent, normalizeEmail, canApplyProviderTransition, safeAuditPayload, executeEventAttempt, KeyedLock, fetchAllCampaignLeads, aggregateProviderStats, reconciliationHealth } = require('./integrations/smartlead-safety');
const { classifyReply: classifyProviderReply, CLASSIFICATION_TO_STATUS } = require('./integrations/reply-classifier');
const { parseRegistry: parseGmailInboxRegistry, publicRegistry: publicGmailInboxRegistry, verifyInbox: verifyGmailInbox } = require('./integrations/gmail-inbox-registry');

const app = express();
// Smartlead signs the exact request bytes. This public route must be registered
// before the global JSON parser and dashboard authentication middleware.
app.post('/api/webhooks/smartlead', express.raw({ type: 'application/json', limit: '1mb' }), handleSmartleadWebhook);
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
// first occurrence of any separator below). MUST stay in sync: the old
// query-param links carried the CLEANED name, so the token route must log and
// forward the same value or open-tracking attribution and the page's
// displayed name would change.
function cleanCompanyName(raw) {
  if (!raw) return '';
  const SEPARATORS = [
    '|',
    ' - ',
    ' • ', // •  bullet
    ' · ', // ·  middle dot
    ' – ', // –  en dash
    ' — ', // —  em dash
  ];
  let cutAt = raw.length;
  for (const sep of SEPARATORS) {
    const idx = raw.indexOf(sep);
    if (idx !== -1) cutAt = Math.min(cutAt, idx);
  }
  return raw.slice(0, cutAt).trim() || raw.trim();
}

// Which clip a DemoPlays row represents. Mirrors the /demo-played write-side
// whitelist exactly — lowercase, only 'intro' or 'demo' accepted, anything else
// (including a BLANK column F on rows written before the intro shipped, which
// were all receptionist-demo plays) resolves to 'demo'. Kept here rather than
// inlined so read and write can never disagree about what a row means.
function normalizeAudioType(raw) {
  const t = String(raw == null ? '' : raw).trim().toLowerCase();
  return (t === 'intro' || t === 'demo') ? t : 'demo';
}

// Canonical company key for matching a ProposalOpens row to its lead. Mirrors
// ceCompanyKey() in public/index.html: clean the name, lowercase, strip
// non-alphanumerics. Used only for the open-filter lookups below.
function openKey(company) {
  return cleanCompanyName(company || '').toLowerCase().trim().replace(/[^a-z0-9]/g, '');
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

  // Which clip was played. The proposal page now renders a short spoken intro
  // next to the receptionist demo on dental pages, and both fire this pixel —
  // without this column the sheet cannot tell "heard the 14s hello" from "heard
  // the receptionist", which is the signal that actually drives follow-up.
  //
  // Whitelisted, not passed through: this lands in a spreadsheet cell, so an
  // arbitrary query string must never reach it. Anything unrecognised — and
  // notably any pixel from an older cached page that sends no audio_type at
  // all — falls back to 'demo', which is exactly what those pixels meant.
  const rawType   = String(req.query.audio_type ?? '').trim().toLowerCase();
  const audioType = (rawType === 'intro' || rawType === 'demo') ? rawType : 'demo';

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

  // audio_type is APPENDED as column F, never inserted mid-row: existing rows
  // already have clientIp in D and ua in E, and shifting them would silently
  // re-label historical data. Rows written before this change have F blank and
  // were all receptionist-demo plays, so treat blank as 'demo' when filtering.
  const row = [new Date().toISOString(), company, niche, clientIp, ua, audioType];

  sheets().spreadsheets.values.append({
    spreadsheetId:   SPREADSHEET_ID,
    range:           'DemoPlays!A:F',
    valueInputOption:'RAW',
    insertDataOption:'INSERT_ROWS',
    requestBody:     { values: [row] },
  })
    // Event-driven intent trigger: if THIS play just completed an intro+demo
    // pair for this company, fire the follow-up now rather than waiting for the
    // cron. Chained after the append so the pass sees the row it is reacting to.
    .then(() => maybeFireIntent(company))
    .catch(e => console.error('[/demo-played] Sheet write failed:', e.message));

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

// ── GLOBAL SUPPRESSION LIST ───────────────────────────────────────────────────
// Durable, email-keyed opt-out record shared with outreach-agent.js. Checked at
// import (below) so a suppressed address can never re-enter ColdEmail via a
// re-scrape/re-import even if its original row was deleted. Written here on a
// manual dashboard unsubscribe, and by the agent on auto unsubscribe/bounce.
const SUPPRESSION_SHEET  = 'Suppression';
const SUPPRESSION_HEADER = ['email','reason','company','suppressedAt','source'];

// Additive Smartlead persistence. Google Sheets is the application's existing
// database, so these tabs are its backward-compatible/reversible migration.
const CAMPAIGN_INTEGRATIONS_SHEET = 'CampaignIntegrations';
const CAMPAIGN_INTEGRATIONS_HEADER = ['internalCampaignId','provider','externalCampaignId','externalCampaignName','syncStatus','lastSynchronizedAt','sendingPool','fieldMappings','updatedAt'];
const PROVIDER_LEADS_SHEET = 'ProviderLeadMappings';
const PROVIDER_LEADS_HEADER = ['internalLeadId','provider','externalLeadId','externalCampaignId','mappingId','normalizedStatus','rawStatus','lastProviderEventAt','lastSynchronizedAt','unsubscribedAt','complianceNote','metadata','mappingKey','normalizedEmail'];
const PROVIDER_EVENTS_SHEET = 'ProviderEvents';
const PROVIDER_EVENTS_HEADER = ['eventId','provider','requestId','eventType','internalCampaignId','internalLeadId','externalCampaignId','externalLeadId','receivedAt','processedAt','processingStatus','payload','error','eventKey','attemptCount','lastAttemptAt'];
const INTEGRATION_HEALTH_SHEET = 'IntegrationHealth';
const INTEGRATION_HEALTH_HEADER = ['provider','lastSuccessfulApiCall','lastReceivedWebhook','lastSuccessfulReconciliation','failedEventCount','lastError','updatedAt','lastReconciliationAttempt','lastPartialReconciliation','campaignsAttempted','campaignsSuccessful','campaignsFailed','campaignErrorSummary'];
const PROVIDER_STATS_SHEET = 'ProviderCampaignStats';
const PROVIDER_STATS_HEADER = ['internalCampaignId','provider','externalCampaignId','totalLeads','scheduled','sent','replied','interested','unsubscribed','bounced','meetings','problems','replyRate','interestedRate','lastSynchronizedAt'];

const smartleadClient = new SmartleadClient();
const smartleadProvider = new SmartleadOutreachProvider({ client: smartleadClient });
const webhookLocks = new KeyedLock();

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

async function ensureIntegrationSheet(title, header) {
  const s = sheets();
  const ss = await s.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  if (!ss.data.sheets.find(sh => sh.properties.title === title)) {
    await s.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { requests: [{ addSheet: { properties: { title } } }] } });
    await s.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${title}!A1`, valueInputOption: 'RAW', requestBody: { values: [header] } });
  } else {
    const current = await s.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${title}!1:1` });
    const existing = current.data.values?.[0] || [];
    const extended = [...existing];
    for (const field of header) if (!extended.includes(field)) extended.push(field);
    if (extended.length !== existing.length) await s.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${title}!A1`, valueInputOption: 'RAW', requestBody: { values: [extended] } });
  }
}

function sheetColumn(number) {
  let result = '', n = number;
  while (n > 0) { n--; result = String.fromCharCode(65 + (n % 26)) + result; n = Math.floor(n / 26); }
  return result;
}

async function readIntegrationRows(title, header) {
  await ensureIntegrationSheet(title, header);
  const response = await sheets().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${title}!A:${sheetColumn(header.length)}` });
  return (response.data.values || []).slice(1).map((row, index) => ({
    ...Object.fromEntries(header.map((key, i) => [key, row[i] || ''])),
    _row: index + 2,
  }));
}

async function appendIntegrationRow(title, header, record) {
  await ensureIntegrationSheet(title, header);
  await sheets().spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: `${title}!A:${sheetColumn(header.length)}`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: [header.map(key => String(record[key] ?? ''))] } });
}

async function upsertIntegrationRow(title, header, key, record) {
  const rows = await readIntegrationRows(title, header);
  const found = rows.find(row => row[key] === String(record[key]));
  const values = [header.map(field => String(record[field] ?? found?.[field] ?? ''))];
  if (found) {
    await sheets().spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${title}!A${found._row}:${sheetColumn(header.length)}${found._row}`, valueInputOption: 'RAW', requestBody: { values } });
  } else {
    await sheets().spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: `${title}!A:${sheetColumn(header.length)}`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values } });
  }
}

async function updateIntegrationHealth(patch) {
  const now = new Date().toISOString();
  await upsertIntegrationRow(INTEGRATION_HEALTH_SHEET, INTEGRATION_HEALTH_HEADER, 'provider', { provider: 'smartlead', ...patch, updatedAt: now });
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

// Shared launcher for the outreach-agent subprocess. extraEnv overrides the
// agent's mode (DRY_RUN / CHECK_ONLY) and per-run knobs (DAILY_CAP). All three
// triggers — UI, the morning send cron and the :15/:45 check-only cron — funnel
// through here and share agentState, so agentState.running is a single
// mutual-exclusion flag across all.
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

function spawnAgent(dryRun, extraEnv = {}) {
  startAgentProcess({ DRY_RUN: dryRun ? 'true' : 'false', ...extraEnv }, dryRun);
}

// Check-only pass: real sheet writes (reply/bounce detection), no sends.
// Guards on agentState.running so it never spawns a second concurrent process
// while a full run is already going.
// Fires the both-audios intent pass. Spawned on demand when a demo play
// completes a pair, and by a safety cron. Cheap: the agent's INTENT_ONLY mode
// skips reply/bounce detection and all outreach.
// Does this company now have BOTH a real intro play and a real demo play?
// Cheap read of DemoPlays only — the agent re-derives everything authoritatively
// and owns the fired-state check, so a false positive here costs one no-op
// spawn, never a duplicate email.
async function companyHasBothAudios(company) {
  const key = openKey(company);
  if (!key) return false;
  const r = await sheets().spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID, range: 'DemoPlays!A:F',
  });
  let intro = false, demo = false;
  for (const row of (r.data.values || []).slice(1)) {
    if (openKey(row[1] || '') !== key) continue;
    const ip = (row[3] || '').trim();
    if (['75.155.151.158'].includes(ip)) continue;      // own IP
    if (BOT_PATTERNS.test(row[4] || '')) continue;      // bot UA
    if (normalizeAudioType(row[5]) === 'intro') intro = true; else demo = true;
  }
  return intro && demo;
}

async function maybeFireIntent(company) {
  try {
    if (await companyHasBothAudios(company)) {
      spawnAgentIntentOnly(`both audios played — ${company}`);
    }
  } catch (e) {
    // Never let intent detection break the tracking pixel; the cron backstop
    // will catch this play on its next tick.
    console.warn('[intent] pair check failed:', e.message);
  }
}

function spawnAgentIntentOnly(why) {
  if (agentState.running) {
    console.log(`[intent] agent busy — skipping intent spawn (${why}); the cron backstop will retry`);
    return;
  }
  console.log(`[intent] spawning intent-only pass (${why})`);
  startAgentProcess({ DRY_RUN: 'false', INTENT_ONLY: 'true' }, false);
}

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

// Resolve a lead id to its sheet row, CONFIRMING the cached row still holds
// that id before trusting it.
//
// rowMap is a long-lived in-memory cache rebuilt only on GET /api/leads. A cache
// HIT previously returned without re-checking, so any structural edit made to
// the sheet directly — inserting, deleting or sorting rows — left every cached
// row number below the edit pointing at the wrong lead. Callers then acted on
// that number: PUT overwrites the whole A:Q row (silently clobbering a different
// lead and returning 200), and DELETE removes the row outright (deleting the
// wrong lead). Both reported success.
//
// The probe is a single cell, so the guard costs far less than the full-sheet
// rescan it prevents, and it only runs on the write paths.
async function findRow(id) {
  const cached = rowMap.get(id);
  if (cached) {
    // The probe itself can fail — a cached row past the sheet's current grid
    // limits (many rows deleted) makes Sheets reject the range outright. That
    // is still just a stale cache, so treat ANY probe failure as a miss and
    // rebuild rather than surfacing a 500 on the write.
    let stillMine = false;
    try {
      const probe = await sheets().spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range:         `${SHEET_NAME}!A${cached}`,
      });
      stillMine = (probe.data.values?.[0]?.[0] || '') === id;
    } catch (e) {
      console.warn(`[findRow] row probe failed for ${id} at row ${cached} (${e.message}) — treating as stale`);
    }
    if (stillMine) return cached;
    console.warn(`[findRow] stale row cache: ${id} was row ${cached} — rebuilding`);
    rowMap.clear();
  }
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

// Same stale-cache guard as findRow() above — ceRowMap has the identical
// exposure, and its callers are likewise a full-row PUT (A:S) and a DELETE.
async function findCERow(id) {
  const cached = ceRowMap.get(id);
  if (cached) {
    let stillMine = false;
    try {
      const probe = await sheets().spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range:         `${CE_SHEET_NAME}!A${cached}`,
      });
      stillMine = (probe.data.values?.[0]?.[0] || '') === id;
    } catch (e) {
      console.warn(`[findCERow] row probe failed for ${id} at row ${cached} (${e.message}) — treating as stale`);
    }
    if (stillMine) return cached;
    console.warn(`[findCERow] stale row cache: ${id} was row ${cached} — rebuilding`);
    ceRowMap.clear();
  }
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

// The DemoPlays header was written before audio_type existed, so it still reads
// 5 columns while rows write 6. Positional data is already correct — this only
// labels column F. Writes A1:F1 exclusively, so no row data can shift. Guarded
// by a module flag: repaired at most once per process, never on every request.
let demoPlaysHeaderChecked = false;
async function ensureDemoPlaysHeader() {
  if (demoPlaysHeaderChecked) return;
  demoPlaysHeaderChecked = true;   // set first: a failure must not retry-loop
  try {
    const hdr = await sheets().spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID, range: 'DemoPlays!A1:F1',
    });
    const row = (hdr.data.values || [])[0] || [];
    if (row.length >= 6 && String(row[5]).trim()) return;   // already labelled
    await sheets().spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID, range: 'DemoPlays!A1:F1',
      valueInputOption: 'RAW',
      requestBody: { values: [['timestamp', 'company', 'niche', 'ip', 'ua', 'audio_type']] },
    });
    console.log('[DemoPlays] header extended to include audio_type (column F)');
  } catch (e) {
    console.warn('[DemoPlays] header check failed:', e.message);
  }
}

// ── DAILY DIGEST ──────────────────────────────────────────────────────────────
// One summary card per day, rendered on the dashboard (not SMS, not email).
// Generated at 18:00 America/Vancouver and cached in its own tab so it is
// idempotent: asking twice on the same day returns the same stored row.
const DIGEST_SHEET  = 'DailyDigest';
const DIGEST_HEADER = ['date','generatedAt','payload'];

// Every date comparison in the digest uses the Vancouver calendar day, not UTC,
// or an evening event would land in tomorrow's summary.
const vanDay = (d = new Date()) =>
  new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });

async function ensureDigestSheet() {
  const s  = sheets();
  const ss = await s.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  if (ss.data.sheets.find(sh => sh.properties.title === DIGEST_SHEET)) return;
  await s.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: DIGEST_SHEET } } }] },
  });
  await s.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID, range: `${DIGEST_SHEET}!A1`,
    valueInputOption: 'RAW', requestBody: { values: [DIGEST_HEADER] },
  });
}

// Computes today's numbers from the source tabs. Read-only.
async function computeDigest(day) {
  const [ceR, opR, dpR, drR, inR] = await Promise.all([
    sheets().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${CE_SHEET_NAME}!A:S` }),
    sheets().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'ProposalOpens!A:F' }),
    sheets().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'DemoPlays!A:F' }),
    sheets().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'ReplyDrafts!A:I' }).catch(() => ({ data: {} })),
    sheets().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'IntentFired!A:E' }).catch(() => ({ data: {} })),
  ]);

  const leadRows = (ceR.data.values || []).slice(1).filter(r => r[0]);
  const isToday  = ts => { try { return ts && vanDay(new Date(ts)) === day; } catch (_e) { return false; } };

  // ── emails sent today (lastEmailedAt lands on every send path) ──
  const emailsSent = leadRows.filter(r => isToday(r[9])).length;

  // ── real opens today: the shared scanner filter, not raw rows ──
  const opens = (opR.data.values || []).slice(1).map(r => ({
    timestamp: r[0] || '', company: r[1] || '', id: r[3] || '', ip: r[4] || '',
  }));
  const leadById  = new Map(leadRows.map(r => [r[0], { lastEmailedAt: r[9] || '' }]));
  const leadByKey = new Map();
  for (const r of leadRows) { const k = openKey(r[1]); if (k && !leadByKey.has(k)) leadByKey.set(k, { lastEmailedAt: r[9] || '' }); }
  const annotatedOpens = annotateOpens({
    opens, keyOf: row => openKey(row.company),
    leadFor: row => (row.id && leadById.get(row.id)) || leadByKey.get(openKey(row.company)) || null,
  });
  const todaysRealOpens = annotatedOpens.filter(o => o.real && isToday(o.timestamp));
  const realOpens = { rows: todaysRealOpens.length, companies: new Set(todaysRealOpens.map(o => o.key).filter(Boolean)).size };

  // ── demo plays today, split by clip, plus how many companies now hold a pair ──
  const playsToday = (dpR.data.values || []).slice(1).filter(r => isToday(r[0]));
  const introToday = playsToday.filter(r => normalizeAudioType(r[5]) === 'intro').length;
  const demoToday  = playsToday.filter(r => normalizeAudioType(r[5]) !== 'intro').length;
  const pairKeys = new Map();
  for (const r of (dpR.data.values || []).slice(1)) {
    const k = openKey(r[1] || ''); if (!k) continue;
    const e = pairKeys.get(k) || { intro: false, demo: false };
    if (normalizeAudioType(r[5]) === 'intro') e.intro = true; else e.demo = true;
    pairKeys.set(k, e);
  }
  const bothPairs = [...pairKeys.values()].filter(v => v.intro && v.demo).length;

  // ── replies today, by Haiku classification (read off the notes tags) ──
  const TAGS = [
    ['Question',       /\[REPLY: Question/],
    ['Interested',     /\[REPLY: Interested\]/],
    ['Not Interested', /\[REPLY: Not Interested\]/],
    ['Unsubscribed',   /\[REPLY: Unsubscribed\]/],
    ['Wrong Person',   /\[REPLY: Wrong Person/],
    ['OOO',            /\[REPLY: OOO/],
    ['Needs Human',    /\[REPLY: Needs Human|\[NEEDS REVIEW/],
  ];
  const repliedToday = leadRows.filter(r => isToday(r[9]) && /\[REPLY:/.test(r[11] || ''));
  const replyBreakdown = {};
  for (const [label, re] of TAGS) {
    const n = repliedToday.filter(r => re.test(r[11] || '')).length;
    if (n) replyBreakdown[label] = n;
  }

  // ── auto-answers vs drafts ──
  const autoAnswered = leadRows.filter(r => isToday(r[9]) && /auto-answered/.test(r[11] || '')).length;
  const draftRows = (drR.data.values || []).slice(1);
  const draftsToday   = draftRows.filter(r => isToday(r[0])).length;
  const draftsPending = draftRows.filter(r => (r[8] || 'pending').toLowerCase() === 'pending').length;

  // ── booking links sent, by trigger ──
  const intentRows = (inR.data.values || []).slice(1);
  const bookingByTrigger = {
    'question reply': autoAnswered,
    'both audios':    intentRows.filter(r => isToday(r[0])).length,
  };

  return {
    date: day,
    generatedAt: new Date().toISOString(),
    emailsSent,
    realOpens,
    demoPlays: { intro: introToday, demo: demoToday, total: playsToday.length, companiesWithBothPairs: bothPairs },
    replies: { total: repliedToday.length, breakdown: replyBreakdown },
    answers: { autoSent: autoAnswered, draftsCreated: draftsToday, draftsPending },
    bookingLinksSent: { total: Object.values(bookingByTrigger).reduce((a, b) => a + b, 0), byTrigger: bookingByTrigger },
  };
}

// Idempotent: returns the stored digest for the day if one exists, otherwise
// computes and stores it. `force` recomputes but still overwrites in place, so
// there is never more than one row per date.
async function getOrCreateDigest(day, { force = false } = {}) {
  await ensureDigestSheet();
  const existing = await sheets().spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID, range: `${DIGEST_SHEET}!A:C`,
  });
  const rows = existing.data.values || [];
  const idx  = rows.findIndex((r, i) => i > 0 && r[0] === day);

  if (idx !== -1 && !force) {
    try { return JSON.parse(rows[idx][2]); } catch (_e) { /* corrupt row — recompute below */ }
  }

  const digest  = await computeDigest(day);
  const payload = [[digest.date, digest.generatedAt, JSON.stringify(digest)]];

  if (idx !== -1) {
    await sheets().spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID, range: `${DIGEST_SHEET}!A${idx + 1}:C${idx + 1}`,
      valueInputOption: 'RAW', requestBody: { values: payload },
    });
  } else {
    const before = rows.length;
    await sheets().spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID, range: `${DIGEST_SHEET}!A:C`,
      valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: payload },
    });
    const after = await sheets().spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID, range: `${DIGEST_SHEET}!A:A`,
    });
    const added = (after.data.values || []).length - before;
    if (added !== 1) console.warn(`[Digest] expected 1 new row, saw ${added}`);
  }
  return digest;
}

app.get('/api/digest', requireAuth, async (req, res) => {
  try {
    const day = String(req.query.date || '').trim() || vanDay();
    const digest = await withAuth(() => getOrCreateDigest(day, { force: req.query.force === 'true' }));
    res.json(digest);
  } catch (e) {
    console.error('[Digest GET]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Serves the DemoPlays log, same shape as /api/proposalOpens plus the
// normalized audioType per row.
//
// NOTE: the opens scanner filter is deliberately NOT applied here. A play event
// requires someone to press play on an audio element — mail scanners fetch
// links, they don't do that — and the live log confirms it: 0 of 20 demo plays
// came from a datacenter IP. Running the opens filter over this data could only
// discard real signal. The write-side guards (blocked IP / bot UA / empty
// company) already ran in /demo-played, so a logged row is trustworthy.
app.get('/api/demoPlays', requireAuth, async (_req, res) => {
  try {
    await ensureDemoPlaysHeader();
    const resp = await sheets().spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'DemoPlays!A:F',
    });
    const rows = resp.data.values || [];
    res.json(rows.slice(1).map(row => ({
      timestamp: row[0] || '',
      company:   row[1] || '',
      niche:     row[2] || '',
      ip:        row[3] || '',
      userAgent: row[4] || '',
      audioType: normalizeAudioType(row[5]),
    })));
  } catch (e) {
    console.error('[DemoPlays GET]', e.message);
    res.json([]);
  }
});

// Serves the ProposalOpens log with each row annotated { scanner, rescued, real }
// by the SHARED open-filter module — the same code outreach-agent.js gates warm
// follow-ups with. The dashboard counts only `real` rows, so the headline "Opens"
// stat stops being inflated by mail-scanner detonations.
//
// Read-time only: the raw ProposalOpens tab is never mutated or trimmed, so the
// full log stays available for auditing and the filter can be revised later
// without data loss.
app.get('/api/proposalOpens', requireAuth, async (_req, res) => {
  try {
    const [openResp, ceResp, engResp, demoResp] = await Promise.all([
      sheets().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'ProposalOpens!A:F' }),
      sheets().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${CE_SHEET_NAME}!A:S` }),
      // Engagement signals rescue a real human who happened to trip a scanner
      // rule. Both tabs are optional — a missing one just means no rescues.
      sheets().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'ProposalEngaged!A:F' }).catch(() => ({ data: {} })),
      sheets().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'DemoPlays!A:F' }).catch(() => ({ data: {} })),
    ]);

    const opens = (openResp.data.values || []).slice(1).map(row => ({
      timestamp: row[0] || '',
      company:   row[1] || '',
      niche:     row[2] || '',
      id:        row[3] || '',
      ip:        row[4] || '',
      userAgent: row[5] || '',
    }));

    // Lead lookup for the send-window rule: prefer the logged lead id, fall back
    // to the company key (only ~60% of rows carry an id).
    const leadRows  = (ceResp.data.values || []).slice(1).filter(r => r[0]);
    const leadById  = new Map(leadRows.map(r => [r[0], { lastEmailedAt: r[9] || '' }]));
    const leadByKey = new Map();
    for (const r of leadRows) {
      const k = openKey(r[1]);
      if (k && !leadByKey.has(k)) leadByKey.set(k, { lastEmailedAt: r[9] || '' });
    }

    const annotated = annotateOpens({
      opens,
      keyOf:   row => openKey(row.company),
      leadFor: row => (row.id && leadById.get(row.id)) || leadByKey.get(openKey(row.company)) || null,
      engagedRows: (engResp.data.values || []).slice(1).map(r => ({ company: r[1] || '' })),
      demoRows:    (demoResp.data.values || []).slice(1).map(r => ({ company: r[1] || '' })),
    });

    res.json(annotated);
  } catch (e) {
    console.error('[ProposalOpens GET]', e.message);
    res.json([]);
  }
});

// Reads the Suppression tab into a Set of lowercased emails. Tolerant: a missing
// tab yields an empty set (a read failure must never un-suppress anyone).
async function loadSuppressedEmails() {
  try {
    const r = await sheets().spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID, range: `${SUPPRESSION_SHEET}!A:A`,
    });
    return new Set((r.data.values || []).slice(1).map(row => (row[0] || '').toLowerCase().trim()).filter(Boolean));
  } catch (e) {
    console.warn(`[Suppression] load failed (${e.message}) — treating as empty`);
    return new Set();
  }
}

// Appends an email to the Suppression tab (creating the tab if needed).
// Idempotent against the passed-in set. Used by the manual-unsubscribe path.
async function addSuppression(email, reason, company, source, known) {
  const e = (email || '').toLowerCase().trim();
  if (!e || (known && known.has(e))) return;
  const ss = await sheets().spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  if (!ss.data.sheets.find(sh => sh.properties.title === SUPPRESSION_SHEET)) {
    await sheets().spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: SUPPRESSION_SHEET } } }] },
    });
    await sheets().spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID, range: `${SUPPRESSION_SHEET}!A1`,
      valueInputOption: 'RAW', requestBody: { values: [SUPPRESSION_HEADER] },
    });
  }
  await sheets().spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID, range: `${SUPPRESSION_SHEET}!A:E`,
    valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[e, reason || '', company || '', new Date().toISOString(), source || '']] },
  });
  if (known) known.add(e);
}

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
      // Durable opt-out check: a suppressed address must never re-enter ColdEmail,
      // even if its original row was deleted (so existingEmails no longer has it).
      const suppressedEmails = await loadSuppressedEmails();
      const now   = Date.now();
      const toAdd = [];
      let duplicates = 0;
      let invalid    = 0;
      let junk       = 0;
      let suppressed = 0;
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
        // Opt-out choke point: never re-import a globally-suppressed address.
        if (suppressedEmails.has(email)) {
          suppressed++;
          console.warn(`[ColdEmail Import] rejected SUPPRESSED (opt-out): ${email} (${row.company || '—'})`);
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
      return { imported: toAdd.length, duplicates, invalid, junk, suppressed };
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

// Idempotent note prepend — mirrors prependNote() in outreach-agent.js. Never
// duplicates a tag that's already present.
function ensureNote(existing, tag) {
  if (existing && existing.includes(tag)) return existing;
  return existing ? `${tag} ${existing}` : tag;
}

app.put('/api/coldemail/:id', requireAuth, async (req, res) => {
  const lead = req.body;
  // CASL hard-suppression invariant. Setting a lead's stage to Unsubscribed
  // (this dashboard's label) — or Unsub (the agent's label) — must ALSO stamp
  // the signals the SEND path actually checks, not just the stage. The stage
  // alone is not enough: selectFollowUps() keys off emailStatus === 'emailed'
  // (ignores stage), and the pre-send guard keys off the notes suppression tag.
  // So a bare stage change on a mid-sequence lead left it sendable — a real
  // follow-up could still go out. Enforcing both here (server-side) closes that
  // hole for every client, not just the current UI.
  const isUnsub = lead.stage === 'Unsubscribed' || lead.stage === 'Unsub';
  if (isUnsub) {
    lead.emailStatus = 'done';
    lead.notes = ensureNote(lead.notes, '[REPLY: Unsubscribed]');
  }
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
    // Durable opt-out: a manual unsubscribe also lands on the global suppression
    // list, so it survives this row being deleted and re-scraped later.
    if (isUnsub) await withAuth(() => addSuppression(lead.email, 'unsubscribe', lead.company, 'manual-dashboard'));
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

// ── OUTREACH PROVIDER INTEGRATION ────────────────────────────────────────────

async function findColdEmailLead({ id, email }) {
  await ensureColdEmailSheet();
  const response = await sheets().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: CE_COL_RANGE });
  const rows = response.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    const candidate = {};
    CE_COLUMNS.forEach((field, index) => { candidate[field] = rows[i][index] || ''; });
    if ((id && candidate.id === id) || (email && candidate.email.trim().toLowerCase() === email.trim().toLowerCase())) return { lead: candidate, row: i + 1 };
  }
  return null;
}

async function findColdEmailLeadForCampaign(email, internalCampaignId) {
  await ensureColdEmailSheet();
  const response = await sheets().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: CE_COL_RANGE });
  const matches = [];
  for (let i = 1; i < (response.data.values || []).length; i++) {
    const lead = {}; CE_COLUMNS.forEach((field, index) => { lead[field] = response.data.values[i][index] || ''; });
    if (normalizeEmail(lead.email) === normalizeEmail(email) && (!internalCampaignId || lead.campaign === internalCampaignId)) matches.push({ lead, row: i + 1 });
  }
  return matches.length === 1 ? matches[0] : null;
}

async function updateIntegrationRowAt(title, header, rowNumber, record) {
  const values = [header.map(field => String(record[field] ?? ''))];
  await sheets().spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${title}!A${rowNumber}:${sheetColumn(header.length)}${rowNumber}`, valueInputOption: 'RAW', requestBody: { values } });
}

async function migrateProviderMappings() {
  const rows = await readIntegrationRows(PROVIDER_LEADS_SHEET, PROVIDER_LEADS_HEADER);
  for (const row of rows) {
    if (row.mappingKey && row.normalizedEmail) continue;
    const found = row.internalLeadId ? await findColdEmailLead({ id: row.internalLeadId }) : null;
    const email = normalizeEmail(row.normalizedEmail || found?.lead.email);
    const mappingKey = row.mappingKey || buildMappingKey({ provider: row.provider || 'smartlead', externalCampaignId: row.externalCampaignId, externalLeadId: row.externalLeadId, email });
    if (!mappingKey) continue;
    await updateIntegrationRowAt(PROVIDER_LEADS_SHEET, PROVIDER_LEADS_HEADER, row._row, { ...row, mappingKey, normalizedEmail: email });
  }
  return readIntegrationRows(PROVIDER_LEADS_SHEET, PROVIDER_LEADS_HEADER);
}

async function campaignIntegration(internalCampaignId) {
  const rows = await readIntegrationRows(CAMPAIGN_INTEGRATIONS_SHEET, CAMPAIGN_INTEGRATIONS_HEADER);
  return rows.find(row => row.internalCampaignId === internalCampaignId) || null;
}

function smartleadLeadPayload(lead) {
  const names = String(lead.contactName || '').trim().split(/\s+/);
  return {
    email: lead.email.trim().toLowerCase(),
    first_name: names[0] || '',
    last_name: names.slice(1).join(' '),
    company_name: lead.company || '',
    website: lead.website || '',
    location: lead.city || '',
    custom_fields: {
      practice_name: lead.company || '', city: lead.city || '', website: lead.website || '', niche: lead.tradeType || '',
      custom_first_line: lead.siteContext || '', service_reference: lead.tier || '', lead_score: lead.rating || '',
      internal_lead_id: lead.id,
    },
  };
}

app.get('/api/integrations/smartlead', requireAuth, async (_req, res) => {
  try {
    const [campaigns, leadMappings, events, health, stats] = await Promise.all([
      readIntegrationRows(CAMPAIGN_INTEGRATIONS_SHEET, CAMPAIGN_INTEGRATIONS_HEADER),
      readIntegrationRows(PROVIDER_LEADS_SHEET, PROVIDER_LEADS_HEADER),
      readIntegrationRows(PROVIDER_EVENTS_SHEET, PROVIDER_EVENTS_HEADER),
      readIntegrationRows(INTEGRATION_HEALTH_SHEET, INTEGRATION_HEALTH_HEADER),
      readIntegrationRows(PROVIDER_STATS_SHEET, PROVIDER_STATS_HEADER),
    ]);
    res.json({ enabled: smartleadClient.integrationEnabled, testMode: !smartleadClient.liveMutationsEnabled, campaigns, leadMappings, stats, recentEvents: events.slice(-20).reverse(), health: health.find(h => h.provider === 'smartlead') || null });
  } catch (error) {
    console.error('[Smartlead status]', error.message);
    res.status(500).json({ error: 'Could not load Smartlead integration status' });
  }
});

// Secondary Gmail inbox readiness only. These endpoints never participate in
// sender selection and never expose credential values. The live legacy sender
// continues to use only FROM_EMAIL + GMAIL_TOKEN_JSON in outreach-agent.js.
app.get('/api/integrations/gmail-inboxes', requireAuth, (_req, res) => {
  try {
    const secondary = publicGmailInboxRegistry(parseGmailInboxRegistry());
    const primary = {
      id: 'primary', email: process.env.FROM_EMAIL || 'Current Gmail inbox', status: 'active',
      dailyLimit: Number(process.env.DAILY_SEND_LIMIT || 40), credentialConfigured: Boolean(process.env.GMAIL_TOKEN_JSON),
      identityVerified: true, sendEligible: process.env.SENDING_ENABLED === 'true', currentRoute: true,
    };
    res.json({ inboxes: [primary, ...secondary] });
  }
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/integrations/gmail-inboxes/:id/verify', requireAuth, async (req, res) => {
  try {
    const entry = parseGmailInboxRegistry().find(item => item.id === req.params.id);
    if (!entry) return res.status(404).json({ error: 'Gmail inbox is not registered' });
    res.json(await verifyGmailInbox(entry));
  } catch (error) { res.status(422).json({ error: error.message }); }
});

app.put('/api/integrations/smartlead/campaigns/:internalCampaignId', requireAuth, async (req, res) => {
  const internalCampaignId = String(req.params.internalCampaignId || '').trim();
  const provider = req.body.provider === 'smartlead' ? 'smartlead' : 'gmail';
  const externalCampaignId = String(req.body.externalCampaignId || '').trim();
  if (!internalCampaignId) return res.status(400).json({ error: 'Internal campaign ID is required' });
  if (provider === 'smartlead' && !/^\d+$/.test(externalCampaignId)) return res.status(422).json({ error: 'A numeric Smartlead campaign ID is required' });
  const now = new Date().toISOString();
  try {
    await upsertIntegrationRow(CAMPAIGN_INTEGRATIONS_SHEET, CAMPAIGN_INTEGRATIONS_HEADER, 'internalCampaignId', {
      internalCampaignId, provider, externalCampaignId: provider === 'smartlead' ? externalCampaignId : '',
      externalCampaignName: String(req.body.externalCampaignName || ''), syncStatus: 'mapped-not-tested',
      lastSynchronizedAt: '', sendingPool: String(req.body.sendingPool || ''),
      fieldMappings: JSON.stringify(req.body.fieldMappings || { first_name: 'contactName', company_name: 'company', city: 'city', website: 'website', niche: 'tradeType', custom_first_line: 'siteContext' }), updatedAt: now,
    });
    res.json({ ok: true, provider, testMode: !smartleadClient.liveMutationsEnabled });
  } catch (error) {
    console.error('[Smartlead mapping save]', error.message);
    res.status(500).json({ error: 'Could not save campaign mapping' });
  }
});

app.post('/api/integrations/smartlead/campaigns/:internalCampaignId/test', requireAuth, async (req, res) => {
  try {
    const mapping = await campaignIntegration(req.params.internalCampaignId);
    if (!mapping || mapping.provider !== 'smartlead' || !mapping.externalCampaignId) return res.status(422).json({ error: 'Map this campaign to Smartlead first' });
    const campaign = await smartleadClient.getCampaign(mapping.externalCampaignId);
    const now = new Date().toISOString();
    await upsertIntegrationRow(CAMPAIGN_INTEGRATIONS_SHEET, CAMPAIGN_INTEGRATIONS_HEADER, 'internalCampaignId', { ...mapping, externalCampaignName: campaign.name || mapping.externalCampaignName, syncStatus: 'connected', lastSynchronizedAt: now, updatedAt: now });
    await updateIntegrationHealth({ lastSuccessfulApiCall: now, lastError: '' });
    res.json({ ok: true, campaign: { id: campaign.id || mapping.externalCampaignId, name: campaign.name || mapping.externalCampaignName, status: campaign.status || 'unknown' } });
  } catch (error) {
    console.warn('[Smartlead mapping test]', error.code || error.message);
    res.status(error.status === 401 ? 401 : 502).json({ error: error.message });
  }
});

app.post('/api/integrations/smartlead/campaigns/:internalCampaignId/leads/:leadId', requireAuth, async (req, res) => {
  try {
    const mapping = await campaignIntegration(req.params.internalCampaignId);
    if (!mapping || mapping.provider !== 'smartlead' || !mapping.externalCampaignId) return res.status(422).json({ error: 'Campaign is not mapped to Smartlead' });
    const found = await findColdEmailLead({ id: req.params.leadId });
    if (!found || !found.lead.email) return res.status(422).json({ error: 'Lead with an email address is required' });
    const suppressed = await loadSuppressedEmails();
    const providerLeads = await migrateProviderMappings();
    const eligibility = leadEligibility({ lead: found.lead, suppressedEmails: suppressed, providerMappings: providerLeads, externalCampaignId: mapping.externalCampaignId });
    if (!eligibility.ok) return res.status(409).json({ error: eligibility.reason });
    const result = await smartleadProvider.addLeads({ externalCampaignId: mapping.externalCampaignId }, [smartleadLeadPayload(found.lead)]);
    const now = new Date().toISOString();
    const externalLeadId = result.lead_ids?.[0] || '';
    const mappingKey = buildMappingKey({ externalCampaignId: mapping.externalCampaignId, externalLeadId, email: eligibility.email });
    await upsertIntegrationRow(PROVIDER_LEADS_SHEET, PROVIDER_LEADS_HEADER, 'mappingKey', {
      internalLeadId: found.lead.id, provider: 'smartlead', externalLeadId: result.lead_ids?.[0] || '', externalCampaignId: mapping.externalCampaignId,
      mappingId: '', normalizedStatus: result.testMode ? 'Test mode' : (result.added_count ? 'Queued' : 'Skipped'), rawStatus: result.message || '',
      lastProviderEventAt: '', lastSynchronizedAt: now, unsubscribedAt: '', complianceNote: String(req.body.complianceNote || ''), metadata: JSON.stringify({ addedCount: result.added_count || 0, skippedCount: result.skipped_count || 0 }), mappingKey, normalizedEmail: eligibility.email,
    });
    res.json({ ok: true, testMode: Boolean(result.testMode), result });
  } catch (error) {
    console.warn('[Smartlead add lead]', error.code || error.message);
    res.status(error.status === 422 ? 422 : 502).json({ error: error.message });
  }
});

function findStoredEvent(rows, eventKey, requestId) {
  return rows.find(row => row.eventKey === eventKey || (!row.eventKey && requestId && row.requestId === requestId));
}

async function processStoredSmartleadEvent(eventRow) {
  const audit = JSON.parse(eventRow.payload || '{}');
  const supported = new Set(['EMAIL_SENT','FIRST_EMAIL_SENT','EMAIL_REPLY','EMAIL_BOUNCE','EMAIL_BOUNCED','LEAD_UNSUBSCRIBED','EMAIL_UNSUBSCRIBED','LEAD_CATEGORY_UPDATED','CAMPAIGN_STATUS_CHANGED']);
  if (!supported.has(eventRow.eventType)) return 'ignored';
  let incomingStatus = normalizeEvent({ event_type: eventRow.eventType, campaign_id: eventRow.externalCampaignId, lead_id: eventRow.externalLeadId, lead_email: audit.email, timestamp: audit.timestamp, category: audit.category, preview_text: audit.replyPreview, subject: audit.subject }).status;
  if (eventRow.eventType === 'EMAIL_REPLY' && audit.replyPreview) {
    const classification = await classifyProviderReply({ provider: 'smartlead', lead: { company: '' }, campaign: { id: eventRow.externalCampaignId }, subject: audit.subject, plainTextReply: audit.replyPreview });
    incomingStatus = CLASSIFICATION_TO_STATUS[classification] || 'Replied';
  }
  const providerRows = await migrateProviderMappings();
  const eventIdentity = { campaignId: eventRow.externalCampaignId, leadId: eventRow.externalLeadId, mappingId: audit.mappingId, email: audit.email };
  let providerRow = providerRows.find(row => mappingMatchesEvent(row, eventIdentity));
  let found = providerRow?.internalLeadId ? await findColdEmailLead({ id: providerRow.internalLeadId }) : null;
  if (!found && audit.email && eventRow.externalCampaignId) {
    const campaign = (await readIntegrationRows(CAMPAIGN_INTEGRATIONS_SHEET, CAMPAIGN_INTEGRATIONS_HEADER)).find(row => row.provider === 'smartlead' && row.externalCampaignId === eventRow.externalCampaignId);
    if (campaign) found = await findColdEmailLeadForCampaign(audit.email, campaign.internalCampaignId);
  }
  const now = new Date().toISOString();
  if (providerRow && !canApplyProviderTransition({ currentStatus: providerRow.normalizedStatus, currentEventAt: providerRow.lastProviderEventAt, incomingStatus, incomingEventAt: audit.timestamp })) return 'processed';
  if (found) {
    const noteByStatus = { Replied: '[SMARTLEAD: Reply received]', Bounced: '[BOUNCED: Smartlead]', Unsubscribed: '[REPLY: Unsubscribed]', Interested: '[REPLY: Interested]', 'Not interested': '[REPLY: Not interested]', 'Meeting requested': '[REPLY: Meeting requested]', Question: '[REPLY: Question — review required]', 'Out of office': '[REPLY: Out of office]' };
    const nextNotes = noteByStatus[incomingStatus] ? ensureNote(found.lead.notes, noteByStatus[incomingStatus]) : found.lead.notes;
    let stage = found.lead.stage;
    if (['Replied','Interested','Meeting requested','Question','Out of office'].includes(incomingStatus)) stage = incomingStatus === 'Question' ? 'Review' : 'Replied';
    if (incomingStatus === 'Unsubscribed') stage = 'Unsub';
    if (['Bounced','Not interested'].includes(incomingStatus)) stage = 'Done';
    const emailStatus = incomingStatus === 'Sent' ? 'emailed' : ['Replied','Interested','Meeting requested','Question','Not interested','Out of office'].includes(incomingStatus) ? 'replied' : ['Unsubscribed','Bounced'].includes(incomingStatus) ? 'done' : found.lead.emailStatus;
    await sheets().spreadsheets.values.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { valueInputOption: 'RAW', data: [{ range: `${CE_SHEET_NAME}!H${found.row}`, values: [[stage]] }, { range: `${CE_SHEET_NAME}!I${found.row}`, values: [[emailStatus]] }, { range: `${CE_SHEET_NAME}!L${found.row}`, values: [[nextNotes]] }] } });
    if (incomingStatus === 'Unsubscribed') await addSuppression(audit.email, 'unsubscribe', found.lead.company, 'smartlead-webhook', await loadSuppressedEmails());
  }
  const email = normalizeEmail(audit.email || found?.lead.email || providerRow?.normalizedEmail);
  const mappingKey = providerRow?.mappingKey || buildMappingKey({ externalCampaignId: eventRow.externalCampaignId, externalLeadId: eventRow.externalLeadId, email });
  if (mappingKey) await upsertIntegrationRow(PROVIDER_LEADS_SHEET, PROVIDER_LEADS_HEADER, 'mappingKey', { ...(providerRow || {}), internalLeadId: found?.lead.id || providerRow?.internalLeadId || '', provider: 'smartlead', externalLeadId: eventRow.externalLeadId || providerRow?.externalLeadId || '', externalCampaignId: eventRow.externalCampaignId, mappingId: audit.mappingId || providerRow?.mappingId || '', normalizedStatus: incomingStatus, rawStatus: audit.providerStatus || eventRow.eventType, lastProviderEventAt: audit.timestamp || now, lastSynchronizedAt: now, unsubscribedAt: incomingStatus === 'Unsubscribed' ? now : providerRow?.unsubscribedAt || '', metadata: JSON.stringify({ category: audit.category || '', replyPreview: audit.replyPreview || '', subject: audit.subject || '' }), mappingKey, normalizedEmail: email });
  return 'processed';
}

async function runStoredEvent(eventRow) {
  const result = await executeEventAttempt(eventRow, () => processStoredSmartleadEvent(eventRow), { onState: state => updateIntegrationRowAt(PROVIDER_EVENTS_SHEET, PROVIDER_EVENTS_HEADER, eventRow._row, state) });
  return result.processingStatus;
}

async function handleSmartleadWebhook(req, res) {
  const signature = req.get('X-Smartlead-Signature') || '';
  const requestId = req.get('X-Request-Id') || '';
  const secret = process.env.SMARTLEAD_WEBHOOK_SECRET || '';
  const authenticated = signature ? verifySignature(req.body, signature, secret) : verifySharedSecret(req.query.token, secret);
  if (!authenticated) return res.status(401).json({ error: 'Invalid webhook authentication' });
  let event;
  try { event = JSON.parse(req.body.toString('utf8')); } catch (_) { return res.status(400).json({ error: 'Invalid JSON' }); }
  const eventKey = buildEventKey(req.body, requestId);
  try {
    const outcome = await webhookLocks.run(eventKey, async () => {
      let rows = await readIntegrationRows(PROVIDER_EVENTS_SHEET, PROVIDER_EVENTS_HEADER);
      let stored = findStoredEvent(rows, eventKey, requestId);
      if (stored && ['processed','ignored'].includes(stored.processingStatus)) return 'already_processed';
      if (!stored) {
        const normalized = normalizeEvent(event); const receivedAt = new Date().toISOString(); const eventId = crypto.randomUUID();
        const campaign = (await readIntegrationRows(CAMPAIGN_INTEGRATIONS_SHEET, CAMPAIGN_INTEGRATIONS_HEADER)).find(row => row.provider === 'smartlead' && row.externalCampaignId === normalized.campaignId);
        await appendIntegrationRow(PROVIDER_EVENTS_SHEET, PROVIDER_EVENTS_HEADER, { eventId, provider: 'smartlead', requestId, eventType: normalized.type, internalCampaignId: campaign?.internalCampaignId || '', internalLeadId: '', externalCampaignId: normalized.campaignId, externalLeadId: normalized.leadId, receivedAt, processedAt: '', processingStatus: 'received', payload: JSON.stringify(safeAuditPayload(event, normalized)), error: '', eventKey, attemptCount: 0, lastAttemptAt: '' });
        rows = await readIntegrationRows(PROVIDER_EVENTS_SHEET, PROVIDER_EVENTS_HEADER); stored = findStoredEvent(rows, eventKey, requestId);
      }
      return runStoredEvent(stored);
    });
    const now = new Date().toISOString();
    const events = await readIntegrationRows(PROVIDER_EVENTS_SHEET, PROVIDER_EVENTS_HEADER);
    await updateIntegrationHealth({ lastReceivedWebhook: now, failedEventCount: events.filter(row => ['failed','received','processing'].includes(row.processingStatus)).length });
    return res.status(200).json({ status: outcome });
  } catch (error) {
    const internalRef = crypto.createHash('sha256').update(eventKey).digest('hex').slice(0, 12);
    console.error(`[Smartlead webhook] processing failed for event ${internalRef}`);
    return res.status(500).json({ error: 'Temporary processing failure' });
  }
}

async function reconcileSmartlead() {
  if (!smartleadClient.integrationEnabled) return { skipped: true };
  const mappings = (await readIntegrationRows(CAMPAIGN_INTEGRATIONS_SHEET, CAMPAIGN_INTEGRATIONS_HEADER)).filter(row => row.provider === 'smartlead' && row.externalCampaignId);
  const startedAt = new Date().toISOString();
  const result = { attempted: mappings.length, successful: 0, failed: 0, pages: 0, leads: 0, errors: [] };
  for (const mapping of mappings) {
    try {
      const [analytics, pageResult] = await Promise.all([smartleadProvider.getCampaignStats(mapping.externalCampaignId), fetchAllCampaignLeads(({ offset, limit }) => smartleadClient.getCampaignLeads(mapping.externalCampaignId, { offset, limit }))]);
      result.pages += pageResult.pages; result.leads += pageResult.leads.length;
      let localMappings = await migrateProviderMappings();
      for (const item of pageResult.leads) {
        const remote = item.lead ? { ...item.lead, status: item.status, campaign_lead_map_id: item.campaign_lead_map_id, created_at: item.created_at } : item;
        const found = await findColdEmailLeadForCampaign(remote.email, mapping.internalCampaignId);
        if (!found) continue;
        const identity = { campaignId: mapping.externalCampaignId, leadId: remote.id, mappingId: remote.campaign_lead_map_id, email: remote.email };
        const existing = localMappings.find(row => mappingMatchesEvent(row, identity));
        const remoteTime = remote.last_sent_time || remote.updated_at || remote.created_at || startedAt;
        const normalizedStatus = remote.email_stats?.is_replied ? 'Replied' : remote.email_stats?.is_bounced ? 'Bounced' : remote.is_unsubscribed ? 'Unsubscribed' : String(remote.category_name || remote.status || 'Queued').replace(/_/g, ' ');
        if (existing && !canApplyProviderTransition({ currentStatus: existing.normalizedStatus, currentEventAt: existing.lastProviderEventAt, incomingStatus: normalizedStatus, incomingEventAt: remoteTime })) continue;
        const email = normalizeEmail(remote.email);
        const mappingKey = existing?.mappingKey || buildMappingKey({ externalCampaignId: mapping.externalCampaignId, externalLeadId: remote.id, email });
        await upsertIntegrationRow(PROVIDER_LEADS_SHEET, PROVIDER_LEADS_HEADER, 'mappingKey', { ...(existing || {}), internalLeadId: found.lead.id, provider: 'smartlead', externalLeadId: remote.id || '', externalCampaignId: mapping.externalCampaignId, mappingId: remote.campaign_lead_map_id || existing?.mappingId || '', normalizedStatus, rawStatus: remote.status || '', lastProviderEventAt: remoteTime, lastSynchronizedAt: startedAt, metadata: JSON.stringify({ category: remote.category_name || '', emailStats: remote.email_stats || {} }), mappingKey, normalizedEmail: email });
        localMappings = localMappings.filter(row => row.mappingKey !== mappingKey).concat([{ ...(existing || {}), mappingKey, normalizedStatus, externalCampaignId: mapping.externalCampaignId }]);
      }
      const campaignMappings = (await migrateProviderMappings()).filter(row => row.provider === 'smartlead' && row.externalCampaignId === mapping.externalCampaignId);
      const localStats = aggregateProviderStats(campaignMappings);
      const sent = Number(analytics.total_sent ?? analytics.contacted ?? localStats.sent);
      const replied = Number(analytics.total_replied ?? analytics.replied ?? localStats.replied);
      await upsertIntegrationRow(PROVIDER_STATS_SHEET, PROVIDER_STATS_HEADER, 'internalCampaignId', { internalCampaignId: mapping.internalCampaignId, provider: 'smartlead', externalCampaignId: mapping.externalCampaignId, ...localStats, totalLeads: Number(analytics.total_leads ?? pageResult.total ?? localStats.totalLeads), sent, replied, replyRate: sent ? replied / sent * 100 : 0, interestedRate: replied ? localStats.interested / replied * 100 : 0, unsubscribed: Number(analytics.total_unsubscribed ?? analytics.unsubscribed ?? localStats.unsubscribed), bounced: Number(analytics.total_bounced ?? analytics.bounced ?? localStats.bounced), lastSynchronizedAt: startedAt });
      await upsertIntegrationRow(CAMPAIGN_INTEGRATIONS_SHEET, CAMPAIGN_INTEGRATIONS_HEADER, 'internalCampaignId', { ...mapping, syncStatus: 'connected', lastSynchronizedAt: startedAt, updatedAt: startedAt, fieldMappings: mapping.fieldMappings, externalCampaignName: analytics.campaign_name || mapping.externalCampaignName });
      result.successful++;
    } catch (error) {
      result.failed++;
      result.errors.push({ campaign: mapping.internalCampaignId, error: String(error.code || error.message || 'request failed').slice(0, 160) });
      console.warn(`[Smartlead reconcile] campaign ${mapping.internalCampaignId}: ${error.code || error.message}`);
    }
  }
  const finishedAt = new Date().toISOString();
  const events = await readIntegrationRows(PROVIDER_EVENTS_SHEET, PROVIDER_EVENTS_HEADER);
  const healthPatch = { ...reconciliationHealth(result, finishedAt), failedEventCount: events.filter(row => ['failed','received','processing'].includes(row.processingStatus)).length };
  if (result.successful) healthPatch.lastSuccessfulApiCall = finishedAt;
  await updateIntegrationHealth(healthPatch);
  return result;
}

app.post('/api/integrations/smartlead/reconcile', requireAuth, async (_req, res) => {
  try { res.json(await reconcileSmartlead()); } catch (error) { res.status(502).json({ error: error.message }); }
});

app.get('/api/integrations/smartlead/events/attention', requireAuth, async (_req, res) => {
  try {
    const rows = await readIntegrationRows(PROVIDER_EVENTS_SHEET, PROVIDER_EVENTS_HEADER);
    res.json(rows.filter(row => ['failed','received','processing'].includes(row.processingStatus)).map(row => ({ eventId: row.eventId, eventKey: row.eventKey || (row.requestId ? `smartlead:request:${row.requestId}` : ''), eventType: row.eventType, internalCampaignId: row.internalCampaignId, internalLeadId: row.internalLeadId, processingStatus: row.processingStatus, attemptCount: Number(row.attemptCount || 0), error: row.error, lastAttemptAt: row.lastAttemptAt })));
  } catch (error) { res.status(500).json({ error: 'Could not load provider events' }); }
});

app.post('/api/integrations/smartlead/events/:eventId/retry', requireAuth, async (req, res) => {
  try {
    const rows = await readIntegrationRows(PROVIDER_EVENTS_SHEET, PROVIDER_EVENTS_HEADER);
    const row = rows.find(item => item.eventId === req.params.eventId && ['failed','received','processing'].includes(item.processingStatus));
    if (!row) return res.status(404).json({ error: 'Retryable event not found' });
    const key = row.eventKey || (row.requestId ? `smartlead:request:${row.requestId}` : `stored:${row.eventId}`);
    const status = await webhookLocks.run(key, () => runStoredEvent(row));
    res.json({ ok: true, status });
  } catch (error) { res.status(500).json({ error: 'Event retry failed' }); }
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
  // Per-run send cap for the scheduled batches. The morning cron fires 8 times
  // a day (:00/:30, 8–11:30am Pacific); 8 × 5 = 40 spreads the day's volume
  // evenly across the window instead of dumping it in the first few runs. This
  // is a per-RUN knob only — the agent's own DAILY_SEND_LIMIT (40) is the hard
  // daily ceiling and is NOT changed, so the daily total is provably unchanged;
  // this commit only redistributes WHEN those 40 go out. Passed via env so the
  // agent's cap logic (effectiveCap = min(DAILY_CAP, dailyRemaining)) is reused
  // untouched. Keep in sync with the 8-slot schedule below if either changes.
  const SEND_PER_RUN_CAP = 5;

  // Sends fire only in a weekday morning window, evenly at :00 and :30 of
  // 8am–11:30am Pacific (8 runs: 8:00, 8:30, 9:00, 9:30, 10:00, 10:30, 11:00,
  // 11:30). That lands 9:00am–12:30pm for Mountain (AB) leads too. Overnight
  // sends are gone — a human doesn't email at 4am, and inboxes are freshest
  // mid-morning. The timezone pin below makes these fields Pacific-local and
  // handles PDT/PST automatically; do NOT hand-convert to UTC.
  cron.schedule('0,30 8-11 * * 1-5', () => {
    console.log('[cron] Triggering scheduled outreach agent run...');
    if (agentState.running) {
      console.log('[cron] Agent already running — skipping this tick');
      return;
    }
    spawnAgent(false, { DAILY_CAP: String(SEND_PER_RUN_CAP) });
  }, {
    timezone: 'America/Vancouver',
  });
  console.log(`[cron] Outreach agent scheduled: :00 and :30, 8–11:30am Pacific, Mon–Fri (${SEND_PER_RUN_CAP}/run)`);

  // :15/:45, never :00/:30 — the send cron above fires on :00 and :30, so the
  // check-only pass is offset by 15 min to avoid racing it for the
  // agentState.running guard (whichever lost a tick was silently skipped, and
  // a check-only win used to cost a whole send window). Offset schedules cannot
  // collide.
  cron.schedule('15,45 * * * *', () => {
    console.log('[cron] Running check-only pass...');
    spawnAgentCheckOnly();
  }, {
    timezone: 'America/Vancouver',
  });

  // Safety net for the both-audios trigger. The /demo-played route fires it
  // event-driven, so this only picks up plays whose spawn was skipped because
  // the agent was busy, or that arrived while the process was restarting.
  // Every 3 minutes keeps the worst case inside the ~5-minute target.
  cron.schedule('*/3 * * * *', () => {
    spawnAgentIntentOnly('cron backstop');
  }, {
    timezone: 'America/Vancouver',
  });
  console.log('[cron] Intent backstop scheduled: every 3 minutes');

  // Daily digest — 18:00 America/Vancouver. getOrCreateDigest is idempotent, so
  // a restart, a re-fire, or a dashboard load on the same day all reuse the
  // stored row rather than producing a second one.
  cron.schedule('0 18 * * *', () => {
    console.log('[cron] Generating daily digest...');
    withAuth(() => getOrCreateDigest(vanDay()))
      .then(d => console.log(`[digest] ${d.date} — ${d.emailsSent} sent, ${d.realOpens.rows} real opens, ${d.answers.draftsPending} drafts pending review`))
      .catch(e => console.error('[digest] generation failed:', e.message));
  }, {
    timezone: 'America/Vancouver',
  });
  // Webhooks are primary; this repairs missed/stale Smartlead state hourly.
  cron.schedule('12 * * * *', () => {
    reconcileSmartlead().catch(e => console.error('[Smartlead reconcile]', e.message));
  }, { timezone: 'America/Vancouver' });
  console.log('[cron] Smartlead reconciliation scheduled: hourly at :12');
  console.log('[cron] Daily digest scheduled: 18:00 Pacific');
  console.log('[cron] Check-only pass scheduled: :15 and :45 every hour');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ScaleLab Pipeline → http://localhost:${PORT}`));
