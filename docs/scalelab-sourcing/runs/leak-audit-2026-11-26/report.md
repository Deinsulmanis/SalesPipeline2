# Leak audit across ScaleLab industrial sourcing runs (2026-11-26): counts only

Read-only. Every run from the V4 pilot (11-19) to the franchise and registry runs (11-25) and the 11-26 re-checks.
**No paid calls:** only GetLeads job searches on the free jobs quota (about 3,000 postings of the 200,000-a-day budget).
**Tools:**
- `tools/leak_audit.py`: the funnel;
- `tools/jobs_sweep.py`: the jobs sweep;
- `tools/jobs_rule.py`: the HOLD sample.

## Funnel per source

**How each column is counted:**
- **Discovered:** raw unique companies, from each run's report or its `disc/` files.
- **Net-new:** after dedupe against production, every earlier run and the master.
- **Gated:** companies that went through the crawl and the ICP gate. The big runs gated only part of their net-new list
  and kept the rest as a reserve.
- **Readable:** 1,500+ characters of site text.
- **Contacts:** contact-ready, plus the registry and Maps contacts that were not added to the master.

**Drops:**
- Dedupe drop: from discovered to net-new.
- Unreadable drop: from gated to readable.
- Contacts drop: from PASS to contacts.

| Source | Discovered | Net-new (drop) | Gated | Readable (drop) | PASS | HOLD | REJECT | PASS % of readable | Contacts (drop from PASS) |
|---|---|---|---|---|---|---|---|---|---|
| GetLeads company search (V4 pilot) | 104 | 87 (16%) | 75 | 50 (33%) | 24 | 42 | 9 | 48% | 9 (62%) |
| Apollo + Adyntel + GetLeads (wave 1) | 301 | 170 (44%) | 170 | 131 (23%) | 63 | 98 | 9 | 48% | 24 (62%) |
| Codex send-ready list (48) | 48 | 48 (0%) | 48 | 46 (4%) | 48 | 0 | 0 | n/a (Codex-reviewed) | 48 (0%) |
| Codex 1,000-company list | 909 | 861 (5%) | 861 | 607 (30%) | 202 | 630 | 29 | 33% | 47 (77%) |
| Apollo industrial tags (w2k) | 4,787 | 2,595 (46%) | 2,000 | 1,607 (20%) | 212 | 1149 | 639 | 13% | 100 (53%) |
| Apollo tags + NAICS 56132 (v4-3000) | 8,607 | 3,405 (60%) | 3,000 | 2,526 (16%) | 114 | 1688 | 1198 | 5% | 58 (49%) |
| GetLeads job boards (jobs-discovery) | 973 | 312 (68%) | 348 | 300 (14%) | 82 | 206 | 60 | 27% | 45 (45%) |
| Google Maps pilot (TX/OH/GA) | 259 | 182 (30%) | 180 | 139 (23%) | 12 | 115 | 53 | 9% | 0 (100%) |
| Google Maps keywords | 463 | 315 (32%) | 311 | 179 (42%) | 49 | 223 | 39 | 27% | 3 (94%) |
| Illinois DTLSA registry | 470 | 98 (79%) | 98 | 86 (12%) | 29 | 54 | 15 | 34% | 8 (72%) |
| Massachusetts DLS registry | 720 | 82 (89%) | 82 | 71 (13%) | 9 | 37 | 36 | 13% | 2 (78%) |
| NYC DCWP licenses | 247 | 29 (88%) | 29 | 23 (21%) | 0 | 19 | 10 | 0% | 0 (–) |
| **Total** | **17,888** | **8,184 (54%)** | **7,202** | **5,765 (20%)** | **844** | **4,261** | **2,097** | **15%** | **344 (59%)** |

| Re-processing run | Gated | Readable | PASS | HOLD | REJECT | Contacts |
|---|---|---|---|---|---|---|
| Shortfall (GetLeads buyers for PASS without one) | 288 | 0 | 288 | 0 | 0 | 30 |
| Re-gate 551 with job postings | 551 | 548 | 6 | 545 | 0 | 5 |
| Recovery: C2 / V1 Import leads | 154 | 142 | 154 | 0 | 0 | 0 |
| Second buyer: V1 (822) | 822 | 814 | 619 | 198 | 5 | 222 |
| Second buyer: C2 (388) | 388 | 380 | 189 | 174 | 25 | 56 |
| Franchise re-check | 14 | 10 | 5 | 8 | 1 | 0 |
| Fit-doubt re-check (57) | 57 | 54 | 1 | 21 | 35 | 0 |

### Top reasons per source (share of that bucket)

