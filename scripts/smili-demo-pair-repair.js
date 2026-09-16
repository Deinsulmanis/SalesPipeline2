'use strict';

/**
 * smili-demo-pair-repair.js — the one-off repair for the Smili Dental fan-out.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT HAPPENED
 *
 * On 2026-09-14 one visitor opened one proposal link — /p/62506e874e, which
 * resolves to Smili Dental - Midtown and to no other lead — and played both
 * clips (DemoPlays rows 42 and 43, one IP, one user agent, 14 seconds apart).
 * The attribution deployed at that moment matched plays to leads by cleaned
 * company name. The four Smili locations share one, so that single session
 * persisted a canonical demo pair for ALL FOUR. Three are false.
 *
 * WHAT THIS DOES, IN ORDER, AND WHY THE ORDER IS NOT OPTIONAL
 *
 *   1. intent-fired   IntentFired rows for all four, at the real times the
 *                     operator sent by hand. This is the duplicate-send LOCK:
 *                     the agent checks it in three separate places, so once
 *                     written no pass can queue a booking link for these leads.
 *   2. outbound       The four manual Gmail messages as canonical
 *                     human_response_sent events, by attestation (they are
 *                     openers in silent threads, which a sweep must refuse).
 *   3. retract        demo_pair_retracted for the three FALSE pairs. Midtown's
 *                     pair is true and is kept.
 *   4. token-backfill 62506e874e into DemoPlays column G for rows 42 and 43, so
 *                     the surviving evidence names one lead and the recurring
 *                     "smili dental match 4 leads" ambiguity ends.
 *
 * Step 4 is the dangerous one: it makes Midtown's pair re-derivable, so the only
 * remaining block on a booking-link send would be the missing sender. That is
 * why it refuses to run until step 1 has locked every lead, and why every phase
 * re-reads live state rather than trusting an earlier phase's report.
 *
 * SAFETY
 *   * Dry run by default. Writing needs --apply AND --confirm-no-send.
 *   * Read-only Sheets scope unless --apply is given.
 *   * Nothing here sends email, reserves a send, or assigns a sender. There is
 *     no provider send client in this file at all.
 *   * Every write is idempotent: IntentFired rows are keyed by lead, activity
 *     event ids are derived from the message or the event they supersede, and
 *     the token cells are compared before they are written.
 *   * No row is ever deleted or overwritten except the two empty token cells.
 */

require('dotenv').config();
const { google } = require('googleapis');
const {
  activitiesForLead, demoPairEventFor, hasUndeliveredDemoPair, buildDemoPairRetraction,
} = require('../integrations/demo-intent-state');
const { planOutboundActivity, OUTCOME } = require('../integrations/human-outbound');
const { mirrorEvents } = require('../integrations/supabase-mirror');

const ACTIVITY_HEADER = ['eventId', 'leadId', 'sourceLeadId', 'email', 'company', 'eventType', 'occurredAt', 'subject', 'content', 'metadata'];
const COLD_HEADER = ['id', 'company', 'contactName', 'email', 'city', 'tradeType', 'website', 'stage', 'emailStatus', 'lastEmailedAt', 'emailStep', 'notes', 'reviewCount', 'rating', 'tier', 'siteContext', 'campaign', 'campaign_notes', 'enrichment_attempted', 'leadNiche', 'senderInboxId', 'emailTemplateId', 'routingRequired', 'intendedCampaignVersion'];
const INTENT_TRIGGER = 'both-audios';
const LEAD_TOKEN = '62506e874e';

/** The lead the token resolves to. Its pair is TRUE and is never retracted. */
const PROVEN_LEAD_ID = 'mstpu1fb8hj6s3dhrwx';

/**
 * The four manual sends, as read from the Gmail account that owns the threads
 * (deins@scalelabai.ca). Message and thread ids are the provider's own, and are
 * what makes each record replay-safe and auditable.
 */
