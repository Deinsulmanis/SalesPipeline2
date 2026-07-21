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
const crypto = require('crypto');
// Junk classifier shared with check-leads.js (CLI) and server.js import —
// legacy junk rows predate the import choke point, so selection re-checks.
const { classify: classifyLeadEmail } = require('./check-leads');

// ── CONFIG ────────────────────────────────────────────────────────────────────

const TOKEN_PATH     = path.join(__dirname, 'token.json');
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME     = 'ColdEmail';

const DRY_RUN          = process.env.DRY_RUN !== 'false';          // default TRUE
// CHECK_ONLY runs reply/bounce detection + open-triggered flagging with REAL
// sheet writes, but skips every email send. Distinct from DRY_RUN, which also
// skips the writes. Used by the 30-minute cron for near-real-time detection.
const CHECK_ONLY       = process.env.CHECK_ONLY === 'true';
// Master kill switch. Fail-safe: sending is OFF unless the env var is the
// literal string 'true' — an absent or mistyped value means no mail leaves.
// Checked immediately before every sendEmail call, not at startup, so a
// mid-run config change can never race past it. Reply/bounce detection is
// unaffected: those passes only ever PREVENT mail.
const SENDING_ENABLED  = process.env.SENDING_ENABLED === 'true';
const DAILY_CAP        = parseInt(process.env.DAILY_CAP || '12', 10);
const DAILY_SEND_LIMIT = parseInt(process.env.DAILY_SEND_LIMIT || '40', 10);
const QUEUE_STAGE = process.env.QUEUE_STAGE || 'Queued';      // set a lead's stage to this to queue it
const SENT_STAGE  = process.env.SENT_STAGE  || 'Contacted';   // stage the agent moves it to after sending
const FROM_EMAIL  = process.env.FROM_EMAIL;                   // must be the authed Google account
const FROM_NAME   = process.env.FROM_NAME || 'ScaleLab AI';
const MAILING_ADDRESS   = process.env.MAILING_ADDRESS || 'ScaleLab AI, New Westminster, BC';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const _rawProposalBase = (process.env.PROPOSAL_BASE || '').trim();
const PROPOSAL_BASE    = (/^https?:\/\//i.test(_rawProposalBase) ? _rawProposalBase : 'https://scalelabaireceptionistproposal.netlify.app').replace(/\/$/, '');

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

// Cold Calls (Leads) sheet — used when auto-promoting interested replies
const LEADS_SHEET   = 'Leads';
const LEADS_RANGE   = `${LEADS_SHEET}!A:Q`;
const LEADS_COLUMNS = [
  'id','type','first','last','brokerage','tradeType','company',
  'city','cityTrade','phone','email','website',
  'stage','priority','followup','notes','created',
];

// ── AUTH (same pattern as server.js) ──────────────────────────────────────────

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI,
);

let _tokenRefreshLogged = false;

