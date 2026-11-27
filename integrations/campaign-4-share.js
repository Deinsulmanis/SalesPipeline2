'use strict';

/**
 * Daily split of ScaleLab's send cap between Campaign 3 and Campaign 4
 * "HOLD Company Test" (owner decisions 2026-11-27).
 *
 * The cap itself (ScaleLab's daily allocation, 170 today) and every sender,
 * window and per-run limit are unchanged. This module only divides it:
 *
 *   - Campaign 4 gets CAMPAIGN_4_DAILY_SENDS a day (default 70); Campaign 3
 *     gets the rest of the cap (170 - 70 = 100). "Campaign 3" here is every
 *     ScaleLab lead that is not Campaign 4 (Campaign 3 plus any earlier ScaleLab
 *     campaign still in sequence). Managed clients are outside the split.
 *   - Rollover: a campaign's demand today is its sends so far + its follow-ups
 *     due by the end of the Vancouver day + its eligible queued Email 1s. When
 *     Campaign 3's demand is below its 100, the difference goes to Campaign 4,
 *     so once Campaign 3 is done Campaign 4 gets all 170. The reverse also holds:
 *     unused Campaign 4 share goes to Campaign 3 (so before any Campaign 4 lead
 *     exists, Campaign 3 keeps the whole 170 it has today).
 *   - Follow-ups first: inside each campaign a new Email 1 is sent only if it
 *     leaves room for every follow-up still due today. Follow-ups are never
 *     held back to make room for an Email 1.
 *   - Every count is in successful sends, every step counted, per Vancouver day,
 *     re-planned from the ledger at the start of each run.
 *
 * CAMPAIGN_4_DAILY_SENDS must be a whole number from 0 to the cap. An invalid
 * value pauses Campaign 4 entirely (no share and no rollover) and Campaign 3
 * keeps the whole cap (fail closed). Each attempt takes a slot
 * synchronously before any Gmail probe or reservation, so parallel sender lanes
 * cannot overshoot. With no throttle initialised a Campaign 3 or Campaign 4
 * attempt is refused (fail closed).
 */

const { SUCCESSFUL_SEND_EVENTS } = require('./gmail-sender-routing');

const DEFAULT_CAMPAIGN_4_DAILY_SENDS = 70;
const C4_CAMPAIGN_ID = 'hold_company_test_campaign_4';
const C4_CAMPAIGN_NAME = 'HOLD Company Test';
const BUCKETS = Object.freeze(['c3', 'c4']);
const parseMetadata = value => { try { return typeof value === 'string' ? JSON.parse(value || '{}') : (value || {}); } catch (_) { return {}; } };
const bareLeadId = value => String(value || '').trim().replace(/^CE-/, '');
const nonNegative = value => Math.max(0, Number(value) || 0);

/** The configured split of `scalelabDailyCap`. Never exceeds the cap. */
function campaignSplitFromEnv(env = process.env, scalelabDailyCap) {
  const cap = Math.floor(nonNegative(scalelabDailyCap));
  const raw = env.CAMPAIGN_4_DAILY_SENDS;
  if (raw === undefined || String(raw).trim() === '') {
    const c4 = Math.min(DEFAULT_CAMPAIGN_4_DAILY_SENDS, cap);
    return { cap, c3: cap - c4, c4, source: 'default' };
  }
  const text = String(raw).trim();
  const value = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(value) || value > cap) {
    return { cap, c3: cap, c4: 0, source: 'invalid', paused: true,
      reason: `CAMPAIGN_4_DAILY_SENDS must be a whole number from 0 to ${cap}; Campaign 4 is paused` };
  }
  return { cap, c3: cap - value, c4: value, source: 'env' };
}

/**
 * Successful ScaleLab sends today (Vancouver day) per bucket, every step.
 * `bucketOfLeadId(bareId)` returns 'c3', 'c4', null (not ScaleLab) or
 * 'unknown' (no such lead); an unknown lead's row counts as Campaign 4 when its
 * attribution names it, else as Campaign 3 when it is ScaleLab's (conservative).
 */
function campaignSendsToday(activities = [], dayKey, bucketOfLeadId = () => null) {
  const counts = { c3: 0, c4: 0 };
  const seen = new Set();
  for (const row of activities) {
    if (!SUCCESSFUL_SEND_EVENTS.includes(String(row.eventType || ''))) continue;
    const day = row.occurredAt ? new Date(row.occurredAt).toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' }) : '';
    if (dayKey && day !== dayKey) continue;
    const eventKey = String(row.eventId || `${row.leadId}:${row.eventType}:${row.occurredAt}:${row.metadata || ''}`);
    if (seen.has(eventKey)) continue;
    seen.add(eventKey);
    const meta = parseMetadata(row.metadata);
    let bucket = bucketOfLeadId(bareLeadId(row.sourceLeadId || row.leadId));
    if (bucket === undefined || bucket === 'unknown') {
      if (meta.campaignVersion === C4_CAMPAIGN_ID || meta.campaign === C4_CAMPAIGN_NAME) bucket = 'c4';
      else if (!meta.clientId || meta.clientId === 'scalelab') bucket = 'c3';
      else bucket = null;
    }
    if (BUCKETS.includes(bucket)) counts[bucket] += 1;
  }
  return counts;
}

