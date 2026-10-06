#!/usr/bin/env node
'use strict';

/**
 * READ-ONLY dry run of the 2026-10-03 Touch 3 timing change.
 *
 *   node scripts/sequence-timing-dry-run.js <snapshot.json> [--at=<ISO>] [--json]
 *
 * The snapshot is { capturedAt, leads: [...], activities: [...] } exported from
 * production (Supabase outreach_leads + crm_events). Nothing is read from or
 * written to any live system here. For each active cold lead it compares the
 * PREVIOUS rule (Touch 2 at lastEmailedAt + 3 days, Touch 3 at Touch 2 + 5
 * days) with the canonical one in integrations/sequence-timing.js, applies the
 * blockers the snapshot can see (manual hold, suppression tags, genuine reply,
 * booking, OOO), and simulates how the due backlog drains under the existing
 * caps with follow-ups first. It never changes a cap.
 *
 * Limits: the durable Suppression sheet and Pipeline cards are not in the
 * snapshot, so a few leads counted eligible may still be refused at send time
 * (that only lowers sends, never raises them).
 */

const fs = require('node:fs');
const {
  nextFollowUp, isFollowUpDue, nextSendWindowAt, addVancouverDays, SEND_WINDOWS,
} = require('../integrations/sequence-timing');
const { scheduledOooResume } = require('../integrations/ooo-pause');

// The rule production ran until this change, for comparison only.
const LEGACY_TOUCH2_AFTER_PREVIOUS_DAYS = 3;
const LEGACY_TOUCH3_AFTER_PREVIOUS_DAYS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

const GENUINE_REPLY = new Set(['positive_reply', 'meeting_requested', 'late_reply', 'question_reply',
  'negative_reply', 'unsubscribe_reply', 'wrong_person_reply', 'needs_human_reply']);

const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: SEND_WINDOWS.timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
const vanDay = ms => fmt.format(new Date(ms));

function legacyDueAt(lead) {
  const step = parseInt(lead.emailStep || '0', 10);
  const last = Date.parse(lead.lastEmailedAt || '');
  if (!Number.isFinite(last) || ![1, 2].includes(step)) return Infinity;
  return last + (step === 1 ? LEGACY_TOUCH2_AFTER_PREVIOUS_DAYS : LEGACY_TOUCH3_AFTER_PREVIOUS_DAYS) * DAY_MS;
}

function normalize(snapshot) {
  const leads = (snapshot.leads || []).map(row => ({
    id: row.lead_id ?? row.id, company: row.company, email: row.email, stage: row.stage,
    emailStatus: row.email_status ?? row.emailStatus, emailStep: String(row.email_step ?? row.emailStep ?? ''),
    lastEmailedAt: row.last_emailed_at ?? row.lastEmailedAt, senderInboxId: row.sender_inbox_id ?? row.senderInboxId,
    hold: Boolean(row.hold), oooMarker: Boolean(row.ooo_marker), suppressionTag: Boolean(row.sup_tag),
  }));
  const activities = (snapshot.activities || []).map(row => ({
    ...row, occurredAt: row.occurredAt ? new Date(row.occurredAt).toISOString() : row.occurredAt,
  }));
  return { leads, activities };
}

/** Why the send path would refuse this lead regardless of timing, or ''. */
function blocker(lead, mine) {
  if (lead.hold) return 'manual_hold';
  if (lead.suppressionTag) return 'suppression_tag';
  if (mine.some(row => row.eventType === 'call_booked')) return 'booking';
  const lastSend = Math.max(...mine.filter(r => ['initial_email_sent', 'follow_up_sent'].includes(r.eventType))
    .map(r => Date.parse(r.occurredAt)), -Infinity);
  if (mine.some(r => GENUINE_REPLY.has(r.eventType))) return 'genuine_reply';
  if (mine.some(r => r.eventType === 'human_response_sent' && Date.parse(r.occurredAt) > lastSend)) return 'human_answered';
  return '';
}

function oooState(mine, now) {
  const ooo = mine.filter(r => r.eventType === 'out_of_office_reply').sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))[0];
  if (!ooo) return null;
  const scheduled = scheduledOooResume(mine, { since: ooo.occurredAt });
  if (scheduled) return Date.parse(scheduled.resumeAt) > now ? `ooo_until_${scheduled.resumeAt.slice(0, 10)}` : null;
  let meta = {};
  try { meta = JSON.parse(ooo.metadata || '{}'); } catch (_) { /* none */ }
  if (meta.returnDate && Date.parse(meta.returnDate) <= now) return null;
  return meta.returnDate ? `ooo_until_${meta.returnDate}` : 'ooo_legacy_nothing_due';
}

