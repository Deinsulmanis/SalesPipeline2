'use strict';
/**
 * Retry only the six Batch 3 infrastructure/retrieval holds.
 * Does not regrade the 58 imported leads or the 20 genuine holds.
 * Duplicate-opening first-claimants are the already-imported Batch 3 openings.
 */
const fs = require('node:fs');
const path = require('node:path');
const {
  parseCsv, csv, loadOpsEnv, appendNotes,
} = require('./personalize_batch3');

const LIVE_ROOT = process.env.LIVE_PIPELINE_ROOT || '/tmp/live-staffing-pipeline';
const { STAFFING_CAMPAIGN } = require(path.join(LIVE_ROOT, 'integrations/staffing-campaign'));
const {
  previewStaffingPersonalization, flagBatchDuplicates,
} = require(path.join(LIVE_ROOT, 'integrations/staffing-personalization'));

const RETRY_EMAILS = new Set([
  'blopez@leadstaff.com',
  'jmarotta@actionlabor.com',
  'avargas@laboronsite.com',
  'bflores@st-staffing.com',
  'larry@staffingauthority.com',
  'dawnt@capitalareastaffing.com',
]);

const LEAD_FIELDS = [
  'firstName', 'company', 'companyWebsite', 'companyDomain', 'companyCity', 'companyState',
  'companySizeCategory', 'jobTitle', 'staffingLane', 'staffingSpecialization', 'emailStatus', 'sourceEvidence',
];

function isCatchAllRow(row) {
  const status = String(row.emailStatus || '');
  if (/\bnot\s+catch-?all\b/i.test(status)) return false;
  if (/\bcatch-?all\b/i.test(status)) return true;
  return String(row.emailCatchAll || '').toLowerCase() === 'true';
}

