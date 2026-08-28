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
const {
  buildReplyMetrics, buildStoredClassificationMap,
  buildReplyRecords, buildReplyEvidenceMap, filterReplyRecords,
} = require('./integrations/reply-analytics');
const { parseRegistry: parseGmailInboxRegistry, publicRegistry: publicGmailInboxRegistry, verifyInbox: verifyGmailInbox } = require('./integrations/gmail-inbox-registry');
const { EMAIL_TEMPLATES, normalizeNiche, validateRoute } = require('./integrations/campaign-routing');
const { TEMPLATE_ID: ROOFING_SURVEY_TEMPLATE, qualifyLead: qualifyRoofingLead } = require('./integrations/roofing-survey-profile');
const {
  COLD_CALL_ACTIVITY_SHEET,
  COLD_CALL_ACTIVITY_HEADER,
  displayStageFor,
  scoreColdCallLead,
} = require('./integrations/cold-call-pipeline');
const { buildActivityTimeline, inspectActivityIntegrity } = require('./integrations/activity-timeline');
const { PROMOTION_TRIGGER, resolvePromotionIdentity, promotionDecision } = require('./integrations/promotion-policy');
const {
  LEGACY_UNKNOWN, CAMPAIGN_VERSIONS, ACTIVE_CAMPAIGN_VERSION,
  buildCampaignVersionIndex, latestSendAttribution, acquisitionAttribution, promotionAttribution, coldSendAttribution,
} = require('./integrations/campaign-versions');
const { buildFunnelAnalytics } = require('./integrations/funnel-analytics');
const { buildCrmHealth } = require('./integrations/crm-health');
const {
  classifyCalendarEvent, matchBookingIdentity, bookingLifecycleAction,
  nextSyncState, providerEventKey, runGoogleCalendarSync: orchestrateGoogleCalendarSync,
  BOOKING_DECISION, PROVIDER: CALENDAR_PROVIDER,
} = require('./integrations/google-calendar');
const { BOOKING_URL } = require('./booking');
const {
  SEQUENCES, SEQUENCE_EVENTS, SEQUENCE_STATUS, evaluateStageSequence,
  buildSequenceEmail, deriveSequenceState, resolveSequenceThread,
} = require('./integrations/stage-sequences');
const {
  deriveAutomationState, automationConflict, deriveNextAction,
  compareNextActions, summarizeNextActions,
  stageTransitionCheck, reopenEligibility, OUTCOME_IDS, LOSS_OUTCOME_IDS,
  MANUAL_HOLD_TAG, HUMAN_OWNED_STAGES,
  REACTIVATION_MODES, reactivationEligibility, FOLLOW_UP_DELAY_DAYS,
  CALL_STATUS, deriveCallLifecycle, callLifecycleActions, deriveHotState,
  applyResumeToNotes, clearResumeFromNotes, resumeAtFromNotes,
  applyHoldToNotes, stageRequiresHold, sendSuppressionReason,
} = require('./integrations/pipeline-state');

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
const CALL_DETAIL_COLS = ['meetingAt', 'outcome', 'conversationContext'];
const AGENT_READ_RANGE = `${SHEET_NAME}!A:W`;

// ── COLD EMAIL SHEET ──────────────────────────────────────────────────────────
const CE_SHEET_NAME = 'ColdEmail';
const CE_COLUMNS    = [
  'id','company','contactName','email','city','tradeType','website',
  'stage','emailStatus','lastEmailedAt','emailStep','notes',
  'reviewCount','rating','tier','siteContext',                        // M N O P
  'campaign','campaign_notes',                                        // Q R
  'enrichment_attempted',                                             // S
  'leadNiche','senderInboxId','emailTemplateId','routingRequired',     // T U V W
];
const CE_COL_RANGE  = `${CE_SHEET_NAME}!A:W`;

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

// Every mutating Sheets call in this process funnels through here, so cache
// invalidation cannot be forgotten at one of the ~30 write sites. A write that
// names a cached tab drops the cached dataset immediately — the next read is
// fresh, which is why a stage change never appears to be swallowed by the TTL.
const MUTATING_VALUE_METHODS = ['update', 'append', 'batchUpdate', 'clear'];

function rangesTouched(params) {
  const out = [];
  if (params && params.range) out.push(String(params.range));
  const data = params && params.requestBody && params.requestBody.data;
  if (Array.isArray(data)) for (const entry of data) if (entry && entry.range) out.push(String(entry.range));
  return out;
}

function sheets() {
  const client = google.sheets({ version: 'v4', auth });
  const values = client.spreadsheets.values;
  for (const method of MUTATING_VALUE_METHODS) {
    const original = values[method].bind(values);
    values[method] = params => {
      const ranges = rangesTouched(params);
      if (ranges.some(range => range.includes(CE_SHEET_NAME) || range.includes(`${SHEET_NAME}!`))) invalidateOutreachCache(`write:${method}`);
      if (ranges.some(range => /DemoPlays|ProposalOpens|ProposalEngaged/.test(range))) invalidateOutreachCache(`write:${method}`);
      return original(params);
    };
  }
  return client;
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

function stableActivityId(prefix, parts) {
  return `${prefix}:${crypto.createHash('sha1').update(parts.map(value => String(value || '')).join('|')).digest('hex').slice(0, 24)}`;
}

async function appendColdCallActivities(records) {
  if (!records?.length) return;
  await ensureIntegrationSheet(COLD_CALL_ACTIVITY_SHEET, COLD_CALL_ACTIVITY_HEADER);
  await sheets().spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${COLD_CALL_ACTIVITY_SHEET}!A:J`,
    valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: records.map(record => COLD_CALL_ACTIVITY_HEADER.map(key => String(record[key] ?? ''))) },
  });
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

function spawnAgentCheckOnly(extraEnv = {}) {
  if (agentState.running) {
    console.log('[cron] Agent already running — skipping check-only pass this tick');
    return;
  }
  startAgentProcess({ DRY_RUN: 'false', CHECK_ONLY: 'true', ...extraEnv }, false);
}

function isDailyLateReplyWindow(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Vancouver', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const clock = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return clock.hour === '12' && clock.minute === '15';
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
        range:         AGENT_READ_RANGE,   // A:W — bookkeeping R:T + cold-call details U:W
      });
      const rows = resp.data.values || [];
      rowMap.clear();
      return rows.slice(1).map((row, idx) => {
        const lead = {};
        COLUMNS.forEach((col, i) => { lead[col] = row[i] || ''; });
        AGENT_COLS.forEach((col, i) => { lead[col] = row[17 + i] || ''; });
        CALL_DETAIL_COLS.forEach((col, i) => { lead[col] = row[20 + i] || ''; });
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
    try {
      const occurredAt = Number.isFinite(Date.parse(String(lead.created || '')))
        ? new Date(lead.created).toISOString() : new Date().toISOString();
      await appendColdCallActivities([{
        eventId: stableActivityId('lead-created', [lead.id]), leadId: lead.id, sourceLeadId: '',
        email: lead.email || '', company: lead.company || '', eventType: 'lead_created',
        occurredAt, subject: 'Lead added to Sales Pipeline', content: '',
        metadata: JSON.stringify({ trigger: 'crm_create' }),
      }]);
    } catch (activityError) {
      console.warn('[Leads POST] saved, but lead-created activity failed:', activityError.message);
    }
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
    // Read the row BEFORE overwriting: the transition gate needs meetingAt and
    // outcome, which live in U:W and are NOT carried in the request body. The
    // write range stays A:Q, so U:W survive this endpoint untouched.
    let previousStage = '';
    let priorRow = [];
    try {
      const prior = await sheets().spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A${rowNum}:W${rowNum}`,
      });
      priorRow = prior.data.values?.[0] || [];
      previousStage = priorRow[12] || '';
    } catch (readError) {
      console.warn('[Leads PUT] prior-row read failed:', readError.message);
    }

    const nextStage = String(lead.stage || '');
    const isTransition = displayStageFor(nextStage) !== displayStageFor(previousStage);

    // Server-side gate. Enforced ONLY on a real transition: the 11 legacy rows
    // sitting at raw stage "lost" carry no outcome, and validating every save
    // would make them unsavable without first changing data this task must not
    // touch. Same shared rules the browser uses — stageTransitionCheck is the
    // single source, not a second copy.
    if (isTransition) {
      const gate = stageTransitionCheck(nextStage, {
        meetingAt: priorRow[20] || '',
        outcome: priorRow[21] || '',
      });
      if (!gate.ok) {
        return res.status(422).json({ error: gate.message, field: gate.field, stage: displayStageFor(nextStage) });
      }
    }

    await withAuth(async () => {
      await sheets().spreadsheets.values.update({
        spreadsheetId:   SPREADSHEET_ID,
        range:           `${SHEET_NAME}!A${rowNum}:Q${rowNum}`,
        valueInputOption:'RAW',
        requestBody:     { values: vals },
      });
    });
    // Stage history + manual hold. Append-only and best-effort: the lead is
    // already saved, so a failure here must not turn a successful save into a
    // 500. Only a real transition runs this, which is what keeps repeated saves
    // of the same card from stacking duplicate stage-entry or hold events.
    if (isTransition) {
      // THE P0 FIX. Moving a card into a human-owned stage now stops the sending
      // agent, because [MANUAL HOLD] lands in the ColdEmail notes that
      // suppressionReason() reads before every send.
      if (stageRequiresHold(nextStage)) {
        try {
          const held = await applyManualHold(req.params.id, lead.email || priorRow[10] || '');
          for (const row of held) {
            await appendIntegrationRow(COLD_CALL_ACTIVITY_SHEET, COLD_CALL_ACTIVITY_HEADER, {
              eventId: crypto.randomUUID(), leadId: req.params.id, sourceLeadId: row.id,
              email: lead.email || '', company: lead.company || '',
              eventType: 'automation_held', occurredAt: new Date().toISOString(),
              subject: 'Automated follow-up suppressed', content: '',
              metadata: JSON.stringify({
                stage: displayStageFor(nextStage), trigger: 'stage_transition',
                coldEmailId: row.id, matchedBy: row.matchedBy,
                emailStatusAtHold: row.emailStatus, tag: MANUAL_HOLD_TAG,
              }),
            });
          }
          if (held.length) console.log(`[hold] ${MANUAL_HOLD_TAG} applied to ${held.length} ColdEmail row(s) for ${req.params.id}`);
        } catch (holdError) {
          // Loud: a failed hold means automation may still be live.
          console.error('[hold] FAILED to apply manual hold for', req.params.id, '-', holdError.message);
        }
      }
      try {
        await appendIntegrationRow(COLD_CALL_ACTIVITY_SHEET, COLD_CALL_ACTIVITY_HEADER, {
          eventId: crypto.randomUUID(), leadId: req.params.id, sourceLeadId: '',
          email: lead.email || '', company: lead.company || '',
          eventType: 'stage_changed', occurredAt: new Date().toISOString(),
          subject: `${displayStageFor(previousStage)} -> ${displayStageFor(nextStage)}`,
          content: '',
          metadata: JSON.stringify({
            fromStage: displayStageFor(previousStage), toStage: displayStageFor(nextStage),
            fromStageRaw: previousStage, toStageRaw: nextStage, trigger: 'manual',
          }),
        });
      } catch (activityError) {
        console.warn('[Leads PUT] saved, but stage-history append failed:', activityError.message);
      }
    }
    const previousNotes = String(priorRow[15] || '');
    const nextNotes = String(lead.notes || '').trim();
    if (nextNotes && nextNotes !== previousNotes.trim()) {
      try {
        await appendColdCallActivities([{
          eventId: stableActivityId('conversation-note', [req.params.id, nextNotes]),
          leadId: req.params.id, sourceLeadId: '', email: lead.email || priorRow[10] || '',
          company: lead.company || priorRow[6] || '', eventType: 'conversation_note',
          occurredAt: new Date().toISOString(), subject: 'Lead note updated', content: nextNotes,
          metadata: JSON.stringify({ trigger: 'crm_notes' }),
        }]);
      } catch (activityError) {
        console.warn('[Leads PUT] saved, but note activity failed:', activityError.message);
      }
    }
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

// Verifying the sheet exists and its header is intact costs a spreadsheets.get
// plus a header read — measured at ~780ms, paid on EVERY dashboard load for a
// check whose answer cannot change while the process runs. Guarded the same way
// ensureDemoPlaysHeader is: at most once per process.
let ceSheetChecked = false;
async function ensureColdEmailSheet() {
  if (ceSheetChecked) return;
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
    ceSheetChecked = true;
    const hResp = await s.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range:         `${CE_SHEET_NAME}!A1:W1`,
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
    range:         `${CE_SHEET_NAME}!A:A`,
  });
  (resp.data.values || []).forEach((row, i) => {
    if (i > 0 && row[0]) ceRowMap.set(row[0], i + 1);
  });
  return ceRowMap.get(id) || null;
}

// Dashboard list reads deliberately skip column P (siteContext). That scrape
// cache is used only by the sending agent, which reads the sheet directly.
// A blank placeholder preserves the existing A:W object shape without moving
// or modifying any Google Sheets data.
async function readColdEmailDashboardRows() {
  const response = await sheets().spreadsheets.values.batchGet({
    spreadsheetId: SPREADSHEET_ID,
    ranges: [`${CE_SHEET_NAME}!A:O`, `${CE_SHEET_NAME}!Q:W`],
  });
  const left = response.data.valueRanges?.[0]?.values || [];
  const right = response.data.valueRanges?.[1]?.values || [];
  const length = Math.max(left.length, right.length);
  return Array.from({ length }, (_, index) => [
    ...Array.from({ length: 15 }, (_value, column) => left[index]?.[column] || ''),
    '',
    ...Array.from({ length: 7 }, (_value, column) => right[index]?.[column] || ''),
  ]);
}

// The engagement-signal reader was removed: /api/proposalOpens used it for a
// second full ColdEmail read that the shared outreach snapshot now supplies.

// ── COLD EMAIL ROUTES ─────────────────────────────────────────────────────────

// ── SHARED OUTREACH DATASET ─────────────────────────────────────────────────
// The Outreach page used to read the ColdEmail sheet three times per load (the
// lead list, the stats card, and the reply drill-down each fetched it), plus
// DemoPlays twice. All of them now derive from this one cached snapshot.
//
// Freshness: a short TTL bounds staleness, and any write this process makes to
// ColdEmail or DemoPlays busts the cache synchronously (see sheets()), so a
// stage change or an import is visible on the very next read. The TTL only ever
// hides changes made OUTSIDE this process — e.g. someone editing the sheet by
// hand or the agent writing from its own process.
const OUTREACH_CACHE_TTL_MS = 30000;
let outreachCache = null;
let outreachCacheLoad = null;

function invalidateOutreachCache(reason) {
  if (outreachCache) console.log(`[outreach-cache] invalidated (${reason})`);
  outreachCache = null;
}

const CE_LIGHT_FIELDS = [
  'id', 'company', 'contactName', 'email', 'city', 'tradeType',
  'website', 'stage', 'emailStatus', 'lastEmailedAt', 'emailStep', 'campaign', 'leadNiche',
];

// Server-side mirror of the SPA's niche normaliser, so niche filtering can be
// answered without shipping every row to the browser.
function normalizedRouteNicheFor(lead) {
  const value = String(lead.leadNiche || lead.tradeType || '').trim().toLowerCase();
  if (value.includes('roof')) return 'roofing';
  if (value.includes('dent')) return 'dental';
  return value;
}

function campaignLabelFor(lead) {
  const value = String(lead.campaign || '').trim();
  return (!value || value.toLowerCase() === 'unlabeled') ? 'Unlabeled' : value;
}

