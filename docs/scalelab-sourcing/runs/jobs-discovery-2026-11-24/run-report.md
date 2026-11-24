# Job-posting gate run: re-gate of 551 HOLDs + job-board discovery (2026-11-24)

Two-part run under the `scalelab-lead-sourcing` skill with the owner's decisions of 2026-11-24. It stopped at the reviewed list: **nothing was imported, queued, sent or deployed, and no caps were changed.** No buyer names or emails appear here; contact-level files are git-ignored.

- Part 1 run folder: `runs-private/regate-551-2026-11-24/`; outputs in `docs/scalelab-sourcing/runs/regate-551-2026-11-24/`.
- Part 2 run folder: `runs-private/jobs-discovery-2026-11-24/`; outputs in `docs/scalelab-sourcing/runs/jobs-discovery-2026-11-24/`.
- **Combined review file:** `approved-contacts-both-parts.csv` and `preview/v4-preview.html` in the Part 2 output folder.

## Result

**37 new contact-ready buyers** at 37 companies; the V4 master went from 316 to 353 rows with 0 duplicates skipped.

| | Contact-ready | With Campaign 3 copy |
|---|---|---|
| Part 1 (re-gate of 551) | 4 | 4 |
| Part 2 (job-board discovery) | 33 | 29 |
| **Total** | **37** | **33** |

- **The source works:** job-board discovery passed the gate at **23% of readable sites** (58 of 251), against 4.5% in the 3,000-company run. Agencies found under "staffing" passed at 48%.
- **The re-gate barely moves:** most of the 551 leftovers have no postings of their own in the last 60 days (441 of 551), so the job-posting rule promoted 5.
- **Copy is again nearly all COPY_C:** 33 COPY_C and 4 copy holds, with no other variant (see Copy).

## Spend against every cap (from vendor balances)

| Tool | Cap | Before | After | Spent |
|---|---|---|---|---|
| Apollo reveals | 400 credits | 1,052 consumed | 1,087 consumed | **35** |
| GetLeads plan | 300 credits | 9,214 | 9,193 | **21** |
| GetLeads wallet | $1.00 | $10.8565 | $10.8420 | **$0.0145** |
| Adyntel | 500 credits | 3,739 | 3,663 | **76** |
| Jev (`jev-1.14.0`) | $1.50 | — | — | **$0.038** |
| GetLeads jobs quota (free, not credits) | — | 17,932 used this month | 23,759 | **5,827 postings** |

- **Apollo:** `bulk_match` by person id only; no phone, personal email or waterfall.
  - A worker restart interrupted one reveal call. The balance was checked before any retry: 1,056 consumed, so the failed calls had not run and nothing was paid twice.
- **GetLeads plan:** `lookup_decision_makers` by domain, limit 2, for 27 domains. No name enrichment.
- **GetLeads wallet:** 4 verification jobs for 29 addresses.
- **Adyntel:** Google and Meta for the 45 PASS companies with a buyer. 204 responses are not billed.
- **Jev:** measured from the runs' token ledgers; Jev has no balance endpoint.
  - Gate fan-out $0.0371, owner-gap picks $0.0004, ad classification $0.0003.
  - Part 1 used no Jev: its gate answers were cached from the 3,000 run.
- **Jobs quota:**
  - Daily: 230 → 6,057.
  - Monthly: 17,932 → 23,759, with 576,241 left.

## How the job-posting rule was applied (owner decision 2026-11-24)

**Rule:** the agency itself has 2+ postings in the last 60 days (2026-09-25 to 2026-11-24) for hands-on industrial or trades roles, and those make up at least 1/3 of its postings in that window. Path A (lowered check 3) is dropped.

- **Matching:** postings are matched on the agency's own `company_domain`, so a direct employer that merely shares the name cannot count.
  - A name-match fallback was tried and dropped after 30 searches returned 2 rows and 0 usable matches.
- **Hands-on titles:** the owner's list plus close trade variants: picker/packer, material handler, assembler, line operator, maintenance helper, installer, wire harness.
  - Titles with manager, supervisor, engineer, coordinator, specialist, assistant and similar never count.
  - Neither do drivers, pilots, event stagehands or vehicle inspectors.
- **What the evidence satisfies:**
  - It meets check 3 (industrial line) and check 8 (hands-on workers).
  - It is also taken to cover check 7 (industrial excerpt) and check 9 (management-only), which test the same thing.
  - Check 4 (placement model) is met by the website as before, or by **2+ hands-on postings** that say temporary, contract, temp-to-hire or contract-to-hire: in the employment type, anywhere in the title, or as a placement phrase in the description.
