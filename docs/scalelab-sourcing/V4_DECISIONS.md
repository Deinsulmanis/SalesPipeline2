# ScaleLab Industrial Staffing V4: decisions and repo conflicts

**Recorded:** 2026-11-18
**Reference:** [`ScaleLab_AI_Industrial_Staffing_ICP_and_Sourcing_Playbook.md`](ScaleLab_AI_Industrial_Staffing_ICP_and_Sourcing_Playbook.md) (v1.0). It is the default operating reference for every new ScaleLab lead-sourcing task. Read it first.

**Status (2026-11-19):** Adyntel and Jev are connected (see the tool table). Docs only otherwise. No V4 code, campaign registration, import path, lead, credit spend, queue or send exists yet. Leads are first sourced on 2026-11-19 at the earliest.

## Owner decisions (2026-11-18)

1. **New campaign: Industrial Staffing V4.**
   - It has its own campaign id, template, version and lead profile. Intended id: `industrial_staffing_employer_acquisition_v4`.
   - It is registered not live until a separate reviewed activation.
   - V1 (completed), V2 (registered, not live), Staffing Outreach Campaign 2 and all Jole data stay untouched.
2. **Jev and Adyntel.** The owner connects them when ready to run the workflow.
   - Until then, the ICP gate (Stage 2), ad evidence (Stage 3) and scoring (Stage 5) fail closed.
   - No vendor or model substitutes them. That includes Firecrawl ad providers and the `research_icp` agent.
3. **Scoring, tags and copy on every lead.** Each V4 lead carries all of this:
   - the ICP decision with its evidence;
   - the ad-intent class;
   - every signal component, kept separate;
   - the total score, `scoring_version`, evidence coverage and priority bucket;
   - the copy tier.

   Each lead also gets a visible tag, e.g. `V4|PASS|HIGH_PRIORITY|EMPLOYER_ACQUISITION|TIER_A`. The copy variant is assigned from that evidence in code.
4. **V4 is a brand-new campaign.** It does not inherit these V2 constraints:
   - the locked ICP score anchors and the pre-reveal subtotal of at least 70;
   - mandatory `ROLE_MARKET_VERIFIED` (Tier A only) at import;
   - the `BROADER_TECHNICAL` vertical;
   - P1A/P1B buyer randomization.

   Tier B is valid.
5. **Buyer order follows the playbook.**
   - Order: Owner / Founder / President / CEO / Managing Partner, then CRO / VP Sales / VP BD, then Director of Sales / BD.
   - Every other title is HOLD.
   - No randomization. One best buyer per organization.
6. **Copy.** The owner writes V4 copy after seeing the quantity and quality of sourced leads. Do not draft, reuse (V1/V2) or assume copy. Copy-tier assignment waits for approved copy.
7. **Free-mailbox addresses (default, owner may override).**
   - A verified address on a free mailbox domain is eligible only when evidence ties it to the agency, per playbook Stage 6.5.
   - Catch-all addresses go to review.

## Existing repo behavior V4 must not inherit

| Area | Current behavior | Consequence for V4 |
|---|---|---|
| Personalization | `personalizeStaffingLead` (`integrations/staffing-personalization.js`) is bound to the V1 campaign id. It runs its own ICP gate (`icpFit` → `INDUSTRIAL_STAFFING_NOT_CONFIRMED` / `ICP_MISMATCH`). | V4 reuses its Haiku fact extraction, fact audit and opening audit without the ICP gate. Genuine identity or eligibility contradictions go to human review. Needs a reviewed code change. |
| V2 import | `integrations/staffing-v2-import.js` refuses unknown fields. It also requires V2 identity, the V2 score anchors and Tier A role + market. | V4 needs its own import path and profile schema. The V2 import and profile are not edited. |
| V1 campaign | Completed (`integrations/lead-archive.js` `COMPLETED_CAMPAIGNS`). Every send gate refuses it. | Never route V4 leads to V1. |
| Free-mailbox domains | The V2 import refuses gmail.com, outlook.com and similar. | The V4 rule follows decision 7. |
| Model | `STAFFING_CAMPAIGN.model` = `claude-haiku-4-5` in code. Production is not verified. | Verify before the first personalization run. |

