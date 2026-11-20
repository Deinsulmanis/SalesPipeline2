'use strict';

const { DEFAULT_CLIENT_ID } = require('./clients/registry');

function concurrentSenderLanesEnabled(env = process.env) {
  return env.SEND_CONCURRENT_SENDER_LANES === 'true';
}

function laneClientId(sender) {
  const id = String(sender?.clientId || '').trim();
  return id || DEFAULT_CLIENT_ID;
}

async function runSenderLanes(senders, work, { parallel = true } = {}) {
  const ids = senders.map(sender => sender.id);
  if (new Set(ids).size !== ids.length) throw new Error('a sender cannot own two lanes in one run');
  if (!parallel) {
    const results = [];
    for (const sender of senders) {
      try { results.push({ status: 'fulfilled', value: await work(sender) }); }
      catch (reason) { results.push({ status: 'rejected', reason }); }
    }
    return results;
  }
  return Promise.allSettled(senders.map(work));
}

// Shared Pacific windows used to walk every inbox in registry order. ScaleLab's
// lanes are registered first and, while serial, consume the 25-minute run
// deadline before Jole's lanes start. Each client keeps its own lane order and
// the existing concurrency flag. Different clients start together, so a long
// default-client lane cannot spend another client's window budget.
async function runClientOverlappedSenderLanes(senders, work, { parallel = false } = {}) {
  const groups = [];
  const indexByClient = new Map();
  for (const sender of senders) {
    const clientId = laneClientId(sender);
    if (!indexByClient.has(clientId)) {
      indexByClient.set(clientId, groups.length);
      groups.push([]);
    }
    groups[indexByClient.get(clientId)].push(sender);
  }
  if (groups.length < 2) return runSenderLanes(senders, work, { parallel });
  const settled = await Promise.all(groups.map(group => runSenderLanes(group, work, { parallel })));
  return settled.flat();
}

module.exports = {
  runSenderLanes, concurrentSenderLanesEnabled, laneClientId, runClientOverlappedSenderLanes,
};
