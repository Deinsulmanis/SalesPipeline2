---
name: salespipeline2-outreach-safety
description: Safety rules and workflows for SalesPipeline2 cold-email outreach — reply classification, suppression, [MANUAL HOLD], human ownership, send reservations and no-resend, canonical Supabase state, fail-closed send gates, egress-safe reads, Gmail observer cursors, Calendar booking gates, safe production debugging and deploy verification. Use before changing, debugging or deploying anything that can send, suppress, classify replies, or mutate lead state.
---

# SalesPipeline2 outreach safety

SalesPipeline2 sends real cold email from several Gmail inboxes on a cron. A wrong
verdict mails someone who opted out, re-mails someone twice, or talks over a human
who owns the conversation. Every rule below exists because one of those nearly or
actually happened. **When in doubt, refuse to send — never refuse to protect.**

Code map: [references/code-map.md](references/code-map.md).
Incident, fix and deploy procedures: [references/runbooks.md](references/runbooks.md).

## Invariants — never bypass, weaken or work around

1. **One final gate before every provider call.** Every Gmail send, Smartlead
   enqueue and stage-sequence step calls `guardProviderSend` (send authorization →
   staffing gate → `revalidateFreshSendSafety`) *immediately* before the provider.
   It re-reads the lead as it is *now*, not the run-start snapshot. New send paths
   must call it too; tests pin the call-site count.
2. **Durable reservation before the attempt; never resend on uncertainty.** A send
   first reserves a deterministic action id (`outbound-action-id.js`, e.g.
   `gmail-cold:<lead>:step:<n>`) in `outbound_send_reservations`. `confirmed` and
   `sent_unconfirmed` are never retried; only `failed_pre_delivery` may be taken
   over; `reconciliation_required` is operator-only. Smartlead uncertainty is
   manual-only.
3. **Supabase is canonical.** With `SUPABASE_OUTREACH_MODE=primary` and
   `SUPABASE_OUTREACH_WRITES=supabase`, `outreach_leads` decides; Sheets is a mirror.
   Automation must never fall back to the mirror (`sheetsFallbackAllowed('automation')`
   is false). Unreadable canonical state ⇒ the run exits non-zero and the final gate
   returns `revalidation_unavailable`. Never "fix" an outage by reading Sheets.
4. **Lead writes go through `applyLeadChange`** (compare-and-set on `revision`,
   then Sheets mirror). No raw PATCHes to `outreach_leads` from app code or scripts.
5. **Safety markers are sticky.** `[REPLY: Unsubscribed]`, `[REPLY: Not Interested]`,
   `[BOUNCED…` and `[MANUAL HOLD]` survive every notes write. Only `[MANUAL HOLD]`
   is releasable (`releaseMarkers`). An opt-out tag can be removed **only** by the
   audited false-opt-out correction, which needs a complete authorization and a human
   override (runbooks §4). Never add another release path.
6. **Suppression is a union.** A lead is suppressed if its notes carry any
   suppression tag, or `[MANUAL HOLD]` without a *past* `[RESUME: <ISO>]`, or its
   email is on the Suppression list (`sendSuppressionReason`). It is checked at
   selection *and* at the final gate. Removing one source never unsuppresses on its own.
7. **At most one owner of the next move** (`deriveAutomationOwnership`). Replied,
   promoted, meeting-bearing, held or terminal leads are human-owned or `none`;
   no cold step, sequence or Agent v2 action may run for them. Ask this module; do
   not re-derive eligibility locally.
8. **Classify only the prospect's own words.** Reply text comes from `ownReplyText`:
   text/plain → text/html cut at its quote markup → snippet, all through
   `stripQuotedReply`. Our own cold-email footer contains the word "unsubscribe",
   so classifying a quoted thread manufactures false opt-outs. Replays of stored
   events use `recordedTerminalReply`, which can only *stop* re-applying a verdict
   our own copy produced — it never lifts a suppression.
9. **No per-send or per-lead full-corpus reads.** One corpus read (all
   `outreach_leads`) is megabytes of Supabase egress. The final gate reads one
   row (`getOutreachLeadById` via `fresh-send-state.js`); the corpus is read once
   per run. Any hot-path loop over leads must not call a corpus reader.
10. **Observer cursors advance only after a complete window.** Gmail `historyId`
    is adopted only when every page was processed; page bounds, identity
    mismatch or quota errors keep the old checkpoint. Never hand-edit cursors to
    "skip ahead" — that silently drops replies.
11. **Calendar gates every automation launch.** `launchAutomationAfterCalendar`
    runs a Calendar sync first; if it fails, nothing launches (including the send
    cron). A booking that cannot be applied — e.g. a suppressed lead with no
    visible Pipeline card — fails the sync and blocks *all* automation until a
    human resolves it.

## Working rules

- **Never send mail to prove a fix.** No test sends, no manual cron triggers in a
  send window. `DRY_RUN` stops at "WOULD SEND" *before* `guardProviderSend`, so no
  no-send path exercises the final gate; live proof waits for the next normal window.
- **Human-owned leads are off-limits to automation and to you.** Do not reactivate,
  release holds, remove suppression or draft/send to a lead the user is handling
  unless the user explicitly asks for that exact change.
- **Diagnose read-only first.** Supabase REST GETs, Sheets readonly scope, dashboard
  GET endpoints, Railway logs. Mutating endpoints only with explicit approval, once,
  with a pre-check before and a post-check after (runbooks §3).
- **Caps and send windows are config, not fixes.** Do not change sender caps,
  per-run limits or windows to explain or fix a shortfall unless evidence proves
  the config wrong and the user approves.
- **Secrets stay in memory.** Load `.env` via dotenv inside the script; never print,
  log or commit values. Railway variable listing is intentionally blocked — use
  runtime logs and read-only endpoints instead.

## Changing code safely

1. Find the invariant the change touches (list above) and the tests that pin it
   (runbooks §5). If a pin must move, narrow it to exactly the new sanctioned call
   site and say so in the commit — never delete a pin.
2. Write the regression test from the real failure shape first (real MIME
   structure, real note strings, real ledger rows), then the fix.
3. Keep fail-closed paths fail-closed: a thrown read ⇒ refusal with a code, never
   a default-allow and never a Sheets fallback.
4. Prove equivalence for refactors of the gate: same verdict for every state
   (held, unsubscribed, suppressed, bounced, terminal, missing, email changed) ×
   purpose (cold / sequence / warm).
5. Run the full suite (`node --test`) plus the targeted suites; require 0 failures.

## Deploying

Production deploys on push (fast-forward) to the Railway production branch, not
`main`. Other sessions deploy too. Follow runbooks §6 exactly: re-read the live
SHA and branch head immediately before pushing, stay out of send windows, confirm
no pass is running, then verify boot, Supabase, observers, Calendar, landing
collector, send lock, caps and the protected leads afterwards.
