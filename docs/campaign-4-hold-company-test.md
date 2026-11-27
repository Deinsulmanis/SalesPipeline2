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
- **Copy** (`integrations/campaign-4-copy.js`, version `c4_v1`, sealed on each lead):
  - **Email 1:** opens "If you place warehouse, production or skilled trades workers, ...". It never claims we verified
    the agency's specialisation.
  - **Emails 2 and 3:** Campaign 3 copy v2, word for word. Email 2 keeps the sample-list offer.
  - **Shared with Campaign 3:** the same locked phrases, no dashes, the "Deins" sign-off, and the compliance footer with
    `Ref: SA-48271`.
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

`integrations/campaign-4-share.js` controls the split. `DAILY_SEND_LIMIT` (170) is untouched.

- **Campaign 4:** at most `floor(170 × CAMPAIGN_4_DAILY_SHARE)` successful sends per Vancouver day, every step counted.
- **The share:**
  - default 0.35, which gives 59 per day;
  - allowed range 0 to 0.5;
  - an invalid value pauses Campaign 4 (fail closed).
- **Campaign 3 and everything else:** take the rest of the same 170, including any part of Campaign 4's share it does
  not use.
- **How it runs:**
  - the throttle takes a slot before any Gmail probe or reservation, like the franchise throttle;
  - new Email 1 candidates are interleaved at the share ratio.
- **Log line:** each run prints `[campaign-4-share] share=… budget=… usedToday=…`.

## Tests

- `test/campaign-4-hold-test.test.js`: 16 tests.
- Registry pins in 9 existing tests were widened to name exactly the one new campaign.
- Full suite: 3,740 tests, 3,729 pass, 4 fail. The 4 failures are the known date and timezone tests, and they fail
  identically on the base `efe13ab`.
- Campaign 3 renders are byte-identical on base and branch: 65 renders across every variant, copy version, step and
  out-of-office form, plus 3 V1 renders.

## Deploy handoff (for the deploy session)

1. Deploy follows runbooks §6:
   - re-read the live SHA and the production branch head;
   - stay out of the 07:00–11:30 PT send window, and confirm no pass is running;
   - fast-forward or rebase as needed, and re-run the suite.
2. No Railway variable is required. `CAMPAIGN_4_DAILY_SHARE` is optional: absent means 0.35. Set it only if the owner
   picks another share.
3. **After the deploy, check:**
   - boot logs;
   - the `[campaign-4-share]` line (share 0.35 (default), budget 59);
   - that Campaign 3 sends continue;
   - the send lock;
   - the Gmail observers.
4. **Import:** a dry run first, with the payload `runs-private/hold-test-2026-11-27/campaign4_import_payload.json`
   (git-ignored, 383 records). Expect about 383 accepted and 0 company refusals. The 2026-11-27 read-only check found
   none of its 406 domains in the 5,496 production leads. The suppression list is checked by the endpoint.
5. **Import, queue and send need explicit owner approval.** The payload has `owner_approved_send_ready: false`, so an
   import as built is REVIEW_READY and cannot be queued.
