'use strict';

// Read-only production preflight. Persist a private exact CAS mutation plan.
require('dotenv').config({ path: process.env.SALESPIPELINE_ENV_FILE || '.env' });
const fs = require('node:fs');
const { google } = require('googleapis');
const { readOutreachCorpus } = require('../integrations/outreach-state');
const { replaceStaffingReviewTag } = require('../integrations/staffing-campaign');
const { withStaffingHold, staffingHoldInconsistencies } = require('../integrations/staffing-hold');
const { isStaffing, neverSent } = require('./staffing-held-inventory');

const inventory = JSON.parse(fs.readFileSync(process.env.INVENTORY_PATH, 'utf8'));
const classified = JSON.parse(fs.readFileSync(process.env.CLASSIFICATION_PATH, 'utf8'));
const COLUMNS = ['id', 'company', 'contactName', 'email', 'city', 'tradeType', 'website', 'stage',
  'emailStatus', 'lastEmailedAt', 'emailStep', 'notes', 'reviewCount', 'rating', 'tier',
  'siteContext', 'campaign', 'campaign_notes', 'enrichment_attempted', 'leadNiche',
  'senderInboxId', 'emailTemplateId', 'routingRequired', 'intendedCampaignVersion'];

async function main() {
  if (inventory.heldCount !== 63 || classified.total !== 63) throw new Error('63-lead inventory required');
  const corpus = await readOutreachCorpus({ env: { ...process.env, SUPABASE_OUTREACH_MODE: 'primary' } });
  if (!corpus.ok) throw new Error(`Cannot read canonical corpus: ${corpus.reason}`);
  const byId = new Map(corpus.leads.map(lead => [lead.id, lead]));
  const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const values = (await sheets.spreadsheets.values.get({ spreadsheetId: process.env.SPREADSHEET_ID,
    range: 'ColdEmail!A:X' })).data.values || [];
  const mirror = new Map(values.slice(1).map((fields, i) => [fields[0], { row: i + 2,
    lead: Object.fromEntries(COLUMNS.map((field, j) => [field, fields[j] || ''])) }]));
  const currentHeld = corpus.leads.filter(lead => isStaffing(lead) && neverSent(lead) && lead.stage !== 'Queued');
  if (currentHeld.length !== 63 || currentHeld.some(lead => !classified.records.some(row => row.leadId === lead.id))) {
    throw new Error(`Held population moved: ${currentHeld.length}; re-audit before writing`);
  }
  const changes = classified.records.map(row => {
    const current = byId.get(row.leadId), sheet = mirror.get(row.leadId), previous = inventory.records.find(item => item.leadId === row.leadId);
    if (!current || !sheet || !previous) throw new Error(`Missing canonical or mirror lead ${row.leadId}`);
    if (!isStaffing(current) || !neverSent(current) || !['Import', 'Review'].includes(current.stage)
      || String(current.clientId || 'scalelab') !== 'scalelab') throw new Error(`Out-of-scope lead ${row.leadId}`);
    if (COLUMNS.some(field => String(current[field] || '') !== String(previous.lead[field] || ''))
      || COLUMNS.some(field => String(current[field] || '') !== sheet.lead[field])) {
      throw new Error(`Lead moved or Sheets mirror drifted: ${row.leadId}`);
    }
    if (row.before.fit !== previous.fit || row.before.personalization !== previous.personalization
      || row.stage !== previous.stage || row.after.stage !== current.stage
      || row.after.personalization !== row.before.personalization || row.after.routingReady !== false
      || row.after.manualHold !== row.before.manualHold) throw new Error(`Classification drift ${row.leadId}`);
    if (row.hold.reason === 'MANUAL_HOLD' && !['muj0yvmkcma90wklvw', 'muj0yvmkcnea3a0k1gp', 'muj0yvmkfsplzmjkqys'].includes(row.leadId)) {
      throw new Error(`Unexpected contact manual hold ${row.leadId}`);
    }
    const cleaned = String(current.campaign_notes || '').replace(/\[STAFFING_REVIEW_V1 fit=ICP_REVIEW;personalization=NONE_REQUIRED;routing_ready=false\]/g, '').trim();
    const reviewed = replaceStaffingReviewTag(cleaned, { fit: row.after.fit,
      personalization: row.after.personalization, routingReady: false });
    const campaignNotes = withStaffingHold(reviewed, row.hold);
    const candidate = { ...current, campaign_notes: campaignNotes };
    const problems = staffingHoldInconsistencies(candidate);
    if (problems.length) throw new Error(`Hold contradiction ${row.leadId}: ${problems.join(', ')}`);
    return { leadId: row.leadId, company: row.company, row: sheet.row,
      expectedState: Object.fromEntries(COLUMNS.map(field => [field, current[field] || ''])),
      patch: { campaign_notes: campaignNotes },
      beforeFit: row.before.fit, afterFit: row.after.fit, reason: row.hold.reason,
      manualHold: row.before.manualHold, stage: current.stage };
  });
  const counts = changes.reduce((out, row) => (out[row.reason] = (out[row.reason] || 0) + 1, out), {});
  const staffing = corpus.leads.filter(isStaffing);
  const queued = staffing.filter(lead => neverSent(lead) && lead.stage === 'Queued');
  const jole = corpus.leads.filter(lead => String(lead.clientId || '') === 'jole');
  const plan = { plannedAt: new Date().toISOString(), capturedAt: inventory.capturedAt,
    canonicalSource: 'Supabase outreach_leads', mirrorSource: 'Google Sheets ColdEmail',
    totalStaffing: staffing.length, heldBefore: currentHeld.length, queuedBefore: queued.length,
    queuedIds: queued.map(lead => lead.id), joleBefore: jole.length,
    changes, counts, fitCorrections: changes.filter(row => row.beforeFit !== row.afterFit).length,
    touchedStages: [...new Set(changes.map(row => row.stage))], manualContactHolds: changes.filter(row => row.reason === 'MANUAL_HOLD').length,
    untouchedQueued: queued.length, touchedSentOrContacted: 0, touchedJole: 0,
    touchedStage: 0, touchedNotes: 0, touchedPersonalization: 0, touchedRoutingReady: 0 };
  fs.writeFileSync(process.env.PLAN_PATH, JSON.stringify(plan, null, 2));
  console.log(JSON.stringify({ plannedAt: plan.plannedAt, totalStaffing: plan.totalStaffing,
    heldBefore: plan.heldBefore, queuedBefore: plan.queuedBefore, joleBefore: plan.joleBefore,
    changes: changes.length, fields: ['campaign_notes'], fitCorrections: plan.fitCorrections,
    reasons: counts, manualContactHolds: plan.manualContactHolds,
    touchedSentOrContacted: 0, touchedJole: 0, touchedQueued: 0,
    touchedStage: 0, touchedNotes: 0, touchedPersonalization: 0, touchedRoutingReady: 0 }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
