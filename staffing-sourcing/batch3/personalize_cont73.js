'use strict';
/**
 * Personalize ONLY the 73 Batch 3 continuation candidates.
 * Reuses the live staffing pipeline. Does not reprocess the original 84,
 * the 58 imported leads, or the six infrastructure-held retries.
 */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const {
  parseCsv, appendNotes, loadOpsEnv,
} = require('./personalize_batch3');

const LIVE_ROOT = process.env.LIVE_PIPELINE_ROOT || '/tmp/live-staffing-pipeline';
const LIVE_COMMIT = '732e215';
const HELD6 = new Set([
  'blopez@leadstaff.com',
  'jmarotta@actionlabor.com',
  'avargas@laboronsite.com',
  'bflores@st-staffing.com',
  'larry@staffingauthority.com',
  'dawnt@capitalareastaffing.com',
]);

const paths = Module._nodeModulePaths(path.join(LIVE_ROOT, 'integrations'));
module.paths.unshift(...paths);
const { STAFFING_CAMPAIGN } = require(path.join(LIVE_ROOT, 'integrations/staffing-campaign'));
const {
  previewStaffingPersonalization,
  flagBatchDuplicates,
} = require(path.join(LIVE_ROOT, 'integrations/staffing-personalization'));

const crypto = require('node:crypto');
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
function codeDigest() {
  const files = [
    'staffing-personalization.js',
    'staffing-research.js',
    'staffing-campaign.js',
    'staffing-compliance.js',
  ];
  return hash(files.map(f => fs.readFileSync(path.join(LIVE_ROOT, 'integrations', f), 'utf8')).join('\n'));
}

function csv(rows, columns) {
  const value = x => `"${String(x ?? '').replace(/"/g, '""')}"`;
  return '\uFEFF' + [columns, ...rows.map(r => columns.map(k => r[k]))].map(r => r.map(value).join(',')).join('\r\n') + '\r\n';
}

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

function isInfraFailure(result) {
  const reason = String(result?.primaryReason || '');
  const classif = String(result?.classification || '');
  if (classif === 'RETRY_REQUIRED') return true;
  if (reason === 'MODEL_OR_RESPONSE_ERROR' || reason === 'MODEL_UNAVAILABLE' || reason === 'MODEL_CREDITS_EXHAUSTED') return true;
  if (result?.executionBlocked) return true;
  return false;
}

function creditsExhausted(result) {
  return String(result?.primaryReason || '') === 'MODEL_CREDITS_EXHAUSTED';
}

async function opsFetch(ops, pathname, { method = 'GET', body, timeoutMs = 120000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${ops.url}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${ops.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, json };
  } finally { clearTimeout(t); }
}

function makeCreateMessage(ops) {
  return async function createMessage(input) {
    const res = await opsFetch(ops, '/anthropic', { method: 'POST', body: input, timeoutMs: 90000 });
    if (!res.ok || res.json?.type === 'error') {
      const message = res.json?.error?.message || res.json?.error || `anthropic_http_${res.status}`;
      const err = new Error(String(message));
      err.status = res.status;
      err.error = res.json;
      if (/credit balance is too low/i.test(String(message))) err.code = 'MODEL_CREDITS_EXHAUSTED';
      throw err;
    }
    return res.json;
  };
}

const val = (facts, kind) => (facts || []).filter(f => f.kind === kind).map(f => f.value).join('; ');

