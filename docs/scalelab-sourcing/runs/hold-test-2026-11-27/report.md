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
