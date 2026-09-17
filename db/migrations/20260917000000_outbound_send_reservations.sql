-- Phase 2C — dedicated outbound send reservation / lock table.
--
-- This database is NOT the lead source of truth. Google Sheets remains
-- canonical for lead and activity state. This table exists only to make
-- "at most one provider send/enqueue per action_id" hold across overlapping
-- processes, rolling deploys, replicas, and restarts.
--
-- Do not store this table in the Supabase outreach project. It is wired only
-- through SEND_LOCK_DATABASE_URL.
--
-- STATE MACHINE
--
--   reserved
--     Exclusive lease acquired. Provider send has NOT begun.
--     Expired lease may be taken over only while provider_attempt_started_at
--     is still NULL.
--
--   sending
--     Provider call has begun (markProviderAttemptStarted). An expired lease
--     must NEVER become sendable. Ambiguity here is reconciliation_required.
--
--   sent_unconfirmed
--     Provider returned success and provider ids were persisted. Local CRM
--     checkpoint (Sheets / ColdCallActivity) may still be pending. NEVER
--     send again.
--
--   confirmed
--     Existing local checkpoint also succeeded. Terminal success. NEVER send
--     again.
--
--   failed_pre_delivery
--     Definite provider rejection BEFORE delivery was possible (typically a
--     4xx other than 408/409/429). A later controlled attempt of the SAME
--     action_id may take over this row. This is NOT a generic "failed".
--
--   reconciliation_required
--     Provider result is unknown or success could not be fully checkpointed
--     into this table. Includes timeouts, 5xx, connection resets, process
--     crashes after attempt start, and expired sending leases.
--     NEVER automatically sendable.
--
-- There is intentionally no generic "failed" status. Ambiguous failures must
-- not look retryable.

CREATE TABLE IF NOT EXISTS public.outbound_send_reservations (
  action_id                    text PRIMARY KEY,
  lead_id                      text NOT NULL,
  action_type                  text NOT NULL,
  provider                     text NOT NULL,
  status                       text NOT NULL,
  lease_owner                  text,
  lease_expires_at             timestamptz,
  reserved_at                  timestamptz NOT NULL DEFAULT NOW(),
  provider_attempt_started_at  timestamptz,
  provider_message_id          text,
  provider_thread_id           text,
  provider_succeeded_at        timestamptz,
  confirmed_at                 timestamptz,
  failed_at                    timestamptz,
  last_error                   text,
  created_at                   timestamptz NOT NULL DEFAULT NOW(),
  updated_at                   timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT outbound_send_reservations_status_check CHECK (status IN (
    'reserved',
    'sending',
    'sent_unconfirmed',
    'confirmed',
    'failed_pre_delivery',
    'reconciliation_required'
  ))
);

COMMENT ON TABLE public.outbound_send_reservations IS
  'Exclusive outbound send/enqueue lease. Not lead authority. Duplicate-send brake only.';
COMMENT ON COLUMN public.outbound_send_reservations.action_id IS
  'Deterministic identity of one logical outbound action. Same action across processes shares this id.';
COMMENT ON COLUMN public.outbound_send_reservations.status IS
  'See migration header. No generic failed status exists; ambiguous outcomes stay non-retryable.';
COMMENT ON COLUMN public.outbound_send_reservations.lease_expires_at IS
  'Dead-process recovery for reserved rows that never started a provider call. Expiration alone never authorizes a resend.';
COMMENT ON COLUMN public.outbound_send_reservations.provider_attempt_started_at IS
  'Set immediately before the provider HTTP/API call. Once set, automatic takeover is forbidden.';

CREATE INDEX IF NOT EXISTS outbound_send_reservations_status_idx
  ON public.outbound_send_reservations (status);
CREATE INDEX IF NOT EXISTS outbound_send_reservations_stale_lease_idx
  ON public.outbound_send_reservations (lease_expires_at)
  WHERE status IN ('reserved', 'sending');
CREATE INDEX IF NOT EXISTS outbound_send_reservations_lead_idx
  ON public.outbound_send_reservations (lead_id);
