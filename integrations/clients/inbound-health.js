'use strict';

/**
 * Operator answer: are this client's inboxes receiving and processing replies?
 *
 * Built from durable observer checkpoints and activity rows — no Gmail calls,
 * no sends. A missing credential or stale cursor is a health failure, not a
 * silent "looks fine".
 */

const { observerHealth } = require('../gmail-observer-health');
const { getClient } = require('./registry');
const { REPLY_EVENT_TYPE, replyEventId } = require('./reply-pipeline');

function parseMeta(row = {}) {
  try {
    return typeof row.metadata === 'object' && row.metadata
      ? row.metadata
      : JSON.parse(row.metadata || '{}');
  } catch (_) {
    return {};
  }
}

function inboundMessageId(row = {}) {
  const meta = parseMeta(row);
  return String(meta.gmailMessageId || '').trim()
    || String(row.eventId || '').replace(/^gmail-reply:/, '').trim();
}

function clientInboundHealth({
  clientId, senders = [], observerRows = [], activities = [], now = new Date(),
} = {}) {
  const client = getClient(clientId);
  const mine = (senders || []).filter(sender => String(sender.clientId || '') === client.id);
  const observers = observerHealth(observerRows, {
    senderIds: mine.map(sender => sender.id), now,
  });
  const inboxes = observers.map((observer) => {
    const sender = mine.find(item => item.id === observer.senderInboxId) || {};
    const inbound = (activities || []).filter((row) => {
      const meta = parseMeta(row);
      if (String(meta.senderInboxId || '') !== observer.senderInboxId) return false;
      return String(row.eventId || '').startsWith('gmail-reply:')
        || String(row.eventType || '') === REPLY_EVENT_TYPE
        || /reply|meeting_requested/.test(String(row.eventType || ''));
    });
    const pending = inbound.filter((row) => {
      if (String(row.eventType || '') === REPLY_EVENT_TYPE) return false;
      const id = inboundMessageId(row);
      if (!id) return false;
      return !activities.some(item => String(item.eventId || '') === replyEventId(client.id, id)
        || (String(item.eventType || '') === REPLY_EVENT_TYPE
          && parseMeta(item).gmailMessageId === id
          && (!parseMeta(item).clientId || parseMeta(item).clientId === client.id)));
    });
    const lastInboundAt = inbound.map(row => row.occurredAt).filter(Boolean).sort().at(-1) || '';
    const credentialConfigured = Boolean(sender.credentialConfigured);
    const observerEnabled = sender.observerEnabled !== false;
    let status = 'critical';
    if (!credentialConfigured) status = 'offline';
    else if (!observerEnabled) status = 'disabled';
    else if (observer.health === 'healthy' && pending.length === 0) status = 'healthy';
    else if (observer.health === 'recovering' || observer.health === 'backoff' || pending.length) status = 'warning';
    else status = 'critical';
    return {
      senderInboxId: observer.senderInboxId,
      email: sender.email || '',
      provider: sender.provider || 'gmail',
      status: sender.status || '',
      credentialConfigured,
      observerEnabled,
      observerHealth: observer.health,
      observerSeverity: observer.severity,
      historyId: observer.historyId || '',
      lastSuccessfulAt: observer.lastSuccessfulAt || '',
      lastError: observer.lastError || '',
      lastInboundAt,
      inboundEvents: inbound.length,
      pendingManagedHandler: pending.length,
      inboxStatus: status,
    };
  });
  const credentialed = inboxes.filter(item => item.credentialConfigured);
  const healthy = inboxes.filter(item => item.inboxStatus === 'healthy');
  const pendingManagedHandler = inboxes.reduce((sum, item) => sum + item.pendingManagedHandler, 0);
  let verdict = 'no_inboxes';
  if (!mine.length) verdict = 'no_inboxes';
  else if (!credentialed.length) verdict = 'no_credentials';
  else if (inboxes.some(item => item.inboxStatus === 'critical')) verdict = 'critical';
  else if (healthy.length !== credentialed.length || pendingManagedHandler) verdict = 'warning';
  else verdict = 'healthy';
  return {
    clientId: client.id,
    displayName: client.displayName,
    campaignIds: [...(client.senderPolicy?.allowedCampaignIds || [])],
    verdict,
    receivingNormally: verdict === 'healthy',
    inboxCount: mine.length,
    credentialedCount: credentialed.length,
    healthyCount: healthy.length,
    pendingManagedHandler,
    inboxes,
    question: `Are all ${client.displayName} inboxes currently receiving and processing replies normally?`,
    answer: verdict === 'healthy'
      ? 'yes'
      : verdict === 'no_inboxes' ? 'no — client has no registered inboxes'
        : verdict === 'no_credentials' ? 'no — no connected observer credentials'
          : `no — ${verdict}`,
  };
}

module.exports = { clientInboundHealth };
