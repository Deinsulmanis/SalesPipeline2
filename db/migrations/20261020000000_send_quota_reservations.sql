-- Send quota lives beside outbound_send_reservations on SEND_LOCK_DATABASE_URL.
-- This private schema is accessed only through the server-side Postgres role.
-- No Data API grants or automatic stale-lane takeover are provided.
CREATE SCHEMA IF NOT EXISTS send_control;

CREATE TABLE IF NOT EXISTS send_control.quota_buckets (
  scope_key text PRIMARY KEY,
  day_key date NOT NULL,
  limit_count integer NOT NULL CHECK (limit_count >= 0),
  used_count integer NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS send_control.quota_runs (
  run_id text PRIMARY KEY,
  day_key date NOT NULL,
  scheduled_tick_at timestamptz,
  deadline_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'complete')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS send_control.quota_run_lanes (
  run_id text NOT NULL REFERENCES send_control.quota_runs(run_id),
  sender_id text NOT NULL,
  client_id text NOT NULL,
  budget integer NOT NULL CHECK (budget >= 0),
  PRIMARY KEY (run_id, sender_id)
);

-- A crashed process leaves its sender blocked for operator review. An expired
-- timer alone cannot prove the old process stopped before the provider call.
CREATE TABLE IF NOT EXISTS send_control.quota_lane_owners (
  sender_id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES send_control.quota_runs(run_id),
  acquired_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS send_control.quota_actions (
  action_id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES send_control.quota_runs(run_id),
  day_key date NOT NULL,
  client_id text NOT NULL,
  sender_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('reserved', 'sending', 'consumed', 'released', 'ambiguous')),
  provider_attempt_started_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS quota_actions_run_idx ON send_control.quota_actions(run_id);
CREATE INDEX IF NOT EXISTS quota_buckets_day_idx ON send_control.quota_buckets(day_key);

ALTER TABLE send_control.quota_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE send_control.quota_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE send_control.quota_run_lanes ENABLE ROW LEVEL SECURITY;
ALTER TABLE send_control.quota_lane_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE send_control.quota_actions ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE send_control.quota_actions IS
  'Capacity holds for Gmail actions. Ambiguous and consumed actions continue to occupy all six quota buckets.';
COMMENT ON TABLE send_control.quota_lane_owners IS
  'One active run per inbox; no automatic takeover after an unclean exit.';
