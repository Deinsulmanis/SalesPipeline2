'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { STATUS, rowView, denialForExisting } = require('./send-reservation-rules');

const TABLE = 'outbound_send_reservations';
const MIGRATION_FILE = path.join(__dirname, '..', 'db', 'migrations', '20260917000000_outbound_send_reservations.sql');

function createPgSendReservationStore({ connectionString, pool: existingPool } = {}) {
  if (!connectionString && !existingPool) {
    throw new Error('SEND_LOCK_DATABASE_URL is not set');
  }
  const pool = existingPool || new Pool({
    connectionString,
    max: 8,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 4000,
  });

  const query = (text, params) => pool.query(text, params);

  async function getReservation(actionId) {
    const result = await query(
      `SELECT * FROM ${TABLE} WHERE action_id = $1`,
      [actionId],
    );
    return rowView(result.rows[0]);
  }

  async function markExpiredAttemptReconciliation(actionId) {
    const result = await query(
      `UPDATE ${TABLE}
          SET status = $2,
              last_error = 'lease expired after provider attempt started',
              lease_owner = NULL,
              updated_at = NOW()
        WHERE action_id = $1
          AND (
            status = $3
            OR (status = $4 AND provider_attempt_started_at IS NOT NULL)
          )
        RETURNING *`,
      [actionId, STATUS.RECONCILIATION_REQUIRED, STATUS.SENDING, STATUS.RESERVED],
    );
    return rowView(result.rows[0]);
  }

  return {
    kind: 'postgres',
    pool,
    async getReservation(actionId) {
      return getReservation(actionId);
    },
    async reserveOutboundAction(action, { leaseOwner, leaseSeconds } = {}) {
      const result = await query(
        `INSERT INTO ${TABLE} (
            action_id, lead_id, action_type, provider, status,
            lease_owner, lease_expires_at, reserved_at, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5,
            $6, NOW() + make_interval(secs => $7), NOW(), NOW(), NOW()
          )
          ON CONFLICT (action_id) DO UPDATE SET
            lead_id = EXCLUDED.lead_id,
            action_type = EXCLUDED.action_type,
            provider = EXCLUDED.provider,
            status = $5,
            lease_owner = EXCLUDED.lease_owner,
            lease_expires_at = EXCLUDED.lease_expires_at,
            reserved_at = NOW(),
            provider_attempt_started_at = NULL,
            provider_message_id = NULL,
            provider_thread_id = NULL,
            provider_succeeded_at = NULL,
            confirmed_at = NULL,
            failed_at = NULL,
            last_error = NULL,
            updated_at = NOW()
          WHERE ${TABLE}.status = $8
             OR (
               ${TABLE}.status = $5
               AND ${TABLE}.provider_attempt_started_at IS NULL
               AND ${TABLE}.lease_expires_at < NOW()
             )
          RETURNING *`,
        [
          action.actionId, action.leadId, action.actionType, action.provider, STATUS.RESERVED,
          leaseOwner, Number(leaseSeconds), STATUS.FAILED_PRE_DELIVERY,
        ],
      );
      if (result.rows[0]) {
        const reservation = rowView(result.rows[0]);
        return { ok: true, code: 'reservation_acquired', reservation };
      }
      const marked = await markExpiredAttemptReconciliation(action.actionId);
      const existing = marked || await getReservation(action.actionId);
      return denialForExisting(existing);
    },
    async markProviderAttemptStarted(actionId, leaseOwner) {
      const result = await query(
        `UPDATE ${TABLE}
            SET status = $3,
                provider_attempt_started_at = NOW(),
                updated_at = NOW()
          WHERE action_id = $1
            AND lease_owner = $2
            AND status = $4
            AND provider_attempt_started_at IS NULL
            AND lease_expires_at > NOW()
          RETURNING *`,
        [actionId, leaseOwner, STATUS.SENDING, STATUS.RESERVED],
      );
      if (result.rows[0]) return { ok: true, reservation: rowView(result.rows[0]) };
      const existing = await getReservation(actionId);
      if (!existing) return { ok: false, code: 'reservation_missing', reason: 'reservation not found' };
      if (existing.leaseOwner !== leaseOwner) {
        return { ok: false, code: 'reservation_not_owned', reason: 'lease owner does not match' };
      }
      return { ok: false, code: 'reservation_not_startable', reason: 'reservation is not in a startable reserved state' };
    },
    async markProviderSucceeded(actionId, leaseOwner, ids = {}) {
      const result = await query(
        `UPDATE ${TABLE}
            SET status = $3,
                provider_message_id = $4,
                provider_thread_id = $5,
                provider_succeeded_at = NOW(),
                updated_at = NOW()
          WHERE action_id = $1
            AND lease_owner = $2
            AND status = $6
            AND provider_attempt_started_at IS NOT NULL
          RETURNING *`,
        [
          actionId, leaseOwner, STATUS.SENT_UNCONFIRMED,
          ids.providerMessageId || null, ids.providerThreadId || null, STATUS.SENDING,
        ],
      );
      if (result.rows[0]) return { ok: true, reservation: rowView(result.rows[0]) };
      const existing = await getReservation(actionId);
      if (!existing) return { ok: false, code: 'reservation_missing', reason: 'reservation not found' };
      if (existing.leaseOwner !== leaseOwner) {
        return { ok: false, code: 'reservation_not_owned', reason: 'lease owner does not match' };
      }
      return { ok: false, code: 'reservation_not_sending', reason: 'provider success can only be recorded from sending' };
    },
    async markConfirmed(actionId, leaseOwner) {
      const result = await query(
        `UPDATE ${TABLE}
            SET status = $3,
                confirmed_at = NOW(),
                updated_at = NOW()
          WHERE action_id = $1
            AND status = $4
            AND ($2::text IS NULL OR lease_owner = $2)
          RETURNING *`,
        [actionId, leaseOwner || null, STATUS.CONFIRMED, STATUS.SENT_UNCONFIRMED],
      );
      if (result.rows[0]) return { ok: true, reservation: rowView(result.rows[0]) };
      const existing = await getReservation(actionId);
      if (!existing) return { ok: false, code: 'reservation_missing', reason: 'reservation not found' };
      if (leaseOwner && existing.leaseOwner && existing.leaseOwner !== leaseOwner) {
        return { ok: false, code: 'reservation_not_owned', reason: 'lease owner does not match' };
      }
      return { ok: false, code: 'reservation_not_confirmable', reason: 'only sent_unconfirmed rows can be confirmed' };
    },
    async markPreDeliveryFailed(actionId, leaseOwner, lastError) {
      const result = await query(
        `UPDATE ${TABLE}
            SET status = $3,
                failed_at = NOW(),
                last_error = $4,
                updated_at = NOW()
          WHERE action_id = $1
            AND lease_owner = $2
            AND status = $5
            AND provider_succeeded_at IS NULL
          RETURNING *`,
        [actionId, leaseOwner, STATUS.FAILED_PRE_DELIVERY, String(lastError || '').slice(0, 500), STATUS.SENDING],
      );
      if (result.rows[0]) return { ok: true, reservation: rowView(result.rows[0]) };
      return { ok: false, code: 'reservation_not_pre_delivery', reason: 'pre-delivery failure requires an in-flight send with no provider success' };
    },
    async markReconciliationRequired(actionId, lastError) {
      const result = await query(
        `UPDATE ${TABLE}
            SET status = $2,
                last_error = $3,
                updated_at = NOW()
          WHERE action_id = $1
            AND status NOT IN ($4, $5)
          RETURNING *`,
        [
          actionId, STATUS.RECONCILIATION_REQUIRED, String(lastError || '').slice(0, 500),
          STATUS.CONFIRMED, STATUS.FAILED_PRE_DELIVERY,
        ],
      );
      if (result.rows[0]) return { ok: true, reservation: rowView(result.rows[0]) };
      return { ok: false, code: 'reservation_terminal', reason: 'terminal rows are not moved to reconciliation_required' };
    },
    async listUnresolved() {
      const result = await query(
        `SELECT * FROM ${TABLE}
          WHERE status IN ($1, $2)
             OR (status = $3 AND lease_expires_at < NOW())
          ORDER BY updated_at DESC
          LIMIT 500`,
        [STATUS.SENT_UNCONFIRMED, STATUS.RECONCILIATION_REQUIRED, STATUS.RESERVED],
      );
      const all = result.rows.map(rowView);
      return {
        sentUnconfirmed: all.filter(row => row.status === STATUS.SENT_UNCONFIRMED),
        reconciliationRequired: all.filter(row => row.status === STATUS.RECONCILIATION_REQUIRED),
        staleReserved: all.filter(row => row.status === STATUS.RESERVED),
      };
    },
    async health() {
      await query('SELECT 1 AS ok');
      const table = await query('SELECT to_regclass($1) AS name', [`public.${TABLE}`]);
      if (!table.rows[0]?.name) {
        return { ok: false, enabled: true, kind: 'postgres', code: 'lock_schema_missing', reason: 'outbound_send_reservations table is missing' };
      }
      return { ok: true, enabled: true, kind: 'postgres', table: TABLE };
    },
    async applyMigration() {
      const sql = fs.readFileSync(MIGRATION_FILE, 'utf8');
      await query(sql);
      return { ok: true, file: path.basename(MIGRATION_FILE) };
    },
    async verifySchema() {
      const health = await this.health();
      if (!health.ok) return health;
      const columns = await query(
        `SELECT column_name, data_type, is_nullable
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1
          ORDER BY ordinal_position`,
        [TABLE],
      );
      const names = columns.rows.map(row => row.column_name);
      const required = [
        'action_id', 'lead_id', 'action_type', 'provider', 'status',
        'lease_owner', 'lease_expires_at', 'reserved_at',
        'provider_attempt_started_at', 'provider_message_id', 'provider_thread_id',
        'provider_succeeded_at', 'confirmed_at', 'failed_at', 'last_error',
        'created_at', 'updated_at',
      ];
      const missing = required.filter(name => !names.includes(name));
      const pk = await query(
        `SELECT a.attname
           FROM pg_index i
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
          WHERE i.indrelid = $1::regclass AND i.indisprimary`,
        [TABLE],
      );
      const pkOk = pk.rows.length === 1 && pk.rows[0].attname === 'action_id';
      return {
        ok: missing.length === 0 && pkOk,
        table: TABLE,
        missing,
        primaryKey: pk.rows.map(row => row.attname),
        columns: names,
      };
    },
    async close() {
      if (!existingPool) await pool.end();
    },
  };
}

module.exports = { createPgSendReservationStore, TABLE, MIGRATION_FILE };
