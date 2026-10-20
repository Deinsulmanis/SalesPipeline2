'use strict';

const { isDefinitePreDeliveryFailure } = require('./provider-delivery-error');

function preDeliveryRefusal(code, reason) {
  return Object.assign(new Error(reason || code), { code, preDeliveryRefusal: true });
}

function createSendQuotaCoordinator({ store, runId, dayKey, plan, baselines,
  scheduledTickAt = null, deadlineAt = null, now = Date.now, log = console.log }) {
  const usedBySender = new Map(plan.lanes.map(lane => [lane.senderId, 0]));
  const budgetBySender = new Map(plan.lanes.map(lane => [lane.senderId, lane.budget]));
  const senderStats = new Map(plan.lanes.map(lane => [lane.senderId, {
    senderId: lane.senderId, clientId: lane.clientId, planned: lane.budget,
    reserved: 0, attempted: 0, successful: 0, definiteFailures: 0, ambiguous: 0,
    deferred: 0, startedAt: null, finishedAt: null,
  }]));
  const totals = { planned: plan.totalPlanned, reserved: 0, attempted: 0,
    successful: 0, definiteFailures: 0, ambiguous: 0, deferred: 0 };
  let startedAt = null;
  let finishedAt = null;
  let deadlineReached = false;

  function remaining(senderId) {
    return Math.max(0, (budgetBySender.get(senderId) || 0) - (usedBySender.get(senderId) || 0));
  }
  function canStart(senderId) {
    if (deadlineAt && now() >= new Date(deadlineAt).getTime()) {
      deadlineReached = true;
      return false;
    }
    return remaining(senderId) > 0;
  }
  function markDeferred(senderId) {
    totals.deferred++;
    const stats = senderStats.get(senderId);
    if (stats) stats.deferred++;
  }
  async function start() {
    await store.beginRun({ runId, dayKey, scheduledTickAt, deadlineAt, plan, baselines });
    startedAt = new Date(now()).toISOString();
    log(JSON.stringify({ event: 'send_run_started', runId, scheduledTickAt,
      actualStart: startedAt, deadlineAt, totalPlanned: plan.totalPlanned,
      lanes: plan.lanes.map(lane => ({ senderId: lane.senderId, clientId: lane.clientId, budget: lane.budget })) }));
  }
  async function execute({ actionId, clientId, senderId, run }) {
    const stats = senderStats.get(senderId);
    if (!stats || stats.clientId !== clientId) throw preDeliveryRefusal('quota_client_mismatch', 'sender does not belong to client');
    if (!canStart(senderId)) throw preDeliveryRefusal(deadlineReached ? 'run_deadline_reached' : 'quota_lane_exhausted',
      deadlineReached ? 'run deadline reached' : 'sender plan is exhausted');
    try { await store.reserve({ actionId, runId, dayKey, clientId, senderId }); }
    catch (error) { markDeferred(senderId); throw preDeliveryRefusal(error.code || 'quota_reservation_refused', error.message); }
    usedBySender.set(senderId, (usedBySender.get(senderId) || 0) + 1);
    totals.reserved++;
    stats.reserved++;
    let attempted = false;
    try {
      const result = await run({ markProviderStart: async () => {
        if (deadlineAt && now() >= new Date(deadlineAt).getTime()) {
          deadlineReached = true;
          throw preDeliveryRefusal('run_deadline_reached', 'run deadline reached before provider dispatch');
        }
        await store.markSending(actionId);
        attempted = true;
        totals.attempted++;
        stats.attempted++;
      } });
      try { await store.markConsumed(actionId); }
      catch (error) { log(JSON.stringify({ event: 'quota_success_checkpoint_failed', runId, actionId, code: error.code || 'database_error' })); }
      totals.successful++;
      stats.successful++;
      return result;
    } catch (error) {
      if (error.code === 'durable_checkpoint_failed' && error.providerResult) {
        try { await store.markConsumed(actionId); }
        catch (checkpointError) { log(JSON.stringify({ event: 'quota_success_checkpoint_failed', runId, actionId,
          code: checkpointError.code || 'database_error' })); }
        totals.successful++;
        stats.successful++;
      } else if (!attempted || isDefinitePreDeliveryFailure(error)) {
        try {
          await store.release(actionId, { definite: attempted && isDefinitePreDeliveryFailure(error) });
          usedBySender.set(senderId, usedBySender.get(senderId) - 1);
        } catch (releaseError) {
          // A failed release remains counted in Postgres and in this lane.
          log(JSON.stringify({ event: 'quota_release_failed', runId, actionId,
            code: releaseError.code || 'database_error' }));
        }
        if (attempted) { totals.definiteFailures++; stats.definiteFailures++; }
        else markDeferred(senderId);
      } else {
        try { await store.markAmbiguous(actionId); }
        catch (markError) { log(JSON.stringify({ event: 'quota_ambiguous_checkpoint_failed', runId, actionId,
          code: markError.code || 'database_error' })); }
        totals.ambiguous++;
        stats.ambiguous++;
      }
      throw error;
    }
  }
  function laneStarted(senderId) {
    const stats = senderStats.get(senderId);
    if (stats && !stats.startedAt) stats.startedAt = new Date(now()).toISOString();
  }
  function laneFinished(senderId) {
    const stats = senderStats.get(senderId);
    if (stats) stats.finishedAt = new Date(now()).toISOString();
  }
  async function finish(terminationReason = 'complete') {
    await store.finishRun(runId);
    finishedAt = new Date(now()).toISOString();
    const senders = [...senderStats.values()].map(stats => ({
      ...stats, durationMs: stats.startedAt && stats.finishedAt
        ? Date.parse(stats.finishedAt) - Date.parse(stats.startedAt) : 0,
    }));
    const clients = {};
    for (const stats of senders) {
      const row = clients[stats.clientId] || { planned: 0, successful: 0 };
      row.planned += stats.planned;
      row.successful += stats.successful;
      clients[stats.clientId] = row;
    }
    const summary = { event: 'send_run_finished', runId, scheduledTickAt,
      actualStart: startedAt, finish: finishedAt,
      durationMs: startedAt ? Date.parse(finishedAt) - Date.parse(startedAt) : 0,
      ...totals, unusedBudget: Math.max(0, totals.planned - [...usedBySender.values()].reduce((a, b) => a + b, 0)),
      deadlineReached, terminationReason: deadlineReached ? 'run_deadline_reached' : terminationReason,
      senders, clients };
    log(JSON.stringify(summary));
    return summary;
  }
  return { start, execute, canStart, remaining, markDeferred, laneStarted, laneFinished, finish,
    get deadlineReached() { return deadlineReached; },
    get runId() { return runId; } };
}

module.exports = { createSendQuotaCoordinator, preDeliveryRefusal };
