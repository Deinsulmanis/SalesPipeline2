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
const ROLE_MAILBOX = /^(it|info|admin|office|sales|hr|jobs|careers|contact|support|hello|team|recruiting|staffing)$/i;

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
  const localPart = lower(source.email).split('@')[0];
  if (ROLE_MAILBOX.test(localPart)) reasons.push({ hold: 'REVIEW_REQUIRED', fit: 'ICP_UNRESOLVED', detail: `${localPart}@ is a role mailbox, not the named buyer's address` });
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

// HOLD (APPLY_CAMPAIGN2_HOLD=yes): holds the cleared leads in HOLD_IDS whose
// sourcing row now fails eligibility(), compare-and-set against their cleared tag.
async function holdCleared(env) {
  if (env.APPLY_CAMPAIGN2_HOLD !== 'yes') throw new Error('Set APPLY_CAMPAIGN2_HOLD=yes after reviewing HOLD_IDS');
  const ids = String(env.HOLD_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
  const source = parseCsv(fs.readFileSync(env.SOURCE_CSV, 'utf8').replace(/^\uFEFF/, ''));
  const byEmail = new Map(source.map(row => [lower(row.email), row]));
  const corpus = await readOutreachCorpus({ env });
  if (!corpus.ok) throw new Error(`Canonical read failed: ${corpus.reason}`);
  const byId = new Map(corpus.leads.map(lead => [lead.id, lead]));
  const cleared = replaceStaffingReviewTag('', { fit: 'ICP_CONFIRMED', personalization: 'NONE_REQUIRED', routingReady: true });
  const { sheetsClient, rows } = await sheetRows(env);
  const changes = ids.map(id => {
    const lead = byId.get(id);
    if (!lead || lead.campaign !== STAFFING_CAMPAIGN_2.name || lead.stage !== 'Import' || !neverSent(lead) || lead.campaign_notes !== cleared) {
      throw new Error(`Lead ${id} is not a cleared, unqueued Campaign 2 lead`);
    }
    const reasons = eligibility(byEmail.get(lower(lead.email)) || {});
    if (!reasons.length) throw new Error(`Lead ${id} still passes eligibility; nothing to hold`);
    const patch = { campaign_notes: patchFor(lead, byEmail.get(lower(lead.email)), reasons).campaign_notes };
    if (staffingHoldInconsistencies({ ...lead, ...patch }).length) throw new Error(`Hold record for ${id} is inconsistent`);
    const row = rows.get(id) || [];
    if (row.length !== 1) throw new Error(`Lead ${id} is not exactly one ColdEmail row`);
    return { leadId: id, row: row[0], patch, expectedState: { campaign_notes: cleared, stage: 'Import' } };
  });
  const result = await applyLeadChanges(changes, { sheetsClient, spreadsheetId: env.SPREADSHEET_ID, env });
  console.log(JSON.stringify({ summary: result.summary, outcomes: result.results.map(row => ({ leadId: row.leadId, status: row.status, mirrored: row.mirrored })) }));
  if (result.results.some(row => row.status !== 'succeeded' || !row.mirrored)) process.exitCode = 1;
}

// PREVIEW (read-only): renders every touch for PREVIEW_IDS (comma-separated)
// from their canonical rows, exactly as the sender would, into PREVIEW_PATH.
async function preview(env) {
  const { renderStaffingEmail, validateStaffingEmail } = require('../integrations/staffing-campaign');
  const ids = String(env.PREVIEW_IDS || '').split(',').map(id => id.trim()).filter(Boolean);
  const corpus = await readOutreachCorpus({ env });
  if (!corpus.ok) throw new Error(`Canonical read failed: ${corpus.reason}`);
  const byId = new Map(corpus.leads.map(lead => [lead.id, lead]));
  // PREVIEW_PLAN renders the planned adoption patches before they are applied.
  const planned = env.PREVIEW_PLAN ? new Map(JSON.parse(fs.readFileSync(env.PREVIEW_PLAN, 'utf8')).adoptions
    .map(item => [item.leadId, item.patch])) : new Map();
  const routed = { emailTemplateId: STAFFING_CAMPAIGN_2.emailTemplateId, intendedCampaignVersion: STAFFING_CAMPAIGN_2.id };
  const out = [`# Staffing Outreach Campaign 2 previews (${new Date().toISOString()})`, ''];
  let failures = 0;
  for (const id of ids) {
    const stored = byId.get(id);
    if (!stored) throw new Error(`Preview lead ${id} not found`);
    const lead = { ...stored, ...(planned.get(id) || {}) };
    out.push(`## ${lead.company} — ${lead.contactName} <${lead.email}> (${id})`, '');
    for (const step of [1, 2, 3]) {
      try {
        // Production renders its own COMMERCIAL_MAILING_ADDRESS; a local preview may stand one in.
        const email = renderStaffingEmail({ ...lead, ...routed }, step,
          { env, ...(env.PREVIEW_MAILING_ADDRESS ? { mailingAddress: env.PREVIEW_MAILING_ADDRESS } : {}) });
        const error = validateStaffingEmail(email, step);
        if (error) failures += 1;
        out.push(`### Email ${step}${email.subject ? ` — subject: ${email.subject}` : ' — same thread (Re: employer accounts)'}${error ? ` — INVALID: ${error}` : ''}`,
          '', '```', email.body, '```', '');
      } catch (error) {
        failures += 1;
        out.push(`### Email ${step} — REFUSED: ${error.message}`, '');
      }
    }
  }
  fs.writeFileSync(env.PREVIEW_PATH, out.join('\n'));
  console.log(JSON.stringify({ leads: ids.length, touches: ids.length * 3, failures }));
  if (failures) process.exitCode = 1;
}

// RECLASSIFY-PLAN (read-only) / RECLASSIFY (APPLY_CAMPAIGN2_RECLASSIFY=yes):
// every Campaign 2 lead without an adopted profile is held, with a reason that
// reflects the V3 ICP its sourcing run used (all eight staffing verticals in
// scope). The vertical rules in eligibility() are not applied: they were the
// industrial-only V1 rule. Every such lead also lacks verified Tier A roles +
// market or Tier B positioning, so Campaign 2 copy cannot render for it.
const GENUINE_HOLDS = new Set(['ICP_REJECT', 'ICP_CONFLICT', 'REVIEW_REQUIRED']);
const RECLASSIFIED_AT = '2026-10-23T08:00:00.000Z';
const RECLASSIFY_SOURCE = 'campaign2-launch-prep reclassify 2026-10-23 (V3 ICP; Campaign 2 sends V2 Tier A / Tier B copy)';
function reclassifiedHold(source) {
  const genuine = eligibility(source).filter(reason => GENUINE_HOLDS.has(reason.hold)
    && !/sourced vertical|no sourced vertical/.test(reason.detail));
  const copy = { hold: 'REVIEW_REQUIRED', fit: 'ICP_CONFIRMED',
    detail: 'no verified Tier A roles + market or Tier B positioning in a sealed V2 record; Campaign 2 copy cannot render without inventing them' };
  const reasons = [...genuine, copy];
  const [primary] = reasons;
  const category = primary.fit === 'ICP_REJECT' ? 'ICP_REJECTED' : genuine.length ? 'DATA_QUALITY_REVIEW' : 'COPY_DATA_MISSING';
  const tagged = replaceStaffingReviewTag('', { fit: primary.fit, personalization: 'NONE_REQUIRED', routingReady: false });
  const campaignNotes = withStaffingHold(tagged, {
    reason: primary.hold, explanation: `Held from Staffing Outreach Campaign 2: ${primary.detail}`,
    evidence: reasons.map(reason => ({ source: 'FINAL-USABLE-POOL-FOR-MANUAL-REVIEW.csv', detail: reason.detail })),
    reviewedAt: RECLASSIFIED_AT, reviewSource: RECLASSIFY_SOURCE,
    temporary: primary.fit !== 'ICP_REJECT', couldBecomeEligible: primary.fit !== 'ICP_REJECT',
  });
  return { category, primary: primary.hold, reasons: reasons.map(reason => reason.detail), campaignNotes };
}
async function reclassifyPlan(env) {
  const { hasStaffingV2ProfileMarker } = require('../integrations/staffing-v2-profile');
  const source = parseCsv(fs.readFileSync(env.SOURCE_CSV, 'utf8').replace(/^\uFEFF/, ''));
  const byEmail = new Map(source.map(row => [lower(row.email), row]));
  const corpus = await readOutreachCorpus({ env });
  if (!corpus.ok) throw new Error(`Canonical read failed: ${corpus.reason}`);
  const leads = corpus.leads.filter(lead => lead.campaign === STAFFING_CAMPAIGN_2.name && !hasStaffingV2ProfileMarker(lead));
  const { rows } = await sheetRows(env);
  const changes = leads.map(lead => {
    const sourceRow = byEmail.get(lower(lead.email));
    if (!sourceRow) throw new Error(`Campaign 2 lead ${lead.id} has no sourcing row`);
    if (lead.stage !== 'Import' || !neverSent(lead) || String(lead.senderInboxId || '').trim()) throw new Error(`Lead ${lead.id} has been routed or contacted`);
    const row = rows.get(lead.id) || [];
    if (row.length !== 1) throw new Error(`Lead ${lead.id} is not exactly one ColdEmail row`);
    const hold = reclassifiedHold(sourceRow);
    const after = { ...lead, campaign_notes: hold.campaignNotes };
    if (!staffingHoldStatus(after) || staffingHoldInconsistencies(after).length) throw new Error(`Hold for ${lead.id} is inconsistent`);
    return { leadId: lead.id, row: row[0], email: lead.email, company: lead.company, category: hold.category, holdReason: hold.primary,
      reasons: hold.reasons, previous: staffingHoldStatus(lead)?.reason || 'CLEARED',
      expectedState: { campaign_notes: String(lead.campaign_notes || ''), stage: String(lead.stage || '') },
      patch: { campaign_notes: hold.campaignNotes } };
  });
  const tally = key => changes.reduce((acc, change) => ({ ...acc, [change[key]]: (acc[change[key]] || 0) + 1 }), {});
  const summary = { plannedAt: new Date().toISOString(), leads: changes.length, byCategory: tally('category'),
    byHoldReason: tally('holdReason'), previously: tally('previous') };
  fs.writeFileSync(env.PLAN_PATH, JSON.stringify({ summary, changes }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}
async function reclassify(env) {
  if (env.APPLY_CAMPAIGN2_RECLASSIFY !== 'yes') throw new Error('Set APPLY_CAMPAIGN2_RECLASSIFY=yes after reviewing the exact plan');
  const planned = JSON.parse(fs.readFileSync(env.PLAN_PATH, 'utf8'));
  if (planned.changes.some(change => Object.keys(change.patch).join() !== 'campaign_notes')) throw new Error('Plan touches fields other than campaign_notes');
  const { sheetsClient } = await sheetRows(env);
  const result = await applyLeadChanges(planned.changes.map(change => ({
    leadId: change.leadId, patch: change.patch, row: change.row, expectedState: change.expectedState,
  })), { sheetsClient, spreadsheetId: env.SPREADSHEET_ID, env });
  const failed = result.results.filter(row => !['succeeded', 'unchanged'].includes(row.status) || (row.status === 'succeeded' && !row.mirrored));
  fs.writeFileSync(env.APPLY_REPORT_PATH, JSON.stringify({ appliedAt: new Date().toISOString(), summary: result.summary,
    outcomes: result.results.map(row => ({ leadId: row.leadId, status: row.status, reason: row.reason, mirrored: row.mirrored })) }, null, 2));
  console.log(JSON.stringify({ summary: result.summary, notAppliedOrUnmirrored: failed.length }));
  if (failed.length) process.exitCode = 1;
}

// ADOPT-PLAN (read-only): plans sealing each prepared V2 import record
// (ADOPTION_PAYLOAD) onto its existing Campaign 2 row, into PLAN_PATH.
// ADOPT (APPLY_CAMPAIGN2_ADOPTION=yes): commits that plan, compare-and-set
// against each row's planned campaign_notes, stage and company.
const ADOPTED_FIELDS = ['company', 'campaign_notes', 'leadNiche', 'emailTemplateId', 'intendedCampaignVersion'];
// The strict read: a failed suppression read stops the plan.
async function suppressedEmailsFor(env) {
  const { sheetsClient } = await sheetRows(env);
  const response = await sheetsClient.spreadsheets.values.get({ spreadsheetId: env.SPREADSHEET_ID, range: 'Suppression!A:A' });
  return new Set((response.data.values || []).slice(1).map(row => lower(row[0])).filter(Boolean));
}
async function adoptPlan(env) {
  const { planCampaign2Adoption } = require('../integrations/staffing-campaign-2-adoption');
  const payload = JSON.parse(fs.readFileSync(env.ADOPTION_PAYLOAD, 'utf8').replace(/^\uFEFF/, ''));
  const corpus = await readOutreachCorpus({ env });
  if (!corpus.ok) throw new Error(`Canonical read failed: ${corpus.reason}`);
  const suppressedEmails = await suppressedEmailsFor(env);
  const result = planCampaign2Adoption(payload, { leads: corpus.leads, suppressedEmails }, {
    renderOptions: { env, ...(env.PREVIEW_MAILING_ADDRESS ? { mailingAddress: env.PREVIEW_MAILING_ADDRESS } : {}) },
  });
  const { rows } = await sheetRows(env);
  const adoptions = result.adoptions.map(adoption => {
    const row = rows.get(adoption.leadId) || [];
    if (row.length !== 1) throw new Error(`Lead ${adoption.leadId} is not exactly one ColdEmail row`);
    return { ...adoption, row: row[0] };
  });
  const summary = { plannedAt: new Date().toISOString(), records: result.request.records.length,
    adoptions: adoptions.length, alreadyAdopted: result.alreadyAdopted.length, refusals: result.refusals.length,
    refusalsByCode: result.refusalsByCode,
    byTier: adoptions.reduce((acc, item) => ({ ...acc, [item.tier]: (acc[item.tier] || 0) + 1 }), {}) };
  fs.writeFileSync(env.PLAN_PATH, JSON.stringify({ summary, adoptions, alreadyAdopted: result.alreadyAdopted, refusals: result.refusals }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}
async function adopt(env) {
  if (env.APPLY_CAMPAIGN2_ADOPTION !== 'yes') throw new Error('Set APPLY_CAMPAIGN2_ADOPTION=yes after reviewing the exact plan');
  const planned = JSON.parse(fs.readFileSync(env.PLAN_PATH, 'utf8'));
  for (const item of planned.adoptions) {
    const fields = Object.keys(item.patch);
    if (fields.some(field => !ADOPTED_FIELDS.includes(field))) throw new Error(`Plan patch for ${item.leadId} touches ${fields.join(', ')}`);
  }
  const corpus = await readOutreachCorpus({ env });
  if (!corpus.ok) throw new Error(`Canonical read failed: ${corpus.reason}`);
  const byId = new Map(corpus.leads.map(lead => [lead.id, lead]));
  for (const item of planned.adoptions) {
    const lead = byId.get(item.leadId);
    if (!lead || lead.campaign !== STAFFING_CAMPAIGN_2.name) throw new Error(`Planned lead ${item.leadId} is no longer in Campaign 2`);
    for (const [field, value] of Object.entries(item.expectedState)) {
      if (String(lead[field] || '').trim() !== String(value)) throw new Error(`Lead ${item.leadId} changed since the plan (${field})`);
    }
    if (!neverSent(lead) || String(lead.senderInboxId || '').trim()) throw new Error(`Lead ${item.leadId} has been routed or contacted`);
  }
  const { sheetsClient, rows } = await sheetRows(env);
  for (const item of planned.adoptions) {
    if ((rows.get(item.leadId) || [])[0] !== item.row) throw new Error(`ColdEmail row moved for ${item.leadId}`);
  }
  const result = await applyLeadChanges(planned.adoptions.map(item => ({
    leadId: item.leadId, patch: item.patch, row: item.row, expectedState: item.expectedState,
  })), { sheetsClient, spreadsheetId: env.SPREADSHEET_ID, env });
  const report = { appliedAt: new Date().toISOString(), summary: result.summary,
    outcomes: result.results.map(row => ({ leadId: row.leadId, status: row.status, reason: row.reason, mirrored: row.mirrored })) };
  fs.writeFileSync(env.APPLY_REPORT_PATH, JSON.stringify(report, null, 2));
  const failed = report.outcomes.filter(row => !['succeeded', 'unchanged'].includes(row.status) || (row.status === 'succeeded' && !row.mirrored));
  console.log(JSON.stringify({ appliedAt: report.appliedAt, summary: report.summary, notAppliedOrUnmirrored: failed.length }));
  if (failed.length) process.exitCode = 1;
}

if (require.main === module) {
  const env = { ...process.env, SUPABASE_OUTREACH_MODE: 'primary', SUPABASE_OUTREACH_WRITES: 'supabase' };
  const run = { apply, preview, hold: holdCleared, 'adopt-plan': adoptPlan, adopt,
    'reclassify-plan': reclassifyPlan, reclassify }[env.MODE] || plan;
  run(env).catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { eligibility, patchFor, parseCsv, reclassifiedHold };
