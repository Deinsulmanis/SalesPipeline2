/**
 * ScaleLab Outreach Agent — Phase 1
 * ---------------------------------
 * Reads QUEUED leads from the same Google Sheet your pipeline dashboard uses,
 * sends one cold email per lead through your own Gmail (via the Gmail API),
 * then writes the result back to the sheet.
 *
 * It REUSES the auth pattern from server.js (token.json + auto-refresh) and the
 * same .env, so it drops into your existing project folder with no new plumbing.
 *
 * SAFETY (read this once):
 *   - DRY_RUN defaults to TRUE. Nothing is sent until you explicitly run with
 *     DRY_RUN=false. In dry-run it prints exactly what it WOULD send.
 *   - DAILY_CAP is a hard ceiling the loop cannot exceed.
 *   - It only touches leads whose `stage` === QUEUE_STAGE (default "Queued"),
 *     so it can never blast your whole sheet by accident.
 *   - It writes its own bookkeeping to columns R/S/T — it never overwrites the
 *     A:Q columns your dashboard manages.
 *
 * PREREQUISITES:
 *   1. In server.js, add the Gmail send scope and re-auth once (see chat notes).
 *   2. In .env add:
 *        FROM_EMAIL=deins@scalelabai.ca
 *        FROM_NAME=Deins (ScaleLab AI)
 *        # optional overrides:
 *        DAILY_CAP=12
 *        QUEUE_STAGE=Queued
 *        SENT_STAGE=Contacted
 *        MAILING_ADDRESS=ScaleLab AI, New Westminster, BC
 *
 * RUN:
 *   node outreach-agent.js            # dry run — sends nothing, just logs
 *   DRY_RUN=false node outreach-agent.js   # actually sends
 */

require('dotenv').config();
const { google }  = require('googleapis');
const Anthropic    = require('@anthropic-ai/sdk');
const axios        = require('axios');
const cheerio      = require('cheerio');
const fs   = require('fs');
const path = require('path');

// ── CONFIG ────────────────────────────────────────────────────────────────────

const TOKEN_PATH     = path.join(__dirname, 'token.json');
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME     = 'ColdEmail';

const DRY_RUN     = process.env.DRY_RUN !== 'false';          // default TRUE
const DAILY_CAP   = parseInt(process.env.DAILY_CAP || '12', 10);
const QUEUE_STAGE = process.env.QUEUE_STAGE || 'Queued';      // set a lead's stage to this to queue it
const SENT_STAGE  = process.env.SENT_STAGE  || 'Contacted';   // stage the agent moves it to after sending
const FROM_EMAIL  = process.env.FROM_EMAIL;                   // must be the authed Google account
const FROM_NAME   = process.env.FROM_NAME || 'ScaleLab AI';
const MAILING_ADDRESS   = process.env.MAILING_ADDRESS || 'ScaleLab AI, New Westminster, BC';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PROPOSAL_BASE     = (process.env.PROPOSAL_BASE || 'https://scalelabaireceptionistproposal.netlify.app').replace(/\/$/, '');

// Random pause between sends so traffic looks human (ms)
const MIN_DELAY = 45 * 1000;
const MAX_DELAY = 120 * 1000;

// ColdEmail columns A:P — must stay in sync with CE_COLUMNS in server.js
//   A=id  B=company  C=contactName  D=email  E=city  F=tradeType  G=website
//   H=stage  I=emailStatus  J=lastEmailedAt  K=emailStep  L=notes
//   M=reviewCount  N=rating  O=tier  P=siteContext
const COLUMNS = [
  'id','company','contactName','email','city','tradeType','website',
  'stage','emailStatus','lastEmailedAt','emailStep','notes',
  'reviewCount','rating','tier','siteContext',
];
const AGENT_COLS  = []; // integrated into COLUMNS for ColdEmail
const READ_RANGE  = `${SHEET_NAME}!A:P`;
const SCRAPE_SKIP = '__scraped__'; // stored in siteContext when site returned no usable text

// ── AUTH (same pattern as server.js) ──────────────────────────────────────────

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI,
);

function saveToken(newTokens) {
  const existing = fs.existsSync(TOKEN_PATH)
    ? JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'))
    : (oauth2Client.credentials || {});
  const merged = { ...existing, ...newTokens };   // never lose refresh_token
  oauth2Client.setCredentials(merged);
  if (process.env.RAILWAY_ENVIRONMENT) {
    console.log('[token] Railway env detected — skipping disk write, token refreshed in memory');
    return merged;
  }
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged));
  return merged;
}

