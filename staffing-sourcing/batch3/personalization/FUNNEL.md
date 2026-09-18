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

No Anthropic credit exhaustion. Retry-required remaining: 5 `RETRIEVAL_UNUSABLE`, 1 `RETRIEVAL_BLOCKED_403`. These were retried twice and remain held.

Live preflight vs current corpus: 0 email overlap, 0 company-name overlap, 58 unique emails/companies, every accepted row has an opening, `[B3]` notes, and `[B3 CATCH-ALL]` only on the 12 catch-all rows.
