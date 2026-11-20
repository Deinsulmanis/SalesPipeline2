# Industrial Campaign 3: email workflow

**Status:** live in production since 2026-11-20 (commit `bf9ed96`). The first wave of 32 leads was queued for the first send window on Friday 2026-11-20.

This document covers what happens to a lead after sourcing: how its email variant is chosen, how it enters the CRM, how it is routed and sent, and how to pause or extend the campaign. For sourcing (finding and qualifying leads), see [`V4_SEND_READY_PIPELINE.md`](V4_SEND_READY_PIPELINE.md).

## 1. The campaign

| Setting | Value |
|---|---|
| Name | Industrial Campaign 3 |
| Campaign id | `industrial_staffing_campaign_3` |
| Template id | `industrial-staffing-campaign-3` |
| Owner | ScaleLab (never Jole BTX) |
| Touches | 3. Email 1 is one of six variants; Emails 2 and 3 are shared |
| Signature | Deins |
| Footer | The existing ScaleLab compliance footer: address, website, unsubscribe line, `Ref: SA-48271` |
| Internal code name | "staffing V4" (`STAFFING_CAMPAIGN_V4`, `staffing-v4-*.js`) |

It is one campaign. The six Email 1 variants are copy choices inside it, not separate campaigns.

## 2. End-to-end flow

```
Sourcing run (V4_SEND_READY_PIPELINE.md)
  └─ V4_APPROVED_CONTACTS_MASTER.csv              one row per buyer, with the V4 tag
       └─ build_evidence.py                       attaches stored ad/site evidence per lead
            └─ v4-copy-evidence.json              (git-ignored: contains PII)
                 ├─ staffing-v4-preview.js        read-only preview of all 3 emails per lead
                 └─ POST /api/staffing/campaign-3/leads/import
                      ├─ server selects the variant (section 3)
                      ├─ dedupe + global Suppression list check
                      └─ writes Import-stage leads with a sealed profile
                           └─ POST /api/coldemail/queue          one call per mailbox
                                └─ stage = Queued, sender assigned
                                     └─ send cron (weekdays 07:00–11:30 Pacific)
                                          Email 1 → Email 2 (day 3) → Email 3 (day 7)
```

## 3. How the Email 1 variant is chosen

The server selects the variant at import time (`selectV4Variant` in `integrations/staffing-v4-copy.js`). The caller cannot choose it. The demand score and signal priority are **not** inputs. The V4 tag (`V4|PASS|<priority>|<ad_class>|COPY_TIER_PENDING`) is stored unchanged, and its `COPY_TIER_PENDING` segment is never rewritten.

Precedence: the first variant with verified evidence and complete variables wins.

| Order | Variant | Evidence required (every item needs a source URL) | Variables |
|---|---|---|---|
| 1 | **COPY_A** | An ad attributed to the company (attribution p ≥ 0.7) that targets employers (employer-facing p ≥ 0.7), seen within the last 30 days. An ad class of MIXED alone is not enough; stale or undated ads never count. | first_name, company |
| 2 | **COPY_D** | An open sales or business-development job for the agency's **own** team, observed within 30 days | sales_position |
| 3 | **COPY_E** | A market or branch expansion announced within 180 days, with the market named in the quote | market |
| 4 | **COPY_F** | The **recipient** was appointed to a senior commercial title within 180 days and still holds it | verified_title |
| 5 | **COPY_B** | A current job ad (seen within 30 days) whose text contains both the role and the location | verified_role, location |
| 6 | **COPY_C** | No qualifying signal, but a specialty phrase backed by a quote from the company's own site | verified_specialization |
| — | **HOLD** | None of the above. Nothing renders and the lead is never imported. | — |

Every variant also requires a valid `first_name` and `company`, because Emails 2 and 3 use them.

**Fallback:** if a variant's evidence exists but a variable fails validation, selection moves to the next variant. Nothing is invented and no paid AI call is made.

