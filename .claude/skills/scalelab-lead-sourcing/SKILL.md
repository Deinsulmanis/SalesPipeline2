---
name: scalelab-lead-sourcing
description: End-to-end workflow for sourcing ScaleLab AI leads (US industrial and skilled-trades staffing agencies) into a reviewed list of contact-ready buyers, then importing and queueing them into Industrial Campaign 3. Covers credit caps, free discovery, dedupe against production, website crawl, the Jev ICP gate, free buyer search, Adyntel ad checks, Apollo reveals, contact QC, review files, and the owner-approved import and queue. Use for any "source N companies", "find more leads", "re-run the workflow" or "import and queue the leads" request for ScaleLab.
---

# ScaleLab lead sourcing (Industrial Campaign 3)

This turns a company count ("run 2,000 companies") into a reviewed list of **contact-ready** buyers. With the owner's go-ahead, those buyers become **send-ready** leads queued in Industrial Campaign 3.

**Read first:**

- `docs/scalelab-sourcing/ScaleLab_AI_Industrial_Staffing_ICP_and_Sourcing_Playbook.md`: the ICP, buyer order and hard rejects.
- `docs/scalelab-sourcing/V4_DECISIONS.md`: the owner's decisions.
- `docs/scalelab-sourcing/tools/README.md`: the scripts used below.
- Before anything that imports, queues or deploys: `.claude/skills/salespipeline2-outreach-safety/`.

## Rules that never bend

1. **Credits are scarce.** Before any paid step, propose a cap for each tool and get the owner's yes. Measure spend from each vendor's balance before and after, never from estimates.
   - **Jev:** a USD budget, enforced by `V4_JEV_BUDGET_USD`.
   - **Adyntel:** a credit count.
   - **Apollo:** reveal credits.
   - **GetLeads:** credits, top-up only.
2. **Free first.** Discovery and buyer search must use the free tools. Use Apollo `apollo_organizations_lookup` and `apollo_mixed_people_api_search`.
   - Never use `apollo_mixed_companies_search`: 1 credit per page.
   - Never use waterfall, phone reveal or personal emails unless the owner asks for them.
3. **No import, queue, send, cap change or deploy** without the owner's explicit go-ahead in the current task. Stop at the reviewed list and report.
4. **ScaleLab only.** Prospects are staffing agencies, never Jole BTX's industrial employers. Never mix the two campaigns' data, suppressions, senders or copy.
5. **Fail closed.** If Jev or Adyntel errors, stop that stage. Never substitute another vendor or model.
6. **No personal data in git.** Buyer names and emails stay in git-ignored files:
   - `runs-private/`
   - `docs/scalelab-sourcing/runs/**/*.csv`
   - `v4-copy-evidence.json`
   - `preview/`

   Only run reports and scripts are committed.
7. **Dedupe before any spend:** against production (all clients), the V4 master, earlier research and name collisions. Also check prior reveals: never pay to reveal a person someone already revealed.
8. **The owner verifies emails, not Claude Code (2026-11-24).** Never submit or poll a verification job (`verify_emails`, `start_email_validation`, `check_email_validation`) and **never use Apollo email validation**. GetLeads-sourced and owner-gap addresses are held as `VERIFY_PENDING` and listed in `runs-private/<run>/to_verify.csv` (one column, header `email`, deduped, nothing else). At the end of every run, tell the owner the count and path and send the file. Apollo-revealed emails (Apollo "verified") skip this.

## Access (how each tool is reached)

| Tool | How |
|---|---|
| Apollo | MCP: `apollo_organizations_lookup` (free, 100 per page max), `apollo_mixed_people_api_search` (free), `apollo_people_bulk_match` (1 credit per match, 10 per call), `apollo_usage_stats_credit_usage_stats` (free balance) |
| Jev (TypeSafe) | `https://api.typesafe.ai`, header `Authorization: Bearer proxy-injected`. The proxy injects the real key; model `jev-1.14.0`, about $0.042 per million tokens |
| Adyntel | REST with body auth from env `ADYNTEL_EMAIL` and `ADYNTEL_API_KEY`. `https://api.adyntel.com/credits_check` is free |
| Supabase | MCP `execute_sql`, project `lasyefxhuwysjebasdbf`. **Read only** |
| Dashboard API | `https://receptionist.scalelabai.ca`. Basic auth is proxy-injected; never send credentials yourself. The `DASHBOARD_BASE_URL` Railway host returns 401 |
| Railway | Project `b3682a32-aa4a-4d4f-a6ee-067fe8876691`, service `59474dfa-d86e-4ab0-9e6d-fb4ab708cf10`, env `a364a41e-22ca-4c86-8e8b-630b82737414`. The service is **pinned to a commit**: deploy by `connect-service-source` with the full 40-character `commitSha` |