const bump = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);
const obj = map => Object.fromEntries([...map].sort(([a], [b]) => String(a).localeCompare(String(b))));

function analyse(snapshot, atIso) {
  const { leads, activities } = normalize(snapshot);
  const now = Date.parse(atIso || snapshot.capturedAt);
  const nextWindow = nextSendWindowAt(now);
  const byLead = new Map();
  for (const row of activities) {
    const id = row.sourceLeadId || String(row.leadId || '').replace(/^CE-/, '');
    if (!byLead.has(id)) byLead.set(id, []);
    byLead.get(id).push(row);
  }
  const rows = [];
  for (const lead of leads) {
    const mine = byLead.get(lead.id) || [];
    const next = nextFollowUp(lead, { activities: mine });
    if (!next) continue;
    const t1 = next.touch1At ?? Date.parse(lead.lastEmailedAt);
    rows.push({
      id: lead.id, company: lead.company, sender: lead.senderInboxId || '(unassigned)', nextStep: next.nextStep,
      touch1Day: Number.isFinite(t1) ? vanDay(t1) : 'unknown',
      oldDueAt: legacyDueAt(lead), newDueAt: next.dueAt, basis: next.basis,
      oldDueByWindow: legacyDueAt(lead) <= nextWindow, newDueByWindow: isFollowUpDue(lead, nextWindow, { activities: mine }),
      alreadySent: next.alreadySent, blockedBy: blocker(lead, mine) || oooState(mine, nextWindow) || '',
    });
  }
  const sendable = rows.filter(r => !r.blockedBy);
  const summary = {
    capturedAt: snapshot.capturedAt, evaluatedAt: new Date(now).toISOString(),
    nextSendWindow: new Date(nextWindow).toISOString(),
    leadsInSequence: rows.length,
    blocked: obj(rows.filter(r => r.blockedBy).reduce((m, r) => bump(m, r.blockedBy.startsWith('ooo_until') ? 'ooo_until_date' : r.blockedBy), new Map())),
    dueAtNextWindow: { old: {}, new: {} },
    newlyEligibleAtNextWindow: {}, deferredByNewRule: {},
    touch3ShiftDays: { earlier: 0, later: 0, same: 0, maxEarlier: 0, maxLater: 0 },
  };
  for (const [label, key] of [['old', 'oldDueByWindow'], ['new', 'newDueByWindow']]) {
    const bySender = new Map(); const byStep = new Map();
    for (const r of sendable.filter(item => item[key])) { bump(byStep, `touch${r.nextStep}`); bump(bySender, `${r.sender}/touch${r.nextStep}`); }
    summary.dueAtNextWindow[label] = { total: sendable.filter(item => item[key]).length, byStep: obj(byStep), bySenderStep: obj(bySender) };
  }
  const gained = sendable.filter(r => r.newDueByWindow && !r.oldDueByWindow);
  const deferred = sendable.filter(r => !r.newDueByWindow && r.oldDueByWindow);
  const group = list => ({
    total: list.length,
    byStep: obj(list.reduce((m, r) => bump(m, `touch${r.nextStep}`), new Map())),
    bySender: obj(list.reduce((m, r) => bump(m, r.sender), new Map())),
    byTouch1Day: obj(list.reduce((m, r) => bump(m, r.touch1Day), new Map())),
  });
  summary.newlyEligibleAtNextWindow = group(gained);
  summary.deferredByNewRule = group(deferred);
  for (const r of rows.filter(item => item.nextStep === 3)) {
    const shift = (r.newDueAt - r.oldDueAt) / DAY_MS;
    if (Math.abs(shift) < 1e-9) summary.touch3ShiftDays.same++;
    else if (shift < 0) { summary.touch3ShiftDays.earlier++; summary.touch3ShiftDays.maxEarlier = Math.max(summary.touch3ShiftDays.maxEarlier, -shift); }
    else { summary.touch3ShiftDays.later++; summary.touch3ShiftDays.maxLater = Math.max(summary.touch3ShiftDays.maxLater, shift); }
  }
  summary.touch3ShiftDays.maxEarlier = Number(summary.touch3ShiftDays.maxEarlier.toFixed(2));
  summary.touch3ShiftDays.maxLater = Number(summary.touch3ShiftDays.maxLater.toFixed(2));
  return { summary, rows, sendable };
}

