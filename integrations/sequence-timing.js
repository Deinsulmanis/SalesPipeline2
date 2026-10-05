'use strict';

/**
 * THE cold sequence cadence. Every consumer — the sending selector, oldest-due
 * ordering, the Pipeline's next action, reactivation, the 06:40 refill's
 * workload projection, offer retirement, the Gmail/CRM audit, readiness and the
 * dashboard preview — reads its timing from here. Nothing else may carry its
 * own copy of the delays: test/sequence-timing.test.js fails if one appears.
 *
 * Staffing is the only live cold offer, so this is the staffing sequence:
 *
 *   Touch 1  Day 0
 *   Touch 2  Touch 1 + 3 days
 *   Touch 3  MAX(Touch 1 + 7 days, Touch 2 + 3 days)
 *
 * Touch 3 is anchored on Touch 1 so a Touch 2 sent on Day 3 or 4 still gives a
 * Day 7 Touch 3, and floored on Touch 2 so a late Touch 2 never makes Touch 3
 * due the moment Touch 2 lands. (Until 2026-10-03 Touch 3 was Touch 2 + 5 days,
 * which could never be earlier than Day 8 and averaged Day 10.4.)
 *
 * Days are Vancouver calendar days at the same wall-clock time, so a cadence
 * that crosses a DST change keeps its time of day and cannot slide out of the
 * morning send windows. The windows themselves (weekdays 07:00–11:30) are
 * unchanged: a follow-up that falls due at a weekend waits for Monday.
 *
 * Pure: no I/O, no requires beyond the lead-row matcher.
 */

const { activityLeadKey } = require('./lead-activity');

const DAY_MS = 24 * 60 * 60 * 1000;
const TIMEZONE = 'America/Vancouver';

const SEQUENCE_TIMING = Object.freeze({
  timezone: TIMEZONE,
  touchCount: 3,
  touch2: Object.freeze({ afterTouch1Days: 3 }),
  touch3: Object.freeze({ afterTouch1Days: 7, minAfterTouch2Days: 3 }),
});

/** Follow-up steps after Touch 1 (Email 2 and Email 3). */
const FOLLOW_UP_STEP_COUNT = SEQUENCE_TIMING.touchCount - 1;

/** The nominal day each touch lands on when nothing slips: [0, 3, 7]. */
const NOMINAL_TOUCH_DAYS = Object.freeze([
  0, SEQUENCE_TIMING.touch2.afterTouch1Days, SEQUENCE_TIMING.touch3.afterTouch1Days,
]);

const DUE_BASIS = Object.freeze({
  TOUCH1_PLUS_3D: 'touch1_plus_3d',
  TOUCH1_PLUS_7D: 'touch1_plus_7d',
  TOUCH2_PLUS_3D: 'touch2_plus_3d',
  // Touch 1 has no ledger evidence. Touch 2 is never earlier than Touch 1 + 3
  // days, so Touch 1 + 7 days is never later than Touch 2 + 4 days: using the
  // upper bound can only make Touch 3 later than the rule, never earlier.
  TOUCH2_PLUS_4D_UNPROVEN_TOUCH1: 'touch2_plus_4d_touch1_unproven',
});

// Scheduled send windows, weekdays at :00 and :30 from 07:00 to 11:30 Vancouver
// time. server.js schedules the agent from SEND_WINDOW_CRON, so this is the one
// definition of when a due follow-up can actually go out.
const SEND_WINDOWS = Object.freeze({
  timezone: TIMEZONE,
  weekdays: Object.freeze([1, 2, 3, 4, 5]),
  firstHour: 7,
  lastHour: 11,
  minutes: Object.freeze([0, 30]),
});
const SEND_WINDOW_CRON = `${SEND_WINDOWS.minutes.join(',')} ${SEND_WINDOWS.firstHour}-${SEND_WINDOWS.lastHour} * * `
  + `${SEND_WINDOWS.weekdays[0]}-${SEND_WINDOWS.weekdays[SEND_WINDOWS.weekdays.length - 1]}`;

// ── Vancouver calendar arithmetic ────────────────────────────────────────────

const wallFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function wallClock(ms) {
  const parts = {};
  for (const part of wallFormat.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return parts;
}

/** The Vancouver wall-clock reading of `ms`, expressed as if it were UTC. */
function wallAsUtc(ms) {
  const p = wallClock(ms);
  const millis = ((ms % 1000) + 1000) % 1000;
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) + millis;
}

/** Add whole Vancouver calendar days, keeping the wall-clock time. */
function addVancouverDays(ms, days) {
  if (!Number.isFinite(ms)) return NaN;
  const targetWall = wallAsUtc(ms) + days * DAY_MS;
  let result = targetWall - (wallAsUtc(ms) - ms);
  // Re-apply the offset in force at the target instant (DST may differ).
  result = targetWall - (wallAsUtc(result) - result);
  return result;
}

/** ISO weekday, 1 = Monday … 7 = Sunday, in Vancouver. */
function vancouverWeekday(ms) {
  const p = wallClock(ms);
  const day = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return day === 0 ? 7 : day;
}

function isSendWindowSlot(ms) {
  const p = wallClock(ms);
  return SEND_WINDOWS.weekdays.includes(vancouverWeekday(ms))
    && p.hour >= SEND_WINDOWS.firstHour && p.hour <= SEND_WINDOWS.lastHour
    && SEND_WINDOWS.minutes.includes(p.minute) && p.second === 0;
}

/**
 * The first scheduled send window at or after `ms`. Vancouver's UTC offset is a
 * whole number of hours, so UTC half-hours are Vancouver half-hours.
 */
function nextSendWindowAt(ms) {
  if (!Number.isFinite(ms)) return NaN;
  const HALF_HOUR = 30 * 60 * 1000;
  let slot = Math.ceil(ms / HALF_HOUR) * HALF_HOUR;
  for (let i = 0; i < 14 * 48; i++, slot += HALF_HOUR) {
    if (isSendWindowSlot(slot)) return slot;
  }
  return NaN;
}

// ── Ledger evidence ──────────────────────────────────────────────────────────

const SEND_EVENTS = Object.freeze(['initial_email_sent', 'follow_up_sent']);

function parseMetadata(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}'); } catch (_) { return {}; }
}

function sendStepOf(row) {
  if (row.eventType === 'initial_email_sent') return 1;
  const meta = parseMetadata(row.metadata);
  const step = Number(meta.sequenceStep ?? meta.step ?? row.sequenceStep);
  return Number.isInteger(step) ? step : null;
}

// One index per activities array: the agent calls this for every lead in the
// corpus each pass, and rescanning ~10k rows per lead would be quadratic.
const indexCache = new WeakMap();

function sendIndex(activities) {
  if (!Array.isArray(activities)) return new Map();
  const cached = indexCache.get(activities);
  if (cached) return cached;
  const index = new Map();
  for (const row of activities) {
    if (!SEND_EVENTS.includes(String(row?.eventType || ''))) continue;
    const key = activityLeadKey(row);
    const at = Date.parse(row.occurredAt || '');
    const step = sendStepOf(row);
    if (!key || !Number.isFinite(at) || !step) continue;
    const list = index.get(key) || [];
    list.push({ step, at });
    index.set(key, list);
  }
  indexCache.set(activities, index);
  return index;
}

function sendsFor(lead, activities) {
  return sendIndex(activities).get(String(lead?.id || '')) || [];
}

/**
 * When the lead's CURRENT sequence started: the latest Touch 1 send at or
 * before `notAfter`. Null when the ledger has no Touch 1 for the lead.
 */
function touch1SentAt(lead, activities, notAfter = Infinity) {
  let latest = null;
  for (const send of sendsFor(lead, activities)) {
    if (send.step === 1 && send.at <= notAfter && (latest === null || send.at > latest)) latest = send.at;
  }
  return latest;
}

/**
 * Has `step` already been delivered in the lead's current sequence? The row's
 * emailStep is normally advanced by the same write that records the send; this
 * covers a row left stale by a failed checkpoint, so a corrected due date can
 * never re-offer a step the ledger already shows as sent.
 */
function stepAlreadySent(lead, activities, step) {
  const sends = sendsFor(lead, activities);
  const start = sends.filter(s => s.step === 1).reduce((max, s) => Math.max(max, s.at), -Infinity);
  return sends.some(s => s.step === Number(step) && s.at >= start);
}