- **Still required:** checks 1 (identity), 2 (employer-facing staffing), 5 (US) and 6 (not a national chain).
  - A website NO_INDUSTRIAL_LINE reject could be lifted by postings; none was.
- **Code:** `jobs_rule.py` (new) and `icp_decide.py --jobs`. Every decision records `evidence_basis`.
  - Without `--jobs`, decisions are unchanged: regression-checked on the 3,000 run, 0 diffs.
- **Where the postings came from:** GetLeads only (free jobs quota, no plan credits). Firecrawl was not used.
  - Discovery and the check-4 description reads used `search_jobs`.
  - **With the owner's approval mid-run**, the per-company counts and titles switched to `enrich_company_jobs`: the same quota and postings data, 50 companies per call.
  - Why: `search_jobs` runs one request at a time across all agents, at about 8–11 calls a minute, and the big keyword pages timed out while the queue was busy.
  - Raw results were parsed from the helper agents' transcripts; nothing was transcribed by hand.

## Part 1: re-gate of the 551 HOLDs (v4-3000-2026-11-23)

The cohort is the 551 HOLD companies from the gate experiment that pass checks 1, 2, 5 and 6:
- 527 failed check 3 and/or check 8;
- 24 failed only check 4, 7 or 9.

The new decisions are in `runs-private/regate-551-2026-11-24/icp_decisions.json`. The original 3,000-run decisions file was not touched.

| Step | Count |
|---|---|
| Companies | 551 |
| Job evidence PROMOTE | 7 |
| **Gate PASS** (all on job postings) | **5** |
| Job-qualified but blocked on check 4 (no temp/contract wording, site shows no placement model) | 2 |
| PASS with a buyer (any path) | 5 (4 Apollo, 1 GetLeads) |
| **Contact-ready** | **4** (the GetLeads buyer was at another employer, and the address was invalid) |
| With copy | 4 (all COPY_C) |

**Why the other 544 stayed on HOLD (job evidence):**
- no postings by the agency in the last 60 days: 441;
- only 1 industrial-function posting: 38;
- recent postings but none hands-on (office, IT, healthcare, drivers, managers): 37;
- only 1 hands-on posting observed: 12;
- hands-on postings under 1/3 of the total: 16.

## Part 2: job-board discovery (jobs-discovery-2026-11-24)

**Discovery query:** `search_jobs`, country US, grouped by company, with the Manufacturing, Skilled Trades & Maintenance and Supply Chain & Logistics functions, one query per company-name keyword, paged to the end. No region filter.
- All 8 keywords completed: 1,178 company rows, 973 unique companies.

**Discovery funnel:**
- **Dropped before the merge:** 30 non-US domains, 8 public bodies, unions or schools, and 19 direct employers in non-staffing industries whose names merely contained a weak keyword (resources, workforce, labor, employment).
  - Other weak-keyword names went on to the gate, where check 2 decided.
- **Deduped by domain** against the full exclusion set: 11,181 domains, covering production for all clients, every earlier run (with redirect and email domains) and the V4 master. Part 1's companies are inside it.
  - Already known: 470.
  - Held for the owner: 106 name collisions, 8 national chains or franchises, 20 off-ICP names.
- **312 net-new**, then 15 redirect duplicates after the crawl, leaving 297 in play, of which 251 were readable after the headless retry (85%).

**Per keyword.** Companies found by two keywords count under both (33 companies).

| Keyword | Rows | Unique found | Net-new | Readable | PASS | PASS rate (of readable) | Contact-ready | With copy |
|---|---|---|---|---|---|---|---|---|
| staffing | 563 | 482 | 104 | 82 | 39 | 47.6% | 22 | 20 |
| personnel | 96 | 89 | 22 | 16 | 6 | 37.5% | 5 | 5 |
| workforce | 63 | 58 | 17 | 12 | 4 | 33.3% | 1 | 0 |
| labor | 30 | 28 | 6 | 5 | 1 | 20.0% | 1 | 1 |
| employment | 73 | 67 | 20 | 14 | 4 | 28.6% | 2 | 1 |
| temps | 5 | 5 | 1 | 1 | 1 | — | 1 | 1 |
| recruiting | 119 | 104 | 57 | 49 | 3 | 6.1% | 1 | 1 |
| resources | 229 | 173 | 89 | 75 | 2 | 2.7% | 2 | 1 |
| **Total (unique companies)** | 1,178 | 973 | 312 | 251 | **58** | **23.1%** | **33** | **29** |

