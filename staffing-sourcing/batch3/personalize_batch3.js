'use strict';
/**
 * Batch 3 personalization runner.
 *
 * Uses the currently deployed staffing pipeline (Railway commit 732e215) from
 * /tmp/live-staffing-pipeline. Does not modify production ICP, templates,
 * send controls, or the Gmail worktree. Writes only Batch 3 artifacts.
 *
 * Anthropic calls go through the authenticated staffing-batch3-ops proxy so
 * the live SalesPipeline2 key is used without copying it into this workspace.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');

const LIVE_ROOT = process.env.LIVE_PIPELINE_ROOT || '/tmp/live-staffing-pipeline';
const OPS_ENV = '/tmp/staffing-batch3-ops.env';
const LIVE_COMMIT = '732e215';

function loadOpsEnv() {
  const env = {};
  if (fs.existsSync(OPS_ENV)) {
    for (const line of fs.readFileSync(OPS_ENV, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) env[m[1]] = m[2];
    }
  }
  return {
    url: process.env.OPS_URL || env.OPS_URL,
    token: process.env.OPS_TOKEN || env.OPS_TOKEN,
  };
}

const paths = Module._nodeModulePaths(path.join(LIVE_ROOT, 'integrations'));
module.paths.unshift(...paths);
const { STAFFING_CAMPAIGN } = require(path.join(LIVE_ROOT, 'integrations/staffing-campaign'));
const {
  previewStaffingPersonalization,
  flagBatchDuplicates,
} = require(path.join(LIVE_ROOT, 'integrations/staffing-personalization'));

function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); if (row.some(Boolean)) rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (quoted) throw new Error('Unclosed CSV quote');
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const header = rows.shift().map(x => x.replace(/^\uFEFF/, ''));
  return rows.map((r, i) => {
    if (r.length !== header.length) throw new Error(`CSV width mismatch at record ${i + 2}`);
    return Object.fromEntries(header.map((k, j) => [k, r[j]]));
  });
}
function csv(rows, columns) {
  const value = x => `"${String(x ?? '').replace(/"/g, '""')}"`;
  return '\uFEFF' + [columns, ...rows.map(r => columns.map(k => r[k]))].map(r => r.map(value).join(',')).join('\r\n') + '\r\n';
}
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

function appendNotes(existing, classification, opening, catchAll) {
  const parts = [];
  const cur = String(existing || '').trim();
  if (cur) parts.push(cur);
  parts.push(`[STAFFING ${classification}] ${opening}`.trim());
  if (!/\b\[B3\]\b/.test(cur)) parts.push('[B3]');
  if (catchAll && !/\[B3 CATCH-ALL\]/.test(cur)) parts.push('[B3 CATCH-ALL]');
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

const val = (facts, kind) => (facts || []).filter(f => f.kind === kind).map(f => f.value).join('; ');

async function personalizeAll({ input, out, concurrency = 3, maxRetries = 2 }) {
  const ops = loadOpsEnv();
  if (!ops.url || !ops.token || /REPLACE/.test(ops.url)) throw new Error('OPS_URL/OPS_TOKEN not configured');
  const source = fs.readFileSync(input, 'utf8');
  const rows = parseCsv(source);
  if (rows.length !== 84) throw new Error(`Expected 84 approved candidates, found ${rows.length}`);
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
        classification: /credit balance is too low/i.test(message) || error.code === 'MODEL_CREDITS_EXHAUSTED'
          ? 'RETRY_REQUIRED' : 'RETRY_REQUIRED',
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

  const afterPersonalization = results.map(r => r || {
    classification: 'RETRY_REQUIRED', primaryReason: 'NOT_PROCESSED', hyperPersonalizedOpening: '',
  });
  await flagBatchDuplicates(afterPersonalization, { createMessage });

  const counts = afterPersonalization.reduce((a, r) => {
    a[r.classification] = (a[r.classification] || 0) + 1;
    return a;
  }, { HIGH: 0, MEDIUM: 0, RETRY_REQUIRED: 0, REVIEW_REQUIRED: 0, ICP_MISMATCH: 0 });

  const retrievalReasons = new Set([
    'RETRIEVAL_UNUSABLE', 'RETRIEVAL_BLOCKED_403', 'RETRIEVAL_PAGE_NOT_FOUND', 'DOMAIN_IDENTITY_UNRESOLVED',
  ]);
  const funnel = {
    attempted: 84,
    liveCommit: LIVE_COMMIT,
    codeDigest: digest,
    stoppedForCredits,
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
  const input = process.argv[2] || path.join(__dirname, 'out/batch3-approved-candidates.csv');
  const out = process.argv[3] || path.join(__dirname, 'personalization');
  personalizeAll({ input, out, concurrency: Number(process.env.B3_CONCURRENCY || 3) })
    .catch(e => { console.error(e); process.exitCode = 1; });
}

module.exports = { personalizeAll, parseCsv, appendNotes, loadOpsEnv };
