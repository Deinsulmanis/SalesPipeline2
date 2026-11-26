# Recovery of the 187 Campaign 2 / V1 Import-stage leads (2026-11-24)

Run name `recovery-c2-import-2026-11-24`. The leads were held by `STAFFING_HOLD_V1` in Staffing Outreach Campaign 2 and Industrial Staffing Agency (V1). The review below was read-only on production. No buyer names or emails appear here; contact-level files are git-ignored.

> **Update, same day:** with the owner's approval, **51 recovered leads were converted in place into Industrial Campaign 3 and queued**. See [Conversion into Campaign 3](#conversion-into-campaign-3-owner-approved). Nothing was archived.

## Result

| Fit (Campaign 2 review) | Leads | Outcome |
|---|---|---|
| ICP_CONFIRMED | 141 | **44 pass contact QC, 39 copy-ready for Campaign 3 (COPY_C)**, 97 held |
| ICP_UNRESOLVED | 21 | Owner review table (domain, reason, homepage title) in `runs-private/recovery-c2-import-2026-11-24/unresolved_review.json` |
| ICP_REJECT | 25 | Listed for archiving in `runs-private/recovery-c2-import-2026-11-24/reject_archive_list.json` (15 non-industrial, 10 ICP reject; 6 carry `[MANUAL HOLD]`). Nothing was archived |

- **Source of the leads:** pulled from the dashboard API, `GET /api/coldemail?client=scalelab&stage=Import`, which returned 187. Raw rows were read from Supabase (read-only).
- **State at the time of the check:** none had been emailed, bounced, suppressed or archived. All have sequence state `not_started`.

## ICP_CONFIRMED (141) as a Campaign 3 candidate run

### Dedupe (read-only, against all 4,986 production leads, the V4 master and suppressions)

No other lead from any client shares an email or company domain with any of the 141. None are in Industrial Campaign 3, the V4 master or a suppressed or replied sibling row, and the dashboard's `suppressed` flag (notes markers plus the Suppression list) is false for all. The only rows on these domains are the Campaign 2 records themselves.

### Stale-record check (free)

- **Apollo people search** by company domain (free, no reveal): **132 of 141 contacts are still listed at their company.** Seven of the 14 search batches hit the 300-person page cap, so a few contacts at larger agencies may simply not have been fetched.
- **Named on the company site:** 65 of 141.
- **Current Apollo title** was used for the buyer check: 6 now hold a non-buyer title and are held.
- **Email checks** (same rules as contact QC): every address was checked against the contact's name (person match), the company domain (with redirect or link proof where they differ), role mailboxes and the MX record.

### Re-verification (GetLeads; wallet cap $0.25)

| Item | Count |
|---|---|
| Addresses verified | 141 of 141. 20 by Claude, 121 by the owner directly in GetLeads after the provider stalled |
| Valid | 77 |
| Valid, catch-all | 40 |
| Ambiguous, catch-all | 4 |
| Ambiguous behind Proofpoint | 17 |
| Ambiguous | 1 |
| Invalid | 2 |

**Claude's verification jobs.** 18 jobs were submitted: 14 first attempts and 4 retries.

| Job outcome | Count |
|---|---|
| Completed | 4 |
| Failed at the provider ("could not be started", refunded) | 13 |
| Never submitted | 1 retry wave (the owner took over) |

The provider ran about 2 jobs at a time and failed anything still queued about 24 minutes after submission.

**Spend, from the wallet:** $10.9435 → $10.863, so **$0.0805** of the $0.25 cap ($0.02 for Claude's jobs and $0.0605 for the owner's run).

Mapping: valid → keep; catch-all → keep, flag, queue last; Proofpoint plus catch-all, invalid, ambiguous, or batch failed → hold.

### Evidence and copy

