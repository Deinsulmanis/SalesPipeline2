-- Supabase Agent v2 shadow persistence. Apply only after reviewing the live
-- schema. This migration creates one new table and changes permissions/RLS on
-- that new table only. It fails if the table already exists.
-- Create the restricted worker role separately before applying this migration;
-- it is the only role named in the table's RLS policies. Grant table privileges
-- separately after the migration. This file creates no role or credential.
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

-- public is exposed through PostgREST in this project. Keep the shadow table
-- invisible to API roles; the dedicated worker uses a session-pinned connection.
ALTER TABLE public.agent_v2_shadow_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.agent_v2_shadow_decisions FROM PUBLIC, anon, authenticated, service_role;
CREATE POLICY agent_v2_shadow_select ON public.agent_v2_shadow_decisions
  FOR SELECT TO agent_v2_shadow_worker USING (true);
CREATE POLICY agent_v2_shadow_insert ON public.agent_v2_shadow_decisions
  FOR INSERT TO agent_v2_shadow_worker WITH CHECK (true);
CREATE POLICY agent_v2_shadow_update ON public.agent_v2_shadow_decisions
  FOR UPDATE TO agent_v2_shadow_worker USING (true) WITH CHECK (true);
