# Runbooks — diagnose, fix, verify, deploy

## 1. Safe production debugging

- **Read-only by default.** Write small throwaway scripts in the session
  scratchpad (not the repo). Load credentials with dotenv from the main
  checkout's `.env` inside the script; never echo them.
  - Supabase: REST `GET` with the service key, narrow `select=` and filters
    (`lead_id=eq.<id>`). Never `select=*` over the whole table in a loop.
  - Sheets: a service-account client with the `spreadsheets.readonly` scope.
  - Dashboard API: `GET` endpoints listed in code-map.md with Basic auth.
  - Railway: `list-deployments` (live SHA in `meta.commitHash`) and `get-logs`
    (filter by timestamp / text). Variable listing is blocked by design.
- **Git Bash on Windows:** export `MSYS_NO_PATHCONV=1` before passing
  `/api/...` as a script argument, or the path is rewritten to a local file path.
- **Timing:** send windows are :00/:30 inside the configured weekday window;
  check-only runs at :15/:45; Calendar sync every 5 min; the landing reconciler
  every 15 min (logs only on failure). Avoid mutating calls and deploys while
  `/api/agent/status` shows `running: true`.
- **Never** trigger an agent run, a send, a draft, or a sequence enrolment to
  "see what happens". Never write `outreach_leads` directly.

## 2. Diagnosing a reply / classification incident

1. Identify the inbound Gmail message id and the lead. Read the lead row
   (stage, email_status, email_step, notes, revision) and every activity event
   for the lead (`sourceLeadId`/`leadId`/email) from the ledger.
2. Fetch the raw message read-only and inspect its MIME tree: is there a
   text/plain part? HTML only (iPhone Mail)? Where does the quote start?
3. Run the extraction locally: `ownReplyText(payload, snippet)` →
   classifier. If the verdict came from quoted text (our own footer, our cold
   copy, a signature), the bug is extraction, not the classifier.
4. Check what the verdict wrote: note tags, Suppression row, stage/status,
   Pipeline card notes (tags are copied to the card), drafts, Agent v2 decisions.
5. Check downstream blast radius: did Calendar sync start failing for this lead
   (`[Calendar safety] … blocked`)? Are other leads affected (search stored
   events whose recorded type differs from `recordedTerminalReply` on their text)?
6. Report root cause, affected leads and the proposed fix **before** mutating.

## 3. Mutating production state (only with explicit approval)

Use the supported endpoint for the change (promote, reply-override,
false-opt-out correction, queue). For each:

1. **Pre-check script** asserting every precondition (state, tags, card count,
   suppression, reservations, ownership, no running pass). Save the snapshot.
2. **One call**, exact body, logged output. No retries on ambiguous results —
   re-read state instead.
3. **Post-check script** diffing against the snapshot: only the intended fields
   changed; exactly the intended audit event added; no send/reservation events.
4. **Second identical call** for idempotent endpoints: must return a no-op
   (`writes: 0`), add no events, leave `revision` unchanged.

Protected leads (human-owned, meeting booked, held on purpose): read them after
every deploy and mutation; they must be byte-for-byte unchanged unless they were
the target.

## 4. False opt-out: prevention and audited correction

Prevention is invariant 8 (own-words extraction) plus `recordedTerminalReply` on
replays. When a false opt-out has already been written:

1. **Contain first:** promote to a human-owned stage
   (`POST /api/coldemail/:id/promote`; it applies `[MANUAL HOLD]` to the
   ColdEmail twin when the target stage requires a hold — verify the tag
   landed), so no automation can act while repairing. The board card id is
   `CE-<leadId>`; confirm exactly one card, in columns A:W.
2. **Record the human verdict:** `POST /api/leads/:id/reply-override` on that
   inbound message, positive/neutral, signed by the human.
3. **Suppression list row:** removing it is a separate, deliberate human
   decision; the correction refuses while the row exists.
