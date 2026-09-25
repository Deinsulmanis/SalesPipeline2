# Staffing landing-link attribution

Internal operator notes. First-party attribution for the staffing landing page
(https://scalelabai.ca/staffing/): which outbound lead received a link, why it
was sent, whether the page loaded, how the visit behaved, and whether the lead
later booked. Lead-level data stays in our Supabase project. GA4 remains
aggregate-only and never receives the token, a lead id, a company, a message id
or an issuance id.

**Status:** every feature is off, the Supabase migration has not been applied,
the collector is not enabled and no tracked email has been sent.

## How it fits together

```
Lead (ColdEmail id)
  │  Follow-up #2 due  /  automated positive reply (send-info or qualified)
  ▼
Send action id (already deterministic)
  gmail-cold:<lead>:step:2        reply-action:<sha256>
  │  token = base64url(HMAC-SHA256(key[v], context + "<action id>|staffing_landing"))[:16 bytes]
  ▼
Plan pinned by the action's first attempt (tracked? key version?)
  ▼
Issuance row (best-effort, before the reservation)  ──►  landing_link_issuances
  ▼
Existing send lifecycle, unchanged: reservation → final gates → send lock → Gmail
  ▼
Page loads with ?t=  →  token read and removed before GA4  →  same-origin beacon
  /staffing/api/lp  ──Netlify signed forward──►  POST /api/landing/e (this server)
  ▼
landing_ingest  →  landing_sessions / landing_events  →  tiers
  ▼
Google Calendar sync → call_booked (exact attendee email) → landing_booking_attribution
```

## Flags and settings

All flags are off unless the value is exactly `true`.

| Variable | Default | Purpose |
|---|---|---|
| `LANDING_LINK_TRACKING_ENABLED` | off | New Follow-up #2 and automated positive-reply links carry `?t=<token>`. Needs a valid key ring, otherwise it reports disabled with a reason. |
| `LANDING_LINK_TOKEN_KEYS` | unset | JSON object `{"1":"<base64, ≥32 bytes>"}`. Versions are positive integers. |
| `LANDING_LINK_TOKEN_ACTIVE_VERSION` | unset | Version used for NEW issuances. Must exist in the key ring. |
| `LANDING_COLLECTOR_ENABLED` | off | The public collector accepts events. While off it answers 204 and does nothing. |
| `LANDING_PROXY_SIGNING_SECRET` | unset | Shared with Netlify's signed forwarding rule (`x-nf-sign`, HS256). Set the same value in Netlify for the production context. |
| `LANDING_PROXY_SITE_ID` | unset | Netlify site id the signature must carry: `010e32a7-2fed-4882-bcc9-62004863bc16` (celebrated-sable-7fe1fd / scalelabai.ca). |
| `LANDING_INTERNAL_MARK_SECRET` | unset | HMAC key for the dashboard's internal-browser codes. Without it the Settings card reports "not configured". |
| `LANDING_RECONCILER_ENABLED` | off | Backfill, session resolution and retention every 15 minutes. |
| `LANDING_TEST_EMAIL_DOMAINS` | `scalelabai.ca,tryscalelabai.ca` | Recipients on these domains are test issuances and are excluded from every view. |

The collector and reconciler reuse the existing `SUPABASE_URL` and
`SUPABASE_SECRET_KEY`. That key stays on Railway. It never reaches a browser or
Netlify.

Every constant (retention, timeouts, rate limits, windows) lives in
`integrations/landing-attribution-config.js`.

## Token keys

Generate a key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

**Rotation:** add the new version to `LANDING_LINK_TOKEN_KEYS`, then set
`LANDING_LINK_TOKEN_ACTIVE_VERSION` to it. Only new issuances use the new
version.

**Never remove a version while links issued under it may still be retried,
recovered or reconciled** (keep it for the 24-month issuance retention). The
first attempt at each action pins its key version in the reservation metadata.
If a pinned version is missing from the ring, that send is **blocked** with
`landing link blocked: pinned landing link key version N is not in the key ring`.
It is never re-derived with another key.

Turning `LANDING_LINK_TRACKING_ENABLED` off stops new tracked issuances only.
An action first attempted tracked keeps its tracked URL on retry, so leave the
keys in place.

## Send-path behaviour

Follow-up #2 (`deliverOrdinaryColdStep`), in order:

1. The plan is derived from the action id and the action's earlier attempts.
   A blocked plan refuses before any provider work.
2. The locked-copy re-render uses the same plan, so the existing body
   comparison also proves the URL.
3. Gmail-first recovery, unchanged. A recovered send marks the issuance sent;
   nothing is resent.
4. The unresolved-reservation check, unchanged.
5. The issuance is written best-effort, **before** the reservation. A slow or
   failed write never blocks the send. A stored row that contradicts the plan
   (different key version or token hash) refuses the send before any
   reservation is written, and logs `LANDING_LINK_ISSUANCE_CONFLICT`.
6. The reservation records the pin (`landingLink`: issuance key, key version,
   source, tracked). It never records the token.
7. Final gate, send lock and Gmail send, all unchanged (one provider call).
8. `follow_up_sent` records the pin. After `markSent` and the send-lock
   confirmation, the issuance is marked sent (best-effort).

Positive replies (`handlePositiveAutomation` → `deliverHardenedWarmReply`):

- Only `AUTO_STAFFING_SEND_INFO` and `AUTO_STAFFING_QUALIFIED` carry the
  landing page, and only on the automated-delivery path.
- **Every human draft keeps the plain URL.** That covers the human-touch hold,
  the Agent v2 hold and Agent v2 failures.
- With `AGENT_V2_EXECUTION_ENABLED=true` (current production), these replies
  are drafted, not auto-sent, so automated positive-reply issuances are rare.
  Agent v2 behaviour is unchanged.
- The issuance write is the last check in `finalRevalidate`, after every
  existing gate and before the reservation.
- The pin goes into `prospect_reply_reserved` and `booking_link_sent`.
- The sent marker runs after the send-lock confirmation, or in
  `persistDelivered` on the recovery path.
- The qualified reply also carries the direct booking link. That is why a
  booking without a page click is never labelled `page_assisted`.

Follow-up #2 and each reply are separate issuances for the same lead, with
source `followup_2` or `positive_reply`. `trigger_action` tells send-info from
qualified.

The email body stored in the Sheets activity `content` column contains the
tracked URL (as it always contained the plain one). `crm_events` does not
mirror `content`.

## Collector

Public `POST /api/landing/e`. The browser path is
`https://scalelabai.ca/staffing/api/lp` through Netlify's signed forwarding
rule, which must be configured in `netlify.toml`, not `_redirects`. It is
registered before the global JSON parser and dashboard auth, with its own
2 KB text parser.

- **Requirements:**
  - a valid `x-nf-sign`: HS256, issuer netlify, this site id,
    `deploy_context: production`, not expired, 30 s skew allowed;
  - origin `https://scalelabai.ca` or `https://www.scalelabai.ca`;
  - within the rate limits: 60/min per client (keyed on Netlify's
    `x-nf-client-connection-ip`), 20/s globally.
- **Schema:** v4 session and page-load ids; a 22-character token or none; an
  18-event allowlist with fixed properties; at most 20 events. Tokenless
  visits from non-internal browsers are not collected; they stay GA4-only.
- **Never stored or logged:** the raw token (hashed on arrival), IP, cookies
  (GA's `_ga` cookies arrive with every forwarded request), Referer, and the
  raw user agent. The user agent is reduced to coarse classes.
- **One `landing_ingest` call** with a 1 s timeout. The answer is always 204,
  except a verified internal-mark code, which gets 200 `{"marked":true}`.
- **Any other method** (GET, HEAD, OPTIONS, …) gets a bare 405 with
  `Allow: POST`, before dashboard authentication. Opening
  `scalelabai.ca/staffing/api/lp` in a browser never shows the dashboard's
  login prompt.
  Transient failures get one retry from a 200-item, 2-minute in-memory buffer;
  nothing depends on it.
- **Health:** `GET /api/landing/collector-health` (dashboard auth) returns
  counters and the reconciler's last run.

Netlify facts (verified 2026-09-25 with a throwaway deploy preview):
- POST, body, query string, Origin and User-Agent are forwarded.
- Cookies are forwarded both ways.
- `x-nf-client-connection-ip` carries the real client IP and overwrites any
  spoofed value.
- The signature lasts about five minutes.
- Forwarded requests time out after 26 s.

## Engagement tiers

These are behavioural confidence levels, **not proof that a visitor is
human**. Browser automation can generate trusted input.

| Tier | Rule |
|---|---|
| RAW | the page's script ran and reported with a token |
| VISIBLE | the document was visible |
| ENGAGED | VISIBLE and any of: ≥10 s visible, trusted input, trusted scroll input, video playing, trusted booking click, booking dialog opened |
| INTERACTED | trusted pointer, touch, key or wheel input, or trusted scroll input. 10 s alone never counts, and a scripted or instant scroll is never input. |
| INTENT | video playing, trusted booking click, or booking dialog opened |

The page decides when to report `engaged_10s` and `scroll_input`: at least 3
real inputs covering 300 px or more. The database derives the tiers, so the
rules can change and be recomputed from stored events.

## Internal browsers and debug mode

This server's side (code minting, the Settings card, one-time verification in
the collector) is in place. The page's side (reading and removing the `#`
fragment, the localStorage flag, suppressing GA, debug mode) ships with the
landing-page tracking change.

