# Batch 3 staffing sourcing report (continuation)

Status: **candidate list only for Phase 2**. No Phase 2 import, queue, send, campaign, cron, template, sender, or dental changes.

Worktree: `/tmp/staffing-batch3` on `cursor/staffing-batch3-sourcing-964b`.
Gmail worktree `/workspace` (`main`) was not used.

Live staffing re-read after Phase 1 and after Phase 2 sourcing: **327 total / 319 queued / 8 sent**. Dental total **1316**.

## Phase 1 recovery (6 infrastructure-held leads)

Retried only these previously `RETRY_REQUIRED` emails. Cached research reused. Thresholds not lowered. Acceptance not forced. The 58 imported Batch 3 leads, 20 genuine ICP/audit/duplicate holds, Batch 1/2, and dental were not reprocessed.

| Outcome | Count |
| --- | ---: |
| Attempted | 6 |
| Accepted HIGH | 0 |
| Accepted MEDIUM | 0 |
| Still `RETRY_REQUIRED` | 6 |
| ICP mismatch | 0 |
| Audit failure | 0 |
| Imported | 0 |
| Queued | 0 |

Retrieval still failed closed: `non_public_address` (leadstaff.com), SSL verify (actionlabor.com), `unusable_or_blocked_page` (laboronsite.com), HTTP 409 (st-staffing.com), expired certificate (staffingauthority.com), HTTP 403 (capitalareastaffing.com).

Live staffing after retry (no writes): **327 / 319 / 8**. Sent unchanged. Dental unchanged.

## Phase 2 sourcing (continuation of remaining 286 credits)

Same method as the first Batch 3 pass:

1. Free Apollo people search (US, SIC 7361/7363, 1–200, senior buyer titles, industrial / warehouse / manufacturing / construction / light-industrial / logistics keywords).
2. Pre-reveal national / ICP / contractor / corpus-duplicate screen.
3. Free org lookup or guessed-domain website fetch for generic names; industrial/trades `SITE_FIT` required (or `keep_name` from SIC staffing search).
4. One buyer per company (`title_rank`).
5. Standard `apollo_people_bulk_match` only (1 credit/person). **No waterfall, no phone.**
6. Verified non-catch-all and verified catch-all admitted. Invalid / unverified / unknown / disposable / do-not-mail / bounced rejected.
7. Post-reveal keyword audit remains the quality gate (weak industrial, IT, exec search, medical, hospitality/event, white-collar, domain mismatch, contractor-not-staffing).

Hard remaining cap at the start of this continuation: **286**. Hard total cap: **400**. Stopped with **90 unspent** because leftover SITE_FIT / keep_name survivors were skip/banned/contractor/off-niche or website-unreadable. Quality was not lowered to spend the rest.

### Credit ledger

| Measure | Value |
| --- | ---: |
| Original Batch 3 pass | 114 |
| This continuation | **196** |
| Cumulative Batch 3 Apollo credits | **310** |
| Remaining of 400 cap | **90** |
| Remaining of original 286 allowance | **90** |
| 400 cap exceeded? | **No** |

### Funnel (jsonl is source of truth)

Funnel counters in `state.json` still include some later-moved post-reveal holds in the verified_* fields. Approved mix below is counted from `out/approved.jsonl`.

| Step | Count |
| --- | ---: |
| People dump files | 105 |
| Apollo people rows reviewed | 10,500 |
| Unique companies in dumps | 2,447 |
| Reveals attempted | 307 |
| Credits spent (cumulative) | **310** |
| Final approved candidates | **157** |
| Verified non-catch-all (Tier 1) | **110** |
| Verified catch-all (Tier 2) | **47** |
| Invalid / unusable emails | 0 |
| Held for review | 149 |
| Rejected (national) | 1 |
| New approved vs original 84 | **73** |
| Phase 2 imported | **0** |
| Phase 2 queued | **0** |

### Pre-reveal skips (current remaining inventory)

