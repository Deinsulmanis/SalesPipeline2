# Insurance pilot (Texas): run report, 2026-11-26

This is a read-only pilot of the new niche from `segments/insurance-deep-dive-2026-11-26.md`:

- **ScaleLab's client:** commercial / workers' comp (WC) insurance agencies.
- **The meetings:** booked with employers whose WC policy renews soon.

The report holds counts only: no names, emails or company lists. All private files are in the git-ignored `runs-private/insurance-pilot-2026-11-26/`. Nothing was imported, queued or sent, no caps were changed and nothing was deployed. No Jole data was used.

Code lives in `tools/insurance/`, chosen by running those scripts. The staffing tools came across unchanged from the toolkit branch and were not modified.

## Spend (measured from balances)

| Tool | Cap | Before | After | Used |
|---|---|---|---|---|
| Apollo reveals (`lead_credit.consumed`) | 100 | 1,445 | 1,490 | **45** |
| GetLeads plan credits | 250 | 5,164 | 5,129 | **35**: 8 company lookups (test) + 27 decision-maker records |
| Jev (`jev-1.14.0`) | $0.25 | $0 | $0.0047 | **$0.0047**: 43 agency gate calls |
| Firecrawl | 20 | – | – | **0** |
| Free | – | – | – | Texas open-data API; about 313 Apollo organization lookups; 30 Apollo people searches (15 calls + 15 redo); 12 Apollo agency discovery pages; GetLeads counts |

## 1. Employer side: Texas WC renewals

**Source:** TDI-DWC "Workers' compensation insurance coverage subscriber information" (data.texas.gov `c4xz-httr`). It is refreshed quarterly; the latest effective date is 2026-09-30.

**Filters:**
- record type I (insured);
- expiration 2027-01-25 to 2027-03-26 (60-120 days out);
- state standard premium of $25k or more;
- PEO flag 1 (non-PEO).

**Funnel:**
- 2,581 policies matched the filters.
- 79 dropped as cancelled or non-renewed with no reinstatement.
- 5 dropped as a second policy for the same employer.
- **2,497 employers** remain.

**Industry mapping:** the governing class code is mapped to an industry using approximate NCCI ranges (`ins_config.py`; spot-checked by sampling each bucket). The dataset's SIC/NAICS field is empty for every row.

| Industry | Employers | Note |
|---|---|---|
| Construction | 854 | 746 contracting + 108 field erection (millwright, boiler) |
| Manufacturing | 352 | |
| Trucking / logistics | 221 | 150 are trucking class codes proper (the rest marine, rail, aviation) |
| Warehousing / wholesale | 190 | 37 warehousing + 153 wholesale / distribution |
| Other | 880 | services 313, stores 283, oilfield services 104, utilities / telecom 98, agriculture 46, mining 28, clerical 8 |

| Premium band | Employers | | Renewal month | Employers |
|---|---|---|---|---|
| $25k-50k | 1,269 | | Jan 2027 (from Jan 25) | 209 |
| $50k-100k | 638 | | Feb 2027 | 1,029 |
| $100k-250k | 433 | | Mar 2027 (to Mar 26) | 1,259 |
| $250k-500k | 111 | | | |
| $500k+ | 46 | | | |

By metro (mailing ZIP on the policy):

| Metro | Mfg | Construction | Trucking / logistics | Warehousing | Other | Total |
|---|---|---|---|---|---|---|
| Dallas-Fort Worth | 78 | 213 | 41 | 32 | 172 | 536 |
| Houston | 90 | 193 | 38 | 46 | 154 | 521 |
| Out-of-state mailing address | 82 | 139 | 41 | 51 | 196 | 509 |
| West Texas (Permian / Lubbock / Amarillo / Abilene) | 21 | 57 | 37 | 20 | 90 | 225 |
| San Antonio | 24 | 58 | 13 | 11 | 64 | 170 |
| Austin | 11 | 67 | 9 | 9 | 60 | 156 |
| East Texas | 12 | 36 | 12 | 2 | 33 | 95 |
| Central Texas | 7 | 23 | 9 | 5 | 24 | 68 |
| Other Texas | 8 | 12 | 10 | 1 | 32 | 63 |
| Corpus Christi | 4 | 16 | 4 | 3 | 18 | 45 |
| El Paso | 2 | 15 | 3 | 5 | 16 | 41 |
| Rio Grande Valley | 5 | 16 | 2 | 4 | 10 | 37 |
| Beaumont / Golden Triangle | 8 | 9 | 2 | 1 | 11 | 31 |

**Carriers:** Texas Mutual writes 1,284 of the 2,497 (51%). Next are Zurich American (101), Old Republic (63), National Union (36) and Berkshire Hathaway Direct (33). The voluntary market accounts for 2,487 and the assigned-risk market for 10.

**Other notes:**
- 36 employers in the window have staffing / labor names. They are excluded from people searches and sample lists, because they are the staffing campaign's prospects.
- 7.4% of names are not obvious business names (sole proprietors and similar). They are never shown on a list.

## 2. Contact match test (random 200 employers)

