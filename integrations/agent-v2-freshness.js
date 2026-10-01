'use strict';

/**
 * Agent v2 final freshness gate.
 *
 * Runs inside the hardened warm-reply final revalidation, on a Phase 1 state
 * rebuilt from a snapshot read at that moment, immediately before the provider
 * thread check and the durable reservation. Any change since the shadow
 * decision refuses the send; nothing here can authorize one on its own.
 *
 * Order of the last steps for an Agent v2 delivery (prospect-reply-delivery.js):
 *   finalRevalidate (… → this gate) → verifyThread (Gmail: the thread's newest
 *   message is still this inbound) → persistReservation → sendProvider.
 * The Gmail check therefore sees a manual reply that the ledger has not
 * observed yet; this gate sees everything the ledger has.
 */

const { clientScope, clientScopeBlock } = require('./agent-v2-input');

const norm = value => String(value || '').trim().toLowerCase();

function refuse(code) { return Object.freeze({ allowed: false, code }); }

function agentV2FinalFreshness({ leadId, messageId, senderInboxId, threadId, stateDigest,
  original, current, state, guards = {} } = {}) {
  if (!leadId || !messageId || !state || !current || !original) return refuse('freshness_input_unavailable');
  if (String(current.id) !== String(leadId) || norm(current.email) !== norm(original.email)
    || String(state.identity?.leadId || '') !== String(leadId)) return refuse('lead_changed');
  if (state.identity?.clientSource !== 'explicit') return refuse('client_id_missing');
  const clientBlock = clientScopeBlock(clientScope(state));
  if (clientBlock) return refuse(clientBlock.toLowerCase());
  if (state.evidenceDigest !== stateDigest) return refuse('state_changed');
  if (state.latest?.inbound?.messageId !== messageId) return refuse('newer_inbound');
  const target = (state.turns || []).find(turn => turn.direction === 'inbound' && turn.messageId === messageId);
  if (!target) return refuse('inbound_missing');
  if ((threadId && target.threadId !== threadId) || (senderInboxId && target.senderInboxId !== senderInboxId))
    return refuse('thread_or_sender_changed');
  if ((state.thread?.threadIds || []).length !== 1) return refuse('thread_or_sender_changed');
  const outbound = (state.turns || []).filter(turn => turn.direction === 'outbound');
  if (outbound.some(turn => turn.actor === 'human' && Number(turn.index) > Number(target.index)))
    return refuse('human_response_after_inbound');
  if (outbound.some(turn => turn.inReplyToMessageId === messageId) || state.responseState?.answered !== 'no')
    return refuse('already_answered');
  if (state.ownership?.humanTakeover?.value !== false || state.ownership?.staffingAutomationHold?.applies !== false)
    return refuse('human_takeover');
  if (state.terminalState?.isTerminal || state.terminalState?.blockedBy) return refuse('terminal_state');
  const call = state.booking?.call || {};
  if (call.live === true || ['scheduled', 'rescheduled'].includes(call.status)
    || state.booking?.meetingIntent?.value === true) return refuse('booking_supersedes');
  if ((state.evidenceWarnings || []).length || (state.ambiguities || []).length) return refuse('evidence_conflict');
  if (guards.suppressed) return refuse('suppressed');
  if (guards.alreadySent) return refuse('already_answered');
  if (guards.humanTouch) return refuse('human_takeover');
  if (guards.repeat) return refuse('repeat_response');
  return Object.freeze({ allowed: true, code: null });
}

module.exports = { agentV2FinalFreshness };
