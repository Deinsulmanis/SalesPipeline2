'use strict';

const { DEFAULT_INBOX_DAILY_LIMIT, DEFAULT_INBOX_PER_RUN_LIMIT } = require('./gmail-sender-capacity');

const WARMUP_STATUS = Object.freeze({
  WARMING: 'warming',
  READY: 'ready',
  ACTIVE: 'active',
  PAUSED: 'paused',
  ERROR: 'error',
});

function sendingActive(sender = {}) {
  return sender.status === WARMUP_STATUS.ACTIVE && Number(sender.dailyLimit) > 0 && Boolean(sender.sendEligible);
}

function markWarmupReady(sender = {}) {
  if (String(sender.status || '') !== WARMUP_STATUS.WARMING) {
    throw new Error(`${sender.email || sender.id || 'sender'} is not warming`);
  }
  return { ...sender, status: WARMUP_STATUS.READY, sendEligible: false };
}

function activationBlockers(sender = {}, {
  auth = null, observer = null, senders = [],
} = {}) {
  const blockers = [];
  const status = String(sender.status || '');
  if (status !== WARMUP_STATUS.READY) blockers.push('warmup is not ready');
  if (String(sender.provider || 'gmail') !== 'gmail') blockers.push('provider must be gmail');
  if (Number(sender.dailyLimit) !== DEFAULT_INBOX_DAILY_LIMIT) {
    blockers.push(`dailyLimit must be ${DEFAULT_INBOX_DAILY_LIMIT}`);
  }
  if (Number(sender.perRunLimit || DEFAULT_INBOX_PER_RUN_LIMIT) !== DEFAULT_INBOX_PER_RUN_LIMIT) {
    blockers.push(`perRunLimit must be ${DEFAULT_INBOX_PER_RUN_LIMIT}`);
  }
  if (!sender.credentialConfigured) blockers.push('gmail auth is not configured');
  if (auth) {
    if (auth.authenticated === false || auth.identityVerified === false) blockers.push('gmail auth unhealthy');
  } else if (!sender.credentialConfigured) {
    blockers.push('gmail auth unhealthy');
  }
  if (!observer || observer.health !== 'healthy') blockers.push('gmail observer unhealthy');
  if (observer && observer.cursorState !== 'present') blockers.push('history cursor missing');
  if (observer && (observer.quotaBackoff || observer.health === 'backoff')) blockers.push('gmail backoff');
  const email = String(sender.email || '').trim().toLowerCase();
  const id = String(sender.id || '').trim();
  const conflict = (senders || []).some(item => item && item !== sender
    && (String(item.id || '') === id || String(item.email || '').trim().toLowerCase() === email)
    && String(item.tokenEnv || '') !== String(sender.tokenEnv || ''));
  if (conflict) blockers.push('sender ownership/config conflict');
  return blockers;
}

function activateSender(sender = {}, context = {}) {
  const blockers = activationBlockers(sender, context);
  if (blockers.length) {
    const error = new Error(`Activate Sender refused: ${blockers.join('; ')}`);
    error.blockers = blockers;
    throw error;
  }
  return {
    ...sender,
    status: WARMUP_STATUS.ACTIVE,
    sendEligible: sender.credentialConfigured && Number(sender.dailyLimit) > 0,
  };
}

function pauseSender(sender = {}) {
  return {
    ...sender,
    status: WARMUP_STATUS.PAUSED,
    sendEligible: false,
    observerEnabled: sender.observerEnabled !== false,
  };
}

function overlayDoesNotTouchObserverState(before = {}, after = {}) {
  return String(before.historyId || '') === String(after.historyId || '')
    && String(before.lastSuccessfulAt || '') === String(after.lastSuccessfulAt || '');
}

module.exports = {
  WARMUP_STATUS, sendingActive, markWarmupReady, activationBlockers,
  activateSender, pauseSender, overlayDoesNotTouchObserverState,
};
