-- Stage 3 — operational outreach lead state.
--
-- Google Sheets (the ColdEmail tab) remains authoritative while this table is
-- being proven. This is a shadow copy written after a Sheets write has already
-- succeeded, exactly as crm_events was in Stage 1, and nothing reads from it
-- for an operational decision until a cutover is separately approved.
--
-- FIDELITY OVER PRETTINESS
--
-- Every ColdEmail column is stored as text, holding precisely what the sheet
-- holds. That is deliberate. The runtime compares these values as strings —
-- routedLeadReady() tests `String(routingRequired).toLowerCase() !== 'true'`,
-- selectQueued() tests `emailStatus !== ''`, NON_COLD_STAGES does a lowercased
-- membership test — so a "helpful" conversion to boolean or enum would change
-- behaviour at the edges ('' vs 'false' vs null) for no gain, and would make
-- parity comparison a matter of interpretation rather than equality.
--
-- Typed columns exist only where a query needs them, and are derived rather
-- than independently written, so they cannot drift into a second source of
-- truth. email_normalized is a GENERATED column for exactly that reason.
--
-- WHAT IS NOT HERE
--
-- Sequence state, hold/resume, meeting lifecycle, sender/thread evidence and
-- demo-intent state are all derived from canonical activity events, which
-- crm_events already mirrors. Duplicating them here would create a second
-- source of truth for state the application deliberately derives.

create table if not exists public.outreach_leads (
  -- Canonical ColdEmail row id. The application's own identity, not a new one.
  lead_id                  text primary key,

  -- The 24 ColdEmail columns, stored exactly as the sheet holds them.
  company                  text,
  contact_name             text,
  email                    text,
  city                     text,
  trade_type               text,
  website                  text,
  stage                    text,
  email_status             text,
  last_emailed_at          text,
  email_step               text,
  notes                    text,
  review_count             text,
  rating                   text,
  tier                     text,
  site_context             text,
  campaign                 text,
  campaign_notes           text,
  enrichment_attempted     text,
  lead_niche               text,
  sender_inbox_id          text,
  email_template_id        text,
  routing_required         text,
  intended_campaign_version text,

  -- Derived for indexing. Generated, so it is impossible for it to disagree
  -- with the column it comes from.
  email_normalized         text generated always as (lower(btrim(coalesce(email, '')))) stored,

  -- Derived for range queries. Written by the mirror using the same isoOrNull
  -- rule as Stage 1: a value that cannot be parsed becomes null rather than a
  -- substituted now(). last_emailed_at above remains the source of truth.
  last_emailed_at_ts       timestamptz,
  email_step_int           integer,

  -- Advisory only. The sheet row a value came from, useful when reconciling a
  -- discrepancy by hand. Row numbers shift when rows are deleted, so nothing
  -- may address a lead by this.
  sheet_row                integer,

  -- Reserved for the write cutover. ColdEmail has no concurrency control today
  -- (writes are last-writer-wins on a cell range), so moving write authority
  -- will need compare-and-set. Present from the start so adding it later is not
  -- a migration on a live table; unused while Sheets stays authoritative.
  revision                 bigint not null default 1,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  -- When the mirror observed this row, distinct from any business timestamp.
  mirrored_at              timestamptz not null default now()
);

comment on table public.outreach_leads is
  'Stage 3 shadow mirror of the authoritative ColdEmail sheet. Observational until a cutover is approved: no operational decision reads from it.';
comment on column public.outreach_leads.lead_id is
  'Canonical ColdEmail id. Primary key, so re-mirroring a lead is idempotent.';
comment on column public.outreach_leads.email_normalized is
  'Generated from email. Secondary lookup key, matching the runtime''s normalizeEmail.';
comment on column public.outreach_leads.revision is
  'Reserved for compare-and-set once write authority moves. Unused while Sheets is authoritative.';
comment on column public.outreach_leads.sheet_row is
  'Advisory. Row numbers shift; never address a lead by this.';

-- A second lead sharing a normalized address would break email-based lookup,
-- which the runtime uses as its secondary identity. Partial, because historical
-- rows may legitimately have a blank address.
create unique index if not exists outreach_leads_email_normalized_key
  on public.outreach_leads (email_normalized)
  where email_normalized <> '';

-- The read patterns Stage 3 actually needs: directory filters, sender
-- ownership, campaign/niche scoping and cadence selection.
create index if not exists outreach_leads_stage_idx        on public.outreach_leads (stage);
create index if not exists outreach_leads_campaign_idx     on public.outreach_leads (campaign);
create index if not exists outreach_leads_lead_niche_idx   on public.outreach_leads (lead_niche);
create index if not exists outreach_leads_sender_idx       on public.outreach_leads (sender_inbox_id);
create index if not exists outreach_leads_email_status_idx on public.outreach_leads (email_status);
create index if not exists outreach_leads_last_emailed_idx on public.outreach_leads (last_emailed_at_ts desc nulls last);
create index if not exists outreach_leads_updated_at_idx   on public.outreach_leads (updated_at desc);

-- Same defence in depth as crm_events: the server reaches Supabase with the
-- secret key, which bypasses RLS. Enabling it with no policy means a
-- publishable key that ever reached a browser would still read nothing.
alter table public.outreach_leads enable row level security;
