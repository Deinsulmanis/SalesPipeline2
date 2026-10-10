'use strict';

// One structured hold annotation in the existing canonical campaign_notes
// column. The review tag remains the source for fit, copy quality and routing.
const START = '[STAFFING_HOLD_V1]';
const END = '[/STAFFING_HOLD_V1]';
const BLOCK = /\n?\[STAFFING_HOLD_V1\]\s*([\s\S]*?)\s*\[\/STAFFING_HOLD_V1\]/g;
const REASONS = Object.freeze([
  'NON_INDUSTRIAL_STAFFING', 'ICP_CONFLICT', 'ICP_UNCONFIRMED',
  'PERSONALIZATION_AUDIT_FAILED', 'WEBSITE_UNAVAILABLE', 'DUPLICATE_OPENING',
  'ICP_REJECT', 'ICP_UNRESOLVED', 'MANUAL_HOLD', 'REVIEW_REQUIRED', 'OTHER',
]);

const hasStaffingHoldMarker = lead => String(lead?.campaign_notes || lead?.campaignNotes || '').includes(START);

function staffingHoldStatus(lead = {}) {
  const notes = String(lead.campaign_notes || lead.campaignNotes || '');
  const matches = [...notes.matchAll(BLOCK)];
  if (matches.length !== 1) return null;
  try {
    const parsed = JSON.parse(matches[0][1]);
    if (!parsed || parsed.version !== 1 || !REASONS.includes(parsed.reason)
      || !parsed.explanation || !parsed.reviewedAt || !parsed.reviewSource
      || !Array.isArray(parsed.evidence)) return null;
    return parsed;
  } catch (_) { return null; }
}

function withStaffingHold(campaignNotes, hold) {
  if (!hold || !REASONS.includes(hold.reason)) throw new Error('Invalid staffing hold reason');
  if (!String(hold.explanation || '').trim()) throw new Error('Staffing hold explanation required');
  if (!Array.isArray(hold.evidence) || !hold.evidence.length
    || hold.evidence.some(item => !item || !item.source || !item.detail)) {
    throw new Error('Staffing hold evidence required');
  }
  if (!Number.isFinite(Date.parse(hold.reviewedAt)) || !String(hold.reviewSource || '').trim()) {
    throw new Error('Staffing hold review provenance required');
  }
  const record = {
    version: 1, reason: hold.reason, explanation: String(hold.explanation).trim(),
    evidence: hold.evidence.map(item => ({ source: String(item.source), detail: String(item.detail) })),
    reviewedAt: new Date(hold.reviewedAt).toISOString(), reviewSource: String(hold.reviewSource).trim(),
    temporary: Boolean(hold.temporary), couldBecomeEligible: Boolean(hold.couldBecomeEligible),
  };
  const prefix = String(campaignNotes || '').replace(BLOCK, '').trimEnd();
  return `${prefix}\n${START}\n${JSON.stringify(record)}\n${END}`;
}

function staffingHoldInconsistencies(lead = {}) {
  const hold = staffingHoldStatus(lead);
  if (!hold) return [];
  const { staffingReviewStatus } = require('./staffing-campaign');
  const review = staffingReviewStatus(lead);
  const problems = [];
  if (!review) problems.push('missing staffing fit/personalization/routing review');
  if (review?.routingReady) problems.push('held lead marked routing ready');
  if (lead.stage === 'Queued') problems.push('held lead is queued');
  if (hold.reason === 'NON_INDUSTRIAL_STAFFING' || hold.reason === 'ICP_REJECT') {
    if (review?.fit !== 'ICP_REJECT') problems.push('rejected fit not reflected in review tag');
  }
  if (['ICP_CONFLICT', 'ICP_UNCONFIRMED', 'ICP_UNRESOLVED'].includes(hold.reason)
    && review?.fit !== 'ICP_UNRESOLVED') problems.push('unresolved fit not reflected in review tag');
  if (hold.reason === 'MANUAL_HOLD' && !String(lead.notes || '').includes('[MANUAL HOLD]')) {
    problems.push('manual hold marker missing');
  }
  return problems;
}

module.exports = { REASONS, hasStaffingHoldMarker, staffingHoldStatus, withStaffingHold, staffingHoldInconsistencies };
