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

// Random pause between sends so traffic looks human (ms)
const MIN_DELAY = 45 * 1000;
const MAX_DELAY = 120 * 1000;

// ColdEmail columns (A:M) — emailStatus/lastEmailedAt/emailStep are part of the main schema
const COLUMNS = [
  'id','company','contactName','email','city','tradeType','website',
  'stage','emailStatus','lastEmailedAt','emailStep','notes','created',
];
const AGENT_COLS = []; // integrated into COLUMNS for ColdEmail
const READ_RANGE = `${SHEET_NAME}!A:M`;

// ── AUTH (same pattern as server.js) ──────────────────────────────────────────

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI,
);

function saveToken(newTokens) {
  const existing = fs.existsSync(TOKEN_PATH)
    ? JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'))
    : {};
  const merged = { ...existing, ...newTokens };   // never lose refresh_token
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged));
  return merged;
}

oauth2Client.on('tokens', t => saveToken(t));

function loadToken() {
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error('token.json not found — authenticate via the dashboard first.');
  }
  oauth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')));
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
const FOLLOW_UP_SEQUENCE = [
  {
    delayDays: 3,
    subject: (lead) => `Re: Quick question about ${lead.company || 'your business'}`,
    body: (lead) =>
`Hi ${lead.first || 'there'},

Just following up on my note from a few days ago — I help ${lead.tradeType || 'trade'} businesses in ${lead.city || 'your area'} turn more inbound calls into booked jobs without adding to your workload.

Worth a quick 15-minute call to see if it'd be a fit for ${lead.company || 'your business'}?

— ${FROM_NAME}

---
${MAILING_ADDRESS}
You're receiving this because your business is publicly listed. Reply "unsubscribe" and I'll remove you immediately.`,
  },
  {
    delayDays: 5,
    subject: (lead) => `Last note — ${lead.company || 'your business'}`,
    body: (lead) =>
`Hi ${lead.first || 'there'},

Last one from me, I promise.

If the timing isn't right, no worries at all. But if you'd like to see how we help ${lead.tradeType || 'trade'} companies in ${lead.city || 'your area'} book more jobs — in under 15 minutes — just reply and I'll send a link.

— ${FROM_NAME}

---
${MAILING_ADDRESS}
You're receiving this because your business is publicly listed. Reply "unsubscribe" and I'll remove you immediately.`,
  },
];

// ── EMAIL TEMPLATE ────────────────────────────────────────────────────────────

// Phase 2: calls Haiku to generate one specific opening sentence.
// Graceful: on any error returns null and the caller falls back to a generic line.
async function generateOpener(lead) {
  if (!ANTHROPIC_API_KEY) return null;
  try {
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const details = [
      lead.company   && `company "${lead.company}"`,
      lead.city      && `based in ${lead.city}`,
      lead.tradeType && `a ${lead.tradeType} business`,
      lead.website   && `website: ${lead.website}`,
    ].filter(Boolean).join(', ');
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 60,
      messages: [{
        role: 'user',
        content: `Write ONE specific opening sentence (under 25 words) for a cold sales email to ${lead.first || 'the owner'} at a trade business${details ? ` — ${details}` : ''}. Sound genuine, not salesy. Output only the sentence, no greeting.`,
      }],
    });
    return msg.content[0]?.text?.trim() || null;
  } catch (e) {
    console.warn(`[Opener] API error for ${lead.email} — using fallback: ${e.message}`);
    return null;
  }
}

async function buildEmail(lead) {
  const name    = lead.first || 'there';
  const company = lead.company || 'your business';

  const opener = await generateOpener(lead)
    || `I noticed ${company} and wanted to reach out.`;

  const subject = `Quick question about ${company}`;

  const body =
`Hi ${name},

${opener}

I help local ${lead.tradeType || 'trade'} businesses turn more of their inbound calls and
leads into booked jobs — without adding to your workload. Worth a quick chat
to see if it'd move the needle for ${company}?

Either way, appreciate your time.

— ${FROM_NAME}

---
${MAILING_ADDRESS}
You're receiving this because your business is publicly listed. Reply with
"unsubscribe" and I'll remove you immediately — no hard feelings.`;

  return { subject, body };
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
// Fails open — returns false on any API error so a lookup failure never blocks a send.
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
    console.warn(`[ReplyCheck] ${lead.email}: ${e.message}`);
    return false;
  }
}

// ── SHEET I/O ─────────────────────────────────────────────────────────────────

async function ensureAgentHeaders() {
  // ColdEmail headers are set by server.js on sheet creation — nothing to do here.
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
  console.log(`Opener API: ${ANTHROPIC_API_KEY ? 'Haiku (claude-haiku-4-5)' : 'not set — using generic fallback'}`);
  console.log('────────────────────────────────────────');

  if (!DRY_RUN) await withAuth(ensureAgentHeaders);

  const all = await withAuth(readLeads);

  // Phase 1 — new sends (stage === QUEUE_STAGE, never emailed)
  const queued = selectQueued(all);

  // Phase 3+4 — follow-ups with reply detection
  const followUpCandidates = selectFollowUps(all);
  const followUps = [];
  for (const lead of followUpCandidates) {
    const replied = await withAuth(() => checkForReply(lead));
    if (replied) {
      console.log(`[ReplyCheck] Reply detected from ${lead.email} — marking replied, skipping`);
      if (!DRY_RUN) await withAuth(() => markReplied(lead._row));
      continue;
    }
    followUps.push(lead);
  }

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
    const { subject, body } = await buildEmail(lead);
    const opener = body.split('\n')[2] || ''; // line 2 = Claude opener (after "Hi name," + blank)

    if (DRY_RUN) {
      console.log(`— WOULD SEND (step 1) →  ${lead.email}  (${lead.company || lead.first || lead.id})`);
      console.log(`   Subject: ${subject}`);
      console.log(`   Opener:  ${opener}\n`);
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
      console.log(`— WOULD SEND (step ${nextStepNum}) →  ${lead.email}  (${lead.company || lead.first || lead.id})`);
      console.log(`   Subject: ${subject}`);
      console.log(`   Preview: ${preview}\n`);
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
