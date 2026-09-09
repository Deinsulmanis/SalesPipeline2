'use strict';
/**
 * generic-reengagement-analytics.js — how generic_follow_up_v1 is performing. PURE.
 * ─────────────────────────────────────────────────────────────────────────────
 * Judged the way the business actually judges cold email: replies, positive
 * replies, booked calls, closed clients. Delivered is the denominator because it
 * is the only number the provider proves.
 *
 * WHY OPENS LIVE HERE AND NOWHERE ELSE
 * ------------------------------------
 * Open rate is reported because it is already collected, and for no other
 * reason. It is DISPLAY ONLY: it must never gate eligibility, enrolment,
 * ownership, stopping or send priority. Keeping it in this module rather than in
 * generic-reengagement.js is what makes that guarantee checkable — the decision
 * module contains no open signal at all, and a test asserts it.
 */

const { GENERIC_SEQUENCE_ID } = require('./generic-reengagement');

const POSITIVE = new Set(['positive_reply', 'meeting_requested']);
const NEGATIVE = new Set(['negative_reply', 'wrong_person_reply']);
const UNSUB = new Set(['unsubscribe_reply']);
const OOO = new Set(['out_of_office_reply']);
const HUMAN_REVIEW = new Set(['needs_human_reply', 'question_reply', 'late_reply']);
const BOOKED = new Set(['call_booked', 'meeting_rescheduled']);
const REPLY_TYPES = new Set([...POSITIVE, ...NEGATIVE, ...UNSUB, ...OOO, ...HUMAN_REVIEW]);

const normEmail = value => String(value || '').trim().toLowerCase();
const cleanId = value => String(value || '').replace(/^CE-/, '').trim();
const meta = row => { try { return JSON.parse(row.metadata || '{}'); } catch (_) { return {}; } };
const rate = (numerator, denominator) => (denominator ? Number((100 * numerator / denominator).toFixed(1)) : null);

/**
 * @param input { activities, leads } — leads only supply the display-only open
 *              signal and the campaign label; no decision reads them.
 */
function genericReengagementAnalytics(input = {}) {
  const { activities = [], leads = [] } = input;

  const leadByKey = new Map();
  for (const lead of leads) {
    const email = normEmail(lead.email);
    if (email && !leadByKey.has(email)) leadByKey.set(email, lead);
    if (lead.id) leadByKey.set(cleanId(lead.id), lead);
  }
  const keyOf = row => cleanId(row.sourceLeadId) || normEmail(row.email) || cleanId(row.leadId);

  const byLead = new Map();
  for (const row of activities) {
    const key = keyOf(row);
    if (!key) continue;
    if (!byLead.has(key)) byLead.set(key, []);
    byLead.get(key).push(row);
  }

  const totals = {
    sequenceId: GENERIC_SEQUENCE_ID,
    enrolled: 0, delivered: 0, step1Delivered: 0, step2Delivered: 0,
    replies: 0, positiveReplies: 0, negativeReplies: 0, unsubscribes: 0,
    outOfOffice: 0, humanReview: 0, bookedMeetings: 0, closedWon: 0,
    step1Replies: 0, step2Replies: 0,
    blockedBeforeStep2: 0, meetingBeforeStep2: 0, stopped: 0, completed: 0,
    // Display only. Never an input to any decision — see the module header.
    openedDisplayOnly: 0,
  };
  const stopReasons = {};

  for (const [key, rows] of byLead) {
    const sorted = rows.slice().sort((a, b) => String(a.occurredAt || '').localeCompare(String(b.occurredAt || '')));
    const mine = sorted.filter(row => String(meta(row).sequenceId || '') === GENERIC_SEQUENCE_ID);
    if (!mine.length) continue;

    if (mine.some(row => row.eventType === 'sequence_enrolled')) totals.enrolled++;
    const steps = mine.filter(row => row.eventType === 'sequence_step_sent');
    const step1 = steps.find(row => Number(meta(row).step) === 1) || null;
    const step2 = steps.find(row => Number(meta(row).step) === 2) || null;
    if (step1) { totals.delivered++; totals.step1Delivered++; }
    if (step2) { totals.delivered++; totals.step2Delivered++; }

    const stops = mine.filter(row => row.eventType === 'sequence_stopped');
    for (const stop of stops) {
      totals.stopped++;
      const reason = String(meta(stop).reason || 'unknown');
      stopReasons[reason] = (stopReasons[reason] || 0) + 1;
    }
    if (mine.some(row => row.eventType === 'sequence_completed')) totals.completed++;

    if (!step1) continue;                       // nothing was delivered to attribute
    const from = String(step1.occurredAt || '');
    const step2At = step2 ? String(step2.occurredAt || '') : null;
    const after = sorted.filter(row => String(row.occurredAt || '') > from);

    // A lead replied at most once for rate purposes; the funnel counts people.
    let replied = false; let positive = false;
    for (const row of after) {
      const type = String(row.eventType || '');
      if (REPLY_TYPES.has(type)) {
        if (!replied) { replied = true; totals.replies++; }
        if (POSITIVE.has(type) && !positive) { positive = true; totals.positiveReplies++; }
        if (NEGATIVE.has(type)) totals.negativeReplies++;
        if (UNSUB.has(type)) totals.unsubscribes++;
        if (OOO.has(type)) totals.outOfOffice++;
        if (HUMAN_REVIEW.has(type)) totals.humanReview++;
        // Which step earned it: before Step 2 landed, Step 1 did the work.
        if (!step2At || String(row.occurredAt) < step2At) totals.step1Replies++;
        else totals.step2Replies++;
      }
      if (BOOKED.has(type)) totals.bookedMeetings++;
      if (type === 'closed_won') totals.closedWon++;
    }

    // Why Step 2 never went out.
    if (!step2) {
      const meetingFirst = after.some(row => BOOKED.has(String(row.eventType || '')));
      if (meetingFirst) totals.meetingBeforeStep2++;
      else if (replied || stops.length) totals.blockedBeforeStep2++;
    }

    const lead = leadByKey.get(key);
    if (lead && /open-triggered/i.test(String(lead.notes || ''))) totals.openedDisplayOnly++;
  }

  return {
    ...totals,
    stopReasons,
    rates: {
      replyRate: rate(totals.replies, totals.delivered),
      positiveReplyRate: rate(totals.positiveReplies, totals.delivered),
      bookedMeetingRate: rate(totals.bookedMeetings, totals.delivered),
      negativeReplyRate: rate(totals.negativeReplies, totals.delivered),
      unsubscribeRate: rate(totals.unsubscribes, totals.delivered),
      closedWonRate: rate(totals.closedWon, totals.delivered),
      // Reported, never acted on.
      openRateDisplayOnly: rate(totals.openedDisplayOnly, totals.delivered),
    },
  };
}

module.exports = { genericReengagementAnalytics };
