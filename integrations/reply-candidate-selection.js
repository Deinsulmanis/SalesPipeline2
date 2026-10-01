'use strict';

/**
 * Which inbound message the reply pass routes for a lead.
 *
 * The pass routes ONE inbound message per lead per pass: when a prospect sends
 * two messages between passes, the newer one is answered and the earlier one
 * stays recorded by the mailbox observer (it is evidence, not a second
 * trigger). A lead pinned to an inbox is only routed from that inbox; a reply
 * that arrives on another inbox is recorded by the observer for human review
 * and never handled by automation.
 *
 * Every inbox is observed in turn, so the choice must not depend on the order
 * inboxes are read in: a message the pass may not route must never displace
 * one it may route, and otherwise the newer message wins.
 */

function inboxMayRoute(lead, senderId, { terminalReplay = false } = {}) {
  return Boolean(terminalReplay) || !lead?.senderInboxId || lead.senderInboxId === senderId;
}

function internalDate(message) {
  const value = Number(message?.internalDate);
  return Number.isFinite(value) ? value : 0;
}

/** true when `next` should replace `current` as the lead's message this pass. */
function preferNextReply(current, next, lead) {
  if (!current) return true;
  if (!next) return false;
  const currentRoutable = inboxMayRoute(lead, current.observedSenderId, current);
  const nextRoutable = inboxMayRoute(lead, next.observedSenderId, next);
  if (currentRoutable !== nextRoutable) return nextRoutable;
  return internalDate(next) >= internalDate(current);
}

module.exports = { inboxMayRoute, preferNextReply };
