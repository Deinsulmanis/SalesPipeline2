# V4 3,000-company run (2026-11-23)

Run name `v4-3000-2026-11-23`. The run used the `scalelab-lead-sourcing` skill with the owner's eight changes for this run. It ran unattended through stage 11 and stopped there: **nothing was imported, queued, sent or deployed, and no caps were changed.** This report has no buyer names or emails. Contact-level files are git-ignored.

## Result in one paragraph

3,000 net-new companies went into the run. **114 passed the ICP gate** (3.8%) and **58 contact-ready buyers** were added to the V4 master (258 → 316): 52 from Apollo and 6 from GetLeads. The owner-gap path produced none. **53 of the 58 have Campaign 3 copy (COPY_C)**; 5 are copy holds. Every cap held, and spend was far under each one. The main finding is about discovery. **The narrow industrial-tag pool is nearly exhausted**: the industrial tag groups returned 2,887 raw records, but only 205 were net-new after earlier runs. 94% of this run therefore came from NAICS 56132 (temporary help services), which passes the gate at 3.4%, against 9.1% for the tagged companies.

## Spend against every cap (from vendor balances)

| Tool | Cap | Before | After | Spent | Notes |
|---|---|---|---|---|---|
| Apollo reveals | 500 credits | 988 consumed | 1,052 consumed | **64** | bulk_match by id only. No phone, personal email or waterfall. 1,458 credits left in the cycle |
| Adyntel | 800 credits | 3,874 | 3,739 | **135** | Google and Meta, PASS companies with a picked buyer only. 204 responses unbilled |
| GetLeads plan | 400 credits | 9,256 | 9,214 | **42** | `lookup_decision_makers` by domain, limit 2. No name enrichment |
| GetLeads wallet | $1.50 | $10.9485 | $10.9435 | **$0.005** | One completed verification batch. Failed or unfinished batches are refunded or released |
| Jev (`jev-1.14.0`) | $2.00 | — | — | **$0.438** | From the run's shared token ledger (Jev has no balance endpoint). ICP qualify $0.369, shadow pre-filter $0.069, owner-gap picks $0.0003, ad classification $0.0003 |

The wallet baseline is $10.9485, taken after the separate shortfall retry had settled. The shortfall run's own retry spend ($0.015) is not counted here.

## Funnel

| Step | Count | % of previous | Notes |
|---|---|---|---|
| Raw discovery lines | 10,536 | | 12 agents, free Apollo lookup, 50 states + DC, 4 query groups |
| Unique domains | 8,607 | | |
| Net-new after dedupe | 3,405 | 39.6% | 2,994 already in production or research, 852 no domain, 1,037 off-ICP names, 298 name collisions (held), 21 chains or franchises (held) |
| Chosen for the run | 3,000 | 88.1% | Round-robin by state. Tag-group companies first, NAICS-only after. 405 are in reserve |
| Redirect duplicates | 19 | 0.6% | Final host already in production or research. Replaced from the reserve, so 3,000 stayed in play |
| Readable for the gate (800 chars or more) | 2,550 | 85.0% | 2,368 readable by plain HTTP, 182 more after the headless retry of 632 thin sites. 450 still unreadable |
| **ICP PASS** | **114** | 4.5% of readable, 3.8% of 3,000 | 36 more held by tighten-only manual review |
| PASS with a buyer email on file (Apollo free search) | 63 | 55.3% | 78 tier 1 and 9 tier 2 picks across 150 searched domains |
| PASS with no Apollo pick → GetLeads lookup (6b) | 51 | | 26 returned contacts. **17 had an eligible tier 1–2 buyer with a work email** (33%) |
| Still no buyer → owner-gap | 34 | | 7 had owner names on the site. Jev picked 6. 1 was dropped because the "name" was a place name. **5 picks → 15 guesses** |
| Revealed (Apollo) | 64 | | 63 at PASS companies (one later moved to HOLD as IT-primary). 63 verified emails, 1 no email |
| GetLeads and guessed addresses verified | 29 submitted | | 10 verified; 19 unverified because their batches never finished (see verification below) |
| **Contact-ready (passed QC)** | **58** | 50.9% of PASS | Apollo 52, GetLeads 6, owner-gap 0 |
| With Campaign 3 copy | 53 | 91.4% | All COPY_C. 5 copy holds (no first-party specialty quote) |

