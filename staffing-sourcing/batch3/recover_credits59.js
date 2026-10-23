'use strict';
/**
 * Final Anthropic-funded recovery for the 59 continuation leads held as
 * MODEL_CREDITS_EXHAUSTED. Reuses the live staffing pipeline unchanged.
 * Does not reprocess completed HIGH/MEDIUM/REVIEW_REQUIRED/ICP_MISMATCH,
 * the two RETRIEVAL_UNUSABLE continuation holds, or the six older held leads.
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
const COMPLETED = new Set(['HIGH', 'MEDIUM', 'REVIEW_REQUIRED', 'ICP_MISMATCH']);

const paths = Module._nodeModulePaths(path.join(LIVE_ROOT, 'integrations'));
module.paths.unshift(...paths);
const { STAFFING_CAMPAIGN } = require(path.join(LIVE_ROOT, 'integrations/staffing-campaign'));
const {
  previewStaffingPersonalization,
  flagBatchDuplicates,
} = require(path.join(LIVE_ROOT, 'integrations/staffing-personalization'));

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

function usableResearch(saved) {
  const research = saved?.research;
  const pages = research?.pages;
  if (!Array.isArray(pages) || !pages.length) return null;
  if (research.reviewRequired) return null;
  const text = pages.reduce((n, p) => n + String(p?.text || '').length, 0);
  if (text < 120) return null;
  return research;
}

function cloneResearch(research) {
  return JSON.parse(JSON.stringify({
    pages: research.pages,
    failures: research.failures || [],
    reviewRequired: !!research.reviewRequired,
    retrieval: research.retrieval || {},
  }));
}

function claimantsFrom(resultsPath) {
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

const val = (facts, kind) => (facts || []).filter(f => f.kind === kind).map(f => f.value).join('; ');

async function recoverCredits59({ root, out, concurrency = 3, maxRetries = 2 }) {
  const ops = loadOpsEnv();
  if (!ops.url || !ops.token || /REPLACE/.test(ops.url)) throw new Error('OPS_URL/OPS_TOKEN not configured');

  const cont73 = JSON.parse(fs.readFileSync(path.join(root, 'personalization/cont73/results.json'), 'utf8'));
  const targetEmails = (cont73.results || [])
    .filter(r => r.primaryReason === 'MODEL_CREDITS_EXHAUSTED')
    .map(r => String(r.email || '').toLowerCase());
  if (targetEmails.length !== 59) throw new Error(`expected 59 MODEL_CREDITS_EXHAUSTED, found ${targetEmails.length}`);
  if (new Set(targetEmails).size !== 59) throw new Error('target emails are not unique');
  const heldHit = targetEmails.filter(e => HELD6.has(e));
  if (heldHit.length) throw new Error(`target set contains held-6: ${heldHit.join(',')}`);

  const completedBlocked = (cont73.results || []).filter(r =>
    targetEmails.includes(String(r.email || '').toLowerCase()) && COMPLETED.has(r.classification));
  if (completedBlocked.length) {
    throw new Error(`refusing to reprocess completed outcomes: ${completedBlocked.map(r => r.email).join(',')}`);
  }

  const allRows = parseCsv(fs.readFileSync(path.join(root, 'out/batch3-continuation-approved-candidates.csv'), 'utf8'));
  const byEmail = new Map(allRows.map(r => [String(r.apolloVerifiedEmail || '').toLowerCase(), r]));
  const rows = targetEmails.map(email => {
    const row = byEmail.get(email);
    if (!row) throw new Error(`continuation CSV missing ${email}`);
    return row;
  });
  if (rows.length !== 59) throw new Error(`row filter produced ${rows.length}`);

  const priorCacheDir = path.join(root, 'personalization/cont73/cache');
  const priorByEmail = new Map();
  if (fs.existsSync(priorCacheDir)) {
    for (const name of fs.readdirSync(priorCacheDir).filter(n => n.endsWith('.json'))) {
      const saved = JSON.parse(fs.readFileSync(path.join(priorCacheDir, name), 'utf8'));
      const email = String(saved.apolloVerifiedEmail || saved.email || '').toLowerCase();
      if (email) priorByEmail.set(email, saved);
    }
  }

  fs.mkdirSync(out, { recursive: true });
  const cacheDir = path.join(out, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });

  const usage = {
    anthropicCalls: 0,
    anthropicErrors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  async function opsFetch(pathname, { method = 'GET', body, timeoutMs = 120000 } = {}) {
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
  const createMessage = async function createMessage(input) {
    usage.anthropicCalls += 1;
    const res = await opsFetch('/anthropic', { method: 'POST', body: input, timeoutMs: 90000 });
    const u = res.json?.usage;
    if (u) {
      usage.inputTokens += u.input_tokens || 0;
      usage.outputTokens += u.output_tokens || 0;
      usage.cacheReadInputTokens += u.cache_read_input_tokens || 0;
      usage.cacheCreationInputTokens += u.cache_creation_input_tokens || 0;
    }
    if (!res.ok || res.json?.type === 'error') {
      usage.anthropicErrors += 1;
      const message = res.json?.error?.message || res.json?.error || `anthropic_http_${res.status}`;
      const err = new Error(String(message));
      err.status = res.status;
      err.error = res.json;
      if (/credit balance is too low/i.test(String(message))) err.code = 'MODEL_CREDITS_EXHAUSTED';
      throw err;
    }
    return res.json;
  };

  const results = new Array(rows.length);
  let stoppedForCredits = false;

  async function processIndex(i, { force = false } = {}) {
    if (stoppedForCredits) return;
    const row = rows[i];
    const email = String(row.apolloVerifiedEmail || '').toLowerCase();
    const lead = {
      ...Object.fromEntries(LEAD_FIELDS.map(k => [k, row[k]])),
      campaign: STAFFING_CAMPAIGN.name,
      campaignId: STAFFING_CAMPAIGN.id,
    };
    const cache = path.join(cacheDir, `lead-${String(i + 1).padStart(3, '0')}.json`);
    let currentSaved = null;
    if (fs.existsSync(cache)) {
      currentSaved = JSON.parse(fs.readFileSync(cache, 'utf8'));
      if (!force && currentSaved.companyDomain === row.companyDomain && currentSaved.campaignId === STAFFING_CAMPAIGN.id
          && COMPLETED.has(currentSaved.classification)) {
        results[i] = currentSaved;
        return;
      }
    }

    const cached = usableResearch(currentSaved) || usableResearch(priorByEmail.get(email));
    const opts = { createMessage };
    let researchReused = false;
    if (cached) {
      const snapshot = cloneResearch(cached);
      opts.researchCompany = async () => cloneResearch(snapshot);
      researchReused = true;
    }

    const started = Date.now();
    let result;
    try {
      result = await previewStaffingPersonalization(lead, opts);
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
      ...row, ...lead, ...result,
      liveCommit: LIVE_COMMIT,
      elapsedMs: Date.now() - started,
      catchAllSource: isCatchAllRow(row),
      researchReused,
      recoveryPass: 'credits59',
    };
    fs.writeFileSync(cache, JSON.stringify(saved, null, 2));
    results[i] = saved;
    console.error(`  ${String(i + 1).padStart(2, '0')}/59 ${row.company}: ${saved.classification} ${saved.primaryReason} reused=${researchReused} pages=${saved.research?.pages?.length || 0}`);
    if (creditsExhausted(saved)) stoppedForCredits = true;
  }

  async function runPool(indexes, label) {
    let next = 0;
    const list = indexes.slice();
    async function worker() {
      while (next < list.length && !stoppedForCredits) {
        const i = list[next++];
        await processIndex(i, { force: label !== 'pass-1' });
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length || 1) }, worker));
    console.error(`  ${label} done cached=${results.filter(Boolean).length}/59`);
  }

  await runPool([...Array(rows.length).keys()], 'pass-1');
  for (let attempt = 1; attempt <= maxRetries && !stoppedForCredits; attempt++) {
    const retry = results.map((r, i) => (!r || (isInfraFailure(r) && !creditsExhausted(r))) ? i : -1).filter(i => i >= 0);
    if (!retry.length) break;
    console.error(`  retry ${attempt}: ${retry.length} infrastructure/retry-required leads`);
    await runPool(retry, `retry-${attempt}`);
  }

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
    recoveryPass: 'credits59',
    researchReused: false,
  });

  const origClaimants = claimantsFrom(path.join(root, 'personalization/results.json'));
  const cont73Claimants = claimantsFrom(path.join(root, 'personalization/cont73/results.json'));
  const duplicateInput = [...origClaimants, ...cont73Claimants, ...afterPersonalization]
    .filter(r => r && typeof r === 'object');
  await flagBatchDuplicates(duplicateInput, { createMessage });

  const cachedResearchReused = afterPersonalization.filter(r => r.researchReused).length;
  const freshResearchRequired = afterPersonalization.length - cachedResearchReused;
  const counts = afterPersonalization.reduce((a, r) => {
    a[r.classification] = (a[r.classification] || 0) + 1;
    return a;
  }, { HIGH: 0, MEDIUM: 0, RETRY_REQUIRED: 0, REVIEW_REQUIRED: 0, ICP_MISMATCH: 0 });
  const retrievalReasons = new Set([
    'RETRIEVAL_UNUSABLE', 'RETRIEVAL_BLOCKED_403', 'RETRIEVAL_PAGE_NOT_FOUND', 'DOMAIN_IDENTITY_UNRESOLVED',
  ]);
  const funnel = {
    attempted: 59,
    liveCommit: LIVE_COMMIT,
    stoppedForCredits,
    cachedResearchReused,
    freshResearchRequired,
    priorClaimants: origClaimants.length + cont73Claimants.length,
    counts,
    acceptedHigh: counts.HIGH,
    acceptedMedium: counts.MEDIUM,
    accepted: counts.HIGH + counts.MEDIUM,
    retrievalBlocked: afterPersonalization.filter(r => retrievalReasons.has(r.primaryReason)).length,
    icpRefusals: afterPersonalization.filter(r => r.classification === 'ICP_MISMATCH' || r.primaryReason === 'INDUSTRIAL_STAFFING_NOT_CONFIRMED' || r.primaryReason === 'PROFESSIONAL_OR_NONINDUSTRIAL_STAFFING' || r.primaryReason === 'ICP_ASSESSMENT_CONFLICT').length,
    auditFailures: afterPersonalization.filter(r => /OPENING_AUDIT_FAILED|OPENING_VALIDATION_FAILED|VALID_FACTS_INSUFFICIENT/.test(r.primaryReason || '')).length,
    duplicateOpeningDemotions: afterPersonalization.filter(r => r.primaryReason === 'DUPLICATE_OPENING_IN_BATCH').length,
    remainingRetryRequired: afterPersonalization.filter(r => r.classification === 'RETRY_REQUIRED').length,
    catchAllAccepted: afterPersonalization.filter(r => ['HIGH', 'MEDIUM'].includes(r.classification) && (r.catchAllAdmitted || r.catchAllSource)).length,
    nonCatchAllAccepted: afterPersonalization.filter(r => ['HIGH', 'MEDIUM'].includes(r.classification) && !(r.catchAllAdmitted || r.catchAllSource)).length,
    usage,
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
    ref_researchReused: r.researchReused ? 'yes' : 'no',
  }));

  fs.writeFileSync(path.join(out, 'funnel.json'), JSON.stringify(funnel, null, 2));
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({
    funnel,
    campaign: { id: STAFFING_CAMPAIGN.id, name: STAFFING_CAMPAIGN.name, template: STAFFING_CAMPAIGN.emailTemplateId },
    results: afterPersonalization.map(r => ({
      company: r.company, companyDomain: r.companyDomain, email: r.apolloVerifiedEmail,
      classification: r.classification, primaryReason: r.primaryReason,
      hyperPersonalizedOpening: r.hyperPersonalizedOpening || '',
      catchAllAdmitted: !!(r.catchAllAdmitted || r.catchAllSource),
      emailAdmission: r.emailAdmission || null,
      safeToSend: !!r.safeToSend,
      researchReused: !!r.researchReused,
      supportingReasons: r.supportingReasons || [],
      modelCalls: r.modelCalls || 0,
    })),
  }, null, 2));
  const write = (name, table) => {
    fs.writeFileSync(path.join(out, name), table.length ? csv(table, Object.keys(table[0])) : '');
  };
  write('batch3-import-ready-approved.csv', importRows);
  write('batch3-disposition.csv', afterPersonalization.map(r => ({
    company: r.company, companyDomain: r.companyDomain, email: r.apolloVerifiedEmail || '',
    classification: r.classification, approvedForImport: ['HIGH', 'MEDIUM'].includes(r.classification) ? 'yes' : 'no',
    catchAll: (r.catchAllAdmitted || r.catchAllSource) ? 'yes' : 'no',
    researchReused: r.researchReused ? 'yes' : 'no',
    hyperPersonalizedOpening: r.hyperPersonalizedOpening || '',
    primaryReason: r.primaryReason || '',
    supportingReasons: (r.supportingReasons || []).join(' | '),
  })));
  console.log(JSON.stringify(funnel, null, 2));
  return { funnel, importRows, results: afterPersonalization };
}

if (require.main === module) {
  const root = __dirname;
  recoverCredits59({
    root,
    out: process.argv[2] || path.join(root, 'personalization/credits59'),
    concurrency: Number(process.env.B3_CONCURRENCY || 3),
  }).catch(e => { console.error(e); process.exitCode = 1; });
}

module.exports = { recoverCredits59 };
