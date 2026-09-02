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
const { isDatacenterIp } = require('./open-filter');
// WARM-ONLY booking asset — see booking.js. Imported here for the two intent
// triggers (question replies, both-audios-played) and NOT by any cold template.
const { bookingSnippet, pricingDeflection, BOOKING_URL, containsBookingLink } = require('./booking');
// The only source of truth the reply-answering model may state as fact.
const { PRODUCT_FACTS, NEVER_AUTO_ANSWER } = require('./product-facts');
// Fixed commercial promise for the cold email. Deliberately NOT in booking.js:
// that module is the warm-only booking asset and the cold path is guarded
// against importing it.
const { guaranteeFor, hasIntactGuarantee } = require('./guarantee');
const { GmailOutreachProvider } = require('./integrations/outreach-providers');
const { SmartleadClient } = require('./integrations/smartlead-client');
const { SmartleadOutreachProvider } = require('./integrations/outreach-providers');
const { classifyReply: classifyProviderReply } = require('./integrations/reply-classifier');
const { classifyReplyText, isUsableReplyIdentity, REPLY_STATE } = require('./integrations/canonical-reply');
// ONE ownership model, shared with the CRM. The sender asks it rather than
// keeping a second opinion about who may act on a lead.
const { NON_COLD_STAGES, deriveAutomationOwnership, mayColdSend } = require('./integrations/automation-ownership');
const { planHumanOutboundIngestion, matchOutbound, latestHumanOutboundAt } = require('./integrations/human-outbound');
// Stage 1 Supabase mirror. Optional and non-blocking: the agent's authoritative
// write is the Google Sheets append above it, and this cannot affect it.
const { mirrorEventsInBackground } = require('./integrations/supabase-mirror');
const { normalizeEmail, buildMappingKey, ACTIVE_STATUSES } = require('./integrations/smartlead-safety');
const { routedLeadReady } = require('./integrations/campaign-routing');
// The reactivation gate is defined once, in the shared pipeline-state model.
const { manualHoldReleased, applyHoldToNotes, stageRequiresHold,
  deriveCallLifecycle, deriveHotState, sendSuppressionReason } = require('./integrations/pipeline-state');
const {
  evaluateStageSequence, buildSequenceEmail, sequenceStepEventId, SEQUENCE_EVENTS,
  resolveSequenceThread, provenSequenceSenderId, automaticEnrollmentDecision,
  automaticEnrollmentEventId,
} = require('./integrations/stage-sequences');
const {
  sequenceRfcMessageId, coldStepRfcMessageId, verifyThreadOwnership, findSuccessfulSequenceSend,
} = require('./integrations/gmail-stage-sequence');
const { wrapSheetsReadClient } = require('./integrations/google-sheets-resilience');
const { stageSendGate } = require('./integrations/pipeline-sequence-safety');
const { PROMOTION_TRIGGER, resolvePromotionIdentity, promotionDecision } = require('./integrations/promotion-policy');
const {
  coldSendAttribution, stageSequenceAttribution, acquisitionAttribution,
  attributionFromActivity, replyTouchAttribution, latestSendAttribution, promotionAttribution,
  LEGACY_UNKNOWN,
} = require('./integrations/campaign-versions');
const { findOriginalSentThread, resolveColdFollowUpThread } = require('./integrations/gmail-threading');
const { oldestDueFirst, followUpSuccessTarget } = require('./integrations/scheduler-fairness');
const { credentialsFor: gmailCredentialsFor, parseRegistry: parseGmailRegistry } = require('./integrations/gmail-inbox-registry');
const {
  configuredSenders, chooseSender, senderCountsToday, successfulSendCountToday,
} = require('./integrations/gmail-sender-routing');
const {
  assembleFinalEmail,
  splitPersonalization,
  dedupePersonalizationBlocks,
  canonicalCta,
  validateFinalEmail,
} = require('./integrations/final-email');
const { buildDentalPersonalization } = require('./integrations/dental-personalization');
const { buildDentalSubject } = require('./integrations/dental-subject');
const {
  COLD_SUBJECTS, coldSubjectIndex, coldSubjectFor, buildDentalColdEmail,
} = require('./integrations/dental-email');
const {
  COLD_CALL_ACTIVITY_SHEET,
  COLD_CALL_ACTIVITY_HEADER,
  COLD_CALL_STAGE_IDS,
} = require('./integrations/cold-call-pipeline');
const {
  DEFAULT_LATE_REPLY_LOOKBACK_DAYS,
  DEFAULT_LATE_REPLY_BATCH_LIMIT,
  selectLateReplyCandidates,
  existingLateReplyEventIds,
  processLateReply,
} = require('./integrations/late-reply');
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
// CHECK_ONLY runs reply/bounce detection with REAL sheet writes, but skips
// every email send. Distinct from DRY_RUN, which also
// skips the writes. Used by the 30-minute cron for near-real-time detection.
const CHECK_ONLY       = process.env.CHECK_ONLY === 'true';
// INTENT_ONLY runs ONLY the both-audios intent pass and exits. Kept separate
// from CHECK_ONLY so the /demo-played route can fire a fast, narrow pass within
// minutes of a play without triggering reply/bounce detection or any outreach.
const INTENT_ONLY      = process.env.INTENT_ONLY === 'true';
// Terminal leads are checked only when the existing check-only scheduler
// explicitly enables this flag for its once-daily window.
const LATE_REPLY_CHECK = process.env.LATE_REPLY_CHECK === 'true';
const LATE_REPLY_LOOKBACK_DAYS = parseInt(process.env.LATE_REPLY_LOOKBACK_DAYS || String(DEFAULT_LATE_REPLY_LOOKBACK_DAYS), 10);
const LATE_REPLY_BATCH_LIMIT = parseInt(process.env.LATE_REPLY_BATCH_LIMIT || String(DEFAULT_LATE_REPLY_BATCH_LIMIT), 10);
// Master kill switch. Fail-safe: sending is OFF unless the env var is the
// literal string 'true' — an absent or mistyped value means no mail leaves.
// Checked immediately before every sendEmail call, not at startup, so a
// mid-run config change can never race past it. Reply/bounce detection is
// unaffected: those passes only ever PREVENT mail.
const SENDING_ENABLED  = process.env.SENDING_ENABLED === 'true';
// Stage-specific recovery journeys (Hot follow-up, no-show, cancelled call,
// demo, timing). SEPARATE from SENDING_ENABLED on purpose: the original cold
// campaign keeps running on its own switch, and this one defaults OFF so the
// engine can ship, be previewed and be tested without a single stage email
// leaving. Both must be true for a stage step to send.
const STAGE_SEQUENCES_ENABLED = process.env.STAGE_SEQUENCES_ENABLED === 'true';
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

// ColdEmail columns A:X — must stay in sync with CE_COLUMNS in server.js
//   A=id  B=company  C=contactName  D=email  E=city  F=tradeType  G=website
//   H=stage  I=emailStatus  J=lastEmailedAt  K=emailStep  L=notes
//   M=reviewCount  N=rating  O=tier  P=siteContext
const COLUMNS = [
  'id','company','contactName','email','city','tradeType','website',
  'stage','emailStatus','lastEmailedAt','emailStep','notes',
  'reviewCount','rating','tier','siteContext','campaign','campaign_notes','enrichment_attempted',
  'leadNiche','senderInboxId','emailTemplateId','routingRequired','intendedCampaignVersion',
];
const AGENT_COLS  = []; // integrated into COLUMNS for ColdEmail
const READ_RANGE  = `${SHEET_NAME}!A:X`;
const CAMPAIGN_INTEGRATIONS_SHEET = 'CampaignIntegrations';
const PROVIDER_LEADS_SHEET = 'ProviderLeadMappings';
let CAMPAIGN_PROVIDERS = new Map();
let ACTIVE_PROVIDER_LEADS = new Set();
let ACTIVE_PROVIDER_EMAILS = new Set();
let EXISTING_PROVIDER_CAMPAIGN_EMAILS = new Set();
const SCRAPE_SKIP = '__scraped__'; // stored in siteContext when site returned no usable text

// Cold Calls (Leads) sheet — used when auto-promoting interested replies
const LEADS_SHEET   = 'Leads';
const LEADS_RANGE   = `${LEADS_SHEET}!A:W`;
const LEADS_COLUMNS = [
  'id','type','first','last','brokerage','tradeType','company',
  'city','cityTrade','phone','email','website',
  'stage','priority','followup','notes','created',
];

let coldCallActivityReady = false;

async function ensureColdCallActivitySheet() {
  if (coldCallActivityReady) return;
  const s = sheets();
  const ss = await s.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const exists = ss.data.sheets.find(sh => sh.properties.title === COLD_CALL_ACTIVITY_SHEET);
  if (!exists) {
    await s.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: COLD_CALL_ACTIVITY_SHEET } } }] },
    });
  }
  await s.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${COLD_CALL_ACTIVITY_SHEET}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [COLD_CALL_ACTIVITY_HEADER] },
  });
  coldCallActivityReady = true;
}