function priorClaimants(root) {
  const resultsPath = path.join(root, 'personalization', 'results.json');
  if (!fs.existsSync(resultsPath)) return [];
  const prior = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
  return (prior.results || [])
    .filter(r => ['HIGH', 'MEDIUM'].includes(r.classification) && r.hyperPersonalizedOpening)
    .map(r => ({
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
}

async function personalizeCont73({ input, out, priorRoot, concurrency = 3, maxRetries = 2 }) {
  const ops = loadOpsEnv();
  if (!ops.url || !ops.token || /REPLACE/.test(ops.url)) throw new Error('OPS_URL/OPS_TOKEN not configured');
  const rows = parseCsv(fs.readFileSync(input, 'utf8'));
  if (rows.length !== 73) throw new Error(`Expected 73 continuation candidates, found ${rows.length}`);
  const emails = rows.map(r => String(r.apolloVerifiedEmail || '').toLowerCase());
  if (new Set(emails).size !== 73) throw new Error('continuation CSV emails are not unique');
  const heldHit = emails.filter(e => HELD6.has(e));
  if (heldHit.length) throw new Error(`continuation CSV contains held-6 emails: ${heldHit.join(',')}`);

  fs.mkdirSync(out, { recursive: true });
  const cacheDir = path.join(out, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const digest = codeDigest();
  const createMessage = makeCreateMessage(ops);
  const results = new Array(rows.length);
  let stoppedForCredits = false;

  async function processIndex(i, { force = false } = {}) {
    if (stoppedForCredits) return;
    const row = rows[i];
    const lead = {
      ...Object.fromEntries(LEAD_FIELDS.map(k => [k, row[k]])),
      campaign: STAFFING_CAMPAIGN.name,
      campaignId: STAFFING_CAMPAIGN.id,
    };
    const cache = path.join(cacheDir, `lead-${String(i + 1).padStart(3, '0')}.json`);
    if (!force && fs.existsSync(cache)) {
      const saved = JSON.parse(fs.readFileSync(cache, 'utf8'));
      if (saved.codeDigest === digest && saved.companyDomain === row.companyDomain && saved.campaignId === STAFFING_CAMPAIGN.id) {
        if (!isInfraFailure(saved) || creditsExhausted(saved)) {
          results[i] = saved;
          return;
        }
      }
    }
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
      };
    }
    const saved = {
      ...row, ...lead, ...result, codeDigest: digest, liveCommit: LIVE_COMMIT,
      elapsedMs: Date.now() - started, catchAllSource: isCatchAllRow(row),
      continuationPass: 'phase2-cont73',
    };
    fs.writeFileSync(cache, JSON.stringify(saved, null, 2));
    results[i] = saved;
    if (creditsExhausted(saved)) stoppedForCredits = true;
  }

  async function runPool(indexes, label) {
    let next = 0;
    const list = indexes.slice();
    async function worker() {
      while (next < list.length && !stoppedForCredits) {
        const i = list[next++];
        await processIndex(i, { force: label !== 'pass-1' });
        const done = results.filter(Boolean).length;
        if (done % 5 === 0 || done === rows.length) {
          console.error(`  ${label} ${done}/${rows.length} cached`);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length || 1) }, worker));
  }

  await runPool([...Array(rows.length).keys()], 'pass-1');
  for (let attempt = 1; attempt <= maxRetries && !stoppedForCredits; attempt++) {
    const retry = results.map((r, i) => (!r || (isInfraFailure(r) && !creditsExhausted(r))) ? i : -1).filter(i => i >= 0);
    if (!retry.length) break;
    console.error(`  retry ${attempt}: ${retry.length} infrastructure/retry-required leads`);
    await runPool(retry, `retry-${attempt}`);
  }

  // Dense fill: Array#map skips holes, and a credits-exhausted stop leaves
  // unprocessed indexes empty. flagBatchDuplicates cannot see undefined rows.
  const afterPersonalization = rows.map((row, i) => results[i] || {
    ...row,
    campaign: STAFFING_CAMPAIGN.name,
    campaignId: STAFFING_CAMPAIGN.id,
    classification: 'RETRY_REQUIRED',
    primaryReason: stoppedForCredits ? 'MODEL_CREDITS_EXHAUSTED' : 'NOT_PROCESSED',
    hyperPersonalizedOpening: '',
    safeToSend: false,
    reviewFlag: true,
    catchAllSource: isCatchAllRow(row),
    supportingReasons: [stoppedForCredits
      ? 'unprocessed_after_model_credit_exhaustion'
      : 'unprocessed'],
    continuationPass: 'phase2-cont73',
  });
  const claimants = priorClaimants(priorRoot);
  const duplicateInput = [...claimants, ...afterPersonalization].filter(r => r && typeof r === 'object');
  await flagBatchDuplicates(duplicateInput, { createMessage });

  const counts = afterPersonalization.reduce((a, r) => {
    a[r.classification] = (a[r.classification] || 0) + 1;
    return a;
  }, { HIGH: 0, MEDIUM: 0, RETRY_REQUIRED: 0, REVIEW_REQUIRED: 0, ICP_MISMATCH: 0 });

  const retrievalReasons = new Set([
    'RETRIEVAL_UNUSABLE', 'RETRIEVAL_BLOCKED_403', 'RETRIEVAL_PAGE_NOT_FOUND', 'DOMAIN_IDENTITY_UNRESOLVED',
  ]);
  const funnel = {
    attempted: 73,
    liveCommit: LIVE_COMMIT,
    codeDigest: digest,
    stoppedForCredits,
    priorBatch3Claimants: claimants.length,
    counts,
    acceptedHigh: counts.HIGH,
    acceptedMedium: counts.MEDIUM,
    accepted: counts.HIGH + counts.MEDIUM,
    retrievalBlocked: afterPersonalization.filter(r => retrievalReasons.has(r.primaryReason)).length,
    icpRefusals: afterPersonalization.filter(r => r.classification === 'ICP_MISMATCH' || r.primaryReason === 'INDUSTRIAL_STAFFING_NOT_CONFIRMED' || r.primaryReason === 'PROFESSIONAL_OR_NONINDUSTRIAL_STAFFING' || r.primaryReason === 'ICP_ASSESSMENT_CONFLICT').length,
    auditFailures: afterPersonalization.filter(r => /OPENING_AUDIT_FAILED|OPENING_VALIDATION_FAILED|VALID_FACTS_INSUFFICIENT/.test(r.primaryReason || '')).length,
    duplicateOpeningDemotions: afterPersonalization.filter(r => r.primaryReason === 'DUPLICATE_OPENING_IN_BATCH').length,
    infrastructureRetryRequired: afterPersonalization.filter(r => isInfraFailure(r)).length,
    catchAllAccepted: afterPersonalization.filter(r => ['HIGH', 'MEDIUM'].includes(r.classification) && (r.catchAllAdmitted || r.catchAllSource)).length,
    nonCatchAllAccepted: afterPersonalization.filter(r => ['HIGH', 'MEDIUM'].includes(r.classification) && !(r.catchAllAdmitted || r.catchAllSource)).length,
    byReason: afterPersonalization.reduce((a, r) => {
      const key = `${r.classification}:${r.primaryReason || ''}`;
      a[key] = (a[key] || 0) + 1;
      return a;
    }, {}),
  };

  const approved = afterPersonalization.filter(r => ['HIGH', 'MEDIUM'].includes(r.classification));
  const importRows = approved.map(r => ({
    email: r.apolloVerifiedEmail || '',
    company: r.company || '',
    contactName: r.fullName || [r.firstName, r.lastName].filter(Boolean).join(' '),
    city: r.companyCity || '',
    tradeType: r.staffingLane || '',
    website: r.companyWebsite || '',
    notes: appendNotes(r.notes, r.classification, r.hyperPersonalizedOpening, r.catchAllAdmitted || r.catchAllSource),
    reviewCount: '',
    rating: '',
    tier: r.buyerTier || '',
    siteContext: r.hyperPersonalizedOpening || '',
    ref_hyperPersonalizedOpening: r.hyperPersonalizedOpening || '',
    ref_confidence: r.classification,
    ref_primaryReason: r.primaryReason || '',
    ref_firstName: r.firstName || '',
    ref_lastName: r.lastName || '',
    ref_buyerTitle: r.jobTitle || '',
    ref_state: r.companyState || '',
    ref_companySize: r.companySizeCategory || '',
    ref_staffingLane: r.staffingLane || '',
    ref_catchAllAdmitted: (r.catchAllAdmitted || r.catchAllSource) ? 'yes' : 'no',
    ref_emailAdmission: r.emailAdmission || '',
    ref_validatedRoles: val(r.facts, 'role'),
    ref_employerMarket: val(r.facts, 'employer_market'),
    ref_geography: val(r.facts, 'geography'),
    ref_sources: r.sourceURL_or_sourceDescription || '',
    ref_campaignId: STAFFING_CAMPAIGN.id,
    ref_emailTemplateId: STAFFING_CAMPAIGN.emailTemplateId,
  }));

  fs.writeFileSync(path.join(out, 'funnel.json'), JSON.stringify(funnel, null, 2));
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({
    funnel, campaign: { id: STAFFING_CAMPAIGN.id, name: STAFFING_CAMPAIGN.name, template: STAFFING_CAMPAIGN.emailTemplateId },
    results: afterPersonalization.map(r => ({
      company: r.company, companyDomain: r.companyDomain, email: r.apolloVerifiedEmail,
      classification: r.classification, primaryReason: r.primaryReason,
      hyperPersonalizedOpening: r.hyperPersonalizedOpening || '',
      catchAllAdmitted: !!(r.catchAllAdmitted || r.catchAllSource),
      emailAdmission: r.emailAdmission || null,
      safeToSend: !!r.safeToSend,
      supportingReasons: r.supportingReasons || [],
      modelCalls: r.modelCalls || 0,
    })),
  }, null, 2));

  const write = (name, table) => {
    const file = path.join(out, name);
    fs.writeFileSync(file, table.length ? csv(table, Object.keys(table[0])) : '');
    return file;
  };
  write('batch3-import-ready-approved.csv', importRows);
  write('batch3-disposition.csv', afterPersonalization.map(r => ({
    company: r.company, companyDomain: r.companyDomain, email: r.apolloVerifiedEmail || '',
    classification: r.classification, approvedForImport: ['HIGH', 'MEDIUM'].includes(r.classification) ? 'yes' : 'no',
    catchAll: (r.catchAllAdmitted || r.catchAllSource) ? 'yes' : 'no',
    hyperPersonalizedOpening: r.hyperPersonalizedOpening || '',
    primaryReason: r.primaryReason || '',
    supportingReasons: (r.supportingReasons || []).join(' | '),
  })));

  console.log(JSON.stringify(funnel, null, 2));
  return { funnel, importRows, results: afterPersonalization };
}

if (require.main === module) {
  const root = __dirname;
  const input = process.argv[2] || path.join(root, 'out/batch3-continuation-approved-candidates.csv');
  const out = process.argv[3] || path.join(root, 'personalization/cont73');
  personalizeCont73({
    input,
    out,
    priorRoot: root,
    concurrency: Number(process.env.B3_CONCURRENCY || 3),
  }).catch(e => { console.error(e); process.exitCode = 1; });
}

module.exports = { personalizeCont73 };
