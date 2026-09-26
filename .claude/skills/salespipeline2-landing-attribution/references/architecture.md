# Architecture reference

## 1. Link issuance (SalesPipeline2 send path)

**Where tracked links are issued:**
- `staffingColdStepLandingPlan`: staffing **Step 2** ("Follow-up #2") only. Steps 1 and 3 and non-staffing leads return `null`.
- `staffingWarmReplyLandingPlan`: the automated `AUTO_STAFFING_SEND_INFO` and `AUTO_STAFFING_QUALIFIED` replies.

**Where they are not:**
- Human drafts always keep `STAFFING_LANDING_PAGE_URL`, the plain URL.
- The Agent v2 cutover path (`AGENT_V2_EXECUTION_ENABLED=true`) passes no landing plan.

**Token (`integrations/landing-link-token.js`):**
- `issuance_key = "<send action id>|staffing_landing"`. Action ids come from `integrations/outbound-action-id.js`: the ordinary cold step id, or the response action id for replies.
- `token = base64url(HMAC-SHA256(key[v], "scalelab/landing-link/v1\0" + issuance_key))[:16 bytes]`. That gives 22 URL-safe characters and 128 bits.
- It is deterministic, so retries, re-render checks and Gmail recovery all produce the same URL, with no database read before the send.
- **Pinning:** the first attempt writes `{ tracked, issuanceKey, keyVersion, source }` into the reservation or send metadata (`metadata.landingLink`). Later renders read the pin first.
  - Disagreeing pins, a foreign issuance key, or a pinned key version missing from the ring all give `PLAN_STATUS.BLOCKED`, and the send defers.
  - A key is never swapped.
- **Key ring:** `LANDING_LINK_TOKEN_KEYS` is a JSON object `{"<version>": "<standard base64, ≥32 bytes>"}` and `LANDING_LINK_TOKEN_ACTIVE_VERSION` names the active version. An invalid ring means tracking is disabled, with the reason reported (it never half-works).
- **Rotation:** add a version, then switch the active version. Keep old versions for at least the reconcile lookback plus retry horizon, because pinned retries and backfill re-derive with the pinned version.

**Lifecycle (`integrations/landing-link-issuance.js`, used by `outreach-agent.js`):**
1. **plan:** pure, done before render.
2. **ensure:** `landing_issue_link` before the reservation.
   - It is best effort: a failed write never blocks the send.
   - A stored row that contradicts the plan refuses the send.
3. **provider send:** as usual.
4. **sent:** `landing_mark_link_sent` after provider success or Gmail recovery. Best effort.

The canonical send activity carries the pin, so the reconciler can rebuild anything that failed. `is_test` is derived from the recipient domain (`LANDING_TEST_EMAIL_DOMAINS`, default `scalelabai.ca,tryscalelabai.ca`).

## 2. Browser (scalelabwebsite `staffing-src/`)

**Head order in `index.html`:** `<meta charset>`, then `<meta name="referrer" content="strict-origin">`, then the inline boot script, which is the first executable code, then everything else.

**The boot script:**
- reads `t`, and accepts it only if it matches `/^[A-Za-z0-9_-]{22}$/`;
- always deletes `t` from the URL;
- handles `#sl-mark=<code|off>` and `#sl-debug=1|0`;
- calls `history.replaceState` to remove the token and fragments;
- only then decides whether GA loads.

GA loads only on production hosts, only when cleaning succeeded, and not on marking visits. Internal browsers get no GA unless debug mode is on. `page_location` is the cleaned `location.href`.

The token is handed to the module in a non-enumerable `window.__slLandingBoot`, which is deleted on read.

**Modules in `src/attribution/`:**
- **`session.js`:** `sessionStorage['sl.lp.session']` holds the session id and a v4 `sid`.
  - A reload continues the session. A new tab, a different token, or 30 minutes idle starts a new one.
  - Every page load gets a fresh `plid`. There is no fingerprinting and no cross-tab recovery.
- **`collector.js`:** batches for 1 s, flushes on hide or pagehide.
  - At most 20 events and about 1.9 KB per request.
  - `fetch` uses `keepalive`, `credentials:'omit'` and `referrerPolicy:'no-referrer'`.
  - No retries; it stops after 3 failures.
