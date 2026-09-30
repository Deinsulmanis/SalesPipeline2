# Current production baseline

**Last verified:** 2026-09-30 Pacific (refs, Railway deployment, logs, read-only endpoints and read-only SQL)
**Start all new work from:** `main`

Read this before starting any code change. Everything under "Snapshot" was true
on the date above and goes stale; re-run the checklist at the end before relying
on it. Never trust a SHA written here without re-reading it from Railway and git.

## How the repository and production relate

| Ref | Role |
|---|---|
| `cursor/staffing-agent-shadow-production-7402` | **Railway production source.** A push (fast-forward only) to this branch deploys immediately. Only push here as a deliberate, verified deploy. |
| `main` | **Canonical development baseline.** Contains every production commit plus docs and project skills (`.claude/skills/`). Merging into `main` deploys nothing. |
| `dev/current-production-baseline` | **Retired.** Frozen at an older point that `main` fully contains. Do not build on it or keep it in sync. |

Workflow:

1. Branch from `main` (or from the production head if production is ahead of
   `main`, see step 4 of the checklist) for any code change.
2. To deploy: rebase or cherry-pick the change onto the **current production
   head**, run the full suite, and fast-forward the production branch. Other
   sessions deploy too, so re-read the production head and Railway's live commit
   immediately before pushing. Follow `.claude/skills/salespipeline2-outreach-safety/`
   for anything touching sending, replies, suppression or lead state.
3. After a deploy, bring `main` up to production: fast-forward if `main` has no
   unique commits, otherwise merge production into `main` taking production's
   version of every code, test and config file. Never merge `main` into the
   production branch.

On 2026-09-29 `main` was reconciled this way (merge `e06e8b0` of production
`72f9e285`, then merge `9541c1d` of production `f70e24f0`). Its code, test and config tree equals production exactly; `main`
additionally carries only documentation (`CURRENT_PRODUCTION_BASELINE.md`,
`OWNER_OPERATOR_GUIDE.md`, `salespipelineflowaudit.md`) and
`.claude/skills/salespipeline2-outreach-safety/`.

## Snapshot: production on 2026-09-29

