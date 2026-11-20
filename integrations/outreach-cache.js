'use strict';

// A snapshot cache with one load in flight at a time.
//
// Freshness rules (unchanged by refresh-ahead):
//   - Within ttlMs a snapshot is served as is; past it, callers wait for a
//     fresh load. Nothing older than ttlMs is ever served.
//   - invalidate() drops the snapshot at once (every write this process makes
//     calls it), so nothing older than the latest write is served again.
//
// Refresh-ahead: a caller that passes { refreshAhead: true } (the read-only
// dashboard views) and is served a snapshot older than refreshAheadMs starts
// the next load in the background. The caller still gets the in-TTL snapshot;
// whoever arrives after the TTL then joins a load that is already under way,
// or finds the new snapshot ready, instead of starting a full rebuild.
function createOutreachCache({ load, ttlMs, refreshAheadMs = null, now = Date.now, onBackgroundError = null } = {}) {
  if (typeof load !== 'function') throw new Error('createOutreachCache requires a load function');
  if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new Error('createOutreachCache requires a numeric ttlMs');
  if (refreshAheadMs !== null && (!Number.isFinite(refreshAheadMs) || refreshAheadMs < 0 || refreshAheadMs >= ttlMs)) {
    throw new Error('createOutreachCache refreshAheadMs must be a number below ttlMs');
  }

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

  function startLoad() {
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

  function get({ force = false, refreshAhead = false } = {}) {
    if (!force && cache && now() - cache.at < ttlMs) {
      if (refreshAhead && refreshAheadMs !== null && !loadPromise && now() - cache.at >= refreshAheadMs) {
        // A failed background load leaves the current snapshot in place; the
        // TTL still bounds it and the next caller simply loads again.
        startLoad().catch(error => { if (onBackgroundError) onBackgroundError(error); });
      }
      return Promise.resolve(cache);
    }
    if (!force && loadPromise) return loadPromise;
    return startLoad();
  }

  return {
    get,
    invalidate,
    peek,
    get generation() { return generation; },
  };
}

module.exports = { createOutreachCache };
