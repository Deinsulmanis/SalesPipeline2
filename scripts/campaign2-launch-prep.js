'use strict';

// Staffing Outreach Campaign 2 launch preparation (2026-10-23).
//
// PLAN (default, read-only): joins the canonical Campaign 2 rows to the
// reviewed sourcing file, decides each lead's eligibility, and writes the exact
// per-lead patch to PLAN_PATH. It writes nothing anywhere else.
//
// APPLY (APPLY_CAMPAIGN2_PREP=yes): re-reads canonical state, refuses if any
// lead moved since the plan, then commits each patch through applyLeadChanges
// (one compare-and-set per lead) and mirrors it to Sheets.
//
// Patches touch only `company` (only where it is blank, copied verbatim from
// the sourcing file) and `campaign_notes` (a staffing review tag, plus a hold
// record for every lead that is not cleared). Nothing is queued or sent here;
// queueing is the dashboard's /api/coldemail/queue.
require('dotenv').config({ path: process.env.SALESPIPELINE_ENV_FILE || '.env' });
const fs = require('node:fs');
const { readOutreachCorpus, applyLeadChanges } = require('../integrations/outreach-state');
const { replaceStaffingReviewTag, staffingCampaignFor, STAFFING_CAMPAIGN_2, isStaffingV2Marked } = require('../integrations/staffing-campaign');
const { withStaffingHold, staffingHoldStatus, staffingHoldInconsistencies } = require('../integrations/staffing-hold');
const { createProviderClassifier } = require('../integrations/cold-delivery-policy');

const EXPECTED_LEADS = 537;
const REVIEWED_AT = '2026-10-23T07:30:00.000Z';
const REVIEW_SOURCE = 'campaign2-launch-prep 2026-10-23 (operator-approved cohort: clearly industrial only)';
const EXCLUDED_VERTICALS = new Set(['ACCOUNTING_FINANCE', 'ADMIN_OFFICE', 'PROFESSIONAL']);
const REVIEW_VERTICALS = new Set(['GENERALIST_COMMERCIAL', 'ENGINEERING_TECHNICAL']);
const NON_US_TLD = /\.(uk|ca|au|in|de|ie|nz)$/i;
const BUYER_TITLE = /owner|president|ceo|chief|founder|partner|principal|managing director|vp|vice president|head of|director|general manager|coo|cro/i;

function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

const lower = value => String(value || '').trim().toLowerCase();
const rootDomain = value => lower(value).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
const neverSent = lead => !lead.emailStatus && !(Number(lead.emailStep) > 0) && !lead.lastEmailedAt;

// The first reason decides the hold; every reason is kept as evidence.
function eligibility(source) {
  const emailDomain = lower(source.email).split('@')[1] || '';
  const companyDomain = rootDomain(source.company_domain || source.domain);
  const vertical = String(source.vertical || '').trim();
  const reasons = [];
  if (NON_US_TLD.test(emailDomain)) reasons.push({ hold: 'ICP_REJECT', fit: 'ICP_REJECT', detail: `non-US email domain ${emailDomain}; the cohort is United States only` });
  if (EXCLUDED_VERTICALS.has(vertical)) reasons.push({ hold: 'NON_INDUSTRIAL_STAFFING', fit: 'ICP_REJECT', detail: `sourced vertical ${vertical} is an excluded (non-industrial) staffing type` });
  if (companyDomain && emailDomain !== companyDomain) reasons.push({ hold: 'ICP_CONFLICT', fit: 'ICP_UNRESOLVED', detail: `email domain ${emailDomain} differs from company domain ${companyDomain}` });
  if (REVIEW_VERTICALS.has(vertical)) reasons.push({ hold: 'ICP_UNCONFIRMED', fit: 'ICP_UNRESOLVED', detail: `sourced vertical ${vertical} needs documented industrial evidence` });
  if (!vertical) reasons.push({ hold: 'ICP_UNCONFIRMED', fit: 'ICP_UNRESOLVED', detail: 'no sourced vertical recorded; industrial fit is unconfirmed' });
  if (!BUYER_TITLE.test(String(source.title || ''))) reasons.push({ hold: 'REVIEW_REQUIRED', fit: 'ICP_UNRESOLVED', detail: `title "${source.title || ''}" is outside the approved buyer cohorts` });
  return reasons;
}