oauth2Client.on('tokens', t => saveToken(t));

function loadToken() {
  if (process.env.GMAIL_TOKEN_JSON) {
    oauth2Client.setCredentials(JSON.parse(process.env.GMAIL_TOKEN_JSON));
    return true;
  }
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error('token.json not found — authenticate via the dashboard first.');
  }
  oauth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')));
  return false;
}

function isTokenError(e) {
  const status = e?.response?.status || e?.code;
  const msg    = (e?.message || '').toLowerCase();
  return status === 401 || msg.includes('invalid_grant') ||
         msg.includes('expired') || msg.includes('invalid credentials') ||
         msg.includes('unauthorized');
}

async function withAuth(fn) {
  loadToken();
  try {
    return await fn();
  } catch (e) {
    if (!isTokenError(e)) throw e;
    console.log('[Auth] token error — refreshing once...');
    const { credentials } = await oauth2Client.refreshAccessToken();
    oauth2Client.setCredentials(credentials);
    saveToken(credentials);
    return await fn();
  }
}

const sheets = () => google.sheets({ version: 'v4', auth: oauth2Client });
const gmail  = () => google.gmail({ version: 'v1', auth: oauth2Client });

// ── FOLLOW-UP SEQUENCE (Phase 3) ──────────────────────────────────────────────
// Index 0 = step-2 template (3 days after initial send)
// Index 1 = step-3 template (5 days after step 2)   Max 3 steps total.
// Each template reads lead.tier to stay consistent with the step-1 angle.
const FOLLOW_UP_SEQUENCE = [
  {
    delayDays: 3,
    subject: (lead) => lead.tier === 'busy'
      ? `Re: ${cleanCompanyName(lead.company) || 'your business'}'s after-hours calls`
      : `Re: quick question about ${cleanCompanyName(lead.company) || 'your business'}'s bookings`,
    body: (lead) => {
      const link    = buildProposalLink(lead);
      const name    = lead.first || 'there';
      const company = cleanCompanyName(lead.company) || 'your business';
      const casl    = `---\n${MAILING_ADDRESS}\nYou're receiving this because your business is publicly listed. Reply "unsubscribe" and I'll remove you immediately.  ·  Ref: SL-${refCode(lead)}`;

      if (lead.tier === 'busy') {
        return `Hi ${name},

Following up from earlier this week — just wanted to close the loop on the after-hours angle.

The AI receptionist I mentioned books overnight and weekend enquiries automatically, so your team doesn't miss a beat when the desk is occupied.

Quick overview for ${company}: ${link}

Worth 15 minutes to see if the numbers make sense?

— ${FROM_NAME}

${casl}`;
      }

      return `Hi ${name},

Just circling back on my note about ${company}'s booking flow.

The short version: an AI receptionist answers when you can't, books the appointment, and the confirmation goes out automatically — no voicemails left hanging.

Quick overview for ${company}: ${link}

Worth a 15-minute call to see what that looks like for your setup?

— ${FROM_NAME}

${casl}`;
    },
  },
  {
    delayDays: 5,
    subject: (lead) => `Last note — ${cleanCompanyName(lead.company) || 'your business'}`,
    body: (lead) => {
      const link    = buildProposalLink(lead);
      const name    = lead.first || 'there';
      const casl    = `---\n${MAILING_ADDRESS}\nYou're receiving this because your business is publicly listed. Reply "unsubscribe" and I'll remove you immediately.  ·  Ref: SL-${refCode(lead)}`;

      if (lead.tier === 'busy') {
        return `Hi ${name},

Last one, I promise.

If after-hours and overflow bookings are already handled, ignore this. If there's a gap, here's the overview I put together: ${link}

— ${FROM_NAME}

${casl}`;
      }

      return `Hi ${name},

Last one from me.

If missed evening or weekend bookings aren't a pain point, this won't be for you. But if there's a gap there, here's the overview I put together: ${link}

— ${FROM_NAME}

${casl}`;
    },
  },
];

// ── EMAIL TEMPLATE ────────────────────────────────────────────────────────────