const MANIFEST = Object.freeze([
  { leadId: 'mstpu1fb8hj6s3dhrwx', email: 'info@mtsmili.com', gmailMessageId: '1a0a693938f5471a', gmailThreadId: '1a01afc6869786fe', sentAt: '2026-09-15T19:38:04.000Z' },
  { leadId: 'mstpw5pp8boj0xk97wy', email: 'info@prsmili.com', gmailMessageId: '1a0a68e48328a0c1', gmailThreadId: '1a02041fcc67d17d', sentAt: '2026-09-15T19:32:17.000Z' },
  { leadId: 'mstpw6d2e1kmio8rhl', email: 'info@pcmsmili.com', gmailMessageId: '1a0a6954ff5a32c4', gmailThreadId: '1a0205a287a71762', sentAt: '2026-09-15T19:39:58.000Z' },
  { leadId: 'mstpw6d2tkpq0wka76', email: 'info@srdsmili.com', gmailMessageId: '1a0a6946c106cefb', gmailThreadId: '1a02043849aa77b8', sentAt: '2026-09-15T19:39:00.000Z' },
]);
const MANUAL_SUBJECT = 'Re: A quick demo I built for Smili Dental';

/** The raw play rows the fan-out came from, with the evidence that identifies them. */
const DEMO_PLAY_ROWS = Object.freeze([
  { row: 42, timestamp: '2026-09-14T18:40:29.887Z', ip: '208.181.179.150', audioType: 'intro' },
  { row: 43, timestamp: '2026-09-14T18:40:43.453Z', ip: '208.181.179.150', audioType: 'demo' },
]);

const RETRACTION_REASON = 'company-name fan-out: DemoPlays rows 42-43 are one session from 208.181.179.150 that opened /p/62506e874e, which resolves to lead mstpu1fb8hj6s3dhrwx (Smili Dental - Midtown) alone';

const rowObjects = (rows, header) => (rows || []).slice(1)
  .map((row, index) => Object.assign(Object.fromEntries(header.map((field, i) => [field, row[i] || ''])), { _row: index + 2 }));
const norm = value => String(value || '').trim().toLowerCase();
const firedKey = leadId => `${leadId}|${INTENT_TRIGGER}`;

/** Company as the agent writes it into IntentFired: the name before a location suffix. */
function cleanCompanyName(raw) {
  if (!raw) return '';
  let cutAt = raw.length;
  for (const sep of ['|', ' - ', ' • ', ' · ', ' – ', ' — ']) {
    const idx = raw.indexOf(sep);
    if (idx !== -1) cutAt = Math.min(cutAt, idx);
  }
  return raw.slice(0, cutAt).trim() || raw.trim();
}

/** Resolve the manifest against live ColdEmail rows. Identity must match exactly. */
function resolveLeads(cold) {
  return MANIFEST.map(entry => {
    const lead = cold.find(row => row.id === entry.leadId) || null;
    if (!lead) return { entry, lead: null, refusal: `lead ${entry.leadId} is not in ColdEmail` };
    if (norm(lead.email) !== norm(entry.email)) {
      return { entry, lead: null, refusal: `lead ${entry.leadId} now holds ${lead.email}, not ${entry.email}` };
    }
    return { entry, lead, refusal: '' };
  });
}

// ── PHASE 1 ──────────────────────────────────────────────────────────────────
/** IntentFired rows for leads that do not already have one. */
function planIntentFired(resolved, firedRows) {
  const existing = new Set((firedRows || []).slice(1)
    .filter(row => row[1]).map(row => firedKey(row[1])));
  const writes = [];
  const skipped = [];
  const refusals = [];
  for (const { entry, lead, refusal } of resolved) {
    if (refusal) { refusals.push({ leadId: entry.leadId, refusal }); continue; }
    if (existing.has(firedKey(entry.leadId))) { skipped.push({ leadId: entry.leadId, reason: 'already fired' }); continue; }
    writes.push({
      leadId: entry.leadId,
      row: [entry.sentAt, entry.leadId, cleanCompanyName(lead.company), lead.email, INTENT_TRIGGER],
    });
  }
  return { writes, skipped, refusals };
}

// ── PHASE 2 ──────────────────────────────────────────────────────────────────
/**
 * The manual sends as canonical human_response_sent events.
 *
 * These are openers in threads the prospect never wrote into, so the ingestion
 * rule refuses them unless the exact provider message id is attested. Attesting
 * the manifest's ids is the whole point of this phase.
 */
