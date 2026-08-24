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
// Scanner-detonation filtering for ProposalOpens, shared verbatim with
// server.js's dashboard stats — one definition, no drift.
const { annotateOpens, isDatacenterIp } = require('./open-filter');
// WARM-ONLY booking asset — see booking.js. Imported here for the two intent
// triggers (question replies, both-audios-played) and NOT by any cold template.
const { bookingSnippet, pricingDeflection, BOOKING_URL } = require('./booking');
// The only source of truth the reply-answering model may state as fact.
const { PRODUCT_FACTS, NEVER_AUTO_ANSWER } = require('./product-facts');
// Fixed commercial promise for the cold email. Deliberately NOT in booking.js:
// that module is the warm-only Calendly asset and the cold path is guarded
// against importing it.
const { guaranteeFor, hasIntactGuarantee } = require('./guarantee');
const { GmailOutreachProvider } = require('./integrations/outreach-providers');
const { SmartleadClient } = require('./integrations/smartlead-client');
const { SmartleadOutreachProvider } = require('./integrations/outreach-providers');
const { classifyReply: classifyProviderReply } = require('./integrations/reply-classifier');
const { normalizeEmail, buildMappingKey, ACTIVE_STATUSES } = require('./integrations/smartlead-safety');
const { routedLeadReady } = require('./integrations/campaign-routing');
const {
  PROFILE_ID: ROOFING_SURVEY_PROFILE,
  TEMPLATE_ID: ROOFING_SURVEY_TEMPLATE,
  renderInitialEmail: renderRoofingSurveyInitial,
  validateInitialEmail: validateRoofingSurveyInitial,
  qualifyLead: qualifyRoofingLead,
  classifyReply: classifyRoofingReply,
  renderPositiveReply: renderRoofingSurveyReply,
  renderQuestionDraft: renderRoofingQuestionDraft,
} = require('./integrations/roofing-survey-profile');

// ── CONFIG ────────────────────────────────────────────────────────────────────

const TOKEN_PATH     = path.join(__dirname, 'token.json');
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME     = 'ColdEmail';