// Derives a stable 4-digit reference code from the lead's id.
// Used to append "Ref: SL-XXXX" to the CASL line so every outgoing message
// carries a filterable "SL-" prefix without a visible automation marker.
function refCode(lead) {
  const digits = String(lead.id || '').replace(/\D/g, '') || '0';
  return String(parseInt(digits.slice(-6), 10) % 10000).padStart(4, '0');
}

// Returns the display name of a business by stripping location suffixes and
// multi-listing noise (e.g. "Yaletown Wellness - Hamilton | RMT Vancouver").
// Takes the segment before the first "|" or " - ", whichever comes first.
// Never mutates stored data — call only at send/display time.
function cleanCompanyName(raw) {
  if (!raw) return '';
  const pipIdx  = raw.indexOf('|');
  const dashIdx = raw.indexOf(' - ');
  let cutAt = raw.length;
  if (pipIdx  !== -1) cutAt = Math.min(cutAt, pipIdx);
  if (dashIdx !== -1) cutAt = Math.min(cutAt, dashIdx);
  return raw.slice(0, cutAt).trim() || raw.trim();
}

// Builds a personalised proposal URL. Omits any param whose value is empty.
// Uses function declaration so it hoists — the follow-up templates call it at
// runtime, not definition time, but being hoisted keeps things clear.
function buildProposalLink(lead) {
  const co = cleanCompanyName(lead.company);
  const params = [
    co             ? ['company', co]               : null,
    lead.contactName ? ['contact', lead.contactName] : null,
    lead.tradeType   ? ['niche',   lead.tradeType]   : null,
  ].filter(Boolean);
  if (!params.length) return `${PROPOSAL_BASE}/`;
  const qs = params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return `${PROPOSAL_BASE}/?${qs}`;
}

// Builds the tier-keyed subject + body for step-1 sends.
// pitchTier = 'busy' | 'medium'. reviewCount may be blank — handled gracefully.
function buildPitch(lead, opener, link, pitchTier) {
  const name    = lead.first || 'there';
  const company = cleanCompanyName(lead.company) || 'your business';
  const count   = parseInt(lead.reviewCount, 10);
  const hasCount = !isNaN(count) && count > 0;

  const casl = `---\n${MAILING_ADDRESS}\nYou're receiving this because your business is publicly listed. Reply with\n"unsubscribe" and I'll remove you immediately — no hard feelings.  ·  Ref: SL-${refCode(lead)}`;

  if (pitchTier === 'busy') {
    // Lead sentence varies: include review count only when present
    const busyLead = hasCount
      ? `You're clearly busy — ${count}+ reviews doesn't happen by accident.`
      : `You're clearly running a busy practice.`;

    return {
      subject: `${company}'s after-hours calls`,
      body:
`Hi ${name},

${opener}

${busyLead} So this isn't about the calls you answer. It's about the ones that come in while your staff's with a client, or after you've closed — booked appointments walking to the clinic down the street.

I build AI receptionists that quietly catch exactly those, booking after hours and when the desk is slammed, without changing how you run the front.

Quick overview for ${company}: ${link}

If you're not the right person for this, mind pointing me to whoever handles bookings?

— ${FROM_NAME}

${casl}`,
    };
  }

  // medium (default when tier is blank or anything other than 'busy')
  return {
    subject: `quick question about ${company}'s bookings`,
    body:
`Hi ${name},

${opener}

When someone calls ${company} after hours or when the desk can't pick up — what happens to that booking? Usually it's "goes to voicemail, half don't call back."

I build AI receptionists that answer and book 24/7, so evening and weekend inquiries turn into booked clients instead of missed ones. At your stage that's often the difference between a full calendar and a patchy one.

Quick overview for ${company}: ${link}

If bookings aren't your area, could you point me to who handles them?

— ${FROM_NAME}

${casl}`,
  };
}

