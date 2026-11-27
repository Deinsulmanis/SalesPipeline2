# HOLD reply test cohort (2026-11-27): counts only

The cohort is built to compare reply rates between HOLD agencies and PASS agencies.
- **Rules:** the same branch, workflow and rules as the PASS runs.
- **Exclusions:** catch-all addresses are left out, so the comparison stays clean.
- **No import, queue or send.**

## Pool

**Source:** HOLD agencies from every industrial run (latest decision per domain).

**Filters:**
- HOLD reason "industrial line not established" or "placement model unclear";
- readable site, US;
- no other blocking reason: employer-facing staffing not established, US operations not corroborated, excluded
  verticals only, identity, chain;
- not healthcare-, IT- or office-only;
- no chain or franchise;
- never contacted: production, the V4 master, pending reveals and second-buyer pools.

| Stage | Agencies |
|---|---|
| **Pool** | **753** |
| of which the site mentions warehouse, light industrial, production, manufacturing or general labor | 561 |
| People found in the free Apollo search | 651 |
| **Tier 1/2 buyer visible (`buyer_pick.py` rule)** | **473** (405 with an email flag) |

The pool is smaller than the ~550 asked for, so all 473 were used.

| HOLD reason (pool) | Agencies |
|---|---|
| Industrial line not established | 410 |
| Placement model unclear | 196 |
| Both | 147 |

## Sources

**GetLeads first (one decision-makers link, max 2 per domain).**
- 200 domains were uploaded, so the worst case was exactly the 400-credit cap. That covered the 68 agencies with no
  Apollo email first, then the strongest industrial sites, spread across states.
- The batch returned 132 contacts at 80 domains (132 credits).
- After the buyer rule and contact QC: 49 usable. They are VERIFY_PENDING in `to_verify.csv`, for the owner to verify.

**Apollo reveals (ids only) only at agencies GetLeads did not cover.**
- 250 revealed (the cap), out of 364 candidates.
- After contact QC: 221 pass, of which 65 are catch-all and excluded from this test.
- **156 verified, non-catch-all.**

## Cohort (`hold_test_contacts.csv`, `cohort=hold_test`, with the HOLD reason)

| Source | Contacts | Status |
|---|---|---|
| Apollo | 156 | Verified (Apollo), not catch-all |
| GetLeads | 49 | VERIFY_PENDING: only VALID will count after the owner's upload |
| **Total** | **205** (52 states/regions) | |

**By HOLD reason:**

| HOLD reason | Contacts |
|---|---|
| Industrial line not established | 118 |
| Placement model unclear | 54 |
| Both | 33 |

**Not in the cohort:**

| Reason | Agencies |
|---|---|
| No usable buyer | 173 |
| Apollo catch-all | 65 |
| Email domain unproven | 14 |
| Person mismatch | 8 |
| Proofpoint gateway + catch-all | 5 |
| Not a buyer | 2 |
| No email | 1 |

**The 400 target is not reachable within the caps.** The pool has 473 agencies with a visible buyer. GetLeads at max 2
per domain can only cover about 200 domains inside 400 credits, and Apollo is capped at 250 reveals. Reaching 400
would need roughly 200 more Apollo reveals, plus a larger HOLD pool, for example one that relaxes the "US operations
not corroborated" or "employer-facing" exclusions.

## Spend

| Tool | This run | Balance change | Cap |
|---|---|---|---|
| GetLeads plan | 132 (batch) | 5,101 → 4,952 (149) | 400 |
| Apollo reveals | 250 (25 calls; reported credits_consumed) | 1,590 → 2,040 (450) | 250 |
| Jev | $0 | n/a | $0.10 |

**About the balance changes:**
- **Apollo:** the balance moved by 200 more than this run's calls report. Apollo's balance had also moved by 145
  between the Campaign 2 run and this one. Another session appears to be using the same Apollo account.
- **GetLeads:** the extra 17 likewise came from outside this run.

## Waiting on the owner

Verify the 49 GetLeads addresses (`runs-private/hold-test-2026-11-27/run/to_verify.csv`). After that, only VALID
addresses stay in the cohort.

## Top-up: extra Apollo reveals (owner approved 150 max, 2026-11-27)

**Revealed:** 126 people, under the 150 cap.
- 114 first picks that were never revealed.
- 12 alternate buyers at agencies whose first reveal failed QC.
- Catch-all domains were skipped.

**Spend:** the balance moved 2,040 → 2,166, which is exactly 126. It matches the calls; nothing outside this run was
spent this time.

**After QC:** 73 more verified, non-catch-all Apollo contacts.

