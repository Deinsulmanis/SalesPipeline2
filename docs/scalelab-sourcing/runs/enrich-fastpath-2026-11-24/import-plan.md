# Fast-path import prep: buyer_ready_combined.csv (2026-11-24, counts only)

Owner file: 178 enriched buyers (GetLeads VALID). Not re-gated, re-researched or re-verified. Nothing imported.

## Dedupe and buyer rules (178 -> 109 contacts at 108 companies)

| Dropped | Count |
|---|---|
| Title is not a tier 1-2 buyer under buyer_pick.py (operations, marketing, managing director, recruiter, CFO, etc.) | 56 |
| Employer on record is a different, non-staffing business (e.g. pressure washing, HOA, financial firm) | 6 |
| Branch / regional manager at a company with fewer than 3 branches | 4 |
| Same company, lower tier (one contact per company) | 2 |
| Company contact limit reached | 1 |

No row was already in production, the V4 master or a pending batch by address.

## From 109 to the plan

- 9 held: multi-branch second contacts at companies that already have an active Campaign 3 lead (allowed by
  the multi-site rule, but the import refuses a company with a live Campaign 3 lead; needs a code change).
- 3 held: no cached crawl / V4 record, so no copy evidence.
- 30 copy HOLD on v2 (no verified industrial specialty on the site: IT, engineering, general recruiting, etc.).
- 1 refused at dry run (prior contact suppressed for a reason other than a bounce).
- **66 importable**: 35 new companies (import), 17 second buyers at finished V1/C2 companies, 14 never-emailed
  production rows (convert in place). Copy v2: COPY_C fallback 65, COPY_A 1, COPY_C primary 0.

## Combined import plan (with the pending jobs-discovery batch)

The pending jobs-discovery batch (50) re-rendered on copy v2: 45 COPY_C fallback, 5 HOLD.

| Payload | Records | Dry run |
|---|---|---|
| 1. Import, non-catch-all (27 jobs-discovery + 35 new + 18 second-buyer) | 80 | 79 accepted, 1 refused |
| 2. Import, catch-all (jobs-discovery), sent second so they sort last | 18 | 18 accepted |
| Convert in place (never-emailed production rows) | 14 | 14 planned |
| **Total** | **111** | |

Queue split (explicit; brings each inbox's load in line with its daily limit; total queue after = 337, about 2 days
at 170 a day):

| Inbox | Convert | Import 1 | Import 2 (catch-all) | Total new |
|---|---|---|---|---|
| primary (50/day) | 4 | 23 | 5 | 32 |
| deniels (45/day) | 4 | 21 | 4 | 29 |
| outreachplateau_zoe (25/day) | 2 | 11 | 3 | 16 |
| outreachplateau_merrick (25/day) | 2 | 12 | 3 | 17 |
| outreachplateau_dave (25/day) | 2 | 12 | 3 | 17 |

## Agency states

scalelab_agency_states: 138 domains backfilled from the file's state column (source lead_record, evidence names
the file); 5 domains already present were left unchanged.
