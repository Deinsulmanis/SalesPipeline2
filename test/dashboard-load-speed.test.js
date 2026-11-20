'use strict';

// Dashboard load speed without changing any result: each faster path is checked
// against the code it replaced.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { calendarDay } = require('../integrations/day-key');
const { buildCampaignVersionIndex, latestSendAttribution } = require('../integrations/campaign-versions');
const { createOutreachCache } = require('../integrations/outreach-cache');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// ── Calendar days: same string as toLocaleDateString, without a formatter per call ──

test('calendarDay returns exactly what toLocaleDateString returned, every hour for two years', () => {
  const zones = ['America/Vancouver', 'America/Chicago', 'UTC'];
  const start = Date.UTC(2025, 0, 1);
  const end = Date.UTC(2027, 0, 1);
  for (const timeZone of zones) {
    for (let at = start; at < end; at += 3600 * 1000) {
      const iso = new Date(at).toISOString();
      assert.equal(calendarDay(iso, timeZone), new Date(iso).toLocaleDateString('en-CA', { timeZone }), `${timeZone} ${iso}`);
    }
  }
});

test('calendarDay matches across DST changes, Date and number inputs, and invalid values', () => {
  const samples = ['2026-03-08T09:59:59Z', '2026-03-08T10:00:00Z', '2026-11-01T08:59:59Z', '2026-11-01T09:00:00Z',
    '2026-11-19T07:59:59.999Z', '2026-11-19T08:00:00Z', 0, 1795100000000, new Date('2026-11-18T23:30:00-08:00')];
  for (const value of samples) {
    assert.equal(calendarDay(value, 'America/Vancouver'), new Date(value).toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' }));
  }
  for (const bad of ['', 'not a date', undefined, NaN]) {
    assert.equal(calendarDay(bad, 'America/Vancouver'), new Date(bad).toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' }));
  }
  assert.equal(calendarDay(null, 'America/Vancouver'), new Date(null).toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' }));
});

// ── Campaign version index: same attribution per lead, linear time ──

function referenceIndex(leads, activities) {
  const byLeadId = new Map();
  for (const lead of leads) {
    const mine = activities.filter(row => row.sourceLeadId === lead.id || row.leadId === `CE-${lead.id}`);
    byLeadId.set(lead.id, latestSendAttribution(mine));
  }
  return byLeadId;
}

function randomData(seed, leadCount, rowCount) {
  let state = seed;
  const rand = n => { state = (state * 1103515245 + 12345) % 2147483648; return state % n; };
  const types = ['initial_email_sent', 'follow_up_sent', 'booking_link_sent', 'sequence_step_sent', 'lead_queued', 'ordinary_send_reserved', 'email_bounced'];
  const leads = Array.from({ length: leadCount }, (_, i) => ({ id: String(100 + i) }));
  const activities = Array.from({ length: rowCount }, (_, j) => {
    const lead = leads[rand(leadCount)].id;
    const other = leads[rand(leadCount)].id;
    const shape = rand(5);
    return {
      eventId: `e${j}`,
      // Some rows carry only one key, some both, some keys that point at
      // different leads, and some carry none.
      sourceLeadId: shape === 0 ? undefined : shape === 1 ? '' : lead,
      leadId: shape === 2 ? `CE-${other}` : shape === 3 ? undefined : `CE-${lead}`,
      eventType: types[rand(types.length)],
      // Few distinct timestamps, so ties are common and order must be preserved.
      occurredAt: new Date(Date.UTC(2026, 10, 1) + rand(6) * 3600 * 1000).toISOString(),
      metadata: JSON.stringify({ campaignVersion: `v${rand(4)}`, sequenceStep: rand(3) + 1, gmailMessageId: `m${j}` }),
    };
  });
  return { leads, activities };
}

test('the campaign version index gives every lead the same attribution as the per-lead scan', () => {
  for (const seed of [1, 7, 42, 2026]) {
    const { leads, activities } = randomData(seed, 60, 900);
    assert.deepEqual(buildCampaignVersionIndex(leads, activities), referenceIndex(leads, activities), `seed ${seed}`);
  }
  // A lead with no id matches rows that have no key, exactly as before.
  const odd = [{ id: undefined }, { id: '' }];
  const { activities } = randomData(5, 10, 200);
  assert.deepEqual(buildCampaignVersionIndex(odd, activities), referenceIndex(odd, activities));
  assert.deepEqual(buildCampaignVersionIndex([], activities), new Map());
});

test('the campaign version index scales with leads + rows, not leads x rows', () => {
  const { leads, activities } = randomData(9, 4800, 25000);
  const startedAt = process.hrtime.bigint();
  buildCampaignVersionIndex(leads, activities);
  const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
  assert.ok(ms < 1000, `production-sized index took ${ms.toFixed(0)}ms`);
});

// ── Snapshot cache: refresh-ahead never serves anything older than the TTL ──

function clockedCache({ fail = false } = {}) {
  let clock = 0;
  let loads = 0;
  const errors = [];
  const resolvers = [];
  const cache = createOutreachCache({
    ttlMs: 30000,
    refreshAheadMs: 20000,
    now: () => clock,
    onBackgroundError: error => errors.push(error.message),
    load: () => new Promise((resolve, reject) => {
      loads += 1;
      const at = clock;
      resolvers.push(() => (fail && loads > 1 ? reject(new Error('sheets down')) : resolve({ at, n: loads })));
    }),
  });
  return {
    cache, errors,
    get loads() { return loads; },
    tick: ms => { clock += ms; },
    settle: async () => { while (resolvers.length) resolvers.shift()(); await new Promise(r => setImmediate(r)); },
  };
}

test('refresh-ahead: a dashboard read late in the TTL starts the next load but is answered from the current snapshot', async () => {
  const c = clockedCache();
  const first = c.cache.get();
  await c.settle();
  assert.equal((await first).n, 1);

  c.tick(10000);
  assert.equal((await c.cache.get({ refreshAhead: true })).n, 1);
  assert.equal(c.loads, 1, 'young snapshot: no background load');

  c.tick(15000); // 25s old
  assert.equal((await c.cache.get({ refreshAhead: true })).n, 1, 'still served the in-TTL snapshot');
  assert.equal(c.loads, 2, 'and the next load started in the background');
  assert.equal((await c.cache.get({ refreshAhead: true })).n, 1);
  assert.equal(c.loads, 2, 'only one background load at a time');

  await c.settle();
  assert.equal(c.cache.peek().n, 2, 'the background load replaced the snapshot');
});

test('refresh-ahead: callers that do not opt in never start a background load', async () => {
  const c = clockedCache();
  const first = c.cache.get();
  await c.settle();
  await first;
  c.tick(25000);
  await c.cache.get();
  assert.equal(c.loads, 1);
});

test('refresh-ahead: past the TTL every caller waits for a fresh load, never the old snapshot', async () => {
  const c = clockedCache();
  const first = c.cache.get();
  await c.settle();
  await first;
  c.tick(31000);
  const pending = c.cache.get({ refreshAhead: true });
  let settled = false;
  pending.then(() => { settled = true; });
  await new Promise(r => setImmediate(r));
  assert.equal(settled, false, 'no stale answer past the TTL');
  await c.settle();
  assert.equal((await pending).n, 2);
});

test('refresh-ahead: a write during a background load still wins, and a failed background load keeps the snapshot', async () => {
  const c = clockedCache();
  const first = c.cache.get();
  await c.settle();
  await first;
  c.tick(25000);
  await c.cache.get({ refreshAhead: true });
  assert.equal(c.loads, 2);
  c.cache.invalidate();
  await c.settle();
  assert.equal(c.cache.peek(), null, 'a load started before a write cannot repopulate the cache');

  const failing = clockedCache({ fail: true });
  const one = failing.cache.get();
  await failing.settle();
  await one;
  failing.tick(25000);
  await failing.cache.get({ refreshAhead: true });
  await failing.settle();
  assert.equal(failing.cache.peek().n, 1, 'the snapshot survives a failed background load');
  assert.deepEqual(failing.errors, ['sheets down'], 'and the failure is reported, not thrown');
});

test('refresh-ahead must be shorter than the TTL', () => {
  assert.throws(() => createOutreachCache({ load: () => ({}), ttlMs: 30000, refreshAheadMs: 30000 }));
});

// ── Wiring: only read-only dashboard views opt in ──

test('only read-only dashboard routes use the display read; decision paths keep the plain read', () => {
  assert.match(server, /const OUTREACH_REFRESH_AHEAD_MS = 20000;/);
  assert.match(server, /async function getOutreachDatasetForDisplay\(query = \{\}\) \{\s*if \(query\.refresh === '1'\) return outreachDatasetCache\.get\(\{ force: true \}\);\s*return outreachDatasetCache\.get\(\{ refreshAhead: true \}\);/);
  const routeOf = needle => {
    const start = server.indexOf(needle);
    assert.ok(start >= 0, needle);
    return server.slice(start, server.indexOf('\n});', start));
  };
  for (const route of ["app.get('/api/coldemail', requireAuth", "app.get('/api/coldemail/funnel'", "app.get('/api/crm/health'",
    "app.get('/api/proposalOpens'", "app.get('/api/archive',", "app.get('/api/coldemail/stats'",
    "app.get('/api/coldemail/summary'", "app.get('/api/coldemail/replies'"]) {
    assert.match(routeOf(route), /getOutreachDatasetForDisplay\(/, route);
  }
  // Nothing that writes, queues, sends or decides uses it.
  for (const route of ["app.post('/api/coldemail/queue'", "app.post('/api/coldemail/:id/promote'", "app.post('/api/ops/send-recovery'",
    "app.post('/api/integrations/gmail-inboxes/:id/pause'", "app.post('/api/archive/cards/:id/restore'"]) {
    assert.doesNotMatch(routeOf(route), /getOutreachDatasetForDisplay|refreshAhead/, route);
  }
  const uses = server.match(/getOutreachDatasetForDisplay\(/g) || [];
  assert.equal(uses.length, 9, 'eight routes plus the definition');
});
