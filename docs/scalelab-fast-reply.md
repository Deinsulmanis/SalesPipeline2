# ScaleLab fast reply mode (foundations)

Fast detection, an owner alert, and a reply screen with an editable draft. Nothing is ever sent without the owner pressing Send. Both flags default off.

## Detection

- **Before:** replies are observed by the check-only pass at :15 and :45 every hour (up to 30 minutes), plus the weekday send-window passes at :00 and :30, 07:00 to 11:30 Pacific.
- **With `SCALELAB_FAST_REPLY_ENABLED=true`:** a read-only probe runs every 2 minutes from 06:00 to 21:00 Pacific (`integrations/gmail-reply-probe.js`). It calls `users.history.list` per ScaleLab inbox from its own in-memory position. Only when a new INBOX message has arrived does it start the normal check-only pass, so classification runs only on new messages. It never moves the observer's checkpoint; if a triggered pass fails, the :15 and :45 pass still sees the same messages.

## Alerts

- **When:** a routed ScaleLab reply classified `interest`, `information_request`, `pricing_request`, `meeting_request` or `reschedule_request`, received in the last 48 hours.
- **What:** one Telnyx SMS per reply, plus the ntfy push when `OWNER_PUSH_URL` is set: `{first name} at {company} replied ({intent}). Open: {link}`. The text never includes the prospect's email body or address, and a leak check refuses any text that would.
- **Failures:** retried once, then marked failed. They never block reply processing.
- **Quiet hours:** 21:00 to 06:00 Pacific. The alert is queued and goes out with the first probe at 06:00.

## Reply screen

- **Where:** dashboard → Sales → **Replies**, behind the existing login. It shows pending replies newest first, with the live Gmail thread, the lead, company, state, intent, time received, and an editable draft.
- **Send:**
  - Refused while any `[FILL: ...]` remains, in the browser and on the server.
  - Then the final gate runs with purpose `human_reply`: opt-out, bounce, the Suppression list and archive still refuse; only the routing `[MANUAL HOLD]` does not.
  - It also checks that the prospect's message is still the newest in the thread.
  - The reply goes from the original inbox in the same Gmail thread, with `In-Reply-To` and `References`, under a durable reservation (`human-reply:<action id>`). An uncertain outcome is never resent.
  - Finally it logs `human_response_sent`, keeps the lead held, and closes the item.
- **Save to Gmail drafts:** creates the draft in the same thread and sends nothing.
- **Dismiss:** closes the item.

## Drafts (v0 placeholder)

`integrations/scalelab-reply-drafter.js` is pluggable: the Claude engine on the existing budgets (feature `reply_question_answer`), with a template fallback. The wording rules live in `docs/skills/scalelab-reply-drafting/RULES.md` and are read at call time. Facts come only from `product-facts.js`; anything else becomes `[FILL: ...]`. Meeting and reschedule drafts include the booking link. Mixed, negative, unsubscribe and unclear replies get no draft.

## Railway variables

| Variable | Value |
|---|---|
| `SCALELAB_FAST_REPLY_ENABLED` | `true` turns on the probe, queue, drafts and reply screen |
| `SCALELAB_REPLY_SMS_ENABLED` | `true` turns on the SMS alert (also needs the line above) |
| `TELNYX_API_KEY` | Telnyx API key (v2) |
| `TELNYX_FROM_NUMBER` | Telnyx sending number, E.164 |
| `TELNYX_MESSAGING_PROFILE_ID` | optional |
| `OWNER_ALERT_SMS_TO` | owner's mobile, E.164; set only in Railway |
| `OWNER_PUSH_URL` | optional ntfy topic URL |
| `DASHBOARD_PUBLIC_URL` | optional; defaults to `https://receptionist.scalelabai.ca` |

Migration: `supabase/migrations/20261125120000_scalelab_reply_queue.sql` (RLS on, no anon or public policies, `service_role` only).