function saveToken(newTokens) {
  const existing = fs.existsSync(TOKEN_PATH)
    ? JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'))
    : (oauth2Client.credentials || {});
  const merged = { ...existing, ...newTokens };   // never lose refresh_token
  oauth2Client.setCredentials(merged);
  if (process.env.RAILWAY_ENVIRONMENT) {
    if (!_tokenRefreshLogged) {
      console.log('[token] Railway env detected — token refreshes handled in memory');
      _tokenRefreshLogged = true;
    }
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

→ See what this looks like for ${company}: ${link}

Worth 15 minutes to see if the numbers make sense?

— ${FROM_NAME}

${casl}`;
      }

      return `Hi ${name},

Just circling back on my note about ${company}'s booking flow.

The short version: an AI receptionist answers when you can't, books the appointment, and the confirmation goes out automatically — no voicemails left hanging.

→ See what this looks like for ${company}: ${link}

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

// Parallel warm-lead template — used only for open-triggered follow-ups.
// Not part of FOLLOW_UP_SEQUENCE (triggered by ProposalOpens count, not elapsed days).
const WARM_FOLLOW_UP_TEMPLATE = {
  step: 'warm',
  subject: (lead) => `Re: AI receptionist for ${cleanCompanyName(lead.company) || lead.company}`,
  body: (lead) => {
    const name    = lead.contactName || 'there';
    const company = cleanCompanyName(lead.company) || lead.company;
    return `Hi ${name},

Wanted to follow up on the proposal I sent over — looks like you had a chance to take a look, which I appreciate.

Happy to answer any questions or put together a quick demo built around ${company}'s setup so you can hear exactly how it would sound to your clients.

Worth a quick chat?

${FROM_NAME}
ScaleLab AI
${MAILING_ADDRESS}`;
  },
};

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

// Deterministic per-lead token for short proposal links: sha1(lead.id), first
// 10 hex chars. Re-sends always produce the same link; the /p/:token route in
// server.js resolves it back to the lead by hashing column A the same way —
// MUST stay in sync with proposalToken() there.
function proposalToken(lead) {
  return crypto.createHash('sha1').update(String(lead.id)).digest('hex').slice(0, 10);
}

// Builds the proposal URL for the email body.
//
// Token style — <PROPOSAL_BASE>/<token> — when PROPOSAL_BASE points at the
// /p tracker (production: https://receptionist.scalelabai.ca/p). The tracker
// resolves the token to company/contact/niche, logs the open, and 302s to the
// Netlify page with the same query params the old links carried — the page
// itself is untouched and personalization is resolved at CLICK time from the
// sheet, so post-send enrichment (e.g. a contactName found later) is picked up.
//
// Legacy query-param style is kept for any base that is NOT the tracker: if
// PROPOSAL_BASE ever falls back to the bare Netlify URL, a token path would
// 404 there, while ?company=… still personalizes.
// Uses function declaration so it hoists — the follow-up templates call it at
// runtime, not definition time, but being hoisted keeps things clear.
function buildProposalLink(lead) {
  if (/\/p$/.test(PROPOSAL_BASE)) {
    return `${PROPOSAL_BASE}/${proposalToken(lead)}`;
  }
  const co = cleanCompanyName(lead.company);
  const params = [
    co               ? ['company', co]                : null,
    lead.contactName ? ['contact', lead.contactName]  : null,
    lead.tradeType   ? ['niche',   lead.tradeType]    : null,
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

→ See what this looks like for ${company}: ${link}

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

→ See what this looks like for ${company}: ${link}

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

// Idempotency probe — STEP 1 ONLY. Step 1 fires once ever per lead, so any
// prior send to the address can only mean (a) we already sent it and the
// record write failed, or (b) another row for the same mailbox was emailed.
// Both must skip. NEVER apply this to follow-ups: steps 2/3 are legitimate
// repeat sends to the same address and the probe would block them.
//
// Window: newer_than:7d. Identical quota to 1d (one messages.list either way);
// covers a multi-day outage that would blind a 1d probe, while a deliberate
// re-prospecting of the same business months later stays possible.
//
// Fails CLOSED in the send direction: 'unverifiable' (query error) means we
// cannot rule out a duplicate — the caller must refuse to send. A skipped
// send costs nothing; a duplicate is permanent.
async function stepOneAlreadySent(lead) {
  try {
    const safeEmail = lead.email.trim().replace(/^[^a-zA-Z0-9]+/, '');
    if (!safeEmail || !safeEmail.includes('@')) return 'unverifiable';
    const resp = await gmail().users.messages.list({
      userId: 'me',
      q: `in:sent to:"${safeEmail}" newer_than:7d`,
      maxResults: 1,
    });
    return (resp.data.messages || []).length ? 'found' : 'clear';
  } catch (e) {
    console.warn(`[probe] Gmail error for ${lead.email}: ${e.message} — treating as unverifiable`);
    return 'unverifiable';
  }
}

// Bounce/auto senders whose thread messages must never be treated as a reply.
const DAEMON_FROM = /mailer-daemon|postmaster|no-?reply|do-?not-?reply/i;

// Read a header value off a Gmail message payload (case-insensitive name).
function headerValue(payload, name) {
  const h = (payload?.headers || []).find(x => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

// Extract the bare address from a From header ("Jill <jill@x.com>" → "jill@x.com").
function parseAddr(fromHeader) {
  const m = /<([^>]+)>/.exec(fromHeader || '');
  return (m ? m[1] : (fromHeader || '')).trim().toLowerCase();
}

// Recursively pull the first text/plain body out of a (possibly deeply nested
// multipart) Gmail payload. Returns '' when no plain-text part exists.
function extractPlainText(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }
  if (payload.parts && payload.parts.length) {
    for (const part of payload.parts) {
      const t = extractPlainText(part);
      if (t) return t;
    }
    return '';
  }
  // Leaf with no explicit mime type (rare) — treat as plain. Never fall through
  // for text/html or other non-plain leaves, which would leak markup.
  if (!payload.mimeType && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  }
  return '';
}

// Concatenates the decoded bodies of ALL text-bearing leaves — text/plain,
// text/html, message/delivery-status, attached-message headers, and untyped
// leaves. Used by bounce confirmation: many NDRs carry the failed address only
// in the machine-readable delivery-status part or the HTML rendering, which
// extractPlainText (first text/plain wins, markup excluded) deliberately skips.
function extractAllText(payload) {
  const chunks = [];
  const walk = p => {
    if (!p) return;
    if (p.parts && p.parts.length) { p.parts.forEach(walk); }
    if (p.body?.data) {
      const mt = p.mimeType || '';
      if (!mt || mt.startsWith('text/') || mt.startsWith('message/')) {
        chunks.push(Buffer.from(p.body.data, 'base64url').toString('utf8'));
      }
    }
  };
  walk(payload);
  return chunks.join('\n');
}

// Phase 4: find a genuine reply from the lead. Two nets, unioned:
//
//   Net 1 — thread walk: our most recent sent message to the address → its full
//           thread. Catches replies sent from a DIFFERENT address than the one
//           we contacted (owner replies from jill@ after we emailed info@).
//
//   Net 2 — direct search: from:"<addr>" after:<lastEmailedAt>. Catches a
//           prospect who composes a FRESH email to us instead of replying —
//           such a message is on no thread of ours, so net 1 cannot see it.
//           includeSpamTrash is set because messages.list EXCLUDES Spam/Trash
//           by default (verified empirically 2026-07-16: identical from: query
//           on a SPAM-labeled message — 0 hits without the flag, 1 with it).
//
// Candidates from both nets are deduped by message id, then the newest inbound
// message wins (not ours, not SENT-labeled, not a bounce daemon, newer than
// lastEmailedAt). Returns { messageId, snippet, body, fromAddr } or null.
// Fails CLOSED — any error returns null.
async function getReplyMessage(lead) {
  if (!lead.lastEmailedAt || !isValidEmail(lead.email)) return null;
  try {
    const afterMs   = new Date(lead.lastEmailedAt).getTime();
    const afterSec  = Math.floor(afterMs / 1000);
    const safeEmail = lead.email.trim().replace(/^[^a-zA-Z0-9]+/, '');
    if (!safeEmail || !safeEmail.includes('@')) return null;

    const candidates = new Map();   // message id → full message resource

    // ── Net 1: thread of our most recent sent message to this address ──
    const sentResp = await gmail().users.messages.list({
      userId: 'me',
      q: `in:sent to:"${safeEmail}"`,
      maxResults: 1,
    });
    const sent = sentResp.data.messages || [];
    if (sent.length) {
      const sentMsg  = await gmail().users.messages.get({ userId: 'me', id: sent[0].id, format: 'minimal' });
      const threadId = sentMsg.data.threadId;
      if (threadId) {
        const thread = await gmail().users.threads.get({ userId: 'me', id: threadId, format: 'full' });
        for (const m of thread.data.messages || []) candidates.set(m.id, m);
      }
    }

    // ── Net 2: anything the contacted address sent us after our last send ──
    const directResp = await gmail().users.messages.list({
      userId: 'me',
      q: `from:"${safeEmail}" after:${afterSec}`,
      maxResults: 5,
      includeSpamTrash: true,
    });
    for (const stub of directResp.data.messages || []) {
      if (candidates.has(stub.id)) continue;
      const full = await gmail().users.messages.get({ userId: 'me', id: stub.id, format: 'full' });
      candidates.set(stub.id, full.data);
    }

    if (!candidates.size) return null;

    // ── Shared inbound filter over the union; newest wins ──
    const ourAddr = (FROM_EMAIL || '').trim().toLowerCase();
    let best = null;
    for (const m of candidates.values()) {
      const internalMs = parseInt(m.internalDate || '0', 10);
      if (internalMs <= afterMs) continue;
      if ((m.labelIds || []).includes('SENT')) continue;   // our own outbound
      const fromAddr = parseAddr(headerValue(m.payload, 'From'));
      if (!fromAddr) continue;
      if (ourAddr && fromAddr === ourAddr) continue;        // our own address
      if (DAEMON_FROM.test(fromAddr)) continue;             // bounce / auto-reply daemon
      if (!best || internalMs > best.ms) best = { ms: internalMs, msg: m, fromAddr };
    }
    if (!best) return null;

    const snippet = best.msg.snippet || '';
    const body    = extractPlainText(best.msg.payload).trim().slice(0, 1500);
    return { messageId: best.msg.id, snippet, body, fromAddr: best.fromAddr };
  } catch (e) {
    console.warn(`[ReplyCheck] API error for ${lead.email}: ${e.message}`);
    return null;
  }
}

const REPLY_CATEGORIES = new Set(['INTERESTED','NOT_INTERESTED','UNSUBSCRIBE','OUT_OF_OFFICE','WRONG_PERSON','NEEDS_HUMAN']);

// Safe default when classification cannot be trusted. NEEDS_HUMAN stops the
// sequence and surfaces the lead for review rather than silently delaying it —
// an ambiguous-but-real reply must reach a human, not sit for 7 days.
// Never default to INTERESTED: a transient API error would silently promote.
const CLASSIFY_FALLBACK = 'NEEDS_HUMAN';

async function classifyReply(company, replyBody) {
  if (!ANTHROPIC_API_KEY) {
    console.warn(`[Classify] ANTHROPIC_API_KEY not set — defaulting ${company} to ${CLASSIFY_FALLBACK}`);
    return CLASSIFY_FALLBACK;
  }
  try {
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 20,
      system: [
        'You are classifying a reply to a cold sales email about an AI receptionist product for small businesses.',
        'Classify the reply into exactly one of these categories:',
        '',
        'INTERESTED — they want to learn more, asked a question about the product, want to schedule a call, or showed clear positive engagement',
        'NOT_INTERESTED — they explicitly declined, said no thanks, not interested, not a good fit, or similar',
        'UNSUBSCRIBE — they asked to be removed, unsubscribed, or said stop emailing',
        'OUT_OF_OFFICE — automated out-of-office or vacation reply',
        'WRONG_PERSON — they indicated they are not the decision maker or the email reached the wrong person',
        'NEEDS_HUMAN — a real person engaged but their intent is unclear or does not cleanly fit the above (e.g. "what exactly is your question?", "who is this?", "can you send more info?" with no clear buying signal)',
        '',
        'Guidance: when a real person has clearly engaged but you are unsure of their intent, or you are unsure between INTERESTED and unclear, prefer NEEDS_HUMAN over guessing.',
        '',
        'Reply with ONLY the category name, nothing else.',
      ].join('\n'),
      messages: [{ role: 'user', content: `Company: ${company}\nReply: ${replyBody}` }],
    });
    const raw = (msg.content[0]?.text || '').trim().toUpperCase();
    if (REPLY_CATEGORIES.has(raw)) return raw;
    console.warn(`[Classify] Unrecognised category "${raw}" for ${company} — defaulting to ${CLASSIFY_FALLBACK}`);
    return CLASSIFY_FALLBACK;
  } catch (e) {
    console.warn(`[Classify] API error for ${company}: ${e.message} — defaulting to ${CLASSIFY_FALLBACK}`);
    return CLASSIFY_FALLBACK;
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

// Re-resolve a lead's CURRENT sheet row by id, immediately before writing.
// The _row captured by readLeads() goes stale the moment a dashboard delete
// shifts rows mid-run (a live run spans ~25 minutes of send jitter), and a
// stale number lands the write on the WRONG lead — mislabelling an innocent
// row while the real target looks untouched. One column-A read per write;
// writes are rare, so the cost is negligible.
// Returns null when the id is gone (row deleted mid-run): the caller must
// SKIP the write — never fall back to the stale row number.
async function resolveRow(leadId) {
  const resp = await sheets().spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:A`,
  });
  const col = resp.data.values || [];
  for (let i = 1; i < col.length; i++) {
    if ((col[i][0] || '') === leadId) return i + 1;
  }
  return null;
}

async function readProposalOpens() {
  try {
    return await withAuth(async () => {
      const resp = await sheets().spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'ProposalOpens!A:F',
      });
      const rows = resp.data.values || [];
      return rows.slice(1).map(row => ({
        timestamp: row[0] || '',
        company:   row[1] || '',
        niche:     row[2] || '',
        id:        row[3] || '',
        ip:        row[4] || '',
        userAgent: row[5] || '',
      }));
    });
  } catch (e) {
    console.error('[ProposalOpens] Failed to read:', e.message);
    return [];
  }
}

// Write stage (H) + agent columns (I:K) for one row, leaving the rest untouched.
// Sets emailStatus='done' when the last step in the sequence has been sent.
//
// The email is ALREADY SENT when this runs — a failed write here is the
// "sent but unrecorded" state that re-sends on the next run. So the whole
// write (including row resolution) retries with exponential backoff, and a
// final failure alarms loudly instead of throwing: the caller's catch would
// log "Failed", which is false — the send succeeded.
async function markSent(lead, step) {
  const now          = new Date().toISOString();
  const isLastStep   = step > FOLLOW_UP_SEQUENCE.length; // step 3 > 2 → done
  const status       = isLastStep ? 'done' : 'emailed';
  const MAX_ATTEMPTS = 4;                                 // backoff: 1s, 2s, 4s

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const rowNum = await resolveRow(lead.id);
      if (!rowNum) {
        console.warn(`[markSent] lead ${lead.id} (${lead.email}) no longer in sheet — row deleted mid-run? Skipping write.`);
        return;
      }
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
      return;
    } catch (e) {
      if (attempt < MAX_ATTEMPTS) {
        const delay = 1000 * 2 ** (attempt - 1);
        console.warn(`[markSent] attempt ${attempt}/${MAX_ATTEMPTS} failed for ${lead.email}: ${e.message} — retrying in ${delay / 1000}s`);
        await sleep(delay);
      } else {
        console.error(`‼️ [UNRECORDED SEND] step ${step} to ${lead.email} (${lead.id}) WAS SENT but could not be recorded after ${MAX_ATTEMPTS} attempts: ${e.message}`);
        console.error(`‼️ [UNRECORDED SEND] step 1 is protected by the idempotency probe; a follow-up step MAY BE RE-SENT next run — fix the sheet row by hand (I=emailed/done, J=${now}, K=${step}).`);
      }
    }
  }
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

async function appendOpenTriggeredNote(lead) {
  const rowNum = await resolveRow(lead.id);
  if (!rowNum) {
    console.warn(`[openNote] lead ${lead.id} (${lead.email}) no longer in sheet — skipping note write.`);
    return;
  }
  const updated = lead.notes ? `${lead.notes} | open-triggered` : 'open-triggered';
  await sheets().spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!L${rowNum}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[updated]] },
  });
}

// ── REPLY ROUTING ─────────────────────────────────────────────────────────────

// Never accumulate the same tag twice — handlers may re-run on a lead whose
// notes already carry their tag (retry, overlapping cron run, manual re-trigger).
function prependNote(existing, tag) {
  if (existing && existing.includes(tag)) return existing;
  return existing ? `${tag} ${existing}` : tag;
}

const TAG_INTERESTED = '[REPLY: Interested]';

// True if this lead was already promoted to the Cold Calls sheet. Guards the
// append against overlapping runs that both read before either wrote.
async function isAlreadyPromoted(leadId) {
  const resp = await sheets().spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range:         `${LEADS_SHEET}!A:A`,
  });
  const ids = (resp.data.values || []).flat();
  return ids.includes(`CE-${leadId}`);
}

// Idempotent: a lead whose notes already carry the Interested tag is skipped
// entirely. Callers must not rely on lead.emailStatus — runReplyCheckPass sets
// it to 'replied' in memory before dispatching here.
async function handleInterested(lead) {
  if ((lead.notes || '').includes(TAG_INTERESTED)) {
    console.log(`  ↺ ${lead.company} — already tagged Interested, skipping`);
    return;
  }
  const rowNum = await resolveRow(lead.id);
  if (!rowNum) {
    console.warn(`[handleInterested] lead ${lead.id} (${lead.email}) no longer in sheet — skipping write.`);
    return;
  }
  await sheets().spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        { range: `${SHEET_NAME}!H${rowNum}`, values: [['Replied']] },
        { range: `${SHEET_NAME}!I${rowNum}`, values: [['replied']] },
        { range: `${SHEET_NAME}!L${rowNum}`, values: [[prependNote(lead.notes, TAG_INTERESTED)]] },
      ],
    },
  });
  if (await isAlreadyPromoted(lead.id)) {
    console.log(`  ↺ ${lead.company} — already in Cold Calls, skipping promote`);
    return;
  }
  const parts = (lead.contactName || '').split(' ');
  const first = parts[0] || '';
  const last  = parts.slice(1).join(' ') || '';
  const promotedLead = {
    id:        `CE-${lead.id}`,
    type:      'trade',
    first,
    last,
    brokerage: '',
    tradeType: lead.tradeType || 'Med Spa',
    company:   lead.company,
    city:      lead.city || '',
    cityTrade: lead.city || '',
    phone:     '',
    email:     lead.email,
    website:   lead.website || '',
    stage:     'new',
    priority:  'hot',
    followup:  new Date().toISOString().split('T')[0],
    notes:     'Auto-promoted from cold email outreach. Reply classified: Interested.',
    created:   new Date().toISOString(),
  };
  await sheets().spreadsheets.values.append({
    spreadsheetId:    SPREADSHEET_ID,
    range:            LEADS_RANGE,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody:      { values: [LEADS_COLUMNS.map(col => String(promotedLead[col] ?? ''))] },
  });
  console.log(`  🔥 Auto-promoted ${lead.company} to Cold Calls kanban`);
}

async function handleNotInterested(lead) {
  const rowNum = await resolveRow(lead.id);
  if (!rowNum) {
    console.warn(`[handleNotInterested] lead ${lead.id} (${lead.email}) no longer in sheet — skipping write.`);
    return;
  }
  await sheets().spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        { range: `${SHEET_NAME}!H${rowNum}`, values: [['Done']] },
        { range: `${SHEET_NAME}!I${rowNum}`, values: [['done']] },
        { range: `${SHEET_NAME}!L${rowNum}`, values: [[prependNote(lead.notes, '[REPLY: Not Interested]')]] },
      ],
    },
  });
  console.log(`  ✗ ${lead.company} — marked Done (not interested)`);
}

async function handleUnsubscribe(lead) {
  const rowNum = await resolveRow(lead.id);
  if (!rowNum) {
    console.warn(`[handleUnsubscribe] lead ${lead.id} (${lead.email}) no longer in sheet — skipping write.`);
    return;
  }
  await sheets().spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        { range: `${SHEET_NAME}!H${rowNum}`, values: [['Unsub']] },
        { range: `${SHEET_NAME}!I${rowNum}`, values: [['done']] },
        { range: `${SHEET_NAME}!L${rowNum}`, values: [[prependNote(lead.notes, '[REPLY: Unsubscribed]')]] },
      ],
    },
  });
  console.log(`  ⊘ ${lead.company} — marked Unsub (unsubscribe request)`);
}

async function handleOutOfOffice(lead) {
  const rowNum = await resolveRow(lead.id);
  if (!rowNum) {
    console.warn(`[handleOutOfOffice] lead ${lead.id} (${lead.email}) no longer in sheet — skipping write.`);
    return;
  }
  const newDate = new Date(lead.lastEmailedAt);
  newDate.setDate(newDate.getDate() + 7);
  await sheets().spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        { range: `${SHEET_NAME}!J${rowNum}`, values: [[newDate.toISOString()]] },
        { range: `${SHEET_NAME}!L${rowNum}`, values: [[prependNote(lead.notes, '[REPLY: OOO — retry in 7d]')]] },
      ],
    },
  });
  console.log(`  ⏸ ${lead.company} — OOO detected, follow-up delayed 7 days`);
}

async function handleWrongPerson(lead) {
  const rowNum = await resolveRow(lead.id);
  if (!rowNum) {
    console.warn(`[handleWrongPerson] lead ${lead.id} (${lead.email}) no longer in sheet — skipping write.`);
    return;
  }
  await sheets().spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        { range: `${SHEET_NAME}!H${rowNum}`, values: [['Replied']] },
        { range: `${SHEET_NAME}!I${rowNum}`, values: [['replied']] },
        { range: `${SHEET_NAME}!L${rowNum}`, values: [[prependNote(lead.notes, '[REPLY: Wrong Person — needs re-enrichment]')]] },
      ],
    },
  });
  console.log(`  ↪ ${lead.company} — wrong person, flagged for re-enrichment`);
}

// Ambiguous-but-real reply: stop the sequence and surface for a human. When the
// reply came from a different address than the one we emailed, record it so the
// human knows where to look.
async function handleNeedsHuman(lead, fromAddr) {
  const rowNum = await resolveRow(lead.id);
  if (!rowNum) {
    console.warn(`[handleNeedsHuman] lead ${lead.id} (${lead.email}) no longer in sheet — skipping write.`);
    return;
  }
  const emailedAddr = (lead.email || '').trim().toLowerCase();
  const from        = (fromAddr || '').trim().toLowerCase();
  const differs     = from && from !== emailedAddr;
  const note        = differs ? `[REPLY: Needs human] (replied from ${from})` : '[REPLY: Needs human]';
  await sheets().spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        { range: `${SHEET_NAME}!H${rowNum}`, values: [['Review']] },
        { range: `${SHEET_NAME}!I${rowNum}`, values: [['replied']] },
        { range: `${SHEET_NAME}!L${rowNum}`, values: [[prependNote(lead.notes, note)]] },
      ],
    },
  });
  console.log(`  ⚑ ${lead.company} — needs human review${differs ? ` (replied from ${from})` : ''}`);
}

// ── REPLY-CHECK PASS ─────────────────────────────────────────────────────────
// Runs unconditionally on every agent invocation — independent of whether there
// are queued sends or follow-ups due. Fetches each emailed lead's reply body,
// classifies it with Haiku, and routes to the appropriate handler. Mutates
// lead.emailStatus in-place so selectFollowUps() excludes replied leads.
async function runReplyCheckPass(leads) {
  const candidates = leads.filter(l => l.emailStatus === 'emailed' && isValidEmail(l.email));
  if (!candidates.length) {
    console.log('[ReplyCheck] No emailed leads to check.\n');
    return;
  }
  console.log(`[ReplyCheck] Checking ${candidates.length} emailed lead${candidates.length === 1 ? '' : 's'} for replies...`);

  let found = 0;
  const classCounts = {};

  for (const lead of candidates) {
    const message = await withAuth(() => getReplyMessage(lead));
    if (!message) continue;

    found++;
    const company        = cleanCompanyName(lead.company) || lead.email;
    const replyText      = message.body || message.snippet;
    const classification = await classifyReply(lead.company, replyText);
    classCounts[classification] = (classCounts[classification] || 0) + 1;

    const fromNote = (message.fromAddr && message.fromAddr !== lead.email.trim().toLowerCase())
      ? ` (from ${message.fromAddr})` : '';
    console.log(`  ↩ Reply from ${lead.email}${fromNote} (${company}) — ${classification}`);
    lead.emailStatus = 'replied'; // exclude from follow-ups this run regardless of classification

    if (!DRY_RUN) {
      await withAuth(async () => {
        switch (classification) {
          case 'INTERESTED':     return handleInterested(lead);
          case 'NOT_INTERESTED': return handleNotInterested(lead);
          case 'UNSUBSCRIBE':    return handleUnsubscribe(lead);
          case 'WRONG_PERSON':   return handleWrongPerson(lead);
          case 'OUT_OF_OFFICE':  return handleOutOfOffice(lead);
          // NEEDS_HUMAN and anything unforeseen surface for review rather than
          // silently delaying — never promote or close on an ambiguous reply.
          case 'NEEDS_HUMAN':
          default:               return handleNeedsHuman(lead, message.fromAddr);
        }
      });
    }
  }

  const LABELS = {
    INTERESTED:     'Interested (auto-promoted)',
    NOT_INTERESTED: 'Not Interested',
    UNSUBSCRIBE:    'Unsubscribe',
    OUT_OF_OFFICE:  'OOO',
    WRONG_PERSON:   'Wrong Person',
    NEEDS_HUMAN:    'Needs human review',
  };
  const breakdown = Object.entries(classCounts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${LABELS[k] || k}`)
    .join(' · ');

  console.log(`[ReplyCheck] ${found} repl${found === 1 ? 'y' : 'ies'} found / ${candidates.length} checked`);
  if (breakdown) console.log(`  → ${breakdown}`);
  console.log();
}

// ── BOUNCE-CHECK PASS ─────────────────────────────────────────────────────────

// Bounce/NDR subject lines seen across providers.
//   Gmail      → "Delivery Status Notification (Failure)" / "Address not found"
//   Office365  → "Undeliverable: <subject>"
//   Exchange   → "Delivery has failed to these recipients or groups"
//   Postfix    → "Undelivered Mail Returned to Sender"  (NOT "Undeliverable"!)
//   Sendmail   → "Returned mail: see transcript for details"
//   qmail      → "failure notice"
//   Exim/cPanel→ "Mail delivery failed: returning message to sender"
const BOUNCE_SUBJECTS = [
  'Undeliverable',
  'Undelivered',
  'Delivery Status Notification',
  'Delivery has failed',
  'Mail delivery failed',
  'Returned mail',
  'failure notice',
  'returning message to sender',
  'Message blocked',
  'Address not found',
];

// Permanent failure: the address is dead — safe to stop the sequence.
// Enhanced status 5.x.x and SMTP 55x are permanent by SMTP convention.
const PERMANENT_FAILURE = /permanent|address not found|no such (?:user|mailbox|address|recipient)|user unknown|does(?: not|n['’]?t) exist|mailbox (?:full|unavailable|is full)|recipient (?:rejected|not found|address rejected)|account (?:has been )?(?:disabled|closed|suspended)|\b55[013456]\b|\b5\.\d\.\d\b/i;

// Transient failure: a delay that will retry — must NOT close the lead.
const TRANSIENT_FAILURE = /delivery (?:is )?incomplete|will (?:retry|keep trying|try again)|temporar(?:y|ily)|being delayed|greylist|\b4\.\d\.\d\b/i;

// Detects a PERMANENT bounce for this lead from any provider.
// Returns true (permanent bounce), false (no bounce / transient delay only),
// null (API error — fail closed, caller leaves the lead active).
async function checkForBounce(lead) {
  if (!lead.lastEmailedAt || !isValidEmail(lead.email)) return false;
  try {
    const afterSec  = Math.floor(new Date(lead.lastEmailedAt).getTime() / 1000);
    const safeEmail = lead.email.trim().replace(/^[^a-zA-Z0-9]+/, '');
    if (!safeEmail || !safeEmail.includes('@')) return false;
    const lowerEmail = safeEmail.toLowerCase();

    // Two nets, unioned by message id:
    //   subject net — known NDR subjects from any sender;
    //   sender net  — anything from a mailer-daemon/postmaster mentioning the
    //                 address, catching NDR subjects we've never seen (other
    //                 languages, exotic MTAs). False positives are gated below
    //                 by the address-in-body and permanent-failure checks.
    // includeSpamTrash on both: Gmail files forged-looking daemon mail to Spam,
    // and messages.list excludes Spam/Trash by default (verified 2026-07-16).
    const subjectQuery = BOUNCE_SUBJECTS.map(s => `"${s}"`).join(' OR ');
    const [bySubject, bySender] = await Promise.all([
      gmail().users.messages.list({
        userId:     'me',
        q:          `after:${afterSec} "${safeEmail}" subject:(${subjectQuery})`,
        maxResults: 5,
        includeSpamTrash: true,
      }),
      gmail().users.messages.list({
        userId:     'me',
        q:          `from:(mailer-daemon OR postmaster) "${safeEmail}" after:${afterSec}`,
        maxResults: 5,
        includeSpamTrash: true,
      }),
    ]);
    const ids = new Set([
      ...(bySubject.data.messages || []).map(m => m.id),
      ...(bySender.data.messages  || []).map(m => m.id),
    ]);
    if (!ids.size) return false;

    for (const id of ids) {
      const full = await gmail().users.messages.get({ userId: 'me', id, format: 'full' });
      // All text parts, including message/delivery-status — some NDRs carry the
      // failed address only in the machine-readable part.
      const body = extractAllText(full.data.payload).toLowerCase();
      // Broad matches can hit unrelated NDRs — require the lead's own
      // address in the body before trusting it.
      if (!body.includes(lowerEmail)) continue;
      // A retry/delay notice is not a dead address — skip it.
      if (TRANSIENT_FAILURE.test(body) && !PERMANENT_FAILURE.test(body)) {
        console.log(`  ⏳ ${lead.email} — transient delivery delay, not marking bounced`);
        continue;
      }
      if (PERMANENT_FAILURE.test(body)) return true;
    }
    return false;
  } catch (e) {
    console.warn(`[BounceCheck] API error for ${lead.email}: ${e.message}`);
    return null;
  }
}

async function runBounceCheckPass(leads) {
  const candidates = leads.filter(l => l.emailStatus === 'emailed' && isValidEmail(l.email));
  if (!candidates.length) {
    console.log('[BounceCheck] No emailed leads to check.\n');
    return;
  }
  console.log(`[BounceCheck] Checking ${candidates.length} lead${candidates.length === 1 ? '' : 's'} for bounces...`);

  let bounced = 0;
  for (const lead of candidates) {
    const isBounced = await withAuth(() => checkForBounce(lead));
    if (isBounced !== true) continue;

    const company = cleanCompanyName(lead.company) || lead.email;
    console.log(`  ⚠ Bounce detected → ${lead.email} (${company}) — marking Done`);
    lead.emailStatus = 'done';

    if (!DRY_RUN) {
      await withAuth(async () => {
        const rowNum = await resolveRow(lead.id);
        if (!rowNum) {
          console.warn(`[BounceCheck] lead ${lead.id} (${lead.email}) no longer in sheet — skipping write.`);
          return;
        }
        await sheets().spreadsheets.values.batchUpdate({
          spreadsheetId: SPREADSHEET_ID,
          requestBody: {
            valueInputOption: 'RAW',
            data: [
              { range: `${SHEET_NAME}!H${rowNum}`, values: [['Done']] },
              { range: `${SHEET_NAME}!I${rowNum}`, values: [['done']] },
              { range: `${SHEET_NAME}!L${rowNum}`, values: [[prependNote(lead.notes, '[BOUNCED]')]] },
            ],
          },
        });
      });
    }
    bounced++;
  }

  console.log(`[BounceCheck] ${bounced} bounce${bounced !== 1 ? 's' : ''} found / ${candidates.length} checked\n`);
}

// ── SELECTION ─────────────────────────────────────────────────────────────────

function isValidEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
}

// Hard suppression: a lead whose notes carry one of these tags must NEVER be
// emailed again, regardless of stage, status, or how it re-entered a batch.
// '[BOUNCED' is a deliberate prefix — it matches both '[BOUNCED]' (agent) and
// '[BOUNCED - manual cleanup]' (mark-bounced.js). Checked immediately before
// every send as a last line of defense; selection filters are the first line.
const SUPPRESSION_TAGS = ['[REPLY: Unsubscribed]', '[BOUNCED'];

function suppressionReason(lead) {
  const notes = lead.notes || '';
  for (const tag of SUPPRESSION_TAGS) {
    if (notes.includes(tag)) return tag;
  }
  return null;
}

function selectQueued(leads) {
  return leads.filter(l => {
    if (l.stage !== QUEUE_STAGE) return false;   // you queued it
    if (!isValidEmail(l.email)) return false;    // sendable address
    // Only never-touched leads may enter step 1. The previous check
    // (!== 'emailed') let terminal leads ('done', 'replied') re-enter the
    // sequence via a stage change alone — a bounced or unsubscribed lead
    // could be re-mailed with one dropdown click. Re-sending now requires
    // explicitly clearing emailStatus as well as re-queueing the stage.
    if (l.emailStatus !== '') return false;
    // Junk check (same classifier as the import choke point): isValidEmail
    // accepts phone-bleed addresses like -687-1887x@gmail.com and third-party
    // tracking domains — legacy rows imported before the choke point existed
    // must not reach the send path.
    const verdict = classifyLeadEmail(l.email);
    if (verdict !== 'CLEAN') {
      console.warn(`🚮 [junk] skipping queued lead ${l.email} (${l.company || l.id}) — classified ${verdict}`);
      return false;
    }
    return true;
  });
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

function countTodaySends(allLeads) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });
  return allLeads.filter(l => {
    if (!l.lastEmailedAt) return false;
    const sentDay = new Date(l.lastEmailedAt).toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });
    return sentDay === today;
  }).length;
}

function normalizeName(str) {
  return (str || '').toLowerCase().trim().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// Scanner detonation is real (confirmed 2026-07): corporate mail filters fetch
// the tracking link within seconds of delivery, with browser-like user agents
// that pass the /p bot check — two such fetches used to read as a hot lead and
// trigger a warm follow-up nobody asked for. Two defenses, both must pass:
//   1. any open within OPEN_SCANNER_WINDOW_MS of the lead's recorded send
//      timestamp is discounted (detonation happens at delivery; humans read
//      later). Only lastEmailedAt is stored, so opens near EARLIER steps'
//      deliveries can't be retro-discounted here — defense 2 covers those.
//   2. the surviving opens must span >= 2 distinct calendar days (Vancouver):
//      a scanner burst lands on one day; a human who returns does not.
const OPEN_SCANNER_WINDOW_MS = 5 * 60 * 1000;

function getOpenTriggeredLeads(allLeads, proposalOpens) {
  const opensByKey = new Map();   // normalized company → [open timestamp ms]
  for (const open of proposalOpens) {
    const key = normalizeName(cleanCompanyName(open.company));
    if (!key) continue;
    const ts = new Date(open.timestamp).getTime();
    if (isNaN(ts)) continue;
    if (!opensByKey.has(key)) opensByKey.set(key, []);
    opensByKey.get(key).push(ts);
  }

  const now          = Date.now();
  const TWELVE_HOURS = 12 * 60 * 60 * 1000;
  const dayOf        = ts => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });
  const genuineCount = new Map();   // lead.id → surviving open count (for sort)

  return allLeads
    .filter(lead => {
      if (lead.emailStatus !== 'emailed') return false;
      const step = parseInt(lead.emailStep || '0', 10);
      if (step < 1 || step > FOLLOW_UP_SEQUENCE.length) return false;
      if (lead.stage === 'Replied') return false;
      const lastSent = new Date(lead.lastEmailedAt).getTime();
      if (isNaN(lastSent) || (now - lastSent) < TWELVE_HOURS) return false;

      const key     = normalizeName(cleanCompanyName(lead.company));
      const opens   = opensByKey.get(key) || [];
      const genuine = opens.filter(ts => Math.abs(ts - lastSent) > OPEN_SCANNER_WINDOW_MS);
      const days    = new Set(genuine.map(dayOf));
      genuineCount.set(lead.id, genuine.length);
      return genuine.length >= 2 && days.size >= 2;
    })
    .sort((a, b) => (genuineCount.get(b.id) || 0) - (genuineCount.get(a.id) || 0));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = () => MIN_DELAY + Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY));

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function run() {
  if (!SPREADSHEET_ID) throw new Error('SPREADSHEET_ID missing from .env');
  if (!DRY_RUN && !CHECK_ONLY && !FROM_EMAIL) throw new Error('FROM_EMAIL missing from .env (required to send)');

  const modeLabel = CHECK_ONLY ? 'CHECK-ONLY (reply/bounce detection, no sends)'
                  : DRY_RUN     ? 'DRY RUN (nothing sent)'
                  :               '🔴 LIVE — sending real emails';

  console.log('────────────────────────────────────────');
  console.log(`ScaleLab Outreach Agent — Phase 1–4`);
  console.log(`Mode:       ${modeLabel}`);
  console.log(`Sending:    ${SENDING_ENABLED ? 'ENABLED' : '⛔ DISABLED (kill switch — set SENDING_ENABLED=true to send)'}`);
  console.log(`Daily cap:  ${DAILY_CAP}`);
  console.log(`Queue stage:"${QUEUE_STAGE}"  →  on send: "${SENT_STAGE}"`);
  console.log(`Opener API: ${ANTHROPIC_API_KEY ? 'Haiku (claude-haiku-4-5) — Tier-2 (site) when website present, Tier-1 otherwise' : 'not set — using generic fallback'}`);
  console.log('────────────────────────────────────────');

  if (!DRY_RUN) await withAuth(ensureAgentHeaders);

  const all = await withAuth(readLeads);

  const todaySent      = countTodaySends(all);
  console.log(`[cap] ${todaySent}/${DAILY_SEND_LIMIT} emails sent today (Vancouver time)`);
  const dailyRemaining = Math.max(0, DAILY_SEND_LIMIT - todaySent);

  // Reply-check pass — unconditional; runs even when cap is reached.
  // Mutates emailStatus on replied leads so selectFollowUps excludes them below.
  await runReplyCheckPass(all);

  // Bounce-check pass — marks bounced leads Done before follow-up selection.
  await runBounceCheckPass(all);

  // Phase 1 — new sends (stage === QUEUE_STAGE, never emailed)
  const queued = selectQueued(all);

  // Phase 3 — follow-ups (replied leads already excluded by runReplyCheckPass)
  const followUps = selectFollowUps(all);

  // Open-triggered warm follow-ups
  const proposalOpens = await readProposalOpens();
  const warmLeads     = getOpenTriggeredLeads(all, proposalOpens);
  console.log(`[opens] ${warmLeads.length} open-triggered lead${warmLeads.length === 1 ? '' : 's'} found`);

  // CHECK-ONLY stops here: reply-check, bounce-check and open detection have all
  // run (with real writes), but no email is sent.
  if (CHECK_ONLY) {
    console.log('\n[check-only] Detection complete — skipping all sends.');
    return;
  }

  const effectiveCap = Math.min(DAILY_CAP, dailyRemaining);
  console.log(`${all.length} leads · ${queued.length} queued · ${warmLeads.length} warm · ${followUps.length} follow-ups due · cap ${effectiveCap} (${dailyRemaining} remaining today)\n`);

  if (dailyRemaining === 0) {
    console.log('[cap] Daily send limit reached — skipping sends this run');
    return;
  }

  // New sends fill the cap first; warm follow-ups second; standard follow-ups use remaining slots
  const newBatch       = queued.slice(0, effectiveCap);
  const slotsAfterNew  = Math.max(0, effectiveCap - newBatch.length);
  const warmBatch      = warmLeads.slice(0, slotsAfterNew);
  const warmIds        = new Set(warmBatch.map(l => l.id));
  const slotsAfterWarm = Math.max(0, slotsAfterNew - warmBatch.length);
  const followBatch    = followUps.filter(l => !warmIds.has(l.id)).slice(0, slotsAfterWarm);
  const total          = newBatch.length + warmBatch.length + followBatch.length;

  if (total === 0) {
    console.log(`Nothing to send. Queue a lead (stage="${QUEUE_STAGE}") or wait for follow-up timers.`);
    return;
  }

  let sent = 0;

  // ── New sends (step 1) ────────────────────────────────────────────────────
  for (const lead of newBatch) {
    const suppressed = suppressionReason(lead);
    if (suppressed) {
      console.error(`🚫 [SUPPRESSED] refusing step-1 send → ${lead.email} (${cleanCompanyName(lead.company) || lead.id}) — notes contain ${suppressed}`);
      continue;
    }

    // Step-1 idempotency probe (see stepOneAlreadySent). Runs in every mode so
    // dry-run and gated reports show exactly what a live run would skip.
    const probe = await withAuth(() => stepOneAlreadySent(lead));
    if (probe !== 'clear') {
      if (probe === 'found') {
        console.warn(`⏭️  [probe] step-1 already sent to ${lead.email} within 7d — skipping (sent-but-unrecorded, or duplicate row for this address)`);
      } else {
        console.warn(`⏭️  [probe] cannot verify prior sends to ${lead.email} — failing closed, skipping this run`);
      }
      continue;
    }

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

    if (!SENDING_ENABLED) {
      console.log(`⛔ [kill-switch] would send (step 1) → ${lead.email}  (${cleanCompanyName(lead.company) || lead.id})`);
      console.log(`   Subject: ${subject}`);
      continue;
    }

    try {
      await sendEmail({ to: lead.email.trim(), subject, body });
      await withAuth(() => markSent(lead, 1));
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

  // ── Warm follow-ups (open-triggered) ─────────────────────────────────────
  for (const lead of warmBatch) {
    const suppressed = suppressionReason(lead);
    if (suppressed) {
      console.error(`🚫 [SUPPRESSED] refusing warm send → ${lead.email} (${cleanCompanyName(lead.company) || lead.id}) — notes contain ${suppressed}`);
      continue;
    }

    const currentStep = parseInt(lead.emailStep, 10);
    const nextStepNum = currentStep + 1;
    const subject     = WARM_FOLLOW_UP_TEMPLATE.subject(lead);
    const body        = WARM_FOLLOW_UP_TEMPLATE.body(lead);
    const preview     = body.split('\n')[2] || '';

    if (DRY_RUN) {
      const rawCo   = lead.company || '';
      const cleanCo = cleanCompanyName(rawCo);
      console.log(`— WOULD SEND (warm) →  ${lead.email}  (${rawCo || lead.first || lead.id})`);
      if (rawCo && rawCo !== cleanCo) console.log(`   Company: "${rawCo}" → "${cleanCo}"`);
      console.log(`   Subject: ${subject}`);
      console.log(`   Preview: ${preview}\n`);
      continue;
    }

    if (!SENDING_ENABLED) {
      console.log(`⛔ [kill-switch] would send (warm) → ${lead.email}  (${cleanCompanyName(lead.company) || lead.id})`);
      console.log(`   Subject: ${subject}`);
      continue;
    }

    try {
      await sendEmail({ to: lead.email.trim(), subject, body });
      await withAuth(() => markSent(lead, nextStepNum));
      await withAuth(() => appendOpenTriggeredNote(lead));
      sent++;
      console.log(`✅ Sent (warm) → ${lead.email}  (${sent}/${total})`);
    } catch (e) {
      console.error(`❌ Failed (warm) → ${lead.email}: ${e.message}`);
    }

    if (sent < total) {
      const d = jitter();
      console.log(`   …waiting ${Math.round(d / 1000)}s\n`);
      await sleep(d);
    }
  }

  // ── Follow-ups (steps 2 & 3) ──────────────────────────────────────────────
  for (const lead of followBatch) {
    const suppressed = suppressionReason(lead);
    if (suppressed) {
      console.error(`🚫 [SUPPRESSED] refusing follow-up send → ${lead.email} (${cleanCompanyName(lead.company) || lead.id}) — notes contain ${suppressed}`);
      continue;
    }

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

    if (!SENDING_ENABLED) {
      console.log(`⛔ [kill-switch] would send (step ${nextStepNum}) → ${lead.email}  (${cleanCompanyName(lead.company) || lead.id})`);
      console.log(`   Subject: ${subject}`);
      continue;
    }

    try {
      await sendEmail({ to: lead.email.trim(), subject, body });
      await withAuth(() => markSent(lead, nextStepNum));
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
