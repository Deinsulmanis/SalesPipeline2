# ScaleLab V4: send-ready lead pipeline

**Status (updated 2026-11-20):** approved and in use. The pilot and wave 1 ran on it. Its leads feed **Industrial Campaign 3**, which is live in production; see [`INDUSTRIAL_CAMPAIGN_3_WORKFLOW.md`](INDUSTRIAL_CAMPAIGN_3_WORKFLOW.md) for everything after the review files (import, queue, sending).
**Scripts:** the reusable, env-configured toolkit is [`tools/`](tools/README.md). The `runs/*/scripts/` folders are the historical record of what each run executed; do not edit or rerun them.
**Based on:**
- The owner's generic `send-ready-lead-pipeline` skill (tool order).
- `ScaleLab_AI_Exact_ICP_Qualification_Spec.md` (ICP, buyer and scoring rules).
- `V4_DECISIONS.md`.
- Lessons from the 2026-11-19 pilot (`runs/v4-pilot-2026-11-19/run-report.md`).

**What's added:** Adyntel in two places, an intent-first discovery lane, and pre-reveal dedupe fixes.

## Why the pilot was slow and low-yield

| Pilot problem | Cause | Fix in this pipeline |
|---|---|---|
| Small, overlapping pool (about 250 GetLeads matches, 20% already contacted in V1) | One paid discovery source with narrow keyword filters | Apollo `organizations_lookup` (free) as the main source, GetLeads only as a top-up, plus an **Adyntel intent lane** (step 1B) |
| 32% of companies unreadable or wrong-domain | Vendor domains not checked before research | A free **domain pre-screen** (step 2): DNS, HTTP status, final redirect domain, parked/for-sale detection, title-vs-name match |
| Duplicates found late (Lone Star → Full Steam, Lingo, TEC), after money was spent | Dedupe only on the listed domain | Dedupe on **listed domain + final redirect domain + parent/"family of companies" names** found on the site, before any paid step |
| Many Jev passes and re-crawls | Excerpt filter missed short menu lines and footer addresses; extra passes added mid-run | One crawl that captures service menus, addresses and phones, and **one fan-out Jev request per company**. A recovery pass runs only for borderline scores. |
| 51 GetLeads credits on contacts for about 2 buyers | Paid contact search by title | **No paid buyer search.** Buyers come from site team pages plus free Apollo people search; paid **reveal only for a named buyer** |
| Apollo waterfall cost 2 credits per person | Waterfall is on by default | **Standard reveal, waterfall off:** 1 credit per match |
| 1 of 24 PASS companies had current employer-facing ads | Ads checked only after random discovery | The intent lane finds **advertisers first**, so the 40-point signal is concentrated in the candidate pool |
| Global Suppression sheet never checked | No Google service account in the cloud session | Resolved: the Campaign 3 import checks the global Suppression sheet server side, in production, before writing any lead |

## Pipeline

Approval stops are marked **[STOP]**. Budgets are set once per run in the run brief (count, GetLeads, Adyntel, Jev, Apollo caps). Spend is reported at every stop.

### 0. Run brief
- Load `ScaleLab_AI_Exact_ICP_Qualification_Spec.md` and `V4_DECISIONS.md`.
- Write `run-brief.json`: target send-ready count, caps per tool, keyword sets, lookback windows (ads 30 days; hiring and expansion 90 days).
- Check free balances: GetLeads `get_fair_use`, Adyntel `credits_check`, Apollo `apollo_usage_stats_credit_usage_stats`, Jev `GET /v1/models`.

### 1. Discover (two lanes, merged by root domain)

**1A. Breadth lane** (ICP fit first):

| Tool | Use | Cost |
|---|---|---|
| Apollo `apollo_organizations_lookup` | Keyword tags such as "industrial staffing", "light industrial staffing", "skilled trades staffing", "manufacturing staffing", "construction staffing", "welding staffing"; US; 1–500 employees. Save every page to JSON. | Free |
| GetLeads `count_companies` → `search_companies` | Only to top up when Apollo runs dry; use `exclude_domains` to avoid paying for known rows | 1 credit per row |

**1B. Intent lane (new, Adyntel)**: finds agencies already advertising to employers.