- **Crawl:** 162 sites crawled (CONFIRMED plus UNRESOLVED), with a headless retry for 24 thin sites. No crawl caches existed from earlier V4 runs.
- **Excerpts:** first-party excerpts were built in code (`icp_gate.build_evidence`), with no Jev call.
- **ICP decision:** taken as the Campaign 2 review's ICP_CONFIRMED. The V4 Jev gate was not re-run, because this task had no Jev budget.
- **Outputs:** `build_outputs` wrote to a **separate candidate file** (`recovery-candidates.csv`, git-ignored). The V4 master was not touched. Then `build_evidence` and the read-only Campaign 3 preview.
- **Copy:** 44 contacts pass QC; **39 get COPY_C**, and 5 are copy holds (no variant has verified evidence and complete variables).
- **Copy-ready split:**
  - verification: 26 verified, 13 catch-all (queue last);
  - source: 37 from Staffing Outreach Campaign 2, 7 from Industrial Staffing Agency V1 (counts are of the 44 QC passes);
  - mail gateways: 19 Microsoft, 15 Google, 4 other, 1 Barracuda.

### Holds among the 141 (97)

| Hold | Count | Notes |
|---|---|---|
| V4_FIT_DOUBT | 68 | Free code-only check under the V4 ICP. Campaign 2's "confirmed" was looser. See the breakdown below |
| SITE_UNREADABLE | 9 | No readable first-party site, so no V4 evidence |
| VERIFY_UNKNOWN | 7 | Ambiguous behind a Proofpoint gateway |
| NOT_BUYER | 6 | Current Apollo title is not tier 1–2 |
| MANUAL_HOLD | 3 | Contact association unclear. Kept held as instructed |
| PERSON_MISMATCH | 3 | Address does not match the named contact |
| VERIFY_INVALID | 1 | Mailbox gone |

**V4_FIT_DOUBT breakdown (68):**

| Reason | Count |
|---|---|
| No first-party industrial excerpt | 27 |
| Site dominated by excluded verticals (IT, healthcare, executive search, hospitality) | 26 |
| Off-ICP company name | 14 |
| Canadian domain | 1 |

The "dominated by excluded verticals" test is crude and may hold some multi-line agencies that do have a real industrial line. **To resolve all 68 properly, run the V4 Jev gate (`qualify.py` + `icp_decide.py`) on them: about $0.03 of Jev, waiting on the owner's approval.**

## Moving them into Campaign 3 without duplicate rows

**The normal Campaign 3 import cannot take these leads.** `POST /api/staffing/campaign-3/leads/import` refuses:
- an address that already exists in the lead database (`duplicate_email`);
- a company domain that already has a ScaleLab lead (`duplicate_company`).

Each recovered lead's own Campaign 2 row triggers both. Archiving the Campaign 2 rows first does not help: the import reads the whole corpus. Separately, the queue refuses any lead that still carries the `STAFFING_HOLD_V1` marker until a reviewed release removes it.

**What it takes (owner approval needed for code and deploy):**

1. **A convert-in-place endpoint.** For example `POST /api/staffing/campaign-3/leads/convert`: dry-run by default, `owner_approved_send_ready` required for send-ready. It reuses the import's own V4 evidence check (`selectV4Variant`) and profile builder, but writes to the **existing lead id**, so no new row is created.
   - **Preconditions per row** (any failure is a refusal):
     - ScaleLab client; stage `Import`;
     - never contacted: no `last_emailed_at` or `email_step`, and no send reservation;
     - no reply, unsubscribe or bounce marker; not on the Suppression list; no `[MANUAL HOLD]`;
     - carries exactly one V1 review tag (`ICP_CONFIRMED`) and one `STAFFING_HOLD_V1` block, with no V2 or V4 profile;
     - email and company domain not used by any other lead;
     - evidence selection is `SELECTED`.
   - **Write.** Done through `applyLeadChange`: compare-and-set on `revision`, then the Sheets mirror.
     - `campaign` becomes `Industrial Campaign 3`;
     - `intended_campaign_version` becomes `industrial_staffing_campaign_3`;
     - `campaign_notes` becomes the sealed V4 profile only (the V1 review tag and hold block are removed);
     - stage stays `Import`; sticky notes markers are untouched;
     - an audit note or CRM event records "converted from Campaign 2 / V1, hold released by owner review on <date>".
