# Current production baseline

**Last reconciled:** 2026-09-21
**Start all new work from:** `main` or `dev/current-production-baseline` (kept identical)

Read this file before starting any code change. If production has moved since the date above, re-verify it before trusting anything below. Check the Railway deployment's commit and branch, then re-run the checks listed at the end.

## Production

| Item | Value |
|---|---|
| Railway project / service | `modest-peace` / `SalesPipeline2` (https://receptionist.scalelabai.ca) |
| Current Railway production source | `cursor/staffing-agent-shadow-production-7402` at `442ba7004e65b01744ecef59bebcd031d979fbff` ("fix: constrain research ICP V1 JSON output and retain response audits") |
| Canonical development baseline | `main` and `dev/current-production-baseline`, kept identical. Aligned at `d44d0ca` (production `442ba70` plus documentation) and then this documentation correction. They contain no code beyond production. |

The canonical development baseline and the Railway production source are different branches. Merging into `main` does not deploy anything. Production changes only when a revision is deployed from its Railway source branch.

## What is live, shadow or off (verified from production logs, 2026-09-21)

**Live (can mutate CRM state or send):**
- Cold outreach sending (`SENDING_ENABLED`): dental and industrial staffing. Two active Gmail senders; caps of 5 per inbox per window, 10 per run and 80 per day. The third sender is registered but inactive.
- Staffing campaign sends (`STAFFING_LAUNCH_ACTIVATED_AT` is set and in the past).
- Reply observation, classification and handling, including staffing qualification replies and auto booking, qualify, send-info and question replies above the confidence floor.
- Stage/recovery sequences (`STAGE_SEQUENCES_ENABLED`): the pass runs every send window.
- Google Calendar booking sync (`GOOGLE_CALENDAR_BOOKING_SYNC_ENABLED`): every 5 minutes.
- Demo-intent backstop: every 3 minutes.
- Durable send reservations (`[send-lock] enabled`).
- Supabase: ColdEmail/outreach reads come **from Supabase** (`SUPABASE_OUTREACH_MODE=primary`, "automation corpus from Supabase"). Canonical activity is mirrored to Supabase after each Sheets write.

**Shadow (no send, CRM or queue authority):**
- Staffing Conversation Agent: `enabled=true mode=shadow`, dedicated key. Writes only `staffing_agent_shadow` activity events.
- Research/ICP Agent V1: flags `true` / `shadow`. Manual `POST /api/agents/research/test` only; nothing is scheduled. Writes only `research_icp_runs`. Two live runs so far, both `failed` (MALFORMED_MODEL_JSON, then UNSUPPORTED_EVIDENCE); no successful fit classification yet.

**Failing:**
- Smartlead reconcile: the hourly run logs `AUTHENTICATION_ERROR` for "Dental Campaign Test".

**Not verified (do not assume). Check Settings or the Railway variable before relying on these:**
- Outreach write authority (`SUPABASE_OUTREACH_WRITES`: `sheets` or `supabase`). It isn't observable from logs. Check it before any change that writes ColdEmail state.
- Roofing survey reply flow (`ROOFING_SURVEY_REPLY_FLOW_ENABLED`). It is off unless set to `true`.
- `generic_follow_up_v1` re-engagement (`GENERIC_REENGAGEMENT_ENABLED` and related flags). An earlier note recorded it as held by three independent rollout locks.
- Smartlead live mutation mode.

## Supabase migrations already applied in production

Do not re-run these.

| Migration | Evidence |
|---|---|
| `20260902000000_crm_events.sql` | Activity mirror is enabled and healthy |
| `20260912000000_outreach_leads.sql` | Production reads the outreach corpus from Supabase |
| `20260921000000_research_icp_runs.sql` | Research runs are persisted (`outputs/research-icp-v1-deployment/`) |
| `20260921010000_research_icp_provider_responses.sql` | Applied with the `442ba70` release (`outputs/research-icp-v1-serialization-deployment/deployment-report.md`) |

## Where the agent work lives

- Research/ICP V1: `integrations/research-icp/*`, `RESEARCH_ICP_V1.md`, `RESEARCH_ICP_V1_SERIALIZATION_FIX.md`, `test/research-icp.test.js`. Production lineage: `883f6a0` → `442ba70`. The older `9177d8b` on `codex/research-icp-v1` has identical agent code and is superseded.
- Staffing Conversation Agent: `integrations/staffing-conversation-agent.js`, `staffing-agent-{schema,shadow,context}.js`, `test/staffing-conversation-agent.test.js`. Commits `7bf9933`, `e6a930f`, `92b615f`.
- Architecture audit of the CRM decision flow: `salespipelineflowaudit.md`.

## Branches not to build on

| Branch | Status |
|---|---|
| `codex/research-icp-v1` | Stale. Its one commit is already in production as `883f6a0`. |
| `integrate/throughput-and-fairshare` | Stale. Behind production, with nothing unique. |
| `origin/cursor/staffing-conversation-agent-shadow-9196` | Stale. Same agent code as production `7bf9933`, built on an older base. |
| `origin/cursor/analytics-integrity-audit-f212` | Stale. Reworked into production as `8dc2444` / `4d964a7`. |
| `feat/fair-share-scheduled-allocator`, `fix/intent-backstop-cron-collision` | Stale. Their patches are already in production. |
| `origin/fix/audit-2026-07`, `codex/smartlead-hardening` | Very old (July/August). Unmerged history; review before any reuse. |
| `backup/local-checkout-2026-09-21` | Archive of the pre-reconciliation working tree. Reference only; never merge. |
| `origin/cursor/staffing-batch3-sourcing-964b` | Data/sourcing branch (Batch 3 Apollo artefacts and runners), with no app code. Not a code base. |

All other `codex/*`, `cursor/*`, `fix/*`, `deploy/*` and `repair/*` branches are fully contained in production.

## Re-verification checklist

1. In Railway, confirm the latest successful deployment's commit and branch.
2. Run `git merge-base --is-ancestor <deployed-sha> dev/current-production-baseline`. It must succeed; if not, fast-forward this branch to the deployed commit first.
3. In the latest deploy logs, confirm the boot lines (`[staffing-shadow] init`, `[send-lock]`, `[supabase-mirror]`), `[StageSeq]` on a send run (it logs "disabled" when off), and `[Calendar sync] complete` (only logged when enabled).
4. Update this file and its date.

`OWNER_OPERATOR_GUIDE.md` is the operator manual. Where it and this file disagree about production state, this file is the more recently verified source.
