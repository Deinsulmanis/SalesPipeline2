-- Managed-client ledger and client-scoped suppression.
--
-- ADDITIVE ONLY. Creates new tables; alters no existing table, row or policy.
-- outreach_leads is untouched: a lead's client is derived from routing fields
-- it already stores (integrations/clients/ownership.js), so historical rows
-- need no backfill and cannot disagree with their Sheets mirror.
--
-- ISOLATION IN THE DATABASE. Every child row carries client_id and references
-- its parent by (id, client_id). A meeting or clarification attached to another
-- client's opportunity violates a foreign key; it cannot be written at all.
--
-- These tables are the only store for ledger rows (no Sheets mirror), so there
-- is no second copy to split from.
--
-- Nothing reads these tables until CLIENT_LEDGER_ENABLED=true is set on the
-- service after this migration is applied.

create table if not exists public.clients (
  client_id     text primary key check (client_id ~ '^[a-z][a-z0-9_]{1,31}$'),
  display_name  text not null,
  created_at    timestamptz not null default now()
);
comment on table public.clients is
  'Identity of managed clients for referential integrity. Configuration lives in integrations/clients/client-configs.js.';

insert into public.clients (client_id, display_name) values
  ('scalelab', 'ScaleLab AI'),
  ('jole', 'Jole Enterprise')
on conflict (client_id) do nothing;

create table if not exists public.client_opportunities (
  opportunity_id        text primary key,
  client_id             text not null references public.clients (client_id),
  lead_id               text not null,
  campaign_id           text not null default '',
  source_campaign       text not null default '',
  employer              text not null default '',
  contact_name          text not null default '',
  contact_title         text not null default '',
  contact_email         text not null default '',
  conversation_status   text not null default 'new' check (conversation_status in (
    'new', 'qualification_in_progress', 'awaiting_client_clarification', 'meeting_booking',
    'meeting_booked', 'future_need', 'referral_pending', 'wrong_contact', 'needs_review',
    'closed_not_interested', 'closed_unsubscribed', 'closed_outside_icp', 'closed_won', 'closed_lost')),
  qualification_status  text not null default 'pending' check (qualification_status in ('pending', 'qualified', 'disqualified')),
  qualification_basis   text not null default '',
  notes                 text not null default '',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (opportunity_id, client_id),
  unique (client_id, lead_id)
);
create index if not exists client_opportunities_client_status_idx on public.client_opportunities (client_id, conversation_status);

create table if not exists public.client_meetings (
  meeting_id             text primary key,
  client_id              text not null references public.clients (client_id),
  opportunity_id         text not null,
  lead_id                text not null,
  campaign_id            text not null default '',
  meeting_status         text not null check (meeting_status in (
    'BOOKED', 'RESCHEDULED', 'CANCELLED', 'NO_SHOW', 'HELD', 'QUALIFIED_HELD', 'DISQUALIFIED_HELD')),
  booked_at              timestamptz not null,
  scheduled_for          timestamptz,
  held_at                timestamptz,
  cancelled_at           timestamptz,
  no_show_at             timestamptz,
  reschedule_count       integer not null default 0,
  attendee_name          text not null default '',
  attendee_title         text not null default '',
  attendee_email         text not null default '',
  attendee_status        text not null default 'unknown' check (attendee_status in ('decision_maker', 'not_decision_maker', 'unknown')),
  employer_fit           text not null default 'unknown' check (employer_fit in ('fit', 'out_of_icp', 'unknown')),
  decision_areas         jsonb not null default '[]'::jsonb,
  use_case               text not null default '',
  qualification_status   text not null default 'pending' check (qualification_status in ('pending', 'qualified', 'disqualified')),
  qualification_basis    text not null default '',
  qualified_at           timestamptz,
  billable               boolean not null default false,
  billable_reason        text not null default '',
  performance_fee_cents  integer not null default 0 check (performance_fee_cents >= 0),
  currency               text,
  invoice_status         text not null default 'not_billable' check (invoice_status in ('not_billable', 'pending', 'invoiced', 'paid', 'void')),
  notes                  text not null default '',
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  foreign key (opportunity_id, client_id) references public.client_opportunities (opportunity_id, client_id),
  -- Billing derives from a held, qualified meeting only.
  constraint client_meetings_billable_requires_qualified_held
    check (not billable or (meeting_status = 'QUALIFIED_HELD' and held_at is not null and qualification_status = 'qualified'))
);
create index if not exists client_meetings_client_status_idx on public.client_meetings (client_id, meeting_status);
create index if not exists client_meetings_client_scheduled_idx on public.client_meetings (client_id, scheduled_for desc);

create table if not exists public.client_clarifications (
  clarification_id   text primary key,
  client_id          text not null references public.clients (client_id),
  opportunity_id     text not null,
  lead_id            text not null,
  question           text not null,
  topics             jsonb not null default '[]'::jsonb,
  source_message_id  text not null default '',
  status             text not null default 'open' check (status in ('open', 'answered', 'closed')),
  answer             text not null default '',
  answered_by        text not null default '',
  answered_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  foreign key (opportunity_id, client_id) references public.client_opportunities (opportunity_id, client_id)
);
create index if not exists client_clarifications_client_status_idx on public.client_clarifications (client_id, status);

create table if not exists public.client_suppressions (
  client_id    text not null references public.clients (client_id),
  match_type   text not null check (match_type in ('email', 'domain', 'company')),
  match_value  text not null check (match_value <> ''),
  reason       text not null default '',
  source       text not null default '',
  created_by   text not null default '',
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (client_id, match_type, match_value)
);
comment on table public.client_suppressions is
  'Client-scoped exclusions. Global suppression (unsubscribe, bounce, compliance) stays in the Suppression list and applies to every client.';

create table if not exists public.client_ledger_events (
  event_id     text primary key,
  client_id    text not null references public.clients (client_id),
  entity_type  text not null,
  entity_id    text not null,
  event_type   text not null,
  payload      jsonb not null default '{}'::jsonb,
  occurred_at  timestamptz not null default now()
);
create index if not exists client_ledger_events_client_idx on public.client_ledger_events (client_id, occurred_at desc);

-- Same defence as every other table here: the server uses the secret key; a
-- publishable key that reached a browser reads nothing.
alter table public.clients               enable row level security;
alter table public.client_opportunities  enable row level security;
alter table public.client_meetings       enable row level security;
alter table public.client_clarifications enable row level security;
alter table public.client_suppressions   enable row level security;
alter table public.client_ledger_events  enable row level security;
