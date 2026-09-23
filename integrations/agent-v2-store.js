'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATION = path.join(__dirname, '..', 'db', 'migrations',
  '20260923000000_agent_v2_shadow_decisions.sql');

function decisionIdFor(leadId, messageId) {
  const lead = String(leadId || '').trim();
  const message = String(messageId || '').trim();
  if (!lead || !message) throw new Error('leadId and messageId required for shadow decision id');
  const digest = crypto.createHash('sha256').update(`${lead}\0${message}`).digest('hex');
  return `agent-v2:${digest}`;
}

// A session lock stays held while the model runs. A crashed process loses the
// lock immediately, so the next worker can take over its durable claim.
function lockKeyFor(decisionId) {
  const hex = crypto.createHash('sha256').update(decisionId).digest('hex').slice(0, 16);
  return BigInt.asIntN(64, BigInt(`0x${hex}`)).toString();
}

function createPgAgentV2Store({ connectionString, pool: existingPool } = {}) {
  if (!connectionString && !existingPool) throw new Error('shadow database connection required');
  const Pool = existingPool ? null : require('pg').Pool;
  const pool = existingPool || new Pool({ connectionString, max: 2,
    idleTimeoutMillis: 10000, connectionTimeoutMillis: 4000 });
  let schemaReady = null;
  async function applyMigration() {
    await pool.query(fs.readFileSync(MIGRATION, 'utf8'));
    schemaReady = null;
  }
  async function ensureSchema() {
    if (!schemaReady) schemaReady = pool.query(`SELECT decision_id, lead_id, message_id,
      claimed_at, claim_token, claim_attempts, model_started_at,
      completed_at, created_at, action_id, record
      FROM agent_v2_shadow_decisions LIMIT 0`)
      .catch(error => { schemaReady = null; throw error; });
    await schemaReady;
  }
  async function get(decisionId) {
    await ensureSchema();
    const rows = await pool.query('SELECT record FROM agent_v2_shadow_decisions WHERE decision_id = $1', [decisionId]);
    return rows.rows[0]?.record || null;
  }
  async function claim({ decisionId, leadId, messageId }) {
    await ensureSchema();
    const client = await pool.connect();
    const lockKey = lockKeyFor(decisionId);
    let locked = false;
    let released = false;
    const controller = new AbortController();
    const lost = () => controller.abort();
    client.on?.('error', lost);
    client.on?.('end', lost);
    async function release() {
      if (released) return;
      released = true;
      client.off?.('error', lost);
      client.off?.('end', lost);
      try {
        if (locked) await client.query('SELECT pg_advisory_unlock($1::bigint)', [lockKey]);
        client.release();
      } catch (error) {
        client.release(true);
        throw error;
      }
    }
    try {
      const lock = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [lockKey]);
      if (!lock.rows[0]?.acquired) {
        await release();
        return { status: 'busy' };
      }
      locked = true;
      const token = crypto.randomUUID();
      const result = await client.query(`INSERT INTO agent_v2_shadow_decisions
        (decision_id, lead_id, message_id, claimed_at, claim_token, claim_attempts)
        VALUES ($1, $2, $3, now(), $4, 1)
        ON CONFLICT (decision_id) DO UPDATE SET
          claimed_at = excluded.claimed_at,
          claim_token = excluded.claim_token,
          claim_attempts = agent_v2_shadow_decisions.claim_attempts + 1
        WHERE agent_v2_shadow_decisions.record IS NULL
        RETURNING decision_id, lead_id, message_id, model_started_at, record`,
      [decisionId, leadId, messageId, token]);
      if (!result.rows.length) {
        const prior = await client.query(`SELECT decision_id, lead_id, message_id, record
          FROM agent_v2_shadow_decisions WHERE decision_id = $1`, [decisionId]);
        const row = prior.rows[0];
        if (!row || row.lead_id !== leadId || row.message_id !== messageId || !row.record)
          throw new Error('shadow decision identity conflict');
        await release();
        return { status: 'complete', record: row.record };
      }
      const row = result.rows[0];
      if (row.lead_id !== leadId || row.message_id !== messageId)
        throw new Error('shadow decision identity conflict');
      return {
        status: 'claimed', signal: controller.signal, release,
        priorModelAttempt: Boolean(row.model_started_at),
        async markModelStarted() {
          if (released || controller.signal.aborted) throw new Error('shadow claim lost');
          const marked = await client.query(`UPDATE agent_v2_shadow_decisions
            SET model_started_at = now()
            WHERE decision_id = $1 AND claim_token = $2
              AND record IS NULL AND model_started_at IS NULL
            RETURNING model_started_at`, [decisionId, token]);
          if (marked.rows.length !== 1) throw new Error('shadow model attempt not confirmed');
        },
        async complete(record) {
          if (released || controller.signal.aborted) throw new Error('shadow claim lost');
          const saved = await client.query(`UPDATE agent_v2_shadow_decisions
            SET record = $3::jsonb, action_id = $4, created_at = $5,
                completed_at = now()
            WHERE decision_id = $1 AND claim_token = $2 AND record IS NULL
            RETURNING record`,
          [decisionId, token, JSON.stringify(record), record.decision.actionId, record.createdAt]);
          if (saved.rows.length !== 1) throw new Error('shadow claim completion not confirmed');
          return saved.rows[0].record;
        },
      };
    } catch (error) {
      await release();
      throw error;
    }
  }
  return { applyMigration, ensureSchema, get, claim,
    close: () => existingPool ? Promise.resolve() : pool.end() };
}

module.exports = { decisionIdFor, lockKeyFor, createPgAgentV2Store };