2. **Tests first.** One per refusal; a converted lead passes `/api/staffing/launch-readiness`; re-importing the same address afterwards is the safe `alreadyImported` no-op; `staffingHoldInconsistencies` stays empty; the lead row count is unchanged.
3. **Deploy.** Follow the outreach-safety skill: push the production branch, re-pin the Railway service with the full SHA outside send windows, then verify boot, crons, send lock and caps.
4. **Run.** Dry run on the 39 copy-ready recoveries, then a live convert. Queue with the normal queue endpoint: explicit inbox split, non-catch-alls first, the 13 catch-alls last.

## Conversion into Campaign 3 (owner-approved)

**Owner decisions:**
- approve all 21 ICP_UNRESOLVED as ICP fits, but exclude 8 of them: 5 contact problems and 3 Canadian companies;
- build the convert-in-place step, then convert and queue every eligible recovery.

**Endpoint:** `POST /api/staffing/campaign-3/leads/convert` (production branch `fix/send-throughput-20261020`), with 9 new tests. Deployed by re-pinning Railway outside the send windows. Boot, crons, send lock, delivery gate and caps were verified unchanged afterwards.

**Owner-approved leads (13).** The two remaining verification jobs (10 and 3 addresses) completed: 12 valid and 1 ambiguous catch-all. 8 of the 13 are catch-alls. All 13 pass contact QC and 11 get COPY_C. The other 2 are copy holds: no variant has verified evidence and complete variables.

| Conversion pass | Leads | Non-catch-all | Catch-all | `[MANUAL HOLD]` released |
|---|---|---|---|---|
| 1. ICP_CONFIRMED copy-ready | 40 | 27 | 13 | 0 |
| 2. Owner-approved (first verification job) | 8 | 2 | 6 | 2 |
| 3. Owner-approved (second verification job) | 3 | 2 | 1 | 1 |
| **Total** | **51** | **31** | **20** | **3** |

- **Source campaigns:** 33 from Staffing Outreach Campaign 2 and 18 from Industrial Staffing Agency V1. All are COPY_C.
- **Released holds:** each of the 3 `[MANUAL HOLD]` markers recorded the ICP question the owner settled ("industrial staffing fit not yet established" or `ICP_UNRESOLVED`). Only the marker was removed; the rest of each note is intact. The 3 contact-association holds among the CONFIRMED leads stay held.

**How each pass ran:**
1. Snapshot the rows first.
2. Dry run, then live.
3. Repeat the call: it returned `alreadyConverted` with 0 written.
4. Supabase post-check: on every row only `campaign`, `campaign_notes`, the template, the intended version and `revision` (+1) changed, plus `notes` on the 3 released rows. Stage stayed `Import`, with no sender, step or send, and identity unchanged. All 51 writes were mirrored to Sheets.

**Queue.** Explicit per-inbox split, non-catch-alls first in every pass. Final Campaign 3 queue: primary 52, deniels 47, zoe 26, merrick 26, dave 26.
- That is about 7 over one weekday's limits, so the last few roll to the following day.
- Converted rows keep their old lead ids, which sort ahead of newly imported ones. As a result, they cannot be forced to the end of the queue.

**Post-checks:**
- `launch-readiness` shows `wouldSendIfSendingEnabled: true` for all 51;
- staffing queued 127 → 178, eligible 126 → 177;
- leads blocked by manual hold 90 → 87;
- the sender-balance plan has 0 moves and no hard shortages.

**Verification spend for this run:** wallet $10.9435 → $10.8565, so **$0.087** of the $0.25 cap.

**Found in passing (not changed):**
- 3 Jole BTX leads (client `jole`) have sat in Queued on the ScaleLab `deniels` inbox since 2026-11-16;
- 1 old Industrial Staffing Agency V1 lead has sat in Queued on `primary` since 2026-09-15. It is the 1 queued staffing lead that readiness counts as not eligible.

## What waits on the owner

1. Decide what to do with the 3 Jole BTX leads queued on a ScaleLab inbox, and the 1 stale V1 lead queued on `primary`.
2. Optional: approve the V4 Jev gate (about $0.03) for the 68 V4_FIT_DOUBT leads.
3. Decide on archiving the 25 REJECTs.
4. The 7 recovered copy holds need more evidence before they can get a variant.