**Large tool outputs:** anything over about 90k characters is saved to a `tool-results/*.txt` file instead of entering context. Parse those files with Python; never retype data from them. A 10-person `bulk_match` is about 60–80k characters and is saved. An Apollo lookup page of 100 is about 25k characters and lands in context, so delegate bulk pages to subagents (stage 2).

## Run setup

```bash
mkdir -p runs-private/<run> && grep -qx 'runs-private/' .git/info/exclude || echo 'runs-private/' >> .git/info/exclude
```

```bash
export V4_RUN_DATE=<YYYY-MM-DD> V4_WAVE=<run>-<YYYY-MM-DD> V4_JEV_BUDGET_USD=<cap>
```

Run Python with `python3 -I`, from the repository root. Toolkit: `docs/scalelab-sourcing/tools/`.

## The workflow

### 0. Balances (free)

Record each balance before any spend:

- Apollo credit stats (`lead_credit.consumed`);
- Adyntel `credits_check`;
- Jev `GET /v1/models` (200 = reachable);
- GetLeads `get_fair_use`.

**Verification carry-over:** list every earlier run's addresses still waiting on the owner, so nothing is lost. Report them at the start of the run:

```bash
python3 -I docs/scalelab-sourcing/tools/ingest_verification.py --pending
```

### 1. Exclusion set (free, read only)

Pull every production domain in one query. The result is large, so it is saved to a tool-result file; parse it into `runs-private/<run>/prod_domains.json`:

```sql
with c as (
 select lower(regexp_replace(regexp_replace(coalesce(website,''),'^(https?://)?(www\.)?',''),'[/:?#].*$','')) d from outreach_leads
 union select lower(split_part(coalesce(email_normalized,email,''),'@',2)) from outreach_leads)
select string_agg(distinct d, ' ' order by d) doms from c where d like '%.%';
```

Do the same for normalized company names with a suppressed flag (`client~S|-~name`, joined by `|`), saved as `prod_names.json`.

Merge into `exclude_domains.json` (`{domain: why}`):

- the production domains;
- every earlier run's `companies.json` domains, including redirect and email domains;
- Codex/CSV domain lists;
- the V4 master.

### 2. Discovery (free): helper agents

Apollo caps a page at 100 results. Fan out 6 `general-purpose` agents (model `sonnet`), one per US region of about 7–12 states. Each brief must say:

- Load and use **only** `mcp__Apollo_io__apollo_organizations_lookup`. Never call anything that costs credits.
- For each state: `organization_locations: ["<State>, US"]`, `organization_num_employees_ranges: ["11,50","51,200","201,500"]`, and an industrial keyword-tag array (OR'd). Page 1–4 at `per_page: 100`; stop early when a page returns fewer than 100.
- After every page, append `domain|name|apollo_id|state|page` to `runs-private/<run>/disc/<letter>.txt` with a quoted heredoc. Replace `|` in names with `/`.
- Return only a count table.

**Tag lesson (2026-11-23):** do **not** include the broad tags `temporary staffing` or `temp agency`, and limit "labor" tags. They pulled in office, IT and healthcare agencies and contractors, and cut the PASS rate to 13% (wave 1 got 37% with narrower tags). Good tags:

- industrial staffing
- light industrial staffing
- skilled trades staffing
- manufacturing staffing
- warehouse staffing
- construction staffing
- welding staffing
- logistics staffing
- trades staffing
- craft labor staffing
- general labor staffing

### 3. Merge and dedupe (free)

```bash
python3 -I docs/scalelab-sourcing/tools/discover_merge.py runs-private/<run> --limit <N>
```

- **Dropped:** domains already in production or earlier research, and records with no domain.
- **Held for the owner, never paid for:** name collisions, national chains and franchises, and off-ICP names (IT, healthcare, legal, executive search).
- **Cut:** round-robin across states. The overflow is a free **reserve** in `discovery_overflow.json`.

Expect about 50% of raw candidates to be net-new.

### 4. Crawl (free)

```bash
nohup python3 -I docs/scalelab-sourcing/tools/fetch_sites.py runs-private/<run> > runs-private/<run>/crawl.log 2>&1 &
```

1. **Find thin sites:** after the crawl, list sites under 1,500 characters.
2. **Check redirects:** a final redirect host already in the exclusion set is a duplicate. Mark it `pre_gate: "REJECT"` and **backfill from the reserve** so the run stays at N.
3. **Headless retry for thin or blocked sites:** run 6 parallel workers, each with a 90-second per-site watchdog. It resumes from `pwcache/`, so a rerun is safe:

   ```bash
   node docs/scalelab-sourcing/tools/pw_fetch.js runs-private/<run> $(cat runs-private/<run>/thin_<i>.txt)
   ```

The plain-HTTP pass runs at about 120 sites a minute. The headless retry takes about 40 seconds per site.

### 5. ICP gate (Jev, capped)

```bash
python3 -I docs/scalelab-sourcing/tools/qualify.py runs-private/<run>
```

```bash
python3 -I docs/scalelab-sourcing/tools/icp_decide.py runs-private/<run>
```

- `qualify.py` makes one fan-out request per readable site, about 3.5k tokens (about $0.00015), and never starts a request that could cross the budget. You can run it on readable sites while the headless retry finishes, then rerun; cached sites are skipped.
- `icp_decide.py` applies the code thresholds, giving PASS, HOLD or REJECT with a reason code.

**Manual review (tighten-only):** check the homepage title of any PASS company whose name sounds off. Record holds in `runs-private/<run>/manual_review.json` as `{domain: {"decision": "HOLD", "reason": "..."}}` and rerun `icp_decide.py`. It can never promote a company to PASS.

Hold for the owner:

- IT-primary or healthcare homepages that have only one industrial page;
- executive search;
- gig or on-demand apps;
- nonprofits;
- strike-response or government-contract workforces;
- possible chains.

### 6. Free buyer search

Batch the PASS domains 10 at a time into `runs-private/<run>/buyers/P<k>_batches.json`. Have helper agents call `apollo_mixed_people_api_search`:

- `q_organization_domains_list`: the batch;
- `person_seniorities`: `["owner","founder","c_suite","partner","vp"]`;
- `per_page`: 100.

They write `batch_index|organization_name|person_id|first|last_obf|title|has_email` to `P<k>.txt`. The tool returns the employer **name**, not its domain, which is why the batches exist. A small batch can be done inline.

```bash
python3 -I docs/scalelab-sourcing/tools/buyer_pick.py runs-private/<run> P1 P2 P3 ...
```

**Buyer order (owner decision 2026-11-24; the one rule lives in `buyer_pick.py`, every tool imports it, no copies):**

- **Top title wins:** owner, co-owner, founder, co-founder, proprietor, president (not vice president), CEO, chief executive are **Tier 1** even combined with an excluded word ("President and Managing Director", "Owner/CFO"); not for former / retired / past / board titles.
- **Tier 1:** also managing partner / principal. **Tier 2:** CRO, VP sales/BD, then COO (incl. "Chief Operations Officer"), CMO, a bare VP, a bare "Partner".
- **Tier 3** (only when the company has no Tier 1/2 candidate AND the agency has <= 200 employees, `can_pick`; unknown size = no): general manager, director of operations, director of sales / BD, sales director, head of sales / growth / BD, operations manager, branch manager.
- **Multi-site exception (any size):** a branch / area / regional manager at a 3+ branch agency (`branch_exception`).
- **Never picked:** everything else on the exclusion list (finance, technology, HR, recruiting, "Talent Partner", "Product Owner", managing directors, assistants ...). Tests: `tools/test_buyer_rule.py`.

A reviewed parent or brand name that doesn't match the company record goes in `buyers/org_alias.json`. Expect about 55% of PASS companies to have a buyer with an email on file.

### 7. Adyntel ad check (capped; option A)

Run only on PASS companies **with a picked buyer**, Google and Meta, before the reveal:

```bash
python3 -I docs/scalelab-sourcing/tools/adyntel_ads.py runs-private/<run> <cap> --only @runs-private/<run>/adyntel_batch.json --platforms google,meta
```

A 204 (no content) is not billed. Confirm spend from the balance.

```bash
python3 -I docs/scalelab-sourcing/tools/ads_score.py runs-private/<run>
```

Jev classifies each ad, then the code scores 40/25/15/10/10. Companies whose ads were never checked score `NOT_CHECKED` (INSUFFICIENT_EVIDENCE), not LOW_SIGNAL.

### 8. Reveal (Apollo, capped)

1. Order targets by score, then tier, into `reveal/targets_ordered.json`.
2. Call `apollo_people_bulk_match` with **ids only**, 10 per call. Never use phone, personal email or waterfall.
3. Copy each saved tool-result file to `reveal/batchNN.json`.
4. Check that the match ids come back **in request order**.
5. Parse:

   ```bash
   python3 -I docs/scalelab-sourcing/tools/parse_reveal.py reveal/batchNN.json reveal/targets_ordered.json <start> >> reveal/all.rows
   ```

A batch under 10 may come back inline. Transcribe only the fields the parser reads, and copy emails exactly. Finally, confirm the credits used from Apollo's balance.

### 9. Contact QC

The parser only flags a domain mismatch when Apollo's company domain also differs, so **check every email domain against the company domain yourself**.

| Finding | Action |
|---|---|
| Differing email domain proven by a redirect (either way), an on-site reference or a cross-link | Keep; caution flag on the row |
| Differing email domain, unproven | HOLD |
| Email at another organization (a national firm, `.edu`) | HOLD (stale or departed) |
| Revealed person is a recruiter or not a buyer | HOLD |
| Proofpoint gateway plus catch-all | HOLD (`build_outputs` does this) |
| No MX record | HOLD |
| Other catch-all | Keep; flag; **queue last** |

Also check email domains against the exclusion set and the master.

Run `contact_qc.py` across all three buyer paths (Apollo, GetLeads 6b, owner-gap):

```bash
python3 -I docs/scalelab-sourcing/tools/contact_qc.py runs-private/<run> --master docs/scalelab-sourcing/runs/V4_APPROVED_CONTACTS_MASTER.csv
```

It writes `contact_qc.json` (`{"holds": {domain: reason}, "caution": {domain: flag}}`), `buyer_shortfalls.json`, `targets.json`, `reveal/all.rows`, `verify_pending.json` and `to_verify.csv`.

#### 9b. Verification (the owner does it)

- **Never** call `verify_emails` or any GetLeads validation tool, and never use Apollo validation.
- GetLeads-sourced and owner-gap addresses with no owner result are `VERIFY_PENDING` holds. Apollo-revealed emails skip this step.
- **Owner-gap guesses:** `owner_gap.py` writes at most two per person: guess 1 `first@`, guess 2 `first.last@`. Only guess 1 goes into `to_verify.csv`. Guess 2 goes in a later round, and only if guess 1 came back invalid. A guess on a catch-all domain is held: an accept-all domain proves nothing about a guessed address.
- **End of run:** report the `to_verify.csv` count and path (`runs-private/<run>/to_verify.csv`) and send the file to the owner.
- **When the owner hands back results:** the owner drops GetLeads' results CSV at `runs-private/<run>/verified_results.csv`. Then run:

  ```bash
  V4_RUN_DATE=<run date> V4_WAVE=<run> python3 -I docs/scalelab-sourcing/tools/ingest_verification.py runs-private/<run> --evidence-runs <other run dirs whose evidence is needed>
  ```

  | GetLeads status | Action |
  |---|---|
  | valid | Keep |
  | catch-all / accept-all | Keep; flag; **queue last** (owner-gap guess: HOLD) |
  | invalid | HOLD (owner-gap guess 1 → guess 2 goes into the next `to_verify.csv`) |
  | unknown / risky / anything else | HOLD |

  It backs up every file it changes, then re-runs `contact_qc`, `build_outputs`, `build_evidence` and the preview for the released contacts. Report its counts (no names or emails), and send any new `to_verify.csv`.

### 10. Outputs, evidence and preview

Back up the master first.

```bash
python3 -I docs/scalelab-sourcing/tools/build_outputs.py runs-private/<run> docs/scalelab-sourcing/runs/<run> docs/scalelab-sourcing/runs/V4_APPROVED_CONTACTS_MASTER.csv
```

```bash
python3 -I docs/scalelab-sourcing/tools/build_evidence.py docs/scalelab-sourcing/runs/V4_APPROVED_CONTACTS_MASTER.csv docs/scalelab-sourcing/runs/<run>/v4-copy-evidence.json <every run dir whose leads are in the master>
```

```bash
node scripts/staffing-v4-preview.js docs/scalelab-sourcing/runs/<run>/v4-copy-evidence.json docs/scalelab-sourcing/runs/<run>/preview
```

The preview selects the Email 1 variant server-side: A > D > E > F > B > C, otherwise HOLD. A lead with no first-party specialty quote is a copy HOLD. Review display names before import.

### 11. Report and stop

Write `docs/scalelab-sourcing/runs/<run>/run-report.md` with no buyer names or emails. Include:

- spend against each cap, measured from balances;
- the funnel;
- dedupe counts;
- ICP reasons;
- QC holds;
- copy variants;
- what waits on the owner.

Commit the report and toolkit changes, then push the dev branch. Send the owner `approved-contacts.csv`, `preview/v4-preview.html` and the report. **Stop:** import and queue need the owner's go-ahead.

### 12. Import and queue (only after the owner says so)

Follow the outreach-safety skill. Pre-check, read only:

- `/api/ops/cold-delivery-gate`: use only ScaleLab inboxes in the cold pool with no `coldHold`;
- `/api/ops/sender-balance?client=scalelab`: per-inbox load and capacity;
- `/api/agent/status`: must not be running;
- the time must be outside the send windows (weekdays 07:00–11:30 Pacific, at :00 and :30).

1. **Payload:** records from `v4-copy-evidence.json` for the copy-selected leads only. Body: `{"schema":"industrial_campaign_3_import_v1","sourcing_run_id":"<id>","owner_approved_send_ready":true,"records":[...]}`.
2. **Catch-alls last:** split into two payloads, non-catch-all and catch-all. The send cron reads queued leads in `lead_id` order, and an id starts with the import time, so the **second** import call sorts last.
3. **Dry run each:** `POST /api/staffing/campaign-3/leads/import` with no `dry_run` field writes nothing. Then run live with `"dry_run": false`. A repeat is a safe no-op (`alreadyImported`).
4. **Queue explicitly:** one `POST /api/coldemail/queue` per inbox, `{"ids":[...],"senderInboxId":"<inbox>","emailTemplateId":"industrial-staffing-campaign-3","campaignVersionId":"industrial_staffing_campaign_3"}`.
   - Do the non-catch-alls first.
   - Split so each inbox's total load stays in line with its daily limit.
   - Never use `"auto"` when an explicit split is possible.
5. **Post-check:**
   - `/api/staffing/launch-readiness` shows `wouldSendIfSendingEnabled: true` for every new id.
   - `sender-balance` plans **no moves into held inboxes**. The scheduled refill applies its plan at 06:40 Pacific on weekdays.
   - A Supabase count by stage for `campaign = 'Industrial Campaign 3'`.
6. **Report send-ready:** queued Email 1 leads, plus contacted leads still in sequence, minus opt-outs.

### 12b. Convert an existing V1 / Campaign 2 row (recovered leads)

The import refuses an address or company that already has a ScaleLab row (`duplicate_email`, `duplicate_company`), so leads recovered from Staffing Outreach Campaign 2 or Industrial Staffing Agency (V1) are converted **in place**, keeping their lead id. Use this only with the owner's approval in the current task.

1. **Payload:** `POST /api/staffing/campaign-3/leads/convert`, body `{"schema":"industrial_campaign_3_convert_v1","sourcing_run_id":"<run>","owner_approved_send_ready":true,"records":[{"lead_id","row","evidence"}]}`. `row` and `evidence` come from the run's `v4-copy-evidence.json`. With no `dry_run` field it writes nothing.
2. **Held rows:** add `"release_manual_hold": true` only when the owner has approved the lead and the `[MANUAL HOLD]` reason is the question they settled (for example "industrial staffing fit not yet established"). Never for a contact-association hold.
3. **What it refuses:** non-ScaleLab or unresolved owner, a row already in Campaign 3 or carrying a V2 profile, anything past stage `Import`, any send, step or sender, reply and bounce markers, suppression, a duplicate address or company, and evidence that is not `SELECTED`.
4. **Write:** compare-and-set on the current state. It changes only `campaign`, `campaign_notes` (the sealed V4 profile, marked `campaign3-convert:<run>`), the template and intended version, `leadNiche` and `routingRequired`, plus `notes` when it releases a hold. Live runs need Supabase primary authority (otherwise 409 `authority_not_canonical`).
5. **Check:** snapshot the rows first (md5 of notes, campaign notes and identity, plus revision). Afterwards only those fields may differ and revision is up by one. A repeat call returns `alreadyConverted`.
6. **Queue:** as in step 12, non-catch-alls first. Converted rows keep their old ids, which sort **before** newly imported ones, so they cannot be forced to the end of the queue. Keep each inbox inside one day's capacity if catch-alls must go last.

### Job-posting evidence and job-board discovery (owner decision 2026-11-24)

**Rule:** the agency itself has 2+ postings in the last 60 days for hands-on industrial or trades roles, and those make up at least 1/3 of its postings. Postings must be the agency's own (matched by `company_domain`).
- It meets check 3 (industrial line) and check 8 (hands-on), and with them checks 7 and 9.
- It meets check 4 only when 2+ hands-on postings say temporary, contract, temp-to-hire or contract-to-hire.
- Checks 1, 2, 5 and 6 are unchanged.
- Code: `jobs_rule.py`, then `icp_decide.py <run> --jobs <run>/jobs_evidence.json`. Every decision records `evidence_basis`.

**Postings come from GetLeads only (free jobs quota, no plan credits).**
- Discovery: `search_jobs` with country US, `group_by: company`, the three industrial functions and a company-name keyword, paged to the end. Parse with `jobs_discover.py`, then run `discover_merge.py` as usual.
- Per-company counts and titles: `enrich_company_jobs`, 50 companies per call, with owner approval on 2026-11-24:
  1. counts with `include_postings: false` (all functions);
  2. industrial-function counts in batches of 25;
  3. titles (`roles_per_company: 10`, industrial functions, batches of 10) only for companies with 2+ industrial postings.
- Check 4 for job-qualified companies whose site shows no placement model: read descriptions with `search_jobs`, limit 10.

**Run the calls through helper agents and parse their transcripts.** Every agent's raw tool results sit in `/tmp/claude-0/.../tasks/<agentId>.output` (and the session's `subagents/` folder):
- job lookups: `jobs_rule.py collect <out.json> <transcripts...>`;
- free Apollo search: `apollo_lines.py`;
- 6b lookups: `gl_lines.py`.