// The row the table actually needs. Deliberately excludes notes, siteContext,
// campaign_notes and website: they are ~70% of the old payload and no column
// renders them. The two facts the UI DID read out of notes are precomputed
// here as flags instead.
function toLightRow(lead, category, attribution = {}) {
  const row = {};
  for (const field of CE_LIGHT_FIELDS) row[field] = lead[field] || '';
  row.replyCategory = category || '';
  row.lateReply = /\[LATE REPLY:/i.test(lead.notes || '');
  row.bounced = /\[BOUNCED/i.test(lead.notes || '');
  row.manualHold = /\[MANUAL HOLD\]/i.test(lead.notes || '');
  row.suppressed = row.bounced || /\[(?:UNSUBSCRIBED|SUPPRESSED|BOUNCED)/i.test(lead.notes || '') || /^(?:Unsub|Unsubscribed)$/i.test(lead.stage || '');
  row.campaignVersion = attribution.campaignVersion || LEGACY_UNKNOWN;
  row.campaignFamily = attribution.campaignFamily || '';
  return row;
}

// Join the two deliberately separate lead stores without using company names.
// A CE- foreign key on the board is authoritative. Exact normalized email is
// only a fallback, and duplicate candidates fail closed as a mapping conflict.
function buildOutreachPipelineIndex(coldEmailLeads, boardLeads) {
  const coldEmailByEmail = new Map();
  const push = (map, key, value) => {
    if (!key) return;
    const values = map.get(key) || [];
    values.push(value);
    map.set(key, values);
  };

  for (const lead of coldEmailLeads || []) push(coldEmailByEmail, normalizeEmail(lead.email), lead);

  const byColdEmailId = new Map();
  let ambiguousMappings = 0;
  for (const lead of coldEmailLeads || []) {
    const email = normalizeEmail(lead.email);
    const coldEmailTwins = email ? (coldEmailByEmail.get(email) || []) : [];
    const identity = resolvePromotionIdentity(lead, boardLeads, { coldEmailTwinCount: coldEmailTwins.length });
    const match = identity.boardLead;
    if (identity.status === 'conflict') ambiguousMappings++;
    byColdEmailId.set(lead.id, {
      pipelinePresence: Boolean(match),
      pipelineStage: match ? displayStageFor(match.stage) : '',
      boardLeadId: match ? match.id : '',
      mappingStatus: identity.status === 'conflict' ? 'conflict' : (match ? 'matched' : 'not_in_pipeline'),
      mappingReason: identity.reason || '',
      matchedBy: identity.matchedBy || '',
    });
  }
  return { byColdEmailId, ambiguousMappings };
}

function outreachSequenceState(lead) {
  const status = String(lead.emailStatus || '').trim().toLowerCase();
  const step = parseInt(lead.emailStep || '0', 10) || 0;
  if (status === 'done' || step > FOLLOW_UP_STEP_COUNT) return 'complete';
  if (status === 'emailed' && step >= 1 && step <= FOLLOW_UP_STEP_COUNT) return 'active';
  if (status === 'replied') return 'replied';
  if (String(lead.stage || '').toLowerCase() === 'queued') return 'queued';
  return 'not_started';
}

async function loadOutreachDataset() {
  await ensureColdEmailSheet();
  const rowObjects = (rows, header) => (rows || []).slice(1)
    .map(row => Object.fromEntries(header.map((field, column) => [field, row[column] || ''])));

  // One batch per tab, all in flight together — this is the whole external cost
  // of an Outreach load.
  const [ceRows, draftResponse, activityResponse, providerResponse, demoResponse,
         openResponse, engagedResponse, boardResponse] = await Promise.all([
    readColdEmailDashboardRows(),
    sheets().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'ReplyDrafts!A:L' }).catch(() => ({ data: {} })),
    sheets().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${COLD_CALL_ACTIVITY_SHEET}!A:J` }).catch(() => ({ data: {} })),
    sheets().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${PROVIDER_LEADS_SHEET}!A:N` }).catch(() => ({ data: {} })),
    sheets().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'DemoPlays!A:F' }).catch(() => ({ data: {} })),
    sheets().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'ProposalOpens!A:F' }).catch(() => ({ data: {} })),
    sheets().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'ProposalEngaged!A:F' }).catch(() => ({ data: {} })),
    sheets().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: AGENT_READ_RANGE }).catch(() => ({ data: {} })),
  ]);

  ceRowMap.clear();
  const leads = ceRows.slice(1).map((row, index) => {
    const lead = {};
    CE_COLUMNS.forEach((col, i) => { lead[col] = row[i] || ''; });
    if (lead.id) ceRowMap.set(lead.id, index + 2);
    return lead;
  }).filter(lead => lead.id);

  const activities = rowObjects(activityResponse.data.values, COLD_CALL_ACTIVITY_HEADER);
  const boardLeads = (boardResponse.data.values || []).slice(1).map(row => {
    const lead = {};
    COLUMNS.forEach((field, index) => { lead[field] = row[index] || ''; });
    return lead;
  }).filter(lead => lead.id);
  const pipelineIndex = buildOutreachPipelineIndex(leads, boardLeads);
  const classificationsByLeadId = buildStoredClassificationMap({
    drafts: rowObjects(draftResponse.data.values, ['createdAt','leadId','company','email','topic','confidence','reason','draftBody','status','campaignProfile','classification','reasonCode']),
    activities,
    providerMappings: rowObjects(providerResponse.data.values, PROVIDER_LEADS_HEADER),
  });

  // Counts and reply records come from the canonical analytics module, exactly
  // as before — this only changes how many times the sheet is read.
  const metrics = buildReplyMetrics(leads, { classificationsByLeadId });
  // Activities are indexed by lead so the canonical evidence hierarchy can run:
  // provider-backed reply activity outranks a legacy [REPLY: ...] tag.
  const activitiesByLeadId = new Map();
  for (const row of activities) {
    const key = String(row.sourceLeadId || '').trim() || String(row.leadId || '').replace(/^CE-/, '').trim();
    if (!key) continue;
    const bucket = activitiesByLeadId.get(key) || [];
    bucket.push(row);
    activitiesByLeadId.set(key, bucket);
  }
  const replyRecords = buildReplyRecords(leads, {
    classificationsByLeadId,
    evidenceByLeadId: buildReplyEvidenceMap(activities),
    activitiesByLeadId,
  });
  const categoryByLeadId = new Map(replyRecords.map(record => [record.leadId, record.category]));
  const campaignVersionByLeadId = buildCampaignVersionIndex(leads, activities);

  const counts = { queued: 0, emailed: 0, replied: metrics.totalReplies, done: 0 };
  const facets = { stages: {}, niches: {}, campaigns: {}, campaignVersions: {} };
  const leadKeys = new Set();
  const demoCompanyKeys = new Set((demoResponse.data.values || []).slice(1).map(row => openKey(row[1])).filter(Boolean));
  const realOpenCounts = new Map();
  const rows = leads.map(lead => {
    if (lead.stage === 'Queued') counts.queued++;
    if (lead.emailStatus) counts.emailed++;
    if (lead.emailStatus === 'done') counts.done++;
    const stage = lead.stage || 'Import';
    facets.stages[stage] = (facets.stages[stage] || 0) + 1;
    const niche = normalizedRouteNicheFor(lead);
    if (niche) facets.niches[niche] = (facets.niches[niche] || 0) + 1;
    const campaign = campaignLabelFor(lead);
    facets.campaigns[campaign] = (facets.campaigns[campaign] || 0) + 1;
    const companyKey = openKey(lead.company);
    if (companyKey) leadKeys.add(companyKey);
    const attribution = campaignVersionByLeadId.get(lead.id) || { campaignVersion: LEGACY_UNKNOWN };
    facets.campaignVersions[attribution.campaignVersion] = (facets.campaignVersions[attribution.campaignVersion] || 0) + 1;
    const row = toLightRow(lead, categoryByLeadId.get(lead.id), attribution);
    Object.assign(row, pipelineIndex.byColdEmailId.get(lead.id));
    row.demoEngaged = demoCompanyKeys.has(openKey(lead.company));
    row.sequenceState = outreachSequenceState(lead);
    const automation = deriveAutomationState(lead);
    row.automationState = automation.state;
    row.automationReason = automation.reason;
    return row;
  });
  counts.total = rows.length;

  // ── Open / warm signal, aggregated over the WHOLE dataset ────────────────
  // These headline numbers used to be computed in the browser from the full
  // lead array. Once the list was paginated that array became one page, so the
  // cards silently started describing 100 rows instead of 1,849. They are
  // aggregated here now, for the same reason the reply metrics always were:
  // a summary must not depend on which page happens to be loaded.
  //
  // Semantics preserved exactly from the previous client code:
  //   opens = DISTINCT companies with >= 1 real open, that match a lead
  //   hits  = sum of those companies' real opens (a prospect reloading counts once
  //           in `opens`, but every real hit shows in the label)
  //   warm  = those companies with >= 2 real opens
  // `real` excludes scanner detonations via the shared open-filter module.
  const proposalOpens = openResponse.data.values || [];
  const proposalEngaged = engagedResponse.data.values || [];
  const demoPlays = demoResponse.data.values || [];
  const demoRows = demoPlays.slice(1).map(row => ({
    timestamp: row[0] || '', company: row[1] || '', niche: row[2] || '',
    ip: row[3] || '', userAgent: row[4] || '', audioType: normalizeAudioType(row[5]),
  }));
  const openRows = proposalOpens.slice(1).map(row => ({
    timestamp: row[0] || '', company: row[1] || '', niche: row[2] || '',
    id: row[3] || '', ip: row[4] || '', userAgent: row[5] || '',
  }));
  const leadById = new Map(leads.map(lead => [lead.id, { lastEmailedAt: lead.lastEmailedAt }]));
  const leadByKey = new Map();
  for (const lead of leads) {
    const k = openKey(lead.company);
    if (k && !leadByKey.has(k)) leadByKey.set(k, { lastEmailedAt: lead.lastEmailedAt });
  }
  const annotatedOpens = annotateOpens({
    opens: openRows,
    keyOf: row => openKey(row.company),
    leadFor: row => (row.id && leadById.get(row.id)) || leadByKey.get(openKey(row.company)) || null,
    engagedRows: proposalEngaged.slice(1).map(row => ({ company: row[1] || '' })),
    demoRows: demoRows.map(row => ({ company: row.company })),
  });
  const realOpensByCompany = realOpenCounts;
  for (const open of annotatedOpens) {
    if (open.real === false) continue;
    const k = openKey(open.company);
    if (!k) continue;
    realOpensByCompany.set(k, (realOpensByCompany.get(k) || 0) + 1);
  }
  const signals = { opens: 0, hits: 0, warm: 0 };
  for (const [k, n] of realOpensByCompany) {
    if (!leadKeys.has(k)) continue;      // orphaned open rows are not lead opens
    signals.opens++;
    signals.hits += n;
    if (n >= 2) signals.warm++;
  }
  for (const row of rows) row.warm = (realOpensByCompany.get(openKey(row.company)) || 0) >= 2;
  const outside = rows.filter(row => !row.pipelinePresence && row.mappingStatus !== 'conflict');
  const pipelineAudit = {
    total: rows.length,
    inPipeline: rows.filter(row => row.pipelinePresence).length,
    notInPipeline: outside.length,
    positiveNotInPipeline: outside.filter(row => row.replyCategory === 'positive').length,
    needsHumanNotInPipeline: outside.filter(row => row.replyCategory === 'needs_human').length,
    demoEngagedNotInPipeline: outside.filter(row => row.demoEngaged).length,
    sequenceCompleteNotInPipeline: outside.filter(row => row.sequenceState === 'complete').length,
    activeSequenceNotInPipeline: outside.filter(row => row.sequenceState === 'active' || row.sequenceState === 'queued').length,
    ambiguousMappings: pipelineIndex.ambiguousMappings,
  };

  return {
    at: Date.now(),
    leads,                 // full rows, server-side only
    rows,                  // light rows, safe to serialise
    activities, classificationsByLeadId, replyRecords,
    metrics, counts, facets, signals,
    pipelineAudit, boardLeads,
    demoPlays, demoRows, proposalOpens, proposalEngaged,
    annotatedOpens,        // computed once; the Opens panel reuses it
  };
}

// Concurrent callers share one in-flight load rather than each starting their
// own — four parallel dashboard requests cost one set of reads, not four.
async function getOutreachDataset({ force = false } = {}) {
  if (!force && outreachCache && Date.now() - outreachCache.at < OUTREACH_CACHE_TTL_MS) return outreachCache;
  if (!force && outreachCacheLoad) return outreachCacheLoad;
  outreachCacheLoad = loadOutreachDataset()
    .then(dataset => { outreachCache = dataset; return dataset; })
    .finally(() => { outreachCacheLoad = null; });
  return outreachCacheLoad;
}

const DEFAULT_CE_PAGE = 100;
const MAX_CE_PAGE = 500;

function filterOutreachRows(rows, query) {
  const stage = String(query.stage || 'all');
  const campaign = String(query.campaign || '').trim();
  const campaignVersion = String(query.campaignVersion || '').trim();
  const niche = String(query.niche || 'all');
  const category = String(query.replyCategory || '').trim().toLowerCase();
  const pipelinePresence = String(query.pipelinePresence || '').trim().toLowerCase();
  const pipelineStage = String(query.pipelineStage || '').trim().toLowerCase();
  const engagement = String(query.engagement || '').trim().toLowerCase();
  const sequenceState = String(query.sequenceState || '').trim().toLowerCase();
  const automationState = String(query.automationState || '').trim().toLowerCase();
  const search = String(query.search || '').trim().toLowerCase();

  return rows.filter(row => {
    // 'Unsub' is what the agent writes and 'Unsubscribed' what the dashboard
    // shows; both must match the same tab or a lead becomes unreachable.
    if (stage !== 'all') {
      if (stage === 'Unsubscribed') { if (row.stage !== 'Unsubscribed' && row.stage !== 'Unsub') return false; }
      else if (row.stage !== stage) return false;
    }
    if (campaign && campaignLabelFor(row) !== campaign) return false;
    if (campaignVersion && campaignVersion !== 'all' && row.campaignVersion !== campaignVersion) return false;
    if (niche !== 'all' && normalizedRouteNicheFor(row) !== niche) return false;
    if (category === 'none') { if (row.replyCategory) return false; }
    else if (category && category !== 'all' && row.replyCategory !== category) return false;
    if (pipelinePresence === 'in' && !row.pipelinePresence) return false;
    if (pipelinePresence === 'out' && (row.pipelinePresence || row.mappingStatus === 'conflict')) return false;
    if (pipelinePresence === 'conflict' && row.mappingStatus !== 'conflict') return false;
    if (pipelineStage && pipelineStage !== 'all' && row.pipelineStage !== pipelineStage) return false;
    if (engagement === 'demo' && !row.demoEngaged) return false;
    if (engagement === 'warm' && !row.warm) return false;
    if (engagement === 'none' && (row.demoEngaged || row.warm)) return false;
    if (sequenceState && sequenceState !== 'all' && row.sequenceState !== sequenceState) return false;
    if (automationState === 'suppressed' && !row.suppressed) return false;
    else if (automationState === 'held' && !row.manualHold) return false;
    else if (automationState && !['all','suppressed','held'].includes(automationState) && row.automationState !== automationState) return false;
    if (search && ![row.company, row.email, row.contactName, row.website]
      .some(field => field && String(field).toLowerCase().includes(search))) return false;
    return true;
  });
}

