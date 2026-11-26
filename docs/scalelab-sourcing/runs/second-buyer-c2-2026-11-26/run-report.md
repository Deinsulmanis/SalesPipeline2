# Second-buyer pass: Staffing Outreach Campaign 2 (2026-11-26): counts only

ScaleLab data only; no Jole data. This replaces the plan for 2026-12-06.

**Same flow as second-buyer-2026-11-24:**

- fresh production snapshot (Supabase plus the sheet export);
- pool, then crawl, then Jev re-gate;
- free Apollo search, then `buyer_pick.py` tiers and the multi-site rule (`second_buyer_pick.py`);
- GetLeads `lookup_decision_makers` by domain;
- owner-gap (only `first@` goes out);
- `contact_qc.py`;
- copy v2 (current production copy), with every row tagged `second_buyer=true`, `distinct_by` and `prior_lead_ids`.

**Nothing was imported, queued or sent.** The V4 master was not written (checksum unchanged); outputs were built
against a scratch copy. Adyntel was not used, so every company scores NOT_CHECKED.

## Spend (from balances)

| Tool | Used | Cap |
|---|---|---|
| Apollo reveals | 71 (1,374 → 1,445) | 200 |
| GetLeads plan credits | 135 (5,299 → 5,164) | 200 |
| Jev (run ledger) | $0.062 | $0.30 |

## Pool

**Spacing rule:** the prior contact's last email must be at least **14 days** old (previously 30), via
`second_buyer_pool.py --spacing 14 --strict`.

| | Companies |
|---|---|
| Campaign 2 companies emailed | 403 (plus 86 imported but never emailed, out of scope) |
| Excluded | 13 |
| Mid-sequence, skipped (WAIT) | 2 |
| **Pool (re-gated)** | **388** |

**Excluded, by primary reason:**

- bounced: 8;
- unsubscribe or negative reply: 3;
- positive reply or pipeline: 1;
- neutral reply: 1.

Suppressed for a reason other than a bounce: 3, all overlapping the above. None were excluded for an existing
Campaign 3 contact, and none as a corporate chain.

**Spacing:** every company in the pool was last emailed 20–27 days ago, so all 388 meet the 14-day rule today.

### The 9 Campaign 2 leads still mid-sequence

All 9 are stuck in stage Contacted since late October:

- **7 bounced.** These companies are excluded anyway under this brief.
- **2 are an out-of-office with no return date,** waiting for review.

Eligible date = estimated sequence end + 14 days. A stalled sequence is estimated as if its remaining touches resumed
today.

| Eligible on | Leads |
|---|---|
| 2026-12-10 | 1 (bounced) |
| 2026-12-13 | 8 (6 bounced, 2 out-of-office) |

The per-lead list is in `runs-private/second-buyer-c2-2026-11-26/mid_sequence_c2.csv`.

## Re-gate (V4 gate, fresh crawl)

| | Companies |
|---|---|
| Crawled | 388 (364 readable on the plain crawl, 24 thin sent to the headless retry) |
| **PASS** | **189** |
| HOLD | 174 (industrial line or placement model not established) |
| REJECT | 25 (no industrial line) |

**Branches** (distinct US street addresses on the site): 33 with 3+, 33 with 2, 128 with 1, 194 none found. Of the PASS
companies, 22 are multi-branch.

## Buyers found per path (189 PASS companies)

| Path | Companies |
|---|---|
| Free Apollo search: a distinct new buyer | 69 (plus 2 second picks at multi-branch agencies) |
| GetLeads by domain (120 looked up) | 15 with a distinct buyer after the second-buyer filter |
| Owner-gap (team pages + Jev, prior people excluded) | 9 |
| No distinct buyer on any path | 96 |

- **Free search:** prior contacts were recognised in the search results at 172 of the 189 PASS companies. None of the
  prior contacts had a title on record.
- **GetLeads filter drops:** 46 were the prior contact's own address, 6 had the prior contact's name, and 55 held the
  same role.

## Contact QC