- **`visibility.js`:** "visible" means at least 50 % of the element in view for at least 1 s while the tab is visible.
- **`video-progress.js`:** watched time only counts advances of at most elapsed × rate + 0.75 s. Seeks, pauses and waits reset the reference point.
  - 25/50/75 milestones use watched time.
  - Complete means 95 % watched, or `ended` after at least 90 %.
- **`debug-panel.js`:** internal+debug only. It shows the session prefix and "token present/none", and never the token.
- **`index.js`:** `ENDPOINT = '/staffing/api/lp'`.
  - An anonymous visitor (no token, not internal) gets an inert API and sends nothing.
  - Input comes only from `isTrusted` pointer, key, wheel or touch events.
  - Scroll depth is recorded with `mode: input|jump`.
  - `booking.js` records click, dialog-open and embed-loaded separately; none of them means "booked".

**Internal marking:**
1. Dashboard Settings → "Mark this browser internal" calls `GET /api/landing/internal-mark`, which returns a signed, 5-minute, single-use code.
2. The browser opens `…/staffing/#sl-mark=<code>`.
3. The page POSTs `{v:1, kind:'mark', code}` to the collector.
4. It sets `localStorage['sl.internal']='1'` **only** on a 200 `{marked:true}`.
5. `#sl-mark=off` clears the mark (and `sl.debug`), and a `hashchange` handler catches links pasted into an open tab.

**`netlify.toml` rule:**
```toml
[[redirects]]
  from = "/staffing/api/lp"
  to = "https://receptionist.scalelabai.ca/api/landing/e"
  status = 200
  force = true
  signed = "LANDING_PROXY_SIGNING_SECRET"
```
`/staffing-src/*` is forced to 404. The source is never served.

## 3. Collector (SalesPipeline2)

`registerLandingCollectorRoute` registers public `POST /api/landing/e` **before** `express.json` and dashboard auth, with its own 2 KB text parser. Any other method gets a bare `405`, `Allow: POST`, and no `WWW-Authenticate`, so no login prompt ever reaches the public site.

**Order of checks** (all failures answer 204 and increment a counter):
1. `LANDING_COLLECTOR_ENABLED` (`disabled`).
2. `x-nf-sign`: `alg=HS256`; HMAC with `LANDING_PROXY_SIGNING_SECRET`; `iss=netlify`; `netlify_id === LANDING_PROXY_SITE_ID`; `deploy_context=production`; `exp` not older than 30 s skew (`unsigned`). Deploy previews are refused. `site_url` is not checked.
3. `Origin` must be `https://scalelabai.ca` or `https://www.scalelabai.ca` (`badOrigin`).
4. Rate limit: 60/min per `x-nf-client-connection-ip`, which is used transiently and never stored, and 20/s globally (`rateLimited`).
5. Schema, from `normalizeCollectorRequest` and `EVENT_PROPS` (`invalid`):
   - v4 `sid`/`plid`;
   - a 22-character token or null;
   - allowlisted event names and properties, at most 20 events.
6. Mark requests: a verified code answers 200 `{marked:true}` (single use, in memory). A refused code is `markRefused`, answered 204.
7. A tokenless, non-internal event batch is `notCollected`.
8. The user agent is classified into browser, major version, OS, device class, headless and declared-bot flags, then one `landing_ingest` call is made with a 1 s timeout.
   - Transient failures get one retry from a bounded buffer (200 items, 2 minutes).
   - Logs contain status codes only.

**Event allowlist:** `page_load`, `visible`, `engaged_10s`, `interaction`, `scroll_input`, `scroll_depth`, `video_visible`, `video_playing`, `video_25`, `video_50`, `video_75`, `video_complete`, `meeting_section_visible`, `booking_cta_click`, `booking_dialog_open`, `booking_embed_loaded`, `booking_new_tab`, `page_summary`. The page and the backend must match exactly; change both together.

`GET /api/landing/collector-health` (dashboard auth) reports the enabled/configured booleans, counters, the retry buffer, and the reconciler's `lastRun` and `lastRetentionAt`.

