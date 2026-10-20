'use strict';

// One queue per Gmail inbox, shared by ordinary cold, stage and warm paths.
// The delay starts after the previous attempt completes, matching the former
// cold-loop behavior without stalling an unrelated sender.
function createSenderPacer({ minDelayMs = 30000, maxDelayMs = 90000,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  random = Math.random, now = Date.now } = {}) {
  if (minDelayMs < 0 || maxDelayMs < minDelayMs) throw new Error('invalid sender pacing range');
  const tails = new Map();
  const completed = new Set();
  const history = new Map();
  async function run(senderId, task) {
    if (!senderId) throw new Error('sender id is required for pacing');
    const prior = tails.get(senderId) || Promise.resolve();
    let release;
    const next = new Promise(resolve => { release = resolve; });
    tails.set(senderId, next);
    await prior;
    try {
      if (completed.has(senderId)) {
        const delay = minDelayMs + Math.floor(random() * (maxDelayMs - minDelayMs + 1));
        await sleep(delay);
      }
      const startedAt = now();
      history.set(senderId, [...(history.get(senderId) || []), startedAt]);
      return await task();
    } finally {
      completed.add(senderId);
      release();
    }
  }
  return { run, history: senderId => [...(history.get(senderId) || [])] };
}

module.exports = { createSenderPacer };
