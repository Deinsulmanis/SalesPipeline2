-- Advisory decisions only. No foreign key or trigger into send/CRM tables.
CREATE TABLE IF NOT EXISTS agent_v2_shadow_decisions (
  decision_id text PRIMARY KEY,
  lead_id text NOT NULL,
  message_id text NOT NULL,
  created_at timestamptz NOT NULL,
  action_id text NOT NULL,
  record jsonb NOT NULL,
  UNIQUE (lead_id, message_id)
);
