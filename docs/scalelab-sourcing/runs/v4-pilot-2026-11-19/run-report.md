# ScaleLab Industrial Staffing V4: pilot run report

**Run date:** 2026-11-19 (UTC)
**Campaign:** ScaleLab AI's own customer acquisition (US industrial/skilled-trades staffing agencies). Not Jole BTX. No Jole data, suppressions, senders or copy were used.
**Rules applied:** `ScaleLab_AI_Exact_ICP_Qualification_Spec.md` v1.0 (attached by the owner and saved next to the playbook), the playbook v1.0 and `V4_DECISIONS.md`.
**Authorized budget:** Adyntel ≤ 300 credits, Jev ≤ $0.50, GetLeads ≤ 150 credits. Apollo: none authorized, so none used.
**Production side effects:** none. Nothing was written to Supabase, Sheets or the CRM. Nothing was imported, queued or sent, and no caps changed. Supabase was only read (SELECT).

## 1. Headline numbers

| Stage | Result |
|---|---|
| Companies discovered (GetLeads) | **104** rows |
| Duplicates of ScaleLab history or this batch (REJECT) | 20 |
| ICP **PASS** | **20** |
| ICP **HOLD** | 56 |
| ICP **REJECT** (all reasons) | 28 |
| PASS companies with ads found (Adyntel) | 3 (1 employer-facing and current, 1 employer-facing but stale, 1 candidate-only) |
| Signal priority | 1 STANDARD, 19 LOW_SIGNAL, 0 HIGH_PRIORITY |
| Contacts **READY_FOR_REVIEW** | **7** |
| PASS companies with a buyer whose email needs evidence | 4 |
| PASS companies with no eligible buyer in GetLeads | 9 |

Yield: 104 discovered → 20 ICP PASS (19%) → 7 review-ready contacts (6.7% of discovered).

## 2. Credits and cost

| Tool | Cap | Used | How measured |
|---|---|---|---|
| GetLeads | 150 credits | **137** (104 company rows + 33 contact rows) | Tool responses: `creditsRemaining` went from 10,000 to 9,863 |
| Adyntel | 300 credits | **37** | Free `credits_check` before and after: 5,050 → 5,013. Empty (204) responses were not charged. |
| Jev (TypeSafe) | $0.50 | **≈ $0.011** (259,060 input tokens over 90 calls at $0.042 per Mtok) | `usage.input_tokens` summed from every response |
| Apollo | none | 0 | Not called |
| Firecrawl | none | 0 | Not called |

Jev model pinned: `jev-1.14.0` (`jev-latest` currently points to it).

## 3. Method

1. **Discovery (GetLeads, companies only).** Filters: industries "Staffing and Recruiting" or "Temporary Help Services", US headquarters, 11–200 employees (the preferred size band, not an exclusion).
   - Query A: description mentions skilled trades, welders, millwrights, electricians, pipefitters, machinists or craft labor. This returned all 44 matches.
   - Query B: description mentions "industrial", excluding Query A's domains. This took 60 of 187.
   - GetLeads holds only about 207 US staffing companies of 11–200 employees that mention "industrial", and 44 that mention specific skilled trades.
2. **Dedupe (read-only Supabase).**
   - Exact domain matching on website and email domain across all ScaleLab `outreach_leads` rows (V1, Campaign 2, V2 and the rest). Name matching was limited to staffing campaigns.
   - Rows flagged with `[REPLY: Unsubscribed | Not Interested | BOUNCED | MANUAL HOLD]` were treated as suppressed.
   - Jole rows (`client_id = jole`) were excluded.
3. **First-party evidence (free).**
   - Each company's site was fetched: the homepage plus up to 7 linked service, industry, about and employer pages.
   - JavaScript-only or blocked sites were re-rendered in headless Chromium.
   - Excerpts were saved with URL and `observed_at`.
4. **ICP gate (Jev plus code).**
   - Jev received only the first-party excerpts and the vendor record, with the vendor record labeled as unverified.
   - Questions asked: identity match, business type, industrial line, service model, US operations and national chain.
   - Every company that would PASS got a second check: does it place hands-on workers, or is it management-only search?
   - The decision itself was made in code with fixed thresholds (§7).
5. **Ad evidence (Adyntel, PASS companies only).**
   - Google (US), Meta (US, active and inactive) and LinkedIn (US). First page only, with no all-ads option.
   - Follow-ups: one extract-text call (Lone Star Staffing) and two LinkedIn date-filter calls (Clark Personnel).
   - Ad class came from Jev; points were calculated in code.
6. **Other signals.**
   - The cached first-party pages were scanned for dated internal sales/BD hiring, expansion and new commercial leadership. Nothing qualifying was found.
   - Job boards and news were not searched, because no budgeted tool covers them. These signals are **UNKNOWN**, not zero.
