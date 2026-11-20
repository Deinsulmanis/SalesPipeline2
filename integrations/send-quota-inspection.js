'use strict';

// Operator diagnostics only. No quota reservation, release, takeover, schema
// change or provider capability is available through this read-only snapshot.
async function inspectSendQuota(pool, dayKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) throw new Error('invalid quota day');
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5s'");
    const buckets = await client.query(`SELECT scope_key, day_key, limit_count, used_count, updated_at
      FROM send_control.quota_buckets WHERE day_key=$1::date AND scope_key LIKE 'day:%' ORDER BY scope_key`, [dayKey]);
    const activeRuns = await client.query(`SELECT run_id, day_key, scheduled_tick_at, deadline_at, started_at
      FROM send_control.quota_runs WHERE status='active' ORDER BY started_at`);
    const laneOwners = await client.query(`SELECT sender_id, run_id, acquired_at
      FROM send_control.quota_lane_owners ORDER BY sender_id`);
    const unresolved = await client.query(`SELECT action_id, run_id, day_key, client_id, sender_id, status,
      provider_attempt_started_at, updated_at FROM send_control.quota_actions
      WHERE status IN ('reserved','sending','ambiguous') ORDER BY updated_at`);
    await client.query('COMMIT');
    return { dayKey, buckets: buckets.rows, activeRuns: activeRuns.rows,
      laneOwners: laneOwners.rows, unresolved: unresolved.rows, readOnly: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

function assertSendQuotaIdle(snapshot) {
  if (!snapshot || snapshot.readOnly !== true
    || !['activeRuns', 'laneOwners', 'unresolved'].every(key => Array.isArray(snapshot[key]))) {
    throw new Error('Send quota state is unavailable; sender assignments are unchanged');
  }
  if (snapshot.activeRuns.length || snapshot.laneOwners.length
    || snapshot.unresolved.some(action => action.status !== 'ambiguous')) {
    throw new Error('A durable send run, lane or provider attempt is active; sender assignments are unchanged');
  }
}

module.exports = { inspectSendQuota, assertSendQuotaIdle };
