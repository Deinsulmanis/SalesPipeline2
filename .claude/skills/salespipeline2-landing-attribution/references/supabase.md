# Supabase reference

**The project** is the SalesPipeline2 outreach project: the host in `SUPABASE_URL`, or "SalesPipeline2" in the Supabase connector's `list_projects`.
- The server reaches it over PostgREST with `SUPABASE_SECRET_KEY` (`service_role`), using `mirrorConfig` in `integrations/supabase-mirror.js`.
- The same project holds `crm_events` (the canonical activity mirror) and `outreach_leads` (the outreach corpus).

**Schema file:** `supabase/migrations/20260925000000_landing_link_attribution.sql`. It is idempotent (`if not exists` / `create or replace`) and needs no extension.

## Tables (RLS on, no policies)

| Table | One row per | Key columns |
|---|---|---|
| `landing_link_issuances` | issued link | `issuance_id` uuid PK; `issuance_key` unique (`…\|staffing_landing`); `token_hash` unique (64-hex SHA-256); `token_key_version`; `lead_id`; `source` (`followup_2`/`positive_reply`); `trigger_action`; `campaign_id`/`campaign_version`; `template_id`/`template_version`; `sender_inbox_id`; `is_test`; `status` (`issued`/`sent`/`revoked`); `issued_at`/`sent_at`; `provider_message_id`/`provider_thread_id` |
| `landing_sessions` | browser-tab session | `session_id` uuid PK; `issuance_id` FK (cascade); `token_hash`; `resolution` (`resolved`/`pending`/`revoked`/`none`); tier timestamps (`visible_at`, `engaged_at` + `engaged_basis`, `interacted_at`, `intent_at`); `visible_ms`; `max_scroll_pct`; `is_internal`; `is_debug`; `webdriver`; coarse UA classes; `viewport_bucket` |
| `landing_events` | allowlisted event | identity `event_id`; `session_id` FK (cascade); `page_load_id` + `seq` unique; `event_name` (CHECK allowlist); `client_ms`; `received_at`; `is_trusted`; `user_activated`; `props` jsonb (≤1 KB). Milestones unique per session (`landing_events_milestone_once`). |

## Functions (SECURITY DEFINER, `search_path = public, pg_temp`)

| Function | Called by | Purpose |
|---|---|---|
| `landing_issue_link(p jsonb)` | send path, reconciler | Insert if absent, fill empty descriptive fields, link pending sessions, return the row |
| `landing_mark_link_sent(p jsonb)` | send path, reconciler | Mark sent. The first values win, and a revoked link stays revoked. |
| `landing_ingest(p jsonb)` | collector | Create the session on first sight, insert events idempotently, refresh rollups. A session belongs to one token for life (`token_mismatch`). |
| `landing_refresh_session(uuid)` | internal only; **not** executable by `service_role` | Recompute tier timestamps and rollups |
| `landing_resolve_pending_sessions(p)` | reconciler | Link sessions that arrived before their issuance |
| `landing_backfill_candidates(p)` | reconciler | crm_events reservations or sends with a tracked pin but a missing or unsent issuance. It returns the recipient domain only. |
| `landing_apply_retention(p)` | reconciler | Delete past `RETENTION_DAYS` (periods are passed in) |
| `landing_forget_lead(p)` | manual deletion request | Remove a lead's issuances (sessions and events cascade) |

## Views (`security_invoker = true`, SELECT for `service_role` only)

- `landing_session_facts`: sessions joined to their issuance, with per-session flags (video 25/50/75/complete, meeting, trusted CTA, dialog, `scroll_jump`) and `seconds_after_send`.
  - **It includes `s.*`, so `token_hash` is in it.** Always name its columns.
- `landing_link_funnel`: one row per non-test issuance, with session tier counts. Internal and debug sessions are excluded.
- `landing_booking_attribution`: `call_booked` crm_events with assist labels. Test, internal and debug traffic are excluded.
- `landing_funnel_daily`: links by send date (Pacific) × source, campaign, sender and template.

## Access model: verify after any schema change

`PUBLIC`, `anon`, `authenticated`, `authenticator` and other roles hold **no** privilege on any `landing%` table, view, sequence or function. `service_role` holds table and view access, the identity sequence, and EXECUTE on every function except `landing_refresh_session`. Supabase's default privileges grant `anon` and `authenticated` everything on new objects in `public`, which is why the migration's explicit REVOKEs are essential.