## 4. Reconciler (`integrations/landing-attribution-reconcile.js`)

It runs every 15 minutes when `LANDING_RECONCILER_ENABLED=true`. It touches only the landing RPCs (no Sheets, no Gmail, no sends).
1. **Backfill:** `landing_backfill_candidates` lists canonical reservations and sends (crm_events, 30-day lookback) whose tracked pin has no issuance, or whose issuance isn't marked sent. It re-derives the token hash from the pin and issues or marks it. The raw token is never read.
2. **Resolution:** `landing_resolve_pending_sessions` links sessions that arrived before their issuance.
3. **Retention:** at most daily, using `RETENTION_DAYS`:
   - events and sessions: 13 months;
   - issuances: 24 months;
   - unresolved sessions: 7 days;
   - internal and debug sessions: 30 days.

## 5. Tiers (computed in SQL by `landing_refresh_session`)

| Tier | Rule |
|---|---|
| RAW | the page reported with a token |
| VISIBLE | the document was visible |
| ENGAGED | VISIBLE and one of: ≥10 s visible, trusted input, trusted scroll input, video playing, trusted booking click, or booking dialog |
| INTERACTED | trusted pointer, touch, key or wheel input, or trusted scroll input (10 s visible alone never counts) |
| INTENT | video playing, trusted booking click, or booking dialog opened |

Milestones are unique per session (`landing_events_milestone_once`), and `(page_load_id, seq)` is unique. That makes replays idempotent.

## 6. Booking attribution (`landing_booking_attribution` view)

Bookings come from the Google Calendar sync: a `call_booked` crm_event, matched to a lead by exact normalized attendee email. Labels are evaluated in this order:
1. `page_assisted`: a trusted booking click or dialog open on the lead's link within **120 minutes** before booking.
2. `visited_before_booking`: an ENGAGED session on the lead's link within **30 days** before booking.
3. `link_sent_no_visit`: a link was sent before the booking, with no engaged visit.
4. `no_link_issued`: no tracked link was sent before the booking.

Test, internal and debug traffic never counts. The windows mirror `ATTRIBUTION_WINDOW`, and tests check that the SQL literals match.

**Calendar caveats:**
- A booking whose attendee matches **no** lead is only logged (`unmatched`), not stored.
- The booker is the single attendee who isn't the calendar's own account, the organizer or `FROM_EMAIL`.
- A booking by a **suppressed outreach-only** lead makes the automatic promotion refuse and the batch throw. That freezes Calendar sync and, through the pre-launch Calendar observation, every automated send run.
  - This is a known open bug.
  - The unblock is a human manual promotion of the lead (`POST /api/coldemail/:id/promote`), which the user must authorize.

## 7. Staffing Funnel dashboard

**Where:** the workspace is Growth → **Staffing Funnel** (`#staffing` in `public/index.html`). The API is `GET /api/landing/funnel` (dashboard auth, `no-store`, generic 503 on Supabase failure). It is registered after `requireAuth` in `server.js`.

**Query parameters:**
- `range=7d|30d|90d|custom`, with `from`/`to` as YYYY-MM-DD Vancouver days; the DST-safe midnight is handled in `vancouverMidnight`.
- `source`, `campaign`, `sender`, `template`.
- `includeTest=1`, `includeInternal=1`.

**How it counts:**
- The period is the links' **send date**; sessions and bookings follow their link.
- Tiers, flags and labels come from SQL, and `landing-dashboard.js` only counts.
- Each rate carries its grain (`links`, `sessions` or `leads`) and a zero denominator gives `null`.

**What it shows:** summary cards, conversion rates, a Follow-up #2 vs positive-reply breakdown, the booking labels, visit quality (highest tier per session plus neutral signals) and a lead table that opens the existing outreach drawer.

**What is excluded:** internal, debug and test traffic by default, and bookings by leads on test domains unless test links are included.

**Queries:** every one names its columns (`ISSUANCE_COLUMNS`, `SESSION_COLUMNS`, `BOOKING_COLUMNS`, `LEAD_COLUMNS`) and none include a token, hash, action id, IP address or user agent. Lead details are fetched only for the ids on screen.
