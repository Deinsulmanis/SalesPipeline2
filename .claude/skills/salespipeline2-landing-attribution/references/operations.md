# Operations reference

## Where things run

- **SalesPipeline2 on Railway:** project "modest-peace", service "SalesPipeline2", environment `production`, custom domain `receptionist.scalelabai.ca`.
  - Railway auto-deploys the service's configured **source branch** on push. That branch is not `main`: read it with the Railway MCP `get-service-config` before every deploy.
- **Website on Netlify:** the site serving `scalelabai.ca` publishes the scalelabwebsite repo root from `main`, with no build step. `staffing/` is the committed build of `staffing-src/`.
- **Supabase:** see [supabase.md](supabase.md).

## Secrets and flags: setting them without exposing values

- **Never let a value into the conversation.** Don't put it in tool-call arguments, printed output, git, logs or docs. Verify by variable **name** or metadata only.
- **Railway:** generate values inside a local script and pipe each one through stdin:
  ```sh
  printf '%s' "$VALUE" | npx -y @railway/cli@latest variable set KEY --stdin --skip-deploys -p <project id> -s <service id> -e production
  ```
  - `--skip-deploys` applies directly to live config. It creates no staged patch and no restart; the next deploy picks it up.
  - Without it, Railway redeploys the same commit, which is how flag flips take effect.
  - Get ids with the Railway MCP `list-projects` / `list-services`.
- **Netlify:** `LANDING_PROXY_SIGNING_SECRET` in the **production** context only.
  - Use the CLI's API from the script: `node "$(npm root -g)/netlify-cli/bin/run.js" api createEnvVars --data '{"account_id":…,"site_id":…,"body":[{"key":…,"values":[{"context":"production","value":…}]}]}'`.
  - Omit `scopes`, which defaults to all four. Explicit scope names were refused.
  - Read it back with `getEnvVar` and compare values **inside the script** only.
  - `netlify env:set --site` run in an unlinked folder silently does nothing.
- **The proxy secret must be identical on both sides.** A mismatch makes every event `unsigned`, and events are dropped with no visitor impact.
- **Formats:**
  - `LANDING_LINK_TOKEN_KEYS`: `{"1":"<44-char standard base64 of 32 random bytes>"}`.
  - `LANDING_LINK_TOKEN_ACTIVE_VERSION`: `"1"`.
  - Proxy and mark secrets: long random base64url.
  - `LANDING_PROXY_SITE_ID`: the Netlify site id.

## Deploying SalesPipeline2 changes

1. **Refresh.** Run `git fetch`, then read the live deployment commit (Railway MCP `list-deployments`) and the source-branch tip. Other sessions deploy to the same branch.
2. **Build on the live head.** Put your commits on top of the current production commit with a cherry-pick or rebase. Confirm `git merge-base --is-ancestor <live> <candidate>` and that the diff against live is only your files.
3. **Test.**
   - Run `npm test` (the full suite; all must pass apart from the known Postgres-integration skips).
   - Run the relevant focused tests.
   - Where email copy could be affected, run a **differential render**: load `renderStaffingEmail`, `warmResponse` and the landing plans from the live commit (`git archive`) and from the candidate, with identical **synthetic** leads and render options, and require byte equality with tracking off. Don't pull real lead data locally.
4. **Deploy.**
   - Deploy outside send windows (Mon–Fri 07:00–11:30 PT, runs at :00 and :30), with 0 open reservations (`/api/ops/send-reconciliation`).
   - Fast-forward the source branch: `git push origin <sha>:refs/heads/<source branch>`. **Never force-push.**
5. **Verify.**
   - Check the Railway deployment is SUCCESS on the expected commit, and that the boot lines (`[send-lock] enabled`, `[staffing-shadow] init …`, the crons) match the previous deployment.
   - The light health set should equal your pre-deploy snapshot:
     - `/api/send-lock/health`;
     - `/api/ops/send-quota`;
     - `/api/ops/send-reconciliation`;
     - `/api/supabase/mirror-health`;
     - `/api/landing/collector-health`.
   - At the next :15/:45 check-only pass, all Gmail observers should report `history_incremental_ok … "observerHealth":"healthy"`.
   - Calendar sync should log `complete` every 5 minutes.

## Deploying website changes

1. **Test in `staffing-src/`:**
   - `npm run test:unit`;
   - `npm run build`;
   - `LANDING_BACKEND_DIR=<SalesPipeline2 checkout> npm run check:attribution`, which runs the scenarios against a stub GA and a recording collector and validates payloads with the backend's own `normalizeCollectorRequest`;
   - `npm run check` against `npm run preview -- --port 4173 --strictPort`;
   - `npm run build:site`, then `npm run verify:site`, which must be byte-identical.