function planAttestedOutbound(resolved, activities) {
  const leadsByEmail = new Map();
  const existingActivitiesByLead = new Map();
  for (const { lead } of resolved) {
    if (!lead) continue;
    leadsByEmail.set(norm(lead.email), lead);
    existingActivitiesByLead.set(lead.id, activitiesForLead(lead, activities));
  }
  const context = {
    leadsByEmail,
    leadIdByThread: new Map(),
    threadsWithInbound: new Set(),
    existingActivitiesByLead,
    attestedMessageIds: new Set(MANIFEST.map(entry => entry.gmailMessageId)),
  };
  const writes = [];
  const skipped = [];
  const refusals = [];
  for (const { entry, lead, refusal } of resolved) {
    if (refusal) { refusals.push({ leadId: entry.leadId, refusal }); continue; }
    const plan = planOutboundActivity({
      id: entry.gmailMessageId, threadId: entry.gmailThreadId,
      to: [lead.email], subject: MANUAL_SUBJECT, sentAt: entry.sentAt,
    }, context);
    if (plan.outcome === OUTCOME.ALREADY_RECORDED) { skipped.push({ leadId: entry.leadId, reason: 'already recorded' }); continue; }
    if (plan.outcome !== OUTCOME.PROPOSED) { refusals.push({ leadId: entry.leadId, refusal: `${plan.outcome}: ${plan.reason}` }); continue; }
    writes.push({ leadId: entry.leadId, activity: plan.activity });
  }
  return { writes, skipped, refusals };
}

// ── PHASE 3 ──────────────────────────────────────────────────────────────────
/**
 * Retract the three false pairs.
 *
 * Gated on phases 1 and 2 for this lead: a retraction removes the pending pair,
 * and the lock plus the recorded manual send are what guarantee that removal
 * can never be read as "this lead was never contacted".
 */
function planRetractions(resolved, activities, firedRows, { retractedAt } = {}) {
  if (!String(retractedAt || '').trim()) throw new Error('retraction requires the instant it was retracted at');
  const fired = new Set((firedRows || []).slice(1).filter(row => row[1]).map(row => firedKey(row[1])));
  const writes = [];
  const skipped = [];
  const refusals = [];
  for (const { entry, lead, refusal } of resolved) {
    if (refusal) { refusals.push({ leadId: entry.leadId, refusal }); continue; }
    if (entry.leadId === PROVEN_LEAD_ID) {
      skipped.push({ leadId: entry.leadId, reason: 'the token proves this play — never retracted' });
      continue;
    }
    const mine = activitiesForLead(lead, activities);
    if (!fired.has(firedKey(entry.leadId))) {
      refusals.push({ leadId: entry.leadId, refusal: 'phase 1 has not locked this lead' });
      continue;
    }
    if (!mine.some(row => String(row.eventId || '') === `gmail-outbound:${entry.gmailMessageId}`)) {
      refusals.push({ leadId: entry.leadId, refusal: 'phase 2 has not recorded this lead\'s manual send' });
      continue;
    }
    const pair = demoPairEventFor(lead, mine);
    if (!pair) { skipped.push({ leadId: entry.leadId, reason: 'no active pair — already retracted' }); continue; }
    writes.push({
      leadId: entry.leadId,
      activity: buildDemoPairRetraction(lead, pair, {
        reason: RETRACTION_REASON,
        retractedAt,
        evidence: { provenLeadId: PROVEN_LEAD_ID, leadToken: LEAD_TOKEN, demoPlaysRows: DEMO_PLAY_ROWS.map(r => r.row), proposalOpensRow: 220 },
      }),
    });
  }
  return { writes, skipped, refusals };
}

// ── PHASE 4 ──────────────────────────────────────────────────────────────────
/**
 * Stamp the token onto the two surviving play rows.
 *
 * Refuses unless every lead is locked and recorded and NONE is still a pending
 * demo-intent candidate, because this is the step that makes Midtown's pair
 * re-derivable again.
 */
