---
name: scalelab-crm-routing
description: Plan and review ScaleLab inbound CRM actions with stable identity, protected stages, and recoverable writes.
---

# ScaleLab CRM routing

Use the canonical ScaleLab client ID and verified message and lead identity.

| Intent | Destination |
| --- | --- |
| Interest, buyer pricing or information request, meeting coordination | Follow Up for a new eligible opportunity or a human task on the existing card |
| Future contact | Follow Up with a human task at the explicitly agreed date |
| Sample list request | Follow Up with a human task, plus a sample employer list drafted in the same thread for the owner to review |
| Opt-out, negative | Existing suppression or rejection handler |
| Delivery notice, calendar notice, automated acknowledgment, OOO, contact change | Transport, calendar or mailbox review rules |
| Objection, referral, reverse pitch, unclear acknowledgment | Human review |

Stage order is Follow Up, Hot (replied), Call Booked, Call Held, Proposal / Agreement Sent, Client Signed + Tech Fee Paid, and Closed / Lost. Closed Won, Closed Lost and Archive remain terminal for this workflow. A human task cannot alter a meeting or resume a sequence. Preserve all later stages and existing manual ownership. Review conflicting identities, bookings or newer edits.

Use a stable action per client, mailbox, message and lead. Commit and verify the cold hold, confirm the linked card, and publish the human task. Keep pending work until verified and read back ambiguous outcomes. Never retry an append with a different identity. Opt-out uses the existing durable global suppression contract.

Crew Staffing's duplicate promotion history is a regression example. A repeated event should converge on one action and one card. Orion's opt-out categorically bypasses positive routing. A2Z belongs to delivery review.

The router validates the following deployment contract when initializing its action store.

```json
{"version":"scalelab_follow_up_v1","newStage":"follow_up","owner":"human","enrollSequence":false}
```