const DRY_RUN          = process.env.DRY_RUN !== 'false';          // default TRUE
// CHECK_ONLY runs reply/bounce detection + open-triggered flagging with REAL
// sheet writes, but skips every email send. Distinct from DRY_RUN, which also
// skips the writes. Used by the 30-minute cron for near-real-time detection.
const CHECK_ONLY       = process.env.CHECK_ONLY === 'true';
// INTENT_ONLY runs ONLY the both-audios intent pass and exits. Kept separate
// from CHECK_ONLY so the /demo-played route can fire a fast, narrow pass within
// minutes of a play without triggering reply/bounce detection or any outreach.
const INTENT_ONLY      = process.env.INTENT_ONLY === 'true';
// Master kill switch. Fail-safe: sending is OFF unless the env var is the
// literal string 'true' — an absent or mistyped value means no mail leaves.
// Checked immediately before every sendEmail call, not at startup, so a
// mid-run config change can never race past it. Reply/bounce detection is
// unaffected: those passes only ever PREVENT mail.
const SENDING_ENABLED  = process.env.SENDING_ENABLED === 'true';
const DAILY_CAP        = parseInt(process.env.DAILY_CAP || '12', 10);
const DAILY_SEND_LIMIT = parseInt(process.env.DAILY_SEND_LIMIT || '40', 10);
// Below this, a drafted answer goes to the review queue instead of the prospect.
// Deliberately high: a wrong auto-answer costs more than a slower human one.
const ANSWER_CONFIDENCE_FLOOR = parseInt(process.env.ANSWER_CONFIDENCE_FLOOR || '85', 10);
const QUEUE_STAGE = process.env.QUEUE_STAGE || 'Queued';      // set a lead's stage to this to queue it
const SENT_STAGE  = process.env.SENT_STAGE  || 'Contacted';   // stage the agent moves it to after sending
const FROM_EMAIL  = process.env.FROM_EMAIL;                   // must be the authed Google account
const FROM_NAME   = process.env.FROM_NAME || 'ScaleLab AI';
const MAILING_ADDRESS   = process.env.MAILING_ADDRESS || 'ScaleLab AI, New Westminster, BC';
const SIGNATURE_NAME    = process.env.SIGNATURE_NAME    || 'Deins Ulmanis';
const SIGNATURE_COMPANY = process.env.SIGNATURE_COMPANY || 'ScaleLabAi';
const SIGNATURE_SITE    = process.env.SIGNATURE_SITE    || 'scalelabai.ca';
const SIGNATURE_PHONE   = process.env.SIGNATURE_PHONE   || '604 836 9902';
const EMAIL_SIGNATURE   = `— ${SIGNATURE_NAME}\n${SIGNATURE_COMPANY}\n${SIGNATURE_SITE}\n${SIGNATURE_PHONE}`;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ROOFING_SURVEY_REPLY_FLOW_ENABLED = process.env.ROOFING_SURVEY_REPLY_FLOW_ENABLED === 'true';
const ROOFING_SURVEY_AUTO_REPLY_ENABLED = process.env.ROOFING_SURVEY_AUTO_REPLY_ENABLED === 'true';
const ROOFING_SURVEY_URL = String(process.env.ROOFING_SURVEY_URL || '').trim();
// Optional safety scope for controlled owned-address tests. When set, every
// detection and send phase is restricted to this one durable lead ID. Normal
// scheduled runs leave it unset and retain their existing behavior.
const TARGET_LEAD_ID = String(process.env.TARGET_LEAD_ID || '').trim();
const anthropicClient = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;
const _rawProposalBase = (process.env.PROPOSAL_BASE || '').trim();
const PROPOSAL_BASE    = (/^https?:\/\//i.test(_rawProposalBase) ? _rawProposalBase : 'https://scalelabaireceptionistproposal.netlify.app').replace(/\/$/, '');

// Random pause between sends so traffic looks human (ms)
const MIN_DELAY = 45 * 1000;
const MAX_DELAY = 120 * 1000;

// ColdEmail columns A:W — must stay in sync with CE_COLUMNS in server.js
//   A=id  B=company  C=contactName  D=email  E=city  F=tradeType  G=website
//   H=stage  I=emailStatus  J=lastEmailedAt  K=emailStep  L=notes
//   M=reviewCount  N=rating  O=tier  P=siteContext
const COLUMNS = [
  'id','company','contactName','email','city','tradeType','website',
  'stage','emailStatus','lastEmailedAt','emailStep','notes',
  'reviewCount','rating','tier','siteContext','campaign','campaign_notes','enrichment_attempted',
  'leadNiche','senderInboxId','emailTemplateId','routingRequired',
];
const AGENT_COLS  = []; // integrated into COLUMNS for ColdEmail
const READ_RANGE  = `${SHEET_NAME}!A:W`;
const CAMPAIGN_INTEGRATIONS_SHEET = 'CampaignIntegrations';
const PROVIDER_LEADS_SHEET = 'ProviderLeadMappings';
let CAMPAIGN_PROVIDERS = new Map();
let ACTIVE_PROVIDER_LEADS = new Set();
let ACTIVE_PROVIDER_EMAILS = new Set();
let EXISTING_PROVIDER_CAMPAIGN_EMAILS = new Set();
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
// Same invitation/sample-demo thread as step 1 (buildPitch) and the same
// single-CTA-reply rule — no longer tier-branched, since the old busy/medium
// split existed to continue the old "after-hours calls" angle that step 1 no
// longer opens with.
const FOLLOW_UP_SEQUENCE = [
  {
    delayDays: 3,
    subject: (lead) => `Re: a quick demo I built for ${cleanCompanyName(lead.company) || 'your business'}`,
    body: (lead) => {
      const link    = buildProposalLink(lead);
      const name    = salutationName(lead);
      const company = cleanCompanyName(lead.company) || 'your business';
      const casl    = `---\n${MAILING_ADDRESS}\nYou're receiving this because your business is publicly listed. Reply "unsubscribe" and I'll remove you immediately.  ·  Ref: SL-${refCode(lead)}`;

      return `Hi ${name},

Just following up on the AI receptionist demo I mentioned for ${company} — still happy to build it if you'd like to hear it.

→ Here's a sample so you know what it sounds like: ${link}

No pressure either way — just reply if you'd like yours.

${EMAIL_SIGNATURE}

${casl}`;
    },
  },
  {
    delayDays: 5,
    subject: (lead) => `Last note — ${cleanCompanyName(lead.company) || 'your business'}`,
    body: (lead) => {
      const link    = buildProposalLink(lead);
      const name    = salutationName(lead);
      const company = cleanCompanyName(lead.company) || 'your business';
      const casl    = `---\n${MAILING_ADDRESS}\nYou're receiving this because your business is publicly listed. Reply "unsubscribe" and I'll remove you immediately.  ·  Ref: SL-${refCode(lead)}`;

      return `Hi ${name},

Last note from me on this.

If a free AI receptionist demo for ${company} isn't useful right now, no worries — I'll leave it here. If it is, here's the sample again: ${link}

Just reply and I'll build yours.

${EMAIL_SIGNATURE}

${casl}`;
    },
  },
];

// Parallel warm-lead template — used only for open-triggered follow-ups.
// Not part of FOLLOW_UP_SEQUENCE (triggered by ProposalOpens count, not elapsed days).
// NOTE: this template was previously missing the CASL unsubscribe line and
// Ref: SL- code entirely — a pre-existing gap, added here while touching this
// body anyway (the casl-building pattern itself is unchanged, just now applied
// here too).
const WARM_FOLLOW_UP_TEMPLATE = {
  step: 'warm',
  subject: (lead) => `Re: a quick demo I built for ${cleanCompanyName(lead.company) || lead.company}`,
  body: (lead) => {
    const name    = salutationName(lead);
    const company = cleanCompanyName(lead.company) || lead.company;
    const casl    = `---\n${MAILING_ADDRESS}\nYou're receiving this because your business is publicly listed. Reply "unsubscribe" and I'll remove you immediately.  ·  Ref: SL-${refCode(lead)}`;
    return `Hi ${name},

Wanted to follow up — looks like you had a chance to check out the demo I sent over for ${company}, which I appreciate.

Happy to answer any questions, or go ahead and build the full version if you're ready.

Just reply and let me know.

${EMAIL_SIGNATURE}

${casl}`;
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
// multi-listing noise (e.g. "Yaletown Wellness - Hamilton | RMT Vancouver",
// "Kitsilano Smiles • Dr Sandra Huish"). Takes the segment before the first
// occurrence of any separator below, whichever comes first in the string.
// Separators other than "|" are space-padded (" - ", " • ", …) so a bare
// hyphen/dash inside a real word — "Mary-Anne's Dental" — is never cut;
// bullet/middle-dot/en-dash/em-dash never legitimately appear mid-word in a
// business name, but are padded too for consistency with " - ".
// Never mutates stored data — call only at send/display time.
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

// ── NICHE CONFIG ──────────────────────────────────────────────────────────────
// Every niche-specific word choice in the Haiku opener prompt and the email
// templates comes from here. Adding a third vertical is adding one entry to
// this array — never edit generateOpener()/buildPitch()/the follow-up bodies
// to special-case a new industry.
//
// `match` is tested against lead.tradeType (case-insensitive), entries checked
// in order, first hit wins. The last entry (`match: null`) is the fallback for
// any tradeType that matches nothing above it — keep it last.
const NICHE_CONFIG = [
  {
    key: 'dental',
    match: /dent(?:ist|al)/i,
    label: 'dental practice',
    labelPlural: 'dental practices',
    person: 'patients',
    booking: 'appointments',
    place: 'practice',
    openerFewShot: [
      '• Dentist in Surrey → "Came across Fraser Family Dental while looking at dental practices in Surrey."',
      '• Dental clinic, no city → "Noticed Bright Smile Dental while looking into local dental practices."',
    ],
  },
  {
    key: 'medspa',
    match: /med.?spa|\bspa\b|skin.?care|laser.*hair|esthetic|dermat|wellness.?cent|massage|beauty.?salon|cosmetic/i,
    label: 'med spa',
    labelPlural: 'med spas',
    person: 'clients',
    booking: 'bookings',
    place: 'clinic',
    openerFewShot: [
      '• Med spa in Vancouver → "Came across Glow Aesthetics while looking at med spas in Vancouver."',
      '• Skin clinic, no city → "Noticed Bright Skin Studio while looking into local skin clinics."',
    ],
  },
  {
    key: 'default',
    match: null,
    label: 'business',
    labelPlural: 'businesses',
    person: 'customers',
    booking: 'appointments',
    place: 'business',
    openerFewShot: [
      '• HVAC company in Vancouver → "Came across Peak Climate HVAC while looking at HVAC contractors in Vancouver."',
      '• Plumber in Calgary → "Saw Mountain Plumbing while browsing plumbers around Calgary."',
    ],
  },
];

function nicheFor(tradeType) {
  const t = (tradeType || '').trim();
  return NICHE_CONFIG.find(c => c.match && c.match.test(t)) || NICHE_CONFIG[NICHE_CONFIG.length - 1];
}

// ── RECIPIENT TYPE ────────────────────────────────────────────────────────────
// Single source of truth for "who is actually reading this inbox" — every
// template branches on this instead of re-deriving it. ROLE_LOCAL_PARTS is the
// known-shared-inbox list; anything NOT on it (dr*, *dmd, *dds, *md, or a plain
// personal name) defaults to 'owner', since a personal address is far more
// likely than a role inbox we haven't seen before. This list can never be
// exhaustive — ownerSalutationName() below is the actual fail-safe: it never
// guesses a name from the address itself, so a role-ish local-part that slips
// past this list still can't produce a nonsense "Hi Dr. Hello," salutation,
// it just falls back to a neutral one.
const ROLE_LOCAL_PARTS = [
  'info', 'reception', 'contact', 'frontdesk', 'office', 'appointments',
  'hello', 'hi', 'chat', 'appts', 'appt', 'smile', 'smiles',
  'dentist', 'dental', 'clinic', 'care', 'team', 'admin', 'inquiry', 'inquiries',
  'booking', 'bookings', 'welcome', 'mail', 'general', 'front', 'frontoffice',
  'receptionist', 'newpatients', 'patients', 'service', 'support',
];

function recipientType(lead) {
  // Digits/dots/dashes/underscores are noise around the actual word
  // ("front.office123", "hello-clinic") — strip them before matching.
  const local = (lead.email || '').split('@')[0].trim().toLowerCase().replace(/[.\-_0-9]/g, '');
  return ROLE_LOCAL_PARTS.some(p => local === p || local.startsWith(p)) ? 'role' : 'owner';
}

// Best-effort salutation name for an 'owner' recipient. Tries, in order:
//   1. "Dr. <Last>" parsed from the raw company field (most reliable — pulls
//      from the actual listed name, e.g. "Kitsilano Smiles • Dr Sandra Huish")
//   2. lead.first, if a contactName is on file
// Returns null if neither is present — callers fall back to 'there' rather
// than guess. Deliberately does NOT parse the email local-part for a name:
// ROLE_LOCAL_PARTS can never enumerate every role-inbox word in existence, so
// any address that slips past that classifier and reaches here (an
// unrecognized role word like "chat@" or "smiles@") must degrade to a neutral
// greeting, not a fabricated surname like "Dr. Chat" or "Dr. Smiles".
function ownerSalutationName(lead) {
  const raw = lead.company || '';
  const drMatch = raw.match(/\bDr\.?\s+([A-Z][a-zA-Z'-]+)(?:\s+([A-Z][a-zA-Z'-]+))?/);
  if (drMatch) return `Dr. ${drMatch[2] || drMatch[1]}`;

  if (lead.first) return lead.first;

  return null;
}

// Salutation name used by every template — resolves to a real name for an
// owner inbox where derivable, otherwise falls back to 'there'.
function salutationName(lead) {
  if (recipientType(lead) === 'owner') return ownerSalutationName(lead) || 'there';
  return lead.first || 'there';
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

// Builds the step-1 subject + body — the invitation offer. Niche-aware via
// NICHE_CONFIG; no longer tier-branched (the old "busy vs medium" pitch split
// belonged to the old offer's after-hours-calls angle, which this replaces).
// buildEmail() still computes/returns pitchTier separately for dry-run logging
// — it no longer changes which copy goes out, so buildPitch doesn't need it.
// ── COLD SUBJECT LINES ────────────────────────────────────────────────────────
// Three approved variants, verbatim as supplied. {{company}} is the only
// substitution. Assignment is DETERMINISTIC per lead (sha1 of the lead id), not
// random, for two reasons:
//   1. steps 2 and 3 reply into the same thread with "Re: <subject>" — a lead
//      whose subject changed between runs would start a second thread.
//   2. a re-run, retry or restart must reproduce the same choice.
// Because it is a pure function of lead.id, which variant a lead received is
// always recomputable — no column needed to measure performance later.
const COLD_SUBJECTS = [
  `3 new patients in 30 days — or you don't pay`,
  `A guarantee for {{company}}`,
  `{{company}}'s missed calls`,
];

function coldSubjectFor(lead, company) {
  const h = crypto.createHash('sha1').update(String(lead.id || '')).digest();
  const variant = COLD_SUBJECTS[h[0] % COLD_SUBJECTS.length];
  return variant.split('{{company}}').join(company);
}

// Which variant index a lead maps to — used by dry-run logging so a preview
// shows the real distribution before anything sends.
function coldSubjectIndex(lead) {
  return crypto.createHash('sha1').update(String(lead.id || '')).digest()[0] % COLD_SUBJECTS.length;
}

// Guarantee-led cold pitch. The guarantee is the FIRST sentence of the body,
// inserted verbatim from guarantee.js — see validateColdEmail() below, which
// refuses to send if that sentence has been altered in any way.
//
// The per-lead opener still runs (generateOpener, grounded in the lead's own
// scraped site text) but now sits AFTER the guarantee rather than leading, so
// the promise lands before anything else.
function buildPitch(lead, opener, link) {
  const type    = recipientType(lead);
  const name    = salutationName(lead);
  const company = cleanCompanyName(lead.company) || '';
  const niche   = nicheFor(lead.tradeType);

  const casl = `---\n${MAILING_ADDRESS}\nYou're receiving this because your business is publicly listed. Reply with\n"unsubscribe" and I'll remove you immediately — no hard feelings.  ·  Ref: SL-${refCode(lead)}`;

  // Cold CTA is reply-to-book. The Calendly link stays warm-only and must not
  // appear here (booking.js is deliberately not imported by this file's cold path).
  const closing = type === 'owner'
    ? `Worth a look? Reply and I'll send it over.`
    : `Worth a look? Reply and I'll send it over — and if bookings aren't your area, feel free to forward this to whoever handles them.`;

  return {
    subject: coldSubjectFor(lead, company),
    body:
`Hi ${name},

${guaranteeFor(company)}

${opener}

I build the receptionist with ${company}'s actual ${niche.booking} and services, so when a ${niche.person.replace(/s$/, '')} calls it already sounds like it works there. It never touches your real phone line, so there's nothing to switch over to try it.

→ Here's one I already built, so you can hear it: ${link}

${closing}

${EMAIL_SIGNATURE}

${casl}`,
  };
}

// ── PRE-SEND VALIDATION FOR COLD EMAIL ────────────────────────────────────────
// The guarantee is line one of a commercial promise, so an unresolved merge
// field is not a cosmetic bug — "…for  in the first 30 days" or a literal
// {{company}} would be sent as a contractual claim. Every one of these routes
// to a DRAFT rather than blocking the run, so the lead is preserved for review.
//
// Returns null when the email is safe to send, or a string reason when it is not.
function validateColdEmail(lead, subject, body, link) {
  const company = cleanCompanyName(lead.company) || '';

  // 1. company must have resolved to something real — no empty, no old fallback
  if (!company) return 'company did not resolve (blank after cleanCompanyName)';
  if (/^your (business|clinic)$/i.test(company)) return `company resolved to the placeholder "${company}"`;

  // 2. no unmerged handlebars anywhere in what would be sent
  const unmerged = `${subject}\n${body}`.match(/\{\{\s*[a-zA-Z_]+\s*\}\}/g);
  if (unmerged) return `unresolved merge field(s): ${[...new Set(unmerged)].join(', ')}`;

  // 3. the guarantee must be present, character-for-character, for THIS company
  if (!hasIntactGuarantee(body, company)) {
    return 'guarantee sentence missing or altered — refusing to send a modified commercial promise';
  }

  // 4. the proposal link must have actually built into a per-lead URL. A bare
  //    base with no token and no params means the personalization silently
  //    failed and every recipient would get the same generic page.
  if (!link || !/^https?:\/\//i.test(link)) return 'proposal link did not build';
  const isTokenLink = /\/p\/[0-9a-f]{6,}$/i.test(link);
  const isParamLink = /[?&]company=/.test(link);
  if (!isTokenLink && !isParamLink) return `proposal link is not lead-specific: ${link}`;
  if (!body.includes(link)) return 'proposal link missing from the body';

  // 5. cold email never carries the warm booking asset or a price
  if (/calendly\.com/i.test(body)) return 'cold email contains the warm-only booking link';
  if (/\$\s?\d|\bper month\b|\bpricing\b/i.test(body)) return 'cold email appears to contain pricing';

  return null;
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
    const niche = nicheFor(lead.tradeType);
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
        `Write ONE opening sentence for a cold email to the owner or manager of a ${niche.label}.`,
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
        ...niche.openerFewShot,
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
        `Write ONE opening sentence for a cold email to the owner or manager of a ${niche.label}.`,
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
        ...niche.openerFewShot,
        '',
        'Output only the sentence.',
      ].join('\n');
    }

    const msg = await anthropicClient.messages.create({
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

  const { subject, body } = buildPitch(lead, opener, link);

  return { subject, body, link, opener, openerTier, pitchTier };
}

// RFC 2047 encoded-word for a header value containing non-ASCII characters
// (em dash, bullet, curly quotes, etc. from cleanCompanyName/company names).
// Header field bodies are US-ASCII per RFC 5322 — raw UTF-8 bytes dropped
// straight into a header get reinterpreted byte-by-byte by the receiving
// client, which is exactly the "Ã¢Â€Â"" mojibake pattern. Pure-ASCII subjects
// pass through unchanged — encoding them would be valid but needlessly ugly.
// Long subjects are split into multiple encoded-words (RFC 2047 caps each
// word, delimiters included, at 75 octets), folded with CRLF + space, and
// split only on UTF-8 character boundaries so no multi-byte char is torn in
// half across chunks.
function encodeHeaderValue(value) {
  if (!value) return '';
  if (/^[\x00-\x7F]*$/.test(value)) return value; // pure ASCII — leave as-is

  const PREFIX = '=?UTF-8?B?';
  const SUFFIX = '?=';
  const maxB64Len = 75 - PREFIX.length - SUFFIX.length;
  const maxBytesPerChunk = Math.floor(maxB64Len / 4) * 3;

  const bytes = Buffer.from(value, 'utf8');
  const words = [];
  let i = 0;
  while (i < bytes.length) {
    let end = Math.min(i + maxBytesPerChunk, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xC0) === 0x80) end--; // don't split mid-character
    words.push(PREFIX + bytes.slice(i, end).toString('base64') + SUFFIX);
    i = end;
  }
  return words.join('\r\n ');
}

// RFC-822 message → base64url for the Gmail API
function toRawMessage({ to, subject, body, inReplyTo, references }) {
  const headers = [
    `From: ${FROM_NAME} <${FROM_EMAIL}>`,
    `To: ${to}`,
    `Subject: ${encodeHeaderValue(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
  ];
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);
  const msg = headers.join('\r\n') + '\r\n\r\n' + body;
  return Buffer.from(msg)
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sendEmail({ to, subject, body, threadId, inReplyTo, references }) {
  const provider = new GmailOutreachProvider({ send: message => gmail().users.messages.send({
    userId: 'me',
    requestBody: { raw: toRawMessage(message), ...(message.threadId ? { threadId: message.threadId } : {}) },
  }) });
  return provider.sendEmail({ to, subject, body, threadId, inReplyTo, references });
}

async function loadOutreachProviderState() {
  CAMPAIGN_PROVIDERS = new Map();
  ACTIVE_PROVIDER_LEADS = new Set();
  ACTIVE_PROVIDER_EMAILS = new Set();
  EXISTING_PROVIDER_CAMPAIGN_EMAILS = new Set();
  try {
    const campaigns = await sheets().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${CAMPAIGN_INTEGRATIONS_SHEET}!A:I` });
    for (const row of (campaigns.data.values || []).slice(1)) CAMPAIGN_PROVIDERS.set(row[0], { provider: row[1] || 'gmail', externalCampaignId: row[2] || '' });
  } catch (e) {
    console.warn(`[Providers] no campaign mappings (${e.message}) — existing Gmail behavior retained`);
  }
  try {
    const mappings = await sheets().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${PROVIDER_LEADS_SHEET}!A:N` });
    for (const row of (mappings.data.values || []).slice(1)) {
      const email = normalizeEmail(row[13]);
      if (row[3] && email) EXISTING_PROVIDER_CAMPAIGN_EMAILS.add(`${row[3]}:${email}`);
      if (ACTIVE_STATUSES.has(String(row[5] || '').trim().toLowerCase().replace(/_/g, ' '))) { if (row[0]) ACTIVE_PROVIDER_LEADS.add(row[0]); if (email) ACTIVE_PROVIDER_EMAILS.add(email); }
    }
  } catch (e) {
    console.warn(`[Providers] no lead mappings yet (${e.message})`);
  }
}

function providerForLead(lead) {
  return CAMPAIGN_PROVIDERS.get(String(lead.campaign || '').trim()) || { provider: 'gmail', externalCampaignId: '' };
}

async function enqueueSmartleadLead(lead, mapping) {
  if (!mapping.externalCampaignId) throw new Error('Smartlead campaign mapping has no external campaign ID');
  if (ACTIVE_PROVIDER_LEADS.has(lead.id) || ACTIVE_PROVIDER_EMAILS.has(normalizeEmail(lead.email))) throw new Error('lead email already has an active provider assignment');
  if (EXISTING_PROVIDER_CAMPAIGN_EMAILS.has(`${mapping.externalCampaignId}:${normalizeEmail(lead.email)}`)) throw new Error('lead email already has a mapping in this Smartlead campaign');
  const workbook = await sheets().spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  if (!workbook.data.sheets.find(sh => sh.properties.title === PROVIDER_LEADS_SHEET)) {
    await sheets().spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { requests: [{ addSheet: { properties: { title: PROVIDER_LEADS_SHEET } } }] } });
    await sheets().spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${PROVIDER_LEADS_SHEET}!A1`, valueInputOption: 'RAW', requestBody: { values: [['internalLeadId','provider','externalLeadId','externalCampaignId','mappingId','normalizedStatus','rawStatus','lastProviderEventAt','lastSynchronizedAt','unsubscribedAt','complianceNote','metadata','mappingKey','normalizedEmail']] } });
  } else {
    const header = await sheets().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${PROVIDER_LEADS_SHEET}!A1:N1` });
    const values = header.data.values?.[0] || [];
    if (!values.includes('mappingKey')) await sheets().spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `${PROVIDER_LEADS_SHEET}!A1`, valueInputOption: 'RAW', requestBody: { values: [['internalLeadId','provider','externalLeadId','externalCampaignId','mappingId','normalizedStatus','rawStatus','lastProviderEventAt','lastSynchronizedAt','unsubscribedAt','complianceNote','metadata','mappingKey','normalizedEmail']] } });
  }
  const names = String(lead.contactName || '').trim().split(/\s+/);
  const client = new SmartleadClient();
  const provider = new SmartleadOutreachProvider({ client });
  const result = await provider.addLeads({ externalCampaignId: mapping.externalCampaignId }, [{
    email: lead.email.trim().toLowerCase(), first_name: names[0] || '', last_name: names.slice(1).join(' '), company_name: lead.company || '', website: lead.website || '', location: lead.city || '',
    custom_fields: { practice_name: lead.company || '', city: lead.city || '', website: lead.website || '', niche: lead.tradeType || '', custom_first_line: lead.siteContext || '', service_reference: lead.tier || '', lead_score: lead.rating || '', internal_lead_id: lead.id },
  }]);
  const now = new Date().toISOString();
  const externalLeadId = result.lead_ids?.[0] || '';
  const normalizedEmail = normalizeEmail(lead.email);
  const mappingKey = buildMappingKey({ externalCampaignId: mapping.externalCampaignId, externalLeadId, email: normalizedEmail });
  await sheets().spreadsheets.values.append({ spreadsheetId: SPREADSHEET_ID, range: `${PROVIDER_LEADS_SHEET}!A:N`, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: [[lead.id, 'smartlead', externalLeadId, mapping.externalCampaignId, '', result.testMode ? 'Test mode' : (result.added_count ? 'Queued' : 'Skipped'), result.message || '', '', now, '', '', JSON.stringify({ addedCount: result.added_count || 0, skippedCount: result.skipped_count || 0 }), mappingKey, normalizedEmail]] } });
  if (!result.testMode && result.added_count) {
    const rowNum = await resolveRow(lead.id);
    await sheets().spreadsheets.values.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { valueInputOption: 'RAW', data: [{ range: `${SHEET_NAME}!H${rowNum}`, values: [['Contacted']] }, { range: `${SHEET_NAME}!I${rowNum}`, values: [['queued']] }] } });
  }
  ACTIVE_PROVIDER_LEADS.add(lead.id);
  ACTIVE_PROVIDER_EMAILS.add(normalizedEmail);
  EXISTING_PROVIDER_CAMPAIGN_EMAILS.add(`${mapping.externalCampaignId}:${normalizedEmail}`);
  return result;
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
    const rfcMessageId = headerValue(best.msg.payload, 'Message-ID');
    return { messageId: best.msg.id, rfcMessageId, threadId: best.msg.threadId || '', snippet, body, fromAddr: best.fromAddr };
  } catch (e) {
    console.warn(`[ReplyCheck] API error for ${lead.email}: ${e.message}`);
    return null;
  }
}

const REPLY_CATEGORIES = new Set(['QUESTION','INTERESTED','NOT_INTERESTED','UNSUBSCRIBE','OUT_OF_OFFICE','WRONG_PERSON','NEEDS_HUMAN']);

// Safe default when classification cannot be trusted. NEEDS_HUMAN stops the
// sequence and surfaces the lead for review rather than silently delaying it —
// an ambiguous-but-real reply must reach a human, not sit for 7 days.
// Never default to INTERESTED: a transient API error would silently promote.
const CLASSIFY_FALLBACK = 'NEEDS_HUMAN';

async function classifyReply(company, replyBody) {
  return classifyProviderReply({ provider: 'gmail', lead: { company }, plainTextReply: replyBody, apiKey: ANTHROPIC_API_KEY });
}

// ── INBOUND QUESTION ANSWERING ────────────────────────────────────────────────
// When a reply is a genuine question, Haiku drafts an answer from
// product-facts.js ONLY, then the warm booking snippet is appended.
//
// The confidence gate is the point of this function. Auto-sending a wrong
// answer to a prospect is worse than answering an hour later, so anything the
// model is not sure of — plus pricing and objections, unconditionally — becomes
// a DRAFT for review instead of an outbound email.
//
// Returns { mode: 'auto' | 'draft', body, reason, confidence }.
// mode 'auto'  → safe to send as-is
// mode 'draft' → write to the review queue, never send
const ANSWER_MAX_TOKENS = 400;

async function answerQuestion(lead, replyText) {
  const company = cleanCompanyName(lead.company) || 'your clinic';
  const draft = (body, reason, confidence = 0) => ({ mode: 'draft', body, reason, confidence });

  if (!ANTHROPIC_API_KEY) {
    return draft(bookingSnippet(company), 'no ANTHROPIC_API_KEY — cannot answer', 0);
  }

  try {
    const msg = await anthropicClient.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: ANSWER_MAX_TOKENS,
      system: [
        'You draft short replies on behalf of Deins, who sells an AI receptionist to dental clinics.',
        '',
        'You may state ONLY what the FACTS below support. If the question needs anything not in',
        'the facts, do not invent it — lower your confidence instead.',
        '',
        '=== FACTS (your only source of truth) ===',
        PRODUCT_FACTS,
        '=== END FACTS ===',
        '',
        'NEVER auto-answer questions about:',
        ...NEVER_AUTO_ANSWER.map(t => `- ${t}`),
        'For any of those, set confidence to 0 and set needs_human to true.',
        '',
        'STYLE — this matters, previous replies have been called out for sounding like AI:',
        '- Plain and short. 2-4 sentences. Answer the question and stop.',
        '- No filler openers ("Great question!", "Thanks for reaching out!", "I hope this finds you well").',
        '- No marketing adjectives, no exclamation marks, no bullet lists.',
        '- Write like a person typing a quick reply on their phone.',
        '- Do NOT add a sign-off, greeting, or booking link — those are added separately.',
        '',
        'Respond with ONLY a JSON object, no prose around it:',
        '{"answer": "<the reply body>", "confidence": <0-100>, "needs_human": <true|false>, "topic": "<2-4 words>"}',
        '',
        'confidence is how sure you are the answer is accurate AND fully supported by the facts.',
        'Use 0-60 if the facts do not clearly cover it. Only use 85+ when the facts answer it directly.',
      ].join('\n'),
      messages: [{ role: 'user', content: `Clinic: ${company}\nTheir reply:\n${replyText}` }],
    });

    const raw = (msg.content[0]?.text || '').trim();
    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    } catch (_e) {
      return draft(bookingSnippet(company), `model returned unparseable output: ${raw.slice(0, 120)}`, 0);
    }

    const confidence = Number(parsed.confidence) || 0;
    const answer = String(parsed.answer || '').trim();
    const topic = String(parsed.topic || '').trim();

    // Belt-and-braces pricing catch: the model is told never to answer pricing,
    // but a regex on the INBOUND text means a price question can't slip through
    // on a model mistake either.
    const pricingAsked = /\b(pric|cost|fee|charge|how much|\$|rate|budget|quote|monthly|per month)/i.test(replyText);
    if (pricingAsked) {
      return draft(pricingDeflection(company), 'pricing question — never auto-sent, price is delivered on the call', confidence);
    }

    // Same belt-and-braces treatment for objections. classifyReply() is the
    // primary gate and routes pushback to NEEDS_HUMAN (verified), so this only
    // fires if an objection is ever mis-routed here as a QUESTION — at which
    // point the model has been observed rating it answerable at exactly the
    // confidence floor. An objection is a sales conversation, not a fact
    // lookup; it goes to a human.
    const OBJECTION_PATTERNS = /\b(already have|already use|already using|not convinced|don'?t think|do not think|doesn'?t work|won'?t work|skeptical|sceptical|we'?re (fine|good|happy|all set)|no thanks|not for us|waste of|scam|spam)\b/i;
    if (OBJECTION_PATTERNS.test(replyText)) {
      return draft(withBooking(answer, company), 'reads as an objection — routed to review, not auto-sent', confidence);
    }
    if (parsed.needs_human === true) return draft(withBooking(answer, company), `model flagged needs_human (${topic})`, confidence);
    if (confidence < ANSWER_CONFIDENCE_FLOOR) return draft(withBooking(answer, company), `confidence ${confidence} < ${ANSWER_CONFIDENCE_FLOOR} (${topic})`, confidence);
    if (!answer) return draft(bookingSnippet(company), 'model returned an empty answer', confidence);

    return { mode: 'auto', body: withBooking(answer, company), reason: `confident answer (${topic})`, confidence };
  } catch (e) {
    return draft(bookingSnippet(company), `answer API error: ${e.message}`, 0);
  }
}

// Answer + the warm booking snippet, in the house voice.
function withBooking(answer, company) {
  return `${answer.trim()}\n\n${bookingSnippet(company)}`;
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
// Sets emailStatus='done' when the last step in the sequence has been sent —
// and, on that same last step, writes stage='Done' too (H), matching what
// handleNotInterested and runBounceCheckPass already do for their own terminal
// paths. Non-final steps keep writing SENT_STAGE, unchanged. This only affects
// the display label: emailStatus is what every selector actually gates on
// (selectQueued/selectFollowUps/getOpenTriggeredLeads — none of them key off
// stage='Contacted'), so this cannot change what gets sent.
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
  const stageValue   = isLastStep ? 'Done' : SENT_STAGE;
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
            { range: `${SHEET_NAME}!H${rowNum}`,            values: [[stageValue]] },
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
  await addSuppression(lead.email, 'unsubscribe', lead.company, 'reply-auto');
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
// Review queue for answers that must not auto-send. One row per drafted reply;
// the dashboard surfaces the pending count as Deins's action queue.
const DRAFTS_SHEET  = 'ReplyDrafts';
const DRAFTS_HEADER = ['createdAt','leadId','company','email','topic','confidence','reason','draftBody','status','campaignProfile','classification','reasonCode'];

async function ensureDraftsSheet() {
  const s  = sheets();
  const ss = await s.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const exists = ss.data.sheets.find(sh => sh.properties.title === DRAFTS_SHEET);
  if (!exists) await s.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: DRAFTS_SHEET } } }] },
    });
  const current = exists ? await s.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${DRAFTS_SHEET}!A1:L1` }) : null;
  if (current && DRAFTS_HEADER.every((value, index) => current.data.values?.[0]?.[index] === value)) return;
  await s.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID, range: `${DRAFTS_SHEET}!A1`,
    valueInputOption: 'RAW', requestBody: { values: [DRAFTS_HEADER] },
  });
  console.log(`[Drafts] ${DRAFTS_SHEET} headers ready`);
}

