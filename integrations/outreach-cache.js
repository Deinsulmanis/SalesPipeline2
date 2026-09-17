'use strict';

function createOutreachCache({ load, ttlMs, now = Date.now } = {}) {
  if (typeof load !== 'function') throw new Error('createOutreachCache requires a load function');
  if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new Error('createOutreachCache requires a numeric ttlMs');

  let cache = null;
  let loadPromise = null;
  let generation = 0;

  function peek() {
    return cache;
  }

  function invalidate() {
    cache = null;
    generation += 1;
    loadPromise = null;
  }

  function get({ force = false } = {}) {
    if (!force && cache && now() - cache.at < ttlMs) return Promise.resolve(cache);
    if (!force && loadPromise) return loadPromise;
    const startedGeneration = generation;
    const pending = Promise.resolve(load()).then(dataset => {
      if (startedGeneration === generation) cache = dataset;
      return dataset;
    }).finally(() => {
      if (loadPromise === pending) loadPromise = null;
    });
    loadPromise = pending;
    return pending;
  }

  return {
    get,
    invalidate,
    peek,
    get generation() { return generation; },
  };
}

module.exports = { createOutreachCache };