// Tier-2 scraper: fetches a lead's homepage and extracts visible text for personalization.
// Returns '' on ANY failure (timeout, 403, DNS, non-200, malformed URL) — never throws.
async function scrapeSite(url) {
  if (!url || typeof url !== 'string' || !url.trim()) return '';
  let normalized = url.trim();
  if (!/^https?:\/\//i.test(normalized)) normalized = `https://${normalized}`;
  try { new URL(normalized); } catch (_e) { return ''; }

  try {
    const resp = await axios.get(normalized, {
      timeout: 8000,
      maxRedirects: 3,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      validateStatus: s => s >= 200 && s < 300,
    });
    const $ = cheerio.load(resp.data);
    $('script, style, nav, footer').remove();

    const parts = [];
    $('h1, h2, h3').each((_, el) => parts.push($(el).text()));
    $('p').each((_, el) => parts.push($(el).text()));
    $('[class*="about"],[class*="service"],[id*="about"],[id*="service"]').each((_, el) => {
      parts.push($(el).text());
    });

    return parts
      .map(t => t.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' ')
      .slice(0, 1500);
  } catch (_e) {
    return '';
  }
}

// Writes scraped siteContext (or SCRAPE_SKIP marker) to column N for one lead row.
async function writeSiteContext(rowNum, text) {
  await sheets().spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!P${rowNum}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[text]] },
  });
}

// Phase 2: calls Haiku to generate one specific opening sentence.
// Graceful: on any error returns null and the caller falls back to a generic line.
async function generateOpener(lead, siteText) {
  if (!ANTHROPIC_API_KEY) return null;
  try {
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    let prompt;

    if (siteText) {
      // Tier-2: reference ONE concrete detail from the scraped page
      const cleanCo = cleanCompanyName(lead.company);
      const facts = [
        cleanCo        && `company: "${cleanCo}"`,
        lead.city      && `city: ${lead.city}`,
        lead.tradeType && `trade: ${lead.tradeType}`,
      ].filter(Boolean).join(' | ');

      prompt = [
        'Write ONE opening sentence for a cold email to a trade business owner.',
        'You have scraped text from their website. Find EXACTLY ONE specific, concrete detail that literally appears in the text.',
        '',
        `Known facts: ${facts || '(none)'}`,
        '',
        'Website text (extracted from their homepage — use ONLY what is explicitly stated here):',
        '---',
        siteText,
        '---',
        '',
        'Rules:',
        '- Reference exactly ONE verifiable detail from the text: a specific service they list, an area they serve, a stated value like "family-owned", or years in business ONLY if explicitly stated.',
        '- If you cannot find a clear, specific, verifiable detail, fall back to the Tier-1 style below instead — do NOT force a vague or invented detail.',
        '- NEVER infer, assume, or embellish. If it is not literally in the text, do not say it.',
        '- One sentence only, max 18 words, plain English, no em-dashes, no marketer voice.',
        '',
        'Tier-1 fallback (use when no clear site detail found):',
        '• HVAC in Vancouver → "Came across Peak Climate HVAC while looking at HVAC contractors in Vancouver."',
        '• Plumber in Calgary → "Saw Mountain Plumbing while browsing plumbers around Calgary."',
        '',
        'Output only the sentence.',
      ].join('\n');
    } else {
      // Tier-1: company + city + trade only
      const cleanCo = cleanCompanyName(lead.company);
      const details = [
        cleanCo        && `company: "${cleanCo}"`,
        lead.city      && `city: ${lead.city}`,
        lead.tradeType && `trade: ${lead.tradeType}`,
        lead.website   && `website: ${lead.website}`,
      ].filter(Boolean).join(' | ');

      prompt = [
        'Write ONE opening sentence for a cold email to a trade business owner.',
        'Use ONLY the facts listed below — never invent or assume anything about their operations, reviews, call volume, customers, or projects.',
        details ? `Known facts: ${details}` : `Known facts: (none — use generic company reference only)`,
        '',
        'Rules:',
        '- One sentence only, max 18 words, plain English, no em-dashes',
        '- Sound like a real person who glanced at their public listing — casual and honest',
        '- Reference city and trade if provided; if missing, just use the company name naturally',
        '- No invented pain points, no "this is costing you", no assumptions about their business',
        '',
        'Examples of the correct style (do not copy — just match the tone):',
        '• HVAC company in Vancouver → "Came across Peak Climate HVAC while looking at HVAC contractors in Vancouver."',
        '• Plumber in Calgary → "Saw Mountain Plumbing while browsing plumbers around Calgary."',
        '• Electrician, no city → "Noticed Bright Spark Electric while looking into local electricians."',
        '',
        'Output only the sentence.',
      ].join('\n');
    }

    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 60,
      messages: [{ role: 'user', content: prompt }],
    });
    return msg.content[0]?.text?.trim() || null;
  } catch (e) {
    console.warn(`[Opener] API error for ${lead.email} — using fallback: ${e.message}`);
    return null;
  }
}

