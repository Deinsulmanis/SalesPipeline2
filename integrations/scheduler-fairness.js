'use strict';

const { followUpDueAt } = require('./sequence-timing');

// Oldest-due first, by the one cadence definition (integrations/sequence-timing).
// `activities` is the pass's canonical ledger: Touch 3's due date is anchored on
// the Touch 1 send it records.
function oldestDueFirst(leads, activities = []) {
  const due = new Map(leads.map(lead => [lead, followUpDueAt(lead, { activities })]));
  return [...leads].sort((a, b) =>
    due.get(a) - due.get(b)
      || String(a.id || '').localeCompare(String(b.id || '')));
}

// How many of a sender's remaining window successes follow-ups may claim before
// initials get their reserved position. Normally all but one, at most four.
//
// drain: a TEMPORARY backlog mode (FOLLOW_UP_DRAIN_MODE=true). Follow-ups may
// take the whole bucket and initials only fill what follow-ups leave unused.
// It moves no cap: the window and daily limits still bound every send.
function followUpSuccessTarget(cap, { drain = false } = {}) {
  const remaining = Math.max(0, Number(cap) || 0);
  if (drain) return remaining;
  return Math.min(4, Math.max(0, remaining - 1));
}

async function simulateFairBatch({ initials, followUps, cap = 5, attemptInitial, attemptFollowUp, drain = false }) {
  let sent = 0;
  let followUpSent = 0;
  let followUpIndex = 0;
  const events = [];
  const target = followUpSuccessTarget(cap, { drain });
  while (followUpIndex < followUps.length && sent < cap && followUpSent < target) {
    const candidate = followUps[followUpIndex++];
    if (await attemptFollowUp(candidate)) {
      sent++; followUpSent++; events.push(['follow-up', candidate.id]);
    }
  }
  for (const candidate of initials) {
    if (sent >= cap) break;
    if (await attemptInitial(candidate)) {
      sent++; events.push(['initial', candidate.id]);
    }
  }
  while (followUpIndex < followUps.length && sent < cap) {
    const candidate = followUps[followUpIndex++];
    if (await attemptFollowUp(candidate)) {
      sent++; followUpSent++; events.push(['follow-up', candidate.id]);
    }
  }
  return { sent, followUpSent, initialSent: sent - followUpSent, events };
}

module.exports = { oldestDueFirst, followUpSuccessTarget, simulateFairBatch };
