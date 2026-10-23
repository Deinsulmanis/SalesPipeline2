'use strict';

// Offline, deterministic saturated-day capacity model. No database, network or
// provider calls. The limits below are the live values reverified for this
// change; a different production configuration needs a new verification.
const assert = require('node:assert/strict');
const { buildSendRunPlan } = require('../integrations/send-run-plan');

const senders = [
  ['primary', 'scalelab', 50, 6],
  ['tryscalelabai', 'scalelab', 30, 6],
  ['deniels', 'scalelab', 45, 5],
  ['deniels_tryscalelabai', 'scalelab', 45, 5],
  ['scalelabaiteam', 'scalelab', 15, 5],
  ['jole_team_jorge', 'jole', 15, 2],
  ['jole_team_jguerrero', 'jole', 15, 2],
  ['jole_group_jorge', 'jole', 15, 2],
  ['jole_group_jguerrero', 'jole', 15, 2],
  ['jole_industrial_jorge', 'jole', 0, 2],
  ['jole_industrial_jguerrero', 'jole', 0, 2],
].map(([id, clientId, dailyLimit, perRunLimit]) =>
  ({ id, clientId, dailyLimit, perRunLimit, sendEligible: dailyLimit > 0 }));
const capacity = { globalDailyLimit: 245, globalPerRunLimit: 39,
  clientLimits: { scalelab: { daily: 185, perRun: 27 }, jole: { daily: 60, perRun: 12 } } };

// Four early Jole ticks are 07:00–08:30 Chicago / 05:00–06:30 Pacific.
// The ten shared ticks are 07:00–11:30 Pacific. Jole's window closes before
// the final four shared ticks, but its daily allocation is exhausted earlier.
const ticks = [0, 30, 60, 90].map(offset => ({ offset, scope: 'jole' }))
  .concat(Array.from({ length: 10 }, (_, index) =>
    ({ offset: 120 + index * 30, scope: index < 6 ? 'shared' : 'scalelab' })));

function clock(offset) {
  const total = 5 * 60 + offset;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function simulate({ paceSeconds, startupSeconds = 480, providerSeconds = 60 }) {
  const bySender = new Map();
  const byClient = new Map();
  let global = 0;
  const rows = [];
  for (const tick of ticks) {
    const eligible = senders.filter(sender => sender.sendEligible
      && (tick.scope === 'shared' || sender.clientId === tick.scope));
    const plan = buildSendRunPlan({ senders: eligible, capacity,
      sentTodayBySender: bySender, sentTodayByClient: byClient,
      sentTodayGlobal: global, perInboxRunCap: 6 });
    const lanes = plan.lanes.filter(lane => lane.budget > 0).map(lane => ({
      senderId: lane.senderId, clientId: lane.clientId, planned: lane.budget,
      durationSeconds: lane.budget * providerSeconds + (lane.budget - 1) * paceSeconds,
    }));
    const durationSeconds = startupSeconds + Math.max(0, ...lanes.map(lane => lane.durationSeconds));
    const deadlineReached = durationSeconds >= 25 * 60;
    const nextTickAvailable = durationSeconds < 30 * 60;
    // This model must refuse to count a partial plan as completed.
    assert.equal(deadlineReached, false, `deadline at ${clock(tick.offset)} for ${paceSeconds}s pacing`);
    assert.equal(nextTickAvailable, true, `next tick occupied at ${clock(tick.offset)}`);
    for (const lane of lanes) {
      bySender.set(lane.senderId, (bySender.get(lane.senderId) || 0) + lane.planned);
      byClient.set(lane.clientId, (byClient.get(lane.clientId) || 0) + lane.planned);
      global += lane.planned;
    }
    rows.push({ tickPacific: clock(tick.offset), scope: tick.scope,
      planned: plan.totalPlanned, senderAllocations: Object.fromEntries(lanes.map(lane => [lane.senderId, lane.planned])),
      laneDurationsSeconds: Object.fromEntries(lanes.map(lane => [lane.senderId, lane.durationSeconds])),
      durationSeconds, completed: plan.totalPlanned, unused: 0,
      deadlineReached, nextTickAvailable });
  }
  assert.ok((byClient.get('scalelab') || 0) <= 185);
  assert.ok((byClient.get('jole') || 0) <= 60);
  assert.ok(global <= 245);
  for (const sender of senders) assert.ok((bySender.get(sender.id) || 0) <= sender.dailyLimit);
  return { paceSeconds, assumptions: { startupSeconds, providerSeconds },
    ticks: rows, totals: { scalelab: byClient.get('scalelab') || 0,
      jole: byClient.get('jole') || 0, combined: global,
      maxDurationSeconds: Math.max(...rows.map(row => row.durationSeconds)),
      deadlineTerminations: rows.filter(row => row.deadlineReached).length,
      skippedNextTicks: rows.filter(row => !row.nextTickAvailable).length } };
}

if (require.main === module) {
  for (const paceSeconds of [30, 60, 90]) console.log(JSON.stringify(simulate({ paceSeconds })));
}
module.exports = { simulate };