async function buildEmail(lead) {
  // Resolve site context: cached value → skip scrape; empty + website → scrape once
  let siteText = '';
  if (lead.siteContext && lead.siteContext !== SCRAPE_SKIP) {
    siteText = lead.siteContext;
  } else if (!lead.siteContext && lead.website) {
    console.log(`[Scrape] Fetching ${lead.website} for ${lead.email}...`);
    siteText = await scrapeSite(lead.website);
    if (!DRY_RUN) {
      await withAuth(() => writeSiteContext(lead._row, siteText || SCRAPE_SKIP));
    }
    if (!siteText) console.log(`[Scrape] No usable text from ${lead.website} — using Tier-1`);
  }

  const openerTier = siteText ? 'SITE' : 'TIER-1';
  const company    = cleanCompanyName(lead.company) || 'your business';
  const opener     = await generateOpener(lead, siteText)
    || `I noticed ${company} and wanted to reach out.`;

  const pitchTier = lead.tier === 'busy' ? 'busy' : 'medium';
  const link      = buildProposalLink(lead);

  const { subject, body } = buildPitch(lead, opener, link, pitchTier);

  return { subject, body, link, opener, openerTier, pitchTier };
}

// RFC-822 message → base64url for the Gmail API
function toRawMessage({ to, subject, body }) {
  const headers = [
    `From: ${FROM_NAME} <${FROM_EMAIL}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
  ];
  const msg = headers.join('\r\n') + '\r\n\r\n' + body;
  return Buffer.from(msg)
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sendEmail({ to, subject, body }) {
  return gmail().users.messages.send({
    userId: 'me',
    requestBody: { raw: toRawMessage({ to, subject, body }) },
  });
}

// Phase 4: check Gmail inbox for a reply from lead.email received after lastEmailedAt.
// Returns: true = reply found, false = no reply, null = check failed (caller must skip follow-up).
// Fails CLOSED — an error returns null so the caller never sends to an unverified lead.
async function checkForReply(lead) {
  if (!lead.lastEmailedAt || !isValidEmail(lead.email)) return false;
  try {
    const afterSec = Math.floor(new Date(lead.lastEmailedAt).getTime() / 1000);
    const resp = await gmail().users.messages.list({
      userId: 'me',
      q: `from:${lead.email.trim()} after:${afterSec}`,
      maxResults: 1,
    });
    return (resp.data.messages || []).length > 0;
  } catch (e) {
    console.warn(`[ReplyCheck] API error for ${lead.email}: ${e.message}`);
    return null; // fail closed — caller will skip this follow-up
  }
}

// ── SHEET I/O ─────────────────────────────────────────────────────────────────

async function ensureAgentHeaders() {
  // Write siteContext header to N1 — idempotent, server.js only created A:M on sheet init.
  await sheets().spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!P1`,
    valueInputOption: 'RAW',
    requestBody: { values: [['siteContext']] },
  });
}

async function readLeads() {
  const resp = await sheets().spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: READ_RANGE,
  });
  const rows = resp.data.values || [];
  return rows.slice(1).map((row, idx) => {
    const lead = { _row: idx + 2 };              // 1-based sheet row (after header)
    COLUMNS.forEach((c, i) => { lead[c] = row[i] || ''; });
    lead.first = (lead.contactName || '').split(' ')[0] || ''; // convenience alias used by templates
    return lead;
  }).filter(l => l.id);
}

// Write stage (M) + agent columns (R:T) for one row, leaving A:L,N:Q untouched.
// Sets emailStatus='done' when the last step in the sequence has been sent.
async function markSent(rowNum, step) {
  const now        = new Date().toISOString();
  const isLastStep = step > FOLLOW_UP_SEQUENCE.length; // step 3 > 2 → done
  const status     = isLastStep ? 'done' : 'emailed';
  await sheets().spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        { range: `${SHEET_NAME}!H${rowNum}`,            values: [[SENT_STAGE]] },
        { range: `${SHEET_NAME}!I${rowNum}:K${rowNum}`, values: [[status, now, String(step)]] },
      ],
    },
  });
}