// Activity recording is additive and best-effort. A logging problem must never
// turn a successful Gmail send into a retry or change outbound selection.
async function recordColdCallActivity(record) {
  try {
    await ensureColdCallActivitySheet();
    const complete = { eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), ...record };
    await sheets().spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${COLD_CALL_ACTIVITY_SHEET}!A:J`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [COLD_CALL_ACTIVITY_HEADER.map(key => String(complete[key] ?? ''))] },
    });
    // Shadow mirror, only once the authoritative append succeeded.
    mirrorEventsInBackground([complete]);
  } catch (error) {
    console.warn(`[ColdCallActivity] non-blocking log failure for ${record.email || record.leadId}: ${error.message}`);
  }
}

// How many ColdEmail rows share this address. resolvePromotionIdentity() fails
// closed when an address is ambiguous across twins, but that guard only works
// if it is told the count -- the server passes it, and until now the agent did
// not, so the protection was inert on every automatic promotion path. Counting
// from the lead array the caller already holds keeps it read-free.
function coldEmailTwinCount(allLeads, email) {
  const key = normEmail(email);
  if (!key || !Array.isArray(allLeads)) return 1;
  return allLeads.filter(row => normEmail(row.email) === key).length || 1;
}

async function upsertColdCallLeadFromEvent(lead, stage, note, options = {}) {
  if (!COLD_CALL_STAGE_IDS.has(stage)) return null;
  try {
    const response = await sheets().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: LEADS_RANGE });
    const rows = response.data.values || [];
    const boardLeads = rows.slice(1).map(row => Object.fromEntries(LEADS_COLUMNS.map((field, index) => [field, row[index] || ''])));
    const identity = resolvePromotionIdentity(lead, boardLeads, { coldEmailTwinCount: options.coldEmailTwinCount || 1 });
    const decision = promotionDecision({
      trigger: options.trigger || PROMOTION_TRIGGER.MANUAL, targetStage: stage,
      coldEmailLead: lead, identity, verifiedDemoPair: options.verifiedDemoPair,
      bookingLinkSent: options.bookingLinkSent, meetingAt: options.meetingAt, outcome: options.outcome,
      suppressedEmails: SUPPRESSED_EMAILS,
    });
    if (!decision.shouldPromote) {
      console.warn(`[promotion] ${lead.email} not promoted (${decision.safety}: ${decision.reason})`);
      return null;
    }
    const targetId = `CE-${lead.id}`;
    const existingId = identity.boardLead?.id || '';
    const existingIndex = existingId ? rows.findIndex((row, index) => index > 0 && row[0] === existingId) : -1;
    if (existingIndex >= 1) {
      if (decision.shouldMove) {
        await sheets().spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `${LEADS_SHEET}!M${existingIndex + 1}`,
          valueInputOption: 'RAW',
          requestBody: { values: [[decision.targetStage]] },
        });
      }
      return existingId;
    }

    const parts = String(lead.contactName || '').trim().split(/\s+/).filter(Boolean);
    const promotedLead = {
      id: targetId, type: 'trade', first: parts[0] || '', last: parts.slice(1).join(' '),
      brokerage: '', tradeType: lead.tradeType || 'Dental', company: lead.company || '',
      city: lead.city || '', cityTrade: lead.city || '', phone: '', email: lead.email || '',
      website: lead.website || '', stage: decision.targetStage, priority: decision.targetStage === 'hot' ? 'hot' : 'warm',
      followup: new Date().toISOString().split('T')[0], notes: note || '', created: new Date().toISOString(),
    };
    await sheets().spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID, range: LEADS_RANGE,
      valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [LEADS_COLUMNS.map(col => String(promotedLead[col] ?? ''))] },
    });
    return targetId;
  } catch (error) {
    console.warn(`[ColdCalls] non-blocking automation failure for ${lead.email}: ${error.message}`);
    return null;
  }
}

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

const sheets = () => wrapSheetsReadClient(google.sheets({ version: 'v4', auth: oauth2Client }));
const gmail  = () => google.gmail({ version: 'v1', auth: oauth2Client });
const GMAIL_SENDERS = configuredSenders();
const PRIMARY_GMAIL_SENDER = GMAIL_SENDERS.find(sender => sender.id === 'primary');
const secondaryAuthById = new Map();
function authForSender(sender = PRIMARY_GMAIL_SENDER) {
  if (sender.id === 'primary') { loadToken(); return oauth2Client; }
  if (secondaryAuthById.has(sender.id)) return secondaryAuthById.get(sender.id);
  const entry = parseGmailRegistry().find(item => item.id === sender.id);
  if (!entry) throw new Error(`Gmail sender ${sender.id} is not registered`);
  const auth = new google.auth.OAuth2(process.env.GMAIL_SECONDARY_GOOGLE_CLIENT_ID,
    process.env.GMAIL_SECONDARY_GOOGLE_CLIENT_SECRET, process.env.GMAIL_SECONDARY_GOOGLE_REDIRECT_URI);
  auth.setCredentials(gmailCredentialsFor(entry));
  secondaryAuthById.set(sender.id, auth);
  return auth;
}
const gmailForSender = sender => google.gmail({ version: 'v1', auth: authForSender(sender) });
function senderForPersistedLead(lead) {
  const id = String(lead?.senderInboxId || 'primary').trim() || 'primary';
  const sender = GMAIL_SENDERS.find(item => item.id === id);
  if (!sender?.sendEligible) throw new Error(`persisted sender ${id} is not delivery eligible`);
  return sender;
}

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
    body: (lead) => {
      const link    = buildProposalLink(lead);
      const name    = salutationName(lead);
      const company = cleanCompanyName(lead.company) || 'your business';
      const casl    = `---\n${MAILING_ADDRESS}\nYou're receiving this because your business is publicly listed. Reply "unsubscribe" and I'll remove you immediately.  ·  Ref: SL-${refCode(lead)}`;

      return `Hi ${name},

Just following up on the 24/7 answering and booking software demo I mentioned for ${company} — still happy to build it if you'd like to hear it.

→ Here's a sample so you know what it sounds like: ${link}

No pressure either way — just reply if you'd like yours.

${EMAIL_SIGNATURE}

${casl}`;
    },
  },
  {
    delayDays: 5,
    body: (lead) => {
      const link    = buildProposalLink(lead);
      const name    = salutationName(lead);
      const company = cleanCompanyName(lead.company) || 'your business';
      const casl    = `---\n${MAILING_ADDRESS}\nYou're receiving this because your business is publicly listed. Reply "unsubscribe" and I'll remove you immediately.  ·  Ref: SL-${refCode(lead)}`;

      return `Hi ${name},

Last note from me on this.

If a free 24/7 answering and booking software demo for ${company} isn't useful right now, no worries — I'll leave it here. If it is, here's the sample again: ${link}

Just reply and I'll build yours.

${EMAIL_SIGNATURE}

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
// Dental leads take the structured renderer in integrations/dental-email.js.
// Other niches retain the established opener path below. Both paths insert the
// guarantee verbatim from guarantee.js and pass through validateColdEmail().
function buildPitch(lead, opener, link, structuredPersonalization = null) {
  const type    = recipientType(lead);
  const name    = salutationName(lead);
  const company = cleanCompanyName(lead.company) || '';
  const niche   = nicheFor(lead.tradeType);

  if (structuredPersonalization) {
    return buildDentalColdEmail({
      lead, name, company, recipientType: type, link,
      personalization: structuredPersonalization,
      mailingAddress: MAILING_ADDRESS,
      signature: EMAIL_SIGNATURE,
      reference: `SL-${refCode(lead)}`,
    });
  }

  const offer = guaranteeFor(company);
  const productContext = `24/7 answering and booking software for dental practices that handles missed calls and helps turn them into booked patients. I configure it with ${company}'s actual ${niche.booking} and services, so when a ${niche.person.replace(/s$/, '')} calls it already sounds like it works there. It never touches your real phone line, so there's nothing to switch over to try it.`;
  const casl = `---\n${MAILING_ADDRESS}\nYou're receiving this because your business is publicly listed. Reply with\n"unsubscribe" and I'll remove you immediately — no hard feelings.  ·  Ref: SL-${refCode(lead)}`;
  const personalizationBlocks = dedupePersonalizationBlocks(
    splitPersonalization(opener).map(text => ({ text, sourceField: 'siteContext' })),
    { entityHint: company },
  );
  const demoIncluded = Boolean(link);
  const cta = canonicalCta({ demoIncluded, recipientType: type });
  const demoBlock = demoIncluded
    ? `→ Here's one I already built, so you can hear it:\n${link}`
    : '';
  const bodyBlocks = [
    `Hi ${name},`, offer, ...personalizationBlocks.map(block => block.text),
    productContext, demoBlock, cta, EMAIL_SIGNATURE, casl,
  ];

  return {
    subject: coldSubjectFor(lead, company),
    body: assembleFinalEmail(bodyBlocks),
    cta,
    personalizationBlocks,
    demoIncluded,
    requiredBlocks: [offer, productContext, demoBlock, EMAIL_SIGNATURE, casl],
    personalizationClaims: [],
    verifiedFactIds: [],
    demoCta: null,
    approvedGuarantee: offer,
    personalizationMetadata: null,
  };
}

// Inbound late replies use strict append semantics: if the activity write
// fails, the next daily pass must retry instead of silently losing the event.
// Outbound activity remains best-effort so a logging failure cannot cause a
// successfully sent email to be retried.
async function recordColdCallActivityStrict(record) {
  await ensureColdCallActivitySheet();
  const complete = { eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), ...record };
  await sheets().spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${COLD_CALL_ACTIVITY_SHEET}!A:J`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [COLD_CALL_ACTIVITY_HEADER.map(key => String(complete[key] ?? ''))] },
  });
  // Shadow mirror. This function is deliberately strict — its callers depend on
  // a send being recorded — so the mirror stays fire-and-forget and cannot turn
  // a durable Sheets append into a thrown error.
  mirrorEventsInBackground([complete]);
}

/**
 * The Sales Pipeline board, read once per pass.
 *
 * The send pass used to know only about ColdEmail rows, which is why ownership
 * could say "this lead is promoted, do not touch it" while the sender had no
 * way to see the pipeline at all. One read, then bounded lookup maps — never a
 * per-candidate fetch.
 */
async function readBoardLeads(rowsOverride = null) {
  try {
    const rows = rowsOverride || (await sheets().spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID, range: LEADS_RANGE,
    })).data.values || [];
    const header = ['id', 'type', 'first', 'last', 'brokerage', 'tradeType', 'company',
      'city', 'cityTrade', 'phone', 'email', 'website', 'stage', 'priority', 'followup',
      'notes', 'created', 'emailStatus', 'lastEmailedAt', 'emailStep',
      'meetingAt', 'outcome', 'conversationContext'];
    return rows.slice(1).map(row => {
      const lead = {};
      header.forEach((key, index) => { lead[key] = row[index] || ''; });
      return lead;
    }).filter(lead => lead.id);
  } catch (error) {
    // Fail CLOSED: if the board cannot be read we must not assume no lead is
    // promoted. The caller treats a null board as "context unavailable".
    console.warn(`[board] could not read the Sales Pipeline (${error.message}) — failing closed`);
    return null;
  }
}

/**
 * One pass, one set of reads, bounded maps. Everything the ownership model
 * needs about a candidate, without a single per-lead fetch.
 */
function buildOwnershipContext({ boardLeads, activities, outboundObservationOk = true }) {
  const activitiesByLead = new Map();
  for (const row of activities || []) {
    const key = String(row.sourceLeadId || '').trim()
      || String(row.leadId || '').replace(/^CE-/, '').trim();
    if (!key) continue;
    const bucket = activitiesByLead.get(key) || [];
    bucket.push(row);
    activitiesByLead.set(key, bucket);
  }
  const boardByLead = new Map();
  const boardByEmail = new Map();
  for (const board of boardLeads || []) {
    const direct = String(board.id || '').replace(/^CE-/, '');
    if (String(board.id || '').startsWith('CE-')) boardByLead.set(direct, board);
    const email = String(board.email || '').trim().toLowerCase();
    if (email && !boardByEmail.has(email)) boardByEmail.set(email, board);
  }
  return {
    activitiesByLead, boardByLead, boardByEmail,
    // Explicit: a failed board read must not read as "nothing is promoted".
    boardAvailable: Array.isArray(boardLeads),
    // Explicit: a failed mailbox read must not read as "nobody has replied".
    outboundObservationOk: outboundObservationOk !== false,
  };
}

async function readColdCallActivities(rowsOverride = null) {
  const rows = rowsOverride || (await sheets().spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${COLD_CALL_ACTIVITY_SHEET}!A:J`,
  })).data.values || [];
  return rows.slice(1).map(row => {
    const record = {};
    COLD_CALL_ACTIVITY_HEADER.forEach((field, index) => { record[field] = row[index] || ''; });
    return record;
  });
}