So agents only make calls; nothing is transcribed by hand.

**Yield (2026-11-24):**
- Keywords "staffing" and "personnel" passed at 38–48% of readable sites; "recruiting" and "resources" at 3–6%.
- Overall 58 PASS from 251 readable (23%).
- Re-gating old low-confidence HOLDs with job evidence promoted only 5 of 551: most leftovers have no postings of their own.

## Benchmarks (for estimates)

| Stage | 2026-11-23 run (2,000 companies) | Wave 1 / Codex re-check |
|---|---|---|
| Net-new of raw discovered | 54% | about 50% |
| Readable sites | 80% | 69% |
| PASS of readable | 13% (broad tags) | 37% |
| PASS with a buyer email (free search) | 54% | 27% |
| Reveal matched and verified | 100% | 100% |
| Pass contact QC | 88% | 88–94% |
| With Campaign 3 copy | 96% | 90–95% |

**Cost per contact-ready lead (2026-11-23):**

- Jev: about $0.0025;
- Adyntel: about 2 credits;
- Apollo: about 1.14 credits.

**Planning rule of thumb:** contact-ready ≈ net-new × readable × PASS × buyer-email × QC. 2,000 net-new gave 100 contact-ready; with narrower tags expect 150–250.

## Gotchas learned the hard way