async function queueDraft(lead, answer) {
  await ensureDraftsSheet();
  const before = await sheets().spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID, range: `${DRAFTS_SHEET}!A:A`,
  });
  const beforeRows = (before.data.values || []).length;

  await sheets().spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID, range: `${DRAFTS_SHEET}!A:L`,
    valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[
      new Date().toISOString(), lead.id, cleanCompanyName(lead.company) || lead.company || '',
      lead.email, answer.reason || '', String(answer.confidence ?? ''), answer.reason || '',
      answer.body || '', 'pending', answer.campaignProfile || '', answer.classification || '', answer.reasonCode || '',
    ]] },
  });

  // post-write verification — exactly one row added
  const after = await sheets().spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID, range: `${DRAFTS_SHEET}!A:A`,
  });
  const added = (after.data.values || []).length - beforeRows;
  if (added !== 1) console.warn(`[Drafts] expected 1 new row, saw ${added}`);
  console.log(`  ✎ Draft queued for review — ${lead.email} (${answer.reason})`);
}

// A genuine question. Answer it from the facts if we're confident; otherwise
// draft it for Deins. Either way the lead is tagged so the dashboard shows it.
async function handleQuestion(lead, replyText, todaySent) {
  const rowNum = await resolveRow(lead.id);
  const answer = await answerQuestion(lead, replyText);

  // ── gates that apply to auto-send only ──
  // A drafted reply is never sent by the agent, so it needs no send gate; a
  // human reviews and sends it, at which point these no longer apply.
  let mode = answer.mode;
  let gateReason = '';
  if (mode === 'auto') {
    const suppressed = suppressionReason(lead);
    if (suppressed) {
      mode = 'blocked';
      gateReason = `suppressed (${suppressed})`;
    } else if (todaySent >= DAILY_SEND_LIMIT) {
      // Touch cap: an auto-answer is a real send and counts against the same
      // daily ceiling as outreach, so a busy day can't over-mail.
      mode = 'draft';
      gateReason = `daily send cap reached (${todaySent}/${DAILY_SEND_LIMIT})`;
      answer.reason = `${answer.reason} — held: ${gateReason}`;
    }
  }

  if (mode === 'blocked') {
    console.warn(`  🚫 [SUPPRESSED] not answering ${lead.email} — ${gateReason}`);
    if (rowNum) {
      await sheets().spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { valueInputOption: 'RAW', data: [
          { range: `${SHEET_NAME}!H${rowNum}`, values: [['Replied']] },
          { range: `${SHEET_NAME}!I${rowNum}`, values: [['replied']] },
          { range: `${SHEET_NAME}!L${rowNum}`, values: [[prependNote(lead.notes, `[REPLY: Question — not answered, ${gateReason}]`)]] },
        ] },
      });
    }
    return;
  }

  if (mode === 'draft') {
    await queueDraft(lead, answer);
    if (rowNum) {
      await sheets().spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { valueInputOption: 'RAW', data: [
          { range: `${SHEET_NAME}!H${rowNum}`, values: [['Review']] },
          { range: `${SHEET_NAME}!I${rowNum}`, values: [['replied']] },
          { range: `${SHEET_NAME}!L${rowNum}`, values: [[prependNote(lead.notes, '[REPLY: Question — draft awaiting review]')]] },
        ] },
      });
    }
    return;
  }

  // ── auto-send ──
  const company = cleanCompanyName(lead.company) || 'your clinic';
  const subject = `Re: a quick demo I built for ${company}`;
  const casl = `---\n${MAILING_ADDRESS}\nReply "unsubscribe" and I'll remove you immediately.`;
  const body = `Hi ${salutationName(lead)},\n\n${answer.body}\n\n${EMAIL_SIGNATURE}\n\n${casl}`;

  if (!SENDING_ENABLED) {
    console.log(`⛔ [kill-switch] would auto-answer → ${lead.email}`);
    return;
  }
  await sendEmail({ to: lead.email.trim(), subject, body });
  console.log(`  ✅ Auto-answered ${lead.email} (confidence ${answer.confidence})`);

  if (rowNum) {
    await sheets().spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: 'RAW', data: [
        { range: `${SHEET_NAME}!H${rowNum}`, values: [['Replied']] },
        { range: `${SHEET_NAME}!I${rowNum}`, values: [['replied']] },
        { range: `${SHEET_NAME}!J${rowNum}`, values: [[new Date().toISOString()]] },
        { range: `${SHEET_NAME}!L${rowNum}`, values: [[prependNote(lead.notes, `[REPLY: Question — auto-answered, booking link sent]`)]] },
      ] },
    });
  }
}

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