// ── PRE-SEND VALIDATION FOR COLD EMAIL ────────────────────────────────────────
// The guarantee is a commercial promise, so an unresolved merge
// field is not a cosmetic bug — an altered pay-per-booking promise or a literal
// merge artifact would be sent as a contractual claim. Every one of these routes
// to a DRAFT rather than blocking the run, so the lead is preserved for review.
//
// Returns null when the email is safe to send, or a string reason when it is not.
function validateColdEmail(lead, subject, body, link, assembly = {}) {
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

  const finalValidation = validateFinalEmail({
    subject, body, demoUrl: link, proposalBase: PROPOSAL_BASE,
    demoIncluded: assembly.demoIncluded !== false,
    cta: assembly.cta || '', personalizationBlocks: assembly.personalizationBlocks || [],
    entityHint: company, requiredBlocks: assembly.requiredBlocks || [],
    personalizationClaims: assembly.personalizationClaims || [],
    verifiedFactIds: assembly.verifiedFactIds || [], demoCta: assembly.demoCta || null,
    approvedGuarantee: assembly.approvedGuarantee || guaranteeFor(company),
    subjectValidation: assembly.subjectMetadata?.validation || null,
  });
  if (!finalValidation.valid) {
    return finalValidation.errors.map(error => `${error.code}: ${error.message}`).join('; ');
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
  // Checked against the CONFIGURED link, not a provider name: the old
  // /calendly\.com/ test would have silently stopped guarding anything the
  // moment the booking link moved to Google Calendar.
  if (containsBookingLink(body)) return 'cold email contains the warm-only booking link';
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
  const isDental = nicheFor(lead.tradeType).key === 'dental';
  const structuredPersonalization = isDental
    ? buildDentalPersonalization({ ...lead, company }, { siteText })
    : null;
  const opener = structuredPersonalization
    ? structuredPersonalization.personalizationBlocks.join('\n\n')
    : await generateOpener(lead, siteText) || `I noticed ${company} and wanted to reach out.`;

  const pitchTier = lead.tier === 'busy' ? 'busy' : 'medium';
  const link      = buildProposalLink(lead);

  const assembled = buildPitch(lead, opener, link, structuredPersonalization);
  const { subject, body } = assembled;

  return { ...assembled, subject, body, link, opener, openerTier, pitchTier };
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
function toRawMessage({ to, subject, body, inReplyTo, references, messageId, fromEmail = FROM_EMAIL }) {
  const headers = [
    `From: ${FROM_NAME} <${fromEmail}>`,
    `To: ${to}`,
    `Subject: ${encodeHeaderValue(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
  ];
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);
  if (messageId) headers.push(`Message-ID: ${messageId}`);
  const msg = headers.join('\r\n') + '\r\n\r\n' + body;
  return Buffer.from(msg)
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sendEmail({ to, subject, body, threadId, inReplyTo, references, messageId, sender = PRIMARY_GMAIL_SENDER }) {
  if (!sender?.sendEligible) throw new Error(`Gmail sender ${sender?.id || 'unknown'} is not delivery eligible`);
  const provider = new GmailOutreachProvider({ send: message => gmailForSender(sender).users.messages.send({
    userId: 'me',
    requestBody: { raw: toRawMessage({ ...message, fromEmail: sender.email }), ...(message.threadId ? { threadId: message.threadId } : {}) },
  }) });
  return provider.sendEmail({ to, subject, body, threadId, inReplyTo, references, messageId });
}

async function loadOutreachProviderState(campaignRowsOverride = null, mappingRowsOverride = null) {
  CAMPAIGN_PROVIDERS = new Map();
  ACTIVE_PROVIDER_LEADS = new Set();
  ACTIVE_PROVIDER_EMAILS = new Set();
  EXISTING_PROVIDER_CAMPAIGN_EMAILS = new Set();
  try {
    const campaignRows = campaignRowsOverride || (await sheets().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${CAMPAIGN_INTEGRATIONS_SHEET}!A:I` })).data.values || [];
    for (const row of campaignRows.slice(1)) CAMPAIGN_PROVIDERS.set(row[0], { provider: row[1] || 'gmail', externalCampaignId: row[2] || '' });
  } catch (e) {
    console.warn(`[Providers] no campaign mappings (${e.message}) — existing Gmail behavior retained`);
  }
  try {
    const mappingRows = mappingRowsOverride || (await sheets().spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${PROVIDER_LEADS_SHEET}!A:N` })).data.values || [];
    for (const row of mappingRows.slice(1)) {
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
async function stepOneAlreadySent(lead, sender = PRIMARY_GMAIL_SENDER) {
  try {
    const safeEmail = lead.email.trim().replace(/^[^a-zA-Z0-9]+/, '');
    if (!safeEmail || !safeEmail.includes('@')) return 'unverifiable';
    const resp = await gmailForSender(sender).users.messages.list({
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
// Fails CLOSED — an API error is a distinct result, never "no reply".
async function getReplyMessage(lead) {
  if (!lead.lastEmailedAt || !isValidEmail(lead.email)) return null;
  try {
    const afterMs   = new Date(lead.lastEmailedAt).getTime();
    const afterSec  = Math.floor(afterMs / 1000);
    const safeEmail = lead.email.trim().replace(/^[^a-zA-Z0-9]+/, '');
    if (!safeEmail || !safeEmail.includes('@')) return null;

    const sender = senderForPersistedLead(lead);
    const mailbox = gmailForSender(sender);
    const candidates = new Map();   // message id → full message resource

    // ── Net 1: thread of our most recent sent message to this address ──
    const sentResp = await mailbox.users.messages.list({
      userId: 'me',
      q: `in:sent to:"${safeEmail}"`,
      maxResults: 1,
    });
    const sent = sentResp.data.messages || [];
    if (sent.length) {
      const sentMsg  = await mailbox.users.messages.get({ userId: 'me', id: sent[0].id, format: 'minimal' });
      const threadId = sentMsg.data.threadId;
      if (threadId) {
        const thread = await mailbox.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
        for (const m of thread.data.messages || []) candidates.set(m.id, m);
      }
    }

    // ── Net 2: anything the contacted address sent us after our last send ──
    const directResp = await mailbox.users.messages.list({
      userId: 'me',
      q: `from:"${safeEmail}" after:${afterSec}`,
      maxResults: 5,
      includeSpamTrash: true,
    });
    for (const stub of directResp.data.messages || []) {
      if (candidates.has(stub.id)) continue;
      const full = await mailbox.users.messages.get({ userId: 'me', id: stub.id, format: 'full' });
      candidates.set(stub.id, full.data);
    }

    if (!candidates.size) return null;

    // ── Shared inbound filter over the union; newest wins ──
    const ourAddr = sender.email;
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
    return {
      messageId: best.msg.id, rfcMessageId, threadId: best.msg.threadId || '', snippet, body,
      subject: headerValue(best.msg.payload, 'Subject'),
      fromAddr: best.fromAddr, occurredAt: new Date(best.ms).toISOString(),
      senderInboxId: sender.id,
    };
  } catch (e) {
    console.warn(`[ReplyCheck] API error for ${lead.email}: ${e.message}`);
    return {
      observationFailed: true,
      senderInboxId: String(lead.senderInboxId || 'primary').trim() || 'primary',
      error: e.message,
    };
  }
}

// Terminal polling is intentionally narrower than active polling: it opens a
// known Gmail thread from recorded outbound activity and never searches the
// mailbox. This makes one bounded thread request per eligible lead.
async function getLateReplyMessages(lead, outbound) {
  if (!lead.lastEmailedAt || !outbound?.threadId || !outbound?.messageId) return [];
  try {
    const afterMs = new Date(lead.lastEmailedAt).getTime();
    if (!Number.isFinite(afterMs)) return [];
    const thread = await gmail().users.threads.get({
      userId: 'me', id: outbound.threadId, format: 'full',
    });
    const ourAddr = (FROM_EMAIL || '').trim().toLowerCase();
    return (thread.data.messages || [])
      .map(m => ({ m, ms: parseInt(m.internalDate || '0', 10) }))
      .filter(({ m, ms }) => {
        if (ms <= afterMs || (m.labelIds || []).includes('SENT')) return false;
        const fromAddr = parseAddr(headerValue(m.payload, 'From'));
        return fromAddr && (!ourAddr || fromAddr !== ourAddr) && !DAEMON_FROM.test(fromAddr);
      })
      .sort((a, b) => a.ms - b.ms)
      .map(({ m, ms }) => ({
        messageId: m.id,
        rfcMessageId: headerValue(m.payload, 'Message-ID'),
        threadId: m.threadId || outbound.threadId,
        subject: headerValue(m.payload, 'Subject'),
        snippet: m.snippet || '',
        body: extractPlainText(m.payload).trim().slice(0, 1500),
        fromAddr: parseAddr(headerValue(m.payload, 'From')),
        occurredAt: new Date(ms).toISOString(),
      }));
  } catch (error) {
    console.warn(`[LateReply] thread read failed for ${lead.email}: ${error.message}`);
    return [];
  }
}

const REPLY_CATEGORIES = new Set(['QUESTION','INTERESTED','MEETING_REQUEST','NOT_INTERESTED','UNSUBSCRIBE','OUT_OF_OFFICE','WRONG_PERSON','NEEDS_HUMAN']);

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
        'You draft short replies on behalf of Deins, who sells 24/7 answering and booking software to dental clinics.',
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

async function readLeads(rowsOverride = null) {
  const rows = rowsOverride || (await sheets().spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: READ_RANGE,
  })).data.values || [];
  return rows.slice(1).map((row, idx) => {
    const lead = { _row: idx + 2 };              // 1-based sheet row (after header)
    COLUMNS.forEach((c, i) => { lead[c] = row[i] || ''; });
    lead.first = (lead.contactName || '').split(' ')[0] || ''; // convenience alias used by templates
    return lead;
  }).filter(l => l.id);
}

// A scheduled process used to issue one values.get per tab (and then re-read
// several of them in later passes). Google charges those parallel requests
// separately. This immutable cycle snapshot costs one read request and is
// shared by observation, ownership, intent, Pipeline recovery and cold cadence.
async function loadAgentSnapshot() {
  const ranges = [
    READ_RANGE, LEADS_RANGE, `${COLD_CALL_ACTIVITY_SHEET}!A:J`,
    `${SUPPRESSION_SHEET}!A:E`, `${CAMPAIGN_INTEGRATIONS_SHEET}!A:I`,
    `${PROVIDER_LEADS_SHEET}!A:N`, 'DemoPlays!A:F', `${INTENT_SHEET}!A:E`,
  ];
  const response = await sheets().spreadsheets.values.batchGet({
    spreadsheetId: SPREADSHEET_ID, ranges,
  });
  const rows = index => response.data.valueRanges?.[index]?.values || [];
  console.log(`[Sheets snapshot] ${ranges.length} datasets loaded in 1 batch read`);
  return {
    coldEmail: rows(0), board: rows(1), activityRows: rows(2),
    suppression: rows(3), campaigns: rows(4), providerMappings: rows(5),
    demoPlays: rows(6), intentFired: rows(7),
  };
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

// Append-only record of a real outbound send. Step 1 is the cold email itself;
// later steps are sequence follow-ups and are typed distinctly so that
// initial_email_sent keeps meaning exactly one thing (lead scoring and the
// demo-trigger backfill both rely on that).
//
// eventId is derived from the Gmail message id when we have one, so a duplicate
// row is detectable rather than anonymous. No credentials, tokens or provider
// internals are stored — only ids the dashboard already displays.
async function recordSendActivity(lead, step, sendMeta, sentAt) {
  const result    = (sendMeta && sendMeta.result) || null;
  const data      = result?.data || result || {};
  const messageId = data.id || data.providerMessageId || '';
  const threadId  = data.threadId || '';
  const isInitial = Number(step) === 1;
  // Callers build this before provider delivery. Unknown/missing active
  // versions therefore fail before send rather than silently becoming legacy.
  const attribution = sendMeta && sendMeta.attribution;
  const senderInboxId = String(sendMeta?.sender?.id || lead.senderInboxId || 'primary').trim();
  if (!attribution || !attribution.campaignVersion) throw new Error('successful send is missing campaign attribution');
  if (!senderInboxId) throw new Error('successful send is missing sender attribution');
  const activity = {
    eventId: messageId ? `gmail:${messageId}` : `${lead.id}:step${step}:${sentAt}`,
    leadId: `CE-${lead.id}`,
    sourceLeadId: lead.id,
    email: lead.email || '',
    company: cleanCompanyName(lead.company) || lead.company || '',
    eventType: isInitial ? 'initial_email_sent' : 'follow_up_sent',
    occurredAt: sentAt,
    subject: String((sendMeta && sendMeta.subject) || '').slice(0, 500),
    content: String((sendMeta && sendMeta.body) || ''),
    metadata: JSON.stringify({
      step: Number(step), trigger: isInitial ? 'cold_sequence_step_1' : 'cold_sequence_follow_up',
      gmailMessageId: messageId, gmailThreadId: threadId,
      provider: 'gmail', providerMessageId: messageId, senderInboxId,
      templateId: lead.emailTemplateId || '', campaign: lead.campaign || '',
      personalization: (sendMeta && sendMeta.personalizationMetadata) || null,
      ...attribution,
    }),
  };
  const activities = sendMeta?.activitiesForCycle;
  if (activities?.some(row => row.eventId === activity.eventId)) return activity;
  await recordColdCallActivityStrict(activity);
  if (activities) activities.push(activity);
  return activity;
}

// sendMeta is the Gmail API response from sendEmail() — passed in by the send
// loops purely so the activity row can carry the real message/thread id. It is
// optional: markSent's existing behaviour is unchanged when it is absent.

// Write stage (H) + agent columns (I:K) for one row, leaving the rest untouched.
// Sets emailStatus='done' when the last step in the sequence has been sent —
// and, on that same last step, writes stage='Done' too (H), matching what
// handleNotInterested and runBounceCheckPass already do for their own terminal
// paths. Non-final steps keep writing SENT_STAGE, unchanged. This only affects
// the display label: emailStatus is what every selector actually gates on
// (selectQueued/selectFollowUps — neither keys off
// stage='Contacted'), so this cannot change what gets sent.
//
// The email is ALREADY SENT when this runs — a failed write here is the
// "sent but unrecorded" state that re-sends on the next run. So the whole
// write (including row resolution) retries with exponential backoff, and a
// final failure alarms loudly instead of throwing: the caller's catch would
// log "Failed", which is false — the send succeeded.
async function markSent(lead, step, sendMeta = null) {
  const now = sendMeta?.occurredAt || new Date().toISOString();
  const isLastStep = step > FOLLOW_UP_SEQUENCE.length;
  const status = isLastStep ? 'done' : 'emailed';
  const stageValue = isLastStep ? 'Done' : SENT_STAGE;
  const retryDelays = [5000, 15000, 40000];
  const maxAttempts = retryDelays.length + 1;
  let activityRecorded = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Provider evidence is durable before mutable lead state advances. If
      // the state write fails, the next run recovers by deterministic Gmail id.
      if (!activityRecorded) {
        await recordSendActivity(lead, step, sendMeta, now);
        activityRecorded = true;
      }
      const rowNum = await resolveRow(lead.id);
      if (!rowNum) {
        console.warn(`[markSent] lead ${lead.id} (${lead.email}) no longer in sheet — row deleted mid-run? Skipping write.`);
        return { recorded: activityRecorded, rowMissing: true };
      }
      await sheets().spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          valueInputOption: 'RAW',
          data: [
            { range: `${SHEET_NAME}!H${rowNum}`, values: [[stageValue]] },
            { range: `${SHEET_NAME}!I${rowNum}:K${rowNum}`, values: [[status, now, String(step)]] },
            ...(sendMeta?.sender?.id ? [{ range: `${SHEET_NAME}!U${rowNum}`, values: [[sendMeta.sender.id]] }] : []),
          ],
        },
      });
      lead.stage = stageValue;
      lead.emailStatus = status;
      lead.lastEmailedAt = now;
      lead.emailStep = String(step);
      if (sendMeta?.sender?.id) lead.senderInboxId = sendMeta.sender.id;
      return { recorded: true };
    } catch (error) {
      if (attempt < maxAttempts) {
        const delay = retryDelays[attempt - 1];
        console.warn(`[markSent] attempt ${attempt}/${maxAttempts} failed for ${lead.email}: ${error.message} — retrying in ${delay / 1000}s`);
        await sleep(delay);
      } else {
        console.error(`‼️ [UNRECORDED SEND] step ${step} to ${lead.email} (${lead.id}) WAS SENT but could not be recorded after ${maxAttempts} attempts: ${error.message}`);
        console.error('‼️ [UNRECORDED SEND] deterministic Gmail evidence will be recovered next run; this step will not be re-sent.');
        return { recorded: false, error };
      }
    }
  }
}

async function deliverOrdinaryColdStep({
  lead, step, sender, subject, body, attribution, activitiesForCycle,
  personalizationMetadata = null, thread = null,
}) {
  const mailbox = gmailForSender(sender);
  const rfcMessageId = coldStepRfcMessageId(lead.id, step, sender.email);
  const metadataOf = row => { try { return JSON.parse(row.metadata || '{}'); } catch (_) { return {}; } };

  // Provider-first recovery: this runs before the legacy recipient probe, so a
  // successful deterministic send with a failed Sheets checkpoint is repaired
  // instead of merely skipped.
  let recovered;
  try {
    recovered = await findSuccessfulSequenceSend({ gmail: mailbox, rfcMessageId });
  } catch (error) {
    return { delivered: false, reason: `idempotency probe failed: ${error.message}` };
  }
  if (recovered) {
    const checkpoint = await markSent(lead, step, {
      result: recovered, subject, body, attribution, sender, personalizationMetadata,
      occurredAt: recovered.occurredAt || new Date().toISOString(), activitiesForCycle,
    });
    console.warn(`[Cold recovery] restored step ${step} for ${lead.email} from Gmail; no duplicate sent`);
    return { delivered: true, recovered: true, checkpoint };
  }

  // Backward-compatible protection for step 1 messages sent before deterministic
  // Message-IDs existed. Exact historical repair is handled by reconciliation;
  // runtime safety still refuses to send a possible duplicate.
  if (Number(step) === 1) {
    const legacyProbe = await stepOneAlreadySent(lead, sender);
    if (legacyProbe !== 'clear') {
      return { delivered: false, reason: legacyProbe === 'found'
        ? 'a prior step-1 send exists in Gmail and needs reconciliation'
        : 'prior step-1 delivery could not be verified' };
    }
  }

  const reservations = (activitiesForCycle || []).filter(row =>
    row.eventType === 'ordinary_send_reserved'
    && metadataOf(row).leadId === lead.id && Number(metadataOf(row).step) === Number(step));
  const failed = new Set((activitiesForCycle || []).filter(row => row.eventType === 'ordinary_send_failed')
    .map(row => metadataOf(row).reservationEventId).filter(Boolean));
  if (reservations.some(row => !failed.has(row.eventId))) {
    return { delivered: false, reason: 'an unresolved delivery reservation exists and Gmail has not confirmed it' };
  }

  const reservationEventId = `cold-reserve:${lead.id}:step${step}:attempt${reservations.length + 1}`;
  const reservation = {
    eventId: reservationEventId, leadId: `CE-${lead.id}`, sourceLeadId: lead.id,
    email: lead.email, company: cleanCompanyName(lead.company) || lead.company || '',
    eventType: 'ordinary_send_reserved', occurredAt: new Date().toISOString(),
    subject, content: '', metadata: JSON.stringify({
      leadId: lead.id, step: Number(step), senderInboxId: sender.id,
      rfcMessageId, gmailThreadId: thread?.threadId || '',
    }),
  };
  try {
    await recordColdCallActivityStrict(reservation);
    activitiesForCycle?.push(reservation);
  } catch (error) {
    return { delivered: false, reason: `delivery reservation could not be persisted: ${error.message}` };
  }

  let result;
  try {
    result = await sendEmail({
      to: lead.email.trim(), subject, body, sender, messageId: rfcMessageId,
      ...(thread ? { threadId: thread.threadId, inReplyTo: thread.inReplyTo, references: thread.references } : {}),
    });
  } catch (error) {
    const status = Number(error?.response?.status || error?.code);
    const rejectedBeforeDelivery = status >= 400 && status < 500 && ![408, 409, 429].includes(status);
    if (rejectedBeforeDelivery) {
      const failure = {
        eventId: `${reservationEventId}:failed`, leadId: `CE-${lead.id}`, sourceLeadId: lead.id,
        email: lead.email, company: cleanCompanyName(lead.company) || lead.company || '',
        eventType: 'ordinary_send_failed', occurredAt: new Date().toISOString(), subject, content: '',
        metadata: JSON.stringify({ leadId: lead.id, step: Number(step), reservationEventId,
          senderInboxId: sender.id, error: String(error.message || '').slice(0, 300) }),
      };
      try { await recordColdCallActivityStrict(failure); activitiesForCycle?.push(failure); } catch (_) { /* reservation remains fail-closed */ }
    }
    return { delivered: false, reason: rejectedBeforeDelivery
      ? `provider rejected before delivery: ${error.message}`
      : `delivery outcome is ambiguous; reservation retained: ${error.message}` };
  }

  const checkpoint = await markSent(lead, step, {
    result, subject, body, attribution, sender, personalizationMetadata, activitiesForCycle,
  });
  return { delivered: true, recovered: false, result, checkpoint };
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
async function handleInterested(lead, message = {}, replyText = '', eventType = 'positive_reply', allLeads = null, activities = []) {
  if ((lead.notes || '').includes(TAG_INTERESTED)) {
    console.log(`  ↺ ${lead.company} — already tagged Interested, skipping`);
    return;
  }
  const rowNum = await resolveRow(lead.id);
  if (!rowNum) {
    console.warn(`[handleInterested] lead ${lead.id} (${lead.email}) no longer in sheet — skipping write.`);
    return;
  }
  const interestedNotes = applyHoldToNotes(prependNote(lead.notes, TAG_INTERESTED));
  lead.notes = interestedNotes;
  await sheets().spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        { range: `${SHEET_NAME}!H${rowNum}`, values: [['Replied']] },
        { range: `${SHEET_NAME}!I${rowNum}`, values: [['replied']] },
        { range: `${SHEET_NAME}!L${rowNum}`, values: [[interestedNotes]] },
      ],
    },
  });
  const coldCallLeadId = await upsertColdCallLeadFromEvent(
    lead, 'hot',
    `Auto-promoted from cold email outreach. Reply classified: ${eventType === 'meeting_requested' ? 'Meeting requested' : 'Interested'}.`,
    { trigger: PROMOTION_TRIGGER.POSITIVE_REPLY, coldEmailTwinCount: coldEmailTwinCount(allLeads, lead.email) },
  );
  const touch = replyTouchAttribution({ occurredAt: message.occurredAt, threadId: message.threadId }, activities);
  await recordColdCallActivity({
    eventId: message.messageId ? `gmail-reply:${message.messageId}` : `${lead.id}:reply:${message.occurredAt || Date.now()}`,
    leadId: coldCallLeadId || `CE-${lead.id}`, sourceLeadId: lead.id,
    email: lead.email, company: cleanCompanyName(lead.company) || lead.company || '',
    eventType, occurredAt: message.occurredAt || new Date().toISOString(),
    subject: '', content: replyText || message.snippet || '',
    metadata: JSON.stringify({
      from: message.fromAddr || lead.email,
      classification: eventType === 'meeting_requested' ? 'MEETING_REQUEST' : 'INTERESTED',
      gmailMessageId: message.messageId || '', gmailThreadId: message.threadId || '',
      rfcMessageId: message.rfcMessageId || '', detectedAfterSequence: false,
      replyTouch: touch,
    }),
  });
  await recordColdCallActivity({
    eventId: `promotion:${message.messageId || `${lead.id}:${message.occurredAt || 'reply'}`}:hot`,
    leadId: coldCallLeadId || `CE-${lead.id}`, sourceLeadId: lead.id,
    email: lead.email, company: cleanCompanyName(lead.company) || lead.company || '',
    eventType: 'pipeline_promoted', occurredAt: message.occurredAt || new Date().toISOString(),
    subject: 'Promoted to Hot — positive reply', content: '',
    metadata: JSON.stringify({ fromStage: '', toStage: 'hot', trigger: 'positive_reply', sourceEventId: message.messageId ? `gmail-reply:${message.messageId}` : '', ...promotionAttribution(touch) }),
  });
  console.log(`  🔥 Auto-promoted ${lead.company} to Cold Calls kanban`);
}

const ACTIVE_REPLY_EVENT_TYPES = Object.freeze({
  QUESTION: 'question_reply', NOT_INTERESTED: 'negative_reply', UNSUBSCRIBE: 'unsubscribe_reply',
  WRONG_PERSON: 'wrong_person_reply', OUT_OF_OFFICE: 'out_of_office_reply', NEEDS_HUMAN: 'needs_human_reply',
});

// The legacy category the send path routes on, mapped to the canonical state
// analytics reads. Both are stored on every event, so a later change to either
// vocabulary can still be traced back to what was actually observed.
const LEGACY_TO_CANONICAL_STATE = Object.freeze({
  INTERESTED: REPLY_STATE.POSITIVE, MEETING_REQUEST: REPLY_STATE.POSITIVE,
  NOT_INTERESTED: REPLY_STATE.NEGATIVE, UNSUBSCRIBE: REPLY_STATE.NEGATIVE,
  QUESTION: REPLY_STATE.NEEDS_HUMAN, NEEDS_HUMAN: REPLY_STATE.NEEDS_HUMAN,
  WRONG_PERSON: REPLY_STATE.NEEDS_HUMAN, OUT_OF_OFFICE: REPLY_STATE.AUTOMATED_REPLY,
});

async function recordActiveReplyActivity(lead, message, replyText, classification, activities = []) {
  const eventType = ACTIVE_REPLY_EVENT_TYPES[classification];
  if (!eventType) return; // positive/meeting replies are logged by handleInterested after promotion
  // Fail closed on identity: a malformed address cannot have received our mail,
  // so anything "matched" through it would be manufactured evidence.
  if (!isUsableReplyIdentity(lead.email)) {
    console.warn(`[reply] refusing to record reply for malformed identity ${lead.email}`);
    return;
  }
  // Idempotency. recordColdCallActivity appends unconditionally, so a stable
  // event id prevents nothing on its own — the duplicate has to be caught here,
  // against the activities already loaded for this pass. Keyed on the Gmail
  // message id, so reprocessing the same inbound message is a no-op no matter
  // how many times the reply scan sees it.
  const eventId = message.messageId
    ? `gmail-reply:${message.messageId}`
    : `${lead.id}:reply:${message.occurredAt || Date.now()}`;
  if (activities.some(row => String(row.eventId || '') === eventId)) {
    return; // already recorded
  }
  const touch = replyTouchAttribution({ occurredAt: message.occurredAt, threadId: message.threadId }, activities);
  // Re-derive the canonical meaning from the message text, so the stored event
  // carries evidence rather than only a category label.
  const canonical = classifyReplyText(String(replyText || message.snippet || ''), {
    subject: message.subject || '', currentEmail: lead.email,
  });
  await recordColdCallActivity({
    eventId,
    leadId: `CE-${lead.id}`, sourceLeadId: lead.id, email: lead.email,
    company: cleanCompanyName(lead.company) || lead.company || '', eventType,
    occurredAt: message.occurredAt || new Date().toISOString(), subject: message.subject || '',
    content: String(replyText || message.snippet || '').slice(0, 1500),
    metadata: JSON.stringify({
      classification, from: message.fromAddr || lead.email,
      gmailMessageId: message.messageId || '', gmailThreadId: message.threadId || '',
      rfcMessageId: message.rfcMessageId || '', detectedAfterSequence: false,
      requiresHumanAttention: ['QUESTION', 'WRONG_PERSON', 'NEEDS_HUMAN'].includes(classification),
      replyTouch: touch,
      // ── canonical reply evidence ──────────────────────────────────────────
      // Stored so analytics never re-reads Gmail, and so a reply's meaning is
      // provable from the event itself rather than reconstructed from a notes
      // tag years later.
      provider: 'gmail',
      matchedColdEmailId: lead.id,
      receivedAt: message.occurredAt || new Date().toISOString(),
      canonicalState: canonical.state || LEGACY_TO_CANONICAL_STATE[classification] || null,
      subtype: canonical.subtype || null,
      reason: canonical.reason || null,
      classifierVersion: canonical.classifierVersion || null,
      confidence: canonical.confidence || null,
      evidenceSignals: canonical.signals || [],
      genuineHuman: canonical.genuineHuman === undefined ? null : canonical.genuineHuman,
      returnDate: canonical.returnDate || null,
      // Evidence only. Nothing may act on this without a human approving it.
      proposedEmail: canonical.proposedEmail || null,
      identityMutationAllowed: false,
    }),
  });
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
async function handleQuestion(lead, replyText, todaySent, activities = [], outboundObservationOk = true, sender = senderForPersistedLead(lead)) {
  const rowNum = await resolveRow(lead.id);
  const answer = await answerQuestion(lead, replyText);

  // ── gates that apply to auto-send only ──
  // A drafted reply is never sent by the agent, so it needs no send gate; a
  // human reviews and sends it, at which point these no longer apply.
  let mode = answer.mode;
  let gateReason = '';
  if (mode === 'auto') {
    const humanTouchAt = latestHumanOutboundAt(activities);
    const suppressed = suppressionReason(lead);
    if (!outboundObservationOk) {
      mode = 'draft';
      gateReason = 'manual outbound observation failed, so mailbox state may be stale';
      answer.reason = `${answer.reason} — held: ${gateReason}`;
    } else if (humanTouchAt) {
      mode = 'draft';
      gateReason = `a human response was already observed at ${humanTouchAt}`;
      answer.reason = `${answer.reason} — held: ${gateReason}`;
    } else if (suppressed) {
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
  const attribution = stageSequenceAttribution({
    acquisition: latestSendAttribution(activities), sequenceId: 'question_auto_answer_v1', step: 1,
  });
  const result = await sendEmail({ to: lead.email.trim(), subject, body, sender });
  const sentAt = new Date().toISOString();
  await recordColdCallActivity({
    eventId: result?.data?.id ? `gmail:${result.data.id}` : `${lead.id}:question-auto-answer:${sentAt}`,
    leadId: `CE-${lead.id}`, sourceLeadId: lead.id, email: lead.email,
    company: cleanCompanyName(lead.company) || lead.company || '', eventType: 'follow_up_sent',
    occurredAt: sentAt, subject, content: body,
    metadata: JSON.stringify({
      gmailMessageId: result?.data?.id || '', gmailThreadId: result?.data?.threadId || '',
      provider: 'gmail', providerMessageId: result?.data?.id || '', senderInboxId: sender.id,
      trigger: 'question_auto_answer', ...attribution,
    }),
  });
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

async function handleRoofingSurveyReply(lead, message, replyText, todaySent, activities = [], outboundObservationOk = true) {
  const sender = GMAIL_SENDERS.find(item => item.id === String(message.senderInboxId || lead.senderInboxId || 'primary')) || PRIMARY_GMAIL_SENDER;
  if (!ROOFING_SURVEY_REPLY_FLOW_ENABLED) {
    await handleNeedsHuman(lead, message.fromAddr);
    return 'flow_disabled';
  }
  const classification = await classifyRoofingReply({ replyText, createMessage: anthropicClient ? input => anthropicClient.messages.create(input) : null });
  console.log(`  [roofing-reply] profile=${ROOFING_SURVEY_PROFILE} classification=${classification.category} reason=${classification.reason_code}`);
  const roofingEventType = classification.category === 'positive' ? 'positive_reply'
    : classification.category === 'negative' ? 'negative_reply'
      : classification.category === 'unsubscribe' ? 'unsubscribe_reply'
        : classification.category === 'wrong_person' ? 'wrong_person_reply'
          : ['out_of_office', 'automated'].includes(classification.category) ? 'out_of_office_reply'
            : 'needs_human_reply';
  await recordColdCallActivity({
    eventId: message.messageId ? `gmail-reply:${message.messageId}` : `${lead.id}:reply:${message.occurredAt || Date.now()}`,
    leadId: `CE-${lead.id}`, sourceLeadId: lead.id, email: lead.email,
    company: cleanCompanyName(lead.company) || lead.company || '', eventType: roofingEventType,
    occurredAt: message.occurredAt || new Date().toISOString(), subject: message.subject || '',
    content: String(replyText || message.snippet || '').slice(0, 1500),
    metadata: JSON.stringify({
      classification: classification.category, reasonCode: classification.reason_code,
      campaignProfile: ROOFING_SURVEY_PROFILE, gmailMessageId: message.messageId || '',
      gmailThreadId: message.threadId || '', rfcMessageId: message.rfcMessageId || '', detectedAfterSequence: false,
      provider: 'gmail', senderInboxId: sender.id,
      requiresHumanAttention: classification.requires_human_review === true,
    }),
  });
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
    const humanTouchAt = latestHumanOutboundAt(activities);
    const blocked = (!outboundObservationOk && 'manual outbound observation failed, so mailbox state may be stale')
      || (humanTouchAt && `a human response was already observed at ${humanTouchAt}`)
      || suppressionReason(lead) || (!SENDING_ENABLED && 'sending disabled') || (todaySent >= DAILY_SEND_LIMIT && 'daily limit reached');
    if (blocked) {
      await queueDraft(lead, { body, confidence: classification.confidence, reason: `roofing survey auto-reply blocked: ${blocked}`, campaignProfile: ROOFING_SURVEY_PROFILE, classification: classification.category, reasonCode: 'send_gate_blocked' });
      await markRoofingReplyState(lead, 'Review', 'replied', ROOFING_DRAFTED_TAG);
      return 'blocked';
    }
    const attribution = stageSequenceAttribution({
      acquisition: latestSendAttribution(activities), sequenceId: 'roofing_survey_reply_v1', step: 1,
    });
    const result = await sendEmail({ to: lead.email.trim(), subject: 'Re: quick roofing question', body, threadId: message.threadId, inReplyTo: message.rfcMessageId, references: message.rfcMessageId, sender });
    const sentAt = new Date().toISOString();
    await recordColdCallActivity({
      eventId: result?.data?.id ? `gmail:${result.data.id}` : `${lead.id}:roofing-survey-reply:${sentAt}`,
      leadId: `CE-${lead.id}`, sourceLeadId: lead.id, email: lead.email,
      company: cleanCompanyName(lead.company) || lead.company || '', eventType: 'follow_up_sent',
      occurredAt: sentAt, subject: 'Re: quick roofing question', content: body,
      metadata: JSON.stringify({
        gmailMessageId: result?.data?.id || '', gmailThreadId: result?.data?.threadId || message.threadId || '',
        provider: 'gmail', providerMessageId: result?.data?.id || '', senderInboxId: sender.id,
        trigger: 'roofing_survey_reply', campaignProfile: ROOFING_SURVEY_PROFILE, ...attribution,
      }),
    });
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
async function runReplyCheckPass(leads, todaySentOverride = null, outboundObservationOk = true, activitiesForCycle = null) {
  const candidates = leads.filter(l => l.emailStatus === 'emailed' && isValidEmail(l.email));
  if (!candidates.length) {
    console.log('[ReplyCheck] No emailed leads to check.\n');
    return { ok: true, failedSenderIds: new Set() };
  }
  console.log(`[ReplyCheck] Checking ${candidates.length} emailed lead${candidates.length === 1 ? '' : 's'} for replies...`);

  let found = 0;
  const classCounts = {};
  // Auto-answers are real sends and share the daily ceiling with outreach, so
  // the pass starts from today's actual count rather than assuming zero.
  let replyPassTodaySent = todaySentOverride ?? countTodaySends(leads);
  let attributionActivities = null;
  const failedSenderIds = new Set();

  for (const lead of candidates) {
    const message = await withAuth(() => getReplyMessage(lead));
    if (!message) continue;
    if (message.observationFailed) {
      failedSenderIds.add(message.senderInboxId);
      continue;
    }

    found++;
    const company        = cleanCompanyName(lead.company) || lead.email;
    const replyText      = message.body || message.snippet;
    if (lead.emailTemplateId === ROOFING_SURVEY_TEMPLATE) {
      lead.emailStatus = 'replied';
      if (!DRY_RUN) {
        if (!attributionActivities) attributionActivities = activitiesForCycle || await withAuth(() => readColdCallActivities());
        await withAuth(() => handleRoofingSurveyReply(lead, message, replyText, replyPassTodaySent, attributionActivities, outboundObservationOk));
      }
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
        if (!attributionActivities) attributionActivities = activitiesForCycle || await readColdCallActivities();
        await recordActiveReplyActivity(lead, message, replyText, classification, attributionActivities);
        switch (classification) {
          // A genuine question is answered from product-facts.js when we're
          // confident, otherwise drafted for review. Both paths append the
          // warm booking snippet. todaySent enforces the touch cap.
          case 'QUESTION':       return handleQuestion(lead, replyText, replyPassTodaySent, attributionActivities, outboundObservationOk, senderForPersistedLead(lead));
          case 'INTERESTED':     return handleInterested(lead, message, replyText, 'positive_reply', leads, attributionActivities);
          case 'MEETING_REQUEST': return handleInterested(lead, message, replyText, 'meeting_requested', leads, attributionActivities);
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
  return { ok: failedSenderIds.size === 0, failedSenderIds };
}

async function writeLateReplyNotes(lead, notes) {
  const rowNum = await resolveRow(lead.id);
  if (!rowNum) throw new Error(`lead ${lead.id} disappeared before late-reply note write`);
  await sheets().spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!L${rowNum}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[notes]] },
  });
}

// Once-daily, bounded watcher for completed sequences. It performs no mailbox
// search, no stage/status/timestamp writes, and has no path to sendEmail.
async function runLateReplyCheckPass(leads, activitiesForCycle = null) {
  if (!LATE_REPLY_CHECK) return;
  if (DRY_RUN) {
    console.log('[LateReply] Dry run — terminal watcher skipped (no classification or writes).');
    return;
  }

  const activities = activitiesForCycle || await withAuth(readColdCallActivities);
  const plan = selectLateReplyCandidates(leads, activities, {
    lookbackDays: LATE_REPLY_LOOKBACK_DAYS,
    batchLimit: LATE_REPLY_BATCH_LIMIT,
    suppressedEmails: SUPPRESSED_EMAILS,
  });
  console.log(`[LateReply] ${plan.stats.terminal} terminal · ${plan.stats.insideLookback} inside ${plan.lookbackDays}d · ${plan.stats.usableIdentity} with Gmail identity · ${plan.candidates.length}/${plan.stats.eligible} checking`);
  if (!plan.candidates.length) return;

  const eventIds = existingLateReplyEventIds(activities);
  let recorded = 0;
  const classes = {};
  for (const { lead, outbound } of plan.candidates) {
    const messages = await withAuth(() => getLateReplyMessages(lead, outbound));
    for (const message of messages) {
      const result = await processLateReply({
        lead, outbound,
        message,
        classify: classifyReply,
        existingEventIds: eventIds,
        writeNotes: (target, notes) => withAuth(() => writeLateReplyNotes(target, notes)),
        addSuppression: target => withAuth(() => addSuppression(target.email, 'unsubscribe', target.company, 'late-reply-auto')),
        recordActivity: activity => withAuth(() => recordColdCallActivityStrict(activity)),
      });
      if (result.status !== 'recorded') continue;
      if (result.classification === 'INTERESTED' || result.classification === 'MEETING_REQUEST') {
        const coldCallLeadId = await withAuth(() => upsertColdCallLeadFromEvent(
          lead, 'hot', 'Auto-promoted from a canonical late positive reply.',
          { trigger: PROMOTION_TRIGGER.LATE_POSITIVE_REPLY, coldEmailTwinCount: coldEmailTwinCount(leads, lead.email) },
        ));
        if (coldCallLeadId) {
          const heldNotes = applyHoldToNotes(lead.notes || '');
          if (heldNotes !== lead.notes) {
            await withAuth(() => writeLateReplyNotes(lead, heldNotes));
            lead.notes = heldNotes;
          }
          await withAuth(() => recordColdCallActivityStrict({
            eventId: `promotion:${result.activity.eventId}:hot`,
            leadId: coldCallLeadId, sourceLeadId: lead.id, email: lead.email,
            company: cleanCompanyName(lead.company) || lead.company || '',
            eventType: 'pipeline_promoted', occurredAt: result.activity.occurredAt,
            subject: 'Promoted to Hot — late positive reply', content: '',
            metadata: JSON.stringify({
              fromStage: '', toStage: 'hot', trigger: 'late_positive_reply', sourceEventId: result.activity.eventId,
              ...promotionAttribution((JSON.parse(result.activity.metadata || '{}').replyTouch || {})),
            }),
          }));
        }
      }
      recorded++;
      classes[result.classification] = (classes[result.classification] || 0) + 1;
      console.log(`  ↩ Late reply from ${lead.email} — ${result.classification} (human review; automation remains stopped)`);
    }
  }
  const breakdown = Object.entries(classes).map(([key, count]) => `${count} ${key}`).join(' · ');
  console.log(`[LateReply] ${recorded} new late repl${recorded === 1 ? 'y' : 'ies'} recorded${breakdown ? ` · ${breakdown}` : ''}`);
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
    const sender = senderForPersistedLead(lead);
    const mailbox = gmailForSender(sender);

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
      mailbox.users.messages.list({
        userId:     'me',
        q:          `after:${afterSec} "${safeEmail}" subject:(${subjectQuery})`,
        maxResults: 5,
        includeSpamTrash: true,
      }),
      mailbox.users.messages.list({
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
      const full = await mailbox.users.messages.get({ userId: 'me', id, format: 'full' });
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
let intentSheetReady = false;

async function ensureIntentSheet() {
  if (intentSheetReady) return;
  const s  = sheets();
  const ss = await s.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  if (ss.data.sheets.find(sh => sh.properties.title === INTENT_SHEET)) {
    intentSheetReady = true;
    return;
  }
  await s.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: INTENT_SHEET } } }] },
  });
  await s.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID, range: `${INTENT_SHEET}!A1`,
    valueInputOption: 'RAW', requestBody: { values: [INTENT_HEADER] },
  });
  intentSheetReady = true;
  console.log(`[Intent] ${INTENT_SHEET} tab created`);
}

async function loadFiredIntents(rowsOverride = null) {
  try {
    const rows = rowsOverride || (await sheets().spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID, range: `${INTENT_SHEET}!A:E`,
    })).data.values || [];
    // key on leadId + trigger so a future second trigger type is independent
    return new Set(rows.slice(1)
      .filter(row => row[1]).map(row => `${row[1]}|${row[4] || 'both-audios'}`));
  } catch (_e) {
    return new Set();   // missing tab = nothing fired yet
  }
}

// Reads DemoPlays and returns Map<companyKey, {intro, demo}> of REAL plays.
async function readRealDemoPlays(rowsOverride = null) {
  const rows = rowsOverride || (await sheets().spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID, range: 'DemoPlays!A:F',
  })).data.values || [];
  const byKey = new Map();
  for (const row of rows.slice(1)) {
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

async function runIntentTriggerPass(allLeads, ownershipContext = null, snapshot = null) {
  await ensureIntentSheet();
  const plays = await readRealDemoPlays(snapshot?.demoPlays);
  const fired = await loadFiredIntents(snapshot?.intentFired);
  const activities = snapshot?.activities || await readColdCallActivities();

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
    const gate = coldSendGate(lead, ownershipContext);
    if (!gate.verdict.allowed) {
      console.warn(`  🚫 [OWNERSHIP] skipping intent email → ${lead.email} — ${gate.verdict.reason}`);
      continue;
    }
    if (todaySent >= DAILY_SEND_LIMIT) { console.warn(`  ⏸️  daily cap reached (${todaySent}/${DAILY_SEND_LIMIT}) — deferring to next pass`); break; }

    const { subject, body } = buildIntentEmail(lead);
    if (DRY_RUN)          { console.log(`— WOULD SEND (intent) → ${lead.email}\n   ${subject}`); continue; }
    if (!SENDING_ENABLED) { console.log(`⛔ [kill-switch] would send intent email → ${lead.email}`); continue; }

    try {
      const company = cleanCompanyName(lead.company) || 'your business';
      const sender = senderForPersistedLead(lead);
      const personalization = buildDentalPersonalization({ ...lead, company }, { siteText: lead.siteContext || '' });
      const currentSubject = buildDentalSubject({ lead, company, personalization }).subject;
      const legacySubject = coldSubjectFor(lead, company);
      const thread = await findOriginalSentThread({
        gmail: gmailForSender(sender), email: lead.email.trim(), expectedSubjects: [currentSubject, legacySubject],
      });
      if (!thread) {
        console.warn(`  ⏸️  intent email deferred → ${lead.email} (original Gmail thread could not be verified)`);
        continue;
      }
      await sendEmail({
        to: lead.email.trim(), subject: thread.subject, body,
        sender,
        threadId: thread.threadId, inReplyTo: thread.inReplyTo, references: thread.references,
      });
      const intentSentAt = new Date().toISOString();
      const relatedActivities = activities.filter(row => row.sourceLeadId === lead.id || row.leadId === `CE-${lead.id}`);
      const influence = replyTouchAttribution({ occurredAt: intentSentAt, threadId: thread.threadId }, relatedActivities);
      // Record the fire BEFORE anything else can fail, so a crash after send
      // can never produce a duplicate on the next pass.
      await sheets().spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID, range: `${INTENT_SHEET}!A:E`,
        valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [[intentSentAt, lead.id,
          cleanCompanyName(lead.company) || '', lead.email, 'both-audios']] },
      });
      const rowNum = await resolveRow(lead.id);
      if (rowNum) {
        await sheets().spreadsheets.values.batchUpdate({
          spreadsheetId: SPREADSHEET_ID,
          requestBody: { valueInputOption: 'RAW', data: [
            { range: `${SHEET_NAME}!J${rowNum}`, values: [[intentSentAt]] },
            { range: `${SHEET_NAME}!L${rowNum}`, values: [[prependNote(lead.notes, '[INTENT: both audios played — booking link sent]')]] },
          ] },
        });
      }
      const coldCallLeadId = await upsertColdCallLeadFromEvent(
        lead, 'follow_up',
        'Demo pair played. Booking-link follow-up sent automatically.',
        { trigger: PROMOTION_TRIGGER.VERIFIED_DEMO_PAIR, verifiedDemoPair: true, bookingLinkSent: true,
          coldEmailTwinCount: coldEmailTwinCount(allLeads, lead.email) },
      );
      // The selectors below operate on this in-memory snapshot. Keep it in
      // sync so a booking-link send cannot be followed by an ordinary cold
      // follow-up later in the same agent pass. The durable ownership record
      // is the canonical Pipeline card above; later passes read that board
      // rather than writing the legacy ColdEmail Promoted stage.
      lead.stage = 'Promoted';
      lead.lastEmailedAt = intentSentAt;
      const timelineLeadId = coldCallLeadId || `CE-${lead.id}`;
      const play = plays.get(normalizeName(cleanCompanyName(lead.company))) || {};
      await recordColdCallActivity({
        leadId: timelineLeadId, sourceLeadId: lead.id, email: lead.email,
        company: cleanCompanyName(lead.company) || lead.company || '',
        eventType: 'initial_email_sent',
        occurredAt: thread.internalDate ? new Date(thread.internalDate).toISOString() : '',
        subject: thread.subject, content: thread.content || '',
        metadata: JSON.stringify({ gmailThreadId: thread.threadId, senderInboxId: sender.id, provider: 'gmail', campaignVersion: LEGACY_UNKNOWN }),
      });
      await recordColdCallActivity({
        leadId: timelineLeadId, sourceLeadId: lead.id, email: lead.email,
        company: cleanCompanyName(lead.company) || lead.company || '',
        eventType: 'demo_pair_played', occurredAt: play.last || intentSentAt,
        subject: '', content: 'Both demo audio clips were played.', metadata: '',
      });
      await recordColdCallActivity({
        leadId: timelineLeadId, sourceLeadId: lead.id, email: lead.email,
        company: cleanCompanyName(lead.company) || lead.company || '',
        eventType: 'booking_link_sent', occurredAt: intentSentAt,
        subject: thread.subject, content: body,
        metadata: JSON.stringify({
          gmailThreadId: thread.threadId, senderInboxId: sender.id, provider: 'gmail', trigger: 'both_audios',
          ...stageSequenceAttribution({ acquisition: influence, sequenceId: 'demo_booking_link_v1', step: 1 }),
        }),
      });
      await recordColdCallActivity({
        eventId: `promotion:${lead.id}:both-audios:follow_up`,
        leadId: timelineLeadId, sourceLeadId: lead.id, email: lead.email,
        company: cleanCompanyName(lead.company) || lead.company || '',
        eventType: 'pipeline_promoted', occurredAt: intentSentAt,
        subject: 'Promoted to Follow Up — verified demo engagement', content: '',
        metadata: JSON.stringify({
          fromStage: '', toStage: 'follow_up', trigger: 'verified_demo_pair', sourceEventId: `${lead.id}|both-audios`,
          ...promotionAttribution(influence),
        }),
      });
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
// [MANUAL HOLD] is written by the CRM when a lead is moved into a human-owned
// or terminal stage (Hot / Call Booked / Closed Won / Closed Lost). Adding it
// here is the entire agent-side change: suppressionReason() is the single guard
// every send loop already calls, so one tag closes new sends, warm follow-ups,
// standard follow-ups, intent emails, auto-answers and the roofing path at once.
// This can only ever REMOVE a lead from a send — it can never cause one.
const MANUAL_HOLD_TAG = '[MANUAL HOLD]';
// The tag list itself now lives in pipeline-state as SEND_SUPPRESSION_TAGS,
// beside the rule that reads it, so there is exactly one copy for the sender
// and the health checker to share.

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
let suppressionSheetReady = false;

const normEmail = e => (e || '').toLowerCase().trim();

async function ensureSuppressionSheet() {
  if (suppressionSheetReady) return;
  const s  = sheets();
  const ss = await s.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  if (ss.data.sheets.find(sh => sh.properties.title === SUPPRESSION_SHEET)) {
    suppressionSheetReady = true;
    return;
  }
  await s.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: SUPPRESSION_SHEET } } }] },
  });
  await s.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID, range: `${SUPPRESSION_SHEET}!A1`,
    valueInputOption: 'RAW', requestBody: { values: [SUPPRESSION_HEADER] },
  });
  suppressionSheetReady = true;
  console.log('[Suppression] tab created with headers');
}

// Reads the tab into SUPPRESSED_EMAILS. Tolerant: a missing tab just yields an
// empty set (nothing is ever un-suppressed by a read failure).
async function loadSuppressionList(rowsOverride = null) {
  try {
    const rows = rowsOverride || (await sheets().spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID, range: `${SUPPRESSION_SHEET}!A:A`,
    })).data.values || [];
    SUPPRESSED_EMAILS = new Set(rows.slice(1).map(row => normEmail(row[0])).filter(Boolean));
    console.log(`[Suppression] loaded ${SUPPRESSED_EMAILS.size} suppressed email(s)`);
  } catch (e) {
    // Suppression uncertainty can only remove permission to send. Treating a
    // quota failure as an empty list silently re-enables opted-out addresses.
    throw new Error(`suppression list unavailable; refusing send-capable run: ${e.message}`);
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
// Delegates to the canonical definition in pipeline-state. The rule itself is
// unchanged — moving it out means the health checker can ask the SAME function
// the sender asks, instead of reimplementing it and quietly disagreeing.
function suppressionReason(lead) {
  return sendSuppressionReason(lead, { suppressedEmails: SUPPRESSED_EMAILS });
}

/**
 * THE send gate. Every provider call passes through here.
 *
 * The sender no longer keeps its own opinion about eligibility: it asks the
 * shared ownership model and refuses anything that is not positively a
 * permitted cold send. Fails CLOSED — an unrecognised state is a refusal, not
 * a default-allow.
 *
 * Board and activity context is not loaded in the send pass, so the verdict
 * here is the lead-level one: identity, terminal stage, suppression, MANUAL
 * HOLD and pipeline promotion. Reply- and meeting-owned leads are already
 * excluded upstream, because runReplyCheckPass moves them off `emailed`.
 */
// How far back the outbound observation looks each cycle. Idempotency is what
// guarantees correctness — this only bounds the work. A few days of overlap
// costs one extra list page and makes a missed cycle self-healing.
const OUR_ADDRESS_PATTERN = /scalelabai|tryscalelab/i;
const HUMAN_OUTBOUND_LOOKBACK_DAYS = parseInt(process.env.HUMAN_OUTBOUND_LOOKBACK_DAYS || '3', 10);

/**
 * Observe manual Gmail replies and turn them into canonical activity.
 *
 * WHY THIS RUNS BEFORE SEND SELECTION
 *
 * Someone answers a prospect from their inbox at 09:00; the agent wakes at
 * 09:05. Without this pass the CRM has no idea the conversation moved, and
 * ownership happily reports the lead as ordinary cold cadence. Six such
 * messages existed in production while the CRM believed nobody had answered.
 * So observation happens first, its activities are persisted, and only then is
 * ownership derived — the send gate reasons about a mailbox that is current.
 *
 * COST: one messages.list, one metadata get per listed message, and one
 * threads.get per message that matched a lead. Never per CRM lead.
 *
 * Returns { ok } — a false result makes automated sends fail closed for the
 * rest of the cycle. Reply checks, bounce checks and the dashboard are
 * unaffected: a stale mailbox is a reason not to SEND, not a reason to stop
 * observing.
 */
async function runHumanOutboundPass(leads, activitiesForCycle, sender = null) {
  if (!sender) {
    const results = [];
    for (const mailbox of GMAIL_SENDERS.filter(item => item.sendEligible)) {
      results.push({ senderInboxId: mailbox.id, ...(await runHumanOutboundPass(leads, activitiesForCycle, mailbox)) });
    }
    return { ok: results.every(item => item.ok), written: results.reduce((n, item) => n + (item.written || 0), 0), senders: results };
  }
  const mailbox = gmailForSender(sender);
  const leadsByEmail = new Map();
  for (const lead of leads) {
    const email = String(lead.email || '').trim().toLowerCase();
    if (email && !leadsByEmail.has(email)) leadsByEmail.set(email, lead);
  }
  const byId = new Map(leads.map(lead => [lead.id, lead]));
  const existingActivitiesByLead = new Map();
  const leadIdByThread = new Map();
  for (const row of activitiesForCycle || []) {
    const key = String(row.sourceLeadId || '').trim() || String(row.leadId || '').replace(/^CE-/, '').trim();
    if (!key) continue;
    const bucket = existingActivitiesByLead.get(key) || [];
    bucket.push(row);
    existingActivitiesByLead.set(key, bucket);
    try {
      const metadata = JSON.parse(row.metadata || '{}');
      const rowSender = String(metadata.senderInboxId || 'primary');
      if (rowSender !== sender.id) continue;
      const threadId = metadata.gmailThreadId;
      if (threadId && byId.has(key) && !leadIdByThread.has(threadId)) leadIdByThread.set(threadId, byId.get(key));
    } catch (_) { /* malformed metadata is health's problem, not this pass's */ }
  }

  const headerOf = (payload, name) =>
    ((payload && payload.headers) || []).find(h => h.name.toLowerCase() === name)?.value || '';
  const addressesOf = value => String(value || '').split(',')
    .map(part => { const m = /<([^>]+)>/.exec(part); return (m ? m[1] : part).trim().toLowerCase(); })
    .filter(Boolean);

  try {
    const listed = await mailbox.users.messages.list({
      userId: 'me', q: `in:sent newer_than:${HUMAN_OUTBOUND_LOOKBACK_DAYS}d`, maxResults: 200,
    });
    const messages = [];
    for (const stub of (listed.data.messages || [])) {
      const full = await mailbox.users.messages.get({
        userId: 'me', id: stub.id, format: 'metadata',
        metadataHeaders: ['To', 'Cc', 'Subject', 'Date'],
      });
      messages.push({
        id: full.data.id, threadId: full.data.threadId,
        to: [...addressesOf(headerOf(full.data.payload, 'to')), ...addressesOf(headerOf(full.data.payload, 'cc'))],
        subject: headerOf(full.data.payload, 'subject'),
        sentAt: new Date(Number(full.data.internalDate)).toISOString(),
      });
    }

    // Thread inbound evidence, resolved ONLY for messages that matched a lead.
    // Asked of Gmail rather than inferred from stored replies, so a lead with
    // no reconciled reply activity is still handled correctly.
    const threadsWithInbound = new Set();
    const candidateThreads = new Set();
    for (const message of messages) {
      const match = matchOutbound(message, { leadsByEmail, leadIdByThread });
      if (match.leadId && message.threadId) candidateThreads.add(message.threadId);
    }
    for (const threadId of candidateThreads) {
      try {
        const thread = await mailbox.users.threads.get({
          userId: 'me', id: threadId, format: 'metadata', metadataHeaders: ['From'],
        });
        const hasInbound = (thread.data.messages || []).some(m => {
          const from = addressesOf(headerOf(m.payload, 'from'))[0] || '';
          return from && !OUR_ADDRESS_PATTERN.test(from);
        });
        if (hasInbound) threadsWithInbound.add(threadId);
      } catch (_) { /* an unreadable thread simply yields no inbound evidence */ }
    }

    const report = planHumanOutboundIngestion(messages, {
      leadsByEmail, leadIdByThread, existingActivitiesByLead, threadsWithInbound,
    });
    const toWrite = report.plans.filter(plan => plan.outcome === 'proposed');
    for (const plan of toWrite) {
      plan.activity.metadata = { ...plan.activity.metadata, provider: 'gmail', senderInboxId: sender.id };
      await recordColdCallActivity({
        ...plan.activity, metadata: JSON.stringify(plan.activity.metadata),
      });
      // Visible to ownership in THIS cycle, without a re-read.
      const bucket = existingActivitiesByLead.get(plan.leadId) || [];
      bucket.push({ ...plan.activity, metadata: JSON.stringify(plan.activity.metadata) });
      existingActivitiesByLead.set(plan.leadId, bucket);
      (activitiesForCycle || []).push({ ...plan.activity, metadata: JSON.stringify(plan.activity.metadata) });
    }
    console.log(`[HumanOutbound:${sender.id}] ${messages.length} sent message(s) in ${HUMAN_OUTBOUND_LOOKBACK_DAYS}d · `
      + `${toWrite.length} new human response(s) recorded · ${JSON.stringify(report.byOutcome)}`);
    return { ok: true, written: toWrite.length, inspected: messages.length };
  } catch (error) {
    console.error(`[HumanOutbound] observation FAILED (${error.message}) — automated sends fail closed this cycle`);
    return { ok: false, written: 0, error: error.message };
  }
}

function coldSendGate(lead, context = null) {
  // Without context the gate still runs, but it can only see lead-level state.
  // That was the original shape and it is not good enough: the audit could say
  // "blocked, this lead is in the pipeline" while the sender had no board to
  // look at. A pass that failed to read the board fails CLOSED rather than
  // quietly reverting to the weaker check.
  if (context && !context.boardAvailable) {
    return { ownership: null, verdict: { allowed: false,
      reason: 'pipeline context unavailable this pass — failing closed' } };
  }
  if (context && !context.outboundObservationOk) {
    return { ownership: null, verdict: { allowed: false,
      reason: 'manual outbound observation failed this pass — mailbox may be stale, failing closed' } };
  }
  const leadId = String(lead.id || '');
  const boardLead = context
    ? (context.boardByLead.get(leadId)
      || context.boardByEmail.get(String(lead.email || '').trim().toLowerCase())
      || null)
    : null;
  const activities = context ? (context.activitiesByLead.get(leadId) || []) : [];
  const callState = boardLead
    ? deriveCallLifecycle(boardLead, { activities, now: new Date() })
    : null;
  const ownership = deriveAutomationOwnership(lead, {
    boardLead, activities, callState,
    // The manual reply observed moments ago in this same cycle.
    humanTouchAt: latestHumanOutboundAt(activities),
    suppressionReason,
    sendingEnabled: SENDING_ENABLED,
    sequencesEnabled: STAGE_SEQUENCES_ENABLED,
    coldCadenceDue: true,   // the selector already proved cadence timing
  });
  return { ownership, verdict: mayColdSend(ownership) };
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
  return routing.ok;
}

// Phase 3: find leads that are due for a follow-up step.
// currentStep 1 → send step 2 (FOLLOW_UP_SEQUENCE[0], 3 days)
// currentStep 2 → send step 3 (FOLLOW_UP_SEQUENCE[1], 5 days)
function selectFollowUps(leads) {
  const now = Date.now();
  const due = leads.filter(l => {
    if (l.emailStatus !== 'emailed') return false;
    // A lead that has left cold stages is no longer ordinary cold cadence,
    // whatever emailStatus still says. This filter used to read emailStatus and
    // never the stage, so Sparkle Dental Spa — ColdEmail stage "Promoted",
    // emailStatus "emailed", step 1, no MANUAL HOLD — stayed queued for an
    // automated cold follow-up while the CRM treated it as a live opportunity.
    // The hold remains a second, independent safety tag; this no longer depends
    // on anyone having remembered to add it.
    if (NON_COLD_STAGES.includes(String(l.stage || '').trim().toLowerCase())) return false;
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
  return oldestDueFirst(due, FOLLOW_UP_SEQUENCE);
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

const sleep = ms => new Promise(r => setTimeout(r, ms));
const jitter = () => MIN_DELAY + Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY));

// ── MAIN ──────────────────────────────────────────────────────────────────────

// ── STAGE-SPECIFIC FOLLOW-UP PASS ───────────────────────────────────────────
// The recovery journeys. This is a SELECTOR, not a new sending engine: it works
// out which lead is due which step, then goes through the same sendEmail, the
// same daily cap, the same kill switch and the same suppression as everything
// else.
//
// It never touches the cold sequence: emailStep, lastEmailedAt and emailStatus
// are neither read nor written here, and [MANUAL HOLD] is never removed — the
// cold selectors stay blocked exactly as before. See stage-sequences.js.
async function runStageSequencePass(allLeads, {
  observationBySender = new Map(), activitiesForCycle = null, boardLeadsForCycle = null, sendsBySender = null,
  quotaState = { globalCount: 0 },
} = {}) {
  // The gate comes first, before any read. With the flag off this pass cannot
  // select a lead, let alone send to one.
  if (!STAGE_SEQUENCES_ENABLED) {
    console.log('[StageSeq] disabled (STAGE_SEQUENCES_ENABLED is not "true") — no stage follow-ups considered.');
    return 0;
  }
  // CHECK_ONLY is a process-level invariant, not merely a caller convention.
  // Even an accidental direct invocation of this pass cannot reach Gmail send.
  if (CHECK_ONLY) { console.log('[StageSeq] check-only — send-capable pass skipped.'); return 0; }
  if (DRY_RUN) { console.log('[StageSeq] dry run — skipped.'); return 0; }

  const boardLeads = boardLeadsForCycle || await withAuth(readBoardLeads);
  if (!Array.isArray(boardLeads)) {
    console.error('[StageSeq] Pipeline snapshot unavailable — failing closed.');
    return 0;
  }
  // Observation handlers update these arrays in memory as they persist facts,
  // so the shared cycle snapshot remains current without another Sheets read.
  const activities = activitiesForCycle || await withAuth(readColdCallActivities);
  const byKey = new Map();
  for (const row of activities) {
    for (const key of [row.leadId, normEmail(row.email)]) {
      if (!key) continue;
      byKey.set(key, [...(byKey.get(key) || []), row]);
    }
  }
  const twinByEmail = new Map();
  for (const lead of allLeads) {
    const key = normEmail(lead.email);
    if (key && !twinByEmail.has(key)) twinByEmail.set(key, lead);
  }

  let sent = 0;
  const senderDayKey = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });
  const senderCounts = sendsBySender || senderCountsToday(activities, senderDayKey);
  const freshSenderCounts = senderCountsToday(activities, senderDayKey);
  for (const [senderId, count] of freshSenderCounts) {
    senderCounts.set(senderId, Math.max(senderCounts.get(senderId) || 0, count));
  }
  // ColdEmail's one-row timestamps remain a conservative compatibility floor;
  // activity events count every successful initial, ordinary follow-up, booking
  // link and Pipeline step. The larger total prevents either ledger lagging.
  let todaySent = Math.max(Number(quotaState.globalCount || 0),
    countTodaySends(allLeads), successfulSendCountToday(activities, senderDayKey));
  quotaState.globalCount = todaySent;

  const persistSequenceStep = async ({ eventId, boardLead, twin, verdict, step, built,
    sender, result, recovered = false, occurredAt = new Date().toISOString() }) => {
    const data = result?.data || result || {};
    const sequenceAttribution = stageSequenceAttribution({
      acquisition: acquisitionAttribution(mineFor(boardLead, activities)),
      sequenceId: verdict.sequenceId, step,
    });
    await recordColdCallActivityStrict({
      eventId, leadId: boardLead.id, sourceLeadId: twin ? twin.id : '',
      email: boardLead.email, company: boardLead.company || '',
      eventType: SEQUENCE_EVENTS.STEP_SENT, occurredAt,
      subject: built.subject, content: built.body,
      metadata: JSON.stringify({
        sequenceId: verdict.sequenceId, step, maxSteps: verdict.maxSteps,
        sequenceVersion: verdict.sequenceId.split('_').pop(),
        providerMessageId: data.id || data.providerMessageId || '', provider: 'gmail',
        senderInboxId: sender.id, gmailThreadId: data.threadId || built.threadId || '',
        rfcMessageId: data.rfcMessageId || built.messageId || '',
        repliedInThread: built.replyToThread, recoveredAfterCheckpointFailure: recovered,
        ...sequenceAttribution,
      }),
    });
  };

  function mineFor(boardLead, sourceActivities) {
    const email = normEmail(boardLead.email);
    return sourceActivities.filter(row => String(row.leadId || '') === String(boardLead.id)
      || (email && normEmail(row.email) === email));
  }

  for (const boardLead of boardLeads) {
    const email = normEmail(boardLead.email);
    const mine = [...(byKey.get(boardLead.id) || []), ...(email ? byKey.get(email) || [] : [])];
    const twin = twinByEmail.get(email) || null;
    const callState = deriveCallLifecycle(boardLead, { activities: mine });
    const hotState = deriveHotState(boardLead, { activities: mine });
    let verdict = evaluateStageSequence({
      boardLead, twin: twin || {}, activities: mine,
      callState, hotState,
      suppressedEmails: SUPPRESSED_EMAILS,
      featureEnabled: true,     // reaching here already proved the flag is on
    });

    const senderProof = provenSequenceSenderId(twin || {}, mine);
    const proofThread = senderProof.ok
      ? resolveSequenceThread(mine, { senderInboxId: senderProof.senderInboxId }) : null;
    const enrollment = automaticEnrollmentDecision({
      boardLead, twin: twin || {}, activities: mine, verdict, senderProof,
      thread: proofThread, callState, hotState,
    });
    if (enrollment.enroll) {
      const enrollmentId = automaticEnrollmentEventId(boardLead.id, enrollment.sequenceId, enrollment.enrolledAt);
      if (!activities.some(row => row.eventId === enrollmentId)) {
        const row = {
          eventId: enrollmentId, leadId: boardLead.id, sourceLeadId: twin ? twin.id : '',
          email: boardLead.email, company: boardLead.company || '', eventType: SEQUENCE_EVENTS.ENROLLED,
          occurredAt: enrollment.enrolledAt, subject: '', content: '',
          metadata: JSON.stringify({
            sequenceId: enrollment.sequenceId, enrollmentMode: 'automatic',
            authorization: enrollment.authorization, senderInboxId: enrollment.senderInboxId,
            gmailThreadId: enrollment.gmailThreadId,
          }),
        };
        try {
          await recordColdCallActivityStrict(row);
          activities.push(row); mine.push(row);
        } catch (error) {
          console.error(`[StageSeq] auto-enrollment checkpoint failed for ${boardLead.email}: ${error.message}`);
          continue;
        }
      }
      verdict = evaluateStageSequence({
        boardLead, twin: twin || {}, activities: mine, callState, hotState,
        suppressedEmails: SUPPRESSED_EMAILS, featureEnabled: true,
      });
    }

    if (verdict.status === 'active' && verdict.stopReason) {
      const stopId = `seq-stop:${boardLead.id}:${verdict.sequenceId}:${String(verdict.stopReason).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
      if (!activities.some(row => row.eventId === stopId)) {
        try {
          await recordColdCallActivityStrict({
            eventId: stopId, leadId: boardLead.id, sourceLeadId: twin ? twin.id : '', email: boardLead.email,
            company: boardLead.company || '', eventType: SEQUENCE_EVENTS.STOPPED,
            occurredAt: new Date().toISOString(), subject: '', content: '',
            metadata: JSON.stringify({ sequenceId: verdict.sequenceId, reason: verdict.stopReason }),
          });
        } catch (error) { console.error(`[StageSeq] stop checkpoint failed for ${boardLead.email}: ${error.message}`); }
      }
      continue;
    }
    if (!verdict.eligible) continue;

    const step = (verdict.step || 0) + 1;
    const eventId = sequenceStepEventId(boardLead.id, verdict.sequenceId, step);
    // Idempotent by construction: the id is derived from lead + sequence + step,
    // so a repeated run that already recorded this step selects nothing.
    if (activities.some(row => row.eventId === eventId)) continue;
    if (!isValidEmail(boardLead.email)) continue;

    const sender = senderProof.ok
      ? GMAIL_SENDERS.find(item => item.id === senderProof.senderInboxId) : null;

    // Reply into the real conversation when the timeline proves one exists.
    // Without a verifiable thread the copy falls back to a standalone subject
    // rather than faking "Re:" on a message that is not part of that thread.
    const thread = sender
      ? resolveSequenceThread(mine, { senderInboxId: sender.id }) : null;
    const verifiedThread = sender && thread ? await verifyThreadOwnership({
      gmail: gmailForSender(sender), threadId: thread.threadId,
      senderEmail: sender.email, recipientEmail: boardLead.email,
    }) : { ok: false, reason: 'sender-pinned thread is not proven' };
    const sendGate = stageSendGate({
      checkOnly: CHECK_ONLY, sendingEnabled: SENDING_ENABLED, senderProof, sender, thread,
      threadVerified: verifiedThread.ok, observationOk: sender ? observationBySender.get(sender.id) === true : false,
      senderCount: sender ? (senderCounts.get(sender.id) || 0) : 0,
      globalCount: todaySent, globalLimit: DAILY_SEND_LIMIT,
    });
    if (!sendGate.allowed) {
      console.warn(`[StageSeq] ${boardLead.email} blocked: ${sendGate.reason}`);
      continue;
    }
    if (!verifiedThread.ok) { console.warn(`[StageSeq] ${boardLead.email} blocked: ${verifiedThread.reason}`); continue; }
    const built = buildSequenceEmail(verdict.sequenceId, step, boardLead, { thread: verifiedThread });
    if (built.error) { console.warn(`[StageSeq] ${built.error}`); continue; }
    built.messageId = sequenceRfcMessageId(eventId, sender.email);

    // Gmail is the durable delivery ledger. A deterministic RFC Message-ID lets
    // a restart recover a provider success whose Sheets checkpoint failed.
    try {
      const recovered = await findSuccessfulSequenceSend({
        gmail: gmailForSender(sender), rfcMessageId: built.messageId,
      });
      if (recovered) {
        await persistSequenceStep({ eventId, boardLead, twin, verdict, step, built,
          sender, result: recovered, recovered: true, occurredAt: recovered.occurredAt || new Date().toISOString() });
        const recoveredDay = new Date(recovered.occurredAt || Date.now())
          .toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });
        if (recoveredDay === senderDayKey) {
          todaySent++;
          quotaState.globalCount = todaySent;
          senderCounts.set(sender.id, (senderCounts.get(sender.id) || 0) + 1);
        }
        console.warn(`[StageSeq] recovered prior successful send for ${boardLead.email}; no duplicate sent`);
        continue;
      }
    } catch (error) {
      console.warn(`[StageSeq] ${boardLead.email} blocked: idempotency probe failed (${error.message})`);
      continue;
    }

    const metadataOf = row => { try { return JSON.parse(row.metadata || '{}'); } catch (_) { return {}; } };
    const reservations = mine.filter(row => row.eventType === SEQUENCE_EVENTS.SEND_RESERVED
      && metadataOf(row).stepEventId === eventId);
    const failedReservations = new Set(mine.filter(row => row.eventType === SEQUENCE_EVENTS.SEND_FAILED)
      .map(row => metadataOf(row).reservationEventId).filter(Boolean));
    const unresolved = reservations.find(row => !failedReservations.has(row.eventId));
    if (unresolved) {
      console.warn(`[StageSeq] ${boardLead.email} blocked: a durable delivery reservation exists and Gmail has not confirmed it yet`);
      continue;
    }
    const reservationEventId = `${eventId}:attempt:${reservations.length + 1}`;
    const reservation = {
      eventId: reservationEventId, leadId: boardLead.id, sourceLeadId: twin ? twin.id : '',
      email: boardLead.email, company: boardLead.company || '',
      eventType: SEQUENCE_EVENTS.SEND_RESERVED, occurredAt: new Date().toISOString(),
      subject: built.subject, content: '',
      metadata: JSON.stringify({
        sequenceId: verdict.sequenceId, step, stepEventId: eventId,
        senderInboxId: sender.id, gmailThreadId: built.threadId,
        rfcMessageId: built.messageId,
      }),
    };
    try {
      await recordColdCallActivityStrict(reservation);
      activities.push(reservation); mine.push(reservation);
    } catch (error) {
      console.warn(`[StageSeq] ${boardLead.email} blocked: delivery reservation could not be persisted (${error.message})`);
      continue;
    }

    let result;
    try {
      result = await sendEmail({
        to: boardLead.email.trim(), subject: built.subject, body: built.body,
        sender, messageId: built.messageId,
        ...(built.replyToThread ? {
          threadId: built.threadId,
          inReplyTo: built.inReplyTo || undefined,
          references: built.references || undefined,
        } : {}),
      });
    } catch (error) {
      // A provider failure consumes no quota. Only a definite pre-delivery 4xx
      // is automatically retryable; ambiguous transport/5xx failures keep the
      // reservation blocked until Gmail proves whether delivery occurred.
      console.error(`[StageSeq] send failed for ${boardLead.email}: ${error.message}`);
      const providerStatus = Number(error?.response?.status || error?.code);
      const providerRejectedBeforeDelivery = providerStatus >= 400 && providerStatus < 500
        && ![408, 409, 429].includes(providerStatus);
      if (!providerRejectedBeforeDelivery) {
        console.error('[StageSeq] delivery outcome is ambiguous; durable reservation remains blocked until Gmail confirms the Message-ID');
        continue;
      }
      const failure = {
        eventId: `${reservationEventId}:failed`, leadId: boardLead.id,
        sourceLeadId: twin ? twin.id : '', email: boardLead.email,
        company: boardLead.company || '', eventType: SEQUENCE_EVENTS.SEND_FAILED,
        occurredAt: new Date().toISOString(), subject: built.subject, content: '',
        metadata: JSON.stringify({
          sequenceId: verdict.sequenceId, step, stepEventId: eventId,
          reservationEventId, senderInboxId: sender.id, error: String(error.message || '').slice(0, 300),
        }),
      };
      try { await recordColdCallActivityStrict(failure); activities.push(failure); mine.push(failure); }
      catch (checkpointError) {
        console.error(`[StageSeq] provider failure checkpoint also failed; reservation remains fail-closed: ${checkpointError.message}`);
      }
      continue;
    }

    // Successful provider delivery consumes both ceilings immediately, before
    // any fallible checkpoint write.
    todaySent++;
    quotaState.globalCount = todaySent;
    senderCounts.set(sender.id, (senderCounts.get(sender.id) || 0) + 1);
    sent++;
    try {
      await persistSequenceStep({ eventId, boardLead, twin, verdict, step, built, sender, result });
      console.log(`  [StageSeq] ${verdict.sequenceId} step ${step} -> ${boardLead.email}`);
    } catch (error) {
      console.error(`‼️ [StageSeq] Gmail delivered ${eventId}, but checkpoint failed: ${error.message}`);
      console.error('‼️ [StageSeq] the deterministic Message-ID will recover this delivery on the next run; it will not resend.');
    }
  }
  console.log(`[StageSeq] ${sent} stage follow-up(s) sent.`);
  return sent;
}

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

  // Load every authoritative tab in one quota-counted request. A missing
  // safety tab fails the run closed; production migrations create these tabs.
  const snapshot = await withAuth(loadAgentSnapshot);
  suppressionSheetReady = true;
  intentSheetReady = true;
  coldCallActivityReady = true;
  snapshot.activities = await readColdCallActivities(snapshot.activityRows);
  snapshot.boardLeads = await readBoardLeads(snapshot.board);
  await loadSuppressionList(snapshot.suppression);
  await loadOutreachProviderState(snapshot.campaigns, snapshot.providerMappings);

  const all = await readLeads(snapshot.coldEmail);
  const allLeadsForDailyCap = [...all];
  if (TARGET_LEAD_ID) {
    const target = all.find(lead => lead.id === TARGET_LEAD_ID);
    if (!target) throw new Error(`TARGET_LEAD_ID ${TARGET_LEAD_ID} was not found`);
    all.splice(0, all.length, target);
    console.log(`[target] Controlled run restricted to lead ${TARGET_LEAD_ID}`);
  }

  // INTENT_ONLY still observes manual Gmail responses and derives canonical
  // ownership before it may send. It skips the other detection passes, but it
  // is not an escape hatch around mailbox freshness or the centralized gate.
  if (INTENT_ONLY && !CHECK_ONLY) {
    const intentBoard = snapshot.boardLeads;
    const intentActivities = snapshot.activities;
    const intentOutbound = await withAuth(() => runHumanOutboundPass(all, intentActivities));
    const intentOwnershipContext = buildOwnershipContext({
      boardLeads: intentBoard, activities: intentActivities,
      outboundObservationOk: intentOutbound.ok,
    });
    await withAuth(() => runIntentTriggerPass(all, intentOwnershipContext, snapshot));
    return;
  }

  let todaySent      = countTodaySends(allLeadsForDailyCap);
  console.log(`[cap] ${todaySent}/${DAILY_SEND_LIMIT} emails sent today (Vancouver time)`);
  let dailyRemaining = Math.max(0, DAILY_SEND_LIMIT - todaySent);

  // Observe manual Gmail replies before ANY pass that could auto-respond.
  // The same activity snapshot is later used to derive ownership for recovery,
  // intent and cold execution, so one provider observation protects them all.
  const ownershipBoard = snapshot.boardLeads;
  const ownershipActivities = snapshot.activities;
  const outbound = await withAuth(() => runHumanOutboundPass(all, ownershipActivities));
  const senderDayKey = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });
  const sendsBySender = senderCountsToday(ownershipActivities, senderDayKey);
  todaySent = Math.max(todaySent, successfulSendCountToday(ownershipActivities, senderDayKey));
  dailyRemaining = Math.max(0, DAILY_SEND_LIMIT - todaySent);

  // Reply-check pass — unconditional; runs even when cap is reached.
  // Mutates emailStatus on replied leads so selectFollowUps excludes them below.
  const replyObservation = await runReplyCheckPass(all, todaySent, outbound.ok, ownershipActivities);

  // Terminal replies are hosted by the same process only during the existing
  // scheduler's once-daily flag. Active polling above keeps its old cadence.
  await runLateReplyCheckPass(all, ownershipActivities);

  // Bounce-check pass — marks bounced leads Done before follow-up selection.
  await runBounceCheckPass(all);

  // CHECK_ONLY is observation-only. Return before constructing any execution
  // context or invoking any send-capable stage/intent/cold path.
  if (CHECK_ONLY) {
    console.log('\n[check-only] Detection complete — skipping all sends.');
    return;
  }

  const observationBySender = new Map();
  for (const sender of GMAIL_SENDERS) {
    const outboundSender = (outbound.senders || []).find(item => item.senderInboxId === sender.id);
    observationBySender.set(sender.id,
      Boolean(outboundSender?.ok) && !replyObservation.failedSenderIds.has(sender.id));
  }

  // ── OBSERVE, PERSIST, THEN DECIDE ────────────────────────────────────────
  // Inbound and bounce evidence above has finished writing. Now the mailbox is
  // read for MANUAL replies a person sent from their inbox and those become
  // canonical activity before EITHER recovery sequences or ordinary cold
  // sends are evaluated. A message answered five minutes ago must be visible
  // to every automated execution path in this same cycle.
  //
  // FAIL-CLOSED FRESHNESS. A failed observation means the mailbox may have
  // moved without us. That is a reason to refuse automated SENDS, not a reason
  // to halt the whole agent: reply checks, bounce handling and the dashboard
  // have already run and are unaffected.
  const ownershipContext = buildOwnershipContext({
    boardLeads: ownershipBoard, activities: ownershipActivities,
    outboundObservationOk: outbound.ok,
  });

  // Stage-specific recovery journeys. Gated OFF by default and entirely
  // separate from the cold sequence: it selects on CRM state, never on
  // emailStep, and it cannot resume a held cold sequence. The pass re-reads
  // canonical activities, including any human_response_sent event persisted
  // moments ago, and refuses all execution if mailbox observation failed.
  const quotaState = { globalCount: todaySent };
  await runStageSequencePass(all, {
    observationBySender, activitiesForCycle: ownershipActivities,
    boardLeadsForCycle: ownershipBoard, sendsBySender, quotaState,
  });
  todaySent = quotaState.globalCount;
  dailyRemaining = Math.max(0, DAILY_SEND_LIMIT - todaySent);

  // Intent trigger — both-audios. Runs in every normal pass as a backstop to
  // the event-driven spawn, so a missed webhook still gets picked up.
  await withAuth(() => runIntentTriggerPass(all, ownershipContext, snapshot));

  // Phase 1 — new sends (stage === QUEUE_STAGE, never emailed)
  const queued = selectQueued(all);

  // Phase 3 — follow-ups (replied leads already excluded by runReplyCheckPass)
  const followUps = selectFollowUps(all);

  const effectiveCap = Math.min(DAILY_CAP, dailyRemaining);
  console.log(`${all.length} leads · ${queued.length} queued · ${followUps.length} follow-ups due · cap ${effectiveCap} (${dailyRemaining} remaining today)\n`);

  if (dailyRemaining === 0) {
    console.log('[cap] Daily send limit reached — skipping sends this run');
    return;
  }

  // Fairness is measured in successful provider sends, never candidates. A
  // normal five-send batch first scans oldest-due follow-ups until four have
  // actually succeeded, then gives initials their reserved position. Refused
  // candidates consume no allocation, and either pool may refill unused space.
  const newBatch    = queued;
  const followBatch = followUps;
  const totalCandidates = newBatch.length + followBatch.length;

  if (totalCandidates === 0) {
    console.log(`Nothing to send. Queue a lead (stage="${QUEUE_STAGE}") or wait for follow-up timers.`);
    return;
  }

  let sent = 0;
  let followUpSent = 0;
  let followUpIndex = 0;

  // ── Follow-ups (steps 2 & 3) ──────────────────────────────────────────────
  async function attemptFollowUp(lead) {
    const suppressed = suppressionReason(lead);
    if (suppressed) {
      console.error(`🚫 [SUPPRESSED] refusing follow-up send → ${lead.email} (${cleanCompanyName(lead.company) || lead.id}) — notes contain ${suppressed}`);
      return false;
    }
    const gate = coldSendGate(lead, ownershipContext);
    if (!gate.verdict.allowed) {
      console.error(`🚫 [OWNERSHIP] refusing follow-up send → ${lead.email} — ${gate.verdict.reason}`);
      return false;
    }

    const currentStep = parseInt(lead.emailStep, 10);
    const nextStepNum = currentStep + 1;
    const template = FOLLOW_UP_SEQUENCE[currentStep - 1];
    const body = template.body(lead);
    const preview = body.split('\n')[2] || '';
    let senderChoice;
    try { senderChoice = chooseSender({ lead, activities: ownershipActivities, senders: GMAIL_SENDERS, sendsToday: sendsBySender, step: nextStepNum }); }
    catch (error) { console.warn(`⏸️  follow-up deferred → ${lead.email} (${error.message})`); return false; }
    if (!senderChoice.sender) { console.warn(`⏸️  follow-up deferred → ${lead.email} (${senderChoice.reason})`); return false; }
    const selectedSender = senderChoice.sender;
    let thread;
    try {
      thread = await resolveColdFollowUpThread({ gmail: gmailForSender(selectedSender), lead, activities: ownershipActivities, expectedSenderId: selectedSender.id });
    } catch (error) {
      console.warn(`⏸️  follow-up deferred → ${lead.email} (Gmail thread verification failed: ${error.message})`);
      return false;
    }
    if (!thread) {
      console.warn(`⏸️  follow-up deferred → ${lead.email} (canonical Gmail thread could not be proven)`);
      return false;
    }
    const subject = thread.subject;

    if (DRY_RUN) {
      const fupPitchTier = lead.tier === 'busy' ? 'busy' : 'medium';
      const rawCo = lead.company || '';
      const cleanCo = cleanCompanyName(rawCo);
      console.log(`— WOULD SEND (step ${nextStepNum}) →  ${lead.email}  (${rawCo || lead.first || lead.id})`);
      if (rawCo && rawCo !== cleanCo) console.log(`   Company: "${rawCo}" → "${cleanCo}"`);
      console.log(`   Pitch:   ${fupPitchTier}`);
      console.log(`   Subject: ${subject}`);
      console.log(`   Preview: ${preview}`);
      console.log(`   Link:    ${buildProposalLink(lead)}\n`);
      return false;
    }

    if (!SENDING_ENABLED) {
      console.log(`⛔ [kill-switch] would send (step ${nextStepNum}) → ${lead.email}  (${cleanCompanyName(lead.company) || lead.id})`);
      console.log(`   Subject: ${subject}`);
      return false;
    }

    try {
      const attribution = coldSendAttribution(lead, nextStepNum);
      const delivery = await deliverOrdinaryColdStep({
        lead, step: nextStepNum, sender: selectedSender, subject, body, attribution,
        activitiesForCycle: ownershipActivities, thread,
      });
      if (!delivery.delivered) {
        console.warn(`⏸️  follow-up deferred → ${lead.email} (${delivery.reason})`);
        return false;
      }
      sent++;
      followUpSent++;
      sendsBySender.set(selectedSender.id, (sendsBySender.get(selectedSender.id) || 0) + 1);
      console.log(`${delivery.recovered ? '♻️ Recovered' : '✅ Sent'} (step ${nextStepNum}) → ${lead.email}  (${sent}/${effectiveCap})`);
      return true;
    } catch (e) {
      console.error(`❌ Failed (step ${nextStepNum}) → ${lead.email}: ${e.message}`);
      return false;
    } finally {
      if (sent < effectiveCap) {
        const d = jitter();
        console.log(`   …waiting ${Math.round(d / 1000)}s\n`);
        await sleep(d);
      }
    }
  }

  async function fillFollowUps(successTarget) {
    while (followUpIndex < followBatch.length && sent < effectiveCap && followUpSent < successTarget) {
      await attemptFollowUp(followBatch[followUpIndex++]);
    }
  }

  const guaranteedFollowUpTarget = followUpSuccessTarget(effectiveCap);
  await fillFollowUps(guaranteedFollowUpTarget);

  // ── New sends (step 1) ────────────────────────────────────────────────────
  for (const lead of newBatch) {
    if (sent >= effectiveCap) break;
    const suppressed = suppressionReason(lead);
    if (suppressed) {
      console.error(`🚫 [SUPPRESSED] refusing step-1 send → ${lead.email} (${cleanCompanyName(lead.company) || lead.id}) — notes contain ${suppressed}`);
      continue;
    }
    const gate = coldSendGate(lead, ownershipContext);
    if (!gate.verdict.allowed) {
      console.error(`🚫 [OWNERSHIP] refusing step-1 send → ${lead.email} — ${gate.verdict.reason}`);
      continue;
    }

    let senderChoice;
    try { senderChoice = chooseSender({ lead, activities: ownershipActivities, senders: GMAIL_SENDERS, sendsToday: sendsBySender, step: 1 }); }
    catch (error) { console.warn(`⏸️  sender routing refused → ${lead.email} (${error.message})`); continue; }
    if (!senderChoice.sender) { console.warn(`⏸️  sender routing deferred → ${lead.email} (${senderChoice.reason})`); continue; }
    const selectedSender = senderChoice.sender;
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
    const {
      subject, body, link, opener, openerTier, pitchTier,
      cta, personalizationBlocks, demoIncluded, requiredBlocks,
      personalizationClaims, verifiedFactIds, demoCta, approvedGuarantee,
      personalizationMetadata, subjectMetadata,
    } = built;

    // Validate the exact assembled body in every mode. Dry runs preview this
    // same normalized value; live runs fail closed and preserve the lead.
    const invalid = lead.emailTemplateId === ROOFING_SURVEY_TEMPLATE
      ? validateRoofingSurveyInitial({ subject, body })
      : validateColdEmail(lead, subject, body, link, {
        cta, personalizationBlocks, demoIncluded, requiredBlocks,
        personalizationClaims, verifiedFactIds, demoCta, approvedGuarantee,
        subjectMetadata,
      });
    if (invalid) {
      console.error(`✎ [draft] not sending step 1 → ${lead.email} — ${invalid}`);
      if (!DRY_RUN) {
        await withAuth(() => queueDraft(lead, {
          mode: 'draft', body, confidence: 0,
          reason: `cold email failed validation: ${invalid}`,
        }));
      }
      continue;
    }
    const validatedPersonalizationMetadata = personalizationMetadata
      ? { ...personalizationMetadata, validationStatus: 'valid' }
      : null;

    if (DRY_RUN) {
      const rawCo  = lead.company || '';
      const cleanCo = cleanCompanyName(rawCo);
      console.log(`— WOULD SEND (step 1) →  ${lead.email}  (${rawCo || lead.first || lead.id})`);
      if (rawCo && rawCo !== cleanCo) console.log(`   Company: "${rawCo}" → "${cleanCo}"`);
      console.log(`   Pitch:   ${pitchTier}`);
      const subjectLabel = subjectMetadata
        ? `level ${subjectMetadata.level}, ${subjectMetadata.angleId}`
        : `variant ${coldSubjectIndex(lead) + 1}/${COLD_SUBJECTS.length}`;
      console.log(`   Subject: ${subject}  [${subjectLabel}]`);
      console.log(`   Opener:  ${opener}  [${openerTier}]`);
      console.log(`   Link:    ${link}`);
      if (validatedPersonalizationMetadata) console.log(`   Personalization: ${JSON.stringify(validatedPersonalizationMetadata)}`);
      console.log('   ── FINAL SUBJECT ──');
      console.log(subject);
      console.log('   ── FINAL BODY ──');
      console.log(body);
      console.log('   ── END FINAL EMAIL ──\n');
      continue;
    }

    if (!SENDING_ENABLED) {
      console.log(`⛔ [kill-switch] would send (step 1) → ${lead.email}  (${cleanCompanyName(lead.company) || lead.id})`);
      console.log(`   Subject: ${subject}`);
      continue;
    }

    try {
      const attribution = coldSendAttribution(lead, 1, { personalizationMetadata: validatedPersonalizationMetadata });
      const delivery = await deliverOrdinaryColdStep({
        lead, step: 1, sender: selectedSender, subject, body, attribution,
        personalizationMetadata: validatedPersonalizationMetadata,
        activitiesForCycle: ownershipActivities,
      });
      if (!delivery.delivered) {
        console.warn(`⏸️  step-1 deferred → ${lead.email} (${delivery.reason})`);
        continue;
      }
      sent++;
      sendsBySender.set(selectedSender.id, (sendsBySender.get(selectedSender.id) || 0) + 1);
      console.log(`${delivery.recovered ? '♻️ Recovered' : '✅ Sent'} (step 1) → ${lead.email}  (${sent}/${effectiveCap})`);
    } catch (e) {
      console.error(`❌ Failed (step 1) → ${lead.email}: ${e.message}`);
    }

    if (sent < effectiveCap) {
      const d = jitter();
      console.log(`   …waiting ${Math.round(d / 1000)}s\n`);
      await sleep(d);
    }
  }

  // ── Follow-up refill (when initials leave successful-send space) ──────────
  for (; followUpIndex < followBatch.length; followUpIndex++) {
    const lead = followBatch[followUpIndex];
    if (sent >= effectiveCap) break;
    const suppressed = suppressionReason(lead);
    if (suppressed) {
      console.error(`🚫 [SUPPRESSED] refusing follow-up send → ${lead.email} (${cleanCompanyName(lead.company) || lead.id}) — notes contain ${suppressed}`);
      continue;
    }
    const gate = coldSendGate(lead, ownershipContext);
    if (!gate.verdict.allowed) {
      console.error(`🚫 [OWNERSHIP] refusing follow-up send → ${lead.email} — ${gate.verdict.reason}`);
      continue;
    }

    const currentStep = parseInt(lead.emailStep, 10);
    const nextStepNum = currentStep + 1;
    const template    = FOLLOW_UP_SEQUENCE[currentStep - 1];
    const body        = template.body(lead);
    const preview     = body.split('\n')[2] || '';
    let senderChoice;
    try { senderChoice = chooseSender({ lead, activities: ownershipActivities, senders: GMAIL_SENDERS, sendsToday: sendsBySender, step: nextStepNum }); }
    catch (error) { console.warn(`⏸️  follow-up deferred → ${lead.email} (${error.message})`); continue; }
    if (!senderChoice.sender) { console.warn(`⏸️  follow-up deferred → ${lead.email} (${senderChoice.reason})`); continue; }
    const selectedSender = senderChoice.sender;
    let thread;
    try {
      thread = await resolveColdFollowUpThread({ gmail: gmailForSender(selectedSender), lead, activities: ownershipActivities, expectedSenderId: selectedSender.id });
    } catch (error) {
      console.warn(`⏸️  follow-up deferred → ${lead.email} (Gmail thread verification failed: ${error.message})`);
      continue;
    }
    if (!thread) {
      console.warn(`⏸️  follow-up deferred → ${lead.email} (canonical Gmail thread could not be proven)`);
      continue;
    }
    const subject = thread.subject;

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
      const attribution = coldSendAttribution(lead, nextStepNum);
      const delivery = await deliverOrdinaryColdStep({
        lead, step: nextStepNum, sender: selectedSender, subject, body, attribution,
        activitiesForCycle: ownershipActivities, thread,
      });
      if (!delivery.delivered) {
        console.warn(`⏸️  follow-up deferred → ${lead.email} (${delivery.reason})`);
        continue;
      }
      sent++;
      sendsBySender.set(selectedSender.id, (sendsBySender.get(selectedSender.id) || 0) + 1);
      console.log(`${delivery.recovered ? '♻️ Recovered' : '✅ Sent'} (step ${nextStepNum}) → ${lead.email}  (${sent}/${effectiveCap})`);
    } catch (e) {
      console.error(`❌ Failed (step ${nextStepNum}) → ${lead.email}: ${e.message}`);
    }

    if (sent < effectiveCap) {
      const d = jitter();
      console.log(`   …waiting ${Math.round(d / 1000)}s\n`);
      await sleep(d);
    }
  }

  console.log(`\nDone. ${DRY_RUN ? `Evaluated ${totalCandidates} bounded candidate(s).` : `Sent ${sent}/${effectiveCap}; ${totalCandidates} bounded candidate(s) available.`}`);
}

run().catch(e => {
  console.error('\n[FATAL]', e.message);
  process.exit(1);
});
