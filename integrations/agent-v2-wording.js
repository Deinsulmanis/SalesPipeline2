'use strict';

const { isDeepStrictEqual } = require('node:util');
const { AUTHORITY, CATALOG_VERSION, FACT_IDS } = require('./agent-v2-contract');
const { evaluateAgentV2Permission, VERDICT } = require('./agent-v2-permission');

const WORDING_VERSION = 'agent_v2_wording_v1';
const RENDERABLE = new Set(['SUGGEST_QUALIFICATION', 'SUGGEST_INFO',
  'SUGGEST_FACT_ANSWER', 'SUGGEST_BOOKING_COORDINATION']);
const FACT_PHRASES = Object.freeze({
  F_TARGET_AGENCIES: 'We work with industrial and skilled-trades staffing agencies.',
  F_QUALIFIED_EMPLOYER_MEETINGS: 'The goal is qualified employer meetings.',
  F_HANDLES_PROSPECTING: 'employer prospecting',
  F_HANDLES_OUTREACH: 'employer outreach',
  F_HANDLES_QUALIFICATION: 'qualification',
  F_CALENDAR_PLACEMENT: 'Interested employers are placed on your calendar.',
  F_30_DAY_PILOT: 'The employer acquisition pilot lasts 30 days.',
  F_PERFORMANCE_BASED: 'The pilot is performance-based.',
  F_PAYMENT_TIED_MEETINGS: 'Payment is tied to qualified employer meetings.',
  F_NO_MEETINGS_NO_FEES: 'If there are no qualified meetings, there are no meeting fees.',
});
const FACT_ORDER = Object.freeze([
  'F_30_DAY_PILOT', 'F_TARGET_AGENCIES', 'F_QUALIFIED_EMPLOYER_MEETINGS',
  'F_HANDLES_PROSPECTING', 'F_HANDLES_OUTREACH', 'F_HANDLES_QUALIFICATION',
  'F_CALENDAR_PLACEMENT', 'F_PERFORMANCE_BASED', 'F_PAYMENT_TIED_MEETINGS',
  'F_NO_MEETINGS_NO_FEES',
]);
const HANDLES = new Set(['F_HANDLES_PROSPECTING', 'F_HANDLES_OUTREACH', 'F_HANDLES_QUALIFICATION']);

function list(items) {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function factWording(ids) {
  const selected = new Set(ids);
  const sentences = [];
  let handlesWritten = false;
  for (const id of FACT_ORDER) {
    if (!selected.has(id)) continue;
    if (HANDLES.has(id)) {
      if (!handlesWritten) {
        const work = FACT_ORDER.filter(item => HANDLES.has(item) && selected.has(item))
          .map(item => FACT_PHRASES[item]);
        sentences.push(`We handle ${list(work)}.`);
        handlesWritten = true;
      }
    } else sentences.push(FACT_PHRASES[id]);
  }
  return sentences.join(' ');
}

function approvedWording(state, record) {
  const decision = record.decision;
  if (decision.actionId === 'SUGGEST_QUALIFICATION') return decision.suggestedWording;
  if (decision.actionId === 'SUGGEST_BOOKING_COORDINATION')
    return 'Happy to coordinate the next step with you.';
  const facts = factWording(decision.factIds);
  const inbound = state.turns.find(turn => turn.direction === 'inbound'
    && turn.messageId === record.messageId);
  return inbound?.decision?.finalClassification === 'QUESTION'
    ? `Sure — ${facts[0].toLowerCase()}${facts.slice(1)}` : facts;
}

function output(status, reasonCode, record, wording = null) {
  return Object.freeze({ version: WORDING_VERSION, status, reasonCode,
    decisionId: typeof record?.decisionId === 'string' ? record.decisionId : null,
    actionId: typeof record?.decision?.actionId === 'string' ? record.decision.actionId : null,
    catalogVersion: CATALOG_VERSION, wording,
    executionAuthorized: false, authority: AUTHORITY });
}

function validateCandidate(candidate, approved) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
    || !isDeepStrictEqual(Object.keys(candidate), ['wording'])
    || typeof candidate.wording !== 'string') return 'MALFORMED_WORDING';
  const wording = candidate.wording;
  if (!wording.trim() || wording !== wording.trim() || /[\x00-\x1f\x7f]/.test(wording)
    || wording.length > 700 || wording.split(/\s+/).length > 100) return 'MALFORMED_WORDING';
  if (/\b(?:https?:\/\/|www\.|calendly\.com|calendar\.google\.com)\b/i.test(wording))
    return 'UNAPPROVED_BOOKING_LINK';
  if (/(?:[$€£]\s*\d|\b(?:USD|CAD)\s*\d|\b\d+(?:\.\d+)?\s*(?:dollars?|percent|%)\b)/i.test(wording))
    return 'UNSUPPORTED_PRICE';
  if (/\b(?:case stud(?:y|ies)|testimonial|customer results?|client results?|we generated|we delivered|guaranteed? meetings?)\b/i.test(wording))
    return 'UNSUPPORTED_PROOF_OR_RESULTS';
  // The finite rendering is the allowlist. This also rejects unselected facts,
  // extra qualification fields, contradicted facts, and changed offer terms.
  if (wording !== approved) return 'WORDING_OUTSIDE_APPROVED_RENDERING';
  return null;
}

function renderAgentV2Wording({ state, record, permission, candidate } = {}) {
  const current = evaluateAgentV2Permission(state, record);
  if (!isDeepStrictEqual(permission, current))
    return output('HANDOFF', 'PERMISSION_MISMATCH', record);
  if (current.verdict !== VERDICT.ALLOW)
    return output('NO_WORDING', `PERMISSION_${current.verdict}`, record);
  if (!RENDERABLE.has(record.decision.actionId))
    return output('HANDOFF', 'ACTION_NOT_RENDERABLE', record);
  if (record.catalogVersion !== CATALOG_VERSION
    || !isDeepStrictEqual([...FACT_IDS].sort(), Object.keys(FACT_PHRASES).sort())
    || !isDeepStrictEqual([...FACT_IDS].sort(), [...FACT_ORDER].sort()))
    return output('HANDOFF', 'CATALOG_MISMATCH', record);
  const approved = approvedWording(state, record);
  const proposed = candidate === undefined ? { wording: approved } : candidate;
  const failure = validateCandidate(proposed, approved);
  if (failure) return output('HANDOFF', failure, record);
  return output('RENDERED', 'APPROVED_WORDING', record, proposed.wording);
}

module.exports = { WORDING_VERSION, renderAgentV2Wording };
