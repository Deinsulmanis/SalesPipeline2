-- Tenant-scoped email uniqueness: drop the GLOBAL unique index on
-- email_normalized, leaving outreach_leads_client_email_key
-- (client_id, email_normalized) as the only uniqueness rule.
--
-- APPLY ORDER — do not run this before:
--   1. 20260930010000_outreach_leads_client_id.sql is applied, and
--   2. the code that scopes every email lookup to one client (observers,
--      reply matching, Calendar booking match, Pipeline twins, queue identity,
--      imports) is deployed and verified.
-- Then set OUTREACH_EMAIL_UNIQUENESS=client on the service. Until that variable
-- is set, imports keep refusing an address that exists under any client.
--
-- Relaxing a unique index is backwards-compatible for writers. Within one
-- client an address is still exactly one lead, so no client can mail a person
-- twice through two rows. Global suppression (the Suppression list) still
-- blocks an address for every client.

do $$
begin
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'outreach_leads_client_email_key') then
    raise exception 'outreach_leads_client_email_key is missing; apply 20260930010000 first';
  end if;
end $$;

drop index if exists public.outreach_leads_email_normalized_key;