Settings → "Mark this browser internal" calls `GET /api/landing/internal-mark`
(dashboard auth). That returns a five-minute code bound to the
`landing_internal_mark` purpose, and opens
`https://scalelabai.ca/staffing/#sl-mark=<code>`.

- The page removes the fragment before GA starts and posts the code to the
  collector, which accepts it once.
- The page then sets its own localStorage flag.
- "Clear internal mark" opens `#sl-mark=off`.
- An internal browser loads no GA and its sessions are stored `is_internal`.
  Every view excludes them, including when you open a prospect's link from
  Gmail Sent.
- Debug mode is available only in a marked browser: GA runs with
  `debug_mode`, and sessions are stored `is_debug`, excluded and kept 30 days.

**Limits:**
- Each browser and device must be marked separately; an unmarked phone
  counts as the prospect.
- Safari may clear the flag after 7 days without a visit.
- Single use is enforced in memory, on one replica.

## Reconciler and retention

Runs every 15 minutes (minutes 4/19/34/49) when enabled. It uses the Supabase
landing functions only, never Sheets or Gmail.

- **Backfill.** Rebuilds any pinned reservation or send whose issuance is
  missing or unsent. It re-derives the token hash from the pin and marks sends
  sent with their Gmail ids. A contradicting row is reported, never marked.