2. **Deploy preview:** open a PR, and Netlify builds a preview. The signed rule forwards from previews too, but the collector refuses them because it requires `deploy_context=production`.
3. **Merge:** the user merges the PR (automated merges may be blocked). Netlify publishes `main` to production.
4. **Verify:**
   - the live `staffing/*` bytes equal the repo, and `node tools/live-check.mjs` passes;
   - `GET /staffing/api/lp` returns 405 with no `WWW-Authenticate`;
   - `/staffing-src/*` returns 404;
   - Netlify's Pretty URLs rewrites `.html` links in other pages; that's expected and not a regression.

## Production verification techniques

- **Signed-proxy proof by counter deltas:** read `collector-health` counters, send one request of each kind, and diff the counters.
  | Request | Expected counter |
  |---|---|
  | valid tokenless batch through `https://scalelabai.ca/staffing/api/lp` | `notCollected+1` (signature and schema passed) |
  | direct `POST https://receptionist.scalelabai.ca/api/landing/e` | `unsigned+1` |
  | forged `x-nf-sign` | `unsigned+1` |
  | through a deploy preview | `unsigned+1` |
- **Internal canary:** in a persistent Playwright profile, fetch `/api/landing/internal-mark` (dashboard auth) and open its URL.
  - Expect `localStorage sl.internal=1`, the fragment removed, and no gtag request.
  - Internal visits should post `internal:true`, and sessions should be stored `is_internal`.
  - `#sl-debug=1` should load GA with `debug_mode` plus the panel, while a clean browser ignores it.
  - `clearUrl` should clear the mark.
- **Synthetic tracked canary, which sends no email:**
  1. Derive a token with `deriveLandingToken` for a `canary:` action id. An ephemeral key ring is fine, because the collector only matches the SHA-256 hash.
  2. Keep the raw token in a scratch file; don't print it.
  3. As `service_role` via SQL, call `landing_issue_link` with `is_test: true` for a ScaleLab-owned lead, then `landing_mark_link_sent`.
  4. Open the URL in a clean, non-internal browser. Capture and **abort** GA `/g/collect` requests and assert they contain no token or identity. Exercise the page.
  5. Check `landing_session_facts` (named columns), the event counts, and that no duplicates exist.
  6. Test issuances are excluded from funnel views; the dashboard's `includeTest=1` shows them.
- **Booking canary:**
  - Google's booking page has reCAPTCHA, so booking is a **manual** step.
  - The attendee must be exactly one **unsuppressed** lead's email, and must not be the calendar's own account or `FROM_EMAIL`.
  - A suppressed attendee freezes Calendar sync and all send runs. An unknown one is only logged as `unmatched`.
  - You can verify the label logic without booking by running the view's lateral-join logic in a CTE with simulated `booked_at` values.

## Safe rollout order, for a re-rollout or a major change

1. Migration applied and verified.
2. Secrets set, with all three flags explicitly `false`.
3. Backend deployed with everything off. Differential render shows untracked copy is byte-identical.
4. Website and signed rule merged. Live checks pass: token stripped, no GA leak, anonymous visitors send nothing, 405 works.
5. `LANDING_COLLECTOR_ENABLED=true` and `LANDING_RECONCILER_ENABLED=true`. Run the signed-proxy proof.
6. Internal canary and synthetic tracked canary.
7. Dashboard verified against the canary data.
8. `LANDING_LINK_TRACKING_ENABLED=true`, only with Supabase healthy and egress under control.
9. Monitor the first real Step 2 window:
   - issuances match tracked sends;
   - the reconciler is ok;
   - unresolved sessions stay low;
   - there are no duplicates;
   - send caps and windows are unchanged.

## Rollback

| Problem | Action | Effect |
|---|---|---|
| Any doubt about tracked links | `LANDING_LINK_TRACKING_ENABLED=false` (restarts the service) | New sends use the plain URL; already-sent links keep working |
| Collector misbehaving | `LANDING_COLLECTOR_ENABLED=false` | 204 no-ops; the page, video and booking are unaffected |
| Reconciler errors | `LANDING_RECONCILER_ENABLED=false` | No backfill, resolution or retention until re-enabled |
| Page tracking bug | Revert the website commit, or roll back the Netlify deploy | Old page; the collector simply receives nothing |
| Backend instability | Railway rollback to the previous SUCCESS deployment | Previous code; flags keep their values |
| Revoke one link | Set its issuance `status='revoked'` | The page still loads; its events are refused (`revoked`) |
| Leaked signing secret | Set a new value in **both** Netlify production and Railway, then redeploy both | Events are dropped until both sides match |
| Key rotation | Add a version to `LANDING_LINK_TOKEN_KEYS`, then switch the active version | Keep old versions while pinned retries or backfill may still need them |

## Known pitfalls

- **Supabase REST outages:** when REST is refused (for example quota 402s), outreach automation stops by design. Recovery is verified by a clean check-only pass, observers resuming from their stored history ids, the reconciler returning `ok`, and the mirror catching up.
- **Access routes:**
  - Supabase DDL and SQL go through the Supabase connector. After authorizing it mid-session, reconnect it with `/mcp`.
  - Production CRM writes (for example `promote`) and PR merges may need the user.
- **Unmatched bookings are only logged.** They appear nowhere in the CRM.
