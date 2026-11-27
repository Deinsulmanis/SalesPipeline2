# Texas insurance agencies (ScaleLab campaign list): run report, 2026-11-26/27

This run sourced every qualifying Texas commercial / workers' comp insurance agency and its decision-maker. ScaleLab's client in this niche is the agency itself.

The report holds counts only: no names, emails or company lists. Private files are in the git-ignored `runs-private/insurance-agencies-tx-2026-11-26/`.

Nothing was imported, queued or sent, no caps were changed and nothing was deployed. No Jole data was used.

- **Code:** `docs/scalelab-sourcing/tools/insurance/`. The staffing tools were reused unchanged.
- **ICP and decision-maker rule:** the brief's ICP field was an unfilled placeholder ("[paste the Texas ICP from chat]"). This run used the deep-dive ICP (`segments/insurance-deep-dive-2026-11-26.md`, section 3), as encoded in `agency_gate.py` and `ins_config.agency_tier`.

## Spend vs caps

| Tool | Cap | This run (from each call's own receipt) | Account balance before → after | Note |
|---|---|---|---|---|
| Apollo reveals | 300 | **300** (26 + 4 batches; `credits_consumed` 260 + 40) | 1,490 → 2,040 consumed (+550) | The balance is shared. A transcript audit of every helper in this run shows exactly 30 `people_bulk_match` calls and no other paid Apollo call, so the other +250 came from parallel sessions. **The cap was reached here**, which is why 126 picked buyers were not revealed |
| GetLeads plan credits | 350 | **0 so far** | 5,129 → 4,969 (−160) | No paid GetLeads call in this run (only free `search_jobs`), so the −160 came from other sessions. The batch link (1 contact per domain, 331 domains) bills **at most 331** when the owner uploads it |
| Jev (`jev-1.14.0`) | $0.50 | **$0.3154** (≈2,900 calls) | | |
| Firecrawl | 15 | **0** | | |

## 1. Discovery

**Free Apollo organization lookup:** Texas HQ, 1-10 and 11-50 staff, three query groups, each paged to its natural end (past the pilot's 3-page cap):

| Group | Query | Pages | Lines |
|---|---|---|---|
| NAICS | 52421 | 35 | 3,419 |
| KW | commercial / business insurance, workers comp, commercial lines, independent agency / agent, contractor / trucking / oilfield insurance | 14 | 1,341 |
| TAG | insurance agency / broker / brokerage / agent / services | 28 | 2,728 |

Statewide paging covers every Texas metro. The lookup returns no location, so per-metro counts are not available.

**Multi-state agencies with a Texas office:** free GetLeads `search_jobs` for insurance-titled roles in 30 Texas cities, 35 calls, 1,183 company rows. Only insurance-named companies were kept, adding 80 domains.

**GetLeads counts (free):** 476 C-level contacts at commercial-described Texas agencies with 1-50 staff (deep-dive count).

**Totals:**

| Stage | Count |
|---|---|
| Raw discovery lines | 8,671 |
| Records with no domain (not crawlable) | 491 |
| **Unique domains** | **4,500** |
| Already known (production `outreach_leads`, every client) | 5 |
| Re-checked from the pilot (13 PASS, 27 HOLD, 10 REJECT carried) | 50 |
| **Net-new** | **4,445** |

The V4 master CSV is not on this machine. Production holds every imported contact, so it is the dedupe source.

**Rejected before the crawl by name or domain** (deep-dive exclusions): 552 in total:
- captive or single-carrier brands: 413;
- life / health / Medicare names with no P&C word: 72;
- not insurance: 60;
- wholesale / MGA / carrier / TPA: 26;
- mega brokers or platforms: 27;
- pilot personal-lines REJECTs: 4;
- duplicates: 5.

## 2. Gate (crawl + `agency_gate.py`)

**Crawl:**
- 3,893 sites crawled by plain HTTP.
- 1,268 came back thin. 407 of those are dead domains (DNS fails); the other 861 (plus 16 thin job-sourced sites) got a headless retry, 882 rendered.
- **2,892 sites were readable and judged by Jev.**

**Gate questions:** independent retail agency; commercial lines core; Texas presence; workers' comp / construction / manufacturing / trucking / oil-and-gas focus; large broker or platform.

| Decision | Count | Top reasons |
|---|---|---|
| **PASS** | **757** | Independent Texas agency, commercial lines core, WC or industry focus |
| HOLD | 2,415 | UNVERIFIED 2,224; NO_INDUSTRY_FOCUS 191 |
| REJECT | 1,328 | Captive 445; not insurance 321; personal lines only 285; not retail 150; no P&C lines 90; mega broker 32; duplicate 5 |

**UNVERIFIED reasons** (one agency can have several):
- site not readable: 1,001;
- commercial lines not core: 820;
- independent agency not established: 600;
- Texas presence not shown: 454;
- identity conflict: 153;
- identity weak: 60;
- possible platform office: 41.

**Pilot re-check:**
- The 27 pilot HOLDs: 25 still HOLD, 2 now REJECT.
- The 13 pilot PASS agencies: all PASS again.
- The 10 pilot REJECTs were carried unchanged.

**The 757 PASS agencies:**

| Specialty | Agencies |
|---|---|
| Workers' comp | 635 |
| Construction | 435 |
| Trucking | 244 |
| Manufacturing | 169 |
| Oil and gas | 85 |

109 have two or more Texas office addresses on their own site.

| Source group (one agency can be in several) | Agencies | PASS |
|---|---|---|
| NAICS | 3,018 | 560 |
| KW | 1,247 | 430 |
| TAG | 2,538 | 531 |
| JOBS | 109 | 22 |

## 3. Decision-makers

**Buyer rule** (`ins_config.agency_tier`):
- Tier 1: principal / owner / president / CEO / founder / managing partner / partner.
- Tier 2: commercial-lines or sales leader.
- Never picked: producers, agents, account managers, CSRs, marketing.

**Free Apollo people search** over all 757 PASS domains: 76 calls of 10 domains, seniorities owner → manager.

| Stage | Count |
|---|---|
| PASS agencies searched | 757 |
| With any person on file | 543 |
| **Picked: eligible title with an email on file** | **426** (Tier 1 396, Tier 2 30) |
| Eligible title but no email on file | 52 |
| People found, no eligible title | 65 |
| No people on file | 214 |
| **Revealed** (Tier 1 first, ranked by WC + industry-focus strength; cap 300) | **300**, all Tier 1, all Apollo "verified" |
| Picked but not revealed (reveal cap reached) | 126 |

**Contact QC** (`agency_contact_qc.py`) checks:
- the email domain matches the agency, or a differing domain is proven by redirect or on-site reference;
- the email matches the person's name;
- current role: Apollo's current employer is the agency (not moved);
- no wrong-person or low-confidence flag;
- the title still passes the rule;
- an MX record exists;
- not a role mailbox.

| QC result | Count |
|---|---|
| **Contact-ready (KEEP)** | **256** |
| … verified, not catch-all | 175 (14 of them on a proven alternate email domain) |
| … verified, catch-all (queue last) | 81 |
| HOLD | 44 (email domain differs and unproven 25; email does not match name 20; one overlaps) |

**Pending verification:** 0 in this run so far (`to_verify.csv` has a header only). The GetLeads batch results will add VERIFY_PENDING addresses once the owner uploads and downloads them.

**No-buyer agencies:** 331 PASS agencies with no eligible person with an email on file. All 331 are in **one GetLeads decision-makers batch link** (`batch_upload_domains.txt`).
- `per_domain_limit` is 1. The brief allowed up to 2, but 2 per domain could bill up to 662 credits against a 350 cap, while 1 per domain bills at most 331.
- The link was created 2026-11-27 00:22 UTC and expires after one hour; a fresh link can be issued.

**qualified_agencies.csv (757 PASS) by contact status:**

| Contact status | Agencies |
|---|---|
| Contact-ready | 256 |
| No buyer, in the GetLeads batch | 331 |
| Picked, not revealed (cap) | 126 |
| Contact held | 44 |

## 4. Outputs (private run folder)

**`approved_contacts.csv` (256 rows):**
- Columns: email, first_name, last_name, title, tier, agency, domain, city, state, office_count, specialties, wc_focus, icp_reason, evidence_url, email_status.
- Catch-alls are last.
- No duplicate emails or domains, and no free-mail addresses.
- 252 rows are TX; 5 have a blank city.

**Other files:**
- `qualified_agencies.csv`: all 757 PASS agencies, with contact status.
- `holds.csv`: 2,415 agency HOLDs and 44 contact HOLDs, with reasons. Not sent.

## GetLeads batch result (owner uploaded, 2026-11-27)

| Stage | Count |
|---|---|
| Domains processed | 331 |
| Contacts found | **17** (one per domain), 17 credits (balance 4,969 → 4,952) |
| No eligible title (producer / agent / account roles) | 9 |
| Eligible title, QC HOLD | 3 (email does not match name 2; email domain differs 1) |
| **Eligible title, QC passed → VERIFY_PENDING** (`to_verify.csv`) | **5** |

**Send-ready now:** 256. That is the Apollo-verified contacts: 175 not catch-all, plus 81 catch-all queued last.

**After the owner verifies the 5 GetLeads addresses:** at most 261. The QC re-run is `ingest_ins_verification.py runs-private/insurance-agencies-tx-2026-11-26` after the results are dropped at `verified_results.csv`.

323 no-buyer agencies remain without a contact.

## Waiting on the owner

- **Upload `batch_upload_domains.txt` (331 domains) at the GetLeads batch link.** It bills at most 331 credits.
  - After the batch completes, save its download as `runs-private/insurance-agencies-tx-2026-11-26/gl_batch_results.csv`.
  - Then run `python3 -I docs/scalelab-sourcing/tools/insurance/agency_contact_qc.py runs-private/insurance-agencies-tx-2026-11-26 --gl-batch runs-private/insurance-agencies-tx-2026-11-26/gl_batch_results.csv`.
  - That writes the new `to_verify.csv` (VERIFY_PENDING) for the owner to verify; ingest the results with `ingest_ins_verification.py`.
- **126 more picked Tier 1 buyers** need reveal credits (cap reached).
- **The pilot's 11-address `to_verify.csv`** (`runs-private/insurance-pilot-2026-11-26/`) is still pending.
- **1,001 HOLDs have unreadable sites.** 407 of those are dead domains. The rest need a manual look, or are better found through a different source.
- **The owner's copy for this campaign.**