const ROOFING_LINK_SENT_TAG = '[ROOFING_SURVEY_LINK_SENT]';
const ROOFING_DRAFTED_TAG = '[ROOFING_SURVEY_DRAFTED]';

async function markRoofingReplyState(lead, stage, status, tag) {
  const rowNum = await resolveRow(lead.id);
  if (!rowNum) return;
  const notes = prependNote(lead.notes, tag);
  await sheets().spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { valueInputOption: 'RAW', data: [
      { range: `${SHEET_NAME}!H${rowNum}`, values: [[stage]] },
      { range: `${SHEET_NAME}!I${rowNum}`, values: [[status]] },
      { range: `${SHEET_NAME}!L${rowNum}`, values: [[notes]] },
    ] },
  });
  lead.notes = notes;
}

async function handleRoofingSurveyReply(lead, message, replyText, todaySent) {
  if (!ROOFING_SURVEY_REPLY_FLOW_ENABLED) {
    await handleNeedsHuman(lead, message.fromAddr);
    return 'flow_disabled';
  }
  const classification = await classifyRoofingReply({ replyText, createMessage: anthropicClient ? input => anthropicClient.messages.create(input) : null });
  console.log(`  [roofing-reply] profile=${ROOFING_SURVEY_PROFILE} classification=${classification.category} reason=${classification.reason_code}`);
  if (classification.category === 'unsubscribe') { await handleUnsubscribe(lead); return classification.category; }
  if (classification.category === 'negative') { await handleNotInterested(lead); return classification.category; }
  if (classification.category === 'wrong_person') { await handleWrongPerson(lead); return classification.category; }
  if (['out_of_office','automated'].includes(classification.category)) { await markRoofingReplyState(lead, 'Done', 'done', `[ROOFING_SURVEY: ${classification.category}]`); return classification.category; }
  if (classification.category === 'already_completed') { await markRoofingReplyState(lead, 'Done', 'done', '[ROOFING_SURVEY: already completed]'); return classification.category; }

  if (classification.category === 'positive' && classification.should_send_survey && !classification.requires_human_review && classification.confidence >= ANSWER_CONFIDENCE_FLOOR / 100) {
    if ((lead.notes || '').includes(ROOFING_LINK_SENT_TAG) || (lead.notes || '').includes(ROOFING_DRAFTED_TAG)) return 'duplicate_blocked';
    let body = '';
    try { body = renderRoofingSurveyReply(lead, ROOFING_SURVEY_URL, { mailingAddress: MAILING_ADDRESS, reference: `SL-${refCode(lead)}` }); }
    catch (_) {
      await queueDraft(lead, { body: '', confidence: classification.confidence, reason: 'roofing survey URL is missing or invalid', campaignProfile: ROOFING_SURVEY_PROFILE, classification: classification.category, reasonCode: 'missing_survey_url' });
      await markRoofingReplyState(lead, 'Review', 'replied', ROOFING_DRAFTED_TAG);
      return 'missing_url';
    }
    if (!ROOFING_SURVEY_AUTO_REPLY_ENABLED) {
      await queueDraft(lead, { body, confidence: classification.confidence, reason: 'roofing survey response requires approval', campaignProfile: ROOFING_SURVEY_PROFILE, classification: classification.category, reasonCode: classification.reason_code });
      await markRoofingReplyState(lead, 'Review', 'replied', ROOFING_DRAFTED_TAG);
      return 'drafted';
    }
    const blocked = suppressionReason(lead) || (!SENDING_ENABLED && 'sending disabled') || (todaySent >= DAILY_SEND_LIMIT && 'daily limit reached');
    if (blocked) {
      await queueDraft(lead, { body, confidence: classification.confidence, reason: `roofing survey auto-reply blocked: ${blocked}`, campaignProfile: ROOFING_SURVEY_PROFILE, classification: classification.category, reasonCode: 'send_gate_blocked' });
      await markRoofingReplyState(lead, 'Review', 'replied', ROOFING_DRAFTED_TAG);
      return 'blocked';
    }
    await sendEmail({ to: lead.email.trim(), subject: 'Re: quick roofing question', body, threadId: message.threadId, inReplyTo: message.rfcMessageId, references: message.rfcMessageId });
    await markRoofingReplyState(lead, 'Replied', 'replied', ROOFING_LINK_SENT_TAG);
    return 'sent';
  }

  const body = classification.category === 'question' ? renderRoofingQuestionDraft(lead) : '';
  await queueDraft(lead, { body, confidence: classification.confidence, reason: 'roofing survey reply requires human review', campaignProfile: ROOFING_SURVEY_PROFILE, classification: classification.category, reasonCode: classification.reason_code });
  await markRoofingReplyState(lead, 'Review', 'replied', ROOFING_DRAFTED_TAG);
  return 'review';
}