| Result | Contacts |
|---|---|
| **Approved** (Apollo-revealed, Apollo-verified) | **58** |
| of which catch-all (flag, queue last) | 17 |
| **VERIFY_PENDING** (you verify: 9 GetLeads, 9 owner-gap `first@`) | **18** |
| Person mismatch (email not the named buyer) | 5 |
| Email domain unproven | 4 |
| Stale organisation (GetLeads person now elsewhere) | 3 |
| Duplicate: the revealed address is the prior contact | 2, plus 1 multi-branch second pick |
| No email on reveal | 1 |
| Not a buyer on reveal | 1 |
| Role mailbox | 1 |
| Multi-branch extra contact, held (see below) | 1 |

- **The held multi-branch contact:** an area manager at a 6-branch agency whose first pick was also approved. The
  import accepts one contact per company.
- **What makes the 58 approved distinct:**
  - a different buyer role: 52;
  - a different role, with the prior contact's title unknown: 2;
  - a branch, area or regional manager at a 3+ branch agency: 4.
- **Multi-branch:** 7 of the 58 are at multi-branch agencies.
- **Prior campaign:** Campaign 2 for all 58.

## Copy (Campaign 3 copy v2, current production copy)

| | Leads |
|---|---|
| COPY_C, specialty_line (primary) | 0 |
| COPY_C, fallback | 56 |
| HOLD (no variant has verified evidence and complete variables) | 2 |

- **No specialty lines:** none of the first-party excerpts names 2–3 hands-on roles plus a client type in one line.
  The 2026-11-24 run had 1 out of 221.
- **No mention of the prior contact:** checked; no colleague or earlier-outreach wording appears in any rendered email.

## Records

- **Tags:** every approved row is tagged `second_buyer=true`, with `distinct_by`, `prior_lead_ids`,
  `prior_campaign=C2`, `prior_last_emailed`, `branches` and `multi_branch`. `v4_tag` ends in `SECOND_BUYER`.
- **Re-engage pool:** in the company master (`runs-private/second-buyer-2026-11-24/company_master.json`, backed up
  first), 56 companies (the copy-selected approved) are set to `active_contact = second_buyer` and
  `re_engage_eligible = false`, which removes them from the re-engage pool. 18 are marked second_buyer VERIFY_PENDING,
  and the 2 copy HOLDs are marked COPY_HOLD.

## Before import: production still enforces 30 days

Production's Campaign 3 import refuses a second buyer whose prior contact was emailed less than 30 days ago:
`SECOND_BUYER_MIN_DAYS = 30` in `integrations/staffing-campaign-3-import.js`. Your new rule is 14 days.

Under the current code, the 56 importable leads clear the 30-day rule on these dates:

| Prior contact last emailed | Leads (of 58 approved) | Importable under the 30-day rule from |
|---|---|---|
| 2026-10-30 | 22 | 2026-11-29 |
| 2026-11-02 | 10 | 2026-12-02 |
| 2026-11-03 | 11 | 2026-12-03 |
| 2026-11-05 | 13 | 2026-12-05 |
| 2026-11-06 | 2 | 2026-12-06 |

Importing them all now needs `SECOND_BUYER_MIN_DAYS` changed to 14, with its tests, plus a deploy. That is not done;
it needs your go-ahead.

## Files (git-ignored; contact data)

- `docs/scalelab-sourcing/runs/second-buyer-c2-2026-11-26/approved-contacts.csv` (58)
- `docs/scalelab-sourcing/runs/second-buyer-c2-2026-11-26/preview/v4-preview.html`
- `runs-private/second-buyer-c2-2026-11-26/to_verify.csv` (18; one column "email")
- `runs-private/second-buyer-c2-2026-11-26/mid_sequence_c2.csv` (9)

## Waiting on you

1. Approve the 56 copy-selected second buyers (catch-alls queue last).
2. Choose how to import:
   - change the production minimum to 14 days and deploy; or
   - import in date batches from 2026-11-29.
3. Upload `to_verify.csv` (18) to GetLeads, and drop the results at
   `runs-private/second-buyer-c2-2026-11-26/verified_results.csv`.