/**
 * Business-day drain: each weekday every active sender sends up to its daily
 * limit, oldest-due follow-ups first (drain mode: no initials). A Touch 2 sent
 * on day d makes that lead's Touch 3 due by the canonical rule. Returns the day
 * each follow-up goes out and how late it is versus its due date.
 */
function simulateDrain(sendable, { limits, startMs, rule = 'new', days = 15 }) {
  const queue = sendable.map(r => ({ ...r, due: rule === 'new' ? r.newDueAt : r.oldDueAt }));
  const out = [];
  let day = startMs;
  for (let i = 0; i < days && queue.length; i++) {
    while ([6, 7].includes(new Date(day).getUTCDay() || 7)) day += DAY_MS;
    const endOfWindows = day + 4.5 * 60 * 60 * 1000;
    const used = new Map();
    queue.sort((a, b) => a.due - b.due);
    for (const item of [...queue]) {
      if (item.due > endOfWindows) continue;
      const cap = limits[item.sender] ?? 0;
      if ((used.get(item.sender) || 0) >= cap) continue;
      used.set(item.sender, (used.get(item.sender) || 0) + 1);
      const sentAt = Math.max(day, nextSendWindowAt(item.due));
      out.push({ ...item, sentAt, lateDays: Math.max(0, (sentAt - item.due) / DAY_MS) });
      queue.splice(queue.indexOf(item), 1);
      if (item.nextStep === 2) {
        const t1 = item.touch1Day === 'unknown' ? null : item.touch1At;
        const touch3 = rule === 'new'
          ? Math.max(addVancouverDays(item.t1Ms ?? sentAt - 3 * DAY_MS, 7), addVancouverDays(sentAt, 3))
          : sentAt + LEGACY_TOUCH3_AFTER_PREVIOUS_DAYS * DAY_MS;
        queue.push({ ...item, nextStep: 3, due: touch3, t1Ms: item.t1Ms, touch1At: t1 });
      }
    }
    day += DAY_MS;
  }
  const t3 = out.filter(item => item.nextStep === 3);
  const touch3DayFromT1 = t3.filter(item => item.t1Ms).map(item => (item.sentAt - item.t1Ms) / DAY_MS);
  return {
    sent: out.length, touch2: out.filter(i => i.nextStep === 2).length, touch3: t3.length,
    remaining: queue.filter(i => i.due <= day).length,
    lastSendDay: out.length ? vanDay(Math.max(...out.map(i => i.sentAt))) : null,
    avgLateDays: out.length ? Number((out.reduce((s, i) => s + i.lateDays, 0) / out.length).toFixed(2)) : 0,
    touch3AvgDayFromTouch1: touch3DayFromT1.length ? Number((touch3DayFromT1.reduce((s, x) => s + x, 0) / touch3DayFromT1.length).toFixed(1)) : null,
  };
}

function main() {
  const [file, ...flags] = process.argv.slice(2);
  if (!file) { console.error('usage: node scripts/sequence-timing-dry-run.js <snapshot.json> [--at=ISO] [--json]'); process.exit(2); }
  const at = (flags.find(f => f.startsWith('--at=')) || '').slice(5) || null;
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { summary, rows, sendable } = analyse(snapshot, at);
  const t1ById = new Map(rows.map(r => [r.id, null]));
  const { activities } = normalize(snapshot);
  for (const row of activities) if (row.eventType === 'initial_email_sent') t1ById.set(row.sourceLeadId, Date.parse(row.occurredAt));
  const withT1 = sendable.map(r => ({ ...r, t1Ms: t1ById.get(r.id) || null }));
  const start = Date.parse(summary.nextSendWindow);
  const current = { primary: 60 };
  const full = { primary: 60, tryscalelabai: 60, scalelabaiteam: 40, deniels: 20, deniels_tryscalelabai: 20 };
  summary.drain = {
    currentCapacity_primaryOnly_60: { new: simulateDrain(withT1, { limits: current, startMs: start }), old: simulateDrain(withT1, { limits: current, startMs: start, rule: 'old' }) },
    fullCapacity_200: { new: simulateDrain(withT1, { limits: full, startMs: start }), old: simulateDrain(withT1, { limits: full, startMs: start, rule: 'old' }) },
  };
  if (flags.includes('--json')) console.log(JSON.stringify({ summary, rows }, null, 2));
  else console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) main();
module.exports = { analyse, simulateDrain, legacyDueAt };