// ── REPLY-CHECK PASS ─────────────────────────────────────────────────────────
// Runs unconditionally on every agent invocation — independent of whether there
// are queued sends or follow-ups due. Fetches each emailed lead's reply body,
// classifies it with Haiku, and routes to the appropriate handler. Mutates
// lead.emailStatus in-place so selectFollowUps() excludes replied leads.
async function runReplyCheckPass(leads, todaySentOverride = null) {
  const candidates = leads.filter(l => l.emailStatus === 'emailed' && isValidEmail(l.email));
  if (!candidates.length) {
    console.log('[ReplyCheck] No emailed leads to check.\n');
    return;
  }
  console.log(`[ReplyCheck] Checking ${candidates.length} emailed lead${candidates.length === 1 ? '' : 's'} for replies...`);

  let found = 0;
  const classCounts = {};
  // Auto-answers are real sends and share the daily ceiling with outreach, so
  // the pass starts from today's actual count rather than assuming zero.
  let replyPassTodaySent = todaySentOverride ?? countTodaySends(leads);

  for (const lead of candidates) {
    const message = await withAuth(() => getReplyMessage(lead));
    if (!message) continue;

    found++;
    const company        = cleanCompanyName(lead.company) || lead.email;
    const replyText      = message.body || message.snippet;
    if (lead.emailTemplateId === ROOFING_SURVEY_TEMPLATE) {
      lead.emailStatus = 'replied';
      if (!DRY_RUN) await withAuth(() => handleRoofingSurveyReply(lead, message, replyText, replyPassTodaySent));
      else console.log(`  ↩ Roofing survey reply from ${lead.email} (${company}) — no writes in dry run`);
      continue;
    }
    const classification = await classifyReply(lead.company, replyText);
    classCounts[classification] = (classCounts[classification] || 0) + 1;

    const fromNote = (message.fromAddr && message.fromAddr !== lead.email.trim().toLowerCase())
      ? ` (from ${message.fromAddr})` : '';
    console.log(`  ↩ Reply from ${lead.email}${fromNote} (${company}) — ${classification}`);
    lead.emailStatus = 'replied'; // exclude from follow-ups this run regardless of classification

    if (!DRY_RUN) {
      await withAuth(async () => {
        switch (classification) {
          // A genuine question is answered from product-facts.js when we're
          // confident, otherwise drafted for review. Both paths append the
          // warm booking snippet. todaySent enforces the touch cap.
          case 'QUESTION':       return handleQuestion(lead, replyText, replyPassTodaySent);
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
      await withAuth(() => addSuppression(lead.email, 'bounce', lead.company, 'bounce-auto'));
    }
    bounced++;
  }

  console.log(`[BounceCheck] ${bounced} bounce${bounced !== 1 ? 's' : ''} found / ${candidates.length} checked\n`);
}

// ── INTENT TRIGGER: BOTH AUDIOS PLAYED ────────────────────────────────────────
// Playing the spoken intro AND the receptionist demo is the strongest signal
// short of a reply: someone sat through both. This fires ONE email per lead,
// within minutes, offering the call.
//
// "Real" plays only. A play is discarded if it came from Deins's own IP (the
// same BLOCKED_IPS list the tracking pixels use), a bot UA, or a datacenter IP
// via the shared open-filter. Multiple plays of the same clip collapse.
//
// Fired state lives in its own tab so a repeat play — or a server restart —
// can never re-fire it.
const INTENT_SHEET  = 'IntentFired';
const INTENT_HEADER = ['firedAt','leadId','company','email','trigger'];
const INTENT_BLOCKED_IPS = ['75.155.151.158'];   // keep in sync with server.js pixels

async function ensureIntentSheet() {
  const s  = sheets();
  const ss = await s.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  if (ss.data.sheets.find(sh => sh.properties.title === INTENT_SHEET)) return;
  await s.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: INTENT_SHEET } } }] },
  });
  await s.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID, range: `${INTENT_SHEET}!A1`,
    valueInputOption: 'RAW', requestBody: { values: [INTENT_HEADER] },
  });
  console.log(`[Intent] ${INTENT_SHEET} tab created`);
}