Pipeline stages:
1. Resolve the domain (free Apollo organization lookup by policy name + state; close-name match only; foreign domains on an unlocated retry dropped).
2. Free Apollo people search (owner / founder / C-suite / partner / VP / director / head).
3. Insurance employer buyer rule (`ins_config.employer_tier`):
   - Tier 1: owner / president / CEO.
   - Tier 2: CFO / controller / VP finance or operations / COO / general manager.
   - Tier 3: HR / safety, used only when nobody above has an email.
4. Apollo reveal of the pick.
5. For companies with no Apollo pick, a GetLeads decision-maker lookup by domain (limit 2).
6. Contact QC.

| Stage | Count | Of 200 |
|---|---|---|
| Sample (seed 20261126; 158 Texas mailing addresses, 186 business names) | 200 | 100% |
| Domain resolved, Apollo free lookup | 77 | 38.5% |
| Domain resolved, GetLeads company lookup (test on 20 of the unresolved) | 2 | 1.0% |
| Unresolved: no candidate / no close name / ambiguous | 84 / 29 / 8 | 60.5% |
| Excluded before search: already in production (any client) / staffing agency | 3 / 1 | |
| People-searched domains / with any person / with an eligible pick that has an email | 75 / 59 / 45 | |
| **Path A, Apollo:** revealed / QC keep / QC hold | 45 / **40** / 5 | **20.0% ready** |
| **Path B, GetLeads:** domains looked up / with records / eligible title → VERIFY_PENDING | 30 / 19 / **11** | **5.5% pending** |
| **Combined decision-makers** (40 ready + 11 pending owner verification) | **51** | **25.5%** |

**Picked titles:**
- Tier 1 (owner / president / CEO): 38.
- Tier 2 (CFO / COO): 4.
- Tier 3 (HR / safety): 3.

