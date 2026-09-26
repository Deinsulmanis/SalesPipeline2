---
name: salespipeline2-landing-attribution
description: Use when working on the ScaleLab staffing landing page (scalelabai.ca/staffing), tracked staffing outreach links (?t= tokens), the Netlify-signed /staffing/api/lp → SalesPipeline2 collector, landing attribution in Supabase (landing_* tables, views, RPCs), the landing reconciler, booking assist labels, the Staffing Funnel dashboard, or any LANDING_* flag or secret. Covers how the system works, where to look, the privacy invariants, and deploy, test, verify and rollback procedures, including egress-safe query patterns.
---

# Staffing landing-link attribution

First-party measurement of what happens after ScaleLab sends a **tracked staffing link**. Two repositories are involved:

- **SalesPipeline2** (this repo, deployed on Railway): link issuance in the send path, the collector, the reconciler, Supabase storage, and the Staffing Funnel dashboard.
- **scalelabwebsite** (deployed on Netlify from `main`): the landing page at `staffing-src/` (built into `staffing/`), `netlify.toml` (the signed forwarding rule), and `privacy-policy.html`.

GA4 stays aggregate only. The first-party system is the source of truth for the outbound staffing funnel.

## How it works

```
Send path (outreach-agent.js)
  plan   → deterministic token from the send's action id, pinned in the reservation metadata
  ensure → landing_issue_link (best effort; a contradicting stored row refuses the send)
  send   → email carries https://scalelabai.ca/staffing/?t=<22-char token>
  sent   → landing_mark_link_sent (best effort)
Browser (staffing-src)
  the first <head> script strips ?t= / #sl-mark / #sl-debug with replaceState BEFORE GA loads
  → the token is kept only in sessionStorage → allowlisted events → POST /staffing/api/lp (same origin)
Netlify signed redirect → POST /api/landing/e with x-nf-sign (HS256)
Collector → verify signature, origin, rate, schema → hash token → landing_ingest RPC → always 204
Reconciler (every 15 min) → backfill issuances from pins → resolve pending sessions → daily retention
Bookings → Calendar sync writes call_booked → landing_booking_attribution labels (assistance, not causation)
Dashboard → GET /api/landing/funnel → Growth → Staffing Funnel
```

Details: [references/architecture.md](references/architecture.md). Supabase objects and query patterns: [references/supabase.md](references/supabase.md). Flags, deploys, verification and rollback: [references/operations.md](references/operations.md).

## Where to inspect

| Concern | SalesPipeline2 | scalelabwebsite |
|---|---|---|
| Flags, secret names, retention, windows | `integrations/landing-attribution-config.js` | |
| Token derivation, pinning, plans | `integrations/landing-link-token.js` | |
| Send-path glue (Step 2, automated replies) | `integrations/landing-link-issuance.js`, `outreach-agent.js` | |
| Supabase RPC calls | `integrations/landing-attribution-store.js` | |
| Collector logic and route | `integrations/landing-collector.js`, `integrations/landing-collector-route.js` | `netlify.toml` |
| Reconciler | `integrations/landing-attribution-reconcile.js` (cron in `server.js`) | |
| Dashboard | `integrations/landing-dashboard.js`, `-route.js`, `public/index.html` (`#staffing`) | |
| Schema | `supabase/migrations/20260925000000_landing_link_attribution.sql` | |
| Operator doc | `LANDING_LINK_ATTRIBUTION.md` | `staffing-src/README.md` |
| Page tracking | | `staffing-src/index.html` (first head script), `staffing-src/src/attribution/*` |
| Tests | `test/landing-*.test.js`, `scripts/landing-attribution-migration-check.mjs` | `staffing-src/tools/unit/*`, `tools/attribution-check.mjs`, `tools/check.mjs` |

## Invariants: these must always hold

