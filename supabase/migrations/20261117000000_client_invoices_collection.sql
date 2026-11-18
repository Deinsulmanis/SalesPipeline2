-- Card on file: each invoice records how it is collected.
--   charge_automatically  charged to the client's saved card on the operator's click
--   send_invoice          emailed for the client to pay (the fallback)
-- ADDITIVE ONLY. Existing rows were all emailed invoices, so the default fits.

alter table public.client_invoices add column if not exists collection_method text not null default 'send_invoice';
alter table public.client_invoices drop constraint if exists client_invoices_collection_method_check;
alter table public.client_invoices add constraint client_invoices_collection_method_check
  check (collection_method in ('send_invoice', 'charge_automatically'));
