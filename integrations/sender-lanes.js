'use strict';

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

module.exports = { runSenderLanes };
