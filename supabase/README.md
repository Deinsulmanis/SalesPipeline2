# Supabase — Stage 1 (shadow mirror)

Google Sheets is the authoritative CRM database. Stage 1 adds a **read-nothing,
depend-on-nothing shadow copy** of canonical activity so the data can be
inspected in Postgres before anything is migrated.

Nothing in production reads from Supabase. If Supabase is unconfigured,
unreachable, or failing, the application behaves exactly as it does today.

---

## 1. Environment variables

Add these **only when you are ready to switch mirroring on**. With either
missing, the app logs `[supabase-mirror] disabled` at boot and every mirror call
is a no-op.

| Variable | Value | Where |
|---|---|---|
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` | Project Settings → Data API |
| `SUPABASE_SECRET_KEY` | the `sb_secret_…` key | Project Settings → API Keys |

`SUPABASE_SERVICE_ROLE_KEY` is accepted as a fallback for older projects that
still issue the legacy `service_role` JWT.

**Server-only.** The secret key must never appear in `public/index.html`, any
frontend bundle, any API response, or the repository. It is read from the
environment at call time and used only as a request header.

Do **not** use the publishable/anon key here — it is subject to RLS, and this
table has RLS enabled with no policy, so it would read and write nothing.

> These have not been added to Railway. Adding them is what turns mirroring on.

## 2. Apply the migration

`migrations/20260902000000_crm_events.sql` creates `public.crm_events`. It is
idempotent (`create table if not exists`, `create index if not exists`), so
re-running it is safe.

```bash
# Supabase CLI, against a linked project
supabase db push

# or paste the file into the SQL editor
```

> Not yet applied to any project.

## 3. Verify

```bash
curl -u "$DASHBOARD_USER:$DASHBOARD_PASSWORD" \
  https://<host>/api/supabase/mirror-health
```

Reports whether the mirror is configured, whether it is reachable, how many
events it holds, the newest mirrored event, and the gap against the Google
Sheets count. It returns no secret and no project URL, and it is deliberately
**not** part of `/api/crm/health` — Stage 1 must never influence an operator
decision.

## 4. Backfill

Dry run by default; writing needs `--apply`. Safe to run repeatedly — every
write is an upsert keyed by the canonical event id.

```bash
node scripts/supabase-backfill.js              # dry run over the whole sheet
node scripts/supabase-backfill.js --limit=500  # dry run, first 500
node scripts/supabase-backfill.js --apply      # write
```

It authenticates to Google with the **read-only** Sheets scope, so it cannot
modify the authoritative store even if asked. It loads no mail client and no
agent, so it cannot send. It touches one table, so it cannot alter Pipeline
state or automation.

## 5. What is mirrored

The existing canonical activity model — the `ColdCallActivity` sheet — not a new
one. Identifiers, timestamps and metadata only.

`content` (email bodies and reply text) is **not** mirrored.

Every attribution column is nullable. Most historical activity predates
campaign, sender and sequence attribution, and a null is the truthful record of
that; nothing is defaulted or inferred to fill the gap.
