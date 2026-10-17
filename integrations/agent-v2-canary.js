'use strict';

/**
 * Agent v2 controlled canary — the ONLY scope in which Agent v2 may execute.
 *
 *   campaign   Industrial Staffing Agency (STAFFING_CAMPAIGN)
 *   client     ScaleLab, explicit client_id, active
 *   inbox      primary only (lead pinned to primary, reply observed on primary)
 *   message    the prospect's FIRST genuine-human message, still fresh, with
 *              no human outbound and no automated warm reply in the conversation
 *   policy     the deterministic policy chose AUTO_STAFFING_QUALIFY_QUESTION
 *   action     Agent v2 SUGGEST_QUALIFICATION, 1–2 employer-acquisition slots,
 *              confidence >= 0.90, no risk flag, no objection, referral or
 *              meeting intent
 *   cap        3 Agent v2 send attempts per Vancouver day, counted durably from
 *              the activity ledger (attempts, not only successes)
 *
 * Every other message stays on the legacy deterministic path exactly as when
 * execution is disabled. All functions here are pure.
 */

const { STAFFING_CAMPAIGN, isStaffingCampaign } = require('./staffing-campaign');
const { DEFAULT_CLIENT_ID } = require('./clients/registry');
const { tenantOf } = require('./clients/email-scope');
const { PENDING_EVENT, QUALIFY_ACTION } = require('./agent-v2-pending-decision');
const { clientScopeBlock } = require('./agent-v2-input');

const CANARY = Object.freeze({
  version: 'agent_v2_canary_v1',
  campaignId: STAFFING_CAMPAIGN.id,
  campaignName: STAFFING_CAMPAIGN.name,
  clientId: DEFAULT_CLIENT_ID,
  senderInboxId: 'primary',
  policyAction: QUALIFY_ACTION,
  agentAction: 'SUGGEST_QUALIFICATION',
  confidenceFloor: 0.9,
  maxSlots: 2,
  dailyCap: 3,
  maxInboundAgeMs: 90 * 60 * 1000,
  observationDays: 14,
  timeZone: 'America/Vancouver',
});

const QUALIFICATION_CLASSES = new Set(['INTERESTED', 'STAFFING_QUALIFICATION']);
const PROSPECT_EVENT = /reply|meeting_requested/;
const NOT_PROSPECT_EVENTS = new Set(['reply_decision_recorded', 'gmail_reply_evaluated',
  'reply_classification_override', 'reply_decision_pending_execution']);
const WARM_OR_HUMAN_OUTBOUND = new Set(['human_response_sent', 'booking_link_sent', 'prospect_reply_reserved']);

const meta = row => {
  if (row && typeof row.metadata === 'object' && row.metadata) return row.metadata;
  try { return JSON.parse(String((row && row.metadata) || '{}')) || {}; } catch (_) { return {}; }
};
const mine = (activities, leadId) => (activities || []).filter(row => row
  && (String(row.sourceLeadId || '') === String(leadId) || String(row.leadId || '') === `CE-${leadId}`));

function vancouverDay(at = new Date()) {
  return new Date(at).toLocaleDateString('en-CA', { timeZone: CANARY.timeZone });
}

/**
 * Deterministic scope check made BEFORE Agent v2 runs, on what the reply pass
 * holds. { inScope, code }.
 */
