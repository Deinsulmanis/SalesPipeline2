'use strict';

// Read-only classification. Inputs are the frozen canonical inventory and
// archived/fresh research; output is a private review artifact, not CRM writes.
const fs = require('node:fs');
const path = require('node:path');
const inventory = JSON.parse(fs.readFileSync(process.env.INVENTORY_PATH, 'utf8'));
const archive = JSON.parse(fs.readFileSync(process.env.ARCHIVE_PATH, 'utf8'));
const rerunDir = process.env.RECHECK_DIR;
const byOld = new Map(archive.map(record => [record.leadId, record]));
const oldThree = new Set(['muj0yvmkcma90wklvw', 'muj0yvmkcnea3a0k1gp', 'muj0yvmkfsplzmjkqys']);
const reasonMap = {
  PROFESSIONAL_OR_NONINDUSTRIAL_STAFFING: 'NON_INDUSTRIAL_STAFFING',
  ICP_ASSESSMENT_CONFLICT: 'ICP_CONFLICT',
  INDUSTRIAL_STAFFING_NOT_CONFIRMED: 'ICP_UNCONFIRMED',
  OPENING_AUDIT_FAILED: 'PERSONALIZATION_AUDIT_FAILED',
  RETRIEVAL_UNUSABLE: 'WEBSITE_UNAVAILABLE',
  ROLE_MARKET_RELATIONSHIP_NOT_PROVEN_SAFE_FALLBACK: 'REVIEW_REQUIRED',
};
const fitMap = { NON_INDUSTRIAL_STAFFING: 'ICP_REJECT', ICP_CONFLICT: 'ICP_UNRESOLVED',
  ICP_UNCONFIRMED: 'ICP_UNRESOLVED', WEBSITE_UNAVAILABLE: 'ICP_UNRESOLVED' };
const reviewNotes = notes => {
  const match = String(notes || '').match(/(?:ICP review:|\[BUYER_HOLD:|\[OUTREACH_QA_HOLD_V1\])\s*([^\]]+)/i);
  return match ? match[1].trim().slice(0, 500) : String(notes || '').slice(0, 500);
};

