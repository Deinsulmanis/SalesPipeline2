# Deploy handoff: franchise locations (owner-approved push, deploy by the deploy session)

- **Branch:** `claude/franchise-icp-20261125`
- **Commit to deploy:** `39697c3d676acf5336c5b928b8aafba435f8a2ca`
- **Base:** production head `39b9b53` ("correct a reply's type from the Analytics reply list") at push time. The branch
  is a fast-forward of that head: 2 commits, no overlapping files.
- **Production branch:** `fix/send-throughput-20261020`. Deploy by fast-forward push, then Railway
  `connect-service-source` with the commit SHA (outreach-safety runbooks §6).

## What it changes

1. **Import** (`integrations/staffing-campaign-3-import.js`, new `integrations/staffing-franchise.js`):
   - A shared franchise domain (expresspros.com, pridestaff.com, spherion.com, ...) is never deduped as one company.
   - It requires `owner_approved_franchise: true` and `row.franchise {brand, owner_key, territory, city}`.
   - The same owner or the same office (already in ScaleLab, or repeated in the batch) is refused.
   - Non-franchise imports are unchanged.
2. **Profile** (`staffing-v4-profile.js`): optional franchise fields, present and digested only on franchise profiles.
   Every existing profile keeps its exact fields and digest.
3. **Copy v2** (`staffing-v4-copy.js`), franchise only:
   - Subject: "Employer accounts for your {{franchise_city}} office".
   - Closing: "Worth a look for your {{franchise_city}} office?".
   - COPY_C city line: "Saw your {{franchise_city}} office places ...".
   - The brand is never merged as {{company}}. A franchise lead gets only COPY_B or the COPY_C city line.
4. **Send path** (`outreach-agent.js`):
   - At most 10 sends per shared franchise domain per Vancouver day, across all inboxes and steps.
   - The slot is taken inside `deliverOrdinaryColdStep`, after the client checks and before any Gmail probe or
     reservation. It fails closed if the throttle is missing.
   - Step-1 franchise leads are interleaved in the sender assignment.
   - Send caps, windows and the final gate are untouched.

## Tests

- `test/staffing-franchise.test.js` (12, pass).
- Full suite on the rebased branch: 3,676 pass, 4 fail. The 4 are the pre-existing DST/date-sensitive tests: DST
  round-trip, Vancouver calendar days, live refill windows, and the 45-day hiring-evidence test. They fail on
  production without this change too.

## After deploy, please verify

- Boot, Supabase, observers, Calendar, send lock, caps, protected leads (the runbook checklist).
- A dry-run import of one franchise record returns `franchiseLeads: 1` with no refusal. The sourcing session runs this.
- **No franchise lead exists in production yet.** The 25-owner test wave is imported only after the deploy is
  confirmed live.
