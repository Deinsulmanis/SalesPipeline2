# Tenant isolation and Jole daily report implementation notes

## Read-only production baseline before code changes

Captured 2026-10-16 23:57:40 UTC from authenticated GET requests. Production branch `cursor/staffing-agent-shadow-production-7402` was `077c31633ac2b78432863087faa46ecf5d326b30`. No production write was made.

| Client | Active ColdEmail leads | Stages | Contacted | Queued | Genuine replies | Booked meetings | Campaigns | Senders |
| --- | ---: | --- | ---: | ---: | ---: | ---: | --- | ---: |
| ScaleLab | 1,003 | Done 379; Contacted 530; Queued 1; Review 36; Unsub 4; Import 53 | 939 | 1 | 10 (17 inbound records including 7 automated) | 0 | Legacy ScaleLab registry | 5 (4 active, 1 paused) |
| Jole | 689 | Queued 670; Import 19 | 0 | 670 | 0 | 0 | `jole-btx-employer-acquisition`: 689 leads, 670 queued, 0 sent/replies/meetings | 6 (status may change during launch preparation) |

The client-scoped lead ID sets had zero intersection. `/api/clients/:id/overview`, `/pipeline`, `/inbox`, `/meetings`, and `/settings` returned client-scoped data. The shared Outreach API returned Jole's 689 rows but **global** `counts` (`queued: 671`, `emailed: 939`, `replied: 17`, `done: 384`, `total: 1692`), facets for both niches/campaigns, global sender choices, send activity, and pipeline audit. `/api/coldemail/stats?client=jole` and `/api/coldemail/replies?client=jole` ignored the client query; replies returned ScaleLab's 17 records. The Jole Outreach UI called those endpoints without a client query and called global `/api/proposalOpens`. ScaleLab's default Outreach likewise received mixed aggregates and filters, even though its lead rows were scoped. These are source/API discrepancies, not a difference in the underlying lead counts.

Browser UI automation was unavailable in the session; desktop and mobile visual assertions require a follow-up browser pass. Static inspection found stale Outreach state and in-flight response races when switching clients, including cached search/filter choices and an initial ScaleLab board fetch before a stored Jole context was selected.

## Proposed additive snapshot schema (before migration)

Table `public.client_daily_reports` with composite primary key `(client_id, report_date)`, `client_id` referencing `public.clients(client_id)`, `report_date date` interpreted in the client's timezone, `generated_at timestamptz NOT NULL`, `timezone text NOT NULL`, `campaign_id text NOT NULL`, `campaign_version text`, nullable integer columns `sends_attempted`, `successful_sends`, `replies`, `positive_replies`, `negative_replies`, `unsubscribe_requests`, `bounces`, `meetings_booked`, `untouched_remaining`, `contacted_cumulative`, `replies_cumulative`, `positive_replies_cumulative`, `meetings_cumulative`, nullable numeric `reply_rate`, `positive_reply_rate`, `meeting_rate`, and JSONB `per_sender`, `sender_health`, `unavailable`. A null number means the source cannot support the metric; it must never be presented as zero. `generated_at` is never changed on retry. RLS is enabled with no browser policies; access is service role only. The migration is prepared on this feature branch and is not applied to production.

## Measurement and timing

Snapshots are Jole-only, deterministic, and use client-owned leads and their activity, client-owned meeting ledger rows, configured Jole sender identities and observer health. A confirmed provider send counts as a successful send. An attempted send has no complete, client-attributed, append-only attempt ledger in the current read model, so it is null with a reason. Other metrics with insufficient dated evidence remain null with a reason. Percentages use contacted unique leads as denominator and are null when the denominator is zero. A report for date D covers events after the previous weekday's 14:00 Central up to and including D's 14:00 Central, so Monday carries Friday afternoon and the weekend, every event lands in exactly one daily report, and cumulative figures are bounded by the same cutoff. Snapshot generation is scheduled for 14:00 `America/Chicago` on weekdays, retried at 14:05 through 23:05 Central on weekdays, and caught up on process start if still the same Central reporting date after 14:00; a retry measures the same period as the 14:00 run. Insert uses the date/client unique key and ignore-duplicate semantics; existing snapshots are returned unchanged. No report read triggers sending or lead mutations. Production activation requires applying the migration and setting `CLIENT_DAILY_REPORT_ENABLED=true`; neither is done here. The frozen report opens from Jole Analytics; it supports date selection, back navigation, responsive desktop/mobile layout and print. Browser visual automation was unavailable, so this UI has source and renderer coverage but still needs a visual browser pass after integration.

## Review pass (2026-10-17)

Reviewed the full diff before commit. Fixed:

- **ScaleLab Outreach crash.** `loadCeLeads` called its `current()` staleness guard inside a block that also declared `const current` (the live campaign version), a temporal-dead-zone `ReferenceError` on every ScaleLab load, surfaced only as "Could not reach server". Renamed; a test now fails any dashboard function that shadows its own guard.
- **Daily report lost evening activity.** Daily metrics used the calendar day while the snapshot freezes at 14:00, so replies, bounces and meetings between 14:00 and midnight were never counted in any daily report, and a delayed retry measured a different window. Replaced with the fixed weekday-to-weekday 14:00 period above.
- **Hard-coded client branches in the dashboard.** The report launcher, report loader and send-chart timezone tested for `'jole'`; two existing tests had been narrowed to tolerate it. The dashboard now reads a server-declared `dailyReport` capability and the client's configured `timezone`; the original whole-dashboard assertions are restored.
- **Lead timeline regression.** The activity drawer matched by lead id only, dropping legacy email-matched rows. It again matches by id or email, restricted to the client's own lead ids.
- Report shows held and capped inboxes as such (`cold_hold`, `daily_limit` in `per_sender`), rates to one decimal, a server-side report title, 422 for a malformed date, and the scheduler's retry task is stoppable.
- Report layout checked in headless Edge with the dashboard's own CSS at 1280px, 390px and print: no horizontal overflow; phones keep two metric columns; print is white with no clipped edge.
- Migration made re-runnable (`if not exists`) with JSON shape checks. It is still not applied.

Not reviewable here: the full dashboard in a live browser (starting `server.js` locally would schedule real sends), so tenant switching was verified by source and unit tests, not visually.
