# Codex 1,000-company file: PASS and HOLD re-check (2026-11-23)

**Input:** Codex's `ScaleLab_1000_Companies_for_Claude_Code.csv` (wave `scalelab-1000-20261121`), 909 rows:

| Codex group | Rows |
|---|---|
| REVIEW_READY | 48 |
| PASS | 166 |
| HOLD | 695 |

The 48 REVIEW_READY rows were used only as a dedupe set; they were not re-processed.

**Toolkit:** `docs/scalelab-sourcing/tools/`, with run date 2026-11-23 and wave `codex1k-recheck-2026-11-23`.

**Caps approved by the owner:** Jev $0.15, Apollo 30, Adyntel 0, GetLeads 0.

**Production side effects:** none. Supabase was read only. Nothing was imported, queued or sent.

## Spend

| Tool | Cap | Used | Measured by |
|---|---|---|---|
| Jev | $0.15 | **$0.087** (614 requests, ≈2.1M tokens) | `jev_usage.jsonl` (hard stop in `qualify.py`) |
| Apollo | 30 | **19** (standard reveal; no waterfall, phone or personal email) | credit stats 821 → 840 |
| Adyntel | 0 | **0** | balance 4,077 → 4,077 |
| GetLeads | 0 | **0** | — |

**Lesson:** 11 of the 19 reveals were people Codex had already revealed. Codex had held them for email-domain mismatch or Proofpoint catch-all, and its export does not include the emails. About 11 credits could have been saved by asking for Codex's revealed emails first, or by skipping rows where `apollo_person_id` is already filled. The re-reveal did prove 7 of those "domain mismatch" emails belong to the company (redirect or cross-link). **Rule for future runs:** check prior reveals before any paid reveal.

## Dedupe (free)

861 PASS and HOLD companies, 946 distinct domains (company, redirect and email domains), checked against:

- **Codex's 48 REVIEW_READY:** no overlap.
- **Production `outreach_leads` (all clients):** 1 domain hit, a suppressed HireQuest V1 lead.
- **V4 master and Industrial Campaign 3 (33 rows):** no overlap.
- **Pilot and wave 1 research:** 13 companies overlapped; their earlier evidence was reused.

Excluded from paid steps:

| Group | Count | Detail |
|---|---|---|
| Franchise collisions | 7 | HireQuest, Manpower and Snelling locations. The brand is already in ScaleLab history, some of it suppressed. |
| National franchise systems | 10 | Express (2), Global Recruiters Network (4), Labor Finders, LaborMAX, Tradesmen International, All Team. Held for owner review under the ICP's chain/franchise rule. |
| Company-name collisions | 5 | Found after the ICP gate by name-matching PASS companies against production. One affiliate duplicate: Full Steam Staffing NJ (parent Full Steam Staffing was contacted in V1). Four held for owner review: names match V1 leads, two of them suppressed or unsubscribed. |

## Crawl and ICP gate

**Crawl:** plain HTTP, then the default headless browser for empty or blocked sites. 844 companies:

| Result | Count |
|---|---|
| Readable (≥1,500 characters) | 582 |
| Thin, empty or blocked | 202 (the headless retry recovered 178) |
| Domain no longer resolves | 60 |

**ICP:** one Jev request per readable company, then the code thresholds in `icp_decide.py`:

| Codex group | Result here |
|---|---|
| PASS (160 open) | **123 PASS**, 37 HOLD |
| HOLD (684 open) | **85 PASS**, 28 REJECT, 571 HOLD |

Why 37 Codex PASS companies moved to HOLD:

| Reason | Count |
|---|---|
| Industrial line not established on the company's own site | 12 |
| Placement model unclear | 10 |
| Hands-on worker placement not shown | 9 |
| US operations not corroborated | 6 |

A manual review moved one Jev PASS to REJECT: a union website, not a staffing agency.

**After collision holds:** 202 PASS.

## Buyers and contact QC

**Free Apollo search for the 160 open Codex PASS companies:** 31 named senior buyers with an email on file.

After the ICP re-check, collisions and two Apollo organization mismatches, 19 were revealed: 13 owners or CEOs, 3 VPs or COOs, and 3 sales or business-development directors.

All 19 matched with verified emails at the right organization.

Contact QC:

- Email domain must be the company domain or proven related. 7 differing email domains were proven by redirect or on-site reference. 2 are mail-only domains with no website, so the contact is **HOLD**.
- Proofpoint plus catch-all is **HOLD** (2).
- Other catch-alls are kept and flagged to queue last (3).

**Result:** 15 READY_FOR_REVIEW contacts, appended to the V4 master (now 48 rows).

**Industrial Campaign 3 variants (read-only preview):**

- 14 COPY_C with a verified specialty.
- 1 HOLD: Apollo stores the buyer's first name as "Stacy?", and the variable check refuses it. Confirm the name.
- No ad lookups this run (Adyntel 0), so signal priority is `INSUFFICIENT_EVIDENCE`, not LOW_SIGNAL.

**Display names to confirm before import:** "ACT Auto Truck Tire Collision Staffing" (the brand may be "ACT") and "Southland Employment Svc" (Apollo abbreviation).

## Waiting on the owner

**34 named buyers with an email on file at the 82 new PASS companies** (formerly Codex HOLD): 29 owners, presidents or CEOs and 5 VPs. Revealing them would cost at most 34 Apollo credits; 11 remain under the approved cap of 30.

Four are flagged for fit or size before any spend:

- an office and accounting staffing firm;
- a staffing app;
- a duplicate domain of one company;
- a multi-market chain.

Not pursued (credit rule): about 130 Codex PASS companies with no senior buyer email in Apollo. Waterfall enrichment would cost about 2 to 2.5 credits each.

## Files (CSV, evidence and preview are git-ignored)

- `approved-contacts.csv` (15)
- `review-holds.csv`
- `company-qualification.csv`
- `ranked-companies.csv`
- `ad-intent-and-signals.csv` (empty: no ad lookups)
- `v4-copy-evidence.json`
- `preview/v4-preview.html` (all 48 master leads)