| Tool | Use | Cost |
|---|---|---|
| Adyntel `linkedin-keyword-search` | Employer-facing phrases, `country=US`, `dateOption=last-30-days`. For example: "staffing solutions for manufacturers", "light industrial staffing", "skilled trades staffing", "contract welders for your", "industrial staffing agency", "temp labor for your warehouse". | 1 credit per page |
| Adyntel `facebook_ad_search` | The same phrases, `country_code=US` | 1 credit per page |

- Output: advertiser name, page id and ad text.
- Resolve each advertiser to a domain with Apollo org lookup by name (free), or the ad's landing URL. An unresolved advertiser is dropped, not guessed.
- Meta search also returns job ads ("welders wanted"). The ad text goes to Jev in step 4 and gets classified there.
- **Validate first:** the first run tests 5 phrases (about 10 credits) and reports the hit rate before scaling the lane.

### 2. Free pre-screen and early dedupe (no spend)
One script, run in parallel:
- **Domain health:** DNS, HTTP status, final URL after redirects, parked/for-sale markers, and whether the page title matches the company name. Dead or parked → HOLD; a redirect to a new brand → research the new brand.
- **Dedupe** on listed domain, final domain and normalized name against ScaleLab `outreach_leads` (Supabase, read-only, all ScaleLab campaigns) and earlier run CSVs.
- Output: the funnel (discovered → net new → healthy) and `candidates.json`.

### 3. Crawl evidence (one parallel script)
- Plain HTTP, 15–20 concurrent: home, about, services/employers/industries, team/leadership, locations/contact, careers.
- Capture short service-menu lines (Temporary / Temp-to-hire / Direct hire), addresses, phones, and **parent or affiliate mentions** ("family of companies", "a division of", "acquired by").
- Fallback for JS-only sites: plain headless Chromium with default settings. **No bot-check evasion**; blocked sites stay HOLD.
- Firecrawl only with an owner-approved cap.
- **Re-dedupe** on any parent or affiliate names and domains found.

### 4. Qualify with Jev (one fan-out request per company)
One `POST /v1/systemone` per company, pinned model (`jev-1.14.0` or current), with every question at once:
- **ICP gate:** identity, business type, industrial line, service model, US operations, national chain.
- **Hands-on workers** vs management-only search.
- **Buyer verification** for each name/title extracted from team pages: is this person a current owner/executive or sales/BD leader at this company?
- **Ad classification** for lane-1B companies (employer acquisition / candidate / mixed / unclear).

Decisions are made in code with the pilot's fixed thresholds. A **recovery pass** re-asks only companies within 0.10 of a threshold, after re-reading the pages it needs. Cost about $0.0002 per company.

### 5. Demand signals (PASS companies only)
- **Adyntel per domain** for companies not already found in lane 1B: Google (US), Meta (US, active+inactive), LinkedIn (US). First page only; empty results are free (pilot average about 0.6 credits per company). `extract-text` (2 credits) only for current image ads that can't otherwise be classified. Advertiser identity must match the company or a parent stated on its own site.
- **Own-company sales/BD hiring:** the careers page or ATS board, re-opened at the source and dated.
- **Expansion and leadership news:** the company's own news page, or a web search with the article re-opened (headline and date recorded).
- **Score in code:** 40/25/15/10/10, version `initial-2026-11-18`, separate components, coverage and bucket. Every lead gets the V4 tag.

### 6. Buyer, one per company (free sources only)
1. Names and titles from the crawled team and leadership pages, verified by Jev in step 4.
2. Apollo `apollo_mixed_people_api_search` (free) by domain with playbook titles. A tier 1–3 title with `has_email` makes the person a candidate. Surnames are masked, so the identity is confirmed in step 8.
3. Playbook order, no randomization. Other titles go to HOLD.
4. No paid search for unnamed buyers. A company with no free-source buyer is a reported shortfall.

**[STOP] Reveal approval:** show the verified-buyer count, the Apollo credit estimate (1 per match) and the score distribution.

### 7. Reveal (Apollo, approved cap)
- Record the starting balance.
- `apollo_people_bulk_match` in batches of 10, by Apollo id where available.
- `run_waterfall_email`, `run_waterfall_phone`, `reveal_personal_emails` and `reveal_phone_number` all **false**.
- Save each batch to a pipe-delimited file as it returns, with flags: NO MATCH, NO EMAIL, WRONG PERSON, BUYER LEFT, DOMAIN MISMATCH, TITLE CONFLICT, LOW CONFIDENCE.
- Record the ending balance and credits used.