- **"staffing" and "personnel" carry the run.**
- **"recruiting" and "resources" are mostly direct-hire, IT, office or direct employers:** about 3–6% PASS.
- The gate's own rejects caught 42 NOT_STAFFING and 10 NO_INDUSTRIAL_LINE.

**Buyers:**
- 58 PASS companies.
- 40 with an eligible buyer:
  - Apollo free search: 32 picks;
  - GetLeads 6b: 5 more;
  - owner-gap: 3 more, with valid non-catch-all guesses.
- 33 contact-ready, 29 with copy.

## PASS evidence split (both parts)

| Basis | PASS companies | Contact-ready | With copy |
|---|---|---|---|
| Website only | 27 | 15 | 14 |
| Website and job postings | 24 | 15 | 15 |
| Job postings only | 12 (Part 1: 5, Part 2: 7) | 7 (4 + 3) | 4 |

Job evidence added **12 PASS companies** that the website alone held, and corroborated 24 more. The 3 Part 2 job-only contacts are all copy holds: their sites have no first-party specialty quote.

## Contacts and cost per contact

**By source path (both parts):**

| Path | Contacts | Verified / catch-all | Paid units | Per contact |
|---|---|---|---|---|
| apollo (free search + reveal) | 30 | 15 / 15 | Apollo 35 credits; Adyntel ~61 of 76 (36 of the 45 checked companies) | 1.17 Apollo + ~2.0 Adyntel credits |
| getleads (6b domain lookup) | 4 | 2 / 2 | GetLeads 21 plan credits (27 lookups); wallet $0.004; Adyntel ~10 | 5.3 plan credits + ~2.5 Adyntel + $0.001 |
| owner-gap (site owner + pattern guesses) | 3 | 3 / 0 | Jev $0.0004; wallet $0.0105 (21 guesses); Adyntel ~5 | ~1.7 Adyntel + $0.0036 |
| Jev, shared (mostly the gate) | | | $0.038 | $0.001 |

**By discovery source:**

| Source | Contacts | Apollo | Adyntel | GetLeads plan | Wallet | Jev |
|---|---|---|---|---|---|---|
| regate-551 | 4 | 4 (1.0 each) | 9 (2.25 each) | 2 (0.5 each) | $0.0005 | $0 |
| jobs-discovery | 33 | 31 (0.94 each) | 67 (2.03 each) | 19 (0.58 each) | $0.014 | $0.038 |

The jobs quota (5,827 postings, free) was shared by both parts.

**Buyer tiers:** 34 tier 1, 3 tier 2. **Catch-alls:** 17 (1 in Part 1, 16 in Part 2), to be queued last.

## Copy variant distribution (flag)

| Variant | Contacts |
|---|---|
| COPY_C | 33 |
| HOLD (no variant has verified evidence and complete variables) | 4 |
| A, B, D, E, F | 0 |

**Nearly all COPY_C again.** Three of the four copy holds are job-postings-only PASS companies with no first-party specialty quote.

The job postings themselves hold the role and location an evidence-backed variant needs. Letting them feed the candidate-ad variant (COPY_B) would be an owner copy decision; it was not changed.

## Holds by reason

**ICP (Part 2, 312 companies):**

| Decision | Count |
|---|---|
| PASS | 58 |
| HOLD: low-confidence industrial line or placement model | 103 |
| HOLD: site not readable | 46 |
| HOLD: identity conflict | 11 |
| HOLD: US operations not corroborated | 10 |
| HOLD: hands-on placement not shown | 5 |
| HOLD: possible chain (Jev) | 4 |
| HOLD: possible executive search only | 2 |
| HOLD: manual review (tighten-only, see below) | 6 |
| REJECT: not staffing | 42 |
| REJECT: no industrial line | 10 |
| REJECT: redirect duplicate | 15 |

**Job-qualified but blocked by another check:** 24, listed under owner review.

**Contact QC holds:**
- Part 2: person mismatch 2, email domain unproven 2, Proofpoint + catch-all 1, stale org (GetLeads) 1.
- Part 1: stale org 1.