function classify(row) {
  const old = byOld.get(row.leadId);
  const rerunFile = path.join(rerunDir, `${row.leadId}.json`);
  const fresh = fs.existsSync(rerunFile) ? JSON.parse(fs.readFileSync(rerunFile, 'utf8')) : null;
  let reason, explanation, evidence, fit = row.fit, temporary = true, couldBecomeEligible = true, reviewSource;
  if (oldThree.has(row.leadId)) {
    reason = 'MANUAL_HOLD'; explanation = old.finalReason;
    evidence = [{ source: old.evidenceUrl, detail: old.evidenceQuote },
      { source: 'archived 2026-09-26 held-salvage-final', detail: old.finalReason }];
    reviewSource = 'staffing_apollo_20260926_and_current_inventory';
  } else if (old) {
    reason = old.leadFitStatus === 'ICP_REJECT' ? 'ICP_REJECT' : 'ICP_UNRESOLVED';
    explanation = old.finalReason;
    evidence = [{ source: old.evidenceUrl, detail: old.evidenceQuote },
      { source: 'archived 2026-09-26 held-salvage-final', detail: old.originalHoldReason }];
    temporary = reason !== 'ICP_REJECT'; couldBecomeEligible = temporary;
    reviewSource = 'staffing_apollo_20260926_and_current_inventory';
  } else if (fresh) {
    const result = fresh.result;
    reason = reasonMap[result.primaryReason] || 'REVIEW_REQUIRED';
    fit = fitMap[reason] || row.fit;
    if (reason === 'REVIEW_REQUIRED') {
      explanation = 'Previous personalization attempt failed; fresh recheck now generated a safe fallback. The original per-lead failure detail is unavailable, so copy and fit need operator review before release.';
    } else if (reason === 'WEBSITE_UNAVAILABLE') {
      explanation = 'Official website research was unusable in the fresh check. Current industrial staffing fit cannot be validated from retrieved evidence; this is a retry or manual research hold, not an ICP rejection.';
    } else if (reason === 'PERSONALIZATION_AUDIT_FAILED') {
      explanation = `Industrial staffing fit is supported, but the generated opening failed the personalization audit: ${result.reviewReasons.join(', ')}.`;
    } else if (reason === 'ICP_CONFLICT') {
      explanation = `The fresh fit assessment says ${result.icpFit}, while the independent evidence extraction says ${result.extractedFit}; resolve this disagreement before using the old confirmed fit. ${result.fitReason}`;
    } else {
      explanation = result.fitReason || result.primaryReason;
    }
    const quoteEvidence = [...(result.validatedFacts || []), ...(result.rejectedFacts || [])]
      .flatMap(fact => fact.evidence || [])
      .filter(item => item.sourceUrl && item.quote)
      .filter((item, index, items) => items.findIndex(other => other.quote === item.quote) === index)
      .slice(0, 3)
      .map(item => ({ source: item.sourceUrl, detail: String(item.quote).slice(0, 350) }));
    const urls = [...new Set((result.research?.pages || []).map(page => page.url).filter(Boolean))];
    evidence = [{ source: `staffing personalization recheck ${fresh.auditedAt}`, detail: `${result.classification}: ${result.primaryReason}; fit=${result.icpFit}; extractedFit=${result.extractedFit}; ${result.fitReason || ''}`.trim() },
      ...quoteEvidence,
      ...(quoteEvidence.length ? [] : urls.slice(0, 2).map(url => ({ source: url,
        detail: 'First-party research retrieved for this individual lead; full page content retained in private audit artifact.' })))];
    if (reason === 'WEBSITE_UNAVAILABLE') evidence.push({ source: 'research retrieval', detail: JSON.stringify(result.retrieval || {}).slice(0, 600) });
    temporary = reason !== 'NON_INDUSTRIAL_STAFFING'; couldBecomeEligible = temporary;
    reviewSource = `staffing_personalization_recheck_${fresh.researchSource}`;
  } else if (row.stage === 'Review' || row.fit === 'ICP_UNRESOLVED') {
    const note = reviewNotes(row.lead.notes);
    reason = row.fit === 'ICP_UNRESOLVED' || row.fit === 'ICP_REVIEW' ? 'ICP_UNRESOLVED' : 'REVIEW_REQUIRED';
    fit = row.fit === 'ICP_REVIEW' ? 'ICP_UNRESOLVED' : row.fit;
    explanation = note;
    evidence = [{ source: row.lead.website || 'current canonical lead notes', detail: note },
      { source: 'canonical campaign notes', detail: row.lead.campaign_notes }];
    reviewSource = 'staffing_readiness_20261005_and_current_canonical_notes';
  } else throw new Error(`No individual evidence for ${row.leadId}`);
  if (!reason || !explanation || !evidence?.length || !fit) throw new Error(`Incomplete ${row.leadId}`);
  return { leadId: row.leadId, company: row.company, email: row.email, stage: row.stage,
    before: { fit: row.fit, personalization: row.personalization, routingReady: row.routingReady,
      manualHold: row.manualHold, siteContext: row.lead.siteContext || '' },
    after: { fit, personalization: row.personalization, routingReady: false,
      manualHold: row.manualHold, stage: row.stage },
    hold: { reason, explanation, evidence, reviewedAt: new Date().toISOString(), reviewSource,
      temporary, couldBecomeEligible }, evidenceGaps: reason === 'REVIEW_REQUIRED' && Boolean(fresh)
      ? ['Original per-lead failure detail from previous personalization rerun unavailable'] : [] };
}

if (inventory.heldCount !== 63 || inventory.records.length !== 63) throw new Error('Expected 63 frozen held leads');
const records = inventory.records.map(classify);
if (new Set(records.map(item => item.leadId)).size !== 63) throw new Error('Duplicate lead ID');
fs.writeFileSync(process.env.CLASSIFICATION_PATH, JSON.stringify({
  capturedAt: inventory.capturedAt, classifiedAt: new Date().toISOString(), total: records.length, records,
}, null, 2));
const counts = records.reduce((out, row) => (out[row.hold.reason] = (out[row.hold.reason] || 0) + 1, out), {});
console.log(JSON.stringify({ total: records.length, counts,
  correctedFit: records.filter(row => row.before.fit !== row.after.fit).length,
  evidenceGaps: records.filter(row => row.evidenceGaps.length).length }, null, 2));
