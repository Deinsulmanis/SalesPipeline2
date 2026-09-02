'use strict';

function followUpDueAt(lead, sequence) {
  const step = parseInt(lead.emailStep || '0', 10);
  const delayDays = sequence[step - 1]?.delayDays;
  const lastSent = new Date(lead.lastEmailedAt).getTime();
  if (!Number.isFinite(lastSent) || !Number.isFinite(delayDays)) return Infinity;
  return lastSent + delayDays * 86400000;
}

function oldestDueFirst(leads, sequence) {
  return [...leads].sort((a, b) => followUpDueAt(a, sequence) - followUpDueAt(b, sequence)
    || String(a.id || '').localeCompare(String(b.id || '')));
}

function followUpSuccessTarget(cap) {
  return Math.min(4, Math.max(0, Number(cap) - 1));
}

async function simulateFairBatch({ initials, followUps, cap = 5, attemptInitial, attemptFollowUp }) {
  let sent = 0, followUpSent = 0, followUpIndex = 0;
  const events = [];
  while (followUpIndex < followUps.length && sent < cap && followUpSent < followUpSuccessTarget(cap)) {
    const candidate = followUps[followUpIndex++];
    if (await attemptFollowUp(candidate)) { sent++; followUpSent++; events.push(['follow-up', candidate.id]); }
  }
  for (const candidate of initials) {
    if (sent >= cap) break;
    if (await attemptInitial(candidate)) { sent++; events.push(['initial', candidate.id]); }
  }
  while (followUpIndex < followUps.length && sent < cap) {
    const candidate = followUps[followUpIndex++];
    if (await attemptFollowUp(candidate)) { sent++; followUpSent++; events.push(['follow-up', candidate.id]); }
  }
  return { sent, followUpSent, initialSent: sent - followUpSent, events };
}

module.exports = { followUpDueAt, oldestDueFirst, followUpSuccessTarget, simulateFairBatch };
