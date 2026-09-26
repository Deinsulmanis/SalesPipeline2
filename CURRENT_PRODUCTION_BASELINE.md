# Current production baseline

**Last verified:** 2026-09-26 (refs, Railway deployment, logs and read-only endpoints)
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

On 2026-09-26 `main` was reconciled this way. Its tree equalled the production
tree plus documentation and `.claude/skills/salespipeline2-outreach-safety/`.

## Snapshot: production on 2026-09-26

Railway project / service: `modest-peace` / `SalesPipeline2`
(https://receptionist.scalelabai.ca), region us-west2.

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

**Shadow (no send, CRM or queue authority):**
- Staffing Conversation Agent / Agent v2: `[staffing-shadow] init enabled=true mode=shadow`, every authority flag `false`.
- Research/ICP Agent V1: manual `POST /api/agents/research/test` only; writes only `research_icp_runs`.

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

| Migration | Evidence (2026-09-26) |
|---|---|
| `20260902000000_crm_events.sql` | `crm_events` readable; activity mirror healthy |
| `20260912000000_outreach_leads.sql` | Production reads/writes `outreach_leads` |
| `20260921000000_research_icp_runs.sql` | `research_icp_runs` readable |
| `20260921010000_research_icp_provider_responses.sql` | Adds the `research_icp_runs.provider_responses` column; the column is readable |
| `20260923000000_agent_v2_shadow_decisions.sql` | Table exists; denies `service_role` reads by design |
| `20260925000000_landing_link_attribution.sql` | `landing_link_issuances`, `landing_sessions` and `landing_events` are readable |

Send-lock Postgres (`db/migrations/`): `20260917000000_outbound_send_reservations.sql`
backs the live send lock (`/api/send-lock/health` → `kind: postgres`).
`anthropic_usage_events` is created on demand by `integrations/anthropic-usage.js`.

## Where things live

- Outreach safety (sending, replies, suppression, holds, reservations,
  canonical state, deploy verification): `.claude/skills/salespipeline2-outreach-safety/`.
- Landing-link attribution: `LANDING_LINK_ATTRIBUTION.md`, `integrations/landing-*.js`.
- Research/ICP V1: `integrations/research-icp/*`, `RESEARCH_ICP_V1.md`, `RESEARCH_ICP_V1_SERIALIZATION_FIX.md`.
- Staffing Conversation Agent / Agent v2: `integrations/staffing-*.js`, `integrations/agent-v2-*.js`, `docs/agent-v2-*.md`.
- Architecture audit of the CRM decision flow: `salespipelineflowaudit.md`.
- Operator manual: `OWNER_OPERATOR_GUIDE.md`. Where it disagrees with this
  file about production state, trust the more recently verified source and re-check.

## Branches with commits not on `main` (2026-09-26)

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
5. Read-only endpoints: `/api/integrations/gmail-inboxes` (caps, observers),
   `/api/integrations/supabase/stage3-parity` (mode, write authority),
   `/api/send-lock/health`, `/api/landing/collector-health`, `/api/landing/funnel`.
6. Update this file and its date.