Benchmarks: w2k got 100 contact-ready from 2,000 net-new. This run got 58 from 3,000, because the population was mostly NAICS-only.

## Discovery yield and PASS rate per query group

All groups used employee ranges 11–50, 51–200 and 201–500, and pages 1–4 per state.

| Group | Filter | Raw unique | Net-new | In run | PASS | PASS rate | Contacts |
|---|---|---|---|---|---|---|---|
| G1_INDUSTRIAL | tags: industrial, light industrial, manufacturing, warehouse, logistics staffing | 1,927 | 111 (5.8%) | 111 | 10 | 9.0% | |
| G2_TRADES | tags: skilled trades, construction, welding, trades, craft labor staffing | 960 | 93 (9.7%) | 93 | 9 | 9.7% | |
| G3_GENLABOR | tag: general labor staffing | 37 | 1 | 1 | 0 | — | |
| **Any industrial tag (G1/G2/G3)** | | 2,887 | 205 | 197 | **18** | **9.1%** | 6 |
| **NAICS 56132 only** (no tag) | `organization_naics_codes: ["56132"]` | 7,612 | 3,234 (42.5%) | 2,822 | **96** | **3.4%** | 52 |

- No "temporary staffing", "temp agency" or broad labor tags were used. Tags were not widened.
- The tag groups are nearly exhausted: 93% of what they return was already researched or in production.
- Of the tagged companies that were net-new, 75% landed in HOLD: low-confidence industrial evidence in 83 cases, unreadable sites in 36. These are the leftovers that earlier waves didn't take.
- The NAICS filter (prefix 56132, which covers 561320) is broad. It brings in IT, office and healthcare temp agencies:
  - 1,037 off-ICP names were dropped before the crawl, most from this group.
  - 56% of the NAICS companies in the run also carry an Apollo off-ICP staffing tag.
  - In the gate, 42% were REJECTED and 55% landed in HOLD.
- NAICS hit the 4-page cap in TX, CA, FL, GA, IL, NY and NJ, so more of it exists.

**PASS rate by state (notable):**
- Higher than average: Michigan 8 of 102 (7.8%), Minnesota 5 of 57 (8.8%), South Carolina 4 of 47 (8.5%).
- The largest states sit near the average: Texas 9 of 202 (4.5%), California 8 of 194 (4.1%), New York 8 of 181 (4.4%), Florida 6 of 175 (3.4%), Illinois 4 of 150 (2.7%).

## Shadow pre-filter (new, did not skip anything)

Before the crawl, Jev scored every company from Apollo's free signals only: the company name, which query groups found it, and whether Apollo also tags it with an off-ICP staffing tag (from a free domain-list lookup). **Apollo's free lookup returns no description or keyword list.** Those fields need paid enrich or `mixed_companies_search`, which the skill bans, so the name and tags were the only Apollo-side inputs available. The crawl and gate ran on everything as normal. Cost: $0.069.

| Skip rule: crawl only if p(PASS) ≥ | Crawls saved | PASS recall (share of gate-PASS still crawled) | PASS missed |
|---|---|---|---|
| 0.2 | 48.4% | 79.8% | 23 |
| 0.3 | 73.6% | 58.8% | 47 |
| 0.5 (its own LIKELY_PASS call) | 90.0% | 27.2% | 83 |
| 0.7 | 92.7% | 19.3% | 92 |