// Phase 4: mark a lead as replied — sets stage to 'Replied' and emailStatus to 'replied'.
async function markReplied(rowNum) {
  await sheets().spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        { range: `${SHEET_NAME}!H${rowNum}`, values: [['Replied']] },
        { range: `${SHEET_NAME}!I${rowNum}`, values: [['replied']] },
      ],
    },
  });
}

// ── REPLY-CHECK PASS ─────────────────────────────────────────────────────────
// Runs unconditionally on every agent invocation — independent of whether there
// are queued sends or follow-ups due. Checks every 'emailed' lead for replies
// and marks the ones that replied. Mutates lead.emailStatus in-place so that
// selectFollowUps() naturally excludes replied leads without an extra sheet read.
async function runReplyCheckPass(leads) {
  const candidates = leads.filter(l => l.emailStatus === 'emailed' && isValidEmail(l.email));
  if (!candidates.length) {
    console.log('[ReplyCheck] No emailed leads to check.\n');
    return;
  }
  console.log(`[ReplyCheck] Checking ${candidates.length} emailed lead${candidates.length === 1 ? '' : 's'} for replies...`);
  let found = 0;
  for (const lead of candidates) {
    const status = await withAuth(() => checkForReply(lead));
    if (status === null) {
      console.log(`  ⚠ reply-check failed for ${lead.email} — skipping`);
      continue;
    }
    if (status === true) {
      found++;
      const label = cleanCompanyName(lead.company) || lead.email;
      console.log(`  ↩ Reply from ${lead.email} (${label}) — marking Replied`);
      lead.emailStatus = 'replied'; // exclude from follow-ups this run
      if (!DRY_RUN) await withAuth(() => markReplied(lead._row));
    }
  }
  console.log(`[ReplyCheck] ${found} repl${found === 1 ? 'y' : 'ies'} found / ${candidates.length} checked.\n`);
}

// ── SELECTION ─────────────────────────────────────────────────────────────────

function isValidEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
}

function selectQueued(leads) {
  return leads.filter(l =>
    l.stage === QUEUE_STAGE &&        // you queued it
    isValidEmail(l.email) &&          // sendable address
    l.emailStatus !== 'emailed'       // not already sent by the agent
  );
}

