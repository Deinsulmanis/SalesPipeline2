# Jole sender refill repair — November 10, 2026

The November 9 audit found 207 accepted outreach sends against 235 configured daily capacity. Ready, untouched leads were left on capped inboxes while primary and deniels had spare capacity. The refill protected a full daily target even after an inbox had already sent its daily allowance. The only scheduled refill also started at 06:40 Pacific, after Jole's first four windows.

## Changes

- Calculate refill targets from successful physical-mailbox usage on the planning day, across clients and with duplicate activity events counted once.
- For live planning, limit that headroom by the remaining normal windows and each mailbox's existing per-window cap. Tomorrow's forecast starts with tomorrow's daily allowance.
- Add Jole-only 04:40/04:50 Pacific pre-window refills and idle-only :24/:54 refills during its sending morning. The legacy 06:40/06:50 refill is scoped to ScaleLab.
- A between-run operator refill requires `client=jole` and JSON `allowBetweenRuns: true`. Hold the existing automation launch reservation and prove that the private quota ledger has no active runs, lane owners or provider attempts before planning any writes. An unavailable ledger refuses the operation.
- Preserve the existing canonical compare-and-set assignment path, unresolved-reservation exclusions, suppression/ownership gates, caps, send schedules and thread ownership. The refill changes only untouched leads' sender assignments and cannot send messages.

## Today's inventory limit

At 07:40 Pacific, 81 outreach sends had completed: 12 per original Jole inbox and three each from tryscalelabai, scalelabaiteam and deniels_tryscalelabai. Primary and deniels had zero. No active quota runs, lane owners or unresolved provider attempts remained at that check.

The nine approved first-touch leads left after Monday had already been consumed. The remaining 102 untouched queued records are held, and 56 Import records require review (48 needs_review, eight hold). No holds, suppressions or classifications are changed by this repair.

With the existing inventory, filling the original six inboxes would yield 114 accepted outreach sends for today (105 original-inbox capacity plus nine first touches already accepted). That is a forecast, not a delivery guarantee. Reaching the nominal 235 daily cap requires additional approved, sendable first-touch inventory and sufficient future normal windows; it cannot be recovered by retrying sends or moving existing conversations.

## Validation

Regressions cover capped-inbox donation, physical usage across clients, duplicate activity events, next-day reset, remaining client-specific windows, unchanged protected lead exclusions, idempotence, and refusal of active/unreadable quota state. Full-suite results and production verification are recorded in the private operator report under the local Jole-Sending-Repair-2026-11-10 directory. Live proof must use the next normal sending tick, never a manual/test send.
