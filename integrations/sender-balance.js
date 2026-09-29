'use strict';

// Capacity-weighted sender assignment for unsent first-touch (step 1) leads.
//
// WHY THIS EXISTS
//
// A step-1 sender is an INSTRUCTION, not evidence: chooseSender() honours the
// assigned inbox and never falls back to another one when it is full (three
// tests pin that on purpose). The only place an instruction was ever written
// was the dashboard queue dialog, where an operator picks ONE inbox for a whole
// batch. So every batch landed on whichever inbox was picked — nearly always
// primary — and every newly activated inbox started with zero supply.
//
// This module decides assignments; it never sends, reserves or touches a lead
// that has any outbound history. Two entry points share one workload model:
//
//   assignNewLeads()      admission: spread a batch being queued across the
//                         compatible inboxes by remaining capacity.
//   planSenderRebalance() refill: move only genuinely unsent, unowned step-1
//                         leads from an inbox holding more than a day of work
//                         to one holding less, and stop when the gap is filled.
//
// WORKLOAD MODEL (per active, send-eligible inbox)
//
//   target    = dailyLimit + ceil(dailyLimit × bufferRatio)
//   followUps = pinned follow-ups that will be due by the planning horizon
//   firstTouch= step-1 leads already assigned to it that are safely movable
//   load      = followUps + firstTouch
//   deficit   = max(0, target − load)
//   giveable  = min(firstTouch, max(0, load − target))
//
// Follow-ups are counted, never moved: a follow-up belongs to the mailbox that
// sent step 1, and that is decided by delivered-message evidence elsewhere.

const { allowedForLead, sentSenderEvidence } = require('./gmail-sender-routing');
const { isStaffingOnlySender } = require('./gmail-inbox-registry');
const { normalizeNiche, validateRoute, routedLeadReady } = require('./campaign-routing');
const { queueEligibility } = require('./outreach-queue');
const { sendSuppressionReason } = require('./pipeline-state');
const { NON_COLD_STAGES } = require('./automation-ownership');

const DEFAULT_BUFFER_RATIO = 0.15;
const FOLLOW_UP_DELAY_DAYS = Object.freeze({ 1: 3, 2: 5 });
const DAY_MS = 24 * 60 * 60 * 1000;
const QUEUE_STAGE = 'Queued';

// Any of these on a lead means a human, a reply, a model decision or an
// outbound attempt has touched it. Such a lead is never re-routed, whatever
// its row says. Deliberately broad: a false positive only leaves a lead where
// it already is.
const BLOCKING_ACTIVITY = /(reply|replied|agent_v2|decision|human|takeover|email_sent|follow_up_sent|sequence_step_sent|booking|send_reserved|send_uncertain|bounce|unsub|meeting|hold|suppress|sender_evidence|opt_out|promot)/i;

const text = value => String(value == null ? '' : value).trim();

function balancingSenders(senders = []) {
  return senders.filter(sender => sender && sender.status === 'active' && sender.sendEligible === true
    && Number(sender.dailyLimit) > 0);
}

function targetFor(sender, bufferRatio = DEFAULT_BUFFER_RATIO) {
  const limit = Number(sender.dailyLimit) || 0;
  return limit + Math.ceil(limit * bufferRatio);
}

function routeInboxes(senders) {
  return senders.map(sender => ({
    id: sender.id, email: sender.email || sender.id, sendEligible: Boolean(sender.sendEligible),
    deliveryImplemented: true, staffingOnly: isStaffingOnlySender(sender),
  }));
}

// A sender may take this lead only when the send path itself would accept it:
// the same allowedForLead() the scheduled sender enforces, plus the queue
// route's validateRoute() (staffing-only reservation, template ↔ niche).
function senderCompatible(sender, lead, inboxes) {
  if (!allowedForLead(sender, lead)) return false;
  return validateRoute({
    niche: lead.leadNiche || lead.tradeType, senderInboxId: sender.id,
    emailTemplateId: lead.emailTemplateId, inboxes,
  }).ok;
}

