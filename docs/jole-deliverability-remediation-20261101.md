# Jole deliverability remediation, 2026-11-01

Baseline: production `3f13ca2`, Railway deployment `00b06d86-d344-4224-a96f-637e345c2a10`.
Sending configuration is unchanged: 15/20/20/20/15/15 = 105/day, 120/day and 12/window
client ceilings, 2/window per inbox.

## What changed

- **First-touch hold.** `integrations/clients/data/jole-deliverability-holds.json` lists the
  Proofpoint catch-all leads with their evidence and original state. `joleSelectionHold`
  skips them at selection, and `renderClientLeadEmail` refuses their Touch 1, which stops
  the queue preflight, the sender refill and the last check before a reservation. No lead
  row changes. Contacted leads are not affected.
- **Delivery notices (managed clients only).** Status code, SMTP reply and diagnostic are
  stored. Recipient failures, routing failures and policy refusals are told apart.
  Cisco, Trend Micro and similar gateway notices are recognised. Delays and temporary
  failures are recorded as `email_delivery_deferred` and `email_delivery_failed`.
- **Inbound health.** `/api/ops/jole-inbound-health` now answers for Jole's inboxes only.
- **Send audit.** `/api/ops/send-audit?date=YYYY-MM-DD&client=jole` covers all six inboxes.
- **Delivery report.** `/api/ops/client-delivery-health?client=jole`: failures by class,
  inbox and domain, with rolling first-touch bounce rates against the 3% and 5% lines.

ScaleLab inboxes keep their existing notice rules. `test/jole-deliverability-remediation.test.js`
pins this.

## Event meanings

| Notice | Event | Suppressed | Next touch |
|---|---|---|---|
| Recipient invalid, recipient routing failure, unclassified permanent | `email_bounced` | Yes | Stopped by suppression |
| Policy or reputation refusal | `email_delivery_failed` | No | Blocked, needs a person |
| Code-less gateway "could not be delivered" | `email_delivery_failed` | No | Blocked, needs a person |
| Final 4.x.x failure | `email_delivery_failed` | No | Continues |
| Delay notice | `email_delivery_deferred` | No | Continues |

Rows written before this change have no `deliveryClass`. They stay as written and report as
`unclassified`.

## Rollback

1. Redeploy Railway deployment `00b06d86-d344-4224-a96f-637e345c2a10` (`3f13ca2`). No data
   migration is involved, and any new event rows are simply ignored by the old code.
2. To release one held lead, remove its entry from the data file and deploy. Do not edit the
   Sheet: selection reads Supabase, and the hold is not a lead-row state.

## DMARC reporting: proposed, not applied

No DNS access or authorized report mailbox was available. Create the mailbox first, then
replace each existing TXT record at `_dmarc.<domain>` in Namecheap Advanced DNS. Keep `p=none`.

| Host | Domain | Value |
|---|---|---|
| `_dmarc` | jolebtxgroup.com | `v=DMARC1; p=none; rua=mailto:dmarc@jolebtxgroup.com;` |
| `_dmarc` | jolebtxteam.com | `v=DMARC1; p=none; rua=mailto:dmarc@jolebtxteam.com;` |
| `_dmarc` | joleindustrial.com | `v=DMARC1; p=none; rua=mailto:dmarc@joleindustrial.com;` |

Each address sits on its own domain, so no `_report._dmarc` authorization record is needed.
A shared mailbox on another domain would need one.