// ── The rule ─────────────────────────────────────────────────────────────────

/**
 * The next cold follow-up for a lead, or null when none applies.
 *
 * Reads only emailStep and lastEmailedAt from the row (the same fields the
 * sender always used) plus the ledger for Touch 1. Callers keep their own
 * status, stage, ownership and suppression gates; this answers WHEN only.
 *
 * @returns {{ currentStep, nextStep, dueAt, dueAtIso, basis, touch1At, touch2At, alreadySent }|null}
 */
function nextFollowUp(lead = {}, { activities = [] } = {}) {
  const currentStep = parseInt(lead.emailStep || '0', 10);
  if (!(currentStep >= 1 && currentStep <= FOLLOW_UP_STEP_COUNT)) return null;
  const lastSent = Date.parse(lead.lastEmailedAt || '');
  if (!Number.isFinite(lastSent)) return null;
  const nextStep = currentStep + 1;

  let dueAt; let basis; let touch1At = null; let touch2At = null;
  if (currentStep === 1) {
    touch1At = lastSent;
    dueAt = addVancouverDays(lastSent, SEQUENCE_TIMING.touch2.afterTouch1Days);
    basis = DUE_BASIS.TOUCH1_PLUS_3D;
  } else {
    touch2At = lastSent;
    touch1At = touch1SentAt(lead, activities, lastSent);
    const floor = addVancouverDays(lastSent, SEQUENCE_TIMING.touch3.minAfterTouch2Days);
    if (touch1At === null) {
      dueAt = addVancouverDays(lastSent, SEQUENCE_TIMING.touch3.afterTouch1Days
        - SEQUENCE_TIMING.touch2.afterTouch1Days);
      basis = DUE_BASIS.TOUCH2_PLUS_4D_UNPROVEN_TOUCH1;
    } else {
      const anchored = addVancouverDays(touch1At, SEQUENCE_TIMING.touch3.afterTouch1Days);
      dueAt = Math.max(anchored, floor);
      basis = anchored >= floor ? DUE_BASIS.TOUCH1_PLUS_7D : DUE_BASIS.TOUCH2_PLUS_3D;
    }
  }
  return {
    currentStep, nextStep, dueAt, dueAtIso: new Date(dueAt).toISOString(), basis,
    touch1At, touch2At, alreadySent: stepAlreadySent(lead, activities, nextStep),
  };
}

/** Due-at instant in ms, or Infinity when no follow-up applies. */
function followUpDueAt(lead, options = {}) {
  const next = nextFollowUp(lead, options);
  return next ? next.dueAt : Infinity;
}

/**
 * THE timing gate. True when a follow-up step exists, its due instant has
 * passed, and the ledger does not already show that step delivered.
 */
function isFollowUpDue(lead, now = Date.now(), options = {}) {
  const next = nextFollowUp(lead, options);
  if (!next || next.alreadySent) return false;
  return new Date(now).getTime() >= next.dueAt;
}

/** Human-readable cadence, for previews, readiness and the dashboard. */
function describeSequence() {
  const t = SEQUENCE_TIMING;
  return [
    { step: 1, day: NOMINAL_TOUCH_DAYS[0], rule: 'Day 0' },
    { step: 2, day: NOMINAL_TOUCH_DAYS[1], rule: `${t.touch2.afterTouch1Days} days after Email 1` },
    { step: 3, day: NOMINAL_TOUCH_DAYS[2],
      rule: `${t.touch3.afterTouch1Days} days after Email 1, and at least ${t.touch3.minAfterTouch2Days} days after Email 2` },
  ];
}

module.exports = {
  SEQUENCE_TIMING, FOLLOW_UP_STEP_COUNT, NOMINAL_TOUCH_DAYS, DUE_BASIS,
  SEND_WINDOWS, SEND_WINDOW_CRON, DAY_MS,
  addVancouverDays, vancouverWeekday, nextSendWindowAt,
  touch1SentAt, stepAlreadySent, nextFollowUp, followUpDueAt, isFollowUpDue, describeSequence,
};
