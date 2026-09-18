# Batch 3 personalization funnel (pre-import)

Live production pipeline: Railway commit `732e215` (`EMAIL_ADMISSION`, `catchAllAdmitted`, compliance footer). ICP / audit / duplicate gates unchanged.

Live staffing before processing: **269 total / 261 queued / 8 sent**. Dental total 1316. Unfiltered CRM 2118.

| Gate | Count |
| --- | ---: |
| Attempted | 84 |
| Accepted HIGH | 47 |
| Accepted MEDIUM | 11 |
| **Accepted for import** | **58** |
| Retrieval blocked/unusable | 6 |
| ICP refusals (mismatch + unconfirmed + assessment conflict) | 13 |
| Audit / opening validation failures | 6 |
| Duplicate-opening demotions | 1 |
| Infrastructure / retry-required (still held) | 6 |
| Catch-all accepted | 12 |
| Non-catch-all accepted | 46 |

No Anthropic credit exhaustion. Retry-required remaining after the original run: 5 `RETRIEVAL_UNUSABLE`, 1 `RETRIEVAL_BLOCKED_403`.

## Phase 1 infrastructure retry (6 held leads only)

Retried only the six previously held emails. Cached research was reused when present; homepage retrieval still failed closed. Thresholds were not lowered and acceptance was not forced. None of the 58 imported leads, the 20 genuine ICP/audit/duplicate holds, Batch 1/2, or dental records were reprocessed.

| Outcome | Count |
| --- | ---: |
| Attempted | 6 |
| Accepted HIGH | 0 |
| Accepted MEDIUM | 0 |
| Imported | 0 |
| Queued | 0 |
| Still `RETRY_REQUIRED` | 6 |
| ICP mismatch | 0 |
| Audit failure | 0 |

Per-lead retrieval failures: `non_public_address` (leadstaff.com), SSL verify (actionlabor.com), `unusable_or_blocked_page` (laboronsite.com), HTTP 409 (st-staffing.com), expired certificate (staffingauthority.com), HTTP 403 (capitalareastaffing.com).

Live staffing after retry (no writes): **327 total / 319 queued / 8 sent**. Dental total still 1316.

Live preflight vs current corpus: 0 email overlap, 0 company-name overlap, 58 unique emails/companies, every accepted row has an opening, `[B3]` notes, and `[B3 CATCH-ALL]` only on the 12 catch-all rows.

## Post-write

Canonical `POST /api/coldemail/import` then `POST /api/coldemail/queue` into the existing Industrial Staffing Agency campaign.

- Imported 58 (0 duplicates, 0 junk, 0 suppressed)
- Queued 58 (`primary` / `industrial-staffing-employer-v1` / `industrial_staffing_employer_acquisition_v1`)
- Staffing corpus 269 → 327 (delta 58)
- Queued 261 → 319 (delta 58)
- Sent unchanged at 8
- Dental total unchanged at 1316
- 58/58 canonical ids unique, 58/58 mirrors `mirrored: true`, 0 CAS conflicts
- 58/58 exactly one `lead_queued` activity
- 12/12 catch-all notes include `[B3 CATCH-ALL]`
- No manual send; production agent stayed INTENT-ONLY with zero Gmail provider work during this run