function patchFor(lead, source, reasons) {
  const patch = {};
  const sourceCompany = String(source.company_name || source.company || '').trim();
  if (!String(lead.company || '').trim() && sourceCompany) patch.company = sourceCompany;
  if (!reasons.length) {
    patch.campaign_notes = replaceStaffingReviewTag('', { fit: 'ICP_CONFIRMED', personalization: 'NONE_REQUIRED', routingReady: true });
    return patch;
  }
  const [primary] = reasons;
  const tagged = replaceStaffingReviewTag('', { fit: primary.fit, personalization: 'NONE_REQUIRED', routingReady: false });
  patch.campaign_notes = withStaffingHold(tagged, {
    reason: primary.hold,
    explanation: `Held from Staffing Outreach Campaign 2: ${primary.detail}`,
    evidence: reasons.map(reason => ({ source: 'FINAL-USABLE-POOL-FOR-MANUAL-REVIEW.csv', detail: reason.detail })),
    reviewedAt: REVIEWED_AT, reviewSource: REVIEW_SOURCE,
    temporary: primary.fit !== 'ICP_REJECT', couldBecomeEligible: primary.fit !== 'ICP_REJECT',
  });
  return patch;
}

async function sheetRows(env) {
  const { google } = require('googleapis');
  const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheetsClient = google.sheets({ version: 'v4', auth });
  const column = (await sheetsClient.spreadsheets.values.get({ spreadsheetId: env.SPREADSHEET_ID, range: 'ColdEmail!A:A' })).data.values || [];
  const rows = new Map();
  column.forEach((cells, index) => { if (index > 0 && cells[0]) rows.set(cells[0], [...(rows.get(cells[0]) || []), index + 1]); });
  return { sheetsClient, rows };
}

async function campaign2Leads(env) {
  const corpus = await readOutreachCorpus({ env });
  if (!corpus.ok) throw new Error(`Canonical read failed: ${corpus.reason}`);
  const leads = corpus.leads.filter(lead => String(lead.campaign || '').trim() === STAFFING_CAMPAIGN_2.name);
  if (leads.length !== EXPECTED_LEADS) throw new Error(`Expected ${EXPECTED_LEADS} Campaign 2 leads, found ${leads.length}`);
  for (const lead of leads) {
    if (String(lead.clientId || 'scalelab') !== 'scalelab' || lead.stage !== 'Import' || !neverSent(lead)
      || isStaffingV2Marked(lead) || String(lead.campaign_notes || '').trim()) {
      throw new Error(`Campaign 2 lead ${lead.id} is not an untouched never-sent ScaleLab import`);
    }
  }
  return { leads, all: corpus.leads };
}

