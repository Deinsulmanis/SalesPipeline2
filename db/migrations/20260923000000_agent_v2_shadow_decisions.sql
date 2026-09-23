-- Advisory decisions only. No foreign key or trigger into send/CRM tables.
CREATE TABLE IF NOT EXISTS agent_v2_shadow_decisions (
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
-- Allow a claim to exist before the model call. These additions also upgrade
-- a database that already ran the original Phase 2 candidate migration.
ALTER TABLE agent_v2_shadow_decisions ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
ALTER TABLE agent_v2_shadow_decisions ADD COLUMN IF NOT EXISTS claim_token text;
ALTER TABLE agent_v2_shadow_decisions ADD COLUMN IF NOT EXISTS claim_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE agent_v2_shadow_decisions ADD COLUMN IF NOT EXISTS model_started_at timestamptz;
ALTER TABLE agent_v2_shadow_decisions ADD COLUMN IF NOT EXISTS completed_at timestamptz;
ALTER TABLE agent_v2_shadow_decisions ALTER COLUMN created_at DROP NOT NULL;
ALTER TABLE agent_v2_shadow_decisions ALTER COLUMN action_id DROP NOT NULL;
ALTER TABLE agent_v2_shadow_decisions ALTER COLUMN record DROP NOT NULL;
