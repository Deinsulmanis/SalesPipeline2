'use strict';

// Apply the reviewed private plan through the canonical Supabase CAS path,
// then mirror only committed campaign_notes cells to Google Sheets.
require('dotenv').config({ path: process.env.SALESPIPELINE_ENV_FILE || '.env' });
const fs = require('node:fs');
const { google } = require('googleapis');
const { applyLeadChanges, readOutreachCorpus } = require('../integrations/outreach-state');
const { staffingHoldStatus, staffingHoldInconsistencies } = require('../integrations/staffing-hold');
const { isStaffing, neverSent } = require('./staffing-held-inventory');

async function main() {
  if (process.env.APPLY_STAFFING_HOLDS !== 'yes') throw new Error('Set APPLY_STAFFING_HOLDS=yes after reviewing exact plan');
  const plan = JSON.parse(fs.readFileSync(process.env.PLAN_PATH, 'utf8'));
  if (plan.changes.length !== 63 || plan.fitCorrections !== 32 || plan.touchedJole
    || plan.touchedSentOrContacted || plan.touchedQueued || plan.touchedStage
    || plan.touchedNotes || plan.touchedPersonalization || plan.touchedRoutingReady) {
    throw new Error('Mutation plan does not match audited scope');
  }
  const env = { ...process.env, SUPABASE_OUTREACH_MODE: 'primary', SUPABASE_OUTREACH_WRITES: 'supabase' };
  const before = await readOutreachCorpus({ env });
  if (!before.ok) throw new Error(`Canonical preflight failed: ${before.reason}`);
  const byId = new Map(before.leads.map(lead => [lead.id, lead]));
  const currentHeld = before.leads.filter(lead => isStaffing(lead) && neverSent(lead) && lead.stage !== 'Queued');
  if (currentHeld.length !== 63 || currentHeld.some(lead => !plan.changes.some(change => change.leadId === lead.id))) {
    throw new Error('Held set moved since the mutation plan');
  }
  for (const change of plan.changes) {
    const lead = byId.get(change.leadId);
    if (!lead || String(lead.clientId || 'scalelab') !== 'scalelab'
      || !isStaffing(lead) || !neverSent(lead) || !['Import', 'Review'].includes(lead.stage)) {
      throw new Error(`Out-of-scope lead in plan ${change.leadId}`);
    }
    if (Object.entries(change.expectedState).some(([field, value]) => String(lead[field] || '') !== String(value))) {
      throw new Error(`Canonical lead changed since plan ${change.leadId}`);
    }
    if (Object.keys(change.patch).join(',') !== 'campaign_notes'
      || staffingHoldStatus({ campaign_notes: change.patch.campaign_notes })?.reason !== change.reason
      || staffingHoldInconsistencies({ ...lead, ...change.patch }).length) {
      throw new Error(`Patch invalid for ${change.leadId}`);
    }
  }
  const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheetsClient = google.sheets({ version: 'v4', auth });
  const ids = (await sheetsClient.spreadsheets.values.get({ spreadsheetId: process.env.SPREADSHEET_ID,
    range: 'ColdEmail!A:A' })).data.values || [];
  for (const change of plan.changes) {
    if (String(ids[change.row - 1]?.[0] || '') !== change.leadId) {
      throw new Error(`Sheets mirror row moved for ${change.leadId}`);
    }
  }
  const result = await applyLeadChanges(plan.changes.map(change => ({
    leadId: change.leadId, patch: change.patch, row: change.row, expectedState: change.expectedState,
  })), { sheetsClient, spreadsheetId: process.env.SPREADSHEET_ID, env });
  const report = { appliedAt: new Date().toISOString(), plannedAt: plan.plannedAt,
    summary: result.summary, outcomes: result.results.map(row => ({
      leadId: row.leadId, status: row.status, reason: row.reason, revision: row.revision, mirrored: row.mirrored,
    })) };
  fs.writeFileSync(process.env.APPLY_REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ appliedAt: report.appliedAt, summary: report.summary,
    mirrorFailures: report.outcomes.filter(row => row.status === 'succeeded' && !row.mirrored).length }));
  if (report.outcomes.some(row => !['succeeded', 'unchanged'].includes(row.status))
    || report.outcomes.some(row => row.status === 'succeeded' && !row.mirrored)) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