// Bounded, filtered page of light rows. Filtering happens here rather than in
// the browser so a search never ships 1,849 records to find three.
// `limit=0` returns every matching light row — used only by the Campaigns
// panel, which genuinely aggregates across the whole set.
app.get('/api/coldemail', requireAuth, async (req, res) => {
  try {
    const dataset = await withAuth(() => getOutreachDataset({ force: req.query.refresh === '1' }));
    const filtered = filterOutreachRows(dataset.rows, req.query);
    const requested = req.query.limit === undefined ? DEFAULT_CE_PAGE : parseInt(req.query.limit, 10);
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_CE_PAGE) : 0;
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const page = limit ? filtered.slice(offset, offset + limit) : filtered;
    res.json({
      leads: page,
      total: filtered.length,
      totalUnfiltered: dataset.rows.length,
      offset, limit,
      hasMore: limit ? offset + page.length < filtered.length : false,
      counts: dataset.counts,
      facets: dataset.facets,
      pipelineAudit: dataset.pipelineAudit,
      fetchedAt: new Date(dataset.at).toISOString(),
    });
  } catch (e) {
    if (e.isAuthError) return res.status(401).json({ error: 'unauthenticated' });
    console.error('[ColdEmail GET]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/campaign-versions', requireAuth, (req, res) => {
  res.json({ active: ACTIVE_CAMPAIGN_VERSION, versions: CAMPAIGN_VERSIONS });
});

// Campaign performance is derived entirely from the shared Outreach snapshot.
// The cohort is anchored to successful send activities, never the visible page
// and never an inferred timestamp/version. `stage` returns a bounded exact-lead
// drill-down without shipping activity bodies or the complete dataset.
app.get('/api/coldemail/funnel', requireAuth, async (req, res) => {
  try {
    const startedAt = process.hrtime.bigint();
    const dataset = await withAuth(() => getOutreachDataset({ force: req.query.refresh === '1' }));
    const analytics = buildFunnelAnalytics({
      leads: dataset.leads, boardLeads: dataset.boardLeads, activities: dataset.activities,
      replyRecords: dataset.replyRecords,
      currentVersion: ACTIVE_CAMPAIGN_VERSION.dental_ai_receptionist,
    }, req.query);
    const stage = String(req.query.stage || '').trim();
    const requested = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    let records;
    let stageTotal;
    if (stage && analytics.stageLeadIds[stage]) {
      const ids = analytics.stageLeadIds[stage]; stageTotal = ids.length;
      const rowById = new Map(dataset.rows.map(row => [row.id, row]));
      // Project to exactly what the drill-down list renders. Whole ColdEmail
      // rows carry notes/siteContext/campaign_notes blobs, which made a single
      // 100-row page ~194 KB; the five displayed fields are ~10 KB. The lead
      // detail drawer already loads the full record on demand.
      records = ids.slice(offset, offset + requested).map(id => rowById.get(id)).filter(Boolean)
        .map(row => ({
          id: row.id, company: row.company, contactName: row.contactName,
          email: row.email, stage: row.stage, pipelineStage: row.pipelineStage,
        }));
    }
    delete analytics.stageLeadIds;
    res.json({
      ...analytics,
      ...(records ? { stage, records, pagination: { total: stageTotal, offset, limit: requested, hasMore: offset + records.length < stageTotal } } : {}),
      generatedMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
      fetchedAt: new Date(dataset.at).toISOString(),
    });
  } catch (error) {
    if (error.isAuthError) return res.status(401).json({ error: 'unauthenticated' });
    console.error('[Funnel Analytics GET]', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── CRM HEALTH (Step 14) ────────────────────────────────────────────────────
// Read-only diagnostics. Detects problems; never repairs them. There is
// deliberately no companion POST/repair route: everything here answers "what
// requires investigation", and acting on it stays a human decision.
//
// Runs entirely off the shared Outreach snapshot plus two small reads that are
// already cached elsewhere, so opening the health panel costs no extra Sheets
// traffic per lead.
app.get('/api/crm/health', requireAuth, async (req, res) => {
  try {
    const startedAt = process.hrtime.bigint();
    const dataset = await withAuth(() => getOutreachDataset({ force: req.query.refresh === '1' }));
    // The sender's OWN suppression rule, bound to the live suppression list, so
    // health cannot disagree with what the sender would actually do.
    const suppressedEmails = await loadSuppressedEmails();
    const calendarSyncState = CALENDAR_SYNC_ENABLED
      ? await readCalendarSyncState().catch(() => null)
      : null;
    // The funnel is CONSUMED, never rebuilt: reconciliation has one owner.
    const funnel = buildFunnelAnalytics({
      leads: dataset.leads, boardLeads: dataset.boardLeads, activities: dataset.activities,
      replyRecords: dataset.replyRecords,
      currentVersion: ACTIVE_CAMPAIGN_VERSION.dental_ai_receptionist,
    }, { version: 'lifetime' });

    const health = buildCrmHealth({
      leads: dataset.leads, boardLeads: dataset.boardLeads, activities: dataset.activities,
      replyRecords: dataset.replyRecords,
      suppressionReason: lead => sendSuppressionReason(lead, { suppressedEmails }),
      sequencesEnabled: process.env.STAGE_SEQUENCES_ENABLED === 'true',
      calendarSyncEnabled: CALENDAR_SYNC_ENABLED,
      bookingCalendarId: BOOKING_CALENDAR_ID,
      appointmentScheduleId: BOOKING_APPOINTMENT_SCHEDULE_ID,
      calendarSyncState,
      canonicalReplyBoundary: process.env.CANONICAL_REPLY_BOUNDARY || null,
      funnel,
    });

    // Drill-down: one check's full affected set, bounded and paginated exactly
    // like every other list endpoint in this CRM.
    const checkId = String(req.query.check || '').trim();
    let drill;
    if (checkId) {
      const requested = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
      const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
      const match = health.findings.find(item => item.id === checkId);
      const rows = match ? match.sample : [];
      drill = {
        check: checkId,
        records: rows.slice(offset, offset + requested),
        pagination: {
          total: match ? match.affected : 0, offset, limit: requested,
          hasMore: offset + Math.min(rows.length, requested) < (match ? match.affected : 0),
          sampleOnly: Boolean(match && match.sampleTruncated),
        },
      };
    }

    res.json({
      ...health,
      ...(drill ? { drill } : {}),
      generatedMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
      fetchedAt: new Date(dataset.at).toISOString(),
    });
  } catch (error) {
    if (error.isAuthError) return res.status(401).json({ error: 'unauthenticated' });
    console.error('[CRM Health GET]', error.message);
    res.status(500).json({ error: error.message });
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
    sheets().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: CE_COL_RANGE }),
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
    // Served from the shared snapshot rather than its own read.
    const rows = (await getOutreachDataset()).demoPlays;
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
    // Annotated once inside the shared snapshot, so the Opens panel and the
    // Opens/Warm cards can never disagree about what counts as a real open.
    const dataset = await getOutreachDataset();
    res.json(dataset.annotatedOpens);
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
  const { rows, campaign, campaign_notes, lead_niche } = req.body || {};
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'body.rows must be an array' });
  if (!campaign || !String(campaign).trim()) return res.status(422).json({ error: 'Campaign name is required' });
  const leadNiche = normalizeNiche(lead_niche);
  if (!leadNiche) return res.status(422).json({ error: 'Lead niche is required' });
  const campaignName  = String(campaign).trim();
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
          leadNiche, senderInboxId: '', emailTemplateId: '', routingRequired: 'true',
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

// A board lead and its ColdEmail row are separate records; the ColdEmail one is
// what the sending agent gates on. Match by the CE- id first (exact, set at
// promotion time) and fall back to email, which is how a hand-added board lead
// lines up with an imported one. Reads only A:L — the columns that decide
// sending — so this stays one cheap call.
// Returns EVERY ColdEmail row that belongs to this board lead, each carrying its
// 1-based sheet row so a caller can write to it.
//
// Matching is deliberately limited to two exact keys, in this order:
//   1. the CE- foreign key stamped on the board row at promotion time, and
//   2. the normalized email address.
// Company name is never used: near-identical practice names are common in this
// data, and a fuzzy match would suppress an unrelated contact. An address with
// duplicate ColdEmail rows yields all of them, because holding only one of a
// duplicated pair would still leak a send.
async function findColdEmailTwins(boardLeadId, boardEmail) {
  const wanted = String(boardLeadId || '').replace(/^CE-/, '');
  const email = normalizeEmail(boardEmail || '');
  const response = await sheets().spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID, range: `${CE_SHEET_NAME}!A:L`,
  });
  const rows = (response.data.values || []).slice(1);
  const matches = [];
  rows.forEach((row, index) => {
    const twin = {
      id: row[0] || '', company: row[1] || '', email: row[3] || '',
      stage: row[7] || '', emailStatus: row[8] || '', lastEmailedAt: row[9] || '',
      emailStep: row[10] || '', notes: row[11] || '',
      _row: index + 2, // +1 for the header, +1 for 1-based rows
    };
    const idHit = Boolean(wanted) && twin.id === wanted;
    const emailHit = Boolean(email) && normalizeEmail(twin.email) === email;
    if (idHit || emailHit) matches.push({ ...twin, _matchedBy: idHit ? 'id' : 'email' });
  });
  // An id match is the authoritative one, so it sorts first.
  matches.sort((a, b) => (a._matchedBy === 'id' ? -1 : 0) - (b._matchedBy === 'id' ? -1 : 0));
  return matches;
}

// The single twin that governs this lead — the id match when there is one.
async function findColdEmailTwin(boardLeadId, boardEmail) {
  const matches = await findColdEmailTwins(boardLeadId, boardEmail);
  return matches.length ? matches[0] : null;
}

// How many follow-up steps the sequence actually has. Mirrors FOLLOW_UP_SEQUENCE
// in outreach-agent.js via the shared cadence constant, so "is there a next
// step?" can never disagree with what the agent would really send.
const FOLLOW_UP_STEP_COUNT = FOLLOW_UP_DELAY_DAYS.length;
// The canonical 'ghosted' loss outcome, asserted against the shared taxonomy so
// a rename there fails loudly here instead of silently writing a dead value.
const GHOSTED_OUTCOME = 'ghosted';
if (!LOSS_OUTCOME_IDS.includes(GHOSTED_OUTCOME)) {
  throw new Error('pipeline-state no longer defines a "ghosted" loss outcome');
}
// A resume date beyond this is almost certainly a typo (a mis-parsed year).
const REACTIVATION_MAX_HORIZON_MS = 365 * 24 * 60 * 60 * 1000;

// STRICT suppression read for the reactivation path. loadSuppressedEmails()
// deliberately returns an empty set when the tab cannot be read, which is right
// for a send-time check layered behind the notes tags — but here an empty set
// would make a suppressed lead look reactivatable. So this one throws, and the
// endpoint turns that into a refusal: fail closed.
async function loadSuppressionEmails() {
  const response = await sheets().spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID, range: `${SUPPRESSION_SHEET}!A:A`,
  });
  return new Set((response.data.values || []).slice(1)
    .map(row => (row[0] || '').toLowerCase().trim()).filter(Boolean));
}

// Writes the notes cell for exactly one ColdEmail row. Column L only — the
// same single cell applyManualHold touches, so no other lead state can move.
async function writeColdEmailNotes(twin, notes) {
  await sheets().spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${CE_SHEET_NAME}!L${twin._row}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[notes]] },
  });
}

// Append-only audit row. The event id is derived from the lead, the mode and the
// resume instant, so re-submitting the same decision cannot stack duplicates.
async function recordReactivationEvent(boardLeadId, twin, { eventType, email, company, subject, metadata }) {
  const fingerprint = [boardLeadId, twin.id, eventType, metadata.mode, metadata.resumeAt || metadata.cancelledResumeAt || ''].join('|');
  await appendIntegrationRow(COLD_CALL_ACTIVITY_SHEET, COLD_CALL_ACTIVITY_HEADER, {
    eventId: 'reactivation:' + crypto.createHash('sha1').update(fingerprint).digest('hex').slice(0, 24),
    leadId: boardLeadId, sourceLeadId: twin.id,
    email: email || '', company: company || '',
    eventType, occurredAt: new Date().toISOString(),
    subject: subject || '', content: '',
    metadata: JSON.stringify(metadata),
  });
}

// ── REACTIVATION ────────────────────────────────────────────────────────────
// Turning cold-email automation back on for a held lead. The dangerous version
// of this is "delete the [MANUAL HOLD] tag": selectFollowUps() only asks whether
// delayDays have elapsed since lastEmailedAt, so a lead held two weeks past a
// three-day delay is already overdue and fires on the next pass.
//
// So nothing here removes the hold. Scheduling writes a [RESUME: <iso>] tag
// BESIDE it, and the agent's suppressionReason() keeps reporting the hold until
// that instant arrives. Consequences worth stating plainly:
//
//   * It is ONE cell write. There is no ordering in which the lead ends up
//     unheld-and-ungated, so the partial-failure case cannot exist.
//   * The write only ever ADDS a time-gated permission. If it half-succeeds,
//     lands twice, or is rolled back, the lead stays held. Fail-closed.
//   * Cancelling removes the resume tag and leaves the hold — strictly a
//     reduction in eligibility.
//
// Nothing in this file can send: reactivation schedules eligibility and the
// sending agent remains the only thing that mails anyone, through all of its
// existing cadence, cap and suppression checks.

// Which ColdEmail twin should resume? Duplicates exist because the same address
// can be imported more than once, and applyManualHold deliberately holds ALL of
// them. Reactivation must not blindly reverse that: only a row that is actually
// mid-sequence can resume, and if two of them are, the situation is ambiguous
// and a human has to look.
function resolveReactivationTarget(twins, opts = {}) {
  const rows = twins || [];
  if (!rows.length) return { ok: false, code: 'no_twin', message: 'No ColdEmail record is linked to this lead.' };

  const scored = rows.map(twin => ({ twin, eligibility: reactivationEligibility(twin, opts) }));
  const suppressed = scored.find(entry => entry.eligibility.blocked === 'suppressed');
  if (suppressed) {
    // One opted-out duplicate poisons the address for all of them: the
    // suppression list is keyed by email, not by row.
    return { ok: false, code: 'suppressed', message: suppressed.eligibility.reason, eligibility: suppressed.eligibility };
  }

  const held = scored.filter(entry => entry.eligibility.eligible);
  if (!held.length) {
    const first = scored[0].eligibility;
    return { ok: false, code: first.blocked || 'not_held', message: first.reason, eligibility: first };
  }

  const resumable = held.filter(entry => entry.eligibility.canSchedule);
  if (resumable.length > 1) {
    return {
      ok: false, code: 'ambiguous_twins',
      message: `${resumable.length} duplicate ColdEmail rows for this address are mid-sequence. `
        + 'Automated resume is blocked until the duplicates are reconciled by hand.',
      candidates: resumable.map(entry => ({ id: entry.twin.id, emailStatus: entry.twin.emailStatus, emailStep: entry.twin.emailStep })),
    };
  }
  // Exactly one row can resume, or none can and only a human reopen is offered.
  const chosen = resumable[0] || held[0];
  return { ok: true, twin: chosen.twin, eligibility: chosen.eligibility, heldCount: held.length };
}

// Writes [MANUAL HOLD] into the notes of every ColdEmail row for this lead.
// ensureNote is idempotent, so re-saving a card already on hold rewrites nothing
// and logs nothing. Returns the rows actually changed.
async function applyManualHold(boardLeadId, boardEmail) {
  const twins = await findColdEmailTwins(boardLeadId, boardEmail);
  const changed = [];
  for (const twin of twins) {
    const updated = applyHoldToNotes(twin.notes || '');
    if (updated === (twin.notes || '')) continue;   // already held — no write, no event
    await sheets().spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${CE_SHEET_NAME}!L${twin._row}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[updated]] },
    });
    changed.push({ id: twin.id, row: twin._row, matchedBy: twin._matchedBy, emailStatus: twin.emailStatus });
  }
  return changed;
}

function activityMatchesLead(row, lead) {
  const id = String(lead.id || '').replace(/^CE-/, '');
  const rowIds = [row.leadId, row.sourceLeadId].map(value => String(value || '').replace(/^CE-/, ''));
  const email = normalizeEmail(lead.email || '');
  return rowIds.includes(id) || (email && normalizeEmail(row.email) === email);
}

function signalMatchesLead(row, lead) {
  const id = String(lead.id || '').replace(/^CE-/, '');
  if (row.id) return String(row.id).replace(/^CE-/, '') === id;
  return Boolean(openKey(lead.company) && openKey(row.company) === openKey(lead.company));
}

function timelineForLead(lead, dataset, activities, signalLead = lead) {
  const opens = (dataset?.annotatedOpens || []).filter(row => row.real !== false && signalMatchesLead(row, signalLead));
  const demos = (dataset?.demoRows || []).filter(row => signalMatchesLead(row, signalLead));
  return buildActivityTimeline({ lead, activities, opens, demos });
}

