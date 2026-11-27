# Insurance agencies, Cohort B (outside Texas / Oregon), 2026-11-27

ScaleLab only; no Jole data. Counts only: names, emails and domains are in `runs-private/insurance-agencies-B-2026-11-27/`
(not in git). Nothing was imported, queued, sent or deployed, and no caps were changed. GetLeads only for contacts; free
Apollo organization search for discovery; no Apollo reveals or validation.

## Result

| | Count |
|---|---|
| Cohort A send-ready (Texas + Oregon) | 565 |
| **Cohort B send-ready (approved_contacts_B.csv)** | **439** |
| **Cohort A + B (approved_contacts_AB.csv)** | **1,004** |
| Cohort B pending verification | 0 (exports took VALID emails only; to_verify_B.csv is empty) |

Stopped at the target (A + B >= 1,000). No duplicate emails or agencies in approved_contacts_AB.csv (1,004 rows =
1,004 emails = 1,004 domains); no Cohort B domain or email domain is in production `outreach_leads` (all clients) or
Cohort A. Sort: verified first, catch-alls last.

## Cohort B by state

| State | Unique agencies | Crawled + gated | Readable | Gate PASS | PASS % of readable | Exported (1/agency) | Send-ready |
|---|---|---|---|---|---|---|---|
| CA | 771 | 725 | 583 | 131 | 22 | 66 | 36 |
| FL | 795 | 743 | 599 | 155 | 26 | 63 | 41 |
| GA | 298 | 266 | 213 | 76 | 36 | 42 | 23 |
| NC | 295 | 264 | 203 | 93 | 46 | 42 | 22 |
| PA | 297 | 287 | 214 | 104 | 49 | 42 | 27 |
| IL | 295 | 275 | 221 | 79 | 36 | 42 | 20 |
| TN | 290 | 267 | 202 | 98 | 49 | 42 | 22 |
| AZ | 283 | 264 | 215 | 70 | 33 | 42 | 24 |
| IN | 285 | 268 | 220 | 89 | 40 | 42 | 28 |
| MI | 285 | 273 | 214 | 102 | 48 | 42 | 27 |
| OK | 224 | 200 | 148 | 53 | 36 | 42 | 26 |
| LA | 290 | 247 | 200 | 60 | 30 | 42 | 19 |
| SC | 193 | 160 | 136 | 63 | 46 | 21 | 12 |
| AL | 194 | 179 | 147 | 40 | 27 | 21 | 10 |
| MO | 189 | 165 | 139 | 47 | 34 | 21 | 12 |
| WI | 197 | 179 | 147 | 62 | 42 | 21 | 14 |
| KY | 190 | 178 | 140 | 53 | 38 | 21 | 11 |
| AR | 107 | 92 | 67 | 28 | 42 | 21 | 11 |
| NV | 175 | 165 | 124 | 30 | 24 | 21 | 8 |
| CO | 189 | 176 | 136 | 61 | 45 | 21 | 10 |
| VA | 199 | 190 | 144 | 75 | 52 | 21 | 9 |
| NJ | 187 | 179 | 153 | 65 | 42 | 21 | 13 |
| NY | 206 | 194 | 158 | 81 | 51 | 21 | 14 |
| **Total** | 6,434 | 5,936 | 4,723 | 1,715 | 36 | 780 | 439 |

Gate PASS rate: 36% of readable sites (29% of all gated). 935 PASS agencies were not exported (target reached); they
are ranked and ready for a later round.

Cohort B segments and tags (439): hook_segment B_trucking 268, B_hiring 141, B_CA_contractors 17, B_FL 13 (Florida
agencies that write trucking are in B_trucking, by the brief's order). writes_trucking=Y 268, writes_contractors=Y 349,
writes_manufacturing=Y 192. Tier 1: 438, Tier 2: 1.

## Method
1. Free GetLeads counts by state with the buyer filters (Tier 1 titles, VALID email, 2-50 staff): CA 1,815, FL 1,590,
   NY 984, PA 777, IL 638, GA 551, MI 513, NC 468, NJ 405, AZ 369, TN 339, MO 335, CO 324, IN 319, VA 313, WI 271,
   SC 204, LA 187, KY 186, AL 181, OK 180, AR 116, NV 109. Excluded states (ND, OH, WA, WY, TX, OR) were not searched.
2. Discovery: free Apollo organization search per state (HQ in state, 1-50 staff): commercial / WC / independent-agency
   keyword tags (all states), NAICS 52421 (CA, FL) and a HIRING group (agencies posting producer / account manager
   roles). 7,634 rows -> 6,434 unique domains.
3. Exclusions before the crawl: 237 not insurance by name, 119 captive, 52 mega broker / roll-up, 49 wholesale / MGA /
   carrier / TPA / PEO, 22 life / health only, 17 already known (production or Cohort A), 2 franchise (Goosehead /
   Brightway, HOLD) -> 5,936 crawled.
4. Jev gate (agency_gate.py, INS_COHORT=B, each agency's own state): PASS needs an independent multi-carrier agency
   with commercial lines core and a presence in its state. Industry focus ranks instead of filtering (brief: "rank
   higher"): 1,590 PASS with a named WC / industry focus, 125 PASS commercial-only. REJECT: 1,258 not insurance, 311 not
   retail, 137 captive, 115 personal lines only, 61 mega broker, 24 no P&C. HOLD: 1,203 unreadable sites, 317
   independent / commercial not established, 207 identity conflict, the rest weak evidence or no in-state presence.
5. Ranking (b_cohort.py): CA and FL first, then the brief's state order, round-robin across states; inside each state
   writes_trucking=Y first, then named focus (contractors, manufacturing, warehousing, oil and gas), WC expertise and
   hiring; commercial-only last.
6. Exports (b_export.py, GetLeads REST, credit guard): one contact per agency, Tier 1 titles, VALID email only, in rank
   order: 780 agencies -> 470 rows. QC (gl_export_pick.py): 439 KEEP, 26 HOLD (email does not match name 24, role
   mailbox 3, moved employer 2, email domain differs 1), 5 no eligible title.

## Spend vs caps

| Tool | Cap | Used |
|---|---|---|
| GetLeads plan credits | 600 (raised from 400 by the owner) | 470 (receipts: 187 + 240 + 37 + 6) |
| Jev | $0.60 | $0.576 |
| Firecrawl | 5 | 0 |
| Apollo | free search only | 0 credits |

## Tooling (tools/insurance/)
agency_gate.py (per-company state, Cohort B questions: warehousing focus, WC expertise; writes_* tags),
agency_candidates.py (state field, franchise HOLD), ins_config.py (PEO exclusion), b_cohort.py (rank + merge),
b_export.py (REST export with credit guard).
