'use strict';

const crypto = require('node:crypto');
const { CONVERSATION_STATE_VERSION, stableStringify } = require('./conversation-state');
const { INPUT_VERSION, CATALOG_VERSION, OFFER_FACTS, SLOT_IDS } = require('./agent-v2-contract');

const MAX_CONTEXT_TURNS = 8;
const MAX_TURN_TEXT = 500;
const RISK_WARNING_CODES = new Set([
  'sender_ownership_conflict', 'sender_mismatch', 'multiple_executable_owners',
  'reply_decision_missing', 'metadata_unparseable', 'automated_send_also_recorded_as_human',
  'inbound_from_other_address', 'email_shared_with_other_leads',
]);

function riskFlags(state, target) {
  const text = String(target.content || '');
  const flags = [];
  if (/\b(?:case stud(?:y|ies)|testimonial|reference(?:s)?|proof|track record)\b/i.test(text)) flags.push('proof_request');
  if (/\b(?:results?|conversion rate|success rate|meetings? (?:per|in) (?:week|month)|how many meetings|employer demand)\b/i.test(text)) flags.push('results_request');
  if (/\b(?:how much|what(?:\'s| is) the (?:price|cost|rate)|price(?:s|d)?|pricing|costs?|fees?|commission|retainer|percentage|percent)\b/i.test(text)) flags.push('pricing_request');
  if (/\b(?:how much|what(?:\'s| is) the (?:price|cost|rate)|exact (?:price|cost|rate)|quote)\b/i.test(text)) flags.push('amount_request');
  if (/\b(?:exact (?:price|cost|rate)|quote|per meeting|\$|discount|refund|guarantee|guaranteed|minimum|volume|contract terms|exclusiv(?:e|ity))\b/i.test(text)) flags.push('unsupported_commercial_request');
  if (/\b(?:complaint|unacceptable|misleading|spam complaint|report you|legal action)\b/i.test(text)) flags.push('complaint');
  if (/\b(?:reschedul\w*|move (?:our|the) (?:call|meeting)|cancel (?:our|the) (?:call|meeting))\b/i.test(text)) flags.push('reschedule_request');
  if (state.thread?.threadIds?.length > 1) flags.push('multiple_threads');
  if ((state.evidenceWarnings || []).some(w => RISK_WARNING_CODES.has(w.code))) flags.push('conflicting_evidence');
  return [...new Set(flags)].sort();
}

function compactTurn(turn) {
  return {
    ref: turn.turnId, actor: turn.actor, direction: turn.direction,
    messageId: turn.messageId || null, threadId: turn.threadId || null,
    occurredAt: turn.occurredAt || null, content: turn.contentAvailable
      ? String(turn.content || '').slice(0, MAX_TURN_TEXT) : null,
    contentTruncated: Boolean(turn.contentTruncated || String(turn.content || '').length > MAX_TURN_TEXT),
    classification: turn.classification?.value || null,
    decisionStatus: turn.decision?.status || null,
  };
}

function buildAgentV2Input(state, messageId) {
  if (!state || state.version !== CONVERSATION_STATE_VERSION) throw new Error('Phase 1 conversation state required');
  if (state.identity?.family !== 'industrial_staffing') throw new Error('industrial staffing state required');
  const leadId = String(state.identity.leadId || '').trim();
  const id = String(messageId || '').trim();
  if (!leadId || !id) throw new Error('leadId and inbound messageId required');
  const allTurns = Array.isArray(state.turns) ? state.turns : [];
  const target = allTurns.find(turn => turn.direction === 'inbound' && turn.messageId === id);
  if (!target) throw new Error('inbound message absent from Phase 1 state');
  const inbound = allTurns.filter(turn => turn.direction === 'inbound');
  const latest = inbound[inbound.length - 1];
  const historical = latest.turnId !== target.turnId;
  const context = allTurns.filter(turn => turn.index <= target.index).slice(-MAX_CONTEXT_TURNS);
  if (!context.some(turn => turn.turnId === target.turnId)) throw new Error('target turn absent from context');
  const refIds = context.map(turn => turn.turnId);
  const currentState = historical ? null : {
    terminal: state.terminalState?.blockedBy || null,
    owner: state.ownership?.owner || 'unknown',
    humanTakeover: state.ownership?.humanTakeover?.value === true,
    staffingAutomationHold: state.ownership?.staffingAutomationHold?.applies === true,
    qualification: {
      status: state.qualification?.status || 'unknown',
      slots: Object.fromEntries(SLOT_IDS.map(slot => [slot, {
        status: state.qualification?.slots?.[slot]?.status || 'unknown',
        values: Array.isArray(state.qualification?.slots?.[slot]?.value)
          ? state.qualification.slots[slot].value.slice(0, 3) : null,
      }])),
    },
    questions: (state.questions || []).filter(q => q.status === 'open').slice(-5)
      .map(q => ({ topic: q.topic, evidenceMessageId: q.evidenceMessageId })),
    objections: (state.objections || []).filter(o => o.status === 'open').slice(-5)
      .map(o => ({ type: o.type, evidenceMessageId: o.evidenceMessageId })),
    referral: state.referral?.status || 'none',
    booking: { linkStatus: state.booking?.linkSent?.status || 'unknown',
      meetingIntent: state.booking?.meetingIntent?.value === true,
      callStatus: state.booking?.call?.status || 'unknown',
      callLive: state.booking?.call?.live === true },
    response: { answered: state.responseState?.answered || 'unknown',
      waitingOn: state.responseState?.waitingOn || 'unknown' },
    productionDecision: {
      status: target.decision?.status || 'not_evaluated',
      classification: target.decision?.finalClassification || target.classification?.value || null,
      policyAction: target.decision?.policyAction || null,
      executionStatus: target.decision?.executionStatus || null,
    },
    evidenceWarnings: [...new Set((state.evidenceWarnings || []).map(w => w.code))].sort(),
    ambiguities: [...new Set((state.ambiguities || []).map(a => a.code))].sort(),
  };
  const input = {
    version: INPUT_VERSION, stateVersion: state.version, catalogVersion: CATALOG_VERSION,
    leadId, messageId: id, targetRef: target.turnId, historical,
    stateDigest: state.evidenceDigest, asOf: state.asOf,
    turns: context.map(compactTurn), currentState,
    riskFlags: historical ? [] : riskFlags(state, target),
    approvedFacts: OFFER_FACTS,
    allowedEvidenceRefs: refIds,
  };
  input.inputDigest = crypto.createHash('sha256').update(stableStringify(input)).digest('hex');
  return Object.freeze(input);
}

module.exports = { buildAgentV2Input, riskFlags, MAX_CONTEXT_TURNS, MAX_TURN_TEXT };
