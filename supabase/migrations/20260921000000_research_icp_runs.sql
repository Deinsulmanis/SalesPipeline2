-- Isolated shadow audit storage. No foreign keys, triggers, or CRM table changes.
create table if not exists public.research_icp_runs (
  run_id uuid primary key,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  lead_id text,
  company text not null default '',
  domain text not null default '',
  campaign_id text not null default '',
  agent text not null check (agent = 'research_icp'),
  version text not null,
  mode text not null check (mode = 'shadow'),
  model text not null,
  status text not null check (status in ('running', 'succeeded', 'failed')),
  classification text check (classification in ('HIGH', 'MEDIUM', 'ICP_MISMATCH', 'INSUFFICIENT_EVIDENCE', 'RETRIEVAL_FAILURE')),
  confidence double precision check (confidence >= 0 and confidence <= 1),
  input_snapshot jsonb not null,
  sources jsonb not null default '[]'::jsonb,
  output jsonb,
  comparison jsonb,
  research_run_id uuid,
  error_code text,
  latency_ms integer check (latency_ms >= 0),
  usage jsonb not null default '[]'::jsonb,
  check (status = 'running' or (completed_at is not null and output is not null and classification is not null and confidence is not null))
);
create index if not exists research_icp_runs_lead_time on public.research_icp_runs (lead_id, started_at desc);
create index if not exists research_icp_runs_campaign_version_time on public.research_icp_runs (campaign_id, version, started_at desc);
alter table public.research_icp_runs enable row level security;
revoke all on public.research_icp_runs from anon, authenticated;
grant select, insert, update on public.research_icp_runs to service_role;
comment on table public.research_icp_runs is 'Manual shadow recommendations only. Not a source of send eligibility or CRM transitions.';
