# Campaign 4 "HOLD Company Test": build notes and deploy handoff

Owner brief 2026-11-27. Built and tested only: **not deployed, nothing imported, queued or sent, no cap changed.**

## What it is

The HOLD reply-test cohort, run as its own campaign, fully separate from Industrial Campaign 3.

- **Identity:**
  - campaign name `HOLD Company Test`;
  - version id `hold_company_test_campaign_4`;
  - template `industrial-staffing-hold-company-test-4`.
- **Sealed profile:** its own schema, `hold_company_test_profile_v1` (`integrations/campaign-4-profile.js`), stored in
  `campaign_notes` with a SHA-256 digest. Campaign 3 code never reads it, and Campaign 4 code never reads a Campaign 3
  profile.
- **Copy:** Campaign 3 copy v2 exactly, plus one Campaign 4-only Email 1 (owner decisions 2026-11-27).
  - **Campaign 3 variants:** COPY_A / D / E / F / B / C, in Campaign 3's precedence, chosen at import, server side, by
    Campaign 3's selector (`selectV4Variant`, copy v2) from each record's evidence, and rendered by Campaign 3's
    renderer. The caller cannot name a variant.
  - **COPY_G** (`integrations/campaign-4-copy.js`): a non-claiming Email 1, used only when the selector finds no
    verified Campaign 3 variant:
    "Is bringing in more employer accounts a focus for {{company}} right now? / We help staffing agencies win qualified
    meetings with employers who need workers, and we only get paid for the meetings we book. / Worth seeing how we'd
    do this for you {{first_name}}?"
    It states nothing about the agency. Campaign 3's variants and selector never include it.
  - **Shared with Campaign 3:** Emails 2 and 3, the locked phrases, the "Deins" sign-off, the footer with
    `Ref: SA-48271`, no dashes, and Campaign 3's validator for every touch.
  - **Copy version:** `v2`, sealed on each lead.
- **Same as Campaign 3:** cadence (day 0 / +3 / +7, weekdays 07:00–11:30 PT), inboxes, global cap, launch gate, final
  gate, reservations and reply handling. Replies and tasks carry the lead's campaign label.

## Safety gates

`campaign4SendBlock` runs:

- at queue time (`outreach-queue.js`);
- in routing (`campaign-routing.js` `routedLeadReady`);
- at the final gate (`staffing-launch-gate.js` `staffingSendBlockReason`, which `guardProviderSend` calls).

A lead is refused unless all of these hold:

- every identifier names Campaign 4;
- the profile verifies, names Campaign 4 and holds this lead's own address;
- `contact_status = VALID`;
- `review_status = SEND_READY`, which only the import sets, and only with `owner_approved_send_ready: true`;
- `STAFFING_C4_LIVE` is true.

Write guard: `campaign_notes` is read-only for Campaign 4 leads, and no path can put a Campaign 4 profile onto an
existing lead.

## Dedupe guard

- **Campaign 4 import** (`POST /api/staffing/campaign-4/leads/import`, a dry run unless `dry_run: false`) refuses:
  - an address already in the database (`email_in_campaign_3`, `email_in_earlier_campaign`, `duplicate_email` or
    `cross_client_duplicate`);
  - a company domain that has any ScaleLab lead (`company_in_campaign_3`, `company_in_earlier_campaign` or
    `company_in_campaign_4`);
  - a franchise domain, a non-VALID contact, a suppressed address, or a duplicate inside the batch.
  - There is no second-buyer exception.
- **Campaign 3 import** already refused a company that has any ScaleLab lead. Its second-buyer path now also refuses
  `second_buyer_company_in_campaign_4`. Campaign 3 conversion refuses a domain that has another ScaleLab lead.
- **Generic paths:** the flat import and lead creation refuse Campaign 4 (`use_campaign_4_import`).

## Daily split of the unchanged cap

