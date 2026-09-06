'use strict';

function positiveLimit(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function createSendingWindowQuota({ senderIds = [], perSenderLimit, globalLimit } = {}) {
  const ids = [...new Set(senderIds.map(id => String(id || '').trim()).filter(Boolean))];
  return {
    senderIds: ids,
    perSenderLimit: positiveLimit(perSenderLimit, 'perSenderLimit'),
    globalLimit: positiveLimit(globalLimit, 'globalLimit'),
    globalSuccesses: 0,
    successesBySender: new Map(ids.map(id => [id, 0])),
  };
}

function sendingWindowVerdict(quota, senderId) {
  const id = String(senderId || '').trim();
  if (!quota || !quota.successesBySender || !quota.successesBySender.has(id)) {
    return { allowed: false, reason: `sender ${id || '(missing)'} has no scheduled-window bucket` };
  }
  if (quota.globalSuccesses >= quota.globalLimit) {
    return { allowed: false, reason: 'scheduled-window global limit reached' };
  }
  if ((quota.successesBySender.get(id) || 0) >= quota.perSenderLimit) {
    return { allowed: false, reason: 'sender scheduled-window limit reached' };
  }
  return { allowed: true, reason: '' };
}

function consumeSendingWindowSuccess(quota, senderId) {
  const verdict = sendingWindowVerdict(quota, senderId);
  if (!verdict.allowed) throw new Error(verdict.reason);
  const id = String(senderId).trim();
  quota.successesBySender.set(id, (quota.successesBySender.get(id) || 0) + 1);
  quota.globalSuccesses++;
  return sendingWindowSnapshot(quota);
}

function sendingWindowRemainingBySender(quota) {
  const globalRemaining = Math.max(0, quota.globalLimit - quota.globalSuccesses);
  return new Map(quota.senderIds.map(id => [id, Math.min(globalRemaining,
    Math.max(0, quota.perSenderLimit - (quota.successesBySender.get(id) || 0)))]));
}

function sendingWindowSnapshot(quota) {
  return {
    globalSuccesses: quota.globalSuccesses,
    globalRemaining: Math.max(0, quota.globalLimit - quota.globalSuccesses),
    successesBySender: new Map(quota.successesBySender),
    remainingBySender: sendingWindowRemainingBySender(quota),
  };
}

module.exports = {
  createSendingWindowQuota,
  sendingWindowVerdict,
  consumeSendingWindowSuccess,
  sendingWindowRemainingBySender,
  sendingWindowSnapshot,
};