async function loadFiredIntents() {
  try {
    const r = await sheets().spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID, range: `${INTENT_SHEET}!A:E`,
    });
    // key on leadId + trigger so a future second trigger type is independent
    return new Set((r.data.values || []).slice(1)
      .filter(row => row[1]).map(row => `${row[1]}|${row[4] || 'both-audios'}`));
  } catch (_e) {
    return new Set();   // missing tab = nothing fired yet
  }
}

// Reads DemoPlays and returns Map<companyKey, {intro, demo}> of REAL plays.
async function readRealDemoPlays() {
  const r = await sheets().spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID, range: 'DemoPlays!A:F',
  });
  const byKey = new Map();
  for (const row of (r.data.values || []).slice(1)) {
    const [ts, company, , ip, ua, audioTypeRaw] = row;
    if (!company) continue;
    if (INTENT_BLOCKED_IPS.includes((ip || '').trim())) continue;      // own IP
    if (BOT_UA_PATTERN.test(ua || '')) continue;                        // bot UA
    if (isDatacenterIp(ip)) continue;                                   // cloud egress
    const key = normalizeName(cleanCompanyName(company));
    if (!key) continue;
    // blank column F predates the intro and was always a receptionist demo
    const type = String(audioTypeRaw || '').trim().toLowerCase() === 'intro' ? 'intro' : 'demo';
    if (!byKey.has(key)) byKey.set(key, { intro: 0, demo: 0, last: '' });
    const e = byKey.get(key);
    e[type]++;                                    // repeat plays collapse via the pair test below
    if ((ts || '') > e.last) e.last = ts || '';
  }
  return byKey;
}