1. **The raw token appears in exactly two places:** the initial document URL and the first-party collector POST body. It never reaches GA (config, `page_location`, params, dataLayer), the console, the debug UI, logs, Referer headers, third-party requests, the database, or any API response.
2. **The database stores only `token_hash`** (SHA-256). The collector hashes on arrival. No IP address, raw user agent, cookie or Referer is stored; user agents are reduced to coarse classes.
3. **GA never receives a token or identity:** no lead id, email, company or issuance id. No UTMs are added.
4. **Anonymous visitors** (no token, not internal) never create a collector request. Internal browsers load no GA. Debug mode works only in internal browsers.
5. **Engagement tiers are behavioural confidence levels, never proof of a human.** Scripted or instant scrolls are never input. Nothing is labelled "human" or "bot".
6. **Booking labels describe assistance, not causation.** Internal, debug and test traffic are excluded from every metric by default.
7. **Only `service_role` can touch landing objects.** RLS is on with no policies, and `PUBLIC`/`anon`/`authenticated` have no grants on tables, views, sequences or functions.
8. **Secrets live only in Railway and Netlify env vars.** Never print them, commit them, or pass them as tool-call arguments.
9. **Human drafts keep the plain URL.** Tracking never changes send eligibility, caps, windows, suppression, send locks or no-resend logic. With tracking off, email output is byte-identical to untracked copy.
10. **Every Supabase read names its columns and is bounded.** The full outreach corpus is never pulled for landing work (see egress rules below).

## Feature flags (off unless exactly `"true"`)

| Variable | Effect when on |
|---|---|
| `LANDING_LINK_TRACKING_ENABLED` | New eligible sends carry `?t=`. Requires a valid key ring; an invalid ring falls back to the plain URL. |
| `LANDING_COLLECTOR_ENABLED` | The collector accepts signed events. When off, everything returns a no-op 204. |
| `LANDING_RECONCILER_ENABLED` | The 15-minute backfill, resolution and retention job runs. |

Secrets and settings: `LANDING_LINK_TOKEN_KEYS`, `LANDING_LINK_TOKEN_ACTIVE_VERSION`, `LANDING_PROXY_SIGNING_SECRET` (the same value in Netlify's **production** context), `LANDING_INTERNAL_MARK_SECRET`, `LANDING_PROXY_SITE_ID`, and optionally `LANDING_TEST_EMAIL_DOMAINS`.

**Emergency rollback:** set `LANDING_LINK_TRACKING_ENABLED=false`. New emails use the plain URL immediately after the restart, and links already sent keep working.

## Changing things safely

1. **Refresh production first.** Other sessions deploy to the same Railway source branch.
   - Read the live commit from the Railway deployments list and the branch tip from `git fetch`.
   - Build on the live head: cherry-pick or rebase onto it. Never force-push, and never assume an earlier SHA is still current.
2. **Test.**
   - SalesPipeline2: run `npm test`, which includes `test/landing-*.test.js`. For schema changes, also run the PGlite migration check.
   - Website (`staffing-src`): run `npm run test:unit`, then `npm run build`, then `LANDING_BACKEND_DIR=<SalesPipeline2 checkout> npm run check:attribution`. Then run `npm run check` against `npm run preview -- --port 4173 --strictPort`, and finish with `npm run build:site` and `npm run verify:site`.
3. **Deploy.**
   - SalesPipeline2: fast-forward the Railway source branch, outside the send windows (Mon–Fri 07:00–11:30 PT, runs at :00/:30).
   - Website: open a PR (it gets a Netlify deploy preview), and the user merges it to `main`.
   - Env-var changes restart the service unless `--skip-deploys` is used.
4. **Verify.** Use [references/operations.md](references/operations.md): light health endpoints, collector-health, logs, targeted SQL and, when behaviour changed, a canary.
5. **Roll back.** Use the flags first, then a website revert, then a Railway rollback to the previous deployment. See the operations reference.

## Egress rules (Supabase)

- **Never read everything:** no `select=*` and no unbounded reads. Filter by time, and pass ids in `in.(…)` chunks of about 80.
- **Diagnose with SQL:** use targeted, aggregate SQL through the Supabase connector instead of pulling rows over REST.
- **Avoid corpus-reading endpoints:** don't call `/api/crm/health` or `/api/integrations/google-calendar/dry-run` for routine checks. Both read the whole outreach corpus.
- **Monitor from logs:** use Supabase edge logs (`query_logs`) and Railway logs to watch status codes, rather than probing endpoints repeatedly.
- **Never select `landing_session_facts.*` outward:** the view includes `token_hash`, so API responses must always name their columns.
