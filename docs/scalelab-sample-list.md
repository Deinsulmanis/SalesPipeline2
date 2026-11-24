# ScaleLab sample employer list (Industrial Campaign 3 replies)

When a prospect agency says yes to the Email 2 offer ("Want me to pull a short sample list of employers hiring in your market?"), the reply agent drafts the list in the same Gmail thread. The owner reviews and sends it. ScaleLab only.

## Flow

1. **Classify.** `scalelab-response-classification.js` returns `sample_list_request` only for a clear yes ("yes", "sure", "send it", "interested in the list", "what does that look like") when our own earlier turn in the thread offered the list. Mixed, conditional, pricing, meeting or negative replies fall through to the existing intents and reach the owner as before. The result is deterministic and high confidence, with no model call.
2. **Route.** `scalelab-reply-router.js` treats it like interest: cold hold, a Follow Up card or task, owner `human`, `autoSendAllowed: false`.
3. **Draft.** `scalelab-sample-list-flow.js` runs after the route reaches `complete` and only when `SCALELAB_SAMPLE_LIST_ENABLED=true`:
   - It picks up to 10 still-hiring employers in the agency's state, using the HQ or branch state from the lead record (`campaign_notes`: `hq_state`, `state`, `var_location`, `var_market`, `branch_states`; or `city`).
   - If fewer than 5 qualify there, it fills from neighbouring states and then the national 20.
   - It re-checks anyone whose check is more than 14 days old with GetLeads `search_jobs`, one call at a time with backoff. It drops anyone no longer hiring in that state.
   - If GetLeads fails, it uses the stored list only if every unchecked employer is within 21 days. Otherwise the request goes to review and the owner is pushed.
   - It creates a Gmail draft in the thread with the standard staffing compliance footer, logs it, adds a dashboard task ("Review sample list draft in Gmail") and pushes the owner.
4. **Log.** Events in `scalelab_sample_list_events` are `drafted` (claim, then ready with the draft id), `review`, `sent` (the owner's send is observed as `human_response_sent` in the thread), `autosend_refused`, and `outcome` (`call_booked`, `declined`, `no_reply` after 14 days, or `replied` after 30 days).
5. **Restock.** A weekly job runs Sundays 03:17 Pacific when `SCALELAB_SAMPLE_LIST_RESTOCK_ENABLED=true`, or by hand with `node scripts/scalelab-sample-employers-restock.js`. It re-checks hiring rows older than 7 days and tops each state up to 10 still-hiring employers from the Jole employer pool. It makes one GetLeads call at a time, at most 300 checks per run.

## Auto-send (built, OFF)

`SCALELAB_SAMPLE_LIST_AUTOSEND=true` enables it. Even then it acts only on a high-confidence request with a fresh list (no stored-data fallback), a known agency state, no negative signal, and at least 10 minutes after the draft. It hands the draft to `deliverHardenedWarmReply`, which applies the final fresh gate, the reservation and the thread checks. There is no separate send path.

**As built, it cannot fire for a routed lead:** the routing step's `[MANUAL HOLD]` makes the warm final gate refuse (`manual_hold`), and the refusal is logged as `autosend_refused`. Letting it send would need an owner decision on how the sample-list route holds the lead. Production code never deletes Gmail drafts, so an auto-send pushes the owner to discard the leftover draft.

## Data

- `sample_employers` holds company-level rows only (company, domain, city, state, industry, open roles, example roles, newest posting, `checked_at`, status, national rank). There are no contacts. It is never committed: the repo is public.
- Migration: `supabase/migrations/20261124120000_scalelab_sample_employers.sql`. RLS is on and only `service_role` has access.
- Load: `node scripts/load-sample-employers.js runs-private/<run>/sample_employers_load.json` is a dry run. Add `--apply` to upsert.

## Environment

| Variable | Purpose |
|---|---|
| `SCALELAB_SAMPLE_LIST_ENABLED` | `true` turns on drafting (needs `SCALELAB_REPLY_ROUTING_MODE=apply`) |
| `SCALELAB_SAMPLE_LIST_AUTOSEND` | `true` turns on auto-send (default off) |
| `SCALELAB_SAMPLE_LIST_RESTOCK_ENABLED` | `true` turns on the weekly restock |
| `GETLEADS_API_KEY` | GetLeads key for `search_jobs` (MCP endpoint `https://app.getleads.io/api/mcp`; override with `GETLEADS_MCP_URL`) |
| `OWNER_PUSH_URL`, `OWNER_PUSH_TOKEN` | Optional ntfy-style push. Unset means the dashboard task only |