- Its LIKELY_PASS call matched the gate 30 times and missed 84 PASS companies.
- It mostly follows the industrial tag: 193 of the 197 tagged companies were called LIKELY_PASS.
- **Verdict:** the score isn't good enough to skip crawls. Keeping 80% of PASS companies saves only about half the crawl. Since crawling is free and quick (about 25 minutes plus the headless retry), **recommendation: keep crawling everything.** The detail is in `runs-private/v4-3000-2026-11-23/shadow_eval.json`.

## ICP gate: reason codes (thresholds and owner decisions unchanged)

| Decision | Reason code | Count |
|---|---|---|
| PASS | VERIFIED_INDUSTRIAL_STAFFING | 114 |
| REJECT | NO_INDUSTRIAL_LINE | 1,098 |
| REJECT | NOT_STAFFING | 100 |
| REJECT | DUPLICATE (redirect to an existing domain; replaced from the reserve) | 19 |
| HOLD | UNVERIFIED | 1,652 |
| HOLD | MANUAL_REVIEW (tighten-only, owner review) | 36 |

**HOLD UNVERIFIED broken down:**

| Reason | Count | Detail |
|---|---|---|
| Low-confidence industrial line or placement model | 993 | Excluded-vertical probability below the 0.8 reject threshold |
| Site not readable (under 800 chars after the headless retry) | 450 | |
| Hands-on worker placement not shown | 68 | |
| Identity conflict (site may not belong to the company) | 64 | |
| US operations not corroborated | 44 | |
| Possibly executive or management search only | 33 | |

**Manual review holds (36):**

| Reason | Count |
|---|---|
| IT-primary homepages | 16 |
| Gig or on-demand apps | 5 |
| Executive search or job boards | 4 |
| Possible chain, subsidiary or franchise | 3 |
| Government-contract workforce | 2 |
| Not clearly a staffing agency | 2 |
| Life sciences | 1 |
| Nonprofit or charter school | 1 |
| Farm labor contractor | 1 |
| International-exchange program | 1 |

**REJECT sample for owner review:** 20 random REJECTs, each with domain, reason code, reason, homepage title and Apollo query group, in `runs-private/v4-3000-2026-11-23/reject_sample.json`.

## Buyers, verification and contact QC, by source path

| Path | Companies reached | Buyer found | Contacts (passed QC) | Verified / catch-all | Paid units | Cost per contact |
|---|---|---|---|---|---|---|
| **apollo** (free search + reveal) | 114 PASS searched | 63 with email | **52** | 39 / 13 | Apollo 64 credits; Adyntel 99 | 1.23 Apollo + 1.90 Adyntel credits |
| **getleads** (6b domain lookup) | 51 | 17 eligible | **6** | 3 / 3 | GetLeads 42 plan credits + $0.005 wallet; Adyntel 28 | 7.0 plan credits + 4.7 Adyntel credits + $0.0008 |
| **owner-gap** (site owner + pattern guesses) | 34 | 5 owners | **0** | — | Jev $0.0003; Adyntel 8; wallet $0 | — (all 15 guesses were in unfinished batches) |
| Jev (shared, mostly the ICP gate) | | | | | $0.438 | $0.0075 per contact |

**Contact QC holds:**

| Path | Hold | Count | Detail |
|---|---|---|---|
| Apollo | Email domain differs and is unproven | 7 | No redirect, on-site reference or link either way |
| Apollo | Person mismatch | 2 | |
| Apollo | No email | 1 | |
| Apollo | Email domain already in production or research | 1 | |
| GetLeads | VERIFY_UNKNOWN | 5 | 4 in unfinished batches, 1 ambiguous non-catch-all |
| GetLeads | Stale org | 2 | |
| GetLeads | Person mismatch | 2 | |
| GetLeads | Role mailbox | 1 | |
| GetLeads | Unproven domain | 1 | |

- Two Apollo emails on other domains were kept with a caution flag. Both were proven by the email domain redirecting to the company domain, a check added to `contact_qc.py` in this run.
- Before verification, 3 GetLeads addresses were dropped as shared role or location mailboxes, and 1 owner-gap pick was removed as not a person.
- 34 PASS companies have no buyer on any path. Their reasons are in `buyer_shortfalls.json`.

