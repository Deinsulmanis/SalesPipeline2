'use strict';

// Read-only post-write check against the reviewed plan and live canonical state.
require('dotenv').config({ path: process.env.SALESPIPELINE_ENV_FILE || '.env' });
const fs = require('node:fs');
const { google } = require('googleapis');
const { readOutreachCorpus } = require('../integrations/outreach-state');
const { staffingReviewStatus } = require('../integrations/staffing-campaign');
const { staffingHoldStatus, staffingHoldInconsistencies } = require('../integrations/staffing-hold');
const { isStaffing, neverSent } = require('./staffing-held-inventory');
const plan = JSON.parse(fs.readFileSync(process.env.PLAN_PATH, 'utf8'));
const tally = (rows, fn) => rows.reduce((out, row) => {
  const key = fn(row); out[key] = (out[key] || 0) + 1; return out;
}, {});

async function main() {
  const corpus = await readOutreachCorpus({ env: { ...process.env, SUPABASE_OUTREACH_MODE: 'primary' } });
  if (!corpus.ok) throw new Error(corpus.reason);
  const byId = new Map(corpus.leads.map(lead => [lead.id, lead]));
  const staffing = corpus.leads.filter(isStaffing);
  const held = staffing.filter(lead => neverSent(lead) && lead.stage !== 'Queued');
  const queued = staffing.filter(lead => neverSent(lead) && lead.stage === 'Queued');
  const jole = corpus.leads.filter(lead => String(lead.clientId || '') === 'jole');
  const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const values = (await sheets.spreadsheets.values.get({ spreadsheetId: process.env.SPREADSHEET_ID,
    range: 'ColdEmail!A:R' })).data.values || [];
  const contradictions = [], mirrorMismatches = [], unplannedFieldChanges = [];
  for (const change of plan.changes) {
    const lead = byId.get(change.leadId);
    if (!lead) { contradictions.push(`${change.leadId}: missing`); continue; }
    const review = staffingReviewStatus(lead), hold = staffingHoldStatus(lead);
    if (!review || !hold || review.fit !== change.afterFit || hold.reason !== change.reason
      || review.routingReady || lead.stage !== change.stage || !neverSent(lead)) {
      contradictions.push(`${change.leadId}: fit/reason/routing/stage differs`);
    }
    contradictions.push(...staffingHoldInconsistencies(lead).map(problem => `${change.leadId}: ${problem}`));
    if (Object.entries(change.expectedState).some(([field, value]) => field !== 'campaign_notes'
      && String(lead[field] || '') !== String(value))) unplannedFieldChanges.push(change.leadId);
    if (String(values[change.row - 1]?.[0] || '') !== change.leadId
      || String(values[change.row - 1]?.[17] || '') !== String(lead.campaign_notes || '')) {
      mirrorMismatches.push(change.leadId);
    }
  }
  const taggedHeld = held.filter(lead => staffingHoldStatus(lead));
  const report = { verifiedAt: new Date().toISOString(), totalStaffing: staffing.length,
    neverSentStaffing: staffing.filter(neverSent).length, held: held.length, queued: queued.length,
    queuedBeforeMutation: plan.queuedBefore, queuedIdsUnchanged: plan.queuedIds.filter(id => byId.get(id)?.stage === 'Queued').length,
    taggedHeld: taggedHeld.length, holdReasons: tally(taggedHeld, lead => staffingHoldStatus(lead).reason),
    fit: tally(held, lead => staffingReviewStatus(lead)?.fit || 'MISSING'),
    personalization: tally(held, lead => staffingReviewStatus(lead)?.personalization || 'MISSING'),
    routingReadyFalse: held.filter(lead => staffingReviewStatus(lead)?.routingReady === false).length,
    manualContactHolds: plan.changes.filter(row => row.reason === 'MANUAL_HOLD'
      && byId.get(row.leadId)?.stage === row.stage).length,
    allManualMarkers: held.filter(lead => /\[MANUAL HOLD\]/i.test(lead.notes || '')).length,
    contradictions, mirrorMismatches, unplannedFieldChanges,
    heldUnexpectedlyQueued: plan.changes.filter(row => byId.get(row.leadId)?.stage === 'Queued').length,
    jole: jole.length };
  fs.writeFileSync(process.env.VERIFY_REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (held.length !== 63 || taggedHeld.length !== 63 || contradictions.length
    || mirrorMismatches.length || unplannedFieldChanges.length || report.heldUnexpectedlyQueued
    || jole.length !== plan.joleBefore) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
