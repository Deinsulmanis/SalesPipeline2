'use strict';

const crypto = require('crypto');

function verifySignature(rawBody, signature, secret) {
  if (!Buffer.isBuffer(rawBody) || !signature || !secret) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const actualBuffer = Buffer.from(String(signature));
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function verifySharedSecret(provided, expected) {
  if (!provided || !expected) return false;
  const providedBuffer = Buffer.from(String(provided));
  const expectedBuffer = Buffer.from(String(expected));
  return providedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

function eventEmail(event) {
  return String(event.lead_email || event.to_email || event.lead?.email || '').trim().toLowerCase();
}

function normalizeCategory(value) {
  const category = String(value || '').toLowerCase();
  if (/meeting|booked/.test(category)) return 'Meeting requested';
  if (/interest|positive/.test(category) && !/not|un/.test(category)) return 'Interested';
  if (/not interested|negative/.test(category)) return 'Not interested';
  if (/question/.test(category)) return 'Question';
  if (/out.?of.?office|ooo/.test(category)) return 'Out of office';
  if (/unsubscribe/.test(category)) return 'Unsubscribed';
  return 'Replied';
}

function normalizeEvent(event) {
  const type = String(event.event_type || event.event || 'UNKNOWN').toUpperCase();
  const base = { type, email: eventEmail(event), campaignId: String(event.campaign_id || ''), leadId: String(event.lead_id || ''), occurredAt: event.time_sent || event.time_replied || event.time_bounced || event.timestamp || new Date().toISOString(), rawStatus: type };
  switch (type) {
    case 'EMAIL_SENT': case 'FIRST_EMAIL_SENT': return { ...base, status: 'Sent' };
    case 'EMAIL_REPLY': return { ...base, status: 'Replied', reply: event.preview_text || event.reply_body || '', subject: event.subject || '' };
    case 'EMAIL_BOUNCE': case 'EMAIL_BOUNCED': return { ...base, status: 'Bounced' };
    case 'LEAD_UNSUBSCRIBED': case 'EMAIL_UNSUBSCRIBED': return { ...base, status: 'Unsubscribed' };
    case 'LEAD_CATEGORY_UPDATED': return { ...base, status: normalizeCategory(event.category || event.lead_data?.category?.name), category: event.category || event.lead_data?.category?.name || '', history: event.history || [] };
    case 'CAMPAIGN_STATUS_CHANGED': return { ...base, status: String(event.status || event.campaign_status || 'Updated') };
    default: return { ...base, status: 'Ignored' };
  }
}

function sanitizePayload(value) {
  const clone = JSON.parse(JSON.stringify(value || {}));
  for (const field of ['custom_email_message', 'reply_body']) if (clone[field]) clone[field] = '[redacted; preview stored separately]';
  return clone;
}

module.exports = { verifySignature, verifySharedSecret, normalizeEvent, sanitizePayload, eventEmail };
