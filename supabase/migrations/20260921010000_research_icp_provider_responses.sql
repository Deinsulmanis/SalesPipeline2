-- Additive audit capture only; existing V1 rows remain unchanged in meaning.
-- Apply before deploying the serialization fix. Existing RLS/grants still apply.
alter table public.research_icp_runs
  add column if not exists provider_responses jsonb not null default '[]'::jsonb;
comment on column public.research_icp_runs.provider_responses is
  'Raw Anthropic message bodies and per-phase parsing/schema status. Untrusted model output retained for authenticated audit; never a source of CRM decisions.';
