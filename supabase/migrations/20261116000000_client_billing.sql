-- Managed-client billing: Stripe invoices for qualified held meetings.
--
-- ADDITIVE ONLY. Three nullable columns on client_meetings and one new table.
-- No existing row, constraint or policy changes; every current meeting row
-- simply has no invoice yet.
--
-- The ledger stays the source of truth for WHAT is billable (a held, qualified
-- meeting, client_meetings.billable). Stripe is the source of truth for the
-- invoice itself; client_invoices records which ledger meetings each Stripe
-- invoice covers, so a meeting is never on two live invoices and a voided or
-- discarded invoice returns its meetings to "billable, not invoiced".

alter table public.client_meetings add column if not exists stripe_invoice_id text;
alter table public.client_meetings add column if not exists invoiced_at       timestamptz;
alter table public.client_meetings add column if not exists paid_at           timestamptz;
create index if not exists client_meetings_client_invoice_idx on public.client_meetings (client_id, stripe_invoice_id);

create table if not exists public.client_invoices (
  invoice_id          text primary key,                 -- Stripe invoice id (in_...)
  client_id           text not null references public.clients (client_id),
  -- period: the 1st/15th draft · manual: an operator's "draft now" · single: one meeting, invoiced now
  kind                text not null check (kind in ('period', 'manual', 'single')),
  period_key          text not null default '',         -- '2026-12-01' / '2026-12-15' for period drafts
  status              text not null check (status in ('draft', 'open', 'paid', 'void', 'uncollectible', 'deleted')),
  currency            text not null,
  amount_cents        integer not null default 0 check (amount_cents >= 0),
  meeting_ids         jsonb not null default '[]'::jsonb,
  invoice_number      text not null default '',
  hosted_invoice_url  text not null default '',
  due_at              timestamptz,
  sent_at             timestamptz,
  paid_at             timestamptz,
  voided_at           timestamptz,
  livemode            boolean not null default false,
  created_by          text not null default '',
  sent_by             text not null default '',
  last_error          text not null default '',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists client_invoices_client_status_idx on public.client_invoices (client_id, status, created_at desc);
-- One live semi-monthly draft per client per period. A discarded or voided one
-- frees the period so it can be drafted again.
create unique index if not exists client_invoices_one_live_period
  on public.client_invoices (client_id, period_key)
  where kind = 'period' and status not in ('deleted', 'void');

-- Same defence as the rest of the ledger: the server uses the secret key; a
-- publishable key that reached a browser reads nothing.
alter table public.client_invoices enable row level security;