**Privilege matrix check (read-only):**
```sql
with roles(r) as (values ('anon'),('authenticated'),('service_role'),('authenticator')),
rels as (select oid, relname from pg_class where relnamespace='public'::regnamespace and relname like 'landing%' and relkind in ('r','v')),
funcs as (select oid, oid::regprocedure::text f from pg_proc where pronamespace='public'::regnamespace and proname like 'landing%')
select 'rel', relname, r, has_table_privilege(r, rels.oid, 'SELECT') sel, has_table_privilege(r, rels.oid, 'INSERT') ins from rels cross join roles
union all select 'fn', f, r, has_function_privilege(r, funcs.oid, 'EXECUTE'), null from funcs cross join roles order by 1,2,3;
```

**Behavioural denial test:** a DO block that switches role and records outcomes, then raises, so it returns results and rolls everything back:
```sql
do $$ declare res text := ''; begin
  set local role anon;
  begin perform count(*) from public.landing_events; res := res || 'ALLOWED'; exception when insufficient_privilege then res := res || 'denied'; end;
  reset role;
  raise exception 'ROLLBACK-ONLY RESULTS: %', res;
end $$;
```
The same pattern works as `service_role` for exercising `landing_issue_link` → `landing_ingest` → views, with nothing persisted. Also confirm through REST with the **publishable** key that every `landing_*` table, view and RPC returns 401/42501.

## Applying a migration

1. Pre-check the catalog for name collisions (`pg_class`, `pg_proc`, `pg_type`, `pg_constraint`, `pg_policies` for `landing%`) and the Postgres version.
2. Apply through the Supabase connector's `apply_migration` with the **exact** file content. Don't hand-edit SQL; change the file and the tests instead.
3. Prove it is byte-identical: `select md5(statements[1]), octet_length(statements[1]) from supabase_migrations.schema_migrations where name = '<name>'` must equal the file's md5 and size.
4. Verify objects, RLS, the grant matrix, the denial tests and the advisor (`get_advisors security`: "RLS enabled, no policy" is expected INFO).
5. Record the application in `LANDING_LINK_ATTRIBUTION.md`, including the date, the recorded version and the md5.

Locally, run `PGLITE_DIR=<dir with @electric-sql/pglite> node scripts/landing-attribution-migration-check.mjs`. It runs the migration twice and exercises every function, view, tier rule, retention rule and grant.

## Egress-safe query patterns

The project has hit its egress quota before. The whole outreach corpus is large, and automation fails closed when Supabase is unreadable (`[FATAL] [outreach-read] … unreadable`), so keep egress down:
- **Name columns:** never `select=*` over REST. The dashboard constants (`ISSUANCE_COLUMNS`, …) are the pattern.
- **Bound every read:** by time (`sent_at`, `started_at`, `booked_at`) and by id lists in `in.("…")` chunks of about 80. Page with `limit`/`offset` and a hard row cap.
- **Fetch lead details narrowly:** only for the ids you display (`outreach_leads?select=lead_id,company,contact_name,email&lead_id=in.(…)`), never the corpus.
- **Aggregate in SQL:** counts and GROUP BY through the connector's `execute_sql`, not raw rows.
- **Check health cheaply:** status codes come from edge logs (`query_logs`), for example:
  ```sql
  select toStartOfFifteenMinutes(timestamp) w, log_attributes['response.status_code'] s, count() n
  from logs where source='edge_logs' group by w, s order by w, s
  ```
  Prefer that to repeated probing. Avoid app endpoints that read the full corpus (`/api/crm/health`, the Calendar dry-run) for routine checks.

## Useful targeted checks

```sql
-- Duplicate protection (all should be 0)
select count(*) from (select page_load_id, seq from landing_events group by 1,2 having count(*)>1) d;
select count(*) from (select session_id, event_name from landing_events
  where event_name in ('visible','engaged_10s','video_playing','video_complete','booking_embed_loaded')
  group by 1,2 having count(*)>1) d;

-- Issuances vs tracked sends in a window (backfill health)
select (select count(*) from landing_link_issuances where sent_at >= now() - interval '1 day') issued_sent,
       (select count(*) from crm_events where event_type in ('follow_up_sent','booking_link_sent')
          and metadata->'landingLink'->>'tracked' = 'true' and occurred_at >= now() - interval '1 day') tracked_sends;

-- Unresolved sessions (a token that matched no issuance)
select count(*) from landing_sessions where resolution = 'pending';

-- One session's facts: NAME the columns, never select token_hash
select resolution, is_test, source, visible_at, engaged_at, engaged_basis, interacted_at, intent_at, seconds_after_send
from landing_session_facts where issuance_id = '<issuance uuid>';
```