**GetLeads company search (V4 pilot)**
- HOLD: first-party website not accessible: only # characters of first-party t (13); first-party website not accessible: urlerror: <urlopen error [errno -# (9); industrial line not established (8); placement model unclear (5); us operations not corroborated on first-party pages (3)
- REJECT: first-party site shows only excluded verticals , no industrial/skilled (3); first-party site shows unrelated business , not employer-facing staffi (3); first-party site shows hr tech jobboard training marketing consulting  (1); first-party site shows peo eor rpo only , not employer-facing staffing (1); industrial offering is executive/management/professional search only , (1)

**Apollo + Adyntel + GetLeads (wave 1)**
- HOLD: placement model unclear (27); first-party website not accessible: only # characters of first-party t (26); industrial line not established (20); first-party website not accessible: urlerror: <urlopen error [errno -# (13); us operations not corroborated on first-party pages (11)
- REJECT: first-party site shows only excluded verticals , no industrial/skilled (6); first-party site shows peo eor rpo only , not employer-facing staffing (1); industrial offering is executive/management/professional search only , (1); first-party site shows unrelated business , not employer-facing staffi (1)

**Codex send-ready list (48)**

**Codex 1,000-company list**
- HOLD: industrial line not established (164); placement model unclear (163); first-party website not accessible: only # characters of first-party t (134); us operations not corroborated on first-party pages (85); first-party website not accessible: urlerror: <urlopen error [errno -# (74)
- REJECT: first-party site shows only excluded verticals , no industrial/skilled (12); first-party site shows unrelated business , not employer-facing staffi (8); first-party site shows own workforce employer or contractor , not empl (5); industrial offering is executive/management/professional search only , (3); united brotherhood of carpenters millwright union site, not a staffing (1)

**Apollo industrial tags (w2k)**
- HOLD: industrial line not established (503); first-party website not accessible: only # characters of first-party t (299); placement model unclear (228); no first-party industrial excerpt captured (162); us operations not corroborated on first-party pages (142)
- REJECT: first-party site shows only excluded verticals , no industrial/skilled (461); first-party site shows own workforce employer or contractor , not empl (101); first-party site shows unrelated business , not employer-facing staffi (48); industrial offering is executive/management/professional search only , (16); first-party site shows hr tech jobboard training marketing consulting  (11)

**Apollo tags + NAICS 56132 (v4-3000)**
- HOLD: industrial line not established (932); placement model unclear (557); first-party website not accessible: only # characters of first-party t (311); no first-party industrial excerpt captured (307); employer-facing staffing not established (299)
- REJECT: first-party site shows only excluded verticals , no industrial/skilled (1089); first-party site shows unrelated business , not employer-facing staffi (57); first-party site shows own workforce employer or contractor , not empl (22); first-party site shows hr tech jobboard training marketing consulting  (19); industrial offering is executive/management/professional search only , (9)

**GetLeads job boards (jobs-discovery)**
- HOLD: industrial line not established (102); placement model unclear (76); employer-facing staffing not established (40); no first-party industrial excerpt captured (33); first-party website not accessible: only # characters of first-party t (31)
- REJECT: first-party site shows own workforce employer or contractor , not empl (26); first-party site shows unrelated business , not employer-facing staffi (16); first-party site shows only excluded verticals , no industrial/skilled (14); first-party site shows hr tech jobboard training marketing consulting  (3); first-party site shows peo eor rpo only , not employer-facing staffing (1)

**Google Maps pilot (TX/OH/GA)**
- HOLD: industrial line not established (43); placement model unclear (33); first-party website not accessible: only # characters of first-party t (26); no first-party industrial excerpt captured (23); employer-facing staffing not established (14)
- REJECT: first-party site shows only excluded verticals , no industrial/skilled (43); first-party site shows hr tech jobboard training marketing consulting  (6); first-party site shows unrelated business , not employer-facing staffi (4)

**Google Maps keywords**
- HOLD: first-party website not accessible: only # characters of first-party t (81); industrial line not established (45); first-party website not accessible: urlerror: <urlopen error [errno -# (43); placement model unclear (42); employer-facing staffing not established (24)
- REJECT: first-party site shows unrelated business , not employer-facing staffi (11); first-party site shows own workforce employer or contractor , not empl (11); first-party site shows hr tech jobboard training marketing consulting  (9); first-party site shows only excluded verticals , no industrial/skilled (7); industrial offering is executive/management/professional search only , (1)

**Illinois DTLSA registry**
- HOLD: industrial line not established (16); first-party website not accessible: only # characters of first-party t (9); placement model unclear (8); hands-on industrial/trades worker placement not clearly shown (7); us operations not corroborated on first-party pages (7)
- REJECT: first-party site shows only excluded verticals , no industrial/skilled (12); first-party site shows own workforce employer or contractor , not empl (1); first-party site shows unrelated business , not employer-facing staffi (1); first-party site shows peo eor rpo only , not employer-facing staffing (1)

