'use strict';

// Operator-requested release of send runs that died without finishing (a
// container stopped mid-run by a deploy). Such a run keeps its sender lanes in
// send_control.quota_lane_owners, so every later run refuses with
// "sender ... is owned by another run" until an operator clears it.
//
// It only touches a run that is still 'active' and whose deadline passed
// before the operator's cutoff. Past its deadline the store already refuses
// reserve() and markSending() for that run, so it cannot start a provider
// attempt. A capacity hold that never reached the provider ('reserved') is
// released; one that may have reached it ('sending') becomes 'ambiguous' and
// stays counted. Nothing is ever retried or sent from here.

const { keys } = require('./send-quota-store');

const DEADLINE_GRACE_MS = 2 * 60000;

const dayString = value => value instanceof Date
  ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
  : String(value).slice(0, 10);

function releaseError(code, message) {
  return Object.assign(new Error(message), { code });
}

async function releaseExpiredQuotaRuns(pool, { cutoff, now = new Date() } = {}) {
  const cut = new Date(cutoff);
  if (!cutoff || !Number.isFinite(cut.getTime())) throw releaseError('release_cutoff_invalid', 'release cutoff must be an ISO timestamp');
  if (cut.getTime() > now.getTime()) throw releaseError('release_cutoff_future', 'release cutoff must not be in the future');
  // A run is eligible only once its deadline is behind both the cutoff and now.
  const limit = new Date(Math.min(cut.getTime(), now.getTime() - DEADLINE_GRACE_MS)).toISOString();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    const candidates = await client.query(`SELECT run_id, day_key FROM send_control.quota_runs
      WHERE status='active' AND deadline_at IS NOT NULL AND deadline_at < $1
      ORDER BY day_key, run_id`, [limit]);
    // The global day bucket is the serialization point reserve/transition use.
    const days = [...new Set(candidates.rows.map(row => dayString(row.day_key)))].sort();
    for (const day of days) {
      await client.query(`SELECT 1 FROM send_control.quota_buckets WHERE scope_key=$1 FOR UPDATE`, [`day:global:${day}`]);
    }
    const released = [];
    for (const candidate of candidates.rows) {
      const read = await client.query(`SELECT run_id, day_key, deadline_at, status FROM send_control.quota_runs
        WHERE run_id=$1 FOR UPDATE`, [candidate.run_id]);
      const run = read.rows[0];
      if (!run || run.status !== 'active' || !run.deadline_at || !(new Date(run.deadline_at).getTime() < Date.parse(limit))) continue;
      const runId = run.run_id;
      const dayKey = dayString(run.day_key);
      const actions = await client.query(`SELECT action_id, client_id, sender_id, status FROM send_control.quota_actions
        WHERE run_id=$1 AND status IN ('reserved','sending') ORDER BY action_id FOR UPDATE`, [runId]);
      let releasedReserved = 0;
      let markedAmbiguous = 0;
      for (const action of actions.rows) {
        if (action.status === 'reserved') {
          await client.query('SAVEPOINT quota_release_action');
          const scopes = keys({ dayKey, runId, clientId: action.client_id, senderId: action.sender_id });
          const freed = await client.query(`UPDATE send_control.quota_buckets SET used_count=used_count-1, updated_at=now()
            WHERE scope_key=ANY($1::text[]) AND used_count>0`, [scopes]);
          if (freed.rowCount === 6) {
            await client.query(`UPDATE send_control.quota_actions SET status='released', updated_at=now() WHERE action_id=$1`, [action.action_id]);
            await client.query('RELEASE SAVEPOINT quota_release_action');
            releasedReserved++;
            continue;
          }
          // Inconsistent buckets: keep the hold counted rather than guess.
          await client.query('ROLLBACK TO SAVEPOINT quota_release_action');
        }
        await client.query(`UPDATE send_control.quota_actions SET status='ambiguous', updated_at=now() WHERE action_id=$1`, [action.action_id]);
        markedAmbiguous++;
      }
      const owners = await client.query(`DELETE FROM send_control.quota_lane_owners WHERE run_id=$1 RETURNING sender_id`, [runId]);
      await client.query(`UPDATE send_control.quota_runs SET status='complete', finished_at=now() WHERE run_id=$1`, [runId]);
      released.push({ runId, dayKey, deadlineAt: new Date(run.deadline_at).toISOString(),
        senders: owners.rows.map(row => row.sender_id).sort(), releasedReserved, markedAmbiguous });
    }
    await client.query('COMMIT');
    return { cutoff: cut.toISOString(), released };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

module.exports = { releaseExpiredQuotaRuns, DEADLINE_GRACE_MS };