app.get('/api/leads/:id/activity', requireAuth, async (req, res) => {
  try {
    const rowNum = await withAuth(() => findRow(req.params.id));
    if (!rowNum) return res.status(404).json({ error: 'not found' });
    const leadResponse = await sheets().spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A${rowNum}:W${rowNum}`,
    });
    const leadRow = leadResponse.data.values?.[0] || [];
    const lead = {};
    COLUMNS.forEach((col, i) => { lead[col] = leadRow[i] || ''; });
    AGENT_COLS.forEach((col, i) => { lead[col] = leadRow[17 + i] || ''; });
    CALL_DETAIL_COLS.forEach((col, i) => { lead[col] = leadRow[20 + i] || ''; });
    const email = normalizeEmail(lead.email);
    const rows = await readIntegrationRows(COLD_CALL_ACTIVITY_SHEET, COLD_CALL_ACTIVITY_HEADER);
    const activities = rows
      .filter(row => row.leadId === req.params.id || (email && normalizeEmail(row.email) === email))
      .sort((a, b) => new Date(b.occurredAt || 0) - new Date(a.occurredAt || 0))
      .map(({ _row, ...row }) => row);
    // Derived, never stored: the board row and the ColdEmail row can disagree,
    // and the UI needs to show which one actually governs what happens next.
    let pipeline = null;
    let twin = null;
    try {
      twin = await findColdEmailTwin(req.params.id, lead.email);
      pipeline = {
        automation: deriveAutomationState(twin),
        conflict: automationConflict(lead, twin),
        nextAction: deriveNextAction(lead, twin, { activities }),
        acquisition: acquisitionAttribution(activities),
        reopen: reopenEligibility(lead, twin),
        twin: twin ? { id: twin.id, emailStatus: twin.emailStatus, emailStep: twin.emailStep, lastEmailedAt: twin.lastEmailedAt } : null,
      };
    } catch (stateError) {
      // Derivation is additive: a failure here must not break the timeline.
      console.warn('[pipeline-state] derivation failed:', stateError.message);
    }
    const dataset = await getOutreachDataset();
    const timelineLead = twin ? {
      ...lead, lastEmailedAt: twin.lastEmailedAt || lead.lastEmailedAt,
      emailStep: twin.emailStep || lead.emailStep, emailStatus: twin.emailStatus || lead.emailStatus,
    } : lead;
    const timeline = timelineForLead(timelineLead, dataset, activities, twin || lead);
    res.json({
      activities: timeline, leadScore: scoreColdCallLead(lead, activities), pipeline,
      integrity: inspectActivityIntegrity(activities, new Set([lead.id, twin?.id].filter(Boolean))),
    });
  } catch (e) {
    console.error('[Cold call activity GET]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── NEXT ACTION QUEUE ───────────────────────────────────────────────────────
// One Next Action for every board lead, derived from the same shared engine the
// drawer uses. Read-only: three sheet reads, no writes, no send path. This is
// what turns the board into a work queue and what the leak audit runs against.
app.get('/api/leads/next-actions', requireAuth, async (_req, res) => {
  try {
    const [boardResponse, ceResponse, activityResponse] = await Promise.all([
      sheets().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: AGENT_READ_RANGE }),
      sheets().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${CE_SHEET_NAME}!A:L` }),
      sheets().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${COLD_CALL_ACTIVITY_SHEET}!A:J` })
        .catch(() => ({ data: {} })),
    ]);

    const leads = (boardResponse.data.values || []).slice(1).map(row => {
      const lead = {};
      COLUMNS.forEach((col, i) => { lead[col] = row[i] || ''; });
      AGENT_COLS.forEach((col, i) => { lead[col] = row[17 + i] || ''; });
      CALL_DETAIL_COLS.forEach((col, i) => { lead[col] = row[20 + i] || ''; });
      return lead;
    }).filter(lead => lead.id);

    // Index the ColdEmail twins once by id and by email — the same two keys
    // findColdEmailTwins matches on, without a read per lead.
    const twinsById = new Map();
    const twinsByEmail = new Map();
    for (const row of (ceResponse.data.values || []).slice(1)) {
      const twin = {
        id: row[0] || '', company: row[1] || '', email: row[3] || '',
        stage: row[7] || '', emailStatus: row[8] || '', lastEmailedAt: row[9] || '',
        emailStep: row[10] || '', notes: row[11] || '',
      };
      if (twin.id && !twinsById.has(twin.id)) twinsById.set(twin.id, twin);
      const key = normalizeEmail(twin.email);
      if (key && !twinsByEmail.has(key)) twinsByEmail.set(key, twin);
    }

    const activitiesByKey = new Map();
    for (const row of (activityResponse.data.values || []).slice(1)) {
      const event = Object.fromEntries(COLD_CALL_ACTIVITY_HEADER.map((field, i) => [field, row[i] || '']));
      for (const key of [event.leadId, normalizeEmail(event.email)]) {
        if (!key) continue;
        const rows = activitiesByKey.get(key) || [];
        rows.push(event);
        activitiesByKey.set(key, rows);
      }
    }

    const now = new Date();
    const entries = leads.map(lead => {
      const email = normalizeEmail(lead.email);
      const twin = twinsById.get(String(lead.id).replace(/^CE-/, '')) || twinsByEmail.get(email) || null;
      const activities = [
        ...(activitiesByKey.get(lead.id) || []),
        ...(email ? activitiesByKey.get(email) || [] : []),
      ];
      return {
        id: lead.id,
        name: `${lead.first || ''} ${lead.last || ''}`.trim() || lead.company || lead.email || lead.id,
        company: lead.company || '',
        stage: displayStageFor(lead.stage),
        nextAction: deriveNextAction(lead, twin, { activities, now }),
      };
    });

    entries.sort((a, b) => compareNextActions(a.nextAction, b.nextAction));
    res.json({ generatedAt: now.toISOString(), summary: summarizeNextActions(entries), entries });
  } catch (e) {
    if (e.isAuthError) return res.status(401).json({ error: 'unauthenticated' });
    console.error('[Next Actions GET]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET the reactivation options for a lead — what the drawer renders, decided
// server-side so the browser never invents an option the server would reject.
app.get('/api/leads/:id/reactivation', requireAuth, async (req, res) => {
  try {
    const rowNum = await withAuth(() => findRow(req.params.id));
    if (!rowNum) return res.status(404).json({ error: 'not found' });
    const leadResponse = await sheets().spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A${rowNum}:W${rowNum}`,
    });
    const row = leadResponse.data.values?.[0] || [];
    const email = row[10] || '';
    const twins = await findColdEmailTwins(req.params.id, email);
    const suppressedEmails = await loadSuppressionEmails().catch(() => null);
    if (!suppressedEmails) {
      return res.json({ leadId: req.params.id, ok: false, code: 'suppression_unavailable',
        message: 'Suppression list unavailable — reactivation options are hidden.', twinCount: twins.length });
    }
    const target = resolveReactivationTarget(twins, { suppressedEmails });
    res.json({
      leadId: req.params.id,
      ok: target.ok,
      code: target.code || null,
      message: target.message || '',
      candidates: target.candidates || null,
      twinCount: twins.length,
      eligibility: target.eligibility || null,
      twin: target.twin
        ? {
            id: target.twin.id, emailStatus: target.twin.emailStatus,
            emailStep: target.twin.emailStep, lastEmailedAt: target.twin.lastEmailedAt,
            company: target.twin.company,
          }
        : null,
      stepCount: FOLLOW_UP_STEP_COUNT,
    });
  } catch (e) {
    if (e.isAuthError) return res.status(401).json({ error: 'unauthenticated' });
    console.error('[Reactivation GET]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Apply a reactivation decision. Every precondition is re-checked here — the
// browser's view of eligibility is a convenience, never the authority.
app.post('/api/leads/:id/reactivate', requireAuth, async (req, res) => {
  const mode = String(req.body?.mode || '');
  try {
    if (!Object.values(REACTIVATION_MODES).includes(mode)) {
      return res.status(400).json({ error: `Unknown reactivation mode "${mode}".`, field: 'mode' });
    }

    const rowNum = await withAuth(() => findRow(req.params.id));
    if (!rowNum) return res.status(404).json({ error: 'not found' });
    const leadResponse = await sheets().spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A${rowNum}:W${rowNum}`,
    });
    const row = leadResponse.data.values?.[0] || [];
    const email = row[10] || '';
    const company = row[6] || '';

    const twins = await findColdEmailTwins(req.params.id, email);
    let suppressedEmails;
    try {
      suppressedEmails = await loadSuppressionEmails();
    } catch (suppressionError) {
      // Cannot prove the lead is not opted out, so do not reactivate it.
      return res.status(503).json({
        error: 'The suppression list could not be read, so reactivation is refused.',
        code: 'suppression_unavailable',
      });
    }
    const target = resolveReactivationTarget(twins, { suppressedEmails });
    if (!target.ok) {
      // 409 for "the data says no", 400 for a malformed ask.
      const status = target.code === 'no_twin' ? 404 : 409;
      return res.status(status).json({ error: target.message, code: target.code, candidates: target.candidates || undefined });
    }

    const { twin, eligibility } = target;

    // ── Option A: reopen for human work, automation stays held ──────────────
    // Deliberately writes nothing to ColdEmail. The hold survives untouched,
    // which is exactly what makes this the safe default.
    if (mode === REACTIVATION_MODES.KEEP_MANUAL) {
      await recordReactivationEvent(req.params.id, twin, {
        eventType: 'reactivation_scheduled', email, company,
        subject: 'Reopened for human follow-up',
        metadata: { mode, resumeAt: null, automationResumed: false, coldEmailId: twin.id,
          emailStepAtDecision: twin.emailStep, previousStage: row[12] || '', trigger: 'crm_reactivate' },
      });
      return res.json({ ok: true, mode, automationHeld: true, resumeAt: null,
        message: 'Reopened for human follow-up. Cold-email automation stays paused.' });
    }

    // ── Option C (cancel): back to an indefinite hold ────────────────────────
    if (mode === REACTIVATION_MODES.CANCEL) {
      if (!eligibility.canCancel) {
        return res.status(409).json({ error: 'This lead has no scheduled reactivation to cancel.', code: 'not_scheduled' });
      }
      const cleared = clearResumeFromNotes(twin.notes || '');
      await writeColdEmailNotes(twin, cleared);
      await recordReactivationEvent(req.params.id, twin, {
        eventType: 'reactivation_cancelled', email, company,
        subject: 'Scheduled reactivation cancelled',
        metadata: { mode, cancelledResumeAt: eligibility.resumeAt, coldEmailId: twin.id,
          emailStepAtDecision: twin.emailStep, trigger: 'crm_reactivate' },
      });
      return res.json({ ok: true, mode, automationHeld: true, resumeAt: null,
        message: 'Scheduled reactivation cancelled. The lead is held indefinitely again.' });
    }

    // ── Option B: schedule automation to resume ─────────────────────────────
    if (!eligibility.canSchedule) {
      return res.status(409).json({
        error: eligibility.reason, code: 'no_resumable_step',
        detail: 'Automated resume needs a sent step with a following step in the sequence.',
      });
    }
    const resumeAtRaw = String(req.body?.resumeAt || '');
    const resumeMs = new Date(resumeAtRaw).getTime();
    if (!resumeAtRaw || !Number.isFinite(resumeMs)) {
      return res.status(400).json({ error: 'A valid resume date/time is required.', field: 'resumeAt' });
    }
    if (resumeMs > Date.now() + REACTIVATION_MAX_HORIZON_MS) {
      return res.status(400).json({ error: 'Resume date is further out than a year.', field: 'resumeAt' });
    }
    // A requested step is accepted only if it matches the step the sequence
    // would genuinely send next. Nothing here rewrites emailStep: the sheet
    // already records the last step that went out, so resuming cannot reset to
    // step 1 or repeat a step that was already sent.
    const requestedStep = req.body?.resumeStep === undefined ? eligibility.nextStep : parseInt(req.body.resumeStep, 10);
    if (requestedStep !== eligibility.nextStep) {
      return res.status(400).json({
        error: `Step ${requestedStep} is not the next step for this lead; the sequence resumes at step ${eligibility.nextStep}.`,
        field: 'resumeStep', nextStep: eligibility.nextStep,
      });
    }

    // THE write. One cell. It adds a time gate beside a hold that stays in
    // place, so there is no instant at which this lead is sendable earlier than
    // the chosen time — including if this request is retried or lands twice.
    const scheduled = applyResumeToNotes(twin.notes || '', new Date(resumeMs).toISOString());
    await writeColdEmailNotes(twin, scheduled);

    await recordReactivationEvent(req.params.id, twin, {
      eventType: 'reactivation_scheduled', email, company,
      subject: `Automation resumes ${new Date(resumeMs).toISOString()}`,
      metadata: {
        mode, resumeAt: new Date(resumeMs).toISOString(), resumeStep: eligibility.nextStep,
        coldEmailId: twin.id, emailStepAtDecision: twin.emailStep,
        lastEmailedAt: twin.lastEmailedAt, previousStage: row[12] || '',
        heldRowsForAddress: target.heldCount, trigger: 'crm_reactivate',
      },
    });

    res.json({
      ok: true, mode, automationHeld: true,
      resumeAt: new Date(resumeMs).toISOString(),
      resumeStep: eligibility.nextStep,
      message: `Automation may resume at step ${eligibility.nextStep} from ${new Date(resumeMs).toISOString()}. Nothing sends before then.`,
    });
  } catch (e) {
    if (e.isAuthError) return res.status(401).json({ error: 'unauthenticated' });
    console.error('[Reactivate POST]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Record that a human answered this prospect. The CRM previously had no way to
// tell "they replied" from "we replied": the only human-side event was
// conversation_note, which means "someone edited the notes field". Without that
// distinction a Hot lead's waiting-on state cannot be derived at all.
//
// This RECORDS an interaction that already happened elsewhere (an inbox, a
// phone). It sends nothing, and it deliberately writes no lead state — the
// staleness clock is derived from the activity row, not stored on the lead.
app.post('/api/leads/:id/human-response', requireAuth, async (req, res) => {
  try {
    const rowNum = await withAuth(() => findRow(req.params.id));
    if (!rowNum) return res.status(404).json({ error: 'not found' });
    const response = await sheets().spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A${rowNum}:W${rowNum}`,
    });
    const row = response.data.values?.[0] || [];
    const note = String(req.body?.note || '').trim().slice(0, 2000);
    const occurredAtRaw = String(req.body?.occurredAt || '').trim();
    const occurredMs = occurredAtRaw ? new Date(occurredAtRaw).getTime() : Date.now();
    if (!Number.isFinite(occurredMs)) {
      return res.status(400).json({ error: 'Invalid response time.', field: 'occurredAt' });
    }
    if (occurredMs > Date.now() + 60000) {
      return res.status(400).json({ error: 'A response cannot be recorded in the future.', field: 'occurredAt' });
    }
    const occurredAt = new Date(occurredMs).toISOString();

    // Minute-resolution id: logging the same response twice cannot stack rows,
    // but two genuinely separate replies on the same day still both record.
    const eventId = stableActivityId('human-response', [req.params.id, occurredAt.slice(0, 16), note]);
    const existing = await readIntegrationRows(COLD_CALL_ACTIVITY_SHEET, COLD_CALL_ACTIVITY_HEADER);
    if (existing.some(activity => activity.eventId === eventId)) {
      return res.json({ ok: true, duplicate: true, eventId, occurredAt });
    }
    await appendColdCallActivities([{
      eventId, leadId: req.params.id, sourceLeadId: '',
      email: row[10] || '', company: row[6] || '',
      eventType: 'human_response_sent', occurredAt,
      subject: 'Response sent to prospect', content: note,
      metadata: JSON.stringify({ direction: 'outbound', actor: 'human', trigger: 'crm_log_response' }),
    }]);
    res.json({ ok: true, duplicate: false, eventId, occurredAt });
  } catch (e) {
    if (e.isAuthError) return res.status(401).json({ error: 'unauthenticated' });
    console.error('[Human response]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Resolve a dead Hot opportunity as Closed Lost / Ghosted. NOTHING about
// staleness triggers this: the Hot clock only surfaces the decision, and a
// human has to confirm it. Time passing is not proof a deal is lost.
//
// This composes the canonical pieces rather than adding a second stage-mutation
// system: stageTransitionCheck is the same gate PUT /api/leads/:id uses,
// stageRequiresHold + applyManualHold are the same hold writer, and the
// timeline gets the same stage_changed event shape.
//
// It exists as its own route because the transition needs BOTH cells: the gate
// refuses closed_lost without a loss outcome, and PUT writes A:Q while the
// outcome lives in V. Doing that from the browser would be two requests with a
// race between them. Here it is one read, one validated batch write.
// ── GOOGLE CALENDAR BOOKING SYNC ────────────────────────────────────────────
// Google Calendar is the booking EVENT SOURCE. It feeds the canonical Step 9
// call lifecycle and the Step 7 promotion policy; it decides nothing itself.
//
// Gated separately from sending, because a calendar read is not a send. Default
// OFF so this ships inert and can be dry-run first.
const CALENDAR_SYNC_ENABLED = process.env.GOOGLE_CALENDAR_BOOKING_SYNC_ENABLED === 'true';
const BOOKING_CALENDAR_ID = String(process.env.GOOGLE_BOOKING_CALENDAR_ID || '').trim();
// Pins bookings to ONE appointment schedule, so a second booking page on the
// same calendar never feeds this pipeline. The id is Google's
// extendedProperties.shared["goo.createdByAvailId"]; it is configuration, never
// source, because it identifies a specific private booking page.
const BOOKING_APPOINTMENT_SCHEDULE_ID = String(process.env.GOOGLE_BOOKING_APPOINTMENT_SCHEDULE_ID || '').trim();

/**
 * Is LIVE booking sync actually safe to run? Strict by design: the flag alone is
 * not enough. Without a pinned appointment schedule the detector would accept a
 * booking from ANY schedule on the calendar, which is precisely the weakness the
 * pin exists to close — so a missing pin means "not configured", not "run
 * loosely".
 *
 * Returns a reason instead of a bare false, because a silently inert sync is
 * exactly the failure mode that hides a misconfiguration.
 */
function calendarSyncReadiness() {
  const missing = [];
  if (!BOOKING_CALENDAR_ID) missing.push('GOOGLE_BOOKING_CALENDAR_ID');
  if (!BOOKING_APPOINTMENT_SCHEDULE_ID) missing.push('GOOGLE_BOOKING_APPOINTMENT_SCHEDULE_ID');
  return {
    enabled: CALENDAR_SYNC_ENABLED,
    configured: missing.length === 0,
    // Live sync needs BOTH the flag and complete configuration.
    ready: CALENDAR_SYNC_ENABLED && missing.length === 0,
    missing,
    schedulePinned: Boolean(BOOKING_APPOINTMENT_SCHEDULE_ID),
    reason: missing.length
      ? `booking sync is not configured: ${missing.join(', ')} not set`
      : (CALENDAR_SYNC_ENABLED ? 'ready' : 'GOOGLE_CALENDAR_BOOKING_SYNC_ENABLED is off'),
  };
}

const CALENDAR_SYNC_SHEET = 'CalendarSync';
const CALENDAR_SYNC_HEADER = ['key', 'value', 'updatedAt'];

// The calendar client is separate from the Sheets client: it needs its own
// scope, and the service account currently holds only the Sheets scope. Kept
// behind a function so nothing is constructed (or fails) until sync is enabled.
function calendarClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
  });
  return google.calendar({ version: 'v3', auth });
}

async function readCalendarSyncState() {
  const rows = await readIntegrationRows(CALENDAR_SYNC_SHEET, CALENDAR_SYNC_HEADER).catch(() => []);
  const state = {};
  for (const row of rows) if (row.key) state[row.key] = row.value;
  if (state.state) {
    try { return JSON.parse(state.state); } catch (_) { /* legacy rows below */ }
  }
  return {
    syncToken: state.syncToken || null,
    needsFullSync: state.needsFullSync === 'true',
    lastSyncAt: state.lastSyncAt || null,
    lastError: state.lastError || null,
  };
}

async function writeCalendarSyncState(state) {
  await ensureIntegrationSheet(CALENDAR_SYNC_SHEET, CALENDAR_SYNC_HEADER);
  const now = new Date().toISOString();
  // One row / one Sheets request: a token can never be updated while the rest
  // of its checkpoint remains stale after a partial multi-row write.
  await upsertIntegrationRow(CALENDAR_SYNC_SHEET, CALENDAR_SYNC_HEADER, 'key',
    { key: 'state', value: JSON.stringify(state), updatedAt: now });
}

/**
 * One page-walk of the Calendar API. Returns a result shaped for nextSyncState,
 * so a failure or an expired token can never advance the checkpoint.
 *
 * Injectable so the whole sync can be exercised without network access.
 */
async function fetchCalendarChanges({ syncToken, calendarId, listEvents } = {}) {
  const list = listEvents || (params => calendarClient().events.list(params));
  const events = [];
  let pageToken;
  let nextSyncToken = null;
  try {
    do {
      const params = {
        calendarId, singleEvents: true, showDeleted: true, maxResults: 250,
        ...(syncToken ? { syncToken } : { timeMin: new Date(Date.now() - 30 * 86400000).toISOString() }),
        ...(pageToken ? { pageToken } : {}),
      };
      const response = await list(params);
      const data = response.data || {};
      events.push(...(data.items || []));
      pageToken = data.nextPageToken;
      // The token is only present on the LAST page of a completed walk.
      nextSyncToken = data.nextSyncToken || nextSyncToken;
    } while (pageToken);
    return { ok: true, complete: true, events, nextSyncToken, at: new Date().toISOString() };
  } catch (error) {
    // 410 GONE is the documented "your sync token is no longer valid" signal.
    const status = error && (error.code || error.status);
    if (Number(status) === 410) {
      return { ok: true, tokenInvalid: true, events: [], at: new Date().toISOString() };
    }
    return { ok: false, error: error.message, events: [], at: new Date().toISOString() };
  }
}

/**
 * Decide what each provider event means for the CRM. PURE with respect to the
 * CRM: it reads state and returns a plan, writing nothing. The dry run and the
 * live sync share it, so a preview cannot drift from what would happen.
 */
async function planCalendarBookings(events, { dataset, boardLeads, activities }) {
  const ownerEmails = new Set([String(process.env.FROM_EMAIL || '').toLowerCase().trim()].filter(Boolean));
  const processed = new Set(activities
    .filter(row => String(row.eventType || '') === 'call_booked' || String(row.eventType || '').startsWith('meeting_'))
    .map(row => { try { return JSON.parse(row.metadata || '{}').providerEventKey || ''; } catch (_) { return ''; } })
    .filter(Boolean));
  const priorByProviderEvent = new Map();
  for (const row of activities) {
    let metadata = {};
    try { metadata = JSON.parse(row.metadata || '{}'); } catch (_) { continue; }
    const providerEventId = String(metadata.providerEventId || '').trim();
    const key = String(metadata.providerEventKey || '');
    if (!providerEventId || !key || !key.startsWith(`gcal:${providerEventId}:`)) continue;
    priorByProviderEvent.set(providerEventId, row);
  }

  const plan = [];
  for (const raw of events) {
    const classified = classifyCalendarEvent(raw, {
      ownerEmails, bookingCalendarId: BOOKING_CALENDAR_ID, calendarId: BOOKING_CALENDAR_ID,
      appointmentScheduleId: BOOKING_APPOINTMENT_SCHEDULE_ID,
      // A NEW booking must come from the pinned schedule. A CANCELLATION is
      // judged before this check ever runs, because Google strips the marker on
      // delete — cancellations are validated against our own prior record
      // instead (see eventWasBooked).
      requireAppointmentScheduleId: true,
    });
    if (classified.decision === BOOKING_DECISION.IGNORED) {
      plan.push({ classified, outcome: 'ignored', reason: classified.reason });
      continue;
    }
    // A cancelled event may be stripped down to {id,status}; resolve it ONLY
    // through our own prior canonical booking event. This is both safer than
    // attendee matching and the only truthful identity when Google removes the
    // attendee/marker. A cancellation we never booked remains review-only.
    let identity;
    if (classified.decision === BOOKING_DECISION.CANCELLED) {
      const prior = priorByProviderEvent.get(classified.event.providerEventId);
      const boardLead = prior && boardLeads.find(row => row.id === prior.leadId);
      const coldEmailLead = prior && dataset.leads.find(row => row.id === prior.sourceLeadId);
      identity = boardLead
        ? { status: 'matched', matchedBy: 'prior_provider_event', boardLead, coldEmailLead: coldEmailLead || null }
        : { status: 'unmatched', reason: 'this CRM never booked this provider event' };
    } else {
      identity = matchBookingIdentity(classified.attendeeEmail, {
        coldEmailLeads: dataset.leads, boardLeads,
      });
    }
    if (identity.status !== 'matched') {
      // Never discarded and never invented into a lead — surfaced for a human.
      plan.push({ classified, outcome: identity.status, reason: identity.reason, identity });
      continue;
    }
    const boardLead = identity.boardLead || null;
    const action = bookingLifecycleAction(classified, {
      meetingAt: boardLead ? boardLead.meetingAt : '',
      processedEventIds: processed,
    });
    plan.push({
      classified, identity, boardLead,
      outcome: action.action || (action.duplicate ? 'duplicate' : action.unchanged ? 'unchanged' : 'no_action'),
      action: action.action, meetingAt: action.meetingAt, previousMeetingAt: action.previousMeetingAt,
      providerEventKey: action.key, reason: action.reason,
    });
  }
  return plan;
}

async function loadBookingContext() {
  const dataset = await getOutreachDataset();
  const boardResponse = await sheets().spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID, range: AGENT_READ_RANGE,
  });
  const boardLeads = (boardResponse.data.values || []).slice(1).map(row => {
    const lead = {};
    COLUMNS.forEach((col, i) => { lead[col] = row[i] || ''; });
    lead.meetingAt = row[20] || '';
    lead.outcome = row[21] || '';
    return lead;
  }).filter(lead => lead.id);
  const activities = await readIntegrationRows(COLD_CALL_ACTIVITY_SHEET, COLD_CALL_ACTIVITY_HEADER);
  return { dataset, boardLeads, activities };
}

