# Illinois registered day & temporary labor agencies pilot (2026-11-25): counts only

ScaleLab only. **No import or queue.**

**Source:** Illinois Department of Labor, Fair Labor Standards Division, Day and Temporary Labor Services Act:
"2026 Registered Agencies as of November 2, 2026" (`RegisteredAgencies 11-2-26.pdf`, 16 pages, created 2026-11-02),
linked from labor.illinois.gov/laws-rules/fls/day-temporary-labor.html.

- The older Employers page (labor.illinois.gov/employers/approveddtlsa.html) still links the 2023 list (as of
  2023-10-02); it was not used.
- The page text spells the date "Noveber 2".

## Funnel

| Stage | Count |
|---|---|
| Registry rows | **1,141** (480 company rows, 661 branch rows; 883 rows with an IL address) |
| Unique agencies | **470** (10 duplicate company rows merged; 321 have an IL HQ or IL branch) |
| Corporate chains (excluded) | 16 (Adecco, Kelly, Randstad and similar) |
| Franchise locations (held, franchise flow) | 18 (mostly Express Employment Professionals offices; also PrideStaff, Spherion, HireQuest) |
| Looked up | 436 |
| **Domains found** | **214** (166 free Apollo organization lookup, 48 web search at high/medium confidence) |
| No domain yet | 222 (see below) |
| Already known (production all clients, every run, V4 master, enrichment lists) | 117 |
| Off-ICP name / duplicate domain / not a company site / franchise brand site | 5 / 4 / 1 / 1 |
| **Net-new** | **86** |
| Website readable (plain + headless) | 72 + some of 14 retried |
| **PASS** | **29** (27 on the website gate + 2 lifted by the job-posting rule); 44 HOLD, 13 REJECT |
| PASS rate | 34% of net-new |
| **Contacts ready now** | **0**: Apollo cap 0, so the 10 Tier-1 buyers found by the free search were not revealed |
| To decision-makers batch | 29 domains, max 2 per domain (at most 58 GetLeads credits) |
| Projected contacts | **~9** (30% decision-maker yield on fresh PASS domains) |

## Why 222 agencies have no domain yet

- **Apollo returned no organization for about 198.** These are small agencies or names Apollo does not have.
- **59 were never Apollo-queried.** The account hit Apollo's limit of 400 organization lookups per hour. A retry about
  9 hours later was still rate-limited, which suggests the limit is shared with other work on the account.
- **51 were never web-searched.** The session limit of 200 web searches per turn ran out.
- **25 off-ICP names were skipped before the web search:** healthcare, IT, janitorial, hospitality.

Both gaps can be closed for free later: about 60 Apollo lookups after the limit resets, and the 51 web searches in a
new turn. On this run's yield, that would add roughly 15-25 domains and 5-10 net-new.

## Job-posting rule

- The GetLeads jobs service responded: 86 counted, 34 with 2+ industrial postings, titles pulled for those. Free jobs
  quota only.
- 6 companies met the rule. 2 were promoted from HOLD to PASS; the others were already PASS or blocked on identity or
  business type.

## Spend

| | Amount |
|---|---|
| GetLeads plan | 0 so far (balance 5,719). The decision-makers batch adds at most 58 when uploaded; cap 200. |
| Apollo | 0 credits (free organization lookup and people search only; no reveals; cap 0) |
| Jev | $0.011 |
| Firecrawl | 4 credits (2 searches to locate the registry) |
| GetLeads jobs | free quota |
| Adyntel | 0 |

**Credits per contact (projected):** about 58 / 9, roughly **6 GetLeads credits per contact**. That is about 15 times
cheaper than the Google Maps keyword pilot (~90), because the registry itself is free and its agencies are real,
operating businesses: 84% of sites were readable, against 57% for Maps.

## Other US states with a similar public registry

Checked on each state's official site (2026-11-25).

| State | List | Covers | Rows | Bulk | As of |
|---|---|---|---|---|---|
| **Massachusetts** | DLS Employment, Placement and Staffing Agencies Program, "list of currently licensed employment and placement agencies" (mass.gov) | Licensed employment agencies and registered placement/staffing agencies, with a staffing flag and branch rows | **1,192** (1,152 placement, 40 employment; 863 flagged staffing; 156 branch rows; 1,051 unique names; 780 with an MA address) | Yes (.xls) | 2026-11-16 (monthly) |
| **New York City** | DCWP Issued Licenses, NYC Open Data (business_category = Employment Agency) | NYC employment agency licenses | **248 active** (365 total) | Yes (CSV/API) | 2026-11-20 |
| New York State | NYS DOL Licensed Employment Agencies (PDF) | Employment agencies; mostly home-care and household | 78 | Yes (PDF) | 2026-11-02 |
| New Jersey | DCA Regulated Business portal, license type "Temporary Help Service Firm" and others | Temp help service firms, employment agencies | Unknown (portal capped at 5,000 mixed rows; no bulk file) | No | Live |
| Connecticut | DOL "Employer Fee-Paid Agencies Registered in Connecticut" (PDF) | Employer-fee staffing and placement agencies | 140 | Yes (PDF) | **2019-03-05 (stale)** |
| Nevada | Labor Commissioner "Private Employment Agencies Licensed" (PDF) | Private employment agencies incl. staffing | ~125 | Yes (PDF) | **2018 (stale)** |
| Michigan | LARA personnel agency licensees (FOIA Excel report) | Personnel agencies | Unknown (report needs JavaScript) | Yes (Excel) | Live |
| Wisconsin | DWD licensed private employment agents | Only agencies charging job seekers; temp help excluded | 5 | No | n/a |

**No usable public list:**

- PA (law repealed 2014), MD (repealed 2013), TX (temp common worker program deregulated 2017), WA (no active
  licensees);
- CA, OR, MN, RI, FL, GA, OH (no general license or list).

Healthcare-only, farm-labor and PEO registries were excluded.

**Best next sources:** Massachusetts (current, about 1,200 rows, staffing flag) and NYC Open Data (248 active, API).

## STOP

Nothing imported or queued. Next steps need the owner:

1. Upload `pass_domains.csv` (29 domains) at the decision-makers link. It expires 18:31 UTC; a new one can be made any
   time.
2. Verify the returned addresses.
3. Optionally, close the free lookup gaps above.
4. Choose whether to run Massachusetts next.
