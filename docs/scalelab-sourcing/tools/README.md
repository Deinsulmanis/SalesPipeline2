# ScaleLab V4 sourcing toolkit

Reusable scripts for a new sourcing run of [`../V4_SEND_READY_PIPELINE.md`](../V4_SEND_READY_PIPELINE.md). They are the scripts the pilot and wave 1 ran, with every run-specific value (date, wave label, Jev model and auth, file paths) moved into environment variables. The `../runs/*/scripts/` folders stay as the historical record of what each run executed; use this folder for new runs.

Leads that come out of a run go into **Industrial Campaign 3**: [`../INDUSTRIAL_CAMPAIGN_3_WORKFLOW.md`](../INDUSTRIAL_CAMPAIGN_3_WORKFLOW.md).

## Settings (`v4config.py`)

Set these before running. Everything has a default.

| Variable | Meaning | Default |
|---|---|---|
| `V4_RUN_DATE` | Run date `YYYY-MM-DD`. Ad freshness and `observed_at` are measured from it | today (UTC) |
| `V4_WAVE` | Wave label on every contact row, e.g. `wave2-2026-12-01` | `wave-<V4_RUN_DATE>` |
| `V4_SCORING_VERSION` | Scoring version label | `initial-2026-11-18` |
| `V4_AD_WINDOW_DAYS` | An ad is current if seen within this many days | `30` |
| `JEV_MODEL` | TypeSafe model id; record it in the run report | `jev-1.14.0` |
| `JEV_URL` | Jev endpoint | `https://api.typesafe.ai/v1/systemone` |
| `TYPESAFE_API_KEY` | Jev key. **Leave unset in the Claude cloud environment**: the proxy injects the key and the scripts send `Bearer proxy-injected`. Anywhere else (Codex, a laptop), export your own key | unset |
| `ADYNTEL_EMAIL`, `ADYNTEL_API_KEY` | Adyntel credentials, sent in the request body, never printed. Scripts refuse to run without them | — |

Always run Python with `-I`, and run from the repository root:

```bash
export V4_RUN_DATE=2026-12-01 V4_WAVE=wave2-2026-12-01
```

## Resuming earlier runs (private data)

The repository is public, so contact-level files are git-ignored and never committed:

- `../runs/V4_APPROVED_CONTACTS_MASTER.csv`
- each run's `approved-contacts.csv` and `review-holds.csv`
- `../runs/v4-copy-2026-11-20/v4-copy-evidence.json`
- the run working folders (`companies.json`, `sitecache/`, `ads/`, `icp_decisions.json` and so on)

The owner has these as **`scalelab-v4-private-2026-11-20.tar.gz`**. To restore, put the archive at the repository root and run:

```bash
mkdir -p runs-private && tar -xzf scalelab-v4-private-2026-11-20.tar.gz -C runs-private
```

```bash
cp runs-private/V4_APPROVED_CONTACTS_MASTER.csv docs/scalelab-sourcing/runs/
```

```bash
cp -r runs-private/v4-pilot-2026-11-19 runs-private/v4-wave1-2026-11-20 runs-private/v4-copy-2026-11-20 docs/scalelab-sourcing/runs/
```

Afterwards:

- `runs-private/w1`, `runs-private/v4run` and `runs-private/v4run_p2` are the working folders for wave 1, pilot pass 1 and pilot pass 2.
- Add `runs-private/` to your local `.git/info/exclude` so it can never be committed.

**Production is the source of truth for what has been sent.** Every imported lead (with its tag, score, variant and evidence) is in Supabase `outreach_leads`, campaign `Industrial Campaign 3`. Dedupe for a new run always runs against production (`dedupe_scalelab.sql`), so a new run does not strictly need the private archive. The archive adds the companies that were researched but never imported (HOLD and REJECT), so they are not paid for twice.

## Run order

The run folder (e.g. `runs-private/wave2`) is the working directory for one run. Budgets are set in the run brief and reported at every stop.

