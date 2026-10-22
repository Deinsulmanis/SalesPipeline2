'use strict';

const { keys } = require('../integrations/send-quota-store');

function error(code) { return Object.assign(new Error(code), { code }); }

// An asynchronous serialized transaction double. Tests launch requests at the
// same time; each operation yields before acquiring its lock.
function createMemorySendQuotaStore() {
  const buckets = new Map();
  const runs = new Map();
  const owners = new Map();
  const actions = new Map();
  let tail = Promise.resolve();
  function atomic(work) {
    const current = tail.then(async () => { await Promise.resolve(); return work(); });
    tail = current.catch(() => {});
    return current;
  }
  function putBucket(key, limit, baseline = 0) {
    const row = buckets.get(key);
    buckets.set(key, { limit: row ? Math.min(row.limit, limit) : limit,
      used: row ? Math.max(row.used, baseline) : baseline });
  }
  return {
    beginRun({ runId, dayKey, plan, baselines }) {
      return atomic(() => {
        if (runs.has(runId)) throw error('quota_run_exists');
        for (const lane of plan.lanes.filter(item => item.budget > 0)) {
          if (owners.has(lane.senderId)) throw error('quota_lane_owned');
        }
        runs.set(runId, { dayKey, active: true });
        putBucket(`day:global:${dayKey}`, plan.globalDailyLimit, baselines.global);
        putBucket(`run:global:${runId}`, plan.globalRunLimit);
        for (const [clientId, cap] of Object.entries(plan.clientLimits)) {
          putBucket(`day:client:${clientId}:${dayKey}`, cap.daily, baselines.clients.get(clientId) || 0);
          putBucket(`run:client:${clientId}:${runId}`, cap.perRun);
        }
        for (const lane of plan.lanes) {
          putBucket(`day:sender:${lane.senderId}:${dayKey}`, lane.dailyLimit,
            baselines.senders.get(lane.senderId) || 0);
          putBucket(`run:sender:${lane.senderId}:${runId}`, lane.budget);
          if (lane.budget > 0) owners.set(lane.senderId, runId);
        }
      });
    },
    reserve({ actionId, runId, dayKey, clientId, senderId }) {
      return atomic(() => {
        if (!runs.get(runId)?.active || owners.get(senderId) !== runId) throw error('quota_lane_unowned');
        if (actions.has(actionId) && actions.get(actionId).status !== 'released') throw error('quota_action_held');
        const scope = keys({ dayKey, runId, clientId, senderId });
        if (scope.some(key => !buckets.has(key))) throw error('quota_schema_missing');
        if (scope.some(key => buckets.get(key).used >= buckets.get(key).limit)) throw error('quota_exhausted');
        for (const key of scope) buckets.get(key).used++;
        actions.set(actionId, { actionId, runId, dayKey, clientId, senderId, status: 'reserved' });
      });
    },
    markSending: id => atomic(() => { const row = actions.get(id);
      if (row?.status !== 'reserved') throw error('quota_bad_transition'); row.status = 'sending'; }),
    markConsumed: id => atomic(() => { const row = actions.get(id);
      if (!['reserved', 'sending'].includes(row?.status)) throw error('quota_bad_transition'); row.status = 'consumed'; }),
    markAmbiguous: id => atomic(() => { const row = actions.get(id);
      if (!['reserved', 'sending'].includes(row?.status)) throw error('quota_bad_transition'); row.status = 'ambiguous'; }),
    release: (id, { definite = false } = {}) => atomic(() => {
      const row = actions.get(id);
      if (!['reserved', 'sending'].includes(row?.status) || (row.status === 'sending' && !definite)) {
        throw error('quota_release_ambiguous');
      }
      for (const key of keys(row)) buckets.get(key).used--;
      row.status = 'released';
    }),
    finishRun: runId => atomic(() => { const run = runs.get(runId);
      if (!run?.active) throw error('quota_run_inactive'); run.active = false;
      for (const [senderId, owner] of owners) if (owner === runId) owners.delete(senderId);
    }),
    snapshot: () => ({ buckets: new Map([...buckets].map(([k, v]) => [k, { ...v }])),
      owners: new Map(owners), actions: new Map([...actions].map(([k, v]) => [k, { ...v }])) }),
  };
}

module.exports = { createMemorySendQuotaStore };