async function main() {
  const root = __dirname;
  const input = path.join(root, 'out/batch3-approved-candidates.csv');
  const out = path.join(root, 'personalization');
  const cacheDir = path.join(out, 'cache');
  const backupDir = path.join(out, 'retry6-backup');
  fs.mkdirSync(backupDir, { recursive: true });
  const all = parseCsv(fs.readFileSync(input, 'utf8'));
  const retryRows = all.filter(r => RETRY_EMAILS.has(String(r.apolloVerifiedEmail || '').toLowerCase()));
  if (retryRows.length !== 6) throw new Error(`expected 6 retry rows, found ${retryRows.length}`);

  const prior = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8'));
  const imported = prior.results.filter(r => ['HIGH', 'MEDIUM'].includes(r.classification));
  if (imported.length !== 58) throw new Error(`expected 58 previously accepted, found ${imported.length}`);

  const { url, token } = loadOpsEnv();
  const createMessage = async input => {
    const res = await fetch(`${url}/anthropic`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const json = await res.json();
    if (!res.ok || json?.type === 'error') {
      const err = new Error(json?.error?.message || `anthropic_http_${res.status}`);
      err.status = res.status; err.error = json;
      if (/credit balance is too low/i.test(String(err.message))) err.code = 'MODEL_CREDITS_EXHAUSTED';
      throw err;
    }
    return json;
  };

  const results = [];
  for (const row of retryRows) {
    const email = String(row.apolloVerifiedEmail || '').toLowerCase();
    const cacheFiles = fs.readdirSync(cacheDir).filter(n => n.endsWith('.json'));
    for (const name of cacheFiles) {
      const saved = JSON.parse(fs.readFileSync(path.join(cacheDir, name), 'utf8'));
      if (String(saved.apolloVerifiedEmail || saved.email || '').toLowerCase() === email) {
        fs.copyFileSync(path.join(cacheDir, name), path.join(backupDir, name));
      }
    }
    const lead = {
      ...Object.fromEntries(LEAD_FIELDS.map(k => [k, row[k]])),
      campaign: STAFFING_CAMPAIGN.name,
      campaignId: STAFFING_CAMPAIGN.id,
    };
    console.error(`retry ${email} ${row.company}`);
    const started = Date.now();
    let result;
    try {
      result = await previewStaffingPersonalization(lead, { createMessage });
    } catch (error) {
      const message = error.error?.error?.message || error.message || '';
      result = {
        campaignId: STAFFING_CAMPAIGN.id,
        classification: 'RETRY_REQUIRED',
        primaryReason: /credit balance is too low/i.test(message) || error.code === 'MODEL_CREDITS_EXHAUSTED'
          ? 'MODEL_CREDITS_EXHAUSTED' : 'MODEL_OR_RESPONSE_ERROR',
        hyperPersonalizedOpening: '',
        safeToSend: false,
        reviewFlag: true,
        supportingReasons: [`uncaught:${error.status || error.message || error.name}`],
        research: { pages: [], failures: [String(error.message || error)] },
      };
    }
    const saved = {
      ...row, ...lead, ...result,
      elapsedMs: Date.now() - started,
      catchAllSource: isCatchAllRow(row),
      retryPass: 'phase1-infra-retry',
    };
    fs.writeFileSync(path.join(out, `retry6-${email.replace(/[^a-z0-9]+/g, '_')}.json`), JSON.stringify(saved, null, 2));
    results.push(saved);
    console.error(`  -> ${saved.classification} ${saved.primaryReason} pages=${saved.research?.pages?.length || 0}`);
  }

  const claimants = imported.map(r => ({
    company: r.company,
    companyDomain: r.companyDomain,
    hyperPersonalizedOpening: r.hyperPersonalizedOpening,
    classification: r.classification,
    validatedFacts: r.validatedFacts || r.facts || [],
    facts: r.facts || [],
    research: r.research || {},
    supportingReasons: r.supportingReasons || [],
    modelCalls: r.modelCalls || 0,
  }));
  await flagBatchDuplicates([...claimants, ...results], { createMessage });

  const funnel = {
    attempted: 6,
    HIGH: results.filter(r => r.classification === 'HIGH').length,
    MEDIUM: results.filter(r => r.classification === 'MEDIUM').length,
    RETRY_REQUIRED: results.filter(r => r.classification === 'RETRY_REQUIRED').length,
    ICP_MISMATCH: results.filter(r => r.classification === 'ICP_MISMATCH').length,
    REVIEW_REQUIRED: results.filter(r => r.classification === 'REVIEW_REQUIRED').length,
    auditFailures: results.filter(r => /OPENING_AUDIT_FAILED|OPENING_VALIDATION_FAILED|VALID_FACTS_INSUFFICIENT/.test(r.primaryReason || '')).length,
    duplicateDemotions: results.filter(r => r.primaryReason === 'DUPLICATE_OPENING_IN_BATCH').length,
    accepted: results.filter(r => ['HIGH', 'MEDIUM'].includes(r.classification)).length,
    outcomes: results.map(r => ({
      company: r.company, email: r.apolloVerifiedEmail, classification: r.classification,
      primaryReason: r.primaryReason, opening: r.hyperPersonalizedOpening || '',
      pages: r.research?.pages?.length || 0, failures: r.research?.failures || [],
      catchAll: !!(r.catchAllAdmitted || r.catchAllSource),
    })),
  };

  const approved = results.filter(r => ['HIGH', 'MEDIUM'].includes(r.classification));
  const importRows = approved.map(r => ({
    email: r.apolloVerifiedEmail || '',
    company: r.company || '',
    contactName: r.fullName || [r.firstName, r.lastName].filter(Boolean).join(' '),
    city: r.companyCity || '',
    tradeType: r.staffingLane || '',
    website: r.companyWebsite || '',
    notes: appendNotes(r.notes, r.classification, r.hyperPersonalizedOpening, r.catchAllAdmitted || r.catchAllSource),
    reviewCount: '', rating: '', tier: r.buyerTier || '',
    siteContext: r.hyperPersonalizedOpening || '',
    ref_confidence: r.classification,
    ref_catchAllAdmitted: (r.catchAllAdmitted || r.catchAllSource) ? 'yes' : 'no',
    ref_primaryReason: r.primaryReason || '',
    ref_campaignId: STAFFING_CAMPAIGN.id,
    ref_emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId,
  }));
  fs.writeFileSync(path.join(out, 'retry6-funnel.json'), JSON.stringify(funnel, null, 2));
  fs.writeFileSync(path.join(out, 'retry6-import-ready.csv'), importRows.length ? csv(importRows, Object.keys(importRows[0])) : '');
  console.log(JSON.stringify(funnel, null, 2));
}

main().catch(e => { console.error(e); process.exitCode = 1; });
