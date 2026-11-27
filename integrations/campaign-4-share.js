'use strict';

/**
 * Campaign 4 "HOLD Company Test" daily share (owner brief 2026-11-27).
 *
 * Campaign 3 and Campaign 4 share the same inboxes and the same global daily
 * cap (DAILY_SEND_LIMIT, 170 today). This module never changes that cap or
 * any sender, window or per-run limit. It only splits it:
 *
 *   - Campaign 4 may take at most floor(globalDailyLimit x share) successful
 *     sends per Vancouver day, every step counted (Email 1 and follow-ups);
 *   - Campaign 3 and everything else take the rest of the same cap, including
 *     any part of Campaign 4's share it does not use;
 *   - so Campaign 4 is not starved by Campaign 3's larger queue, new Email 1
 *     candidates are interleaved at the share ratio (ordering only).
 *
 * The share comes from CAMPAIGN_4_DAILY_SHARE (a fraction, 0 to 0.5). Absent:
 * DEFAULT_SHARE. Present but invalid: 0, so Campaign 4 sends nothing
 * (fail closed). The throttle is seeded from today's ledger and reserves
 * synchronously, so parallel sender lanes cannot overshoot. An attempt that
 * ends without delivery keeps its slot for the rest of the run (conservative;
 * the next run re-counts from the ledger). With no throttle initialised a
 * Campaign 4 lead is refused (fail closed); every other lead is unaffected.
 */

const { SUCCESSFUL_SEND_EVENTS } = require('./gmail-sender-routing');

const DEFAULT_SHARE = 0.35;
const MAX_SHARE = 0.5;
const C4_CAMPAIGN_ID = 'hold_company_test_campaign_4';
const C4_CAMPAIGN_NAME = 'HOLD Company Test';
const parseMetadata = value => { try { return typeof value === 'string' ? JSON.parse(value || '{}') : (value || {}); } catch (_) { return {}; } };
const bareLeadId = value => String(value || '').trim().replace(/^CE-/, '');

function campaign4ShareFromEnv(env = process.env) {
  const raw = env.CAMPAIGN_4_DAILY_SHARE;
  if (raw === undefined || String(raw).trim() === '') return { share: DEFAULT_SHARE, source: 'default' };
  const text = String(raw).trim();
  const value = /^(?:0(?:\.\d+)?|\.\d+|1(?:\.0+)?)$/.test(text) ? Number(text) : NaN;
  if (!Number.isFinite(value) || value < 0 || value > MAX_SHARE) {
    return { share: 0, source: 'invalid', reason: `CAMPAIGN_4_DAILY_SHARE must be a fraction from 0 to ${MAX_SHARE}; Campaign 4 is paused` };
  }
  return { share: value, source: 'env' };
}

function campaign4DailyBudget(globalDailyLimit, share) {
  const limit = Number(globalDailyLimit);
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(share) || share <= 0) return 0;
  return Math.floor(limit * Math.min(share, MAX_SHARE));
}

/**
 * Successful Campaign 4 sends today (Vancouver day), every step. A ledger row
 * counts when its recorded attribution names Campaign 4, or its lead (by
 * `isCampaign4LeadId(bareLeadId)`) is a Campaign 4 lead.
 */
function campaign4SendsToday(activities = [], dayKey, isCampaign4LeadId = () => false) {
  let count = 0;
  const seen = new Set();
  for (const row of activities) {
    if (!SUCCESSFUL_SEND_EVENTS.includes(String(row.eventType || ''))) continue;
    const day = row.occurredAt ? new Date(row.occurredAt).toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' }) : '';
    if (dayKey && day !== dayKey) continue;
    const eventKey = String(row.eventId || `${row.leadId}:${row.eventType}:${row.occurredAt}:${row.metadata || ''}`);
    if (seen.has(eventKey)) continue;
    seen.add(eventKey);
    const meta = parseMetadata(row.metadata);
    const attributed = meta.campaignVersion === C4_CAMPAIGN_ID || meta.campaign === C4_CAMPAIGN_NAME;
    if (attributed || isCampaign4LeadId(bareLeadId(row.sourceLeadId || row.leadId))) count += 1;
  }
  return count;
}

/** The per-run throttle. reserve(lead) is synchronous; non-Campaign 4 leads always pass. */
function createCampaign4Throttle({ sendsToday = 0, budget = 0, isCampaign4 = () => false } = {}) {
  let used = Math.max(0, Number(sendsToday) || 0);
  return Object.freeze({
    budget,
    used: () => used,
    remaining: () => Math.max(0, budget - used),
    reserve(lead) {
      if (!isCampaign4(lead)) return { ok: true, campaign4: false, release() {} };
      if (used >= budget) return { ok: false, campaign4: true, reason: `Campaign 4 daily share reached (${used}/${budget})` };
      used += 1;
      let released = false;
      return { ok: true, campaign4: true, release() { if (!released) { released = true; used = Math.max(0, used - 1); } } };
    },
  });
}

/**
 * Ordering only: Campaign 4 leads are placed through the batch at the share
 * ratio, so the first N candidates hold about N x share of them; everything
 * else keeps its order. With no Campaign 4 leads (or only those) the batch is
 * returned unchanged.
 */
function interleaveCampaign4Leads(leads = [], share = DEFAULT_SHARE, isCampaign4 = () => false) {
  const c4 = leads.filter(isCampaign4);
  if (!c4.length || c4.length === leads.length || !(share > 0)) return [...leads];
  const others = leads.filter(lead => !isCampaign4(lead));
  const out = [];
  let a = 0;
  let b = 0;
  while (a < c4.length || b < others.length) {
    const wantC4 = a < c4.length && (b >= others.length || (a + 1) <= share * (out.length + 1));
    out.push(wantC4 ? c4[a++] : others[b++]);
  }
  return out;
}

module.exports = {
  DEFAULT_SHARE, MAX_SHARE, campaign4ShareFromEnv, campaign4DailyBudget, campaign4SendsToday,
  createCampaign4Throttle, interleaveCampaign4Leads,
};