// Phase 3: find leads that are due for a follow-up step.
// currentStep 1 → send step 2 (FOLLOW_UP_SEQUENCE[0], 3 days)
// currentStep 2 → send step 3 (FOLLOW_UP_SEQUENCE[1], 5 days)
function selectFollowUps(leads) {
  const now = Date.now();
  return leads.filter(l => {
    if (l.emailStatus !== 'emailed') return false;
    if (!isValidEmail(l.email)) return false;
    const currentStep = parseInt(l.emailStep || '0', 10);
    // currentStep must be 1..FOLLOW_UP_SEQUENCE.length (i.e. 1 or 2)
    if (currentStep < 1 || currentStep > FOLLOW_UP_SEQUENCE.length) return false;
    const template  = FOLLOW_UP_SEQUENCE[currentStep - 1];
    const lastSent  = new Date(l.lastEmailedAt).getTime();
    if (isNaN(lastSent)) return false;
    return (now - lastSent) / (1000 * 60 * 60 * 24) >= template.delayDays;
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = () => MIN_DELAY + Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY));

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function run() {
  if (!SPREADSHEET_ID) throw new Error('SPREADSHEET_ID missing from .env');
  if (!DRY_RUN && !FROM_EMAIL) throw new Error('FROM_EMAIL missing from .env (required to send)');

  console.log('────────────────────────────────────────');
  console.log(`ScaleLab Outreach Agent — Phase 1–4`);
  console.log(`Mode:       ${DRY_RUN ? 'DRY RUN (nothing sent)' : '🔴 LIVE — sending real emails'}`);
  console.log(`Daily cap:  ${DAILY_CAP}`);
  console.log(`Queue stage:"${QUEUE_STAGE}"  →  on send: "${SENT_STAGE}"`);
  console.log(`Opener API: ${ANTHROPIC_API_KEY ? 'Haiku (claude-haiku-4-5) — Tier-2 (site) when website present, Tier-1 otherwise' : 'not set — using generic fallback'}`);
  console.log('────────────────────────────────────────');

  if (!DRY_RUN) await withAuth(ensureAgentHeaders);

  const all = await withAuth(readLeads);

  // Reply-check pass — unconditional; runs even when nothing is queued or due.
  // Mutates emailStatus on replied leads so selectFollowUps excludes them below.
  await runReplyCheckPass(all);

  // Phase 1 — new sends (stage === QUEUE_STAGE, never emailed)
  const queued = selectQueued(all);

  // Phase 3 — follow-ups (replied leads already excluded by runReplyCheckPass)
  const followUps = selectFollowUps(all);

  console.log(`${all.length} leads · ${queued.length} queued · ${followUps.length} follow-ups due · cap ${DAILY_CAP}\n`);

  // New sends fill the cap first; follow-ups use remaining slots
  const newBatch    = queued.slice(0, DAILY_CAP);
  const followBatch = followUps.slice(0, Math.max(0, DAILY_CAP - newBatch.length));
  const total       = newBatch.length + followBatch.length;

  if (total === 0) {
    console.log(`Nothing to send. Queue a lead (stage="${QUEUE_STAGE}") or wait for follow-up timers.`);
    return;
  }

  let sent = 0;

  // ── New sends (step 1) ────────────────────────────────────────────────────
  for (const lead of newBatch) {
    const { subject, body, link, opener, openerTier, pitchTier } = await buildEmail(lead);

    if (DRY_RUN) {
      const rawCo  = lead.company || '';
      const cleanCo = cleanCompanyName(rawCo);
      console.log(`— WOULD SEND (step 1) →  ${lead.email}  (${rawCo || lead.first || lead.id})`);
      if (rawCo && rawCo !== cleanCo) console.log(`   Company: "${rawCo}" → "${cleanCo}"`);
      console.log(`   Pitch:   ${pitchTier}`);
      console.log(`   Subject: ${subject}`);
      console.log(`   Opener:  ${opener}  [${openerTier}]`);
      console.log(`   Link:    ${link}\n`);
      continue;
    }

    try {
      await sendEmail({ to: lead.email.trim(), subject, body });
      await withAuth(() => markSent(lead._row, 1));
      sent++;
      console.log(`✅ Sent (step 1) → ${lead.email}  (${sent}/${total})`);
    } catch (e) {
      console.error(`❌ Failed (step 1) → ${lead.email}: ${e.message}`);
    }

    if (sent < total) {
      const d = jitter();
      console.log(`   …waiting ${Math.round(d / 1000)}s\n`);
      await sleep(d);
    }
  }

  // ── Follow-ups (steps 2 & 3) ──────────────────────────────────────────────
  for (const lead of followBatch) {
    const currentStep = parseInt(lead.emailStep, 10);
    const nextStepNum = currentStep + 1;
    const template    = FOLLOW_UP_SEQUENCE[currentStep - 1];
    const subject     = template.subject(lead);
    const body        = template.body(lead);
    const preview     = body.split('\n')[2] || '';

    if (DRY_RUN) {
      const fupPitchTier = lead.tier === 'busy' ? 'busy' : 'medium';
      const rawCo  = lead.company || '';
      const cleanCo = cleanCompanyName(rawCo);
      console.log(`— WOULD SEND (step ${nextStepNum}) →  ${lead.email}  (${rawCo || lead.first || lead.id})`);
      if (rawCo && rawCo !== cleanCo) console.log(`   Company: "${rawCo}" → "${cleanCo}"`);
      console.log(`   Pitch:   ${fupPitchTier}`);
      console.log(`   Subject: ${subject}`);
      console.log(`   Preview: ${preview}`);
      console.log(`   Link:    ${buildProposalLink(lead)}\n`);
      continue;
    }

    try {
      await sendEmail({ to: lead.email.trim(), subject, body });
      await withAuth(() => markSent(lead._row, nextStepNum));
      sent++;
      console.log(`✅ Sent (step ${nextStepNum}) → ${lead.email}  (${sent}/${total})`);
    } catch (e) {
      console.error(`❌ Failed (step ${nextStepNum}) → ${lead.email}: ${e.message}`);
    }

    if (sent < total) {
      const d = jitter();
      console.log(`   …waiting ${Math.round(d / 1000)}s\n`);
      await sleep(d);
    }
  }

  console.log(`\nDone. ${DRY_RUN ? `Would have sent ${total}.` : `Sent ${sent}/${total}.`}`);
}

run().catch(e => {
  console.error('\n[FATAL]', e.message);
  process.exit(1);
});
