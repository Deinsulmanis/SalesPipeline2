#!/usr/bin/env node
'use strict';

require('dotenv').config();
const fs = require('node:fs');
const { Pool } = require('pg');
const { sendLockDatabaseUrl, URL_VAR } = require('../integrations/send-lock-config');
const { MIGRATION_FILE } = require('../integrations/send-quota-store');

async function main() {
  const url = sendLockDatabaseUrl();
  if (!url) throw new Error(`${URL_VAR} is required`);
  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 4000 });
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      const original = await client.query("SELECT to_regclass('public.outbound_send_reservations') AS reservation_table");
      if (!original.rows[0].reservation_table) throw new Error('dedicated send-lock reservation table is missing');
      await client.query(fs.readFileSync(MIGRATION_FILE, 'utf8'));
      const expected = ['quota_buckets', 'quota_runs', 'quota_run_lanes', 'quota_lane_owners', 'quota_actions'];
      const tables = await client.query(`SELECT table_name FROM information_schema.tables
        WHERE table_schema='send_control' AND table_name = ANY($1::text[])`, [expected]);
      if (tables.rowCount !== expected.length) throw new Error('quota migration tables are incomplete');
      const indexes = await client.query(`SELECT indexname FROM pg_indexes WHERE schemaname='send_control'
        AND indexname = ANY($1::text[])`, [['quota_actions_run_idx', 'quota_buckets_day_idx']]);
      if (indexes.rowCount !== 2) throw new Error('quota migration indexes are incomplete');
      const constraints = await client.query(`SELECT c.relname, con.contype FROM pg_constraint con
        JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='send_control' AND c.relname = ANY($1::text[])`, [expected]);
      for (const table of expected) {
        const found = constraints.rows.filter(row => row.relname === table);
        if (!found.some(row => row.contype === 'p') ||
          !found.some(row => row.contype === 'c') && table !== 'quota_lane_owners') {
          throw new Error(`quota migration constraints are incomplete: ${table}`);
        }
      }
      await client.query('COMMIT');
      console.log('send quota migration verified on dedicated send-lock Postgres');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  } finally { await pool.end(); }
}

main().catch(error => {
  console.error(String(error.message || error).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[redacted-db-url]'));
  process.exitCode = 1;
});
