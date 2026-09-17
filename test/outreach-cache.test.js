'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOutreachCache } = require('../integrations/outreach-cache');

test('concurrent callers share one in-flight load', async () => {
  let loads = 0;
  const cache = createOutreachCache({
    ttlMs: 30_000,
    load: async () => {
      loads += 1;
      await new Promise(resolve => setTimeout(resolve, 20));
      return { at: 1, value: 'one' };
    },
  });
  const [a, b] = await Promise.all([cache.get(), cache.get()]);
  assert.equal(loads, 1);
  assert.equal(a.value, 'one');
  assert.equal(b.value, 'one');
  assert.equal(cache.peek().value, 'one');
});

test('an in-flight stale load cannot repopulate the cache after invalidation', async () => {
  const resolvers = [];
  let loads = 0;
  const cache = createOutreachCache({
    ttlMs: 30_000,
    load: () => new Promise(resolve => {
      loads += 1;
      resolvers.push(resolve);
    }),
  });

  const stale = cache.get();
  assert.equal(loads, 1);
  cache.invalidate();
  assert.equal(cache.peek(), null);

  const fresh = cache.get();
  assert.equal(loads, 2);

  resolvers[0]({ at: 1, value: 'stale' });
  assert.equal((await stale).value, 'stale');
  assert.equal(cache.peek(), null, 'stale completion must not repopulate after invalidation');

  resolvers[1]({ at: 2, value: 'fresh' });
  assert.equal((await fresh).value, 'fresh');
  assert.equal(cache.peek().value, 'fresh');
});

test('TTL hits reuse the snapshot until invalidation', async () => {
  let now = 1000;
  let loads = 0;
  const cache = createOutreachCache({
    ttlMs: 30,
    now: () => now,
    load: async () => {
      loads += 1;
      return { at: now, value: loads };
    },
  });
  await cache.get();
  now += 10;
  await cache.get();
  assert.equal(loads, 1);
  now += 30;
  await cache.get({ force: true });
  assert.equal(loads, 2);
  cache.invalidate();
  await cache.get();
  assert.equal(loads, 3);
});
