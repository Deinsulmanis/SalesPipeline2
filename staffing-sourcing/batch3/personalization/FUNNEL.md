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

## Phase 2 sourcing continuation (not personalized)

Additional sourcing under the remaining 286-credit allowance produced **73** new approved candidates (cumulative **157** / **310** credits / **90** unspent of the 400 cap). Phase 2 candidates were **not** personalized, imported, queued, or sent. Live staffing after Phase 2 sourcing is unchanged: **327 / 319 / 8**. Dental still 1316.

Live preflight vs current corpus: 0 email overlap, 0 company-name overlap, 58 unique emails/companies, every accepted row has an opening, `[B3]` notes, and `[B3 CATCH-ALL]` only on the 12 catch-all rows.

## Phase 2 continuation personalization (73 new candidates only)

Processed **only** `out/batch3-continuation-approved-candidates.csv` (73 unique emails). The original 84 / imported 58 were not re-run. The six older infrastructure-held leads were not retried. Live pipeline commit `732e215` unchanged. No additional Apollo credits.

Anthropic live key is exhausted (`MODEL_CREDITS_EXHAUSTED`). Completed non-infra cache was reused. Unprocessed remainder is held retry-required; acceptance was not forced.

| Gate | Count |
| --- | ---: |
| Attempted | 73 |
| Accepted HIGH | 5 |
| Accepted MEDIUM | 1 |
| **Accepted for import** | **6** |
| Retrieval blocked/unusable | 2 |
| ICP refusals | 1 |
| Audit / opening validation failures | 2 |
| Duplicate-opening demotions | 3 |
| Infrastructure / retry-required | 61 |
| Catch-all accepted | 5 |
| Non-catch-all accepted | 1 |

Retry-required split: 2 `RETRIEVAL_UNUSABLE` + 59 `MODEL_CREDITS_EXHAUSTED` (includes dense-filled unprocessed rows after the model-credit stop). Duplicate-opening first claimants were the prior 58 Batch 3 accepted openings.

Live preflight vs current corpus **327 / 319 / 8** (dental 1316): 0 email overlap, 0 company overlap, 0 domain overlap, 0 overlap with the original 58 or held-6. Every accepted row has an opening, `[B3]` notes, and `[B3 CATCH-ALL]` only on the 5 catch-all rows.

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

## Phase 2 continuation post-write

Canonical `POST /api/coldemail/import` then `POST /api/coldemail/queue` into the existing Industrial Staffing Agency campaign. Only the 6 continuation leads that cleared every existing gate were written.

- Imported 6 (0 duplicates, 0 junk, 0 suppressed)
- Queued 6 (`primary` / `industrial-staffing-employer-v1` / `industrial_staffing_employer_acquisition_v1`)
- Staffing corpus 327 → 333 (delta 6)
- Queued 319 → 325 (delta 6)
- Sent unchanged at 8
- Dental total unchanged at 1316
- 6/6 canonical ids unique, 6/6 mirrors `mirrored: true`, 0 CAS conflicts
- 6/6 exactly one `lead_queued` activity; 0 send events; `lastEmailedAt` empty
- 5/5 catch-all notes include `[B3 CATCH-ALL]`; Alliance Workforce (non-catch-all) does not
- Launch readiness `missingPersonalization: 0` across 333 staffing rows
- Campaign sending state left `Active / sending`; copy version still `staffing_locked_v1`
- Held-6 emails still absent from the live corpus
- No manual send; no agent trigger; no additional Apollo spend; Gmail worktree and dental records untouched

## Credits-exhausted recovery (59 leads only)

Final Anthropic-funded recovery of continuation leads held as `MODEL_CREDITS_EXHAUSTED`. Completed HIGH/MEDIUM/REVIEW/ICP outcomes, the two `RETRIEVAL_UNUSABLE` continuation holds, and the six older infrastructure-held leads were not retried. Live pipeline `732e215` unchanged.

Pre-run inventory: **6** already had usable cached pages; **53** required fresh homepage retrieval. All 59 still needed extract / fact-audit / opening-audit model calls. The run reused **7** research snapshots (6 prior + 1 in-run retry) and fetched **52** homepages.

| Gate | Count |
| --- | ---: |
| Attempted | 59 |
| Cached research reused | 7 |
| Fresh research required | 52 |
| Accepted HIGH | 17 |
| Accepted MEDIUM | 4 |
| **Accepted for import** | **21** |
| Retrieval blocked/unusable | 11 |
| ICP refusals | 14 |
| Audit / opening validation failures | 6 |
| Duplicate-opening demotions | 7 |
| Remaining retry-required | 11 |
| Catch-all accepted | 4 |
| Non-catch-all accepted | 17 |

Remaining retry-required is retrieval/domain only (`RETRIEVAL_UNUSABLE` 5, `RETRIEVAL_PAGE_NOT_FOUND` 3, `RETRIEVAL_BLOCKED_403` 1, `DOMAIN_IDENTITY_UNRESOLVED` 2). Zero `MODEL_CREDITS_EXHAUSTED`. Anthropic usage: 133 calls, 0 errors, 946,819 input tokens, 88,442 output tokens.

Live preflight vs **333 / 325 / 8** (dental 1316): 21 unique emails, 0 overlap with live corpus, original 58, continuation 6, or held-6.

## Credits-exhausted recovery post-write

- Imported 21 (0 duplicates, 0 junk, 0 suppressed)
- Queued 21 (`primary` / `industrial-staffing-employer-v1` / `industrial_staffing_employer_acquisition_v1`)
- Staffing corpus 333 → 354 (delta 21)
- Queued 325 → 346 (delta 21)
- Sent unchanged at 8
- Dental total unchanged at 1316
- 21/21 canonical ids unique, 21/21 mirrors `mirrored: true`, 0 CAS conflicts
- 21/21 exactly one `lead_queued` activity; 0 send events; `lastEmailedAt` empty
- 4/4 catch-all notes include `[B3 CATCH-ALL]`; 17/17 non-catch-all notes do not
- Launch readiness `missingPersonalization: 0` across 354 staffing rows
- Campaign sending state left `Active / sending`; copy version still `staffing_locked_v1`
- Held-6 emails still absent
- No manual send; no agent trigger; no Apollo spend; Gmail worktree and dental records untouched
- Stopped after this recovery; no further sourcing or retry cycle