**Variable validation** (`variableProblem`) refuses values that are blank, `undefined`/`null`/placeholder text, contain braces, line breaks, en or em dashes, or a free-standing hyphen, are over the length limit, or (for first names) are a single initial. Hyphens inside proper names (RJ-Staffing, Jean-Paul) are allowed.

**Lead-level holds:** a contact whose QC status is not `READY_FOR_REVIEW` (for example AMMON's `NEEDS_EVIDENCE`), or whose email is unresolved, is held even when its evidence supports a variant.

**Signals not yet researched:** sourcing has never searched for internal sales hiring, expansion or new commercial leaders. Until a run collects that evidence, COPY_D, COPY_E and COPY_F cannot be selected.

### Specialty phrase rules (COPY_C)

`build_evidence.py` derives the phrase from first-party excerpts captured during the ICP check:

- Trades terms (skilled trades, welders, electricians, millwrights, pipefitters, HVAC, machinists, skilled craftsmen and similar) **and** light-industrial terms (light industrial, warehouse, manufacturing, assembly, forklift) → "skilled trades and light industrial"
- Trades terms only → "skilled trades"
- Light-industrial terms only → "light industrial"
- Only the word "industrial" → "industrial"
- None → HOLD

The supporting excerpt and URL are stored with the lead and shown in the preview.

## 4. Where the variant is stored

Each lead's `campaign_notes` column holds a sealed JSON profile (schema `staffing_v4_lead_profile_v1`, `integrations/staffing-v4-profile.js`). It contains:

- the original `v4_tag`, `demand_score`, `signal_priority` and `ad_class`;
- `copy_variant` and `copy_status` (SELECTED or HOLD);
- the variables used (`var_first_name`, `var_company`, and so on);
- the evidence URL, quote and observed date, plus why each higher variant was passed over;
- `contact_status`, `review_status` (REVIEW_READY, SEND_READY or HOLD), the selector version and the selection time.

The profile carries a SHA-256 digest. Every read verifies it, and a tampered profile renders nothing. No write path except the import can change `campaign_notes` on a Campaign 3 lead, so the variant cannot change once a sequence has started. To change a lead's variant, re-import it as a reviewed new record; never edit the notes.

## 5. The emails

The copy is locked in `integrations/staffing-v4-copy.js` (`EMAIL_1`, `FOLLOW_UPS`), verbatim from the owner-approved copy of 2026-11-20.

| Touch | When | Subject | Bolded sentence (HTML only) |
|---|---|---|---|
| Email 1 | Day 0 | The variant's subject: "Employer accounts for {company}", "More employer accounts for {company}", "Growing your employer accounts", "Employer accounts in {market}" or "Employer growth at {company}" | "We only get paid when we generate qualified employer meetings for you. No qualified meetings, no fees." |
| Email 2 | Day 3 | "Re: \<Email 1 subject\>", same Gmail thread | "It's entirely performance based. We only get paid for the qualified employer meetings we generate." |
| Email 3 | Day 7, and at least 3 days after Email 2 | "Re: \<Email 1 subject\>", same Gmail thread | "We only get paid when we generate qualified employer meetings, so there's no meeting fee if we don't deliver results." |

Notes on the emails:

- The approved standalone subjects for Emails 2 and 3 ("Employer acquisition", "Employer accounts") are kept for reference only. A follow-up must keep the thread subject, or Gmail would split the thread.
- Plain text carries identical wording with no asterisks. Only the approved sentence is bold.
- The copy contains no en or em dashes; tests enforce this.
- After an out-of-office reply, the first follow-up adds the shared line "Circling back now that you're back in the office." after the greeting.

## 6. Schedule and sending

Campaign 3 uses the shared schedule and gates. Nothing about timing is specific to it:

- **Send windows:** weekdays, every :00 and :30 from 07:00 to 11:30 Pacific. A follow-up that falls due outside a window waits for the next one, and the system never catches up by breaking the spacing.
- **Spacing:** Email 2 is due 3 Vancouver calendar days after Email 1. Email 3 is due 7 days after Email 1 and never sooner than 3 days after Email 2 (`integrations/sequence-timing.js`).
- **Caps:** ScaleLab's existing limits apply: 170/day and 27 per run, plus per-inbox daily and per-run limits. Campaign 3 changed none of them.
- **Fairness:** each inbox sends roughly 4 follow-ups for every 1 new Email 1. On inboxes busy with Campaign 2 follow-ups, Campaign 3's first emails can therefore take more than one day.

**Gates that stop a send** (the final check runs immediately before every provider call):

- send authorization and the staffing launch gate (`STAFFING_LAUNCH_ACTIVATED_AT`);
- the Campaign 3 block (`staffingV4SendBlock`): the profile must verify, have `copy_status` SELECTED, `contact_status` READY_FOR_REVIEW and `review_status` SEND_READY, and `STAFFING_V4_LIVE` must be true;
- suppression: an unsubscribe or not-interested reply, a bounce, a manual hold, or the global Suppression list;
- a reply or meeting moves the lead to human ownership, and no further cold touch is sent;
- durable send reservations (no duplicate touches, no resend when delivery is uncertain), mailbox health, and the recipient-provider policy (currently `off`, so any mailbox is admitted).

## 7. Adding the next wave of leads

1. **Source** with [`V4_SEND_READY_PIPELINE.md`](V4_SEND_READY_PIPELINE.md). Add the new rows to `runs/V4_APPROVED_CONTACTS_MASTER.csv` with their V4 tags.
2. **Build the evidence file** from every run folder whose leads are in the master (toolkit: [`tools/README.md`](tools/README.md)):
   ```bash
   python3 -I docs/scalelab-sourcing/tools/build_evidence.py docs/scalelab-sourcing/runs/V4_APPROVED_CONTACTS_MASTER.csv <evidence.json> <run-dir> [<run-dir> ...]
   ```
   For a COPY_B lead, add its ad to `CANDIDATE_ADS` in that script: the domain, a phrase that matches the ad text, the role, and "City, ST". The selector re-checks that the role and location appear in the ad's own text.
3. **Preview** every lead's three emails, read only:
   ```bash
   node scripts/staffing-v4-preview.js <evidence.json> <out-dir>
   ```
   Open `<out-dir>/v4-preview.html` and check the variants, evidence and holds. Admission is shown under the same `RECIPIENT_PROVIDER_POLICY` the server applies (default `off`). Every preview lead shows "REVIEW READY, not SEND READY", because the preview never marks a lead send ready; only the import does, with the owner's approval.
4. **Dry-run the import.** The dashboard uses Basic auth. Body:
   `{"schema":"industrial_campaign_3_import_v1","sourcing_run_id":"<run id>","owner_approved_send_ready":true,"records":[{row, evidence}, ...]}`.
   With no `dry_run` field, the call writes nothing and reports accepted, refused (by code) and the variant counts.
5. **Import for real** with the same body plus `"dry_run": false`. Repeating the call is a safe no-op: it reports `alreadyImported`. Leads land in stage `Import`, unrouted.
6. **Queue** with `POST /api/coldemail/queue`, one call per mailbox:
   `{"ids":[...],"senderInboxId":"<inbox id>","emailTemplateId":"industrial-staffing-campaign-3","campaignVersionId":"industrial_staffing_campaign_3"}`.
   The whole selection is validated before anything is written. Read `/api/ops/cold-delivery-gate` **fresh** and use only inboxes in the cold pool with no `coldHold`. On 2026-11-20 those were `primary`, `deniels`, `outreachplateau_zoe`, `outreachplateau_merrick` and `outreachplateau_dave`. `"auto"` also skips held and out-of-pool inboxes now (`coldAssignableSenders`), but explicit routing stays the safest path.
7. **Verify** read only:
   - `/api/staffing/launch-readiness` should show `wouldSendIfSendingEnabled: true` for each new lead.
   - `/api/ops/sender-balance?client=scalelab` should plan no unexpected moves.

**Import refusal codes:**

| Code | Meaning |
|---|---|
| `held` | No verified variant, or contact QC not ready |
| `suppressed` | Address is on the global Suppression list |
| `duplicate_email` | Address already exists for any client |
| `duplicate_company` | A ScaleLab lead already exists for this company domain (V1, Campaign 2 or anything else) |
| `duplicate_in_batch` | Email or domain repeats inside the request |
| `personal_mailbox` | A free mailbox is not a company buyer |
| `invalid_email` | Missing or malformed address |

## 8. Pausing or stopping

- **One lead:** add `[MANUAL HOLD]` to its notes from the dashboard. Every gate refuses it until the hold is released.
- **The whole campaign:** set `STAFFING_V4_LIVE = false` in `integrations/staffing-campaign.js`, run the tests, and deploy (section 9). Every Campaign 3 lead is then refused at queue, routing and the final gate. Campaign 2 and Jole are unaffected.
- **All staffing sends:** clearing `STAFFING_LAUNCH_ACTIVATED_AT` on Railway pauses every staffing campaign, Campaign 2 included.

## 9. Deploying a change

Production runs from Railway's `SalesPipeline2` service on branch `fix/send-throughput-20261020`.

- The service is **pinned to a commit**, so a push alone does not deploy. After a fast-forward push, re-pin the service source to the new commit on the same branch (Railway "connect service source" with the commit SHA). That starts the build.
- Follow `.claude/skills/salespipeline2-outreach-safety/references/runbooks.md` §6: re-read the live commit, stay outside send windows, confirm `/api/agent/status` is not running, and check boot logs, crons, send-lock and caps afterwards.
- Expected test baseline: 3 pre-existing failures (2 Vancouver timezone fixtures, 1 sender-refill window test). Anything more is new.

## 10. Known issues

- **Automatic mailbox routing (fixed 2026-11-20).** `senderInboxId: "auto"` had chosen `scalelabaiteam`, which is on the cold hold list; the queue refused and wrote nothing. Automatic assignment and the 06:40 refill now take their senders from `coldAssignableSenders` (cold pool, no hold). Still check `/api/ops/cold-delivery-gate` before queueing.
- **Microsoft deliverability.** Microsoft earlier junked ScaleLab senders, and 20 of the first 33 sourced buyers use Microsoft mailboxes. Watch opens and replies by provider.
- **AMMON Staffing** is not imported. Its legal name may collide with a V1 lead (Capital City Staffing). Resolve that, change its `contact_status` to READY_FOR_REVIEW, and import it on its own.
- **COPY_D, COPY_E and COPY_F are unused** until sourcing researches those signals.

## 11. File map

| File | Role |
|---|---|
| `integrations/staffing-v4-copy.js` | Locked copy, variant selector, variable validation, rendering |
| `integrations/staffing-v4-profile.js` | Sealed profile: build, serialize, verify |
| `integrations/staffing-campaign-3-import.js` | Import: selection, dedupe, suppression, write |
| `integrations/staffing-campaign.js` | Campaign identity, `STAFFING_V4_LIVE`, send block, renderer hookup, read-only notes |
| `integrations/campaign-versions.js` | Registry entry and per-variant send attribution (`industrial_staffing_v4_e1_copy_a`, ...) |
| `integrations/campaign-routing.js`, `integrations/outreach-queue.js`, `integrations/staffing-launch-gate.js` | Template registration, queue and final-gate checks |
| `server.js` | `POST /api/staffing/campaign-3/leads/import`; flat imports refuse Campaign 3 leads |
| `scripts/staffing-v4-preview.js` | Read-only preview generator |
| `docs/scalelab-sourcing/tools/` | Reusable, env-configured sourcing toolkit, including the evidence builder ([README](tools/README.md)) |
| `docs/scalelab-sourcing/runs/v4-copy-2026-11-20/` | Variant-count README and the historical evidence builder (evidence and preview files are git-ignored) |
| `test/staffing-v4-campaign.test.js` | 28 tests: copy, precedence, holds, scheduling, gates, import |
