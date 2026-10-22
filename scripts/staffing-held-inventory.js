'use strict';

// Read-only inventory of every never-sent staffing lead outside Queued.
// Run with OUTPUT_PATH=<private JSON path> node scripts/staffing-held-inventory.js.
require('dotenv').config({ path: process.env.SALESPIPELINE_ENV_FILE || '.env' });
const fs = require('node:fs');
const { google } = require('googleapis');
const { readOutreachCorpus } = require('../integrations/outreach-state');
const { staffingReviewStatus } = require('../integrations/staffing-campaign');

const COLUMNS = ['id', 'company', 'contactName', 'email', 'city', 'tradeType', 'website', 'stage',
  'emailStatus', 'lastEmailedAt', 'emailStep', 'notes', 'reviewCount', 'rating', 'tier',
  'siteContext', 'campaign', 'campaign_notes', 'enrichment_attempted', 'leadNiche',
  'senderInboxId', 'emailTemplateId', 'routingRequired', 'intendedCampaignVersion'];
const isStaffing = lead => String(lead.leadNiche || '').toLowerCase().includes('staffing');
const neverSent = lead => !lead.lastEmailedAt && !Number(lead.emailStep)
  && !/^(emailed|done|replied)$/i.test(String(lead.emailStatus || ''));

async function main() {
  const corpus = await readOutreachCorpus({ env: { ...process.env, SUPABASE_OUTREACH_MODE: 'primary' } });
  if (!corpus.ok) throw new Error(`Supabase corpus: ${corpus.reason}`);
  const staffing = corpus.leads.filter(isStaffing);
  const held = staffing.filter(lead => neverSent(lead) && lead.stage !== 'Queued');
  const sheets = google.sheets({ version: 'v4', auth: new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  }) });
  const values = (await sheets.spreadsheets.values.get({ spreadsheetId: process.env.SPREADSHEET_ID,
    range: 'ColdEmail!A:X' })).data.values || [];
  const byId = new Map(values.slice(1).map((row, i) => [row[0], { row: i + 2,
    lead: Object.fromEntries(COLUMNS.map((field, j) => [field, row[j] || ''])) }]));
  const records = held.map(lead => {
    const mirror = byId.get(lead.id);
    const mirrorDiff = mirror ? COLUMNS.filter(field => String(lead[field] || '') !== mirror.lead[field]) : COLUMNS;
    const tag = staffingReviewStatus(lead);
    return { leadId: lead.id, company: lead.company, email: lead.email, stage: lead.stage,
      fit: tag?.fit || (/fit=ICP_REVIEW/.test(lead.campaign_notes) ? 'ICP_REVIEW' : null),
      personalization: tag?.personalization || (/personalization=NONE_REQUIRED/.test(lead.campaign_notes) ? 'NONE_REQUIRED' : null),
      routingReady: tag?.routingReady ?? false, manualHold: String(lead.notes || '').includes('[MANUAL HOLD]'),
      lead, mirrorRow: mirror?.row || null, mirrorDiff };
  });
  const out = { capturedAt: new Date().toISOString(), canonicalSource: 'Supabase outreach_leads',
    mirrorSource: 'Google Sheets ColdEmail', totalStaffing: staffing.length,
    neverSentStaffing: staffing.filter(neverSent).length, queuedNeverSent: staffing.filter(lead => neverSent(lead) && lead.stage === 'Queued').length,
    heldCount: records.length, records };
  if (!process.env.OUTPUT_PATH) throw new Error('OUTPUT_PATH must name a private local JSON file');
  fs.writeFileSync(process.env.OUTPUT_PATH, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ capturedAt: out.capturedAt, totalStaffing: out.totalStaffing,
    neverSentStaffing: out.neverSentStaffing, queuedNeverSent: out.queuedNeverSent,
    heldCount: out.heldCount, mirrorDrift: records.filter(r => r.mirrorDiff.length).length,
    missingMirror: records.filter(r => !r.mirrorRow).length }));
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { isStaffing, neverSent };