// Mirrors the pixel routes' bot check so a UA rejected there is rejected here.
const BOT_UA_PATTERN = /curl|wget|python|java|go-http|axios|node-fetch|spider|crawler|bot|preview|scan|mimecast|barracuda|proofpoint|cloudmark|symantec/i;

function buildIntentEmail(lead) {
  const company = cleanCompanyName(lead.company) || 'your clinic';
  const casl = `---\n${MAILING_ADDRESS}\nReply "unsubscribe" and I'll remove you immediately.`;
  // Opens by naming the demo play directly and asking for a reaction, so the
  // easiest response is a reply rather than a booking — the calendar link below
  // is the second option, not the only one.
  //
  // Note this addresses "you" even though the listener may have been a staff
  // member; that is a deliberate call, chosen over the vaguer "someone at your
  // office" phrasing. The trigger itself still requires BOTH clips to have been
  // played — the copy just refers to "the demo" rather than itemising them.
  const lead_in = `I noticed you listened to the demo — I'm interested to hear your thoughts.`;
  return {
    subject: `Re: a quick demo I built for ${company}`,
    body: `Hi ${salutationName(lead)},\n\n${bookingSnippet(company, { lead: lead_in })}\n\n${EMAIL_SIGNATURE}\n\n${casl}`,
  };
}

async function runIntentTriggerPass(allLeads) {
  await ensureIntentSheet();
  const [plays, fired] = await Promise.all([readRealDemoPlays(), loadFiredIntents()]);

  const due = [];
  for (const lead of allLeads) {
    const key = normalizeName(cleanCompanyName(lead.company));
    if (!key) continue;
    const p = plays.get(key);
    if (!p || p.intro < 1 || p.demo < 1) continue;        // needs BOTH
    if (fired.has(`${lead.id}|both-audios`)) continue;     // already fired, ever
    // A lead who has already replied is in a HUMAN conversation — Deins may
    // have answered, booked them, or been told no. An automated "someone
    // listened, here's my calendar" nudge on top of that is at best redundant
    // and at worst contradicts what was already agreed. Verified against live
    // data: without this, an INTERESTED lead already promoted to the call
    // pipeline would have been mailed again.
    if (lead.emailStatus === 'replied' || lead.stage === 'Replied' || lead.stage === 'Promoted') {
      console.log(`  ⏭️  ${lead.email} played both but has already replied (${lead.stage}) — human has it`);
      continue;
    }
    due.push(lead);
  }

  if (!due.length) { console.log('[Intent] no leads with both audios pending.'); return 0; }
  console.log(`[Intent] ${due.length} lead(s) played BOTH audios and have not been contacted.`);

  let sent = 0;
  let todaySent = countTodaySends(allLeads);
  for (const lead of due) {
    // ── same gates as every other send path ──
    const suppressed = suppressionReason(lead);
    if (suppressed) { console.warn(`  🚫 [SUPPRESSED] skipping intent email → ${lead.email} (${suppressed})`); continue; }
    if (!isValidEmail(lead.email)) { console.warn(`  ⏭️  invalid address ${lead.email}`); continue; }
    if (todaySent >= DAILY_SEND_LIMIT) { console.warn(`  ⏸️  daily cap reached (${todaySent}/${DAILY_SEND_LIMIT}) — deferring to next pass`); break; }

    const { subject, body } = buildIntentEmail(lead);
    if (DRY_RUN)          { console.log(`— WOULD SEND (intent) → ${lead.email}\n   ${subject}`); continue; }
    if (!SENDING_ENABLED) { console.log(`⛔ [kill-switch] would send intent email → ${lead.email}`); continue; }

    try {
      await sendEmail({ to: lead.email.trim(), subject, body });
      // Record the fire BEFORE anything else can fail, so a crash after send
      // can never produce a duplicate on the next pass.
      await sheets().spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID, range: `${INTENT_SHEET}!A:E`,
        valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [[new Date().toISOString(), lead.id,
          cleanCompanyName(lead.company) || '', lead.email, 'both-audios']] },
      });
      const rowNum = await resolveRow(lead.id);
      if (rowNum) {
        await sheets().spreadsheets.values.batchUpdate({
          spreadsheetId: SPREADSHEET_ID,
          requestBody: { valueInputOption: 'RAW', data: [
            { range: `${SHEET_NAME}!J${rowNum}`, values: [[new Date().toISOString()]] },
            { range: `${SHEET_NAME}!L${rowNum}`, values: [[prependNote(lead.notes, '[INTENT: both audios played — booking link sent]')]] },
          ] },
        });
      }
      sent++; todaySent++;
      console.log(`  🎧 Intent email sent → ${lead.email} (${cleanCompanyName(lead.company)})`);
    } catch (e) {
      console.error(`  ❌ intent send failed → ${lead.email}: ${e.message}`);
    }
  }
  console.log(`[Intent] ${sent} intent email(s) sent.`);
  return sent;
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

// ── GLOBAL SUPPRESSION LIST (durable, keyed by email) ─────────────────────────
// The per-row notes tag above is fragile: delete the row (manual cleanup, a
// re-scrape churn) and the opt-out is gone, so a later re-import of the same
// address re-enters as sendable — a CASL violation. The Suppression tab is the
// durable record: keyed by EMAIL, it survives row deletion and is checked at
// BOTH import (server.js) and send (here). Every suppression origin
// (auto-unsubscribe, auto-bounce, manual dashboard unsubscribe) writes to it.
const SUPPRESSION_SHEET = 'Suppression';
const SUPPRESSION_HEADER = ['email', 'reason', 'company', 'suppressedAt', 'source'];
let SUPPRESSED_EMAILS = new Set();   // populated by loadSuppressionList() at run() start

const normEmail = e => (e || '').toLowerCase().trim();

async function ensureSuppressionSheet() {
  const s  = sheets();
  const ss = await s.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  if (ss.data.sheets.find(sh => sh.properties.title === SUPPRESSION_SHEET)) return;
  await s.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: SUPPRESSION_SHEET } } }] },
  });
  await s.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID, range: `${SUPPRESSION_SHEET}!A1`,
    valueInputOption: 'RAW', requestBody: { values: [SUPPRESSION_HEADER] },
  });
  console.log('[Suppression] tab created with headers');
}

// Reads the tab into SUPPRESSED_EMAILS. Tolerant: a missing tab just yields an
// empty set (nothing is ever un-suppressed by a read failure).
async function loadSuppressionList() {
  try {
    const r = await sheets().spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID, range: `${SUPPRESSION_SHEET}!A:A`,
    });
    SUPPRESSED_EMAILS = new Set((r.data.values || []).slice(1).map(row => normEmail(row[0])).filter(Boolean));
    console.log(`[Suppression] loaded ${SUPPRESSED_EMAILS.size} suppressed email(s)`);
  } catch (e) {
    console.warn(`[Suppression] load failed (${e.message}) — treating as empty`);
    SUPPRESSED_EMAILS = new Set();
  }
}

// Appends an email to the durable tab (and the in-memory set). Idempotent: an
// email already present is not re-appended. No-op in DRY_RUN.
async function addSuppression(email, reason, company, source) {
  const e = normEmail(email);
  if (!e || SUPPRESSED_EMAILS.has(e)) return;
  SUPPRESSED_EMAILS.add(e);
  if (DRY_RUN) return;
  await sheets().spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID, range: `${SUPPRESSION_SHEET}!A:E`,
    valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[e, reason || '', cleanCompanyName(company) || company || '', new Date().toISOString(), source || '']] },
  });
  console.log(`[Suppression] + ${e} (${reason})`);
}

