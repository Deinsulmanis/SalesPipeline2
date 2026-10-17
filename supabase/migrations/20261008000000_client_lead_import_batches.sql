-- Managed-client lead import batches (integrations/clients/import-batches.js).
--
-- ADDITIVE ONLY. One new table; no existing table, row or policy changes.
--
-- A batch is a client, its campaign and the rows to import. The service claims
-- `pending` batches and imports each through the same path as the dashboard
-- import (validation, duplicate protection, global + client suppression, the
-- ColdEmail append and the outreach_leads mirror), then records the result.
-- `staged` batches are never processed: an operator reviews and promotes them.
--
-- Row level security with no policy: only the service role reads or writes.

create table if not exists public.client_lead_import_batches (
  batch_id      text primary key check (batch_id ~ '^[a-z0-9][a-z0-9_-]{2,79}$'),
  client_id     text not null references public.clients(client_id),
  campaign_id   text not null,
  rows          jsonb not null check (jsonb_typeof(rows) = 'array'),
  row_count     integer not null check (row_count >= 0),
  status        text not null default 'staged'
                check (status in ('staged', 'pending', 'processing', 'done', 'failed')),
  submitted_by  text not null default '',
  result        jsonb,
  error         text,
  created_at    timestamptz not null default now(),
  claimed_at    timestamptz,
  finished_at   timestamptz
);
comment on table public.client_lead_import_batches is
  'Managed-client import intake. Only operator-promoted pending batches are imported, once, by the service.';

create index if not exists client_lead_import_batches_status_idx
  on public.client_lead_import_batches (status, created_at);

alter table public.client_lead_import_batches enable row level security;