7. **Buyers (GetLeads, PASS companies only).**
   - One `search_contacts` call: senior titles at the 20 PASS domains, emails required. It returned 33 rows; collapsing duplicates left 29 distinct people.
   - Buyers were chosen in playbook order with no randomization.
   - Not eligible as buyers: role mailboxes, people whose current employer is a different business, and generic VP titles.

## 4. Company ICP distribution

| Decision | Reason | Count |
|---|---|---|
| PASS | VERIFIED_INDUSTRIAL_STAFFING | 20 |
| REJECT | DUPLICATE: domain already in V1 or Campaign 2 (2 carry suppression markers or Import stage), or the same franchise domain repeated in this batch | 20 |
| REJECT | NOT_STAFFING: law firm, used-car dealer, ambulance service, job board, PEO/RPO-only | 5 |
| REJECT | NO_INDUSTRIAL_LINE: healthcare/government/admin only, or executive search only | 3 |
| HOLD | First-party site inaccessible: dead DNS, 403/404/503, parked or for-sale domain, bot check or JS-only | 22 |
| HOLD | Ambiguous: industrial line, placement model or hands-on placement unclear, or weak identity | 13 |
| HOLD | Identity conflict: the GetLeads domain belongs to a different business (e.g. "A-1 Staffing" listed as peopleready.com) | 10 |
| HOLD | Possible affiliate of a ScaleLab historical record (Signature Labor, two HireQuest franchises, ExecuSearch) | 4 |
| HOLD | Large national chain or franchise location (Express Employment ×2, System One): owner decision | 3 |
| HOLD | No domain in the GetLeads record | 2 |
| HOLD | US operations not corroborated on first-party pages | 2 |

HOLD is not a disqualification. `review-holds.csv` lists exactly what evidence would resolve each one.

## 5. Ads and scoring

Scoring version `initial-2026-11-18` (40/25/15/10/10). The active-ad window was **30 days**: Google `last_seen` within 30 days, or present in Adyntel's LinkedIn `last30d` filter.

| Company | Ad class | Evidence | Points |
|---|---|---|---|
| Lone Star Staffing (lonestarstaffing.biz) | MIXED | 27 Google text ads; 18 distinct after collapsing duplicates. Run under parent account "Full Steam Staffing, LLC"; the first-party site says "The Full Steam Staffing Family of Companies". Employer-facing creatives live through 2026-11-19, e.g. "We Focus on Providing Clerical and Light Industrial Staffing Solutions to Manufacturers". Running since 2023-06. | 40 + 10 sustained = **50, STANDARD** |
| Clark Personnel (clarkpersonnel.com) | EMPLOYER_ACQUISITION, **STALE** | 3 LinkedIn creatives offering skilled professionals to businesses ("cut production unit costs"). Present in Adyntel's `year` filter, absent from `last30d`; all uploaded 2026-01-15. | 0, LOW_SIGNAL |
| PRT Staffing (prtstaffing.com) | CANDIDATE_RECRUITMENT | 4 Meta and 4 LinkedIn job ads ("$65/hour + $150 per diem… Low Voltage Electricians", CTA "Apply now") | 0, LOW_SIGNAL |
| 17 others | NO_ADS_OBSERVED | None on Google, Meta or LinkedIn (US) | 0, LOW_SIGNAL: the no-ad control group |

No ad spend was inferred: `verified_ad_spend_usd` is empty for every company. Evidence coverage is **PARTIAL** for every company, because BD hiring, expansion and leadership were only checked on cached first-party pages.

## 6. Review-ready contacts (7)

All email statuses are GetLeads `VALID`, all contacts are tier 1 or tier 2 buyers, and all are clear of ScaleLab Supabase leads at both domain and email level.

Buyer names and emails are kept out of this committed report because the repository is public. They are in `approved-contacts.csv`, which is git-ignored and stays local to the run.

| Company | Buyer title | Score | Notes |
|---|---|---|---|
| PRT Staffing | CEO | 0 | Industrial, construction and data-center trades. A CRO and a VP of Business Development are alternates. |
| Staff Line, LLC (Memphis) | President & COO | 0 | GetLeads' contact record lists 501–1,000 employees, larger than the 11–200 preference. That's a priority note, not an exclusion. |
| MK Industries | President & FSO | 0 | Shipbuilding, marine and industrial trades since 1995 |
| HL Welding Inc. | President | 0 | Supplies welders and skilled labor to shipyards and industrial facilities. A conflicting GetLeads record for the same email (a different person at another company) was rejected. |
| FINITETEK INC | Sr VP Sales & Operations | 0 | Construction, manufacturing and oil & gas staffing. The site also has a Canada page; US operations corroborated. |
| Imperial Design (Personnel) | Owner | 0 | GetLeads lists 4 "Owner" records and one belongs to another firm. Confirm the current decision-maker. |
| RPM Staffing Professionals (hiringpartners.com) | President | 0 | Thin first-party site (1 page). No LinkedIn to corroborate employment. |