function planTokenBackfill(resolved, demoRows, activities, firedRows) {
  const refusals = [];
  const fired = new Set((firedRows || []).slice(1).filter(row => row[1]).map(row => firedKey(row[1])));
  for (const { entry, lead, refusal } of resolved) {
    if (refusal) { refusals.push({ leadId: entry.leadId, refusal }); continue; }
    if (!fired.has(firedKey(entry.leadId))) refusals.push({ leadId: entry.leadId, refusal: 'not locked by phase 1' });
    const mine = activitiesForLead(lead, activities);
    if (!mine.some(row => String(row.eventId || '') === `gmail-outbound:${entry.gmailMessageId}`)) {
      refusals.push({ leadId: entry.leadId, refusal: 'manual send not recorded by phase 2' });
    }
    if (hasUndeliveredDemoPair(lead, mine) && !fired.has(firedKey(entry.leadId))) {
      refusals.push({ leadId: entry.leadId, refusal: 'still a pending demo-intent candidate' });
    }
  }

  const writes = [];
  const skipped = [];
  for (const expected of DEMO_PLAY_ROWS) {
    const actual = (demoRows || [])[expected.row - 1];   // 1-based sheet row
    if (!actual) { refusals.push({ row: expected.row, refusal: 'row no longer exists' }); continue; }
    const [timestamp, company, , ip, , audioType, token] = actual;
    const mismatch = String(timestamp || '') !== expected.timestamp
      || String(ip || '') !== expected.ip
      || (String(audioType || '').trim().toLowerCase() || 'demo') !== expected.audioType
      || norm(company).replace(/[^a-z0-9]/g, '') !== 'smilidental';
    if (mismatch) {
      refusals.push({ row: expected.row, refusal: `evidence no longer matches (timestamp ${timestamp}, ip ${ip}, audio ${audioType}, company ${company})` });
      continue;
    }
    if (String(token || '').trim()) {
      skipped.push({ row: expected.row, reason: `token already present: ${token}` });
      continue;
    }
    writes.push({ range: `DemoPlays!G${expected.row}`, value: LEAD_TOKEN });
  }
  return { writes, skipped, refusals };
}

/** The operator-facing checks, answered from live state. */
function verificationReport(resolved, activities, firedRows, demoRows) {
  const fired = new Set((firedRows || []).slice(1).filter(row => row[1]).map(row => firedKey(row[1])));
  const leads = resolved.filter(item => item.lead).map(({ entry, lead }) => {
    const mine = activitiesForLead(lead, activities);
    return {
      leadId: lead.id, email: lead.email,
      demoEngaged: Boolean(demoPairEventFor(lead, mine)),
      manualSendRecorded: mine.some(row => String(row.eventId || '') === `gmail-outbound:${entry.gmailMessageId}`),
      lockedAgainstResend: fired.has(firedKey(lead.id)),
      pendingDemoIntent: hasUndeliveredDemoPair(lead, mine) && !fired.has(firedKey(lead.id)),
      bookingLinkSent: mine.some(row => String(row.eventType || '') === 'booking_link_sent'),
      senderInboxId: lead.senderInboxId || '',
    };
  });
  const tokened = DEMO_PLAY_ROWS.every(expected => String(((demoRows || [])[expected.row - 1] || [])[6] || '').trim() === LEAD_TOKEN);
  return {
    leads,
    onlyProvenLeadIsDemoEngaged: leads.every(item => item.demoEngaged === (item.leadId === PROVEN_LEAD_ID)),
    allManualSendsRecorded: leads.every(item => item.manualSendRecorded),
    allLockedAgainstResend: leads.every(item => item.lockedAgainstResend),
    nonePending: leads.every(item => !item.pendingDemoIntent),
    noSyntheticBookingLink: leads.every(item => !item.bookingLinkSent),
    playRowsCarryToken: tokened,
  };
}

// ── RUNTIME ──────────────────────────────────────────────────────────────────

const PHASES = ['intent-fired', 'outbound', 'retract', 'token-backfill', 'verify'];

