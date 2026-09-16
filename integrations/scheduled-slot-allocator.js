'use strict';

/**
 * Fair-share allocation of a sender's scheduled-window slots.
 *
 * WHY THIS EXISTS
 *
 * Staffing and dental both route to `primary`. The step-1 pass walked the
 * queued list in sheet order and asked chooseSender for a sender per lead, so
 * whichever niche happened to sit earlier in the sheet consumed the whole
 * five-success window. Staffing leads reached chooseSender only after the
 * bucket was empty and were deferred with "assigned sender scheduled-window
 * limit reached" — a scheduling artifact, not an eligibility verdict.
 *
 * This module decides ORDER ONLY. It does not decide who may send: every
 * candidate handed to it has already passed selectQueued's eligibility filter,
 * and every attempt-time guard (suppression, ownership, routing, hold,
 * terminal state, CAS) still runs afterwards and can still refuse. A refused
 * candidate consumes no slot, because slots are counted on provider success,
 * never on attempt — so reordering can never turn a refusal into a send.
 *
 * THE RESERVATION
 *
 * Within each block of five slots the pattern is [staffing, other, staffing,
 * other, staffing]: three staffing, two other. The pattern is interleaved
 * rather than sorted, so neither niche is globally ranked ahead of the other
 * and neither can starve the other in reverse.
 *
 * Unused reserved capacity spills immediately: when the preferred pool for a
 * slot is empty, the slot goes to the other pool. Capacity is never left idle
 * while an eligible candidate exists.
 *
 * At a partial cap (a bucket already partly spent by stage or intent sends)
 * the same pattern degrades proportionally: cap 2 yields one each, cap 1
 * yields one staffing, rather than handing a short window entirely to one
 * niche.
 */

const STAFFING_NICHE = 'industrial_staffing';

/** Slot preference within each block. Three staffing to two other, interleaved. */
const SLOT_PATTERN = Object.freeze(['staffing', 'other', 'staffing', 'other', 'staffing']);

/**
 * Staffing is identified by canonical niche alone. Accepts either the runtime
 * ColdEmail shape (leadNiche) or a raw Supabase row (lead_niche) so callers on
 * either side of the mirror agree about which pool a lead belongs to.
 */
function isStaffingCandidate(lead = {}) {
  const niche = lead.leadNiche === undefined ? lead.lead_niche : lead.leadNiche;
  return String(niche || '').trim().toLowerCase() === STAFFING_NICHE;
}

/**
 * The sender a queued lead is assigned to, as an instruction — the same field
 * chooseSender honours for step 1. Blank means "no explicit assignment"; those
 * leads are routed dynamically and are not allocated against a named bucket.
 */
function assignedSenderId(lead = {}) {
  const id = lead.senderInboxId === undefined ? lead.sender_inbox_id : lead.senderInboxId;
  return String(id || '').trim();
}

function normalizeCap(windowCap) {
  const parsed = Number(windowCap);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

/**
 * allocateScheduledSlots(candidates, senderId, windowCap)
 *
 * `candidates` must already be eligibility-filtered and in the caller's
 * deterministic order. Only candidates assigned to `senderId` participate.
 *
 * Returns:
 *   selected  the leads that own this window's slots, at most windowCap,
 *             honouring the 3:2 reservation with spill
 *   ordered   selected first, then every remaining candidate for this sender
 *             in original relative order — so an attempt-time refusal falls
 *             through to the next candidate instead of wasting the slot
 *   staffing  / other: the partitioned pools, for reporting
 */
function allocateScheduledSlots(candidates = [], senderId = '', windowCap = 0) {
  const id = String(senderId || '').trim();
  const cap = normalizeCap(windowCap);
  const mine = (Array.isArray(candidates) ? candidates : [])
    .filter(lead => lead && assignedSenderId(lead) === id && id !== '');

  const staffing = mine.filter(isStaffingCandidate);
  const other = mine.filter(lead => !isStaffingCandidate(lead));

  const selected = [];
  const taken = new Set();
  let s = 0;
  let o = 0;

  for (let slot = 0; slot < cap; slot++) {
    if (s >= staffing.length && o >= other.length) break;
    const prefersStaffing = SLOT_PATTERN[slot % SLOT_PATTERN.length] === 'staffing';
    // Take from the preferred pool; if it is exhausted the slot spills to the
    // other pool rather than going unused.
    let pick = null;
    if (prefersStaffing) pick = s < staffing.length ? staffing[s++] : (o < other.length ? other[o++] : null);
    else pick = o < other.length ? other[o++] : (s < staffing.length ? staffing[s++] : null);
    if (!pick) break;
    selected.push(pick);
    taken.add(pick);
  }

  const ordered = [...selected, ...mine.filter(lead => !taken.has(lead))];
  return { selected, ordered, staffing, other, cap, senderId: id };
}

/**
 * Reorder a whole queued batch so each named sender's slice honours the
 * reservation. Leads with no explicit sender assignment keep their original
 * relative position at the end: they route dynamically and are not allocated
 * against a named bucket.
 *
 * `remainingForSender(senderId)` supplies the live per-sender window remaining
 * so a bucket already partly spent by stage or intent sends allocates only
 * what it actually has left.
 */
function fairShareQueuedOrder(candidates = [], remainingForSender = () => 0) {
  const list = Array.isArray(candidates) ? candidates : [];
  const senderIds = [];
  for (const lead of list) {
    const id = assignedSenderId(lead);
    if (id && !senderIds.includes(id)) senderIds.push(id);
  }
  const ordered = [];
  for (const id of senderIds) {
    ordered.push(...allocateScheduledSlots(list, id, remainingForSender(id)).ordered);
  }
  ordered.push(...list.filter(lead => !assignedSenderId(lead)));
  return ordered;
}

module.exports = {
  STAFFING_NICHE,
  SLOT_PATTERN,
  isStaffingCandidate,
  assignedSenderId,
  allocateScheduledSlots,
  fairShareQueuedOrder,
};