/**
 * Calendar adapter for the existing Step 7 + Step 9 rules. It deliberately
 * writes only the canonical board cells and canonical lifecycle activity rows;
 * Google-specific state lives solely in activity metadata.
 */
async function applyCalendarPlanItem(item, context) {
  const action = item.action;
  if (!['book', 'reschedule', 'cancel'].includes(action)) {
    return { ok: true, changed: false, leadId: item.boardLead?.id || '' };
  }
  const identity = item.identity;
  const ceLead = identity?.coldEmailLead || null;
  let boardLead = identity?.boardLead || null;
  const meetingAt = String(item.meetingAt || '').trim();
  const previousMeetingAt = String(item.previousMeetingAt || boardLead?.meetingAt || '').trim();
  const providerId = item.classified?.event?.providerEventId || '';
  const providerKey = item.providerEventKey || providerEventKey(providerId,
    action === 'cancel' ? 'cancelled' : meetingAt);
  const occurredAt = item.classified?.event?.updatedAt || new Date().toISOString();
  let createdBoard = false;

  // A CE-only booking enters the board exclusively through the shared Step 7
  // promotion policy. Identity and suppression are rechecked at mutation time.
  if (!boardLead) {
    if (action !== 'book' || !ceLead) {
      return { ok: false, error: 'booking identity no longer maps to a board or Outreach lead' };
    }
    const email = normalizeEmail(ceLead.email);
    const twinCount = context.dataset.leads.filter(row => email && normalizeEmail(row.email) === email).length;
    const promotionIdentity = resolvePromotionIdentity(ceLead, context.boardLeads, { coldEmailTwinCount: twinCount });
    const suppressedEmails = await loadSuppressionEmails().catch(() => new Set());
    const decision = promotionDecision({
      trigger: PROMOTION_TRIGGER.MEETING_BOOKED, coldEmailLead: ceLead,
      identity: promotionIdentity, meetingAt, suppressedEmails,
    });
    if (!decision.shouldPromote) return { ok: false, error: decision.reason || 'promotion policy blocked booking' };

    if (promotionIdentity.boardLead) {
      boardLead = promotionIdentity.boardLead;
    } else {
      const parts = String(ceLead.contactName || '').trim().split(/\s+/).filter(Boolean);
      const boardId = `CE-${ceLead.id}`;
      boardLead = {
        id: boardId, type: 'trade', first: parts[0] || '', last: parts.slice(1).join(' '),
        brokerage: '', tradeType: ceLead.tradeType || '', company: ceLead.company || '',
        city: ceLead.city || '', cityTrade: ceLead.city || '', phone: '', email: ceLead.email || '',
        website: ceLead.website || '', stage: 'call_booked', priority: 'warm', followup: '',
        notes: ceLead.notes || '', created: new Date().toISOString(), meetingAt,
      };
      // Human-owned stage safety is fail-closed: hold before creating the card.
      if (stageRequiresHold('call_booked')) await withAuth(() => applyManualHold(boardId, boardLead.email));
      await withAuth(() => sheets().spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID, range: AGENT_READ_RANGE,
        valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [[...COLUMNS.map(field => String(boardLead[field] ?? '')), '', '', '', meetingAt, '', '']] },
      }));
      createdBoard = true;
      context.boardLeads.push(boardLead);
      const promotionEventId = stableActivityId('pipeline-promotion', [ceLead.id, boardId, 'call_booked', PROMOTION_TRIGGER.MEETING_BOOKED]);
      if (!context.activities.some(row => row.eventId === promotionEventId)) {
        const acquisition = latestSendAttribution(context.activities.filter(row => row.sourceLeadId === ceLead.id || row.leadId === `CE-${ceLead.id}`));
        const promotionEvent = {
          eventId: promotionEventId, leadId: boardId, sourceLeadId: ceLead.id,
          email: boardLead.email, company: boardLead.company, eventType: 'pipeline_promoted',
          occurredAt, subject: 'Added to Sales Pipeline — call_booked', content: '',
          metadata: JSON.stringify({ fromStage: '', toStage: 'call_booked', trigger: PROMOTION_TRIGGER.MEETING_BOOKED, provider: CALENDAR_PROVIDER, providerEventKey: providerKey, ...promotionAttribution(acquisition) }),
        };
        await appendColdCallActivities([promotionEvent]);
        context.activities.push(promotionEvent);
      }
    }
  }

  const leadId = boardLead.id;
  const rowNum = await withAuth(() => findRow(leadId));
  if (!rowNum) return { ok: false, error: 'matched board lead disappeared before Calendar mutation' };
  const prior = await sheets().spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A${rowNum}:W${rowNum}`,
  });
  const row = prior.data.values?.[0] || [];
  const current = { stage: row[12] || '', meetingAt: row[20] || '', outcome: row[21] || '' };
  const email = row[10] || boardLead.email || '';
  const company = row[6] || row[4] || boardLead.company || '';
  const activities = context.activities.filter(a => a.leadId === leadId
    || (email && normalizeEmail(a.email) === normalizeEmail(email)));
  const lifecycle = deriveCallLifecycle(current, { activities });
  const allowed = callLifecycleActions(lifecycle);

  if (!createdBoard && !allowed[action]) {
    // A replay after the canonical state already changed is a no-op only when
    // the provider key is already present. Everything else is a stale conflict.
    if (activities.some(a => {
      try { return JSON.parse(a.metadata || '{}').providerEventKey === providerKey; } catch (_) { return false; }
    })) return { ok: true, changed: false, leadId };
    return { ok: false, error: `canonical call lifecycle rejects ${action} from ${lifecycle.status}` };
  }
  if (action === 'reschedule' && previousMeetingAt
    && new Date(current.meetingAt).getTime() !== new Date(previousMeetingAt).getTime()) {
    return { ok: false, error: 'meeting changed after the Calendar plan was created' };
  }

  if (!createdBoard && (action === 'book' || action === 'reschedule')) {
    const ms = new Date(meetingAt).getTime();
    if (!Number.isFinite(ms)) return { ok: false, error: 'Calendar supplied an invalid meeting time' };
    if (stageRequiresHold('call_booked')) await withAuth(() => applyManualHold(leadId, email));
    const gate = stageTransitionCheck('call_booked', { meetingAt, outcome: current.outcome });
    if (!gate.ok) return { ok: false, error: gate.message };
    await withAuth(() => sheets().spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: 'RAW', data: [
        { range: `${SHEET_NAME}!U${rowNum}`, values: [[new Date(ms).toISOString()]] },
        { range: `${SHEET_NAME}!M${rowNum}`, values: [['call_booked']] },
      ] },
    }));
  }

  const eventType = CALL_ACTION_EVENT[action];
  const eventId = stableActivityId('calendar-call-lifecycle', [leadId, providerKey]);
  if (context.activities.some(a => a.eventId === eventId)) return { ok: true, changed: false, leadId };
  const event = {
    eventId, leadId, sourceLeadId: ceLead?.id || '', email, company, eventType, occurredAt,
    subject: action === 'book' ? 'Call booked' : action === 'reschedule' ? 'Call rescheduled' : 'Call cancelled',
    content: '',
    metadata: JSON.stringify({
      meetingAt: action === 'cancel' ? current.meetingAt : new Date(meetingAt).toISOString(),
      previousMeetingAt: action === 'reschedule' ? previousMeetingAt : '',
      trigger: 'google_calendar', action, provider: CALENDAR_PROVIDER,
      providerEventId: providerId, providerEventKey: providerKey,
      salesOutcomeUnchanged: true,
    }),
  };
  await appendColdCallActivities([event]);
  context.activities.push(event);
  return { ok: true, changed: true, leadId };
}

async function runGoogleCalendarSync() {
  const readiness = calendarSyncReadiness();
  return orchestrateGoogleCalendarSync({
    enabled: readiness.enabled,
    calendarId: BOOKING_CALENDAR_ID,
    appointmentScheduleId: BOOKING_APPOINTMENT_SCHEDULE_ID,
    readState: readCalendarSyncState,
    fetchChanges: fetchCalendarChanges,
    loadContext: loadBookingContext,
    planBookings: planCalendarBookings,
    applyPlan: applyCalendarPlanItem,
    writeState: writeCalendarSyncState,
    logger: console,
  });
}

// Read-only preview: what WOULD happen if sync were enabled. Writes nothing —
// not even the sync checkpoint.
app.get('/api/integrations/google-calendar/dry-run', requireAuth, async (_req, res) => {
  try {
    if (!BOOKING_CALENDAR_ID) {
      return res.json({
        ok: false, configured: false, syncEnabled: CALENDAR_SYNC_ENABLED, bookingUrl: BOOKING_URL,
        error: 'GOOGLE_BOOKING_CALENDAR_ID is not set, so no calendar can be read.',
      });
    }
    const state = await readCalendarSyncState();
    let result = await fetchCalendarChanges({ syncToken: state.syncToken, calendarId: BOOKING_CALENDAR_ID });
    if (result.tokenInvalid) {
      // Dry run mirrors the writer's 410 recovery but deliberately stores no
      // replacement token or checkpoint.
      result = await fetchCalendarChanges({ syncToken: null, calendarId: BOOKING_CALENDAR_ID });
    }
    if (!result.ok) {
      return res.json({ ok: false, configured: true, syncEnabled: CALENDAR_SYNC_ENABLED, bookingUrl: BOOKING_URL, error: result.error });
    }
    const context = await loadBookingContext();
    const plan = await planCalendarBookings(result.events, context);
    const counts = plan.reduce((acc, item) => ({ ...acc, [item.outcome]: (acc[item.outcome] || 0) + 1 }), {});
    res.json({
      ok: true, configured: true, syncEnabled: CALENDAR_SYNC_ENABLED, dryRun: true,
      bookingUrl: BOOKING_URL, calendarId: BOOKING_CALENDAR_ID,
      appointmentScheduleId: BOOKING_APPOINTMENT_SCHEDULE_ID || null,
      appointmentSchedulePinned: Boolean(BOOKING_APPOINTMENT_SCHEDULE_ID),
      readiness: calendarSyncReadiness(),
      eventsInspected: result.events.length, counts,
      tokenInvalid: Boolean(result.tokenInvalid),
      plan: plan.map(item => ({
        providerEventId: item.classified.event.providerEventId,
        decision: item.classified.decision,
        outcome: item.outcome,
        reason: item.reason,
        attendeeEmail: item.classified.attendeeEmail || null,
        meetingAt: item.meetingAt || item.classified.meetingAt || null,
        previousMeetingAt: item.previousMeetingAt || null,
        leadId: item.boardLead ? item.boardLead.id : (item.identity && item.identity.coldEmailLead ? item.identity.coldEmailLead.id : null),
      })),
    });
  } catch (e) {
    if (e.isAuthError) return res.status(401).json({ error: 'unauthenticated' });
    console.error('[Calendar dry-run]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── STAGE SEQUENCES ─────────────────────────────────────────────────────────
// Enrolment, pause, resume and cancel — plus a dry-run preview. Deliberately
// NO send path: these routes only move canonical state, and the sending agent
// decides when (and whether) anything actually goes out, behind its own feature
// flag. A button here can never mail a prospect.
const SEQUENCE_ACTIONS = new Set(['enroll', 'pause', 'resume', 'cancel']);

async function loadSequenceContext(leadId) {
  const rowNum = await withAuth(() => findRow(leadId));
  if (!rowNum) return null;
  const prior = await sheets().spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A${rowNum}:W${rowNum}`,
  });
  const row = prior.data.values?.[0] || [];
  const lead = {};
  COLUMNS.forEach((col, i) => { lead[col] = row[i] || ''; });
  lead.meetingAt = row[20] || '';
  lead.outcome = row[21] || '';
  const email = normalizeEmail(lead.email);
  const all = await readIntegrationRows(COLD_CALL_ACTIVITY_SHEET, COLD_CALL_ACTIVITY_HEADER);
  const activities = all.filter(a => a.leadId === leadId || (email && normalizeEmail(a.email) === email));
  const twin = await findColdEmailTwin(leadId, lead.email).catch(() => null);
  return { rowNum, lead, email, activities, allActivities: all, twin };
}