function canaryPreScope({ lead, message = {}, policy = {}, activities = [], now = new Date() } = {}) {
  const out = code => Object.freeze({ inScope: false, code });
  if (!lead || !lead.id || !message.messageId) return out('identity_missing');
  if (!isStaffingCampaign(lead)) return out('not_staffing_campaign');
  if (String(lead.clientId || '').trim() !== CANARY.clientId || tenantOf(lead) !== CANARY.clientId)
    return out('not_explicit_scalelab_client');
  if (lead.senderInboxId !== CANARY.senderInboxId || message.senderInboxId !== CANARY.senderInboxId)
    return out('not_primary_inbox');
  if (policy.action !== CANARY.policyAction || policy.send !== true) return out('policy_not_qualification');
  const at = Date.parse(message.occurredAt || '');
  if (!Number.isFinite(at) || new Date(now).getTime() - at > CANARY.maxInboundAgeMs) return out('inbound_not_fresh');
  const rows = mine(activities, lead.id);
  const prospect = rows.filter(row => PROSPECT_EVENT.test(String(row.eventType || ''))
    && !NOT_PROSPECT_EVENTS.has(row.eventType));
  const others = prospect.filter(row => String(meta(row).gmailMessageId || '') !== String(message.messageId));
  if (others.length) return out('not_first_prospect_message');
  if (rows.some(row => WARM_OR_HUMAN_OUTBOUND.has(row.eventType))) return out('prior_human_or_warm_outbound');
  return Object.freeze({ inScope: true, code: null });
}

/**
 * Agent v2 send attempts counted against today's cap: every pending-execution
 * record written today (written before any attempt), so a crashed or
 * unresolved attempt still consumes capacity.
 */
function canaryAttemptsToday(activities = [], { day = vancouverDay(), excludeMessageId = '' } = {}) {
  return (activities || []).filter(row => row && row.eventType === PENDING_EVENT
    && vancouverDay(row.occurredAt || 0) === day
    && String(meta(row).inboundMessageId || '') !== String(excludeMessageId || '')).length;
}

function canaryCapVerdict(activities = [], { day = vancouverDay(), messageId = '' } = {}) {
  const used = canaryAttemptsToday(activities, { day, excludeMessageId: messageId });
  return Object.freeze({ allowed: used < CANARY.dailyCap, used, cap: CANARY.dailyCap, day });
}

/**
 * The completed Agent v2 decision and fresh Phase 1 state must be inside the
 * canary. { allowed, code }.
 */
function canaryDecisionGate({ record, state, input } = {}) {
  const out = code => Object.freeze({ allowed: false, code });
  const decision = record?.decision;
  if (!record || record.modelStatus !== 'ok' || decision?.status !== 'valid') return out('decision_not_valid');
  if (decision.actionId !== CANARY.agentAction) return out('action_not_in_canary');
  if (!(typeof decision.confidence === 'number' && decision.confidence >= CANARY.confidenceFloor))
    return out('confidence_below_floor');
  if (!Array.isArray(decision.slotIds) || !decision.slotIds.length || decision.slotIds.length > CANARY.maxSlots)
    return out('slot_count_out_of_range');
  if (!input || !state) return out('state_unavailable');
  if (clientScopeBlock(input.client) || input.client.clientSource !== 'explicit') return out('client_not_in_canary');
  if (input.historical) return out('stale_inbound');
  if ((input.riskFlags || []).length) return out(`risk_${input.riskFlags[0]}`);
  const current = input.currentState || {};
  if ((current.objections || []).length) return out('objection_open');
  if (current.referral && current.referral !== 'none') return out('referral_present');
  if (current.booking?.meetingIntent || current.booking?.callLive) return out('booking_state');
  const target = (state.turns || []).find(turn => turn.direction === 'inbound' && turn.messageId === record.messageId);
  if (!target || target.genuineHuman !== true || target.automatedReply) return out('not_genuine_human');
  if (target.senderInboxId !== CANARY.senderInboxId) return out('not_primary_inbox');
  const prospect = (state.turns || []).filter(turn => turn.direction === 'inbound' && !turn.automatedReply);
  if (prospect.length !== 1) return out('not_first_prospect_message');
  if ((state.turns || []).some(turn => turn.direction === 'outbound' && turn.actor === 'human'))
    return out('prior_human_outbound');
  if (!QUALIFICATION_CLASSES.has(target.decision?.finalClassification)) return out('classification_not_positive');
  return Object.freeze({ allowed: true, code: null });
}

module.exports = { CANARY, vancouverDay, canaryPreScope, canaryAttemptsToday, canaryCapVerdict, canaryDecisionGate };