async function main() {
  const args = process.argv.slice(2);
  const phaseArg = args.find(arg => arg.startsWith('--phase='));
  const phase = phaseArg ? phaseArg.slice('--phase='.length) : 'verify';
  const apply = args.includes('--apply');
  const confirmed = args.includes('--confirm-no-send');
  if (!PHASES.includes(phase)) throw new Error(`--phase must be one of ${PHASES.join(', ')}`);
  if (apply && !confirmed) throw new Error('--apply requires --confirm-no-send');
  if (!process.env.SPREADSHEET_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new Error('SPREADSHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON are required');
  }

  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: [apply ? 'https://www.googleapis.com/auth/spreadsheets' : 'https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const api = google.sheets({ version: 'v4', auth });
  const read = async () => {
    const snapshot = await api.spreadsheets.values.batchGet({
      spreadsheetId: process.env.SPREADSHEET_ID,
      ranges: ['ColdEmail!A:X', 'ColdCallActivity!A:J', 'IntentFired!A:E', 'DemoPlays!A:G'],
    });
    const at = index => snapshot.data.valueRanges?.[index]?.values || [];
    return {
      cold: rowObjects(at(0), COLD_HEADER),
      activities: rowObjects(at(1), ACTIVITY_HEADER),
      firedRows: at(2),
      demoRows: at(3),
    };
  };

  const state = await read();
  const resolved = resolveLeads(state.cold);
  const report = { phase, apply, applied: [] };

  if (phase === 'verify') {
    report.verification = verificationReport(resolved, state.activities, state.firedRows, state.demoRows);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const appendActivities = async writes => {
    if (!writes.length) return;
    // Re-read immediately before the append so a concurrent agent pass cannot be
    // mistaken for permission to write a second copy.
    const fresh = rowObjects((await api.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID, range: 'ColdCallActivity!A:J',
    })).data.values || [], ACTIVITY_HEADER);
    const seen = new Set(fresh.map(row => String(row.eventId || '')));
    const pending = writes.filter(item => !seen.has(item.activity.eventId));
    if (!pending.length) return;
    const values = pending.map(({ activity }) => ACTIVITY_HEADER.map(field => {
      const value = activity[field];
      if (field === 'metadata' && value && typeof value === 'object') return JSON.stringify(value);
      return String(value === undefined || value === null ? '' : value);
    }));
    await api.spreadsheets.values.append({
      spreadsheetId: process.env.SPREADSHEET_ID, range: 'ColdCallActivity!A:J',
      valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values },
    });
    const mirror = await mirrorEvents(pending.map(item => ({
      ...item.activity,
      metadata: typeof item.activity.metadata === 'object' ? JSON.stringify(item.activity.metadata) : item.activity.metadata,
    })));
    report.applied.push({ activities: pending.map(item => item.activity.eventId), mirrored: mirror.mirrored || 0, mirrorDeferred: mirror.failed || 0 });
  };

  if (phase === 'intent-fired') {
    const plan = planIntentFired(resolved, state.firedRows);
    report.plan = plan;
    if (apply && plan.writes.length) {
      await api.spreadsheets.values.append({
        spreadsheetId: process.env.SPREADSHEET_ID, range: 'IntentFired!A:E',
        valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
        requestBody: { values: plan.writes.map(item => item.row) },
      });
      report.applied.push({ intentFired: plan.writes.map(item => item.leadId) });
    }
  }

  if (phase === 'outbound') {
    const plan = planAttestedOutbound(resolved, state.activities);
    report.plan = plan;
    if (apply) await appendActivities(plan.writes);
  }

  if (phase === 'retract') {
    const plan = planRetractions(resolved, state.activities, state.firedRows, { retractedAt: new Date().toISOString() });
    report.plan = plan;
    if (apply) await appendActivities(plan.writes);
  }

  if (phase === 'token-backfill') {
    const plan = planTokenBackfill(resolved, state.demoRows, state.activities, state.firedRows);
    report.plan = plan;
    if (plan.refusals.length) throw new Error(`token backfill refused: ${JSON.stringify(plan.refusals)}`);
    if (apply && plan.writes.length) {
      // Re-read the exact cells immediately before writing; abort on any drift.
      const check = (await api.spreadsheets.values.get({
        spreadsheetId: process.env.SPREADSHEET_ID, range: 'DemoPlays!A:G',
      })).data.values || [];
      const recheck = planTokenBackfill(resolved, check, state.activities, state.firedRows);
      if (recheck.refusals.length || recheck.writes.length !== plan.writes.length) {
        throw new Error(`DemoPlays changed under the repair: ${JSON.stringify(recheck.refusals)}`);
      }
      await api.spreadsheets.values.batchUpdate({
        spreadsheetId: process.env.SPREADSHEET_ID,
        requestBody: {
          valueInputOption: 'RAW',
          data: plan.writes.map(item => ({ range: item.range, values: [[item.value]] })),
        },
      });
      report.applied.push({ tokenCells: plan.writes.map(item => item.range) });
    }
  }

  const after = await read();
  report.verification = verificationReport(resolveLeads(after.cold), after.activities, after.firedRows, after.demoRows);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  MANIFEST, DEMO_PLAY_ROWS, PROVEN_LEAD_ID, LEAD_TOKEN, RETRACTION_REASON,
  resolveLeads, planIntentFired, planAttestedOutbound, planRetractions,
  planTokenBackfill, verificationReport, cleanCompanyName,
};
