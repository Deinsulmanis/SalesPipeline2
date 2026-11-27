# Insurance agencies, Cohort A completion (Texas + Oregon), 2026-11-27

ScaleLab only (commercial / WC insurance agencies as ScaleLab's clients); no Jole data. Counts only: names, emails and
domains live in `runs-private/insurance-agencies-tx-2026-11-27/` (not in git). Nothing was imported, queued, sent,
deployed, and no caps were changed. No Apollo reveals and no Apollo email validation (free Apollo search only).

Owner rules applied: GetLeads export rows with `email_status` VALID count as verified; CATCH_ALL / UNKNOWN go to
`to_verify.csv` (single `email` column). Decision-maker tiers per `ins_config.agency_tier` / `agency_can_pick`
(Tier 1 owner / principal / president / CEO / founder / managing partner; Tier 2 VP / director of commercial lines,
commercial lines manager, sales manager, partner; Tier 3 senior commercial producer only with no Tier 1/2 and <= 50 staff).
One contact per agency. Personal emails and phone numbers were never read.

## Result

| | Count |
|---|---|
| **Cohort A send-ready (approved_contacts_A.csv)** | **538** |
| of which A_TX | 499 |
| of which A_OR | 39 |
| Tier 1 / Tier 2 | 481 / 57 |
| Catch-all addresses (sorted last, from the 2026-11-26 list) | 113 |
| Pending verification (to_verify.csv, owner upload) | 36 |
| Qualifying agencies with no contact yet | 360 (TX 325, OR 35) |

No duplicate emails or agencies (538 rows = 538 emails = 538 domains). Production `outreach_leads` (all clients) was
re-checked read-only: the 60 leads added since 2026-11-26 are all staffing agencies, none overlap.

## New qualifying agencies and new send-ready, by source

| Source (`source` column) | New qualifying agencies (gate PASS) | New send-ready | Pending verification |
|---|---|---|---|
| tx_run_apollo_reveal (list before this task) | (757 PASS, 2026-11-26) | 363 (carried) | - |
| tx_gap (step 1: the 323 no-contact TX agencies, GetLeads export) | - | 74 | 22 |
| held_review_same_firm (step 2: held contacts proven same firm) | - | 36 | - |
| tdi_list (step 3: TDI licence data) | 93 | 26 | 5 |
| gate_recheck (step 4: headless retry of gate HOLDs) | 1 | 0 | 0 |
| oregon (step 5) | 83 | 39 | 9 |
| **New this task** | **177** | **175** | **36** |

### Step 1, TX gap (323 agencies)
GetLeads free count first, export only for domains with matches (max 2 per company). Picks: 74 KEEP (VALID), 22 pending
(CATCH_ALL / UNKNOWN), 10 HOLD (email does not match the person's name 9, role mailbox 1, email domain differs 1).
227 had no GetLeads match.

### Step 2, the 65 held contacts
Same-firm proof for "email on a different domain" (redirect, same phone, same street number + ZIP, one site naming the
other, or Apollo org name = agency): 37 proven; 36 approved and 1 kept on hold because the agency is a platform under
the ICP. Remaining held, by reason: 23 email does not match the person's name; 4 email domain differs and could not be
proven the same firm (1 of them also has no MX); 1 platform. Total still held: 29 (left out of the list).

### Step 3, TDI licence data (data.texas.gov)
- Datasets: 3yqc-fcdt (agency licences), avjc-7u2m (carrier appointments), kvqi-vsrr (agency-person relationships).
  Published by the Texas Department of Insurance as open data, refreshed daily, no licence restriction stated;
  attribute to TDI. Fields used: agency name, licence type / qualification, city, ZIP, NPN, appointment carriers,
  relationship type.
- Funnel: 9,602 P&C agency licences -> 6,873 firms after collapsing and exclusions -> 2,092 with enough commercial
  carrier appointments to look up -> 422 domains resolved (accepted only on name + licence-city match: 190 by
  domain guess verified on the site text, 37 by city-filtered free Apollo lookup) -> 227 new after dedupe against the
  Texas run and production -> gate: 93 PASS, 117 HOLD, 17 REJECT -> 26 send-ready, 5 pending.
- Apollo's free organization search hit its 400 calls / hour limit during lookups; domain guessing replaced it.

### Step 4, gate HOLDs (591 unreadable sites)
Re-rendered with headless Chromium (pw_fetch.js) and re-gated: 1 PASS (no usable contact), 2 REJECT personal lines,
1 REJECT not retail, 587 still unreadable. Unreadable causes: broken / mismatched TLS certificates or hosts not
answering 203, bot blocks (access denied, "you have been blocked", 403) about 70, parked / expired / unpublished
domains about 50, empty pages 22, other errors the rest. These stay on hold.

### Step 5, Oregon (cohort A_OR)
- Discovery: free Apollo organization search (Oregon HQ, 1-50 staff; NAICS 52421 333, commercial / WC keyword tags 197,
  agency / broker tags 254) + GetLeads job postings in 25 Oregon cities (429 rows, 211 companies) -> 503 unique domains.
- Pre-gate by code: 47 captive, 19 duplicate of Texas / production, 10 not insurance, 8 no P&C, 6 mega broker -> 413
  crawled and gated (INS_STATE=Oregon: Oregon presence required).
- Gate: 83 PASS; REJECT 57 captive, 48 not insurance, 21 personal lines only, 14 not retail, 8 no P&C, 7 mega broker,
  19 duplicate; HOLD 92 unreadable, 34 Oregon presence not shown, 11 no industry focus, the rest independent /
  commercial not established or identity conflict.
- GetLeads export for the 83 PASS (max 2 per company): 39 send-ready, 9 pending, 4 held (email / name mismatch 3, no MX 1),
  4 with no eligible title; 27 had no match.

## Files for the owner (private run folder)
- `approved_contacts_A.csv`: 538 rows; brief's columns + `cohort` + `source`; verified first, catch-alls last.
- `to_verify.csv`: 36 addresses, single `email` column.
- `owner_names.csv`: 202 named decision-makers for agencies with no contact (first_name, last_name, company_name,
  company_domain): 75 named on the agency's own site (Tier 1/2 titles only), 127 from TDI licence relationships
  (Desig-Resp-Lic-Person 94, Member 14, Officer/Director 8, Qualifying Active Officer 7, Partner 4). TDI names are
  Texas only and never name-matched to Oregon agencies; whatever the upload returns must still pass the Tier 1/2 rule.
- `batch_upload_domains_A.txt`: 114 domains for one decision-makers batch link (max 2 per domain). These are the
  no-contact agencies with no GetLeads match that were not in the 2026-11-26 batch upload (195 others were, and
  returned nothing). The link expires 2026-11-27 21:52 UTC.

## Projection: Cohort A ceiling
| | Estimate |
|---|---|
| Send-ready now | 538 |
| to_verify.csv (36; about 60-70% usually come back valid) | +22-25 |
| Batch link (114 domains; last batch found contacts for about 5% of domains) | +5-10 |
| **Ceiling without the names upload** | **about 565-575** |
| owner_names.csv (202 names; no past hit rate; at 20-30%) | +40-60 |
| Ceiling with the names upload | about 605-635 |

## Spend vs caps
Balances are shared with other sessions, so spend is taken from each call's own receipt.

| Tool | Cap | Used this task |
|---|---|---|
| GetLeads plan credits | 600 | 319 (exports 176 gap + 49 + 6 TDI / recheck + 77 + 11 Oregon); batch link bills on completion, at most 228 |
| Jev | $0.50 | about $0.06 (TDI gate $0.023, recheck $0.001, Oregon $0.034, earlier passes) |
| Firecrawl | 10 | 0 |
| Apollo | free search only | 0 credits (no reveals, no validation) |

Even if the batch link returned the maximum (228), GetLeads would end at 547 of 600.

## Tooling (tools/insurance/)
gl_export_pick.py, held_review.py, tdi_resolve.py, owner_names.py, tdi_owner_names.py, cohort_merge.py; agency_gate.py
and cohort_merge.py are state-aware (INS_STATE). Insurance logic stays in tools/insurance/ (agency_gate.py, ins_config.py).