4. **Release the tag:** `POST /api/coldemail/:id/false-opt-out-correction`
   `{ providerMessageId, overrideId, by }`. It refuses (HTTP 409, with a code)
   unless: exactly one lead; the original opt-out event exists; an active,
   unreversed override authorises it; the stored reply re-read as own words no
   longer opts out and no other inbound reply does; the exact tag and
   `[MANUAL HOLD]` are present; lead and card are human-owned; not on the
   suppression list; no pass running; send lock readable with no unresolved
   reservation; no pending Agent v2 decision, sequence or undelivered send; and
   ownership still refuses sending after the release. It writes one
   `false_opt_out_corrected` audit event first, removes only the exact tag from
   the lead and the Pipeline card notes, and returns `already_corrected` with
   `writes: 0` on repeat. It never sends, reserves, enrols, changes stage or
   status, removes the hold, or edits the original event.
5. `[MANUAL HOLD]` stays. Resuming automation is a separate human decision.

## 5. Tests

Run everything: `node --test` from the repo root (require 0 failures; a handful
of skips are expected). Targeted suites by area:

| Area | Suites |
|---|---|
| Reply extraction / classification | `reply-quoted-contamination`, `reply-reconciliation`, `canonical-reply`, `reply-decision`, `late-reply`, `multi-reply-conversation`, `reply-detection-failsafe` |
| Opt-out correction / markers | `false-opt-out-correction`, `supabase-safety-note-precedence`, `sheets-notes-preservation`, `manual-hold`, `supabase-resume-tag-precedence` |
| Ownership / suppression | `automation-ownership`, `stage-ownership`, `live-booking-gate` |
| Final gate / fresh reads | `send-safety-revalidate`, `fresh-send-state`, `send-authorization` |
| Reservations / no-resend | `send-lock-concurrency`, `send-reservation-store`, `send-reconciliation`, `send-reconciliation-phase2d` |
| Canonical Supabase | `supabase-stage3*` (incl. `-apply-lead-change`, `-safety-matrix`, `-write-authority`, `-primary-reads`) |
| Egress model / pins | `intent-backstop` (corpus-read budget model), `calendar-zero-event`, `supabase-stage3` (H4/N2 reader pins) |
| Observers / threading | `gmail-mailbox-observer`, `gmail-threading` |
| Calendar / booking | `google-calendar`, `calendar-zero-event`, `prebooking-e2e` |
| Board writes | `leads-sheet-append` |

Regression-test expectations for any safety fix:
- Reproduce the real input shape (MIME tree, note string, ledger rows).
- Assert the refusal code, not just `allowed: false`.
- Cover the fail-closed branch (reader throws / returns `ok: false`) and assert
  there is no Sheets fallback.
- For gate refactors, an equivalence matrix over states × purposes.
- For read-path changes, a count of corpus reads per run/per send.
- Source pins for call sites that must not regress (and narrow, never delete).

## 6. Deploy and verify

Before:
1. `git fetch`; read Railway's live SHA and the production branch head. They
   must match what you based on; if production moved, stop and rebase/cherry-pick
   only your change onto the new head, rerun tests, and report.
2. Clean tree; the candidate is exactly your commit(s) on the production head;
   read the diff.
3. Full suite + targeted suites green.
4. Outside a send window, `/api/agent/status` not running.
5. Push fast-forward to the production branch (never force).

After (read-only):
- Railway deployment `SUCCESS` with the expected `commitHash`; boot logs clean
  (all crons scheduled, send-lock enabled, staffing-shadow authority unchanged).
- Supabase REST 200; no `402` / `[FATAL]` in logs.
- Boot intent-only pass exits 0 with a single `[outreach-read]` corpus read.
- Next check-only pass: every `[GmailObserver:*] history_incremental_ok`,
  `trustworthy: true`; `/api/integrations/gmail-inboxes` observers healthy.
- `[Calendar sync] complete`; landing collector healthy, 0 ingest failures.
- `/api/send-lock/health` ok; `/api/send-lock/reservations` no unexpected
  unresolved rows.
- Caps and windows unchanged (`capacity` block of gmail-inboxes; cron line).
- Protected leads unchanged.
- Send-path changes: first live proof comes from the next normal send window
  (`[egress-meter]` agent reads per window, gate refusals, reservations confirmed).
