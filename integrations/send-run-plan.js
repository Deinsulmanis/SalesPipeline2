'use strict';

// A run plan is immutable once published to the quota store. Allocate from
// the smallest (inbox) limits upward; no worker can borrow another lane's
// allocation during a run.
function buildSendRunPlan({ senders, capacity, sentTodayBySender, sentTodayByClient,
  sentTodayGlobal, perInboxRunCap }) {
  const dailyRemaining = Math.max(0, capacity.globalDailyLimit - sentTodayGlobal);
  let globalDaily = dailyRemaining;
  let globalRun = capacity.globalPerRunLimit;
  const clients = new Map(Object.entries(capacity.clientLimits).map(([id, cap]) => [id, {
    daily: Math.max(0, cap.daily - (sentTodayByClient.get(id) || 0)),
    run: cap.perRun,
  }]));
  const lanes = [];
  for (const sender of senders.filter(item => item.sendEligible).sort((a, b) => a.id.localeCompare(b.id))) {
    const clientId = sender.clientId || 'scalelab';
    const client = clients.get(clientId);
    if (!client) throw new Error(`No client allocation for sender ${sender.id}`);
    const daily = Math.max(0, sender.dailyLimit - (sentTodayBySender.get(sender.id) || 0));
    const run = Math.min(perInboxRunCap, sender.perRunLimit);
    const budget = Math.max(0, Math.min(daily, run, client.daily, client.run, globalDaily, globalRun));
    lanes.push({ senderId: sender.id, clientId, budget, dailyLimit: sender.dailyLimit,
      runLimit: run });
    client.daily -= budget;
    client.run -= budget;
    globalDaily -= budget;
    globalRun -= budget;
  }
  return {
    globalDailyLimit: capacity.globalDailyLimit,
    globalRunLimit: capacity.globalPerRunLimit,
    clientLimits: capacity.clientLimits,
    lanes,
    totalPlanned: lanes.reduce((sum, lane) => sum + lane.budget, 0),
  };
}

module.exports = { buildSendRunPlan };