| Source | Contacts |
|---|---|
| Apollo (verified, not catch-all) | 229 |
| GetLeads (VERIFY_PENDING; only VALID counts) | 49 |
| **Cohort total** | **278** (54 states/regions) |

**By HOLD reason:**

| HOLD reason | Contacts |
|---|---|
| Industrial line not established | 160 |
| Placement model unclear | 68 |
| Both | 50 |

**Not in the cohort:**

| Reason | Agencies |
|---|---|
| Apollo catch-all | 96 |
| No usable buyer | 59 |
| Email domain unproven | 19 |
| Proofpoint gateway + catch-all | 10 |
| Person mismatch | 7 |
| Not a buyer | 3 |
| No email | 1 |

**Apollo reveal spend for the test:** 376 (250 + 126). 344 credits remain this cycle.

## Top-up: GetLeads decision-maker lookups (owner approved, 250-credit cap, 2026-11-27)

**Lookups:** 301 untried domains, by domain with up to 2 contacts each and a stop at 248 credits.
- 22 had an Apollo buyer that failed; 279 had no Apollo buyer.
- All 301 were looked up for **200 credits**. The balance moved 4,952 → 4,752, which matches.
- 200 contacts returned; 168 domains returned none.

**After QC:**
- **41 new usable contacts**, VERIFY_PENDING for the owner to verify.
- Rejected: 15 stale organisation, 5 person mismatch, 2 role mailbox.

| Source | Contacts |
|---|---|
| Apollo (verified, not catch-all) | 229 |
| GetLeads (VERIFY_PENDING; only VALID counts) | 90 |
| **Cohort total** | **319** (56 states/regions) |

**By HOLD reason:**

| HOLD reason | Contacts |
|---|---|
| Industrial line not established | 179 |
| Placement model unclear | 82 |
| Both | 58 |

**GetLeads spend for the test:** 332 (132 batch + 200 lookups).

**Verification files:**
- `to_verify.csv`: all 90 addresses;
- `to_verify_new.csv`: the 41 added in this round.

## Top-up 3: GetLeads only, no Apollo (owner caps: GetLeads 500, Jev $0.10; 2026-11-27)

**Pool:** 2,938 HOLD agencies, any HOLD reason, readable or not (1,602 readable), all not yet in hold_test.
- **Excluded:** healthcare-, IT- and office-only (excluded-vertical HOLDs with no industrial wording, or sites
  dominated by those words), chains and franchises, non-US domains, and anyone ever contacted.
- **One domain dropped as malformed.**

**Free count** (buyer titles owner / co-owner / founder / president / CEO / managing partner / VP sales or BD / COO,
email required):
- About 6,100 matching contacts across the pool, any email status. Title matching is broad ("president" also matches
  vice presidents), so that total is high.
- Per-domain counts were not run: they would have needed about 2,900 single-domain calls. The export below charges
  nothing for domains with no match.

**Export:**
- Run on the strongest 750 domains (readable, most industrial wording first), with the same filters plus
  `email_status = VALID`: **1,613 matching** contacts.
- One export at `max_per_company` 2, capped at 300 rows: **300 rows at 220 agencies, all VALID, 300 credits**
  (balance 4,752 → 4,452).

**Buyer rule + contact QC, one contact per agency:**
- **178 verified.** By the owner's rule, VALID export rows count as verified.
- Rejected: 44 stale organisation (the person now works elsewhere), 11 person mismatch, 4 role mailbox.

**Stop rule reached:** 229 Apollo + 178 GetLeads export = **407 VALID**, which is at least 400. The decision-makers
batch link was therefore not created.

| Source | Contacts | Status |
|---|---|---|
| Apollo reveals | 229 | VALID (Apollo verified, not catch-all) |
| GetLeads export | 178 | VALID (owner rule) |
| GetLeads decision makers (batch + lookups) | 90 | VERIFY_PENDING (owner verifies) |
| **Cohort** | **497 agencies** | **407 VALID** + 90 pending |

**By HOLD reason (cohort):**

| HOLD reason | Contacts |
|---|---|
| Industrial line not established | 224 |
| Placement model unclear | 87 |
| Both of the above | 58 |
| Employer-facing staffing not established | 47 |
| Possibly executive search | 24 |
| Hands-on placement not shown | 19 |
| US operations not corroborated | 18 |
| Other | 20 |

**GetLeads spend for this top-up:** 300 of the 500 cap. After it, the balance moved a further 4,452 → 4,276; those 176
credits were not used by this run.

**GetLeads spend for the whole test:** 632 (132 batch + 200 lookups + 300 export). **Jev:** $0.