/**
 * Today's allowance per campaign. `today[bucket]` = { sent, followUpsDue,
 * queuedEmail1 }: sends so far, follow-ups due by the end of the day and not yet
 * sent, and eligible queued Email 1s. Pure.
 */
function planDailySplit(split, today = {}) {
  const side = bucket => ({ sent: nonNegative(today[bucket]?.sent), followUpsDue: nonNegative(today[bucket]?.followUpsDue),
    queuedEmail1: nonNegative(today[bucket]?.queuedEmail1) });
  const c3 = side('c3');
  const c4 = side('c4');
  const demand = { c3: c3.sent + c3.followUpsDue + c3.queuedEmail1, c4: c4.sent + c4.followUpsDue + c4.queuedEmail1 };
  // A paused Campaign 4 neither receives nor gives a rollover.
  const toC4 = split.paused ? 0 : Math.max(0, split.c3 - demand.c3);
  const toC3 = Math.max(0, split.c4 - demand.c4);
  const allowance = { c3: split.c3 + toC3, c4: split.paused ? 0 : split.c4 + toC4 };
  return { cap: split.cap, base: { c3: split.c3, c4: split.c4 }, today: { c3, c4 }, demand, rollover: { toC3, toC4 }, allowance,
    source: split.source, ...(split.reason ? { reason: split.reason } : {}) };
}

function splitLogLine(plan, dayKey) {
  const t = plan.today;
  return `[campaign-split] day=${dayKey} scalelabCap=${plan.cap} base c3=${plan.base.c3} c4=${plan.base.c4} (${plan.source})`
    + ` | sentToday c3=${t.c3.sent} c4=${t.c4.sent}`
    + ` | dueToday c3 followUps=${t.c3.followUpsDue} email1=${t.c3.queuedEmail1} c4 followUps=${t.c4.followUpsDue} email1=${t.c4.queuedEmail1}`
    + ` | rollover toC4=${plan.rollover.toC4} toC3=${plan.rollover.toC3}`
    + ` | allowance c3=${plan.allowance.c3} c4=${plan.allowance.c4}${plan.reason ? ` | ${plan.reason}` : ''}`;
}

/**
 * The per-run throttle. reserve(lead, step) is synchronous. A lead outside the
 * split (bucketOf returns null) always passes. A follow-up needs one slot of its
 * campaign's allowance; an Email 1 additionally leaves room for every follow-up
 * of its campaign still due today.
 */
function createCampaignSplitThrottle({ plan, bucketOf = () => null } = {}) {
  const used = { c3: plan.today.c3.sent, c4: plan.today.c4.sent };
  const pendingFollowUps = { c3: plan.today.c3.followUpsDue, c4: plan.today.c4.followUpsDue };
  const label = bucket => (bucket === 'c4' ? 'Campaign 4' : 'Campaign 3');
  return Object.freeze({
    plan,
    used: bucket => used[bucket],
    pendingFollowUps: bucket => pendingFollowUps[bucket],
    reserve(lead, step = 1) {
      const bucket = bucketOf(lead);
      if (!BUCKETS.includes(bucket)) return { ok: true, bucket: null, release() {} };
      const allowance = plan.allowance[bucket];
      const followUp = Number(step) > 1;
      if (used[bucket] >= allowance) return { ok: false, bucket, reason: `${label(bucket)} daily split reached (${used[bucket]}/${allowance})` };
      if (!followUp && used[bucket] + pendingFollowUps[bucket] >= allowance) {
        return { ok: false, bucket, reason: `${label(bucket)} daily split: remaining ${allowance - used[bucket]} slot(s) are reserved for follow-ups due today` };
      }
      used[bucket] += 1;
      if (followUp) pendingFollowUps[bucket] = Math.max(0, pendingFollowUps[bucket] - 1);
      return { ok: true, bucket, release() {} };
    },
  });
}

/**
 * Ordering only: Email 1 candidates of the two campaigns are placed through the
 * batch in proportion to the Email 1 room each has left today, so Campaign 3's
 * larger queue cannot take every slot before Campaign 4. Each campaign keeps its
 * own order; leads outside the split keep their place among Campaign 3's.
 */
function interleaveCampaign4Leads(leads = [], c4Fraction = 0, isCampaign4 = () => false) {
  const c4 = leads.filter(isCampaign4);
  if (!c4.length || c4.length === leads.length || !(c4Fraction > 0)) return [...leads];
  const share = Math.min(1, c4Fraction);
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

/** The fraction of today's remaining Email 1 room that is Campaign 4's (for interleaving). */
function campaign4Email1Fraction(plan) {
  const room = bucket => Math.max(0, plan.allowance[bucket] - plan.today[bucket].sent - plan.today[bucket].followUpsDue);
  const total = room('c3') + room('c4');
  return total > 0 ? room('c4') / total : 0;
}

module.exports = {
  DEFAULT_CAMPAIGN_4_DAILY_SENDS, campaignSplitFromEnv, campaignSendsToday, planDailySplit, splitLogLine,
  createCampaignSplitThrottle, interleaveCampaign4Leads, campaign4Email1Fraction,
};
