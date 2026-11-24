# Second-buyer run (Phase 2, 2026-11-24): counts only

ScaleLab data only. Pool: 764 ICP_UNKNOWN companies plus the 58 manual-hold V1 companies (no hold was
company-level: 57 plain holds, 1 out-of-office) = 822, all previously emailed once (821 V1, 1 C2 among the approved).
No import, queue, send, cap change or deploy. The V4 master was not written (checksum unchanged); outputs were
built against a scratch copy. Adyntel skipped (owner): every company scores NOT_CHECKED.

## Spend (from balances)

| Tool | Used | Cap |
|---|---|---|
| Jev (run ledger) | $0.139 | $0.50 |
| Apollo reveals | 250 (1,102 -> 1,352) | 250 |
| GetLeads plan (lookup_decision_makers by domain, limit 2) | 351 (9,184 -> 8,833) | 400 |
| Adyntel | 0 | 0 |

The two GetLeads halves ran in parallel; the second was stopped at 351 by balance to stay under the cap
(37 of its 185 domains were not looked up).

## Re-gate (V4 gate, fresh crawl)

| | Companies |
|---|---|
| Crawled | 822 (797 readable on the plain crawl, 25 thin sent to the headless retry) |
| PASS | 619 (manual-hold group: 48 of 58) |
| HOLD | 198 |
| REJECT | 5 (no industrial line) |

Branches counted from the crawl (distinct US street addresses): 147 with 3+, 69 with 2, 276 with 1, 330 none found.
Among PASS: 137 multi-branch.

## Buyers (PASS companies only, 619)

- Free Apollo search over all 822 (about 8,300 people). Prior contacts recognised in the results: 559; titles found
  for 364 of the 396 prior contacts with no title on record.
- Distinct new buyer from the free search: 250 companies (first picks) plus 69 second picks at multi-branch companies.
  Reveals covered the 250 first picks (cap); the 69 second picks were not revealed.
- GetLeads by domain on the 369 PASS companies without a distinct buyer: 301 looked up; after removing the prior
  person (139 same email, 14 same name) and same-role people (103), 51 companies had a distinct buyer.
- Owner-gap (team pages + Jev, prior people excluded, first@ only goes out): 33 companies.
- No distinct buyer anywhere: 285 companies.

## Contact QC

| Result | Contacts |
|---|---|
| Approved (Apollo-revealed, Apollo-verified) | 222 |
| of which catch-all (flag, queue last) | 63 |
| VERIFY_PENDING (owner verifies: 38 GetLeads, 33 owner-gap first@) | 71 |
| Person mismatch (email not the named buyer) | 14 |
| Stale org (GetLeads person now elsewhere) | 9 |
| Email domain unproven | 6 |
| Proofpoint + catch-all | 5 |
| Not a buyer on reveal (assistant / payroll / ops titles) | 5 |
| Duplicate (revealed email is the prior contact) | 2 |

Approved, by what makes the contact distinct: different buyer role 141, different role with the prior title unknown
48, different branch (branch / area / regional manager at a 3+ branch agency) 33. 85 of the 222 are at multi-branch
agencies. Prior campaign: V1 221, C2 1.

## Copy (Campaign 3 copy v2, from branch claude/campaign3-copy-v2-2026-11-24)

222 previewed on copy v2: COPY_C 221 (fallback 220, primary 1), HOLD 1. The copy never refers to the earlier
contact (checked: no "colleague" / earlier-outreach wording in any rendered email).

## Records

- Every approved row is tagged second_buyer=true with distinct_by, prior_lead_ids, prior_campaign, branches and
  multi_branch; v4_tag ends in SECOND_BUYER.
- Company master list (runs-private/second-buyer-2026-11-24/company_master.json): 222 companies marked
  active_contact = second_buyer and re_engage_eligible = false (removed from the future re-engage pool); 71 marked
  second_buyer VERIFY_PENDING.

## Files (git-ignored; contact data)

- docs/scalelab-sourcing/runs/second-buyer-2026-11-24/approved-contacts.csv (222)
- docs/scalelab-sourcing/runs/second-buyer-2026-11-24/preview/v4-preview.html
- runs-private/second-buyer-2026-11-24/to_verify.csv (71; one column "email")

## Waiting on the owner

1. Approve the 222 (then they go to the V4 master; import and queue only on your go-ahead).
2. Verify to_verify.csv in GetLeads and drop the results at runs-private/second-buyer-2026-11-24/verified_results.csv.
3. Whether to reveal the 69 multi-branch second picks (69 more Apollo credits) and look up the 37 unchecked domains.

## Import and queue (owner go-ahead 2026-11-24)

- Production change: the Campaign 3 import accepts an owner-approved second buyer (commit 792b055 on
  fix/send-throughput-20261020, deployed by pinning Railway to it; boot clean, crons scheduled, send-lock enabled).
  Without `owner_approved_second_buyer` the import is unchanged.
- Added to the V4 master: 222 (master 588 rows).
- Imported: 219 (156 non-catch-all, then 63 catch-all so they sort last), all COPY_C on copy v2.
  Refused by the new rule: 2 (the prior contact is on the Suppression list for a reason other than a bounce).
  Not sent to import: 1 copy HOLD. These 3 are marked held in the master.
- Queued explicitly: primary 64, deniels 58, outreachplateau_zoe 33, outreachplateau_merrick 32,
  outreachplateau_dave 32. Launch-readiness: 219 of 219 Queued, wouldSendIfSendingEnabled true. Sender balance
  plans no moves into held inboxes.
- Campaign 3 in Supabase: Queued 226 (219 second buyers), Contacted 341, Unsub 1.
- Company master: 219 companies have the second buyer as their one active contact and are out of the
  re-engage pool.