**Massachusetts DLS registry**
- HOLD: industrial line not established (17); first-party website not accessible: only # characters of first-party t (7); us operations not corroborated on first-party pages (4); no first-party industrial excerpt captured (4); may be executive/management search only (3)
- REJECT: first-party site shows only excluded verticals , no industrial/skilled (32); first-party site shows unrelated business , not employer-facing staffi (3); industrial offering is executive/management/professional search only , (1)

**NYC DCWP licenses**
- HOLD: industrial line not established (14); placement model unclear (12); no first-party industrial excerpt captured (11); employer-facing staffing not established (11); first-party website not accessible: only # characters of first-party t (4)
- REJECT: first-party site shows unrelated business , not employer-facing staffi (5); first-party site shows only excluded verticals , no industrial/skilled (5)

### Where the funnel leaks

1. **Dedupe:** about 54% of everything discovered was already known. The Apollo tag pool and the registries are
   largely exhausted: 60–89% were already known.
2. **The gate:** 74% of readable companies are not PASS.
   - HOLD is mostly "industrial line not established" or "placement model unclear": the site does not say it clearly
     enough.
   - REJECT is mostly "excluded verticals only": healthcare, IT and office staffing.
   - There are 8,565 unique gated domains across all runs. Their latest decisions: 1,755 PASS, 4,647 HOLD, 2,163
     REJECT.
3. **Unreadable sites:** 20% of gated companies, worst for Google Maps (42%). 693 HOLDs are an unreachable or empty
   website.
4. **PASS to contact:** 59% of PASS companies never got a contact-ready buyer.

## Recoverable leaks

| Leak | Count | Estimate / note |
|---|---|---|
| HOLDs that would pass under the job-posting rule | **~2%** of HOLDs | See below |
| PASS companies with no contact anywhere (production or master) | **428** | See below |
| Agencies with 5+ branches (crawl address count) | **215** | See below |

**HOLDs and the job-posting rule:**
- **Sample:** 50 random HOLDs that had never been checked for postings, run through the free GetLeads jobs data with
  the same rule as `jobs_rule.py`.
- **Result:** 2 of 50 met the rule, and 1 of them is Tradesmen International, a national chain that stays excluded.
  43 of 50 had no postings at all in 60 days.
- **Estimate:** applied to the 3,168 never-checked HOLDs, about 60 more PASS (a 95% interval of roughly 2 to 300).
- **Consistent with:** the earlier re-gate of 551, which promoted 5.

**PASS companies with no contact:**
- 99 have an owner or executive named on their own site (team/about pages; free extraction from the crawl).
- 115 publish a generic email (info@, sales@, office@ and similar) at their domain.
- 195 have at least one of the two.
- 233 have neither.

**Agencies with 5+ branches:**
- 121 are PASS. 52 of those have exactly one contact and 13 have none.
- Of all 215: 96 have no contact, 63 have one, and 56 have two or more.

## Free GetLeads jobs sweep (estimate for discovery)

**Query:** 30 hands-on industrial titles × 6 staffing name words (staffing, personnel, labor, workforce, temps,
employment), US, postings since 2026-09-27 (60 days), grouped by company. That is 180 queries, every one covered after
the retries: 262 calls.

| Stage | Count |
|---|---|
| Agency rows with a website domain | 828 |
| After the free filters (non-US domain 32, public body 6, direct employer 1) | **789** unique agency domains |
| Industrial postings at those agencies (60 days) | 12,429 |
| Already known (production, every run, master, enrichment lists) | 646 (82%) |
| **Net-new** | **143** (90 with 2+ postings, 45 with 5+) |
| of which a franchise brand (Snelling, Spherion, Express, Remedy) or corporate chain | 8 |

**Titles with the most unique agency domains:**

| Title | Domains |
|---|---|
| forklift | 263 |
| machine operator | 259 |
| assembler | 253 |
| maintenance technician | 242 |
| CNC | 225 |
| welder | 224 |
| warehouse associate | 203 |

Millwright, line worker and boilermaker found fewer than 20 each.

**Caveats:**
- GetLeads fills the company domain on only about 59% of postings, so agencies whose postings carry no domain are
  missed.
- The staffing name words miss agencies with plain brand names.

A wider sweep (more name words, or the three industrial job functions without a title filter) would find more. On
this rate, expect about 15–20% of what it finds to be net-new.

**The owner's CSV:** `runs-private/leak-audit-2026-11-26/jobs_sweep_netnew.csv` (143 rows).
- Columns: `company_domain`, `company_name`, `industrial_postings_60d`, `titles`, `found_by_keyword`,
  `chain_or_franchise_flag`.
- It holds company data only. Rows with a flag should go to the franchise flow or be skipped.

## STOP

Nothing was imported, queued, revealed or bought.