- **Resolution.** Links sessions that arrived before their issuance.
- **Retention**, once a day:

| Data | Kept for |
|---|---|
| Events and sessions | 13 months |
| Issuances | 24 months |
| Sessions whose token never matched | 7 days |
| Internal and debug sessions | 30 days |

**Deletion request for a lead**, from the SQL editor:
`select public.landing_forget_lead('{"lead_id":"<ColdEmail id>"}'::jsonb);`
This removes the lead's issuances, sessions and events. The email bodies in
Sheets follow the CRM's own deletion process.

**Revoke a link:**
`update public.landing_link_issuances set status = 'revoked', revoked_at = now() where issuance_key = '<key>';`
The page still loads for that link; its events are ignored.

## Supabase migration

File: `supabase/migrations/20260925000000_landing_link_attribution.sql`. It is
idempotent and needs no extension.

1. Review it, then apply it once in the SQL editor of the outreach project.
2. Verify through PostgREST with the server key, e.g.
   `POST /rest/v1/rpc/landing_resolve_pending_sessions` with body `{"p":{}}`
   returns `0`.
3. Verify with the publishable key that every function and view is refused.

Before applying it, `scripts/landing-attribution-migration-check.mjs` runs
the migration twice in an in-memory PostgreSQL and exercises every function,
view, tier rule, retention rule and grant:

```sh
npm install --prefix <dir> @electric-sql/pglite
PGLITE_DIR=<dir> node scripts/landing-attribution-migration-check.mjs
```

**Views** (service_role only):

- `landing_session_facts`
- `landing_link_funnel`: one row per issued link.
- `landing_booking_attribution`, with these labels:
  - `page_assisted`: a trusted booking click or dialog open within 120 minutes
    before the booking;
  - `visited_before_booking`: an ENGAGED session within 30 days;
  - `link_sent_no_visit`;
  - `no_link_issued`.

  These describe assistance, not causation. `booked_at` is the calendar
  event's update time as recorded by the sync.
- `landing_funnel_daily`: by sent date, source, campaign, sender and template
  version.

## Out of scope, for now

- **Manual dashboard replies.** A link typed by hand is plain and untracked.
- **The Staffing Conversation Agent**, while it is shadow and non-sending.

Before either sends a landing link, it must use the same helpers as the
automated paths:
- `staffingColdStepLandingPlan` / `staffingWarmReplyLandingPlan` for the plan;
- `landingLinkMetadata` for the reservation and send pins;
- `ensureLandingIssuance` before its reservation;
- `recordLandingLinkSent` after its send-lock confirmation.

Never render a token without pinning it on the action's reservation first.

## Staffing landing page: internal notes

Moved here from the page's README, which is now public
(`scalelabwebsite/staffing-src/`).

- **Commercial language.** The page states only the locked pricing logic:
  "We get paid based on the meetings we generate." and "If we don't generate
  qualified employer meetings, there are no meeting fees." No guarantee
  framing, and no setup, infrastructure, platform, retainer or other fees.
  Offer facts come from `industrial_staffing` in
  `integrations/offer-config.js` and the locked staffing emails. No
  testimonials, client logos, results or statistics. Illustrations are
  labelled illustrative. The video's text version matches V5's on-screen text.
- **Booking.** The page uses the same Google Calendar appointment schedule
  this server sends as `BOOKING_URL` (Deins Ulmanis, "Discovery Call",
  30 minutes, Pacific).
- **Video provenance.** `staffing-explainer-v5.mp4` is
  `ScaleLab AI/Video5-Caption-Fix/ScaleLab-V5-Caption-Fix.mp4`, unchanged.
  - V5 corrects the guarantee-scene captions (0:27.0–0:35.9)
    (`Video5-Caption-Fix/guarantee-redesign.mjs`, lines 17 and 60).
  - To change the video, publish it under a new filename, update the
    `<source>`, rebuild and run the check.
- **GA4 admin (still open).**
  - Register `funnel`, `cta`, `cta_location` and `method` as event-scoped
    custom dimensions.
  - Mark `staffing_booking_started` as a key event.
  - Before debug mode ships, activate the Developer traffic data filter.
- **Separate fixes (still open).**
  - Warm replies say "Grab a quick 15 min here", but the calendar is a
    30-minute Discovery Call: `booking.js` and `integrations/offer-config.js`
    (`warmResponse`).
  - The privacy policy does not yet mention Google Calendar appointment
    scheduling or link-level email tracking.
  - The contractual definition of a qualified employer meeting is still to be
    written.