// A lead must not be emailed if EITHER its notes carry a suppression tag OR its
// address is on the global suppression list (survives row deletion / re-import).
function suppressionReason(lead) {
  const notes = lead.notes || '';
  for (const tag of SUPPRESSION_TAGS) {
    if (notes.includes(tag)) return tag;
  }
  if (SUPPRESSED_EMAILS.has(normEmail(lead.email))) return 'suppression-list';
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
    const routing = routedLeadReady(l);
    if (!routing.ok) {
      console.warn(`🧭 [routing] skipping queued lead ${l.email} (${l.company || l.id}) — ${routing.reason}`);
      return false;
    }
    if (!routing.legacy && l.senderInboxId !== 'primary') {
      console.warn(`🧭 [routing] skipping queued lead ${l.email} (${l.company || l.id}) — assigned inbox routing is not active`);
      return false;
    }
    // Global suppression list (durable, survives row deletion / re-import) —
    // first-line exclusion; suppressionReason() is the last-line guard at send.
    if (SUPPRESSED_EMAILS.has(normEmail(l.email))) {
      console.warn(`⊘ [suppressed] skipping queued lead ${l.email} (${l.company || l.id}) — on global suppression list`);
      return false;
    }
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

function routedLeadCanUseCurrentSender(lead) {
  const routing = routedLeadReady(lead);
  return routing.ok && (routing.legacy || lead.senderInboxId === 'primary');
}

// Phase 3: find leads that are due for a follow-up step.
// currentStep 1 → send step 2 (FOLLOW_UP_SEQUENCE[0], 3 days)
// currentStep 2 → send step 3 (FOLLOW_UP_SEQUENCE[1], 5 days)
function selectFollowUps(leads) {
  const now = Date.now();
  return leads.filter(l => {
    if (l.emailStatus !== 'emailed') return false;
    if (l.emailTemplateId === ROOFING_SURVEY_TEMPLATE) return false;
    if (!isValidEmail(l.email)) return false;
    if (!routedLeadCanUseCurrentSender(l)) return false;
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
//   1. scanner-looking opens are discounted — the shared isScannerOpen() in
//      open-filter.js owns that definition (send-window proximity + datacenter
//      IP ranges) and server.js's dashboard stats call the exact same code, so
//      the two can never drift.
//   2. the surviving opens must span >= 2 distinct calendar days (Vancouver):
//      a scanner burst lands on one day; a human who returns does not.
//
// NOTE: this pass deliberately does NOT feed ProposalEngaged/DemoPlays rows to
// annotateOpens, so the rescue can only fire on a genuine multi-day return
// visit. Sending is the irreversible direction: the agent stays at least as
// strict as the dashboard, never looser.
function getOpenTriggeredLeads(allLeads, proposalOpens) {
  const leadByKey = new Map();
  for (const l of allLeads) {
    const k = normalizeName(cleanCompanyName(l.company));
    if (k && !leadByKey.has(k)) leadByKey.set(k, l);
  }

  const annotated = annotateOpens({
    opens:   proposalOpens,
    keyOf:   row => normalizeName(cleanCompanyName(row.company)),
    leadFor: row => leadByKey.get(normalizeName(cleanCompanyName(row.company))) || null,
  });

  const opensByKey = new Map();   // normalized company → [real open timestamp ms]
  for (const open of annotated) {
    if (!open.real) continue;     // scanner detonation — never counts toward warm
    const key = open.key;
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
      if (lead.emailTemplateId === ROOFING_SURVEY_TEMPLATE) return false;
      if (!routedLeadCanUseCurrentSender(lead)) return false;
      const step = parseInt(lead.emailStep || '0', 10);
      if (step < 1 || step > FOLLOW_UP_SEQUENCE.length) return false;
      if (lead.stage === 'Replied') return false;
      const lastSent = new Date(lead.lastEmailedAt).getTime();
      if (isNaN(lastSent) || (now - lastSent) < TWELVE_HOURS) return false;

      const key     = normalizeName(cleanCompanyName(lead.company));
      // opensByKey already holds only non-scanner opens (annotateOpens above),
      // so no second timing filter is needed here.
      const genuine = opensByKey.get(key) || [];
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

  const modeLabel = INTENT_ONLY ? 'INTENT-ONLY (both-audios trigger only)'
                  : CHECK_ONLY ? 'CHECK-ONLY (reply/bounce detection, no sends)'
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

  // Load the durable suppression list before any pass — the reply/bounce
  // handlers add to it, and both selection and the send guard read it. Ensure
  // the tab exists first (no-op if already there) so writes never fail.
  if (!DRY_RUN) await withAuth(ensureSuppressionSheet);
  await withAuth(loadSuppressionList);
  await withAuth(loadOutreachProviderState);

  const all = await withAuth(readLeads);
  const allLeadsForDailyCap = [...all];
  if (TARGET_LEAD_ID) {
    const target = all.find(lead => lead.id === TARGET_LEAD_ID);
    if (!target) throw new Error(`TARGET_LEAD_ID ${TARGET_LEAD_ID} was not found`);
    all.splice(0, all.length, target);
    console.log(`[target] Controlled run restricted to lead ${TARGET_LEAD_ID}`);
  }

  // INTENT_ONLY: run just the both-audios trigger and stop. No reply check, no
  // bounce check, no outreach — this path exists to be cheap enough to spawn on
  // demand when a demo play completes a pair.
  if (INTENT_ONLY) {
    await withAuth(() => runIntentTriggerPass(all));
    return;
  }

  const todaySent      = countTodaySends(allLeadsForDailyCap);
  console.log(`[cap] ${todaySent}/${DAILY_SEND_LIMIT} emails sent today (Vancouver time)`);
  const dailyRemaining = Math.max(0, DAILY_SEND_LIMIT - todaySent);

  // Reply-check pass — unconditional; runs even when cap is reached.
  // Mutates emailStatus on replied leads so selectFollowUps excludes them below.
  await runReplyCheckPass(all, todaySent);

  // Bounce-check pass — marks bounced leads Done before follow-up selection.
  await runBounceCheckPass(all);

  // Intent trigger — both-audios. Runs in every normal pass as a backstop to
  // the event-driven spawn, so a missed webhook still gets picked up.
  await withAuth(() => runIntentTriggerPass(all));

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

    const campaignProvider = providerForLead(lead);
    if (campaignProvider.provider === 'smartlead') {
      if (DRY_RUN) { console.log(`— WOULD ADD TO SMARTLEAD → ${lead.email} (campaign ${campaignProvider.externalCampaignId || 'missing mapping'})`); continue; }
      try {
        const result = await withAuth(() => enqueueSmartleadLead(lead, campaignProvider));
        console.log(result.testMode ? `🧪 Smartlead test mode — no upload → ${lead.email}` : `✅ Added to Smartlead campaign → ${lead.email}`);
      } catch (e) { console.error(`❌ Smartlead enqueue failed → ${lead.email}: ${e.message}`); }
      continue;
    }
    // buildEmail can THROW rather than emit a half-merged guarantee (see
    // guaranteeFor). That must become a draft for review, not an unhandled
    // error or a "send failed" log line — the lead is fine, the data isn't.
    let built;
    try {
      if (lead.emailTemplateId === ROOFING_SURVEY_TEMPLATE) {
        const qualification = qualifyRoofingLead(lead);
        if (!qualification.ok) throw new Error(`roofing lead qualification failed (${qualification.reasonCode})`);
        const email = renderRoofingSurveyInitial(lead, { mailingAddress: MAILING_ADDRESS, reference: `SL-${refCode(lead)}` });
        const invalid = validateRoofingSurveyInitial(email);
        if (invalid) throw new Error(invalid);
        built = { ...email, link: '', opener: 'locked roofing survey copy', openerTier: 'LOCKED', pitchTier: ROOFING_SURVEY_PROFILE };
      } else {
        built = await buildEmail(lead);
      }
    } catch (e) {
      console.error(`✎ [draft] could not build step 1 → ${lead.email} — ${e.message}`);
      await withAuth(() => queueDraft(lead, {
        mode: 'draft', body: '', confidence: 0,
        reason: `cold email could not be built: ${e.message}`,
      }));
      continue;
    }
    const { subject, body, link, opener, openerTier, pitchTier } = built;

    if (DRY_RUN) {
      const rawCo  = lead.company || '';
      const cleanCo = cleanCompanyName(rawCo);
      console.log(`— WOULD SEND (step 1) →  ${lead.email}  (${rawCo || lead.first || lead.id})`);
      if (rawCo && rawCo !== cleanCo) console.log(`   Company: "${rawCo}" → "${cleanCo}"`);
      console.log(`   Pitch:   ${pitchTier}`);
      console.log(`   Subject: ${subject}  [variant ${coldSubjectIndex(lead) + 1}/${COLD_SUBJECTS.length}]`);
      console.log(`   Opener:  ${opener}  [${openerTier}]`);
      console.log(`   Link:    ${link}\n`);
      continue;
    }

    // Personalization + guarantee gate. Runs BEFORE the kill switch so a
    // dry/gated run still surfaces bad merges, and before any send so a
    // malformed guarantee can never leave the building.
    const invalid = lead.emailTemplateId === ROOFING_SURVEY_TEMPLATE
      ? validateRoofingSurveyInitial({ subject, body })
      : validateColdEmail(lead, subject, body, link);
    if (invalid) {
      console.error(`✎ [draft] not sending step 1 → ${lead.email} — ${invalid}`);
      await withAuth(() => queueDraft(lead, {
        mode: 'draft', body, confidence: 0,
        reason: `cold email failed validation: ${invalid}`,
      }));
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
