-- Run once in the production Railway Postgres send-lock database. This creates
-- only the Agent v2 shadow table; it never alters an existing table. If the
-- table already exists, stop and inspect it instead of silently accepting it.
CREATE TABLE public.agent_v2_shadow_decisions (
  decision_id text PRIMARY KEY,
  lead_id text NOT NULL,
  message_id text NOT NULL,
  claimed_at timestamptz,
  claim_token text,
  claim_attempts integer NOT NULL DEFAULT 0,
  model_started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz,
  action_id text,
  record jsonb,
  UNIQUE (lead_id, message_id)
);
