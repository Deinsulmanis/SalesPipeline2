# Jole industrial activation

The operator explicitly approved internal warmup completion for
`jole_industrial_jorge` (jorge@joleindustrial.com) and
`jole_industrial_jguerrero` (j.guerrero@joleindustrial.com). This is an
operator override, not a Smartlead completion report.

The existing persisted runtime rows already say active. Production activation
requires removing only their `warmup_incomplete` holds and changing only their
entries in `COLD_INBOX_DAILY_CAPS` from 0 to 15. Preserve 2/window, client jole,
and the jole-btx-employer-acquisition campaign restriction. Revalidate through
the existing activation endpoint after deployment; it checks Gmail identity,
credentials, observer health, domain/campaign policy, and remaining holds.

The six daily caps are 15, 20, 20, 20, 15, 15. Existing allocation code derives
105/day from that sum, below Jole's unchanged 120 hard ceiling. The window
ceiling stays 12. ScaleLab stays 170/day with sender caps 50/30/15/45/45.
No scheduler, copy, follow-up ownership or sender-lane execution change is needed.
The baseline is 0038e1a4c2b88a5b6d9a3455812b80cbe5d16f6a.

## Queue preparation

Use GET /api/ops/sender-balance?client=jole&bufferRatio=7.8 for a read-only plan,
then POST the same route only after inspecting its per-lead moves and counts.
This requests roughly 8.8 days of capacity-weighted workload, counting pinned
follow-ups without moving them. The full corpus remains available to duplicate
and suppression checks, while only Jole senders can receive or donate work.
Without these explicit parameters, the existing scheduled refill is unchanged.

The existing server operation excludes concurrent agent passes, holds its launch
reservation during writes, uses canonical compare-and-set changes, updates only
senderInboxId, and appends a lead_sender_rebalanced audit event for every success.
Its reservation inventory now includes fresh reserved/sending leases as well as
expired and unresolved outcomes, without the diagnostic 500-row truncation.
Its existing 400-move limit still applies.

## Validation and rollout

- Both industrial mailboxes: OAuth refresh, Gmail profile/read access, gmail.modify
  sending scope, and primary/default From identity verified without sending.
- Public DNS: Google MX, SPF include:_spf.google.com, Google DKIM key, DMARC p=none.
  These are configuration checks; recipient-side alignment/delivery is not inferred.
- Test suite: 3350 passed, 7 skipped, 0 failed (3357 total).
- New coverage exercises six-inbox 105/12 allocation, ten overlapping client
  windows consuming exactly 105/170, sender exhaustion, isolation, persisted
  runtime reconstruction, activation gates, multi-day queue redistribution,
  unsafe-lead exclusions, and fresh reservation exclusion.
- Stage only the two cold-policy variable changes, commit/push the intended
  production branch, explicitly deploy that commit, then check live SHA,
  quotas, holds, observers and the queue. Git push is not deployment evidence.
- Use the existing activation endpoints and audited queue operation; never
  invoke a send pass, replay missed windows, or send external test emails.

Next scheduled Jole window after this rollout: Monday 2026-10-26 at 07:00
America/Chicago (12:00 UTC), followed by half-hour windows through 11:30.
Capacity is a maximum, not evidence of future dispatch or delivery.
