'use strict';

const crypto = require('crypto');

const ACTIVE_STATUSES = new Set(['queued','scheduled','started','in progress','inprogress','sent','emailed','replied','interested','meeting requested','question','out of office','paused','processing']);
const TERMINAL_STATUSES = new Set(['completed','not interested','unsubscribed','bounced','blocked','failed','stopped']);
const REPLY_STATUSES = new Set(['replied','interested','meeting requested','not interested','question','out of office','unsubscribed']);

function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }
function normalizeStatus(value) { return String(value || '').trim().toLowerCase().replace(/_/g, ' '); }
function csvSet(value, normalizer = v => String(v).trim()) { return new Set(String(value || '').split(',').map(normalizer).filter(Boolean)); }

function buildEventKey(rawBody, requestId) {
  if (!Buffer.isBuffer(rawBody)) throw new TypeError('rawBody must be a Buffer');
  const id = String(requestId || '').trim();
  return id ? `smartlead:request:${id}` : `smartlead:payload:${crypto.createHash('sha256').update(rawBody).digest('hex')}`;
}

function buildMappingKey({ provider = 'smartlead', externalCampaignId, externalLeadId, email }) {
  const identity = String(externalLeadId || '').trim() || normalizeEmail(email);
  if (!externalCampaignId || !identity) return '';
  return `${provider}:${String(externalCampaignId).trim()}:${identity}`;
}

function mappingMatchesEvent(row, event) {
  if (row.provider !== 'smartlead' || String(row.externalCampaignId) !== String(event.campaignId)) return false;
  if (event.mappingId && row.mappingId && String(row.mappingId) === String(event.mappingId)) return true;
  if (event.leadId && row.externalLeadId && String(row.externalLeadId) === String(event.leadId)) return true;
  return Boolean(event.email && row.normalizedEmail && normalizeEmail(row.normalizedEmail) === normalizeEmail(event.email));
}

function leadEligibility({ lead, suppressedEmails = new Set(), providerMappings = [], externalCampaignId }) {
  const email = normalizeEmail(lead?.email);
  if (!email || !email.includes('@')) return { ok: false, reason: 'Lead with a valid email address is required' };
  if (suppressedEmails.has(email) || /unsub|bounc|block/i.test(`${lead.emailStatus || ''} ${lead.notes || ''}`)) return { ok: false, reason: 'Lead is globally suppressed' };
  const active = providerMappings.filter(row => ACTIVE_STATUSES.has(normalizeStatus(row.normalizedStatus)));
  if (active.some(row => row.internalLeadId === lead.id || normalizeEmail(row.normalizedEmail) === email)) return { ok: false, reason: 'Lead email already has an active provider assignment' };
  const sameCampaign = externalCampaignId && providerMappings.find(row => String(row.externalCampaignId) === String(externalCampaignId) && normalizeEmail(row.normalizedEmail) === email);
  if (sameCampaign) return { ok: false, reason: 'Lead already has a mapping in this campaign' };
  return { ok: true, email };
}

function mutationDecision({ integrationEnabled, liveMutationsEnabled, pilotMode, approvedCampaignIds, recipientAllowlist, campaignId, recipients }) {
  if (!integrationEnabled) return { ok: false, reason: 'Smartlead integration is disabled' };
  if (!liveMutationsEnabled) return { ok: false, reason: 'Smartlead live mutations are disabled' };
  const campaigns = approvedCampaignIds instanceof Set ? approvedCampaignIds : csvSet(approvedCampaignIds);
  const emails = recipientAllowlist instanceof Set ? recipientAllowlist : csvSet(recipientAllowlist, normalizeEmail);
  if (!campaigns.size) return { ok: false, reason: 'No approved Smartlead campaign IDs are configured' };
  if (!campaigns.has(String(campaignId))) return { ok: false, reason: 'Smartlead campaign is not approved for mutations' };
  if (pilotMode && !emails.size) return { ok: false, reason: 'Pilot recipient allowlist is empty' };
  if (pilotMode) {
    const denied = (recipients || []).map(normalizeEmail).find(email => !emails.has(email));
    if (denied) return { ok: false, reason: 'Recipient is not approved for the Smartlead pilot' };
  }
  return { ok: true };
}

function canApplyProviderTransition({ currentStatus, currentEventAt, incomingStatus, incomingEventAt }) {
  const current = normalizeStatus(currentStatus);
  const incoming = normalizeStatus(incomingStatus);
  const currentMs = Date.parse(currentEventAt || '');
  const incomingMs = Date.parse(incomingEventAt || '');
  if (Number.isFinite(currentMs) && Number.isFinite(incomingMs) && incomingMs < currentMs) return false;
  if (!current) return true;
  if (incoming === 'sent' && (REPLY_STATUSES.has(current) || TERMINAL_STATUSES.has(current))) return false;
  if (TERMINAL_STATUSES.has(current) && incoming !== current) return false;
  if (current === 'interested' && incoming === 'replied') return false;
  if (current === 'meeting requested' && ['replied','interested'].includes(incoming)) return false;
  if (current === 'replied' && ['interested','meeting requested','not interested','question','out of office','unsubscribed'].includes(incoming)) return true;
  return true;
}

