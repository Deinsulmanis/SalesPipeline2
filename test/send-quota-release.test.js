'use strict';

// Release of send runs that died mid-run (2026-11-25: deploys stopped the
// 11:00 and 11:30 runs; their lane owners blocked every run on 11-26 with
// "sender deniels is owned by another run").

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { releaseExpiredQuotaRuns } = require('../integrations/send-quota-release');
const { keys } = require('../integrations/send-quota-store');

// Minimal stand-in for the send_control schema: enough SQL to drive the release.
function fakePool(state) {
  const statements = [];
  let snapshot = null;
  const clone = () => JSON.parse(JSON.stringify(state));
  const client = {
    async query(sql, params = []) {
      const text = sql.replace(/\s+/g, ' ').trim();
      statements.push(text);
      if (text === 'BEGIN') { snapshot = clone(); return { rows: [], rowCount: 0 }; }
      if (text === 'COMMIT') { snapshot = null; return { rows: [], rowCount: 0 }; }
      if (text === 'ROLLBACK') { if (snapshot) Object.assign(state, snapshot); return { rows: [], rowCount: 0 }; }
      if (/^SET LOCAL|^SAVEPOINT|^RELEASE SAVEPOINT|^ROLLBACK TO SAVEPOINT/.test(text)) return { rows: [], rowCount: 0 };
      if (text.startsWith('SELECT run_id, day_key FROM send_control.quota_runs')) {
        const rows = state.runs.filter(run => run.status === 'active' && run.deadline_at && run.deadline_at < params[0])
          .map(run => ({ run_id: run.run_id, day_key: run.day_key }));
        return { rows, rowCount: rows.length };
      }
      if (text.startsWith('SELECT 1 FROM send_control.quota_buckets')) return { rows: [{}], rowCount: 1 };
      if (text.startsWith('SELECT run_id, day_key, deadline_at, status FROM send_control.quota_runs')) {
        const rows = state.runs.filter(run => run.run_id === params[0]);
        return { rows, rowCount: rows.length };
      }
      if (text.startsWith('SELECT action_id, client_id, sender_id, status FROM send_control.quota_actions')) {
        const rows = state.actions.filter(a => a.run_id === params[0] && ['reserved', 'sending'].includes(a.status));
        return { rows, rowCount: rows.length };
      }
      if (text.startsWith('UPDATE send_control.quota_buckets SET used_count=used_count-1')) {
        let count = 0;
        for (const bucket of state.buckets) {
          if (params[0].includes(bucket.scope_key) && bucket.used_count > 0) { bucket.used_count--; count++; }
        }
        return { rows: [], rowCount: count };
      }
      if (text.startsWith('UPDATE send_control.quota_actions SET status=')) {
        const status = text.match(/status='(\w+)'/)[1];
        const action = state.actions.find(a => a.action_id === params[0]);
        action.status = status;
        return { rows: [], rowCount: 1 };
      }
      if (text.startsWith('DELETE FROM send_control.quota_lane_owners')) {
        const removed = state.owners.filter(owner => owner.run_id === params[0]);
        state.owners = state.owners.filter(owner => owner.run_id !== params[0]);
        return { rows: removed.map(owner => ({ sender_id: owner.sender_id })), rowCount: removed.length };
      }
      if (text.startsWith('UPDATE send_control.quota_runs SET status=\'complete\'')) {
        state.runs.find(run => run.run_id === params[0]).status = 'complete';
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
    release() {},
  };
  return { pool: { connect: async () => client }, statements };
}

const DAY = '2026-11-25';
const bucketsFor = (runId, senderId, used = 1) => keys({ dayKey: DAY, runId, clientId: 'scalelab', senderId })
  .map(scope_key => ({ scope_key, used_count: used }));

function stateWithDeadRun() {
  return {
    runs: [
      { run_id: 'dead-1100', day_key: DAY, deadline_at: '2026-11-25T19:25:00.007Z', status: 'active' },
      // Still inside its window: an old container may be sending right now.
      { run_id: 'live-now', day_key: '2026-11-26', deadline_at: '2026-11-26T17:55:00.000Z', status: 'active' },
      { run_id: 'done-earlier', day_key: DAY, deadline_at: '2026-11-25T15:25:00.000Z', status: 'complete' },
    ],
    owners: ['deniels', 'primary', 'outreachplateau_zoe'].map(sender_id => ({ sender_id, run_id: 'dead-1100' }))
      .concat([{ sender_id: 'outreachplateau_dave', run_id: 'live-now' }]),
    actions: [
      { action_id: 'a-reserved', run_id: 'dead-1100', client_id: 'scalelab', sender_id: 'deniels', status: 'reserved' },
      { action_id: 'a-sending', run_id: 'dead-1100', client_id: 'scalelab', sender_id: 'primary', status: 'sending' },
      { action_id: 'a-consumed', run_id: 'dead-1100', client_id: 'scalelab', sender_id: 'primary', status: 'consumed' },
    ],
    buckets: [...bucketsFor('dead-1100', 'deniels', 1)],
  };
}

const NOW = new Date('2026-11-26T17:40:00.000Z');

test('a dead run past its deadline frees its senders; a live run and finished runs are untouched', async () => {
  const state = stateWithDeadRun();
  const { pool } = fakePool(state);
  const result = await releaseExpiredQuotaRuns(pool, { cutoff: '2026-11-26T08:00:00.000Z', now: NOW });
  assert.deepEqual(result.released, [{ runId: 'dead-1100', dayKey: DAY, deadlineAt: '2026-11-25T19:25:00.007Z',
    senders: ['deniels', 'outreachplateau_zoe', 'primary'], releasedReserved: 1, markedAmbiguous: 1 }]);
  assert.deepEqual(state.owners, [{ sender_id: 'outreachplateau_dave', run_id: 'live-now' }]);
  assert.equal(state.runs.find(r => r.run_id === 'dead-1100').status, 'complete');
  assert.equal(state.runs.find(r => r.run_id === 'live-now').status, 'active');
});

test('a hold that never reached Gmail is released; one that may have reached it stays counted as ambiguous', async () => {
  const state = stateWithDeadRun();
  await releaseExpiredQuotaRuns(fakePool(state).pool, { cutoff: '2026-11-26T08:00:00.000Z', now: NOW });
  const status = id => state.actions.find(a => a.action_id === id).status;
  assert.equal(status('a-reserved'), 'released');
  assert.equal(status('a-sending'), 'ambiguous');
  assert.equal(status('a-consumed'), 'consumed');
  assert.ok(state.buckets.every(bucket => bucket.used_count === 0), 'the released hold gives back all six buckets');
});

test('inconsistent buckets keep the hold counted instead of guessing', async () => {
  const state = stateWithDeadRun();
  state.buckets = bucketsFor('dead-1100', 'deniels', 1).slice(0, 4); // two buckets missing
  await releaseExpiredQuotaRuns(fakePool(state).pool, { cutoff: '2026-11-26T08:00:00.000Z', now: NOW });
  assert.equal(state.actions.find(a => a.action_id === 'a-reserved').status, 'ambiguous');
  assert.deepEqual(state.owners.map(o => o.run_id), ['live-now'], 'the senders are still freed');
});

test('the cutoff is required, must be in the past, and a run within 2 minutes of its deadline is left alone', async () => {
  const state = stateWithDeadRun();
  await assert.rejects(releaseExpiredQuotaRuns(fakePool(state).pool, { cutoff: '', now: NOW }), /ISO timestamp/);
  await assert.rejects(releaseExpiredQuotaRuns(fakePool(state).pool, { cutoff: 'soon', now: NOW }), /ISO timestamp/);
  await assert.rejects(releaseExpiredQuotaRuns(fakePool(state).pool, { cutoff: '2026-11-26T18:00:00Z', now: NOW }), /future/);
  // A future-looking cutoff is refused; one equal to now still spares the run whose deadline just passed.
  const fresh = stateWithDeadRun();
  fresh.runs[1].deadline_at = '2026-11-26T17:39:00.000Z';
  const result = await releaseExpiredQuotaRuns(fakePool(fresh).pool, { cutoff: NOW.toISOString(), now: NOW });
  assert.deepEqual(result.released.map(r => r.runId), ['dead-1100']);
  assert.equal(fresh.runs[1].status, 'active');
});

test('nothing to release is a clean no-op', async () => {
  const state = stateWithDeadRun();
  state.runs = state.runs.filter(run => run.run_id !== 'dead-1100');
  state.owners = state.owners.filter(owner => owner.run_id !== 'dead-1100');
  const result = await releaseExpiredQuotaRuns(fakePool(state).pool, { cutoff: '2026-11-26T08:00:00.000Z', now: NOW });
  assert.deepEqual(result.released, []);
});

test('pre-deploy wiring: opt-in by one variable, after the migration check, and never blocks the deploy', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'send-quota-migrate.js'), 'utf8');
  assert.match(script, /process\.env\.SEND_QUOTA_RELEASE_EXPIRED_BEFORE/);
  assert.ok(script.indexOf("console.log('send quota migration verified") < script.indexOf('await releaseExpiredRunsIfRequested(pool)'));
  const start = script.indexOf('async function releaseExpiredRunsIfRequested');
  const fn = script.slice(start, script.indexOf('\n}\n', start) + 2);
  assert.match(fn, /if \(!cutoff\) return;/);
  assert.match(fn, /catch \(error\) \{/);
  assert.doesNotMatch(fn, /exitCode|throw /, 'a release failure is logged, not fatal');
  const release = fs.readFileSync(path.join(__dirname, '..', 'integrations', 'send-quota-release.js'), 'utf8')
    .split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(release, /gmail|sendEmail|deliver|markSending|reserve\(/i, 'release never sends or reserves');
});
