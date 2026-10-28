'use strict';

// Read-only Jole v5 migration snapshot and dry render. Reads the Google Sheets
// CRM (ColdEmail), the activity ledger (ColdCallActivity) and the Supabase
// outreach corpus with read-only credentials, then, for every Jole lead,
// resolves the copy version of its next step and renders that step with the
// code in this checkout. Nothing is written and nothing is sent.
//
//   OUTPUT_PATH=<private JSON path> node scripts/jole-v5-migration-dry-run.js
//
// The footer's postal address is a placeholder unless
// JOLE_COMMERCIAL_MAILING_ADDRESS is set; copy and claims are what production renders.
require('dotenv').config({ path: process.env.SALESPIPELINE_ENV_FILE || '.env' });
const fs = require('node:fs');
const { google } = require('googleapis');
const { readOutreachCorpus } = require('../integrations/outreach-state');
const { COLD_CALL_ACTIVITY_SHEET, COLD_CALL_ACTIVITY_HEADER } = require('../integrations/cold-call-pipeline');
const { resolveJoleCopyVersion, joleThreadCopyVersion } = require('../integrations/clients/jole-copy');
const { jolePersonalizationFor, joleFollowUpHold } = require('../integrations/clients/jole-personalization');
const { renderClientLeadEmail, clientSelectionHold } = require('../integrations/clients/client-email');
const { nextFollowUp } = require('../integrations/sequence-timing');

const OUTBOUND = /(?:email_sent|follow_up_sent|sequence_step_sent|booking_link_sent|human_response_sent|send_reserved|send_uncertain)/;
const meta = row => { try { return JSON.parse(row.metadata || '{}') || {}; } catch (_) { return {}; } };
const isJole = lead => lead.clientId === 'jole' || lead.emailTemplateId === 'jole-industrial-employer-v1';
const count = (items, key) => items.reduce((acc, item) => { const k = key(item); acc[k] = (acc[k] || 0) + 1; return acc; }, {});

function leadState(lead, rows) {
  const step = Number(lead.emailStep) || 0;
  const status = String(lead.emailStatus || '').trim();
  const stage = String(lead.stage || '').trim();
  if (/^(unsub|replied|bounced)$/i.test(stage) || /^replied$/i.test(status)) return 'reply_or_suppression_hold';
  if (rows.some(row => /bounce|unsubscribe|_reply|reply_classified/i.test(row.eventType))) return 'reply_or_suppression_hold';
  if (step >= 3 || /^done$/i.test(status)) return 'completed';
  if (step === 2) return 'pending_email_3';
  if (step === 1) return 'pending_email_2';
  if (rows.some(row => OUTBOUND.test(row.eventType))) return 'unsent_with_outbound_evidence';
  return stage === 'Queued' ? 'uncontacted_queued' : `uncontacted_${stage.toLowerCase() || 'blank'}`;
}

function unresolvedReservations(lead, rows) {
  const failed = new Set(rows.filter(row => /_send_failed$/.test(row.eventType)).map(row => meta(row).reservationEventId));
  const sentSteps = new Set(rows.filter(row => ['initial_email_sent', 'follow_up_sent'].includes(row.eventType))
    .map(row => (row.eventType === 'initial_email_sent' ? 1 : Number(meta(row).step ?? meta(row).sequenceStep))));
  return rows.filter(row => /send_reserved$/.test(row.eventType) && !failed.has(row.eventId) && !sentSteps.has(Number(meta(row).step)))
    .map(row => ({ eventId: row.eventId, step: Number(meta(row).step), copyVersion: meta(row).copyVersion || '' }));
}

