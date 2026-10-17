-- Additive, operator-only daily report snapshots. Do not apply until this
-- feature branch is reconciled and the deployment is ready to read this table.
create table if not exists public.client_daily_reports (
  client_id text not null references public.clients (client_id),
  report_date date not null,
  generated_at timestamptz not null,
  timezone text not null,
  campaign_id text not null,
  campaign_version text,
  sends_attempted integer check (sends_attempted >= 0),
  successful_sends integer check (successful_sends >= 0),
  replies integer check (replies >= 0),
  positive_replies integer check (positive_replies >= 0),
  negative_replies integer check (negative_replies >= 0),
  unsubscribe_requests integer check (unsubscribe_requests >= 0),
  bounces integer check (bounces >= 0),
  meetings_booked integer check (meetings_booked >= 0),
  untouched_remaining integer check (untouched_remaining >= 0),
  contacted_cumulative integer check (contacted_cumulative >= 0),
  replies_cumulative integer check (replies_cumulative >= 0),
  positive_replies_cumulative integer check (positive_replies_cumulative >= 0),
  meetings_cumulative integer check (meetings_cumulative >= 0),
  reply_rate numeric(8, 3) check (reply_rate >= 0),
  positive_reply_rate numeric(8, 3) check (positive_reply_rate >= 0),
  meeting_rate numeric(8, 3) check (meeting_rate >= 0),
  per_sender jsonb not null default '[]'::jsonb,
  sender_health jsonb not null default '{}'::jsonb,
  unavailable jsonb not null default '{}'::jsonb,
  check (jsonb_typeof(per_sender) = 'array'),
  check (jsonb_typeof(sender_health) = 'object'),
  check (jsonb_typeof(unavailable) = 'object'),
  -- One frozen snapshot per client per client-local date; it also serves every lookup.
  primary key (client_id, report_date)
);

alter table public.client_daily_reports enable row level security;
-- SELECT and INSERT only: no role the service uses can UPDATE or DELETE a snapshot.
-- Inserts use ON CONFLICT DO NOTHING (PostgREST resolution=ignore-duplicates).
revoke all on public.client_daily_reports from public, anon, authenticated, service_role;
grant select, insert on public.client_daily_reports to service_role;

comment on table public.client_daily_reports is
  'Immutable weekday client-local 14:00 reporting snapshots; insert conflicts are ignored, not updated.';