`integrations/campaign-4-share.js` controls the split (owner decision 2026-11-27). ScaleLab's daily allocation (170)
and every sender, window and per-run limit are unchanged.

- **Base split:** Campaign 4 = `CAMPAIGN_4_DAILY_SENDS` (default 70); Campaign 3 = the rest of the 170 (100).
  - "Campaign 3" here means every ScaleLab lead that is not Campaign 4, including any earlier ScaleLab lead still in
    sequence.
  - Managed clients (Jole) are outside the split and keep their own caps.
  - An invalid value pauses Campaign 4 and leaves Campaign 3 the whole 170 (fail closed).
- **Demand:** a campaign's demand today = sends so far + follow-ups due by the end of the Vancouver day + eligible queued
  Email 1s.
- **Rollover, Campaign 3 to Campaign 4:** when Campaign 3's demand is under its 100, the difference goes to Campaign 4.
  Once Campaign 3 is done, Campaign 4 gets all 170.
- **Rollover, Campaign 4 to Campaign 3:** unused Campaign 4 share goes to Campaign 3. So before any Campaign 4 lead
  exists, Campaign 3 keeps the 170 it has today.
- **Follow-ups first:** inside each campaign, a new Email 1 is sent only if it leaves room for every follow-up of that
  campaign still due today. Within each run, sender lanes already send follow-ups before new Email 1s.
- **How it runs:**
  - the plan is made once per run from the ledger;
  - each attempt takes a slot before any Gmail probe or reservation;
  - Email 1 candidates of the two campaigns are interleaved in proportion to each one's remaining Email 1 room.
- **Log line:** every run prints the split used, for example
  `[campaign-split] day=2026-12-01 scalelabCap=170 base c3=100 c4=70 (default) | sentToday c3=… c4=… | dueToday c3
  followUps=… email1=… c4 followUps=… email1=… | rollover toC4=… toC3=… | allowance c3=… c4=…`.

## Tests

- `test/campaign-4-hold-test.test.js`: 18 tests, including COPY_G's exact text and Campaign 3 byte-for-byte renders.
- Registry pins in 9 existing tests were widened to name exactly the one new campaign.
- Full suite: 3,742 tests, 3,731 pass, 4 fail. The 4 failures are the known date and timezone tests, and they fail
  identically on the base `efe13ab`.
- Campaign 3 renders are byte-identical on base and branch: 65 renders across every variant, copy version, step and
  out-of-office form, plus 3 V1 renders.

## Deploy handoff (for the deploy session)

1. Deploy follows runbooks §6:
   - re-read the live SHA and the production branch head;
   - stay out of the 07:00–11:30 PT send window, and confirm no pass is running;
   - fast-forward or rebase as needed, and re-run the suite.
2. No Railway variable is required. `CAMPAIGN_4_DAILY_SENDS` is optional: absent means 70 (Campaign 3 gets 100). Set
   it only if the owner picks another split.
3. **After the deploy, check:**
   - boot logs;
   - the `[campaign-split]` line (`scalelabCap=170 base c3=100 c4=70 (default)`; with no Campaign 4 leads yet,
     `allowance c3=170`);
   - that Campaign 3 sends continue;
   - the send lock;
   - the Gmail observers.
4. **Import:** a dry run first, with the payload `runs-private/hold-test-2026-11-27/campaign4_import_payload.json`
   (git-ignored, 334 records). Expect 334 accepted: COPY_G 323, COPY_C fallback 10, COPY_B 1. Expect 0 company
   refusals. 49 rows were removed before the build because the gate did not rate the company a staffing agency
   (`runs-private/hold-test-2026-11-27/campaign4_removed_rows.csv`). The 2026-11-27 read-only check found
   none of its 406 domains in the 5,496 production leads. The suppression list is checked by the endpoint.
5. **Import, queue and send need explicit owner approval.** The payload has `owner_approved_send_ready: false`, so an
   import as built is REVIEW_READY and cannot be queued.