**Every contact carries one outstanding check: the global Suppression sheet (Google Sheets) was not read.** The Drive connector can't see it; it's probably owned by the app's service account. It must be checked at import. All seven are LOW_SIGNAL (no observed ads), so they serve as the no-ad comparison cohort. The single STANDARD company, Lone Star Staffing, has no revealed buyer email yet: its first-party site names a VP of Sales.

## 7. Decision thresholds (fixed in code)

- **PASS** requires all of the following:
  - identity ≥ 0.70
  - employer-facing staffing ≥ 0.70
  - substantive industrial line ≥ 0.70
  - placement model (temp/contract or direct hire) ≥ 0.50
  - US operations ≥ 0.70
  - national chain < 0.50
  - at least one first-party industrial excerpt
  - hands-on worker placement ≥ 0.70
  - not management-only search
- **REJECT** needs a confirmed identity (≥ 0.70) and positive exclusion evidence ≥ 0.80. Identity below 0.50 is a HOLD for identity conflict. Everything else is HOLD with the specific failing checks.
- Jev probabilities are **classification confidence**, not factual validation. Evidence coverage is tracked separately.

## 8. Risks and gaps

1. **The global Suppression sheet was not checked**, so no contact is admissible until it is.
2. **GetLeads' supply for this niche is small.** There are about 207 "industrial" plus 44 skilled-trades companies in the 11–200 band, and V1 already holds many of the trade-keyword ones: 20 of 104 were duplicates. Reaching 1,000 send-ready leads would need wider size bands, keyword sets, more industries or other discovery sources.
3. **GetLeads domain quality is uneven.** 10 records pointed at an unrelated business and 22 sites were inaccessible.
4. **Contact yield:** 7 of 20 PASS companies were review-ready with GetLeads alone. 13 need Apollo or paid verification, which this run wasn't authorized to use.
5. **Signals beyond ads are UNKNOWN.** Job boards and news weren't searched, so BD-hiring and expansion points are likely understated.
6. **Personalization, V4 campaign registration and the import path don't exist yet.** Copy waits for the owner.

## 9. Funnel arithmetic for scaling (from this pilot, not a forecast)

- Per 100 discovered companies: about 19 PASS and about 7 review-ready with GetLeads-only buyers. Adding Apollo would plausibly bring that to 12–15.
- Adyntel used about 1.85 credits per PASS company: 3 lookups, but empty results were free.
- Jev cost about $0.0002 per company.
- At this rate, 1,000 send-ready leads would need roughly 7,000–14,000 discovered candidates. That's far more than GetLeads currently holds for the strict filter.

## 10. Smallest safe next steps (each needs the owner's go-ahead)

1. Check the 7 contacts against the global Suppression sheet.
2. Authorize Apollo, with a credit cap, for the 13 PASS companies without a review-ready buyer. That includes Lone Star Staffing's VP of Sales.
3. Decide on the HOLD categories: national chains and franchises, the 4 possible affiliates of history, and identity conflicts. The last group could be fixed by looking up the correct domain.
4. Widen discovery (size bands 1–10 and 201–500, more trade keywords, the Construction industry tag) to test supply.

## Files

All `.csv` outputs are excluded from git by the repository's existing `*.csv` ignore rule, plus explicit rules for the contact files. They exist only in the run folder of the session that produced them; only this report and `scripts/` are committed.

| File | Contents |
|---|---|
| `company-qualification.csv` | All 104 companies: decision, reason, first-party evidence URLs and excerpts, Jev answers |
| `ad-intent-and-signals.csv` | Every ad (text, dates, library/landing URL, advertiser) plus other signals for the 20 PASS companies |
| `ranked-companies.csv` | Score components, total, version, coverage, priority, V4 tag, control-group flag |
| `approved-contacts.csv` | The 7 review-ready buyers with provenance. **Git-ignored** (public repo); kept locally. |
| `review-holds.csv` | Every HOLD and REJECT (company level) and contact HOLD, with what would resolve it. **Git-ignored** (contains contact names and emails); kept locally. |
| `scripts/` | The pipeline scripts used (no credentials inside) |

V4 tag format: `V4|PASS|<priority>|<ad_class>|COPY_TIER_PENDING`. The copy tier waits for owner-approved V4 copy.
