#!/usr/bin/env node
'use strict';
/**
 * generic-reengagement-preview.js — READ-ONLY pilot preview for generic_follow_up_v1.
 * ─────────────────────────────────────────────────────────────────────────────
 * Answers "who WOULD be re-engaged, and why" without changing anything. It uses
 * a read-only Sheets scope, so it cannot write even if it were asked to: no
 * enrolment, no reservation, no send, no stage or hold mutation.
 *
 * This is the "preview → approve" half of the controlled rollout. Enrolling the
 * cohort it prints is a separate, separately-authorised action.
 *
 *   node generic-reengagement-preview.js [--limit 50] [--all]
 *
 * Prints no email bodies and no secrets.
 */
require('dotenv').config();
const { google } = require('googleapis');
const {
  genericConfig, genericEligibility, selectPilotCohort,
} = require('./integrations/generic-reengagement');
const { provenSequenceSenderId, deriveSequenceState } = require('./integrations/stage-sequences');
const { deriveAutomationOwnership } = require('./integrations/automation-ownership');
const { sendSuppressionReason } = require('./integrations/pipeline-state');
const { COLD_CALL_ACTIVITY_HEADER: H } = require('./integrations/cold-call-pipeline');

const CE = ['id', 'company', 'contactName', 'email', 'city', 'tradeType', 'website', 'stage',
  'emailStatus', 'lastEmailedAt', 'emailStep', 'notes', 'reviewCount', 'rating', 'tier',
  'siteContext', 'campaign', 'campaign_notes', 'enrichment_attempted', 'leadNiche', 'senderInboxId'];

const arg = name => {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
};
const norm = value => String(value || '').trim().toLowerCase();
const pad = (value, width) => String(value == null ? '' : value).slice(0, width).padEnd(width);