**QC holds (5):**
- Email domain differs and is unproven: 3.
- Person outside the US: 1. This is also one of the domain differences, so the count overlaps.
- Manual review: 1 (a regional executive, not the employer's decision-maker).

**QC cautions:**
- 12 catch-all addresses: keep, queue last.
- 2 differing domains proven by redirect or an on-site reference: keep, with a flag.

**GetLeads company-lookup test (20 calls, 8 credits):**
- 11 not found.
- 2 found with no domain.
- 5 wrong company (a franchisor, a foreign company, an unrelated domain).
- 2 correct.

So 10% yield at about 4 credits per usable domain. **Not worth scaling.**

| Industry (sample) | Sample | Domain | Apollo ready | GetLeads pending |
|---|---|---|---|---|
| Construction | 63 | 28 | 15 | 5 |
| Manufacturing | 29 | 11 | 2 | 1 |
| Trucking / logistics | 20 | 5 | 3 | 0 |
| Warehousing / wholesale | 10 | 6 | 4 | 1 |
| Other | 78 | 29 | 16 | 4 |

**Cost per matched decision-maker:**
- **Apollo path:** 1.12 reveal credits per QC-passed contact (45 / 40).
- **GetLeads path:** 2.45 credits per contact pending verification (27 / 11), before verification losses.

**Projection to the full 2,497 filtered employers (same rates):**
- About **500 Apollo-ready decision-makers** for about 560 Apollo credits.
- About **137 GetLeads contacts** for about 340 GetLeads credits (before verification).
- About **640 combined** (~25%).
- About 3,900 free Apollo lookup calls (rate-limited at about 200 a minute).

**Bottleneck:** domain resolution, at 39.5%. Policy names are legal entities, often holding companies or truncated at 35 characters. Manufacturing matched worst: 2 of 29 were Apollo-ready, because large or holding entities resolve to the wrong person or none.

## 3. Example renewal sample lists

Built with `tools/insurance/renewal_sample_list.js`, which follows the same pattern as `integrations/scalelab-sample-list.js`: pure selection, a plain-text table, a simple HTML table, and no dashes in cells.

**What each list contains:**
- Columns: company, city, industry, current carrier, renewal month, premium band.
- Business names only. Staffing names are excluded.
- Largest premium first.
- Source attribution to TDI.
- No personal data.

**Lists:**

| List | Rows | Pool | Premium bands | Renewal months |
|---|---|---|---|---|
| Houston manufacturing | 20 | 87 | $250k-500k 7, $100k-250k 13 | Jan 2, Feb 8, Mar 10 |
| DFW construction | 20 | 197 | $500k+ 2, $250k-500k 7, $100k-250k 11 | Jan 1, Feb 7, Mar 12 |
| Texas trucking (statewide) | 20 | 150 | $500k+ 5, $250k-500k 5, $100k-250k 10 | Jan 5, Feb 5, Mar 10 |

Files: `runs-private/insurance-pilot-2026-11-26/sample_lists/*.{csv,txt,html}`.

## 4. Agency side: Texas commercial agencies

**Free counts:**
- GetLeads: 476 C-level contacts at commercial-described insurance agencies with 1-50 staff located in Texas (`count_contacts`). Company counts cannot be filtered by headquarters state.
- Free Apollo discovery: organization lookup, Texas headquarters, 1-10 and 11-50 staff, four query groups (commercial tags / independent tags / agency tags / NAICS 52421), each capped at 3 pages of 100.
- Every group hit the page cap, so the true pool is larger.

**Discovery funnel:**
- 1,170 lines → 840 unique.
- Dropped: 48 with no domain.
- Dropped by name: 6 captive / single-carrier brands, 4 mega brokers or platforms, 3 not retail (MGA / TPA / wholesale), 7 not insurance.
- 0 already in production.
- **772 eligible.**

**Random 50 → crawl → Jev gate.** Insurance ICP config: deep-dive section 3. The thresholds are in `agency_gate.py`. The crawl used plain HTTP, then a headless retry on 12 thin sites; 43 of 50 were readable.

| Decision | Count | Reason codes |
|---|---|---|
| **PASS** | **13** (26%; 30% of readable) | VERIFIED_COMMERCIAL_AGENCY: independent, core commercial lines, Texas presence, WC or industry focus |
| HOLD | 27 | UNVERIFIED 22; NO_INDUSTRY_FOCUS 5 |
| REJECT | 10 | NOT_RETAIL_AGENCY 6 (TPA / carrier / exchange / warranty / credit union); PERSONAL_LINES_ONLY 4 |

**Why the 22 UNVERIFIED HOLDs** (one company can have several reasons):
- commercial lines not core: 10;
- site not readable: 7;
- independent agency not established: 6;
- Texas presence not shown: 4;
- identity conflict: 1.

**Industry focus among the 13 PASS agencies:**
- workers' comp: 12;
- construction: 8;
- manufacturing: 4;
- trucking: 4.

No reveals were made on the agency side.

## 5. Terms of use (prospecting allowed?)

This is research, not legal advice.

### Texas TDI-DWC dataset

**What the sources say:**
- The dataset has no license; attribution is "Texas Department of Insurance".
- The portal is the state's official repository for publicly accessible open data.
- Gov. Code §2054.1265 publishes raw data for the public to "search, extract, organize, and analyze".
- Labor Code §402.083 makes *claim* files confidential, not coverage records.
- Under the Public Information Act (§552.222) the state may not ask the purpose of a request.
- TDI's website disclaimer allows copying "for noncommercial use". It is unclear whether that applies to open-data files.
- The Socrata / Tyler portal terms could not be read.

**Verdict:**
- **Prospecting is allowed, with conditions.** That covers ScaleLab's own use and use on behalf of one agency client.
- **Do not resell or republish the raw dataset.** Its status is unclear.

**Conditions:**
- Credit TDI as the source.
- Never imply TDI endorsement or a state referral.
- Treat dates as possibly stale and confirm the renewal date with the employer.
- Never imply non-compliance.

### Insurance Xdate (terms dated 2026-11-06)

**What the terms say:**
- "Limited… non-transferable license… for your own internal business use".
- The service is for licensed agents and agencies "for their own benefit".
- "Marketing organizations and similar entities are not eligible for standard subscriptions."
- Logins cannot be shared.
- Users may not "resell, sublicense, publish or distribute the data to any third party, inside or outside your agency".
- No bots or scrapers.

**Verdict:**
- **ScaleLab subscribing itself: not allowed.**
- **Using an agency client's subscription on its behalf: not allowed** without Insurance Xdate's written permission or a separate data license, which was not seen.
- **Resale or use across clients: not allowed.**
- Workable route: the agency pulls its own x-dates.
- Pricing could not be verified.

### General
- CAN-SPAM applies to email.
- TCPA and do-not-call rules apply if phones are used.
- Not verified: the Texas Bus. & Com. Code ch. 302/304 B2B exemption, and whether appointment setting needs an insurance license. Keep scripts to booking only: no quotes, no coverage advice.

## Waiting on the owner

- **`to_verify.csv`: 11 addresses** (GetLeads path) at `runs-private/insurance-pilot-2026-11-26/to_verify.csv`. Upload it to GetLeads, then drop the results at `runs-private/insurance-pilot-2026-11-26/verified_results.csv`. To ingest:
  - Run `python3 -I docs/scalelab-sourcing/tools/insurance/ingest_ins_verification.py runs-private/insurance-pilot-2026-11-26`.
  - It reuses `ingest_verification.py`'s mapping and re-runs the insurance QC.
  - Use this, not the staffing `ingest_verification.py`, which would run the staffing outputs.
- **Decision: domain-resolution bottleneck.** About 60% of policy names don't resolve for free. Options:
  1. Accept about 25% coverage.
  2. Add a second free pass (DBA / truncation variants, city filter).
  3. Test a paid enrichment.
  The GetLeads company lookup is not recommended (10% yield).
- **Decision: Texas Mutual concentration.** Texas Mutual holds 51% of renewals. Many independent agencies write it, so this is a talking point, not a blocker.
- **Before any send:** copy for both sides (the owner writes it), and a legal check on Texas telemarketing / insurance-licensing questions for appointment setting.