- `fetch_sites.py` once crashed on a malformed link, and `pw_fetch.js` workers hung for an hour. Both are fixed: each site is wrapped, and there is a watchdog. Always check that a background job really finished (`pgrep`) rather than trusting a wait loop's timeout.
- The Adyntel ledger once counted unbilled 204 responses. Trust the balance.
- Buyer titles: "Product Owner", "Talent Partner" and "Principal Pay Strategist" were all mis-ranked at first. Re-run `buyer_pick.py` after any rule change and diff the picks before revealing.
- `buyer_pick.py` rewrites `targets.json`. Before `build_outputs.py`, set it back to the revealed list, or the rows won't find their targets.
- The Railway service is pinned: a push alone does not deploy. Re-pin with the full SHA, then verify:
  - deployment SUCCESS with the right `commitHash`;
  - all crons scheduled and send-lock enabled;
  - the live endpoint shows the change.
- **Inbox capacity:** daily limit = min(registry `dailyLimit`, per-window limit × 10 windows); ScaleLab's ceiling is 170 a day (`SCALELAB_MAX_DAILY`). Registry defaults are in `integrations/gmail-inbox-registry.js`. Entries in Railway's `GMAIL_INBOX_REGISTRY_JSON` override them, and Railway variables can't be listed, so confirm limits on `/api/integrations/gmail-inboxes`.
- **Held inboxes** (`coldHold: mailbox_archived_access_not_configured`) can't send cold mail. Their Gmail access must be restored before they help capacity.
- **Tag pool exhausted (2026-11-24):** after five runs, the narrow industrial tags return about 93% already-researched companies (2,887 raw → 205 net-new). Apollo's lookup takes `organization_naics_codes` (2–5 digits, prefix match: use `56132`, not `561320`). NAICS-only companies pass the gate at about 3.4%, against 9% for tagged ones. Record the query group as a 6th field on each discovery line (`discover_merge.py` reports per group; `--defer NAICS_56132` keeps it behind the tags).
- **Shadow pre-filter (2026-11-24):** Apollo's free lookup has no description or keywords. A Jev score from the name, tag group and off-ICP tags kept only 27% of PASS companies at its own cut-off, and 80% only by saving half the crawl. Do not skip crawls on it.
- **Thin sites and qualify:** run `qualify.py --only @readable.json` before the headless retry and the rest after. A site between 800 and 1,500 characters judged early is cached and never re-judged.
- **GetLeads verification is the owner's job (2026-11-24).** In-session jobs sat queued past 50 minutes, retry included, and stalled a run. Never submit or poll them; use `to_verify.csv` and `ingest_verification.py` (section 9b).
- **GetLeads job search throughput (2026-11-24):** the MCP serves one `search_jobs` request at a time across every agent, at about 8–11 calls a minute. Under load, grouped keyword pages over ~500 companies time out at 60 seconds, and `enrich_company_jobs` with titles for 50 companies times out too.
  - Run big discovery pages when nothing else is calling, and drop to 50 or 25 per page.
  - Use counts first and titles in batches of 10.
  - A name-match fallback (`company_name`) returned 2 rows and 0 usable matches in 30 tries; don't use it.
- **Worker restarts during paid calls:** after a restart, read the vendor balance before retrying anything that costs credits. A call reported as "did not run" really hadn't run (Apollo 1,056 = exactly the earlier batch). Reveal one batch per call so a restart loses at most one.
- **owner_gap.py overwrites** `owner_gap/candidates.json` and `picks.json` on each run. Copy them aside before a second round and restore afterwards.
- **Tests:** the full suite has date-dependent failures (DST, the live-refill window, a Jole fixture past its 45-day evidence age). Compare against the live commit before calling a failure new.