function indexActivities(activities = []) {
  const byLead = new Map();
  const add = (id, row) => {
    if (!id) return;
    if (!byLead.has(id)) byLead.set(id, []);
    byLead.get(id).push(row);
  };
  for (const row of activities) {
    if (row.sourceLeadId) add(text(row.sourceLeadId), row);
    else if (/^CE-/.test(text(row.leadId))) add(text(row.leadId).slice(3), row);
    else add(text(row.leadId), row);
  }
  return byLead;
}

/**
 * Is this step-1 lead safe to (re)assign? Returns { ok, reason }.
 * Fails closed: any doubt leaves the lead exactly where it is.
 */
function firstTouchMovability(lead, ctx) {
  if (lead.stage !== QUEUE_STAGE) return { ok: false, reason: 'not queued' };
  if (text(lead.emailStatus) || Number(lead.emailStep || 0) > 0 || text(lead.lastEmailedAt)) {
    return { ok: false, reason: 'not first-touch' };
  }
  if (ctx.lockedLeadIds.has(lead.id)) return { ok: false, reason: 'durable reservation exists' };
  const mine = ctx.activitiesByLead.get(lead.id) || [];
  if (sentSenderEvidence(lead, mine).length) return { ok: false, reason: 'outbound ownership exists' };
  const blocking = mine.find(row => BLOCKING_ACTIVITY.test(text(row.eventType)));
  if (blocking) return { ok: false, reason: `activity ${blocking.eventType}` };
  const suppressed = sendSuppressionReason(lead, { suppressedEmails: ctx.suppressedEmails });
  if (suppressed) return { ok: false, reason: `suppressed (${suppressed})` };
  const routed = routedLeadReady(lead, ctx.env);
  if (!routed.ok) return { ok: false, reason: `routing: ${routed.reason}` };
  // The queue route's own preflight, with the same (default) render options it
  // uses, so a lead is movable exactly when it could be queued again.
  const eligible = queueEligibility(lead, {
    ...ctx.renderOptions,
    leads: ctx.leads, activities: mine, boardLeads: ctx.boardLeads, suppressedEmails: ctx.suppressedEmails,
  });
  if (!eligible.ok) return { ok: false, reason: `queue eligibility: ${eligible.reason}` };
  return { ok: true };
}

/** Follow-ups pinned to each inbox that will be due by `horizon`. Counted, never moved. */
function projectedFollowUps({ leads, activitiesByLead, senders, suppressedEmails, horizon }) {
  const counts = new Map(senders.map(sender => [sender.id, 0]));
  const ids = new Set(senders.map(sender => sender.id));
  for (const lead of leads) {
    if (lead.emailStatus !== 'emailed') continue;
    const step = Number(lead.emailStep || 0);
    const delay = FOLLOW_UP_DELAY_DAYS[step];
    if (!delay) continue;
    if (NON_COLD_STAGES.includes(text(lead.stage).toLowerCase())) continue;
    if (sendSuppressionReason(lead, { suppressedEmails })) continue;
    const sent = Date.parse(lead.lastEmailedAt || '');
    if (!Number.isFinite(sent) || sent + delay * DAY_MS > horizon) continue;
    // Only a follow-up with ONE delivered-message owner is really sendable;
    // unproven legacy ownership is refused at send time, so it is no workload.
    const owners = sentSenderEvidence(lead, activitiesByLead.get(lead.id) || []);
    if (owners.length !== 1 || !ids.has(owners[0])) continue;
    counts.set(owners[0], counts.get(owners[0]) + 1);
  }
  return counts;
}

function planContext(input) {
  const leads = input.leads || [];
  return {
    leads,
    boardLeads: input.boardLeads || [],
    suppressedEmails: input.suppressedEmails || new Set(),
    lockedLeadIds: input.lockedLeadIds || new Set(),
    activitiesByLead: indexActivities(input.activities || []),
    env: input.env || process.env,
    renderOptions: input.renderOptions || {},
  };
}

/**
 * Per-inbox workload snapshot. `horizon` is the instant by which counted
 * follow-ups must be due (normally the end of the next sending day).
 */