**Buyer shortfalls:** 19 Part 2 PASS companies have no buyer on any path.
- 14: the GetLeads lookup found no eligible tier 1–2 buyer.
- 4: the owner-gap guesses failed verification.
- 1: nothing on any path.

**Prior reveal:** for 1 PASS company (kfistaffing.com) the picked person had already been targeted in an earlier run, so it was not paid for twice. It is a possible duplicate company.

## Verification jobs (GetLeads)

| Item | Count |
|---|---|
| Jobs submitted | 4 (batches of 10, 10, 6 and 3) |
| Completed | 4, all on the first poll, within 30 seconds |
| Failed / retried | 0 / 0 |
| Addresses verified | 29 of 29 |

| Path | Addresses | Valid | Valid catch-all | Ambiguous catch-all (HOLD) | Invalid (HOLD) |
|---|---|---|---|---|---|
| GetLeads | 8 | 5 | 2 | 0 | 1 |
| Owner-gap guesses | 21 | 3 | 0 | 3 | 15 |

Apollo-verified emails skipped verification, per the rule. No substitute verifier was used.

## What waits on the owner

1. **Review the 37 contacts:** `approved-contacts-both-parts.csv` and `preview/v4-preview.html` (git-ignored). The 17 catch-alls queue last.
2. **Import and queue** into Industrial Campaign 3 need your go-ahead. Nothing was imported.
3. **Discovery holds** (never paid for):
   - 106 name collisions;
   - 20 off-ICP names;
   - 8 chains or franchises: elwoodassociate.com, ultimatestaffing.com, snelling.com, remedystaffing.com, integritystaffing.com, select.com, selectstaffing.com, gemini-catalyst.com.
4. **Manual-review holds (6, tighten-only):**
   - atwork.com: franchise network;
   - eastridge.com: large national firm;
   - cwresources.org: mission-driven contractor, not staffing;
   - santacruzstaffing.com: office/professional with executive recruiting;
   - cthrecruiting.com and renoirstaffing.com: property-management staffing whose job evidence is apartment maintenance technicians.
5. **Job-qualified but blocked (24).** The postings meet the rule, but another check fails:
   - **Check 4, no temp/contract wording and no placement model on the site (9):** ngroup.biz, syncstaffingservices.com, peiasap.com, hbrecruiting.com, pslabels.com, tburksassociates.com, ybirecruiting.com, encoreprostaffing.com, arsenalrecruiting.com. Strict as written, with ngroup.biz the clearest case: 28 of 32 postings are general labor and warehouse.
   - **US operations not corroborated on the site (8):** nexusemployment.com, empireworkforce.com, coworxstaffing.com, honeycreekstaffing.com, ambitionspersonnel.com, sawyerstaffing.com, eliteaviationstaffing.org, arsenalrecruiting.com (also missing check 4). Several look like plain US agencies, so these may be worth a manual US check.
   - **Chain (1):** lyneer.com (p=0.58).
   - **Identity or staffing type not established (7):** turleyinternational.com, ioneresources.net, remstaffsolution.com, employer-solutions-resources.com, inclusivehr.org, avolv3.com, bctechstaffing.com.
6. **Rule points to confirm:**
   - checks 7 and 9 treated as covered by job evidence;
   - check 4 by postings needs 2+ hands-on postings with temp/contract wording;
   - posting matching by domain only, since the name fallback found nothing usable.
7. **kfistaffing.com:** the person was already targeted in an earlier run; check whether the company is a duplicate under another domain.
8. **Copy:** decide whether job postings may feed COPY_B (see Copy).

## Toolkit changes in this run (committed)

- **New scripts:**
  - `jobs_rule.py`: the job-posting rule, temp/contract detection, and parsing of raw `search_jobs` and `enrich_company_jobs` results from agent transcripts.
  - `jobs_discover.py`: job-board discovery into `discover_merge.py` lines, with US-only, public-body and keyword filters.
  - `apollo_lines.py`: free Apollo search results into `buyer_pick.py` input, from transcripts.
  - `gl_lines.py`: 6b lookups into `gl/D*.txt` from transcripts. Personal emails and phones are never written.
- **Changed scripts:**
  - `icp_decide.py`: `--jobs <evidence>` and `--out <file>`, plus `evidence_basis` on every decision.
  - `build_outputs.py`: run CSVs carry `source_path`, `discovery_source` and `icp_evidence_basis`.
- **Lessons** are recorded in the skill's gotchas.