function evaluateFor(ctx) {
  return evaluateStageSequence({
    boardLead: ctx.lead, twin: ctx.twin || {}, activities: ctx.activities,
    callState: deriveCallLifecycle(ctx.lead, { activities: ctx.activities }),
    hotState: deriveHotState(ctx.lead, { activities: ctx.activities }),
    // The server reports what WOULD happen; the agent owns the real flag.
    featureEnabled: process.env.STAGE_SEQUENCES_ENABLED === 'true',
  });
}

// What journey is available/active, and what the next email would say. Pure
// read — this is the dry-run preview.
app.get('/api/leads/:id/sequence', requireAuth, async (req, res) => {
  try {
    const ctx = await loadSequenceContext(req.params.id);
    if (!ctx) return res.status(404).json({ error: 'not found' });
    const verdict = evaluateFor(ctx);
    // Preview the journey that is running OR the one on offer, so the exact
    // copy can be inspected before anyone decides to enrol.
    const previewId = verdict.sequenceId || verdict.offer || null;
    const step = (verdict.step || 0) + 1;
    const maxSteps = verdict.maxSteps || (previewId && SEQUENCES[previewId] ? SEQUENCES[previewId].maxSteps : 0);
    // The preview resolves the same thread the sender would, so what is shown
    // here is byte-identical to what would go out.
    const thread = resolveSequenceThread(ctx.activities);
    const preview = previewId && step <= maxSteps
      ? buildSequenceEmail(previewId, step, ctx.lead, { thread })
      : null;
    res.json({
      leadId: req.params.id,
      ...verdict,
      catalogue: Object.values(SEQUENCES).map(def => ({
        id: def.id, label: def.label, maxSteps: def.maxSteps, requiresEnrollment: def.requiresEnrollment,
      })),
      preview: preview && !preview.error
        ? { sequenceId: previewId, step, subject: preview.subject, body: preview.body,
            replyToThread: preview.replyToThread, threadId: preview.threadId || '', wouldSend: false }
        : null,
      previewError: preview && preview.error ? preview.error : null,
    });
  } catch (e) {
    if (e.isAuthError) return res.status(401).json({ error: 'unauthenticated' });
    console.error('[Sequence GET]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Move sequence state. Records an activity row and nothing else — no lead
// column is written, so enrolment cannot disturb stage, sequence or send state.
app.post('/api/leads/:id/sequence', requireAuth, async (req, res) => {
  const action = String(req.body?.action || '').trim();
  try {
    if (!SEQUENCE_ACTIONS.has(action)) {
      return res.status(400).json({ error: `Unknown sequence action "${action}".`, field: 'action' });
    }
    const ctx = await loadSequenceContext(req.params.id);
    if (!ctx) return res.status(404).json({ error: 'not found' });
    const verdict = evaluateFor(ctx);
    const state = deriveSequenceState(ctx.activities);

    let sequenceId = state.sequenceId;
    let recontactAt = '';
    if (action === 'enroll') {
      sequenceId = String(req.body?.sequenceId || verdict.offer || '').trim();
      if (!SEQUENCES[sequenceId]) {
        return res.status(422).json({ error: 'Choose a valid follow-up sequence.', field: 'sequenceId' });
      }
      // Only a journey this lead's CURRENT state actually offers may be started.
      if (!verdict.offers || !verdict.offers.includes(sequenceId)) {
        if (sequenceId !== 'timing_recontact_v1') {
          return res.status(409).json({
            error: `This lead does not currently qualify for "${SEQUENCES[sequenceId].label}".`,
            code: 'not_offered', offers: verdict.offers || [],
          });
        }
      }
      if (state.status === SEQUENCE_STATUS.ACTIVE) {
        return res.status(409).json({
          error: `A follow-up sequence is already running for this lead.`,
          code: 'already_active', sequenceId: state.sequenceId,
        });
      }
      // A blocked lead must never be enrolled, even by hand.
      if (verdict.stopReason) {
        return res.status(409).json({ error: `Cannot enrol: ${verdict.stopReason}.`, code: 'blocked' });
      }
      if (sequenceId === 'timing_recontact_v1') {
        recontactAt = String(req.body?.recontactAt || '').trim();
        const ms = recontactAt ? new Date(recontactAt).getTime() : NaN;
        if (!Number.isFinite(ms) || ms <= Date.now()) {
          return res.status(422).json({ error: 'Choose a future re-contact date.', field: 'recontactAt' });
        }
        recontactAt = new Date(ms).toISOString();
      }
    } else if (state.status !== SEQUENCE_STATUS.ACTIVE && action === 'pause') {
      return res.status(409).json({ error: 'No active sequence to pause.', code: 'not_active' });
    } else if (state.status !== SEQUENCE_STATUS.PAUSED && action === 'resume') {
      return res.status(409).json({ error: 'No paused sequence to resume.', code: 'not_paused' });
    } else if (!state.sequenceId) {
      return res.status(409).json({ error: 'No sequence on this lead.', code: 'not_enrolled' });
    }

    const eventType = {
      enroll: SEQUENCE_EVENTS.ENROLLED, pause: SEQUENCE_EVENTS.PAUSED,
      resume: SEQUENCE_EVENTS.RESUMED, cancel: SEQUENCE_EVENTS.CANCELLED,
    }[action];
    const occurredAt = new Date().toISOString();
    const eventId = stableActivityId('sequence', [req.params.id, eventType, sequenceId, recontactAt || occurredAt.slice(0, 16)]);
    if (!ctx.allActivities.some(a => a.eventId === eventId)) {
      await appendColdCallActivities([{
        eventId, leadId: req.params.id, sourceLeadId: ctx.twin ? ctx.twin.id : '',
        email: ctx.lead.email || '', company: ctx.lead.company || '',
        eventType, occurredAt,
        subject: `${SEQUENCES[sequenceId] ? SEQUENCES[sequenceId].label : sequenceId} ${action}ed`,
        content: String(req.body?.reason || '').trim().slice(0, 500),
        metadata: JSON.stringify({
          sequenceId, recontactAt, action, trigger: 'crm_sequence',
          reason: String(req.body?.reason || '').trim().slice(0, 200),
          // Structured for Step 12's version attribution.
          sequenceVersion: sequenceId ? sequenceId.split('_').pop() : '',
        }),
      }]);
    }
    res.json({ ok: true, action, sequenceId, recontactAt: recontactAt || null, automationResumed: false });
  } catch (e) {
    if (e.isAuthError) return res.status(401).json({ error: 'unauthenticated' });
    console.error('[Sequence POST]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── CALL LIFECYCLE ──────────────────────────────────────────────────────────
// One route for the whole booked-call journey: book, reschedule, cancel,
// complete, no-show. Every mutation re-derives the lifecycle from STORED state
// and refuses anything the current state does not permit, so a drawer opened
// before someone else rescheduled cannot resolve a meeting that no longer
// exists.
//
// The separation this enforces: a meeting RESULT is an activity event, while
// the SALES outcome stays in column V. Marking a no-show therefore never writes
// the `outcome` column — which matters, because `no_show` is a LOSS value in
// that taxonomy and writing it would make a missed meeting look like a dead
// deal. Cancel, complete and no-show write no lead state at all: they append an
// event, and the derivation does the rest.
const CALL_ACTIONS = new Set(['book', 'reschedule', 'cancel', 'complete', 'no_show']);
// Readable verbs for refusal messages; string-concatenating the action id gave
// nonsense like "completeed".
const CALL_ACTION_VERB = {
  book: 'booked', reschedule: 'rescheduled', cancel: 'cancelled',
  complete: 'marked completed', no_show: 'marked no-show',
};
const CALL_ACTION_EVENT = {
  book: 'call_booked', reschedule: 'meeting_rescheduled',
  cancel: 'meeting_cancelled', complete: 'meeting_completed', no_show: 'meeting_no_show',
};

app.post('/api/leads/:id/call-lifecycle', requireAuth, async (req, res) => {
  const action = String(req.body?.action || '').trim();
  try {
    if (!CALL_ACTIONS.has(action)) {
      return res.status(400).json({ error: `Unknown call action "${action}".`, field: 'action' });
    }
    const rowNum = await withAuth(() => findRow(req.params.id));
    if (!rowNum) return res.status(404).json({ error: 'not found' });

    const prior = await sheets().spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A${rowNum}:W${rowNum}`,
    });
    const row = prior.data.values?.[0] || [];
    const email = row[10] || '';
    const company = row[6] || row[4] || '';
    const lead = { stage: row[12] || '', followup: row[14] || '', meetingAt: row[20] || '', outcome: row[21] || '' };

    // Current stored history decides what is legal — never the browser's view.
    const allActivities = await readIntegrationRows(COLD_CALL_ACTIVITY_SHEET, COLD_CALL_ACTIVITY_HEADER);
    const activities = allActivities.filter(a => a.leadId === req.params.id
      || (email && normalizeEmail(a.email) === normalizeEmail(email)));
    const lifecycle = deriveCallLifecycle(lead, { activities });
    const allowed = callLifecycleActions(lifecycle);

    if (!allowed[action]) {
      return res.status(409).json({
        error: `A call in state "${lifecycle.status.replace(/_/g, ' ')}" cannot be ${CALL_ACTION_VERB[action]}. Reload and try again.`,
        code: 'invalid_transition', status: lifecycle.status, meetingAt: lifecycle.meetingAt,
        allowed: Object.entries(allowed).filter(([, ok]) => ok).map(([name]) => name),
      });
    }

    // Optimistic concurrency: the drawer sends the meeting it was showing.
    const expected = String(req.body?.expectedMeetingAt || '').trim();
    if (expected && expected !== String(lifecycle.meetingAt || '')) {
      return res.status(409).json({
        error: 'This meeting was changed elsewhere. Reload before resolving it.',
        code: 'meeting_changed', status: lifecycle.status, meetingAt: lifecycle.meetingAt,
      });
    }

    const eventType = CALL_ACTION_EVENT[action];
    const occurredAt = new Date().toISOString();
    let meetingAt = String(lifecycle.meetingAt || '');
    const previousMeetingAt = meetingAt;

    if (action === 'book' || action === 'reschedule') {
      const raw = String(req.body?.meetingAt || '').trim();
      const ms = raw ? new Date(raw).getTime() : NaN;
      if (!raw || !Number.isFinite(ms)) {
        return res.status(422).json({ error: 'A valid meeting date and time is required.', field: 'meetingAt' });
      }
      if (ms < Date.now()) {
        return res.status(422).json({ error: 'A meeting cannot be booked in the past.', field: 'meetingAt' });
      }
      meetingAt = new Date(ms).toISOString();
      if (action === 'reschedule' && meetingAt === previousMeetingAt) {
        return res.status(422).json({ error: 'Choose a different time to reschedule to.', field: 'meetingAt' });
      }
      // Booking the identical time again is a no-op, not a duplicate event.
      if (action === 'book' && meetingAt === previousMeetingAt
        && [CALL_STATUS.SCHEDULED, CALL_STATUS.RESCHEDULED].includes(lifecycle.status)) {
        return res.json({ ok: true, unchanged: true, status: lifecycle.status, meetingAt });
      }

      // Call Booked is human-owned: hold before the stage write, the same
      // fail-closed ordering every other terminal transition uses.
      if (stageRequiresHold('call_booked')) {
        await withAuth(() => applyManualHold(req.params.id, email));
      }
      const gate = stageTransitionCheck('call_booked', { meetingAt, outcome: lead.outcome });
      if (!gate.ok) return res.status(422).json({ error: gate.message, field: gate.field });

      // Targeted cells only: the meeting time (U) and the stage (M). Sequence
      // state, notes, follow-up date and sales outcome are all left alone.
      await withAuth(() => sheets().spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          valueInputOption: 'RAW',
          data: [
            { range: `${SHEET_NAME}!U${rowNum}`, values: [[meetingAt]] },
            { range: `${SHEET_NAME}!M${rowNum}`, values: [['call_booked']] },
          ],
        },
      }));
    }

    // Resolutions write NO lead state at all — the event is the record, and the
    // sales outcome column is deliberately untouched.
    const eventId = stableActivityId('call-lifecycle', [req.params.id, eventType, previousMeetingAt, meetingAt]);
    let recorded = false;
    if (!allActivities.some(a => a.eventId === eventId)) {
      await appendColdCallActivities([{
        eventId, leadId: req.params.id, sourceLeadId: '', email, company,
        eventType, occurredAt,
        subject: eventType === 'call_booked' ? 'Call booked'
          : eventType === 'meeting_rescheduled' ? 'Call rescheduled'
            : eventType === 'meeting_cancelled' ? 'Call cancelled'
              : eventType === 'meeting_completed' ? 'Call completed' : 'No show',
        content: '',
        metadata: JSON.stringify({
          meetingAt, previousMeetingAt: action === 'reschedule' ? previousMeetingAt : '',
          trigger: 'crm_call_lifecycle', action,
          // Meeting result only. The sales outcome is a separate decision.
          salesOutcomeUnchanged: true,
        }),
      }]);
      recorded = true;
    }

    const nextLifecycle = deriveCallLifecycle({ ...lead, meetingAt, stage: 'call_booked' }, {
      activities: [...activities, { eventType, occurredAt, metadata: JSON.stringify({ meetingAt, previousMeetingAt }) }],
    });
    res.json({
      ok: true, action, recorded, status: nextLifecycle.status,
      meetingAt: nextLifecycle.meetingAt, previousMeetingAt: nextLifecycle.previousMeetingAt,
      salesOutcome: lead.outcome || '', automationResumed: false,
    });
  } catch (e) {
    if (e.isAuthError) return res.status(401).json({ error: 'unauthenticated' });
    console.error('[Call lifecycle]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/leads/:id/mark-ghosted', requireAuth, async (req, res) => {
  try {
    const rowNum = await withAuth(() => findRow(req.params.id));
    if (!rowNum) return res.status(404).json({ error: 'not found' });

    // Current STORED state decides — never what the browser believed when the
    // modal was opened.
    const prior = await sheets().spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A${rowNum}:W${rowNum}`,
    });
    const row = prior.data.values?.[0] || [];
    const rawStage = row[12] || '';
    const currentStage = displayStageFor(rawStage);
    const currentOutcome = String(row[21] || '').trim();
    const company = row[6] || '';
    const email = row[10] || '';

    // Idempotent: an already-ghosted lead is a success with no second write and
    // no second timeline entry.
    if (currentStage === 'closed_lost' && currentOutcome === GHOSTED_OUTCOME) {
      return res.json({ ok: true, alreadyGhosted: true, stage: currentStage, outcome: currentOutcome });
    }

    // Raced: the lead moved on (booked, won, closed another way) between the
    // modal opening and this request. Refuse rather than overwrite the newer
    // stage — the person who moved it knew something this request does not.
    if (currentStage !== 'hot') {
      return res.status(409).json({
        error: `This lead is no longer Hot — it is now ${currentStage.replace(/_/g, ' ')}. Reload before closing it.`,
        code: 'stage_changed', currentStage, currentOutcome,
      });
    }

    // The same shared gate every other transition passes through.
    const gate = stageTransitionCheck('closed_lost', { meetingAt: row[20] || '', outcome: GHOSTED_OUTCOME });
    if (!gate.ok) return res.status(422).json({ error: gate.message, field: gate.field });

    // Hold first, exactly as the manual-promotion path does: closed_lost is a
    // human-owned stage, so if the later write fails the safe failure is a held
    // lead rather than one that could still be mailed. applyManualHold is
    // idempotent, so an already-held lead is not touched.
    if (stageRequiresHold('closed_lost')) {
      await withAuth(() => applyManualHold(req.params.id, email));
    }

    // One batch: stage (M) and outcome (V). Deliberately targeted cells — this
    // cannot clobber notes, follow-up date, sequence state or send history the
    // way a full-row write could.
    await withAuth(() => sheets().spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        valueInputOption: 'RAW',
        data: [
          { range: `${SHEET_NAME}!M${rowNum}`, values: [['closed_lost']] },
          { range: `${SHEET_NAME}!V${rowNum}`, values: [[GHOSTED_OUTCOME]] },
        ],
      },
    }));

    // Same event shape the PUT transition records, with a derived id so a retry
    // cannot stack a second entry. Prior history is untouched: this appends.
    const eventId = stableActivityId('stage-changed', [req.params.id, currentStage, 'closed_lost', GHOSTED_OUTCOME]);
    try {
      const existing = await readIntegrationRows(COLD_CALL_ACTIVITY_SHEET, COLD_CALL_ACTIVITY_HEADER);
      if (!existing.some(activity => activity.eventId === eventId)) {
        await appendColdCallActivities([{
          eventId, leadId: req.params.id, sourceLeadId: '', email, company,
          eventType: 'stage_changed', occurredAt: new Date().toISOString(),
          subject: `${currentStage} -> closed_lost`, content: 'Closed Lost — Ghosted',
          metadata: JSON.stringify({
            fromStage: currentStage, toStage: 'closed_lost', fromStageRaw: rawStage,
            toStageRaw: 'closed_lost', outcome: GHOSTED_OUTCOME, trigger: 'manual_mark_ghosted',
          }),
        }]);
      }
    } catch (activityError) {
      // The lead is already closed; a timeline failure must not turn a
      // successful close into a 500.
      console.warn('[Mark ghosted] closed, but activity write failed:', activityError.message);
    }

    res.json({ ok: true, alreadyGhosted: false, stage: 'closed_lost', outcome: GHOSTED_OUTCOME, previousStage: currentStage });
  } catch (e) {
    if (e.isAuthError) return res.status(401).json({ error: 'unauthenticated' });
    console.error('[Mark ghosted]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/leads/:id/call-details', requireAuth, async (req, res) => {
  try {
    const rowNum = await withAuth(() => findRow(req.params.id));
    if (!rowNum) return res.status(404).json({ error: 'not found' });
    const currentResponse = await sheets().spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A${rowNum}:W${rowNum}`,
    });
    const current = currentResponse.data.values?.[0] || [];
    const meetingAt = String(req.body?.meetingAt || '').trim();
    const outcome = String(req.body?.outcome || '').trim();
    const conversationContext = String(req.body?.conversationContext || '').trim().slice(0, 10000);
    const validOutcomes = new Set(['', ...OUTCOME_IDS]);
    if (meetingAt && Number.isNaN(Date.parse(meetingAt))) return res.status(422).json({ error: 'invalid meeting time' });
    if (!validOutcomes.has(outcome)) return res.status(422).json({ error: 'invalid outcome' });
    await sheets().spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!U${rowNum}:W${rowNum}`,
      valueInputOption: 'RAW', requestBody: { values: [[meetingAt, outcome, conversationContext]] },
    });
    const oldMeetingAt = current[20] || '';
    const oldOutcome = current[21] || '';
    const oldContext = current[22] || '';
    const occurredAt = new Date().toISOString();
    const activityEvents = [];
    if (meetingAt !== oldMeetingAt) {
      const eventType = !oldMeetingAt && meetingAt ? 'call_booked'
        : oldMeetingAt && meetingAt ? 'meeting_rescheduled'
          : 'meeting_cancelled';
      activityEvents.push({
        eventId: stableActivityId('meeting', [req.params.id, eventType, oldMeetingAt, meetingAt]),
        leadId: req.params.id, sourceLeadId: '', email: current[10] || '', company: current[6] || current[4] || '',
        eventType, occurredAt,
        subject: eventType === 'call_booked' ? 'Meeting scheduled' : eventType === 'meeting_rescheduled' ? 'Meeting time changed' : 'Meeting removed',
        content: '', metadata: JSON.stringify({ meetingAt, previousMeetingAt: oldMeetingAt, outcome }),
      });
    }
    if (outcome && outcome !== oldOutcome) {
      const eventType = LOSS_OUTCOME_IDS.includes(outcome) ? 'closed_lost' : 'meeting_outcome';
      activityEvents.push({
        eventId: stableActivityId('meeting-outcome', [req.params.id, oldOutcome, outcome]),
        leadId: req.params.id, sourceLeadId: '', email: current[10] || '', company: current[6] || current[4] || '',
        eventType, occurredAt, subject: '', content: conversationContext,
        metadata: JSON.stringify({ meetingAt, outcome, previousOutcome: oldOutcome }),
      });
    }
    if (conversationContext && conversationContext !== oldContext) {
      activityEvents.push({
        eventId: stableActivityId('conversation-context', [req.params.id, conversationContext]),
        leadId: req.params.id, sourceLeadId: '', email: current[10] || '', company: current[6] || current[4] || '',
        eventType: 'conversation_note', occurredAt, subject: 'Conversation context updated', content: conversationContext,
        metadata: JSON.stringify({ meetingAt, outcome, trigger: 'call_details' }),
      });
    }
    if (activityEvents.length) {
      try {
        await appendColdCallActivities(activityEvents);
      } catch (activityError) {
        console.warn('[Cold call details] saved, but timeline append failed:', activityError.message);
      }
    }
    res.json({ ok: true, meetingAt, outcome, conversationContext });
  } catch (e) {
    console.error('[Cold call details PATCH]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/coldemail/queue', requireAuth, async (req, res) => {
  const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(value => String(value || '').trim()).filter(Boolean))];
  const senderInboxId = String(req.body?.senderInboxId || '').trim();
  const emailTemplateId = String(req.body?.emailTemplateId || '').trim();
  if (!ids.length || ids.length > 500) return res.status(422).json({ error: 'Select between 1 and 500 leads' });
  try {
    const result = await withAuth(async () => {
      await ensureColdEmailSheet();
      const response = await sheets().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: CE_COL_RANGE });
      const rows = response.data.values || [];
      const selected = [];
      for (let index = 1; index < rows.length; index++) {
        const lead = {}; CE_COLUMNS.forEach((field, column) => { lead[field] = rows[index][column] || ''; });
        if (ids.includes(lead.id)) selected.push({ lead, rowNumber: index + 1 });
      }
      if (selected.length !== ids.length) return { error: 'One or more selected leads no longer exist', status: 409 };
      if (new Set(selected.map(({ lead }) => String(lead.campaign || '').trim())).size !== 1) return { error: 'Queue leads from one campaign at a time', status: 422 };
      const inboxes = gmailInboxOptions();
      for (const { lead } of selected) {
        if (lead.emailStatus || ['Replied','Done','Promoted','Unsubscribed'].includes(lead.stage)) return { error: `${lead.company || lead.email} is not eligible to queue`, status: 409 };
        const route = validateRoute({ niche: lead.leadNiche || lead.tradeType, senderInboxId, emailTemplateId, inboxes });
        if (!route.ok) return { error: route.reason, status: 422 };
        if (emailTemplateId === ROOFING_SURVEY_TEMPLATE) {
          const qualification = qualifyRoofingLead(lead);
          if (!qualification.ok) return { error: `${lead.company || lead.email} does not have enough roofing-business evidence`, status: 422 };
        }
      }
      const queuedAt = new Date().toISOString();
      const queueActivities = [];
      const data = selected.map(({ lead, rowNumber }) => {
        const changed = lead.stage !== 'Queued' || lead.senderInboxId !== senderInboxId || lead.emailTemplateId !== emailTemplateId;
        lead.stage = 'Queued'; lead.senderInboxId = senderInboxId; lead.emailTemplateId = emailTemplateId; lead.routingRequired = 'true';
        if (changed) queueActivities.push({
          eventId: stableActivityId('lead-queued', [lead.id, senderInboxId, emailTemplateId, queuedAt]),
          leadId: `CE-${lead.id}`, sourceLeadId: lead.id, email: lead.email || '', company: lead.company || '',
          eventType: 'lead_queued', occurredAt: queuedAt, subject: 'Queued for outreach', content: '',
          metadata: JSON.stringify({ senderInboxId, emailTemplateId, campaign: lead.campaign || '', trigger: 'outreach_queue' }),
        });
        return { range: `${CE_SHEET_NAME}!A${rowNumber}:W${rowNumber}`, values: [CE_COLUMNS.map(field => String(lead[field] ?? ''))] };
      });
      await sheets().spreadsheets.values.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { valueInputOption: 'RAW', data } });
      try { await appendColdCallActivities(queueActivities); }
      catch (activityError) { console.warn('[ColdEmail Queue] queued, activity append failed:', activityError.message); }
      ceRowMap.clear();
      return { queued: selected.length, senderInboxId, emailTemplateId };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  } catch (error) {
    if (error.isAuthError) return res.status(401).json({ error: 'unauthenticated' });
    console.error('[ColdEmail Queue]', error.message);
    res.status(500).json({ error: 'Could not queue selected leads' });
  }
});

// The Outreach summary. Lightweight by construction (~200 bytes): it returns
// counts only, never lead rows, so the metric cards can paint without waiting
// on the lead list. Now reads the shared snapshot instead of fetching the
// ColdEmail sheet a second time.
app.get('/api/coldemail/stats', requireAuth, async (req, res) => {
  try {
    const dataset = await withAuth(() => getOutreachDataset({ force: req.query.refresh === '1' }));
    res.json({
      ...dataset.counts,
      replied: dataset.metrics.totalReplies,
      replyMetrics: dataset.metrics,
      signals: dataset.signals,
      pipelineAudit: dataset.pipelineAudit,
      totalLeads: dataset.rows.length,
      fetchedAt: new Date(dataset.at).toISOString(),
    });
  } catch (e) {
    if (e.isAuthError) return res.status(401).json({ error: 'unauthenticated' });
    console.error('[ColdEmail Stats GET]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Alias under the newer naming. Same shared snapshot, same numbers.
app.get('/api/coldemail/summary', requireAuth, async (req, res) => {
  try {
    const dataset = await withAuth(() => getOutreachDataset({ force: req.query.refresh === '1' }));
    res.json({
      ...dataset.counts,
      totalLeads: dataset.rows.length,
      replyMetrics: dataset.metrics,
      signals: dataset.signals,
      fetchedAt: new Date(dataset.at).toISOString(),
    });
  } catch (e) {
    if (e.isAuthError) return res.status(401).json({ error: 'unauthenticated' });
    console.error('[ColdEmail Summary GET]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Read-only drill-down behind the reply stat cards. Returns the same canonical
// records the counters are built from — now straight off the shared snapshot,
// so opening a drill-down costs no sheet read at all.
app.get('/api/coldemail/replies', requireAuth, async (req, res) => {
  try {
    const dataset = await withAuth(() => getOutreachDataset({ force: req.query.refresh === '1' }));
    const category = String(req.query.category || 'all');
    const rowById = new Map(dataset.rows.map(row => [row.id, row]));
    const campaignVersion = String(req.query.campaignVersion || '').trim();
    const records = filterReplyRecords(dataset.replyRecords, category).map(record => {
      const row = rowById.get(record.leadId) || {};
      return { ...record, campaignVersion: row.campaignVersion || LEGACY_UNKNOWN, pipelinePresence: Boolean(row.pipelinePresence), pipelineStage: row.pipelineStage || '', mappingStatus: row.mappingStatus || 'not_in_pipeline' };
    }).filter(record => !campaignVersion || campaignVersion === 'all' || record.campaignVersion === campaignVersion);
    res.json({
      category,
      total: dataset.replyRecords.length,
      records,
      fetchedAt: new Date(dataset.at).toISOString(),
    });
  } catch (e) {
    if (e.isAuthError) return res.status(401).json({ error: 'unauthenticated' });
    console.error('[ColdEmail Replies GET]', e.message);
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

const COLD_EMAIL_DASHBOARD_STAGES = new Set(['Import','Contacted','Replied','Review','Done','Promoted','Unsubscribed']);

// Lazy, canonical Outreach lead detail. Initial page load remains a bounded
// light page; full notes plus the timeline are fetched only when its drawer
// opens. Signals reuse the shared 30-second snapshot and never add an N+1 read.
app.get('/api/coldemail/:id/activity', requireAuth, async (req, res) => {
  try {
    const dataset = await getOutreachDataset();
    const lead = dataset.leads.find(row => row.id === req.params.id);
    if (!lead) return res.status(404).json({ error: 'not found' });
    const activities = dataset.activities.filter(row => activityMatchesLead(row, lead));
    const timeline = timelineForLead(lead, dataset, activities);
    const row = dataset.rows.find(item => item.id === lead.id) || {};
    res.json({
      lead: { ...lead, ...row }, activities: timeline,
      pipeline: {
        presence: Boolean(row.pipelinePresence), stage: row.pipelineStage || '',
        boardLeadId: row.boardLeadId || '', mappingStatus: row.mappingStatus || 'not_in_pipeline',
        matchedBy: row.matchedBy || '', automation: deriveAutomationState(lead),
      },
      integrity: inspectActivityIntegrity(activities, new Set([lead.id])),
    });
  } catch (error) {
    console.error('[ColdEmail activity GET]', error.message);
    res.status(500).json({ error: 'Could not load lead activity' });
  }
});

app.patch('/api/coldemail/:id/stage', requireAuth, async (req, res) => {
  const stage = String(req.body?.stage || '').trim();
  if (!COLD_EMAIL_DASHBOARD_STAGES.has(stage)) return res.status(422).json({ error: 'invalid stage' });
  try {
    const rowNum = await withAuth(() => findCERow(req.params.id));
    if (!rowNum) return res.status(404).json({ error: 'not found' });
    const current = await withAuth(() => sheets().spreadsheets.values.batchGet({
      spreadsheetId: SPREADSHEET_ID,
      ranges: [`${CE_SHEET_NAME}!B${rowNum}`, `${CE_SHEET_NAME}!D${rowNum}`, `${CE_SHEET_NAME}!H${rowNum}`, `${CE_SHEET_NAME}!L${rowNum}`],
    }));
    const company = current.data.valueRanges?.[0]?.values?.[0]?.[0] || '';
    const email = current.data.valueRanges?.[1]?.values?.[0]?.[0] || '';
    const previousStage = current.data.valueRanges?.[2]?.values?.[0]?.[0] || '';
    const existingNotes = current.data.valueRanges?.[3]?.values?.[0]?.[0] || '';
    if (previousStage === stage) return res.json({ ok: true, unchanged: true });
    if (stage !== 'Unsubscribed') {
      await withAuth(() => sheets().spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${CE_SHEET_NAME}!H${rowNum}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[stage]] },
      }));
      try {
        await appendColdCallActivities([{
          eventId: crypto.randomUUID(), leadId: `CE-${req.params.id}`, sourceLeadId: req.params.id,
          email, company, eventType: 'stage_changed', occurredAt: new Date().toISOString(),
          subject: `${previousStage || 'Unknown'} -> ${stage}`, content: '',
          metadata: JSON.stringify({ fromStage: previousStage, toStage: stage, trigger: 'outreach_manual' }),
        }]);
      } catch (activityError) {
        console.warn('[ColdEmail Stage PATCH] stage saved, activity append failed:', activityError.message);
      }
      return res.json({ ok: true });
    }

    const notes = ensureNote(existingNotes, '[REPLY: Unsubscribed]');
    await withAuth(() => sheets().spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: 'RAW', data: [
        { range: `${CE_SHEET_NAME}!H${rowNum}`, values: [['Unsubscribed']] },
        { range: `${CE_SHEET_NAME}!I${rowNum}`, values: [['done']] },
        { range: `${CE_SHEET_NAME}!L${rowNum}`, values: [[notes]] },
      ] },
    }));
    await withAuth(() => addSuppression(email, 'unsubscribe', company, 'manual-dashboard'));
    try {
      await appendColdCallActivities([{
        eventId: crypto.randomUUID(), leadId: `CE-${req.params.id}`, sourceLeadId: req.params.id,
        email, company, eventType: 'stage_changed', occurredAt: new Date().toISOString(),
        subject: `${previousStage || 'Unknown'} -> Unsubscribed`, content: '',
        metadata: JSON.stringify({ fromStage: previousStage, toStage: 'Unsubscribed', trigger: 'outreach_manual' }),
      }]);
    } catch (activityError) {
      console.warn('[ColdEmail Stage PATCH] unsubscribe saved, activity append failed:', activityError.message);
    }
    res.json({ ok: true });
  } catch (e) {
    if (e.isAuthError) return res.status(401).json({ error: 'unauthenticated' });
    console.error('[ColdEmail Stage PATCH]', e.message);
    res.status(500).json({ error: e.message });
  }
});

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
    const targetStage = String(req.body?.stage || '').trim();
    if (!targetStage) return res.status(422).json({ error: 'Choose a Sales Pipeline stage.' });
    const dataset = await withAuth(() => getOutreachDataset());
    const ceLead = dataset.leads.find(row => row.id === req.params.id);
    if (!ceLead) return res.status(404).json({ error: 'not found' });
    const email = normalizeEmail(ceLead.email);
    const twinCount = dataset.leads.filter(row => email && normalizeEmail(row.email) === email).length;
    const identity = resolvePromotionIdentity(ceLead, dataset.boardLeads, { coldEmailTwinCount: twinCount });
    const meetingAt = String(req.body?.meetingAt || '').trim();
    const outcome = String(req.body?.outcome || '').trim();
    const decision = promotionDecision({
      trigger: PROMOTION_TRIGGER.MANUAL, targetStage, coldEmailLead: ceLead,
      identity, meetingAt, outcome,
    });
    if (!decision.shouldPromote) {
      return res.status(decision.safety === 'conflict' ? 409 : 422).json({ error: decision.reason, decision });
    }

    const parts = String(ceLead.contactName || '').trim().split(/\s+/).filter(Boolean);
    const boardId = identity.boardLead?.id || `CE-${ceLead.id}`;
    const previousStage = identity.boardLead ? displayStageFor(identity.boardLead.stage) : '';
    const boardLead = {
      ...(identity.boardLead || {}), id: boardId, type: identity.boardLead?.type || 'trade',
      first: identity.boardLead?.first || parts[0] || '', last: identity.boardLead?.last || parts.slice(1).join(' '),
      brokerage: identity.boardLead?.brokerage || '', tradeType: identity.boardLead?.tradeType || ceLead.tradeType || '',
      company: identity.boardLead?.company || ceLead.company || '', city: identity.boardLead?.city || ceLead.city || '',
      cityTrade: identity.boardLead?.cityTrade || ceLead.city || '', phone: identity.boardLead?.phone || '',
      email: identity.boardLead?.email || ceLead.email || '', website: identity.boardLead?.website || ceLead.website || '',
      stage: decision.targetStage, priority: identity.boardLead?.priority || (decision.targetStage === 'hot' ? 'hot' : 'warm'),
      followup: identity.boardLead?.followup || '', notes: identity.boardLead?.notes || ceLead.notes || '',
      created: identity.boardLead?.created || new Date().toISOString(),
    };

    // Human-owned promotion is fail-closed: hold the ColdEmail twin(s) before
    // the board write. If the later write fails, the safe failure is a held
    // Outreach lead, never an opportunity that keeps receiving cold mail.
    if (stageRequiresHold(decision.targetStage)) await withAuth(() => applyManualHold(boardId, ceLead.email));

    if (identity.boardLead) {
      const boardRow = await withAuth(() => findRow(boardId));
      if (!boardRow) return res.status(409).json({ error: 'Matched board lead disappeared; promotion stopped.' });
      await withAuth(() => sheets().spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A${boardRow}:Q${boardRow}`,
        valueInputOption: 'RAW', requestBody: { values: [COLUMNS.map(field => String(boardLead[field] ?? ''))] },
      }));
      if (meetingAt || outcome) await withAuth(() => sheets().spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!U${boardRow}:V${boardRow}`,
        valueInputOption: 'RAW', requestBody: { values: [[meetingAt || identity.boardLead.meetingAt || '', outcome || identity.boardLead.outcome || '']] },
      }));
    } else {
      await withAuth(() => sheets().spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID, range: AGENT_READ_RANGE,
        valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [[...COLUMNS.map(field => String(boardLead[field] ?? '')), '', '', '', meetingAt, outcome, String(req.body?.conversationContext || '').trim().slice(0, 10000)]] },
      }));
    }

    const eventId = stableActivityId('pipeline-promotion', [ceLead.id, boardId, decision.targetStage, PROMOTION_TRIGGER.MANUAL]);
    if (!dataset.activities.some(row => row.eventId === eventId)) {
      const existingAcquisition = dataset.activities
        .filter(row => row.leadId === boardId || row.sourceLeadId === ceLead.id)
        .map(row => { try { return JSON.parse(row.metadata || '{}'); } catch (_) { return {}; } })
        .find(metadata => metadata.acquisitionCampaignVersion);
      const touch = latestSendAttribution(dataset.activities.filter(row => row.sourceLeadId === ceLead.id || row.leadId === `CE-${ceLead.id}`));
      await upsertIntegrationRow(COLD_CALL_ACTIVITY_SHEET, COLD_CALL_ACTIVITY_HEADER, 'eventId', {
        eventId, leadId: boardId, sourceLeadId: ceLead.id, email: ceLead.email || '', company: ceLead.company || '',
        eventType: 'pipeline_promoted', occurredAt: new Date().toISOString(),
        subject: `Added to Sales Pipeline — ${decision.targetStage}`, content: '',
        metadata: JSON.stringify({
          fromStage: previousStage, toStage: decision.targetStage, trigger: PROMOTION_TRIGGER.MANUAL, sourceEventId: '',
          ...promotionAttribution(touch, existingAcquisition ? {
            campaignVersion: existingAcquisition.acquisitionCampaignVersion,
            campaignFamily: existingAcquisition.acquisitionCampaignFamily || '',
            sourceSendEventId: existingAcquisition.acquisitionSourceEventId || '',
            sourceMessageId: existingAcquisition.acquisitionSourceMessageId || '',
          } : {}),
        }),
      });
    }
    res.json({ ok: true, boardLeadId: boardId, created: !identity.boardLead, stage: decision.targetStage, automationResumed: false });
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
function gmailInboxOptions() {
  const secondary = publicGmailInboxRegistry(parseGmailInboxRegistry());
  secondary.forEach(inbox => { inbox.deliveryImplemented = false; });
  const primary = {
      id: 'primary', email: process.env.FROM_EMAIL || 'Current Gmail inbox', status: 'active',
      dailyLimit: Number(process.env.DAILY_SEND_LIMIT || 40), credentialConfigured: Boolean(process.env.GMAIL_TOKEN_JSON),
      identityVerified: true, sendEligible: Boolean(process.env.GMAIL_TOKEN_JSON), currentRoute: true,
      deliveryImplemented: true,
  };
  return [primary, ...secondary];
}

app.get('/api/integrations/gmail-inboxes', requireAuth, (_req, res) => {
  try { res.json({ inboxes: gmailInboxOptions() }); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/outreach/routing-options', requireAuth, (_req, res) => {
  try { res.json({ niches: ['dental','roofing'], inboxes: gmailInboxOptions(), templates: EMAIL_TEMPLATES }); }
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
    const attribution = coldSendAttribution(found.lead, 1);
    await upsertIntegrationRow(PROVIDER_LEADS_SHEET, PROVIDER_LEADS_HEADER, 'mappingKey', {
      internalLeadId: found.lead.id, provider: 'smartlead', externalLeadId: result.lead_ids?.[0] || '', externalCampaignId: mapping.externalCampaignId,
      mappingId: '', normalizedStatus: result.testMode ? 'Test mode' : (result.added_count ? 'Queued' : 'Skipped'), rawStatus: result.message || '',
      lastProviderEventAt: '', lastSynchronizedAt: now, unsubscribedAt: '', complianceNote: String(req.body.complianceNote || ''), metadata: JSON.stringify({ addedCount: result.added_count || 0, skippedCount: result.skipped_count || 0, attribution }), mappingKey, normalizedEmail: eligibility.email,
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
    if (incomingStatus === 'Sent') {
      let providerMetadata = {};
      try { providerMetadata = JSON.parse(providerRow?.metadata || '{}'); } catch (_) {}
      const attribution = providerMetadata.attribution;
      if (!attribution?.campaignVersion) throw new Error('Smartlead send has no immutable campaign attribution');
      await upsertIntegrationRow(COLD_CALL_ACTIVITY_SHEET, COLD_CALL_ACTIVITY_HEADER, 'eventId', {
        eventId: `smartlead:${eventRow.eventId}`, leadId: `CE-${found.lead.id}`, sourceLeadId: found.lead.id,
        email: found.lead.email || audit.email || '', company: found.lead.company || '',
        eventType: eventRow.eventType === 'FIRST_EMAIL_SENT' ? 'initial_email_sent' : 'follow_up_sent',
        occurredAt: audit.timestamp || now, subject: audit.subject || '', content: '',
        metadata: JSON.stringify({ provider: 'smartlead', providerEventId: eventRow.eventId, ...attribution }),
      });
    }
  }
  const email = normalizeEmail(audit.email || found?.lead.email || providerRow?.normalizedEmail);
  const mappingKey = providerRow?.mappingKey || buildMappingKey({ externalCampaignId: eventRow.externalCampaignId, externalLeadId: eventRow.externalLeadId, email });
  if (mappingKey) {
    let priorMetadata = {};
    try { priorMetadata = JSON.parse(providerRow?.metadata || '{}'); } catch (_) {}
    await upsertIntegrationRow(PROVIDER_LEADS_SHEET, PROVIDER_LEADS_HEADER, 'mappingKey', { ...(providerRow || {}), internalLeadId: found?.lead.id || providerRow?.internalLeadId || '', provider: 'smartlead', externalLeadId: eventRow.externalLeadId || providerRow?.externalLeadId || '', externalCampaignId: eventRow.externalCampaignId, mappingId: audit.mappingId || providerRow?.mappingId || '', normalizedStatus: incomingStatus, rawStatus: audit.providerStatus || eventRow.eventType, lastProviderEventAt: audit.timestamp || now, lastSynchronizedAt: now, unsubscribedAt: incomingStatus === 'Unsubscribed' ? now : providerRow?.unsubscribedAt || '', metadata: JSON.stringify({ ...priorMetadata, category: audit.category || '', replyPreview: audit.replyPreview || '', subject: audit.subject || '' }), mappingKey, normalizedEmail: email });
  }
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
    const lateReplyDue = isDailyLateReplyWindow();
    spawnAgentCheckOnly(lateReplyDue ? { LATE_REPLY_CHECK: 'true' } : {});
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

  // Calendar incremental sync is independently gated. With the flag OFF the
  // first line of the orchestrator returns before reading Calendar, Sheets, or
  // checkpoint state. Registering the cadence now therefore cannot activate it.
  cron.schedule('1,6,11,16,21,26,31,36,41,46,51,56 * * * *', () => {
    runGoogleCalendarSync()
      .then(result => {
        if (!result.skipped) console.log(`[Calendar sync] complete — ${result.mutations || 0} mutation(s)`);
      })
      .catch(error => console.error('[Calendar sync] unhandled failure:', error.message));
  }, { timezone: 'America/Vancouver' });
  console.log('[cron] Google Calendar booking sync scheduled every 5 minutes (feature-gated)');

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
  console.log('[cron] Late-reply terminal watcher hosted by check-only: daily at 12:15 Pacific');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ScaleLab Pipeline → http://localhost:${PORT}`));