**Buyer tiers:** 55 tier 1, 3 tier 2. **Catch-alls:** 16, to be queued last. **Signal priority:** all 58 are LOW_SIGNAL. Ad classes: 48 no ads observed, 5 unrelated or unclear, 4 candidate recruitment, 1 employer acquisition.

## Verification jobs (GetLeads; the provider is still flaky)

- 29 addresses in 3 batches of 10, 10 and 9. Each batch could be polled up to 3 times and a failed batch retried once.
- **First attempt:** all 3 failed at the provider ("could not be started"). They were refunded.
- **Retry:** 1 completed, 10 addresses, $0.005. 2 were still queued after the final poll, and their wallet holds were released. Note: the first three retry polls landed within 8 minutes of submission, so one final status check was made at about 25 minutes. Status checks are free.
- **Totals:**

| Item | Count |
|---|---|
| Jobs submitted | 6 |
| Completed | 1 |
| Failed (refunded) | 3 |
| Never started | 2 |
| Addresses verified | 10 of 29 (34%) |

- No other verifier was substituted.
- The 19 unverified addresses are 4 GetLeads buyers and 15 owner-gap guesses at 5 companies. They stay on HOLD. One successful retry could add up to about 9 contacts.
- In the separate shortfall retry the same day, 3 of 10 batches completed. The provider's fail-or-finish pattern held across both runs: jobs that start finish in 5–15 minutes, and the rest fail at a sweep about 23 minutes after submission.

## Dedupe

- **Exclusion set: 8,042 domains** (5,003 production across all clients, 3,030 earlier research, 9 Codex).
- Built with the new `build_exclude.py` from production, the V4 master and the w2k, shortfall, pilot, wave 1, c1k and c48 runs.
- **Redirect duplicates after the crawl:** 19, replaced from the reserve.
- **Prior reveals:** 0 of the 64 reveal targets had been revealed in any earlier run or the master.
- **Master append:** 0 duplicate domains or emails were skipped.

## What waits on the owner

1. **Review the 58 contacts:** `docs/scalelab-sourcing/runs/v4-3000-2026-11-23/approved-contacts.csv` and `preview/v4-preview.html` (both git-ignored). The 16 catch-alls queue last.
2. **Import and queue** into Industrial Campaign 3 needs your go-ahead (skill stage 12). It was not done.
3. **Discovery strategy for the next run:** the narrow tags are nearly exhausted. NAICS 56132 works but at a third of the PASS rate. Options:
   - Lift the 4-page cap on NAICS in the big states.
   - Try other narrow industrial tags.
   - Accept smaller runs.
4. **Shadow pre-filter:** the recommendation is not to use it to skip crawls (see above).
5. **Owner holds to review:**
   - 36 manual-review companies;
   - 298 name collisions and 21 chains from discovery;
   - 1,652 HOLD UNVERIFIED, mostly NAICS IT or office agencies with low-confidence evidence;
   - the 20-row REJECT sample.
6. **Verification retry (optional):** the 19 unverified addresses could be resubmitted once the provider is stable. That would cost about $0.01.
7. **V4 copy:** the owner writes the copy after seeing the leads.

## Toolkit changes in this run (committed)

New scripts:
- `build_exclude.py`: stage-1 exclusion set.
- `post_crawl.py`: redirect duplicates, reserve backfill and thin-site lists.
- `jevlib.py`: shared Jev access with the run-wide budget enforced against the run ledger.
- `shadow_prefilter.py`: shadow score and evaluation.
- `owner_gap.py`: owner-gap names and pattern guesses.
- `contact_qc.py`: section-9 QC over the Apollo, GetLeads and owner-gap paths, source-tagged, with reverse redirect proof.

Changed scripts:
- `discover_merge.py`: query-group field, per-group counts, `--defer`.
- `qualify.py`: `--only` passes, `buyers_site.json` merged across passes, safe cache merge while the headless retry is writing.
