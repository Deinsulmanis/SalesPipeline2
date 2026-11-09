# Exclusive ScaleLab sender transfer to Jole

The transfer uses the existing 11 physical Gmail identities. It adds no mailbox,
OAuth credential, sender alias, database schema or duplicate quota identity.
Five original ScaleLab identities receive an exclusive future outbound assignment
to `jole-btx-employer-acquisition` when `JOLE_SCALELAB_SENDERS_ENABLED=true`.

## Current limits

Updated at the user's request on 8 November: primary 45/day and deniels 30/day.

| Physical sender ID | Daily ceiling | Per scheduled window |
| --- | ---: | ---: |
| primary | 45 | 2 |
| tryscalelabai | 20 | 2 |
| scalelabaiteam | 15 | 2 |
| deniels | 30 | 2 |
| deniels_tryscalelabai | 20 | 2 |

These ceilings can only lower existing configured/runtime limits. The six
existing Jole inboxes retain their configuration. Their current effective total
is 105/day, and the five transferred inboxes add a daily ceiling of 130. Effective Jole
client capacity becomes 235/day and 22/window while enabled. With two per window
and ten normal daily windows, each inbox still sends at most 20/day; raising the
daily ceiling alone does not increase that schedule limit. Actual sends still
depend on normal windows, eligible leads, deliverability gates and quota holds.

`CLIENT_SENDING_PAUSED=scalelab` independently blocks ScaleLab at its final client
gate, including old first touches and follow-ups. It does not complete campaigns,
reset sequence steps or disable historical observation.

## Ownership and identity

Historical ownership comes from the canonical lead/campaign and confirmed Gmail
send evidence for that physical mailbox. Current outbound assignment cannot
relabel an old reply. Ambiguous thread/RFC/email matches fail closed; messages
without deterministic ownership enter metadata-only operator review. Client
activity/health reports filter by conversation ownership. Client-scoped inbox
responses omit other clients' aggregate health and capacity.

Outbound client consistency remains strict. Historical inbound evidence cannot
authorize a new outbound send through the other client's assignment. The five
transferred From names identify the original operator as sending "on behalf of
Jole BTX LLC". Existing Jole signatures, mailing address, opt-outs, credentials
and From email addresses remain in use.

## Deployment and activation gates

1. Deploy from the current production branch ancestry, outside sending windows,
   after isolated full-suite validation and a fresh production/remote SHA check.
2. Keep transfer disabled while Google access is blocked. Pause ScaleLab with
   `CLIENT_SENDING_PAUSED=scalelab` without releasing any lead or reservation.
3. Verify all 11 Gmail accounts with the read-only per-inbox verification route.
   An `access_not_configured` response identifies the existing public OAuth
   client ID and existing `gmail.modify` scope for Workspace administrator review.
4. Check idle agent, `/api/send-lock/reservations?includeActive=true`, and the
   read-only `/api/ops/send-quota-state`. Never release or retry an uncertain
   provider outcome merely because it is old or absent from a Gmail search.
5. Record canonical lead and protected-record snapshots. Archive only confirmed
   automatic residual ScaleLab follow-ups through the existing archive API;
   preserve replies, manual review, suppression and sequence history.
6. Once Google access and complete observer checkpoints are healthy, enable the
   exclusive assignment and existing concurrent sender lanes. All five move in
   one configuration change. Verify physical IDs/emails are unique and the
   effective client totals are Jole 235/22 and ScaleLab zero.
7. Preview then apply the existing Jole sender balancing operation for eligible,
   unsent, unreserved leads only. Existing sent follow-ups remain pinned.
8. Verify production SHA, boot, canonical-store health, observers, quota state,
   client views and protected-record snapshots. Do not send synthetic emails or
   trigger an agent pass. Observe the next normal scheduled sending window.

## Rollback

Pause Jole outbound before changing assignments; wait for all active sends and
reservations to be resolved. Set `JOLE_SCALELAB_SENDERS_ENABLED=false` and deploy.
Keep `CLIENT_SENDING_PAUSED=scalelab` until a separate explicit resume decision.
Original sender configuration then applies again. Historical Jole replies on
these same five mailboxes retain their original owner through the same evidence
path. Do not reset usage, durable actions, cursors, Gmail threads or sequence
steps. Archived sent leads restore held for review, never directly to sending.

The flag and assignment are reversible. Real sends, archive audit events and
Gmail observations are lasting history and must be preserved across rollback.

## Validation

`test/jole-sender-transfer.test.js` covers exact mailbox binding, exclusive
assignment/rollback, independent client pause, both directions of historical
ownership, same-address ambiguity, conflicting threads, persisted-event replay,
metadata-only review, client reporting isolation, shared physical usage,
ambiguous quota holds, fresh observation for delegated first touches and
read-only quota inspection. The normal full repository suite must pass before
deployment; production Gmail and database health are checked separately.
