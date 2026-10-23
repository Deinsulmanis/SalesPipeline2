'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const MIGRATION_FILE = path.join(__dirname, '..', 'db', 'migrations', '20261020000000_send_quota_reservations.sql');
const BUCKET = 'send_control.quota_buckets';
const ACTION = 'send_control.quota_actions';
const dayString = value => value instanceof Date
  ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
  : String(value).slice(0, 10);

function keys({ dayKey, runId, clientId, senderId }) {
  return [
    `day:global:${dayKey}`, `day:client:${clientId}:${dayKey}`, `day:sender:${senderId}:${dayKey}`,
    `run:global:${runId}`, `run:client:${clientId}:${runId}`, `run:sender:${senderId}:${runId}`,
  ];
}

function quotaError(code, message) {
  return Object.assign(new Error(message), { code });
}

function createPgSendQuotaStore({ connectionString, pool: existingPool } = {}) {
  if (!connectionString && !existingPool) throw quotaError('quota_database_unavailable', 'SEND_LOCK_DATABASE_URL is required for quota');
  const pool = existingPool || new Pool({ connectionString, max: 8,
    idleTimeoutMillis: 10000, connectionTimeoutMillis: 4000 });

  async function transaction(work) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async function bucket(client, scopeKey, dayKey, limit, baseline = 0) {
    await client.query(`INSERT INTO ${BUCKET} (scope_key, day_key, limit_count, used_count)
      VALUES ($1, $2::date, $3, $4)
      ON CONFLICT (scope_key) DO UPDATE SET
        limit_count = LEAST(${BUCKET}.limit_count, EXCLUDED.limit_count),
        used_count = GREATEST(${BUCKET}.used_count, EXCLUDED.used_count),
        updated_at = now()`, [scopeKey, dayKey, limit, baseline]);
  }

  async function lockGlobalDay(client, dayKey) {
    const key = `day:global:${dayKey}`;
    const row = await client.query(`SELECT used_count, limit_count FROM ${BUCKET}
      WHERE scope_key = $1 FOR UPDATE`, [key]);
    if (row.rowCount !== 1) throw quotaError('quota_schema_missing', 'global daily quota bucket is missing');
    return row.rows[0];
  }

  async function beginRun({ runId, dayKey, scheduledTickAt = null, deadlineAt = null,
    plan, baselines }) {
    if (!runId || !/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) throw quotaError('quota_invalid_run', 'run id and day key are required');
    if (!plan || !Array.isArray(plan.lanes)) throw quotaError('quota_invalid_plan', 'fixed sender plan is required');
    return transaction(async client => {
      await bucket(client, `day:global:${dayKey}`, dayKey, plan.globalDailyLimit, baselines.global);
      await lockGlobalDay(client, dayKey); // single serialization point for this day
      const inserted = await client.query(`INSERT INTO send_control.quota_runs
        (run_id, day_key, scheduled_tick_at, deadline_at)
        VALUES ($1, $2::date, $3, $4) ON CONFLICT DO NOTHING RETURNING run_id`,
      [runId, dayKey, scheduledTickAt, deadlineAt]);
      if (!inserted.rowCount) throw quotaError('quota_run_exists', 'run id was already initialized');
      await bucket(client, `run:global:${runId}`, dayKey, plan.globalRunLimit);
      for (const [clientId, cap] of Object.entries(plan.clientLimits)) {
        await bucket(client, `day:client:${clientId}:${dayKey}`, dayKey, cap.daily,
          baselines.clients.get(clientId) || 0);
        await bucket(client, `run:client:${clientId}:${runId}`, dayKey, cap.perRun);
      }
      for (const lane of plan.lanes) {
        await bucket(client, `day:sender:${lane.senderId}:${dayKey}`, dayKey, lane.dailyLimit,
          baselines.senders.get(lane.senderId) || 0);
        await bucket(client, `run:sender:${lane.senderId}:${runId}`, dayKey, lane.budget);
        await client.query(`INSERT INTO send_control.quota_run_lanes
          (run_id, sender_id, client_id, budget) VALUES ($1, $2, $3, $4)`,
        [runId, lane.senderId, lane.clientId, lane.budget]);
        if (lane.budget > 0) {
          const owner = await client.query(`INSERT INTO send_control.quota_lane_owners(sender_id, run_id)
            VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING sender_id`, [lane.senderId, runId]);
          if (!owner.rowCount) throw quotaError('quota_lane_owned', `sender ${lane.senderId} is owned by another run`);
        }
      }
      return { runId, planned: plan.totalPlanned };
    });
  }

  async function reserve({ actionId, runId, dayKey, clientId, senderId }) {
    if (![actionId, runId, dayKey, clientId, senderId].every(Boolean)) throw quotaError('quota_invalid_action', 'quota identity is incomplete');
    return transaction(async client => {
      await lockGlobalDay(client, dayKey);
      const run = await client.query(`SELECT status, deadline_at FROM send_control.quota_runs
        WHERE run_id=$1 AND day_key=$2::date`, [runId, dayKey]);
      if (run.rows[0]?.status !== 'active') throw quotaError('quota_run_inactive', 'quota run is inactive');
      if (run.rows[0].deadline_at && Date.now() >= new Date(run.rows[0].deadline_at).getTime()) {
        throw quotaError('run_deadline_reached', 'run deadline reached');
      }
      const owner = await client.query(`SELECT 1 FROM send_control.quota_lane_owners
        WHERE sender_id=$1 AND run_id=$2`, [senderId, runId]);
      if (!owner.rowCount) throw quotaError('quota_lane_unowned', 'sender lane is not owned by this run');
      const lane = await client.query(`SELECT client_id FROM send_control.quota_run_lanes
        WHERE sender_id=$1 AND run_id=$2`, [senderId, runId]);
      if (lane.rows[0]?.client_id !== clientId) throw quotaError('quota_client_mismatch', 'sender lane belongs to another client');
      const prior = await client.query(`SELECT status FROM ${ACTION} WHERE action_id=$1 FOR UPDATE`, [actionId]);
      if (prior.rowCount && prior.rows[0].status !== 'released') {
        throw quotaError('quota_action_held', 'action already has consumed or unresolved capacity');
      }
      const scopes = keys({ dayKey, runId, clientId, senderId });
      const rows = await client.query(`SELECT scope_key, used_count, limit_count FROM ${BUCKET}
        WHERE scope_key=ANY($1::text[]) FOR UPDATE`, [scopes]);
      if (rows.rowCount !== 6) throw quotaError('quota_schema_missing', 'one or more quota buckets are missing');
      for (const row of rows.rows) {
        if (row.used_count >= row.limit_count) throw quotaError('quota_exhausted', `${row.scope_key} is exhausted`);
      }
      await client.query(`UPDATE ${BUCKET} SET used_count=used_count+1, updated_at=now()
        WHERE scope_key=ANY($1::text[])`, [scopes]);
      const written = await client.query(`INSERT INTO ${ACTION} (action_id, run_id, day_key, client_id, sender_id, status)
        VALUES ($1,$2,$3::date,$4,$5,'reserved') ON CONFLICT (action_id) DO UPDATE SET
        run_id=EXCLUDED.run_id, day_key=EXCLUDED.day_key,
        client_id=EXCLUDED.client_id, sender_id=EXCLUDED.sender_id,
        status='reserved', provider_attempt_started_at=NULL, updated_at=now()
        WHERE ${ACTION}.status='released' RETURNING action_id`, [actionId, runId, dayKey, clientId, senderId]);
      if (written.rowCount !== 1) throw quotaError('quota_action_held', 'action is already held');
      return { actionId, runId, senderId, clientId, status: 'reserved' };
    });
  }

  async function transition(actionId, from, to, { definite = false } = {}) {
    return transaction(async client => {
      const currentDay = await client.query(`SELECT day_key FROM ${ACTION} WHERE action_id=$1`, [actionId]);
      if (!currentDay.rowCount) throw quotaError('quota_action_missing', 'quota action is missing');
      const lockedDay = dayString(currentDay.rows[0].day_key);
      await lockGlobalDay(client, lockedDay);
      const read = await client.query(`SELECT * FROM ${ACTION} WHERE action_id=$1 FOR UPDATE`, [actionId]);
      const row = read.rows[0];
      if (!row || dayString(row.day_key) !== lockedDay) throw quotaError('quota_action_changed', 'quota action changed days during transition');
      if (!from.includes(row.status)) throw quotaError('quota_bad_transition', `quota action is ${row.status}`);
      if (to === 'sending') {
        const run = await client.query(`SELECT deadline_at, status FROM send_control.quota_runs WHERE run_id=$1`, [row.run_id]);
        if (run.rows[0]?.status !== 'active' ||
          (run.rows[0]?.deadline_at && Date.now() >= new Date(run.rows[0].deadline_at).getTime())) {
          throw quotaError('run_deadline_reached', 'run deadline reached before provider attempt');
        }
      }
      if (to === 'released') {
        if (row.status === 'sending' && !definite) throw quotaError('quota_release_ambiguous', 'provider attempt may have delivered');
        const scopes = keys({ dayKey: lockedDay, runId: row.run_id,
          clientId: row.client_id, senderId: row.sender_id });
        const released = await client.query(`UPDATE ${BUCKET} SET used_count=used_count-1, updated_at=now()
          WHERE scope_key=ANY($1::text[]) AND used_count>0`, [scopes]);
        if (released.rowCount !== 6) throw quotaError('quota_release_inconsistent', 'quota bucket release was incomplete');
      }
      await client.query(`UPDATE ${ACTION} SET status=$2,
        provider_attempt_started_at=CASE WHEN $2='sending' THEN now() ELSE provider_attempt_started_at END,
        updated_at=now() WHERE action_id=$1`, [actionId, to]);
      return { actionId, status: to };
    });
  }

  async function finishRun(runId) {
    return transaction(async client => {
      const currentDay = await client.query(`SELECT day_key FROM send_control.quota_runs WHERE run_id=$1`, [runId]);
      if (!currentDay.rowCount) throw quotaError('quota_run_missing', 'run is missing');
      await lockGlobalDay(client, dayString(currentDay.rows[0].day_key));
      const active = await client.query(`SELECT status FROM send_control.quota_runs WHERE run_id=$1 FOR UPDATE`, [runId]);
      if (active.rows[0]?.status !== 'active') throw quotaError('quota_run_inactive', 'run is not active');
      await client.query(`UPDATE send_control.quota_runs SET status='complete', finished_at=now() WHERE run_id=$1`, [runId]);
      await client.query(`DELETE FROM send_control.quota_lane_owners WHERE run_id=$1`, [runId]);
    });
  }

  return {
    beginRun, reserve, finishRun,
    markSending: actionId => transition(actionId, ['reserved'], 'sending'),
    markConsumed: actionId => transition(actionId, ['reserved', 'sending'], 'consumed'),
    markAmbiguous: actionId => transition(actionId, ['reserved', 'sending'], 'ambiguous'),
    release: (actionId, options) => transition(actionId, ['reserved', 'sending'], 'released', options),
    applyMigration: () => pool.query(fs.readFileSync(MIGRATION_FILE, 'utf8')),
    close: () => existingPool ? Promise.resolve() : pool.end(),
  };
}

module.exports = { createPgSendQuotaStore, keys, MIGRATION_FILE };
