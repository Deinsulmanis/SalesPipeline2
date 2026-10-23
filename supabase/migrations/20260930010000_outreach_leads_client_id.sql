-- Explicit tenant ownership for outreach leads.
--
-- ADDITIVE. Requires 20260930000000_client_ledger.sql (public.clients).
--
-- client_id is the canonical owner of a lead. Every existing row belongs to
-- ScaleLab (read-only audit 2026-09-29: 2,349 rows, all resolve to scalelab,
-- 0 conflicts), so the column is added NOT NULL DEFAULT 'scalelab': Postgres
-- 11+ records the default in the catalog, so this backfills every existing row
-- without rewriting the table, and old code that never names client_id keeps
-- writing ScaleLab rows. A managed client's lead is always written with its
-- client_id explicitly.
--
-- The guard below refuses to run if any existing row already looks like a
-- managed client's lead, so no such row is silently stamped 'scalelab'.
--
-- The global unique index on email_normalized is NOT dropped here. The
-- tenant-scoped index is added alongside it; dropping the global one is
-- 20260930020000_outreach_leads_tenant_scoped_email.sql, applied only after the
-- code that scopes every email lookup to a client is live.

do $$
begin
  if exists (
    select 1 from public.outreach_leads
    where concat_ws('|', lead_niche, email_template_id, intended_campaign_version, campaign, sender_inbox_id)
          ~* '(^|[|])jole[_-]'
  ) then
    raise exception 'outreach_leads already holds rows naming a managed client; backfill them explicitly before adding client_id';
  end if;
end $$;

alter table public.outreach_leads
  add column if not exists client_id text not null default 'scalelab';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'outreach_leads_client_id_fkey') then
    alter table public.outreach_leads
      add constraint outreach_leads_client_id_fkey foreign key (client_id) references public.clients (client_id);
  end if;
end $$;

comment on column public.outreach_leads.client_id is
  'Canonical tenant owner (ColdEmail column Y). Routing fields must agree with it; a disagreement blocks every send.';

-- One lead per address PER CLIENT. Coexists with the global index until
-- 20260930020000 drops that one.
create unique index if not exists outreach_leads_client_email_key
  on public.outreach_leads (client_id, email_normalized)
  where email_normalized <> '';

create index if not exists outreach_leads_client_idx on public.outreach_leads (client_id);