| Skip | Count | Credits |
| --- | ---: | ---: |
| Already revealed or dispositioned | 289 | 0 |
| Duplicate company name vs live / sourced / this batch | 330 | 0 |
| Generic already website-rejected | 230 | 0 |
| ICP name reject | 70 | 0 |
| National / enterprise name | 44 | 0 |
| Contractor not staffing | 12 | 0 |
| Weak title | 10 | 0 |
| Duplicate company domain | 1 | 0 |

Integrity Staffing (`integritystaffing.com`) and Quinyx (`quinyx.com`) remain banned before reveal.

Leftover `generic_pass` after this pass (Applied Staffing entity mismatch, CitiStaffing nationwide, Innovative Anesthesia, Integrity, Scion, Workforce Management/Quinyx, MDS, LIVIT white-collar professionals) were **not** revealed.

Leftover `keep_name` rows are contractors, logistics operators, media/production companies, or already website-rejected. Not revealed.

Late-page generic names that org-looked-up without industrial SITE_FIT (Spak/Spark unresolved, Vital healthcare, Bear no industrial evidence, APR/Structure/Move 403, Hatch no industrial evidence) were **not** revealed.

### Efficiency

| Metric | Original 84 | This continuation (73 new) | Cumulative 157 |
| --- | ---: | ---: | ---: |
| Credits | 114 | 196 | 310 |
| Credits per approved candidate | 1.36 | 2.68 | 1.97 |
| Approved candidates per 100 credits | 73.7 | 37.2 | 50.6 |

Generic-name yield is lower than the first keep_name / industrial-named pass. That is expected. Quality was not dropped to recover the original 73.7 rate.

Projected imported yield if the 157 were later authorized at the prior ~69% personalization rate: about 108 imported, live 327 → ~435. That is still short of ~500. Remaining 90 credits were not spent on unread/off-niche leftovers.

### Quality of the 157 approved

- **Lane:** 141 Lane A (light industrial / warehouse / manufacturing / logistics), 16 Lane B (construction / skilled trades).
- **Email:** 110 verified non-catch-all, 47 verified catch-all.
- **Size:** 1–10: 43; 11–50: 73; 51–200: 41. No 201+.
- **Geography:** Largest states CA (16), TX (16), IL (11), OH (9), NC (9), PA (9). No non-US approvals.
- **Continuation 73 mix:** 45 non-catch-all, 28 catch-all.

Approved set remains industrial / skilled-trades staffing agencies. Weak generic homepages and off-niche Apollo keywords were moved to held after reveal.

## Safety

- 400 total Batch 3 credit cap not exceeded (310 / 400; 90 remaining).
- No Phase 2 candidates imported.
- No Phase 2 candidates queued.
- No manual email sent.
- No dental records changed (1316).
- Gmail worktree `/workspace` on `main` untouched.
- ICP / personalization / copy / sender / cadence / cron / caps / suppression / Gmail logic unchanged.
- Standard match only; waterfall/phone not used despite waterfall being enabled on the Apollo team.
- 113+ Batch 3 raw/generated sourcing files stay on this isolated branch; not merged into production application code.

## Output files

- `out/batch3-approved-candidates.csv` (157)
- `out/batch3-continuation-approved-candidates.csv` (73 new vs original 84)
- `out/batch3-rejected-held.csv`
- `out/batch3-credit-ledger.csv`
- `out/batch3-duplicate-exclusion-report.md`
- `out/approved.jsonl`, `held.jsonl`, `rejected.jsonl`
- `state.json` credit ledger
- `raw/remaining-inventory.json`
- `raw/live-totals-phase2.json`

## Follow-on (not done)

Phase 2 candidates are sourcing-only. Do not import, queue, personalize, or send until explicitly authorized. Remaining 90 credits can be used later only if new SITE_FIT / keep_name industrial staffing survivors appear; do not spend them on the leftover skip/banned/contractor/unreadable set.