async function main() {
  if (!process.env.OUTPUT_PATH) throw new Error('OUTPUT_PATH must name a private local JSON file');
  const sheets = google.sheets({ version: 'v4', auth: new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  }) });
  const [crm, ledger] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId: process.env.SPREADSHEET_ID, range: 'ColdEmail!A:Z' }),
    sheets.spreadsheets.values.get({ spreadsheetId: process.env.SPREADSHEET_ID, range: `${COLD_CALL_ACTIVITY_SHEET}!A:J` }),
  ]);
  const [header, ...crmRows] = crm.data.values || [];
  const sheetLeads = crmRows.map(row => Object.fromEntries(header.map((field, i) => [field, row[i] || ''])));
  const activities = (ledger.data.values || []).slice(1)
    .map(row => Object.fromEntries(COLD_CALL_ACTIVITY_HEADER.map((field, i) => [field, row[i] || ''])));
  const corpus = await readOutreachCorpus({ env: { ...process.env, SUPABASE_OUTREACH_MODE: 'primary' } });
  if (!corpus.ok) throw new Error(`Supabase corpus: ${corpus.reason}`);
  const supabase = new Map(corpus.leads.map(lead => [lead.id, lead]));

  const env = { ...process.env, JOLE_COMMERCIAL_MAILING_ADDRESS: process.env.JOLE_COMMERCIAL_MAILING_ADDRESS || 'SIMULATION ADDRESS, Brownsville, TX 78526' };
  const byLead = new Map();
  for (const row of activities) {
    const key = row.sourceLeadId || String(row.leadId || '').replace(/^CE-/, '');
    if (!byLead.has(key)) byLead.set(key, []);
    byLead.get(key).push(row);
  }
  const now = Date.now();
  const records = sheetLeads.filter(isJole).map(lead => {
    const rows = byLead.get(lead.id) || [];
    const state = leadState(lead, rows);
    const mirror = supabase.get(lead.id);
    const drift = mirror ? ['stage', 'emailStep', 'emailStatus', 'lastEmailedAt', 'senderInboxId']
      .filter(field => String(mirror[field] ?? '') !== String(lead[field] ?? '')) : ['<missing>'];
    const resolved = resolveJoleCopyVersion(lead, activities);
    const record = {
      leadId: lead.id, company: lead.company, stage: lead.stage, emailStep: lead.emailStep, emailStatus: lead.emailStatus,
      senderInboxId: lead.senderInboxId, state, threadCopyVersion: joleThreadCopyVersion(lead, activities),
      nextStep: resolved.step, nextCopyVersion: resolved.copyVersion, versionReason: resolved.reason,
      unresolvedReservations: unresolvedReservations(lead, rows), mirrorDrift: drift,
      sentSteps: rows.filter(row => ['initial_email_sent', 'follow_up_sent'].includes(row.eventType))
        .map(row => ({ step: row.eventType === 'initial_email_sent' ? 1 : Number(meta(row).step ?? meta(row).sequenceStep), copyVersion: meta(row).copyVersion || '', at: row.occurredAt })),
    };
    if (state === 'completed' || state === 'reply_or_suppression_hold') return { ...record, outcome: 'no_further_send' };
    if (state.startsWith('pending_email')) {
      const due = nextFollowUp(lead, { activities });
      record.dueAt = due?.dueAtIso || null;
      record.alreadySent = Boolean(due?.alreadySent);
      const hold = joleFollowUpHold(lead);
      if (hold) return { ...record, outcome: 'follow_up_hold', reason: hold };
    } else if (state === 'uncontacted_queued' || state.startsWith('uncontacted_')) {
      const hold = clientSelectionHold(lead);
      if (hold) return { ...record, outcome: 'selection_hold', reason: hold };
    }
    try {
      const email = renderClientLeadEmail(lead, resolved.step, { env, now, activities });
      const p = jolePersonalizationFor(lead, activities, { now });
      return { ...record, outcome: 'renders', copyVersion: email.copyVersion, mode: email.personalization?.mode || null,
        personalizationSource: p.source, subject: email.subject, body: email.body };
    } catch (error) {
      return { ...record, outcome: 'refused', reason: error.message, code: error.code || '' };
    }
  });

  const summary = {
    capturedAt: new Date(now).toISOString(), totalJole: records.length,
    stage: count(records, r => r.stage), state: count(records, r => r.state),
    threadCopyVersion: count(records.filter(r => r.threadCopyVersion), r => r.threadCopyVersion),
    sentStepVersions: count(records.flatMap(r => r.sentSteps), s => `step${s.step}:${s.copyVersion || '(none)'}`),
    outcomeByState: count(records, r => `${r.state} -> ${r.outcome}${r.outcome === 'renders' ? `:${r.copyVersion}:${r.mode}` : ''}`),
    refusals: count(records.filter(r => r.outcome === 'refused'), r => r.reason.replace(/[A-Za-z0-9 ,.&'-]+ (in|at) [A-Z][A-Za-z .']+, [A-Z]{2}/, '<claim>')),
    unresolvedReservations: records.filter(r => r.unresolvedReservations.length).map(r => ({ leadId: r.leadId, reservations: r.unresolvedReservations })),
    nextVersionForUnattemptedSteps: count(records.filter(r => r.outcome === 'renders'), r => `${r.versionReason}:${r.copyVersion}`),
    mirrorDrift: records.filter(r => r.mirrorDrift.length).map(r => ({ leadId: r.leadId, fields: r.mirrorDrift })),
  };
  fs.writeFileSync(process.env.OUTPUT_PATH, JSON.stringify({ summary, records }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { leadState, unresolvedReservations };