## What still applies unchanged

- Dedupe against all ScaleLab history, at company/domain and contact level (V1, Campaign 2, V2, queue, sent, clients).
- The suppression union (email, domain, company).
- Supabase is the source of truth.
- `guardProviderSend` and send reservations.
- Imports are Import-stage only and dry run by default.
- No queue, cap change or send without explicit authorization.
- See `.claude/skills/salespipeline2-outreach-safety/`.

## Tool connection status (updated 2026-11-19)

| Tool | Status | How to use it |
|---|---|---|
| **Adyntel** | Connected through **cloud environment variables** `ADYNTEL_EMAIL` and `ADYNTEL_API_KEY` (environment "SalesPipline2"). The claude.ai connector (`mcp.adyntel.com`) failed: claude.ai demanded OAuth, which Adyntel's server does not offer. Do not retry the connector. | Call Adyntel's REST API directly. Auth is `email` + `api_key` **in the request body/params**, not a header. Endpoint docs: https://docs.adyntel.com/llms.txt (Google, Meta, LinkedIn and TikTok ad libraries; credit balance). Load the variables in memory only. Never print, log or commit them. **First call: the credit-balance check.** No paid lookups until the run budget is approved. |
| **Jev (TypeSafe AI)** | **Connected 2026-11-19** as a **network secret** for `api.typesafe.ai` on environment "SalesPipline2". The proxy injects `Authorization: Bearer <key>`. No env var holds it; code that wants `TYPESAFE_API_KEY` gets the placeholder `proxy-injected`. `GET /v1/models` answered 200 (models `jev-latest`, `jev-preview`). Key validity is not yet proven by a scored call. | `POST https://api.typesafe.ai/v1/systemone` with `model`, `state` (the evidence only) and `questions` (`choice` / `score` / `noul`). Docs: https://docs.typesafe.ai. Use it for the Stage 2 ICP gate and Stage 5 scoring. Pin the model version used in each run's report. Jev returns confidences: keep classification confidence separate from evidence coverage, and keep exact calculations (point totals, buckets) in code. Do not substitute `research_icp`, Firecrawl or another model. |
| **GetLeads** | Available as an MCP connector (`mcp__GetLeads_MCP__*`). | Company discovery only at Stage 1. Check `get_fair_use` and balance before batches. |
| **Apollo** | Available as an MCP connector (`mcp__Apollo_io__*`). | Selective contact reveals at Stage 6 only, within an approved credit budget. Check `apollo_usage_stats_credit_usage_stats` first. |
| **Firecrawl** | Available. It also lists an "adyntel" provider. | Do **not** use it as an Adyntel substitute without owner approval: it bills through Firecrawl, not the owner's Adyntel account. |

## First-run checklist (when the owner says go)

1. Read the playbook and this file.
2. Confirm the run scope: count, geography and credit budgets. Default: a read-only pilot of up to 100 companies with zero paid reveals.
3. Confirm tool status. Run the free Adyntel credit-balance check, check GetLeads and Apollo balances, and run Jev `GET /v1/models`. If any tool fails, say so and stop before the stage that needs it.
4. Run the playbook pipeline in order and stop at the review artifacts (playbook §5):
   - `run-report.md`
   - `company-qualification.csv`
   - `ad-intent-and-signals.csv`
   - `ranked-companies.csv`
   - `approved-contacts.csv`
   - `review-holds.csv`

   Each lead carries the V4 tag and its full score breakdown.
5. Build the V4 campaign, profile and import path only when authorized. Copy waits for the owner. Never import, queue or send without explicit authorization in the current task.