### 8. Contact QC (scripted)
- **Identity and title:** name, employer and title against the site or Apollo search pick. Hold real conflicts.
- **Email domain:** must be the company domain, or a related domain proven by redirect or on-site use. Otherwise reject.
- **MX:** `nslookup -type=mx` per domain. Proofpoint plus catch-all → HOLD. Other catch-alls are kept, flagged and queued last.
- **Live dedupe:** email, domain and name against ScaleLab `outreach_leads` (read-only SQL; see `tools/README.md`) and the V4 master. The global Suppression tab is checked again by the Campaign 3 import.
- Never use personal emails (aol, gmail and so on) unless on-site evidence ties them to the agency (V4 decision 7).

### 9. Wave files (one script)
- Write `Approved`, `Hold`, `No_Valid_Contact` and `Review_All` CSVs with reason codes, plus `ranked-companies.csv` and `run-report.md`.
- Contact files are never committed; the repository is public.
- The copy tier stays `COPY_TIER_PENDING` until the owner's V4 copy exists.

### 10–14. Import, queue, verify (live: Industrial Campaign 3)
These steps are implemented and live. Follow [`INDUSTRIAL_CAMPAIGN_3_WORKFLOW.md`](INDUSTRIAL_CAMPAIGN_3_WORKFLOW.md) §7:
- evidence file and read-only preview (`tools/build_evidence.py`, `scripts/staffing-v4-preview.js`);
- dry-run, then real import via `POST /api/staffing/campaign-3/leads/import`. The server selects the copy variant and checks suppression and dedupe;
- queue via `POST /api/coldemail/queue`, one call per freshly checked, cold-eligible ScaleLab mailbox (see §10 of that doc);
- verify via `/api/staffing/launch-readiness`.

Never use the managed-client import (`/api/clients/<client>/leads/import`); that is Jole's path. Import and queue each need the owner's explicit go-ahead in the current task. No deploy is needed to add leads.

## Expected funnel and cost per 600 discovered (estimate, not measured)

| Step | Rate assumed | Count |
|---|---|---|
| Discovered (1A + 1B) | — | 600 |
| Net new after dedupe | 85% | 510 |
| Healthy, readable site | 80% after redirect resolution | 410 |
| ICP PASS | 45–55% (better targeted than the pilot's 42% of readable) | 185–225 |
| Free-source buyer found | 75% (Apollo search found tier-1 buyers at 4 of 5 pass-2 companies) | 140–170 |
| Reveal + QC pass | 75–80% | **105–135 send-ready** |

- **Yield:** about 18–22% of discovered, but **55–60% of ICP PASS** and about 25–33% of healthy candidates. Most discovery is free (Apollo), so cost per lead is the number to watch, not the percentage of discovered.
- **Cost:** GetLeads 0–200 credits (top-up only); Adyntel about 40–80 for the intent lane plus about 120 per-domain; Jev about $0.15; Apollo about 1 credit per send-ready lead (about 110–140).
- **Kill metric:** if after the first 100 healthy candidates the ICP PASS rate is below 35% or buyer-found is below 60%, stop and change keywords or sources before spending more.

## Prerequisites before the first run

| Need | Status in a cloud session | Option |
|---|---|---|
| Global Suppression tab (Google Sheets) | Checked server side by the Campaign 3 import (dry run shows `suppressed` refusals) | — |
| Supabase reads | Available through the Supabase connector (read-only SQL) | — |
| Apollo, GetLeads, Adyntel, Jev | Connected | — |
| Dashboard API (import, queue, readiness) | Basic auth to `receptionist.scalelabai.ca`. In the Claude cloud environment it is a saved network secret; elsewhere use the dashboard login | — |
| Private run data (master CSV, evidence, run working folders) | Git-ignored (public repo). Delivered to the owner as `scalelab-v4-private-<date>.tar.gz`; unpack at the repo root to resume (see `tools/README.md`) | — |
| OneDrive deliverables folder | Local only | Cloud runs deliver to the run folder plus files in chat; local runs use OneDrive |
