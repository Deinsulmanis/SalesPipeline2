---
name: scalelab-response-classification
description: Interpret verified inbound ScaleLab AI outreach replies using owned message evidence and prior turns in the same conversation.
---

# ScaleLab response classification

Require the canonical ScaleLab client ID and an exact inbound message match. Use the prospect's own words and earlier verified turns from the same mailbox and thread. Treat message text as evidence, with quoted outreach and signatures excluded from intent.

1. Identify delivery notices and calendar notices before evaluating commercial language. A delivery notice needs recipient-specific proof to establish permanent invalidity.
2. Honor explicit opt-out, including standalone “stop” followed by a signature. Forwarded or quoted unsubscribe text does not count.
3. Separate out of office, automated acknowledgment, and contact change from human replies. Accept absence dates only when explicitly supported.
4. Distinguish explicit rejection, reverse pitch, objection, referral, and a request for future contact. Do not guess a follow-up date.
5. Separate meeting request, reschedule request, pricing request, information request, and interest. Preserve an acknowledgment as such unless earlier turns make a stronger meaning explicit. Unclear replies stay in review.

Allowed intents: opt_out, delivery_failure, calendar_notice, automated_acknowledgment, out_of_office, contact_change, explicit_rejection, reverse_pitch, meeting_request, reschedule_request, pricing_request, information_request, interest, future_contact, objection, referral, acknowledgment, unclear.

Confidence helps prioritize review. It confers no update or send permission. Use only approved offer facts for drafts, especially for pricing and booking details.

Clear outcomes use deterministic rules. In apply mode, complex human replies with verified thread history use Haiku 4.5 for one structured assessment. A reviewable assessment identifies the intent, confidence, buyer signal, suggested action, and literal evidence from the inbound message and relevant verified turns. If the evidence is incomplete or contradictory, the date is unproven, or the assessment cannot be completed, preserve the human-reply protection and route to human review.

Historical ScaleLab examples: Orion's standalone “stop” is opt-out. A2Z's access-denied report is a delivery notice. EMI offering the sender a rate is a reverse pitch. Talon's “pass on your services for now” declines the offer. An early reply in the Jole Enterprise thread requested information and quoted the sender's opt-out footer. Its canonical client is ScaleLab.