async function plan(env) {
  const source = parseCsv(fs.readFileSync(env.SOURCE_CSV, 'utf8').replace(/^\uFEFF/, ''));
  const byEmail = new Map(source.map(row => [lower(row.email), row]));
  const { leads, all } = await campaign2Leads(env);
  const classifier = createProviderClassifier({ env });
  const { rows } = await sheetRows(env);
  const changes = [];
  for (const lead of leads) {
    const sourceRow = byEmail.get(lower(lead.email));
    if (!sourceRow) throw new Error(`Campaign 2 lead ${lead.id} has no sourcing row`);
    const sameAddress = all.filter(other => lower(other.email) === lower(lead.email));
    if (sameAddress.length !== 1) throw new Error(`Campaign 2 lead ${lead.id} shares its address with another lead`);
    const sheetRow = rows.get(lead.id) || [];
    if (sheetRow.length !== 1) throw new Error(`Campaign 2 lead ${lead.id} is not exactly one ColdEmail row`);
    const reasons = eligibility(sourceRow);
    const patch = patchFor(lead, sourceRow, reasons);
    const after = { ...lead, ...patch };
    if (reasons.length && (!staffingHoldStatus(after) || staffingHoldInconsistencies(after).length)) {
      throw new Error(`Hold record for ${lead.id} is inconsistent: ${staffingHoldInconsistencies(after).join('; ')}`);
    }
    if (staffingCampaignFor(after) !== STAFFING_CAMPAIGN_2) throw new Error(`Lead ${lead.id} does not resolve to Campaign 2`);
    const provider = reasons.length ? null : await classifier.classify(lead.email);
    changes.push({
      leadId: lead.id, row: sheetRow[0], email: lead.email, company: patch.company || lead.company,
      eligible: !reasons.length, holdReason: reasons[0]?.hold || '', reasons: reasons.map(reason => reason.detail),
      recipientProvider: provider ? provider.provider : '', recipientReason: provider ? provider.reason : '',
      expectedState: { company: lead.company || '', campaign_notes: lead.campaign_notes || '', stage: lead.stage,
        emailStatus: lead.emailStatus || '', emailStep: lead.emailStep || '', senderInboxId: lead.senderInboxId || '' },
      patch,
    });
  }
  const count = predicate => changes.filter(predicate).length;
  const summary = {
    plannedAt: new Date().toISOString(), leads: changes.length,
    eligible: count(change => change.eligible),
    eligibleGoogle: count(change => change.eligible && change.recipientProvider === 'google'),
    eligibleNotGoogle: count(change => change.eligible && change.recipientProvider !== 'google'),
    held: count(change => !change.eligible),
    holdsByReason: changes.filter(change => !change.eligible).reduce((acc, change) => ({ ...acc, [change.holdReason]: (acc[change.holdReason] || 0) + 1 }), {}),
    companyRepairs: count(change => Object.hasOwn(change.patch, 'company')),
  };
  fs.writeFileSync(env.PLAN_PATH, JSON.stringify({ summary, changes }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

async function apply(env) {
  if (env.APPLY_CAMPAIGN2_PREP !== 'yes') throw new Error('Set APPLY_CAMPAIGN2_PREP=yes after reviewing the exact plan');
  const planned = JSON.parse(fs.readFileSync(env.PLAN_PATH, 'utf8'));
  if (planned.changes.length !== EXPECTED_LEADS) throw new Error('Plan does not cover exactly the Campaign 2 cohort');
  for (const change of planned.changes) {
    const fields = Object.keys(change.patch);
    if (!fields.length || fields.some(field => !['company', 'campaign_notes'].includes(field))) {
      throw new Error(`Plan patch for ${change.leadId} touches fields outside company and campaign_notes`);
    }
  }
  const { leads } = await campaign2Leads(env);
  const byId = new Map(leads.map(lead => [lead.id, lead]));
  for (const change of planned.changes) {
    const lead = byId.get(change.leadId);
    if (!lead) throw new Error(`Planned lead ${change.leadId} is no longer in Campaign 2`);
    for (const [field, value] of Object.entries(change.expectedState)) {
      if (String(lead[field] || '') !== String(value)) throw new Error(`Lead ${change.leadId} changed since the plan (${field})`);
    }
  }
  const { sheetsClient, rows } = await sheetRows(env);
  for (const change of planned.changes) {
    if ((rows.get(change.leadId) || [])[0] !== change.row) throw new Error(`ColdEmail row moved for ${change.leadId}`);
  }
  const result = await applyLeadChanges(planned.changes.map(change => ({
    leadId: change.leadId, patch: change.patch, row: change.row,
    expectedState: { company: change.expectedState.company, campaign_notes: change.expectedState.campaign_notes, stage: change.expectedState.stage },
  })), { sheetsClient, spreadsheetId: env.SPREADSHEET_ID, env });
  const report = { appliedAt: new Date().toISOString(), summary: result.summary,
    outcomes: result.results.map(row => ({ leadId: row.leadId, status: row.status, reason: row.reason, revision: row.revision, mirrored: row.mirrored })) };
  fs.writeFileSync(env.APPLY_REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ appliedAt: report.appliedAt, summary: report.summary,
    notApplied: report.outcomes.filter(row => !['succeeded', 'unchanged'].includes(row.status)).length,
    mirrorFailures: report.outcomes.filter(row => row.status === 'succeeded' && !row.mirrored).length }));
  if (report.outcomes.some(row => !['succeeded', 'unchanged'].includes(row.status) || (row.status === 'succeeded' && !row.mirrored))) process.exitCode = 1;
}

if (require.main === module) {
  const env = { ...process.env, SUPABASE_OUTREACH_MODE: 'primary', SUPABASE_OUTREACH_WRITES: 'supabase' };
  (env.MODE === 'apply' ? apply(env) : plan(env)).catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { eligibility, patchFor, parseCsv };
