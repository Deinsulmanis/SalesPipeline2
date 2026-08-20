'use strict';

function leadEligibility({ lead, suppressedEmails, providerMappings }) {
  if (!lead?.email || !String(lead.email).includes('@')) return { ok: false, reason: 'Lead with a valid email address is required' };
  const email = String(lead.email).trim().toLowerCase();
  if (suppressedEmails?.has(email) || /unsub|bounc/i.test(`${lead.emailStatus || ''} ${lead.notes || ''}`)) return { ok: false, reason: 'Lead is globally suppressed' };
  const conflict = (providerMappings || []).find(row => row.internalLeadId === lead.id && !/completed|unsubscribed|bounced|failed|skipped|test mode/i.test(row.normalizedStatus));
  if (conflict) return { ok: false, reason: 'Lead already has an active provider assignment' };
  return { ok: true };
}

function shouldApplyRemoteEvent(localTimestamp, remoteTimestamp) {
  if (!localTimestamp) return true;
  const local = new Date(localTimestamp).getTime();
  const remote = new Date(remoteTimestamp).getTime();
  if (!Number.isFinite(local) || !Number.isFinite(remote)) return false;
  return remote >= local;
}

function isDuplicateRequest(rows, requestId) {
  return Boolean(requestId) && (rows || []).some(row => row.requestId === requestId);
}

module.exports = { leadEligibility, shouldApplyRemoteEvent, isDuplicateRequest };
