# Candidate-ad sweep (industrial ICP): cads-2026-11-26

National sweep of US staffing agencies posting hands-on industrial jobs in the last 60 days (posted since 2026-09-27). ScaleLab only. Output: `runs-private/cads-2026-11-26/qualified_companies.csv` (PASS only) and `holds_rejects.csv` (git-ignored). No buyer finding, reveals, Adyntel or imports. Counts only in this report.

## Funnel

| Stage | Count |
|---|---|
| Discovery calls (unique pages, 51 states x agency words) | 169 |
| Company-state rows scanned | 3450 |
| Industrial-function postings represented in those rows | 24,753 |
| Unique agencies | 1124 |
| Dropped: non-US domain / public body / direct employer | 61 |
| Kept for merge | 1063 |
| Already in production, any client (domain) | 483 |
| Held: name collision with production | 133 |
| Held: corporate chain | 12 |
| Held: franchise shared domain | 4 |
| Held: off-ICP name | 17 |
| **Net-new** | 414 |
| Duplicate after crawl (redirects to a known domain) | 8 |
| Job-posting rule met (2+ hands-on, >= 1/3, 2+ US locations) | 92 |
| Jev-gated | 92 |
| **PASS** | 53 |

Agency words: staffing (state by state), personnel (state by state), workforce (state by state), staff, labor, employment, temps, manpower (national, small). Functions: Manufacturing, Skilled Trades & Maintenance, Supply Chain & Logistics; the requested titles are matched by the hands-on title rule in `jobs_rule.py` (yard jockey/spotter and sanitation added for this run).

## Decisions

- **PASS 53**: website-verified 30, job-postings-verified 23. Top states posted: TX (10); OH (8); SC (8); VA (8); CA (8); PA (7); IL (6); NC (6). HQ address found on own site: 34. Franchise locations: 0.
- **Job-rule HOLD 314**: only N industrial-function posting in the last N days (117); N hands-on of N recent postings (69); N hands-on of N recent postings (N%, under N/N) (66); only N hands-on posting observed of N recent postings (39); only N distinct US posting location(s) in the sample (N+ required) (19); no postings by the agency in the last N days (3).
- **ICP-gate HOLD 39**: UNVERIFIED (36); MANUAL_REVIEW (2); OTHER (1) (UNVERIFIED = the first-party site did not confirm the checks and the postings did not cover the rest).
- **Manual review (tighten-only)**: 2 held (apartment / property-management staffing; nonprofit social-enterprise staffing). One franchise flag corrected (brand rule matched a word in an independent firm's name).
- **REJECT 8**: sites redirect to a domain already in production.

## Spend

| Tool | Cap | Used | Source |
|---|---|---|---|
| Jev (TypeSafe) | $0.50 | **$0.0105** (71 requests, 250,656 tokens) | run ledger `jev_usage.jsonl` (no vendor balance endpoint) |
| GetLeads jobs quota (free) | daily 200,000 | about 26,000 job records across 2026-11-26/27 | `get_jobs_fair_use` |
| GetLeads plan credits | 0 | balance 5,164 -> 5,101 (-63); **not attributed to this run** | `get_fair_use` |
| Apollo, Adyntel, Firecrawl | 0 | 0 | not called |

**Plan-credit note:** this run called only `search_jobs` and `enrich_company_jobs` (documented as jobs-quota only), and none of their responses carry a plan-credit charge. The 63-credit drop since the 5,164 reading at the start of the earlier demand-signal pass is unexplained from this session; the account may have other activity. The demand-signal report stated the balance was unchanged after that pass without a second reading; treat that line as unverified.

## Caveats

- Dedupe covered production (every client, domains and normalized names). Earlier runs' private research folders and the V4 master are not in this environment, so a company researched earlier but never imported could reappear.
- GetLeads timed out often (one call at a time across all agents). Every gap was retried; 1 agency still has no posting data and is held (fail closed).
- Hands-on share is estimated from a 10-posting title sample per agency when it has more industrial postings than that.
- "2+ US locations" counts distinct city/state, or 3-digit ZIP prefix + state when a posting gives only ZIP and state.
- HQ comes only from an address on the company's own site; blank when none was found (never guessed from posting locations).

Scripts: `tools/jobs_discover.py` (state-aware), `tools/jobs_rule.py`, `tools/discover_merge.py`, `tools/qualify.py`, `tools/icp_decide.py`, `tools/candidate_sweep_build.py`.