function stripText(value, max = 500) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeAuditPayload(event, normalized) {
  return {
    eventType: normalized.type,
    campaignId: normalized.campaignId,
    leadId: normalized.leadId || '',
    mappingId: normalized.mappingId || '',
    email: normalizeEmail(normalized.email),
    timestamp: normalized.occurredAt || '',
    category: stripText(normalized.category, 100),
    providerStatus: stripText(normalized.rawStatus, 100),
    subject: stripText(normalized.subject, 200),
    replyPreview: stripText(normalized.reply, 500),
    deliveryCode: stripText(event?.bounce_code || event?.error_code || event?.status_code, 100),
    omitted: { history: Array.isArray(event?.history), leadData: Boolean(event?.lead_data), replyBody: Boolean(event?.reply_body || event?.lastReply?.email_body), html: /<[^>]+>/.test(String(event?.reply_body || '')) },
  };
}

function eventStateTransition(current, action) {
  const state = String(current || 'received');
  if (action === 'start' && ['received','processing','failed'].includes(state)) return 'processing';
  if (action === 'succeed' && state === 'processing') return 'processed';
  if (action === 'ignore' && ['received','processing'].includes(state)) return 'ignored';
  if (action === 'fail' && ['received','processing'].includes(state)) return 'failed';
  if (['processed','ignored'].includes(state)) return state;
  throw new Error(`Invalid provider event transition: ${state} -> ${action}`);
}

async function executeEventAttempt(record, downstream, { onState = async () => {}, now = () => new Date().toISOString() } = {}) {
  const attempt = Number(record.attemptCount || 0) + 1;
  const processing = { ...record, processingStatus: eventStateTransition(record.processingStatus || 'received', 'start'), attemptCount: attempt, lastAttemptAt: now(), processedAt: '', error: '' };
  await onState(processing);
  try {
    const outcome = await downstream(processing);
    const completed = { ...processing, processingStatus: eventStateTransition('processing', outcome === 'ignored' ? 'ignore' : 'succeed'), processedAt: now(), error: '' };
    await onState(completed); return completed;
  } catch (error) {
    const failed = { ...processing, processingStatus: eventStateTransition('processing', 'fail'), processedAt: '', error: String(error.code || error.message || 'processing failed').replace(/[\r\n\x00-\x1F]/g, ' ').slice(0, 300) };
    await onState(failed); error.eventRecord = failed; throw error;
  }
}

class KeyedLock {
  constructor() { this.pending = new Map(); }
  async run(key, fn) {
    const previous = this.pending.get(key) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    this.pending.set(key, current);
    await previous;
    try { return await fn(); } finally { release(); if (this.pending.get(key) === current) this.pending.delete(key); }
  }
}

async function fetchAllCampaignLeads(fetchPage, { limit = 100, maxPages = 1000 } = {}) {
  const all = []; let offset = 0; let pages = 0; const fingerprints = new Set();
  while (pages < maxPages) {
    const page = await fetchPage({ offset, limit }); pages++;
    const items = page.leads || page.data || [];
    const total = Number(page.total ?? page.total_leads ?? items.length);
    const fingerprint = items.map(item => item.id || item.lead?.id || item.campaign_lead_map_id || '').join('|');
    if (items.length && fingerprints.has(fingerprint)) throw new Error('Smartlead pagination returned a repeated page');
    if (items.length) fingerprints.add(fingerprint);
    all.push(...items);
    if (!items.length || items.length < limit || all.length >= total) return { leads: all, pages, total };
    const next = offset + items.length;
    if (next <= offset) throw new Error('Smartlead pagination offset did not advance');
    offset = next;
  }
  throw new Error('Smartlead pagination exceeded safety limit');
}

function aggregateProviderStats(mappings) {
  const unique = new Map();
  for (const row of mappings || []) if (row.mappingKey) unique.set(row.mappingKey, row);
  const rows = [...unique.values()];
  const count = status => rows.filter(row => normalizeStatus(row.normalizedStatus) === status).length;
  const replied = rows.filter(row => REPLY_STATUSES.has(normalizeStatus(row.normalizedStatus))).length;
  const interested = count('interested'); const meetings = count('meeting requested');
  const sent = rows.filter(row => !['queued','scheduled','blocked','failed'].includes(normalizeStatus(row.normalizedStatus))).length;
  return { totalLeads: rows.length, scheduled: count('scheduled') + count('queued'), sent, replied, replyRate: sent ? replied / sent * 100 : 0, interested, interestedRate: replied ? interested / replied * 100 : 0, meetings, unsubscribed: count('unsubscribed'), bounced: count('bounced'), problems: count('blocked') + count('failed') };
}

function reconciliationHealth(result, at) {
  const patch = { lastReconciliationAttempt: at, campaignsAttempted: result.attempted, campaignsSuccessful: result.successful, campaignsFailed: result.failed, campaignErrorSummary: JSON.stringify(result.errors || []), lastError: result.failed ? `${result.failed} campaign reconciliation failure(s)` : '' };
  if (result.failed === 0) patch.lastSuccessfulReconciliation = at;
  else if (result.successful > 0) patch.lastPartialReconciliation = at;
  return patch;
}

module.exports = { ACTIVE_STATUSES, TERMINAL_STATUSES, normalizeEmail, csvSet, buildEventKey, buildMappingKey, mappingMatchesEvent, leadEligibility, mutationDecision, canApplyProviderTransition, stripText, safeAuditPayload, eventStateTransition, executeEventAttempt, KeyedLock, fetchAllCampaignLeads, aggregateProviderStats, reconciliationHealth };
