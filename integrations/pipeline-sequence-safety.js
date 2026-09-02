'use strict';

function stageSendGate(input = {}) {
  const {
    checkOnly = false, sendingEnabled = false, senderProof = null, sender = null,
    thread = null, threadVerified = false, observationOk = false,
    senderCount = 0, globalCount = 0, globalLimit = 80,
  } = input;
  if (checkOnly) return { allowed: false, code: 'check_only', reason: 'CHECK_ONLY cannot send stage sequences' };
  if (!sendingEnabled) return { allowed: false, code: 'sending_disabled', reason: 'sending is disabled' };
  if (!senderProof?.ok) return { allowed: false, code: 'sender_unproven', reason: senderProof?.reason || 'sender ownership is not proven' };
  if (!sender?.sendEligible) return { allowed: false, code: 'sender_ineligible', reason: 'owning sender is not delivery eligible' };
  if (!observationOk) return { allowed: false, code: 'observation_failed', reason: 'Gmail observation failed for the owning sender' };
  if (Number(senderCount) >= Number(sender.dailyLimit)) return { allowed: false, code: 'sender_quota', reason: 'owning sender daily quota reached' };
  if (Number(globalCount) >= Number(globalLimit)) return { allowed: false, code: 'global_quota', reason: 'global daily quota reached' };
  if (!thread?.threadId) return { allowed: false, code: 'thread_unproven', reason: 'sender-pinned thread is not proven' };
  if (!threadVerified) return { allowed: false, code: 'thread_mismatch', reason: 'thread is not verified in the owning mailbox' };
  return { allowed: true, code: 'ready', reason: 'ready' };
}

module.exports = { stageSendGate };
