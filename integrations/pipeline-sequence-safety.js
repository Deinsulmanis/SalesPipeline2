'use strict';

/**
 * The last gate before a stage-sequence provider call. Fails CLOSED: it returns
 * allowed only for a combination it positively recognises as safe.
 *
 * THREADING
 * ---------
 * Every stage journey continues an existing conversation, so a proven,
 * mailbox-verified thread is mandatory for them and remains so. The generic
 * re-engagement journey's Step 1 is the one deliberate exception: it opens a NEW
 * conversation because the historical threads it would otherwise reuse are
 * ambiguous (see generic-reengagement.js). That exception is opt-in per call via
 * freshThreadAllowed, never inferred from a missing thread — so "no thread"
 * still blocks everything that did not explicitly ask for a fresh one.
 */
function stageSendGate(input = {}) {
  const {
    checkOnly = false, sendingEnabled = false, senderProof = null, sender = null,
    thread = null, threadVerified = false, observationOk = false,
    senderCount = 0, globalCount = 0, globalLimit = 80,
    freshThreadAllowed = false,
  } = input;
  if (checkOnly) return { allowed: false, code: 'check_only', reason: 'CHECK_ONLY cannot send stage sequences' };
  if (!sendingEnabled) return { allowed: false, code: 'sending_disabled', reason: 'sending is disabled' };
  if (!senderProof?.ok) return { allowed: false, code: 'sender_unproven', reason: senderProof?.reason || 'sender ownership is not proven' };
  if (!sender?.sendEligible) return { allowed: false, code: 'sender_ineligible', reason: 'owning sender is not delivery eligible' };
  if (!observationOk) return { allowed: false, code: 'observation_failed', reason: 'Gmail observation failed for the owning sender' };
  if (Number(senderCount) >= Number(sender.dailyLimit)) return { allowed: false, code: 'sender_quota', reason: 'owning sender daily quota reached' };
  if (Number(globalCount) >= Number(globalLimit)) return { allowed: false, code: 'global_quota', reason: 'global daily quota reached' };
  if (freshThreadAllowed) {
    // A fresh-thread send must carry NO thread at all. A caller that asks for a
    // fresh thread while also handing one over is confused about which
    // conversation it is in, and that ambiguity is exactly what this journey
    // exists to avoid.
    if (thread?.threadId) {
      return { allowed: false, code: 'fresh_thread_conflict', reason: 'a fresh-thread send may not also supply a thread' };
    }
    return { allowed: true, code: 'ready_fresh_thread', reason: 'ready — opening a new conversation' };
  }
  if (!thread?.threadId) return { allowed: false, code: 'thread_unproven', reason: 'sender-pinned thread is not proven' };
  if (!threadVerified) return { allowed: false, code: 'thread_mismatch', reason: 'thread is not verified in the owning mailbox' };
  return { allowed: true, code: 'ready', reason: 'ready' };
}

module.exports = { stageSendGate };
