'use strict';

/**
 * Agent v2 execution evidence for the ops endpoint, from the activity ledger.
 * Counts, codes and timestamps only — no prospect text. PURE.
 *
 * An Agent v2 attempt is a reply_decision_pending_execution record (written
 * before any attempt). Its outcome is the reply_decision_recorded for the same
 * inbound message; a send is the booking_link_sent whose event id is the
 * deterministic qualification responseActionId for that inbound.
 */

const { PENDING_EVENT, QUALIFY_ACTION } = require('./agent-v2-pending-decision');
const { responseActionId } = require('./prospect-reply-delivery');
const { CANARY, vancouverDay, canaryAttemptsToday } = require('./agent-v2-canary');

const meta = row => {
  if (row && typeof row.metadata === 'object' && row.metadata) return row.metadata;
  try { return JSON.parse(String((row && row.metadata) || '{}')) || {}; } catch (_) { return {}; }
};
const RECONCILIATION = /reconcil|provider_ambiguous|reservation_unresolved|checkpoint_failed/i;

function agentV2ExecutionEvidence(activities = [], { now = new Date(), recentDays = 7 } = {}) {
  const rows = (activities || []).filter(Boolean);
  const attempts = rows.filter(row => row.eventType === PENDING_EVENT);
  const byEventId = new Map(rows.map(row => [row.eventId, row]));
  const decisions = new Map(rows.filter(row => row.eventType === 'reply_decision_recorded')
    .map(row => [String(meta(row).inboundMessageId || meta(row).gmailMessageId || ''), meta(row)]));
  const since = new Date(now).getTime() - recentDays * 24 * 3600 * 1000;
  const sends = [];
  const outcomes = {};
  let reconciliationRequired = 0;
  let unresolved = 0;
  for (const attempt of attempts) {
    const data = meta(attempt);
    const leadId = String(data.leadId || attempt.sourceLeadId || '');
    const messageId = String(data.inboundMessageId || '');
    const sent = byEventId.get(responseActionId(leadId, messageId, QUALIFY_ACTION));
    if (sent && sent.eventType === 'booking_link_sent') sends.push(String(sent.occurredAt || ''));
    const decision = decisions.get(messageId);
    if (!decision) { unresolved += 1; continue; }
    const code = String(decision.executionCode || decision.executionStatus || 'unknown');
    if (RECONCILIATION.test(code)) reconciliationRequired += 1;
    if (Date.parse(attempt.occurredAt || '') >= since && !sent) outcomes[code] = (outcomes[code] || 0) + 1;
  }
  const today = vancouverDay(now);
  sends.sort();
  return {
    attemptsTotal: attempts.length,
    attemptsToday: canaryAttemptsToday(rows, { day: today }),
    sendsTotal: sends.length,
    sendsToday: sends.filter(at => at && vancouverDay(at) === today).length,
    lastSendAt: sends.at(-1) || null,
    lastAttemptAt: attempts.map(row => String(row.occurredAt || '')).sort().at(-1) || null,
    recentDenyOrHandoff: outcomes,
    unresolvedAttempts: unresolved,
    reconciliationRequired,
    dailyCap: CANARY.dailyCap,
    day: today,
  };
}

module.exports = { agentV2ExecutionEvidence };
