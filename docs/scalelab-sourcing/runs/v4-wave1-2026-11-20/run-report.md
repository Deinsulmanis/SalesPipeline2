# ScaleLab V4: wave 1 (200-company pilot) run report

**Run date:** 2026-11-20 (UTC)
**Pipeline:** `docs/scalelab-sourcing/V4_SEND_READY_PIPELINE.md` (proposed), first run.
**Rules:** `ScaleLab_AI_Exact_ICP_Qualification_Spec.md`, playbook v1.0, `V4_DECISIONS.md`.
**Caps (owner-approved):** GetLeads 100, Adyntel 200, Jev $0.25, Apollo 60 (standard reveal; waterfall, phone and personal-email reveals off).
**Production side effects:** none. Supabase was read only. Nothing was imported, queued or sent, and no Apollo contacts or lists were created.

## Funnel

| Step | Count |
|---|---|
| Discovered: Apollo free org search (199), Adyntel Meta keyword ads (12), GetLeads top-up (90) | 301 |
| Already contacted (V1 / Campaign 2), or in the 2026-11-19 pilot (Staffline) | 121 |
| Possible franchise or affiliate of ScaleLab history (HireQuest, First Call, Spherion, Snelling) | 4 (HOLD) |
| Net new, researched | 171 |
| Readable first-party site after crawl + headless fallback | 132 |
| **ICP PASS** | **63** (48% of readable, 37% of net new) |
| Current employer-facing ads (STANDARD priority) | 7 |
| PASS with a free-source buyer that has an email on file | 27 |
| Apollo reveal matched | 26 |
| **Contact QC passed (READY_FOR_REVIEW)** | **22** |

ICP decisions: 63 PASS, 104 HOLD (dead, blocked or thin sites; ambiguous; identity conflicts; chains; affiliates), 128 REJECT (121 duplicates, 7 excluded verticals, 2 not staffing). Details are in `company-qualification.csv` and `review-holds.csv`.

## Spend

| Tool | Cap | Used | Measured by |
|---|---|---|---|
| GetLeads | 100 | **90** | `creditsRemaining` 9,845 → 9,755 |
| Adyntel | 200 | **171** | `credits_check` 5,001 → 4,830: intent lane 10, per-domain 145, text extraction + 2 late PASS 16 |
| Jev | $0.25 | **≈ $0.021** (502k input tokens) | `usage.input_tokens` |
| Apollo | 60 | **31** (26 standard reveal + 5 waterfall for 3 advertisers) | `credit_usage_stats` 1,906 → 1,875 |

Cost per review-ready contact: about 1.2 Apollo, 7.8 Adyntel, 4.1 GetLeads credits.

## Scoring (version `initial-2026-11-18`, 30-day active window)

Seven PASS companies run **current employer-facing ads**, versus 1 of 24 in the pilot:

| Company | Score | Ad class | Buyer status |
|---|---|---|---|
| Aventure Staffing | 50 | MIXED | No email on file for co-founder, founder or director of sales → HOLD |
| AMMON Staffing (Capital City Staffing t/a AMMON) | 50 | EMPLOYER_ACQUISITION | President found, no email on file → HOLD |
| TPI Staffing | 50 | MIXED | Owner and VP found, no email on file → HOLD |
| Power Labor USA | 50 | MIXED | No tier 1–3 buyer found → HOLD |
| A Better Choice Staffing | 50 | MIXED | Only a generic VP → HOLD |
| **RJ-Staffing** | 40 | MIXED | **Owner, ready** |
| **Ameri-Force** | 40 | MIXED | **President/CEO, ready (catch-all)** |

Everything else scored 0. That includes stale or candidate-only ads (PEG and Motive had employer-facing ads, but none from the last 30 days). Internal BD hiring, expansion and leadership signals were not searched beyond cached first-party pages, so they are UNKNOWN.

## Contact QC

Checks applied: identity, title, email domain, MX gateway, catch-all, and dedupe on email and domain against ScaleLab Supabase leads and the pilot.

- **Held (5):**
  - Flexblue: the buyer resolved to another employer, with no email.
  - Equity Staffing: `equitysg.com` relation unproven.
  - Resource Employment: the CEO's email is at True PEO.
  - Motive Workforce: `motivecompanies.com` relation unproven.
  - OpSource: no match.
- **Catch-all (8):** kept and flagged to queue last.
- **Proofpoint without catch-all (3):** kept and flagged.
- **Low-confidence Apollo matches (2: SCI, CPI):** kept with a caution, because the people are named on the companies' own team pages.
- **Global Suppression sheet:** still not checked (not readable from this cloud session). It must be checked at import.


## Follow-up: waterfall for employer-advertisers (2026-11-20)

The owner approved waterfall enrichment for the buyers of the advertisers that had no email on file. It cost 5 credits.

- **TPI Staffing (Founder/Owner):** verified (ZeroBounce valid, Icypeas ultra_sure), not catch-all. **Approved, score 50, STANDARD.** The V1 "TPI Staffing Group" (tpistaffing.net) is a different NH/VT company.
- **AMMON Staffing (President):** verified, not catch-all. **NEEDS_EVIDENCE.** The legal name "Capital City Staffing, LLC" resembles the V1 lead "Capital City Staffing Solutions" (capcitystaffing.com, site returns 403). It is a possible affiliate collision and the owner must check it.
- **Aventure (founder named on its site):** rejected. Apollo matched an unrelated "Aventure IT" (Sri Lanka) and returned an extrapolated email that ZeroBounce marked invalid.
- **Power Labor and A Better Choice:** not attempted. No playbook buyer was found in a broader free Apollo search or on their sites.

The master list now holds 33 rows: **32 READY_FOR_REVIEW** (3 STANDARD, 29 LOW_SIGNAL) plus 1 NEEDS_EVIDENCE (AMMON).

## Lessons

1. **About 40% of free discovery is already contacted.** Apollo's "industrial staffing" tag overlaps heavily with V1, so future discovery should use different keyword tags, size bands or geographies.
2. **Meta keyword search is a usable intent lane; LinkedIn keyword search is not** (mostly personal posts).
3. **The biggest leak is buyers at advertisers.** Five of the seven employer-advertising agencies had no email-bearing buyer. Waterfall enrichment for just those 5 is the highest-value next spend.
4. Apollo maps some domains to unrelated or franchise orgs (Construction Labor Contractors, The Reserves Network, Next Level), so name-matching the org is required.

## Files (CSV files are git-ignored; contacts are never committed)

- `company-qualification.csv`
- `ranked-companies.csv`
- `ad-intent-and-signals.csv`
- `approved-contacts.csv` (22)
- `review-holds.csv`
- `scripts/`
- `../V4_APPROVED_CONTACTS_MASTER.csv`: **31 contacts** (pilot 9 + wave 1 22), one row per buyer, with `demand_score`, `signal_priority`, `ad_class`, score components and `v4_tag` (`V4|PASS|<priority>|<ad_class>|COPY_TIER_PENDING`). The copy tier waits for the owner's copy decision per demand-score bucket.