function senderWorkload(input) {
  const senders = balancingSenders(input.senders || []);
  const bufferRatio = input.bufferRatio ?? DEFAULT_BUFFER_RATIO;
  const ctx = planContext(input);
  const inboxes = routeInboxes(senders);
  const horizon = Number(input.horizon ?? Date.now());
  const followUps = projectedFollowUps({ ...ctx, senders, horizon });
  const byId = new Map(senders.map(sender => [sender.id, sender]));

  const movable = [];
  const excluded = {};
  for (const lead of ctx.leads) {
    if (lead.stage !== QUEUE_STAGE) continue;
    const verdict = firstTouchMovability(lead, ctx);
    if (!verdict.ok) {
      const key = input.detailedReasons ? verdict.reason : verdict.reason.replace(/\s*\(.*$/, '').replace(/: .*/, '');
      excluded[key] = (excluded[key] || 0) + 1;
      continue;
    }
    const compatible = senders.filter(sender => senderCompatible(sender, lead, inboxes)).map(sender => sender.id);
    const current = text(lead.senderInboxId);
    movable.push({ lead, current: byId.has(current) && compatible.includes(current) ? current : '', compatible });
  }

  const rows = senders.map(sender => {
    const firstTouch = movable.filter(item => item.current === sender.id).length;
    const load = followUps.get(sender.id) + firstTouch;
    const target = targetFor(sender, bufferRatio);
    return {
      id: sender.id, dailyLimit: Number(sender.dailyLimit), staffingOnly: isStaffingOnlySender(sender),
      target, followUps: followUps.get(sender.id), firstTouch, load,
      deficit: Math.max(0, target - load), giveable: Math.min(firstTouch, Math.max(0, load - target)),
    };
  });
  return { senders: rows, movable, excluded, horizon, bufferRatio };
}

// Fraction of the inbox's own daily capacity still unfilled. Comparing this,
// not raw counts, is what makes the fill capacity-weighted.
const unfilledShare = row => (row.target - row.load) / row.dailyLimit;

/**
 * The refill plan. Pure and deterministic: the same inputs always produce the
 * same moves, and a plan applied and re-planned produces no moves.
 */
function planSenderRebalance(input) {
  const workload = senderWorkload(input);
  const rows = new Map(workload.senders.map(row => [row.id, { ...row }]));
  const order = workload.senders.map(row => row.id);
  const sortKey = item => [Number(item.lead.sheetRow ?? item.lead._row ?? 0), text(item.lead.id)];
  const pool = workload.movable
    .filter(item => item.compatible.length)
    .sort((a, b) => {
      const [ra, ia] = sortKey(a); const [rb, ib] = sortKey(b);
      return ra - rb || ia.localeCompare(ib);
    });
  // An unassigned (or incompatibly assigned) movable lead is freely giveable.
  const orphanDonor = { id: '', giveable: Infinity };
  const moves = [];
  const movedIds = new Set();

  const donorFor = item => (item.current ? rows.get(item.current) : orphanDonor);
  for (;;) {
    const recipients = [...rows.values()].filter(row => row.target - row.load > 0);
    if (!recipients.length) break;
    // Staffing-only inboxes can use only staffing leads, so they choose first;
    // then the inbox with the largest unfilled share of its own capacity.
    recipients.sort((a, b) => (b.staffingOnly - a.staffingOnly)
      || unfilledShare(b) - unfilledShare(a) || order.indexOf(a.id) - order.indexOf(b.id));
    let moved = false;
    for (const recipient of recipients) {
      const options = pool.filter(item => !movedIds.has(item.lead.id)
        && item.current !== recipient.id
        && item.compatible.includes(recipient.id)
        && donorFor(item).giveable > 0);
      if (!options.length) continue;
      // Prefer the lead fewest other short inboxes could use, so a flexible
      // inbox does not consume supply a restricted one needs; then orphans;
      // then the donor with the most surplus; then oldest row.
      const shortIds = new Set(recipients.map(row => row.id));
      const scarcity = item => item.compatible.filter(id => shortIds.has(id)).length;
      options.sort((a, b) => scarcity(a) - scarcity(b)
        || (a.current ? 1 : 0) - (b.current ? 1 : 0)
        || donorFor(b).giveable - donorFor(a).giveable);
      const pick = options[0];
      const donor = donorFor(pick);
      donor.giveable -= 1;
      if (pick.current) { donor.load -= 1; donor.firstTouch -= 1; }
      recipient.load += 1; recipient.firstTouch += 1;
      movedIds.add(pick.lead.id);
      moves.push({ leadId: pick.lead.id, from: pick.current || text(pick.lead.senderInboxId),
        to: recipient.id, niche: normalizeNiche(pick.lead.leadNiche || pick.lead.tradeType),
        expectedState: pick.lead });
      moved = true;
      break; // re-rank after every single move
    }
    if (!moved) break;
  }

  const after = [...rows.values()].map(row => ({ ...row, deficit: Math.max(0, row.target - row.load) }));
  return {
    before: workload.senders,
    after,
    moves,
    shortages: after.filter(row => row.deficit > 0).map(row => ({ senderInboxId: row.id, unfilled: row.deficit })),
    excluded: workload.excluded,
    horizon: workload.horizon,
    bufferRatio: workload.bufferRatio,
  };
}

/**
 * Admission: choose an inbox for each lead in a batch being queued. Each lead
 * goes to the compatible inbox with the largest unfilled share of its own
 * capacity; once every inbox is at target the batch is spread in proportion to
 * daily limit (lowest load ÷ dailyLimit first), so a 60/day inbox receives
 * three times the work of a 20/day one. Returns { assignments, refused }.
 */
function assignNewLeads({ batch = [], workload, senders = [] }) {
  const eligible = balancingSenders(senders);
  const inboxes = routeInboxes(eligible);
  const order = eligible.map(sender => sender.id);
  const rows = new Map((workload?.senders || []).map(row => [row.id, { ...row }]));
  for (const sender of eligible) {
    if (!rows.has(sender.id)) {
      rows.set(sender.id, { id: sender.id, dailyLimit: Number(sender.dailyLimit),
        target: targetFor(sender, workload?.bufferRatio), load: 0 });
    }
  }
  const assignments = new Map();
  const refused = [];
  for (const lead of batch) {
    const options = eligible.filter(sender => senderCompatible(sender, lead, inboxes)).map(sender => rows.get(sender.id));
    if (!options.length) { refused.push({ leadId: lead.id, reason: 'no active compatible sending inbox' }); continue; }
    options.sort((a, b) => {
      const ga = a.target - a.load; const gb = b.target - b.load;
      if ((ga > 0) !== (gb > 0)) return ga > 0 ? -1 : 1;
      if (ga > 0) return unfilledShare(b) - unfilledShare(a) || order.indexOf(a.id) - order.indexOf(b.id);
      return a.load / a.dailyLimit - b.load / b.dailyLimit || order.indexOf(a.id) - order.indexOf(b.id);
    });
    options[0].load += 1;
    assignments.set(lead.id, options[0].id);
  }
  return { assignments, refused };
}

/**
 * Admission against live state: the batch's own leads are taken out of the
 * workload first, so re-queueing an already-queued lead does not count it twice.
 */
function assignBatch({ batch = [], input }) {
  const workload = senderWorkload(input);
  const batchIds = new Set(batch.map(lead => lead.id));
  const rows = workload.senders.map(row => {
    const own = workload.movable.filter(item => batchIds.has(item.lead.id) && item.current === row.id).length;
    return { ...row, firstTouch: row.firstTouch - own, load: row.load - own };
  });
  return assignNewLeads({ batch, workload: { ...workload, senders: rows }, senders: input.senders });
}

/** End of the next Pacific send day (11:59:59 PT), the follow-up horizon. */
function nextSendDayHorizon(now = new Date()) {
  const pacific = new Date(now.toLocaleString('en-US', { timeZone: 'America/Vancouver' }));
  const offsetMs = now.getTime() - pacific.getTime();
  const day = new Date(pacific);
  // Once the last window (11:30) has started, today's sending is spoken for.
  if (pacific.getHours() * 60 + pacific.getMinutes() >= 11 * 60 + 30) day.setDate(day.getDate() + 1);
  while ([0, 6].includes(day.getDay())) day.setDate(day.getDate() + 1);
  day.setHours(11, 59, 59, 0);
  return day.getTime() + offsetMs;
}

module.exports = {
  DEFAULT_BUFFER_RATIO, BLOCKING_ACTIVITY, balancingSenders, targetFor, senderCompatible,
  firstTouchMovability, projectedFollowUps, senderWorkload, planSenderRebalance, assignNewLeads,
  assignBatch, nextSendDayHorizon,
};