| Stage | How | Script / tool |
|---|---|---|
| 0. Balances + carry-over | Connector calls: GetLeads `get_fair_use`; Apollo credit stats; Jev `GET /v1/models`; Adyntel credit check. Then list every earlier run's VERIFY_PENDING addresses that still have no result (and any results file not yet ingested) | `ingest_verification.py --pending` |
| 1. Discover | Connector calls: Apollo `organizations_lookup` (free), GetLeads `search_companies` (top-up), Adyntel Meta keyword ad search (intent lane). Save the merged candidates as `<run>/companies.json` (`domain`, `company_name`, `source_id`, `pre_gate`, optional `intent_ads`) | — |
| 1b. Merge | Discovery lines (`<run>/disc/*.txt`: `domain|name|source_id|slice|page`) into `companies.json`, dropping domains in `<run>/exclude_domains.json` (production, master, earlier research) and setting aside name collisions (`prod_names.json`), chains/franchises and off-ICP names. `--limit N` cuts round-robin across slices; the rest is a free reserve | `discover_merge.py <run> --limit 2000` |
| 2. Pre-screen + dedupe | Domain health and redirects, then **read-only** dedupe against production and the V4 master. Mark duplicates in `pre_gate`. After the crawl, also check final redirect hosts against the exclusion set | `dedupe_scalelab.sql` |
| 3. Crawl | Plain HTTP, then headless Chromium fallback for blocked or empty sites (default browser, no evasion) | `fetch_sites.py <run>`, then `node pw_fetch.js <run> <dom...>` / `node pw_deep.js <run> <dom...>` |
| 4. ICP gate | One fan-out Jev request per company: ICP questions plus team-page buyer pick, then the code thresholds. Reviewer holds go in `<run>/manual_review.json` (tighten-only) | `qualify.py <run>` (uses `icp_gate.py`), then `icp_decide.py <run>` |
| 5. Ads | Adyntel per-domain lookups for PASS companies only, under a hard credit cap. Option A (2026-11-23): only companies with a picked buyer, Google + Meta | `adyntel_ads.py <run> <cap> [--only @domains.json] [--platforms google,meta]` |
| 6. Classify + score | Jev classifies each ad (employer-facing probability, attribution). Scores are computed in code (40/25/15/10/10) | `ads_score.py <run>` |
| 7. Buyers + reveal | Free Apollo people search for named buyers (lines in `<run>/buyers/P*.txt` with their domain batches), mapped and picked in playbook order into `<run>/targets.json`. Apollo `people_bulk_match` standard reveal within the approved cap (10 per call; full batches are saved to tool-result files), then parse each batch result. Check that match ids come back in request order | `buyer_pick.py <run> P1 P2 ...`; `parse_reveal.py <batch.json> <targets.json> <start> >> <run>/reveal/all.rows` |
| 8a. Contact QC | Apollo, GetLeads 6b and owner-gap paths. GetLeads-sourced and owner-gap addresses without an owner result are held as VERIFY_PENDING and written to `<run>/to_verify.csv` (one column, `email`, deduped). **Claude Code never submits or polls verification jobs and never uses Apollo validation**; the owner uploads the file to GetLeads | `contact_qc.py <run> --master <master.csv>` |
| 8b. Owner verification results | Owner drops the GetLeads results at `<run>/verified_results.csv`. Mapping: valid keep; catch-all / accept-all keep, flag, queue last; invalid / unknown / risky HOLD. Owner-gap: guess 1 first@ only; guess 2 first.last@ only after guess 1 is invalid (never more than 2); a catch-all guess is held. Re-runs QC, outputs, evidence and preview for the released contacts and prints counts | `ingest_verification.py <run> [--out <dir>] [--evidence-runs <dirs>]` |
| 8c. Contact QC notes | Reviewer writes `<run>/contact_qc.json`: `{"holds": {domain: reason}, "caution": {domain: flag}}`. Check every email domain against the company domain (parse_reveal only flags it when Apollo's org domain also differs) and prove a differing domain by redirect, on-site reference or cross-link; also write `<run>/buyer_shortfalls.json` | — |
| 9. Outputs + master | Review CSVs into the run's output folder; new contacts are appended to the V4 master (an existing domain or email is skipped) | `build_outputs.py <run> <out_dir> docs/scalelab-sourcing/runs/V4_APPROVED_CONTACTS_MASTER.csv` |
| 10. Evidence + preview | Evidence for every master lead from all run folders, then the read-only email preview | `build_evidence.py <master.csv> <evidence.json> <run1> <run2> ...`, then `node scripts/staffing-v4-preview.js <evidence.json> <out>` |
| 11. Import + queue | **Owner go-ahead required.** See the Campaign 3 workflow §7 | dashboard API |

**Copy v2 evidence** (`copy_v2_evidence.py`, read by `build_evidence.py`):
- `specialtyLine` (COPY_C primary) comes from the ICP excerpts.
- COPY_B job-posting candidates come from `<run>/job_postings.json`, collected from saved GetLeads `search_jobs` results with `python3 -I copy_v2_evidence.py collect <run>/job_postings.json <result files...>` (free jobs quota).

For a COPY_B lead, add its job ad to `CANDIDATE_ADS` in `build_evidence.py` (domain, a phrase matching the ad text, role, "City, ST"). The copy selector re-checks that the role and location appear in the ad's own text.

## Queueing: mailbox eligibility

Before queueing, read `GET /api/ops/cold-delivery-gate` and use only ScaleLab inboxes with `inColdPool: true` and `coldHold: null`. On 2026-11-20 those were `primary`, `deniels`, `outreachplateau_zoe`, `outreachplateau_merrick` and `outreachplateau_dave`.

Automatic routing (`senderInboxId: "auto"`) skips held and out-of-pool inboxes from commit `coldAssignableSenders` onward. Explicit per-inbox queueing remains the safest path, and you can check the result with `/api/staffing/launch-readiness`.

## Rules that do not change

- No paid credits, imports, queueing, cap changes or sends without the owner's explicit go-ahead in the current task.
- If Jev or Adyntel fails, stop the stage that needs it. Never substitute another vendor or model.
- Never commit contact-level data. Buyer names and emails stay in git-ignored files.
- ScaleLab only. Never mix with Jole BTX data, suppressions, senders or copy.