(async () => {
  const config = genericConfig();
  const limit = Number(arg('--limit') || config.pilotLimit);
  const showAll = process.argv.includes('--all');

  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const read = async range => (await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SPREADSHEET_ID, range,
  })).data.values || [];

  const leads = (await read('ColdEmail!A:X')).slice(1)
    .map(row => { const item = {}; CE.forEach((key, i) => { item[key] = row[i] || ''; }); return item; })
    .filter(item => item.id);
  const activities = (await read('ColdCallActivity!A:J')).slice(1)
    .map(row => { const item = {}; H.forEach((key, i) => { item[key] = row[i] || ''; }); return item; });
  const suppressed = new Set((await read('Suppression!A:C')).slice(1)
    .map(row => norm(row[0])).filter(Boolean));
  const boardRows = await read('Leads!A:W');
  const boardEmails = new Set(boardRows.slice(1).map(row => norm(row[3])).filter(Boolean));

  const byLead = new Map();
  for (const row of activities) {
    const key = String(row.sourceLeadId || '').trim() || norm(row.email)
      || String(row.leadId || '').replace(/^CE-/, '').trim();
    if (!key) continue;
    if (!byLead.has(key)) byLead.set(key, []);
    byLead.get(key).push(row);
  }
  const activitiesFor = lead => [...(byLead.get(lead.id) || []), ...(byLead.get(norm(lead.email)) || [])];

  const rows = [];
  const blockerTally = {};
  for (const lead of leads) {
    if (boardEmails.has(norm(lead.email))) continue;      // Pipeline leads keep their stage journeys
    const mine = activitiesFor(lead);
    const state = deriveSequenceState(mine);
    const senderProof = provenSequenceSenderId(lead, mine);
    // forPilot: the historical backfill gate is what the pilot exists to lift,
    // under explicit authorisation. Every other gate still applies in full.
    const decision = genericEligibility({
      twin: lead, activities: mine, sequenceState: state, suppressedEmails: suppressed,
      senderProof, config, forPilot: true,
    });
    const ownership = deriveAutomationOwnership(lead, {
      activities: mine, sequenceState: state, sequencesEnabled: true,
      suppressionReason: item => sendSuppressionReason(item, { suppressedEmails: suppressed }),
    });
    for (const blocker of decision.blockers) {
      const bucket = blocker.replace(/\d+/g, 'N').slice(0, 60);
      blockerTally[bucket] = (blockerTally[bucket] || 0) + 1;
    }
    rows.push({
      leadId: lead.id, company: lead.company || '', email: lead.email,
      sender: decision.senderInboxId || senderProof.senderInboxId || '(unproven)',
      ageDays: decision.ageDays, campaign: decision.campaign,
      suppressed: suppressed.has(norm(lead.email)) ? 'listed' : 'clear',
      owner: ownership.owner, blockedBy: ownership.blockedBy || '',
      eligible: decision.eligible, blocker: decision.blockers[0] || '',
      finalColdEmailAt: decision.finalColdEmailAt,
      projectedStep1DueAt: decision.projectedStep1DueAt,
      why: decision.reason,
    });
  }

  const eligible = rows.filter(row => row.eligible);
  const cohort = selectPilotCohort(eligible, { limit, config });

  console.log('=== generic_follow_up_v1 — READ-ONLY PILOT PREVIEW ===');
  console.log(`  generated            : ${new Date().toISOString()}`);
  console.log(`  ColdEmail rows       : ${leads.length}  (${rows.length} outside the Pipeline, examined)`);
  console.log(`  age window           : ${config.minQuietDays}-${config.maxQuietDays} days since the final cold email`);
  console.log(`  journey enabled      : ${config.enabled}`);
  console.log(`  auto-enrol cutoff    : ${config.autoEnrollAfter}  (historical backfill stays OFF until authorised)`);
  console.log(`  SAFELY ELIGIBLE      : ${eligible.length}`);
  console.log(`  PILOT COHORT         : ${cohort.selected.length} / ${limit}   (deferred: ${cohort.deferred})`);
  console.log(`  ENROLLED BY THIS RUN : 0 — this tool holds a read-only Sheets scope`);

  console.log('\n--- top exclusion reasons ---');
  Object.entries(blockerTally).sort((a, b) => b[1] - a[1]).slice(0, 12)
    .forEach(([reason, count]) => console.log(`  ${String(count).padStart(4)}  ${reason}`));

  console.log(`\n--- pilot cohort (deterministic, oldest eligible first) ---`);
  console.log(`  ${pad('#', 4)}${pad('lead id', 22)}${pad('company', 26)}${pad('sender', 10)}${pad('age', 5)}${pad('campaign', 22)}${pad('supp', 6)}${pad('owner', 16)}step 1 due`);
  cohort.selected.forEach((row, index) => {
    console.log(`  ${pad(index + 1, 4)}${pad(row.leadId, 22)}${pad(row.company, 26)}${pad(row.sender, 10)}${pad(row.ageDays + 'd', 5)}${pad(row.campaign, 22)}${pad(row.suppressed, 6)}${pad(row.owner, 16)}${String(row.projectedStep1DueAt || '').slice(0, 10)}`);
  });

  const campaigns = {}; const senders = {}; const ages = [];
  for (const row of eligible) {
    campaigns[row.campaign] = (campaigns[row.campaign] || 0) + 1;
    senders[row.sender] = (senders[row.sender] || 0) + 1;
    if (Number.isFinite(row.ageDays)) ages.push(row.ageDays);
  }
  ages.sort((a, b) => a - b);
  console.log('\n--- eligible pool shape ---');
  console.log('  campaigns : ' + Object.entries(campaigns).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  '));
  console.log('  senders   : ' + Object.entries(senders).map(([k, v]) => `${k}=${v}`).join('  '));
  if (ages.length) console.log(`  age       : median ${ages[Math.floor(ages.length / 2)]}d  min ${ages[0]}d  max ${ages[ages.length - 1]}d`);
  if (cohort.selected.length) console.log(`  why       : ${cohort.selected[0].why}`);

  if (showAll) {
    console.log('\n--- every eligible lead ---');
    eligible.forEach(row => console.log(`  ${pad(row.leadId, 22)}${pad(row.company, 30)}${pad(row.ageDays + 'd', 6)}${row.why}`));
  }
  console.log('\nNo lead was enrolled. Enrolling this cohort is a separate authorised step.');
})().catch(error => { console.error('PREVIEW FAILED:', error.message); process.exit(1); });
