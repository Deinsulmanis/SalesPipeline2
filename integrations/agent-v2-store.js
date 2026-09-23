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

function createPgAgentV2Store({ connectionString, pool: existingPool } = {}) {
  if (!connectionString && !existingPool) throw new Error('shadow database connection required');
  const Pool = existingPool ? null : require('pg').Pool;
  const pool = existingPool || new Pool({ connectionString, max: 2,
    idleTimeoutMillis: 10000, connectionTimeoutMillis: 4000 });
  let schemaReady = null;
  async function ensureSchema() {
    if (!schemaReady) schemaReady = pool.query(fs.readFileSync(MIGRATION, 'utf8'))
      .catch(error => { schemaReady = null; throw error; });
    await schemaReady;
  }
  async function get(decisionId) {
    await ensureSchema();
    const rows = await pool.query('SELECT record FROM agent_v2_shadow_decisions WHERE decision_id = $1', [decisionId]);
    return rows.rows[0]?.record || null;
  }
  async function putIfAbsent(record) {
    await ensureSchema();
    const result = await pool.query(`INSERT INTO agent_v2_shadow_decisions
      (decision_id, lead_id, message_id, created_at, action_id, record)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      ON CONFLICT DO NOTHING RETURNING record`,
    [record.decisionId, record.leadId, record.messageId, record.createdAt,
      record.decision.actionId, JSON.stringify(record)]);
    if (result.rows[0]) return { inserted: true, record: result.rows[0].record };
    const existing = await pool.query(`SELECT record FROM agent_v2_shadow_decisions
      WHERE lead_id = $1 AND message_id = $2`, [record.leadId, record.messageId]);
    const saved = existing.rows[0]?.record;
    if (!saved || saved.decisionId !== record.decisionId) throw new Error('shadow decision identity conflict');
    return { inserted: false, record: saved };
  }
  return { ensureSchema, get, putIfAbsent, close: () => existingPool ? Promise.resolve() : pool.end() };
}

module.exports = { decisionIdFor, createPgAgentV2Store };