Railway project / service: `modest-peace` / `SalesPipeline2`
(https://receptionist.scalelabai.ca), region us-west2.

**Production SHA:** `e9a7a01f8c4b7b7a5f14d869d1c7e004bb4e3ed8` (branch
`cursor/staffing-agent-shadow-production-7402`; Railway deployment
`cfab6c73`, SUCCESS). Deployed 2026-09-30 16:46 Pacific: `f70e24f` plus
`c0863ee` (modern email TLDs), `3f3a110` (staffing role-to-market evidence),
`2725508` (dental retired + soft Archive), `6065245` (roofing and med spa
retired) and `e9a7a01` (Archive row record scope).

**Roofing and med spa RETIRED (2026-09-30) and archived** with the dental
machinery: 174 roofing leads + 1 card (`offer_retired_roofing`), 348 med spa
leads + 3 cards (`offer_retired_med_spa`). The only live outreach offer is
staffing (547 leads). **Protected clients** (`lead-archive.js`
`PROTECTED_RECORDS`, exact card ids): Trade Select `mq4vq4pw2t0w6u6qwmp` and
SureSky Roofing `mq3i7yq86ri0ueadqtl` (contact recorded as "marman"), both
Closed/Won, never retired or archived; every retirement plan refuses to run
unless both are present exactly once, closed_won, un-archived. Moving either
card to another stage will therefore block all retirement dry runs until
`PROTECTED_RECORDS` is updated in a reviewed commit.

**Dental offer RETIRED (2026-09-30) and archived.** `integrations/lead-archive.js`
`RETIRED_OFFERS` makes every dental lead unsendable at routing, ownership,
queue admission, refill, sequences, demo intent and the final provider gate,
archived or not, restored or not. All 1,327 dental leads and their 10 Pipeline
cards were archived (`offer_retired_dental`) by the migration endpoint
`/api/ops/offer-retirement/dental`; a rerun plans 0. Non-dental lead rows were
byte-identical before and after. Archived leads keep every event and Gmail id,
leave active lists and counts, and live in the **Archive** workspace. Restore
(`/api/archive/leads/:id/restore`) returns a lead to Import or held Review,
never to a sending state. Do not re-enable dental by editing a template or a
campaign status: the offer gate is separate and fails closed.

**Live (can mutate CRM state or send):**
- Cold outreach over Gmail: five active senders (`primary`, `tryscalelabai`,
  `scalelabaiteam`, `deniels`, `deniels_tryscalelabai`). Daily limits are
  60/60/40/20/20, with global ceilings of 200 per day and 21 per window.
  `scalelabaiteam` is staffing-only. Windows are :00/:30, 07:00–11:30 Pacific,
  Mon–Fri. The boot cron line `(6/inbox, 12/run, 120/day, 2 active)` is stale
  display text; trust `/api/integrations/gmail-inboxes` → `capacity` and the
  per-window `[cap]` lines.
- Staffing campaign sends (the staffing-only sender sent its cap on the last send day).
- Reply observation: Gmail history observers on all five inboxes run in the
  :15/:45 check-only pass. Replies are classified from the prospect's own words
  only.
- Google Calendar booking sync every 5 minutes; every automation launch waits
  for a successful sync.
- Demo-intent backstop (every 3 minutes while armed).
- Durable send reservations (`[send-lock] enabled`, Postgres store).
- Supabase `outreach_leads` is canonical: mode `primary`, write authority
  `supabase` (`/api/integrations/supabase/stage3-parity`). Sheets is a mirror.
  Canonical activity is mirrored to Supabase after each Sheets write.
- The per-send final gate reads a single lead, not the whole corpus. Corpus
  egress is metered hourly in `[egress-meter]` logs.
- Landing-link attribution: the collector and reconciler are enabled, and
  `trackingEnabled: true` (`/api/landing/funnel` → `status`). See
  `LANDING_LINK_ATTRIBUTION.md`.
- Audited false-opt-out correction endpoint
  (`POST /api/coldemail/:id/false-opt-out-correction`). It is human-invoked only
  and never sends.
- **Multi-client architecture** (`integrations/clients/`; design and launch
  checklist in `docs/multi-client-architecture.md`). SalesPipeline2 stays an
  internal ScaleLab operator platform; managed clients never log in.
  - `CLIENT_LEDGER_ENABLED=true`: the client ledger tables are live, and every
    send also reads the client suppression list for that one lead (fails closed
    if unreadable).
  - **Explicit lead ownership is live:** `outreach_leads.client_id` (NOT NULL
    DEFAULT `scalelab`, FK `clients`) and ColdEmail column **Y** (`clientId`).
    **All 2,349 existing leads are owned by `scalelab`** (0 conflicts, 0 sender
    mismatches: `scripts/client-ownership-audit.js`).
  - **Supabase and Sheets client ownership are reconciled:** column Y backfilled
    for all 2,349 rows; `scripts/client-id-backfill.js` (dry run) reports 2,349
    ok, 0 fill, 0 mismatch, 0 conflict, 0 missing. The lead data checksum was
    identical before and after both migrations and the backfill.
  - Isolation is enforced at route validation, lead readiness, sender choice,
    the final gate, reservations, the Gmail provider boundary, observers and the
    reply loop. Email identity is tenant-scoped in code; the database still has
    the global email index (launch gate A).
  - Client send capacity (`[client-cap]` log line per pass): ScaleLab has no
    client cap (exactly the global 200/day, 21/window); Jole 0/0.
  - All five senders resolve to `scalelab` (`/api/integrations/gmail-inboxes`
    shows `clientId`; `?client=<id>` returns only that client's inboxes).
  - **Client-aware dashboard:** the sidebar comes from each client's config
    (`integrations/clients/navigation.js`; `workspaces` and `defaultWorkspace`
    in `client-configs.js`). ScaleLab keeps every module. Jole has Client Ops,
    Pipeline, Inbox, Bookings, Campaigns, Analytics and Settings, served by
    server-scoped `GET /api/clients/:id/{pipeline,inbox,settings}` plus the
    existing overview, meetings and opportunities routes. URLs are
    `#<workspace>` for ScaleLab and `#<client>/<workspace>` for other clients.
    Hidden navigation is never the boundary; every client route filters on the
    server.

**Jole Enterprise (managed client) — NOT activated:**
- `lifecycle_status = onboarding_pending` (agreement not signed, onboarding form
  not returned, remaining $175 setup balance unpaid).
- `active = false`; `sending = false` (every send path refuses with
  `client_inactive`); daily capacity **0**, window capacity **0**.
- Jole leads **0**; Jole senders **0**; Jole sends **0**; ledger rows 0.
- Campaign #1 `JOLE_DC_MISSION_CRITICAL`: **draft** (template not ready).
  Campaigns #2 `JOLE_GULF_INDUSTRIAL` and #3 `JOLE_SHIPYARD`: **disabled
  placeholders**.
- Verify: `GET /api/clients`, `GET /api/clients/jole/overview`,
  `GET /api/clients/jole/settings` (caps 0, no inboxes).

**Shadow (no send, CRM or queue authority):**
- Staffing Conversation Agent / Agent v2: `[staffing-shadow] init enabled=true mode=shadow`, every authority flag `false`.
- Research/ICP Agent V1: manual `POST /api/agents/research/test` only; writes only `research_icp_runs`.

**Pending production validation:**
- No send window has run on the multi-client code (`72f9e285` and later) yet. At the first window (07:00 Pacific,
  Mon-Fri) watch `[client-cap]` (ScaleLab `allowed` with `remaining` equal to the
  window ceiling; Jole `blockedBy: client_inactive`) and confirm ScaleLab sends,
  reservations confirm and `[cap]` advances normally.

**Failing:**
- Smartlead reconcile: every hourly run at :12 logs `AUTHENTICATION_ERROR` for
  "Dental Campaign Test". Smartlead live mutation stays disabled; uncertain
  Smartlead reservations are manual-only.

**Not re-verified (check before relying on them):**
- Stage/recovery sequences (`STAGE_SEQUENCES_ENABLED`; `[StageSeq]` on a send run).
- Roofing survey reply flow (`ROOFING_SURVEY_REPLY_FLOW_ENABLED`, off unless `true`).
- `generic_follow_up_v1` re-engagement (`GENERIC_REENGAGEMENT_ENABLED` and related locks).

## Database migrations

Supabase (`supabase/migrations/`). All of these are applied in production; do
not re-run them.

| Migration | Evidence |
|---|---|
| `20260902000000_crm_events.sql` | `crm_events` readable; activity mirror healthy |
| `20260912000000_outreach_leads.sql` | Production reads/writes `outreach_leads` |
| `20260921000000_research_icp_runs.sql` | `research_icp_runs` readable |
| `20260921010000_research_icp_provider_responses.sql` | Adds the `research_icp_runs.provider_responses` column; the column is readable |
| `20260923000000_agent_v2_shadow_decisions.sql` | Table exists; denies `service_role` reads by design |
| `20260925000000_landing_link_attribution.sql` | `landing_link_issuances`, `landing_sessions` and `landing_events` are readable |
| `20260930000000_client_ledger.sql` | Applied 2026-09-29 (recorded as version `20260930015011`, name `client_ledger`). `clients` = `jole`, `scalelab`; six tables with RLS; 0 rows |
| `20260930010000_outreach_leads_client_id.sql` | Applied 2026-09-29 (recorded as version `20260930015039`, name `outreach_leads_client_id`). `client_id` NOT NULL DEFAULT `scalelab`, FK present, `outreach_leads_client_email_key` added; global `outreach_leads_email_normalized_key` retained |

**Not applied (deliberately):** `20260930020000_outreach_leads_tenant_scoped_email.sql`
(drops the global email index); see launch gate A. All three client migrations
were validated beforehand on real PostgreSQL 17.9 (UTF-8), 46/46 checks
(`scripts/validate-client-migrations.js`).

Send-lock Postgres (`db/migrations/`): `20260917000000_outbound_send_reservations.sql`
backs the live send lock (`/api/send-lock/health` → `kind: postgres`).
`anthropic_usage_events` is created on demand by `integrations/anthropic-usage.js`.

## Jole launch gates (all open)

**A. Before the first Jole lead import:**
- Fix the Sheets-mode dashboard reads (`A:O` + `Q:X`) to read `clientId`
  (column Y); today those fallback reads infer ownership.
- Apply `20260930020000_outreach_leads_tenant_scoped_email.sql`.
- Set `OUTREACH_EMAIL_UNIQUENESS=client` when cross-client email ownership is
  needed (until then imports refuse an address any client already has).

**B. Before Jole sending:**
- Fix demo-intent per-client metering (warm/intent sends are refused for an
  inactive client today but are not counted against client capacity).
- Provision Jole sending domains and inboxes; warm the senders.
- Add Gmail credentials and `GMAIL_INBOX_REGISTRY_JSON` entries with
  `"clientId": "jole"`.
- Configure Jole client send caps (and ScaleLab's reservation) in
  `integrations/clients/client-configs.js`.
- Finalize campaign copy; mark the template ready and the campaign approved.
- Activate Jole only after the agreement is signed, the onboarding form is
  returned and the remaining $175 is paid (reviewed commit: onboarding items
  true, `activation.activatedBy` / `activatedAt`, `lifecycleStatus: 'active'`).
- Separately authorize sending: `sending.enabled: true` in a reviewed commit
  **and** `CLIENT_SENDING_AUTHORIZED=jole` on the service.

**C. Production validation still pending:**
- The first real send window on the multi-client code: watch `[client-cap]`
  and confirm ScaleLab still sends normally.

## Where things live

- Outreach safety (sending, replies, suppression, holds, reservations,
  canonical state, deploy verification): `.claude/skills/salespipeline2-outreach-safety/`.
- Landing-link attribution: `LANDING_LINK_ATTRIBUTION.md`, `integrations/landing-*.js`.
- Research/ICP V1: `integrations/research-icp/*`, `RESEARCH_ICP_V1.md`, `RESEARCH_ICP_V1_SERIALIZATION_FIX.md`.
- Staffing Conversation Agent / Agent v2: `integrations/staffing-*.js`, `integrations/agent-v2-*.js`, `docs/agent-v2-*.md`.
- Architecture audit of the CRM decision flow: `salespipelineflowaudit.md`.
- Managed clients (registry, ownership, isolation, suppression scopes, capacity,
  ledger, lifecycle): `integrations/clients/`, `docs/multi-client-architecture.md`.
  Scripts: `client-ownership-audit.js`, `client-id-backfill.js`,
  `validate-client-migrations.js`.
- Operator manual: `OWNER_OPERATOR_GUIDE.md`. Where it disagrees with this
  file about production state, trust the more recently verified source and re-check.

## Branches with commits not on `main` (2026-09-26; `feat/multi-client-jole` added 2026-09-29)

Every other remote branch is fully contained in `main`, or its commits are
already on `main` as equivalent patches (for example the per-incident fix and
correction branches from 2026-09-25/26).

| Branch | Status |
|---|---|
| `docs/landing-attribution-skill` | One docs-only commit: a project skill for landing-link attribution. Not yet on `main`; review, then merge if wanted. |
| `cursor/setup-cloud-agent-environment-e353` | One commit adding `.cursor/environment.json`. Not on `main`. |
| `cursor/staffing-conversation-agent-shadow-9196` | Stale: an older build of the agent that is in production. |
| `cursor/analytics-integrity-audit-f212` | Stale: reworked into production. |
| `cursor/staffing-batch3-sourcing-964b` | Data/sourcing artefacts, no app code. Not a code base. |
| `codex/smartlead-hardening`, `fix/audit-2026-07` | Very old (July/August), unmerged. Review before any reuse. |
| `dev/current-production-baseline` | Retired (see above). Fully contained in `main`. |
| `feat/multi-client-jole` | Development branch of the multi-client work. Its code is on `main` and in production as the equivalent cherry-picked commits (`c00adb4`..`72f9e28`); its `.claude/skills` code-map entry was carried into `main` with this refresh. Do not build on it. |

## Re-verification checklist

1. Railway: the latest successful deployment's `commitHash` and branch
   (it must be the production branch).
2. `git fetch origin` and compare `origin/cursor/staffing-agent-shadow-production-7402`
   with that `commitHash`. They must match; if not, a deploy is in flight or failed.
3. `git merge-base --is-ancestor <production-head> origin/main`. If it fails,
   production is ahead of `main`; reconcile `main` as described above before
   starting work from it.
4. Logs: the boot lines (`[staffing-shadow] init`, `[send-lock] enabled`,
   `[supabase-mirror] enabled`), `[Calendar sync] complete`,
   `[GmailObserver:*] history_incremental_ok` in the next :15/:45 pass, and no
   `402` or `[FATAL]`.
5. Read-only endpoints: `/api/integrations/gmail-inboxes` (caps, observers,
   `clientId`), `/api/integrations/supabase/stage3-parity` (mode, write
   authority), `/api/send-lock/health`, `/api/landing/collector-health`,
   `/api/landing/funnel`, `/api/clients`, `/api/clients/jole/overview`, and
   `[client-cap]` in a send or check-only pass.
6. Ownership: `node -r dotenv/config scripts/client-ownership-audit.js` (0
   conflicts) and a `scripts/client-id-backfill.js` dry run (0 fill, 0 mismatch).
7. Update this file and its date.
