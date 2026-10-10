# Agent v2 Phase 6 execution boundary

Phase 6 is disabled unless `AGENT_V2_EXECUTION_ENABLED=true`. It applies only
to industrial staffing positive replies whose existing deterministic policy
chooses `AUTO_STAFFING_QUALIFY_QUESTION`. The only Agent v2 action allowed to
reach delivery is `SUGGEST_QUALIFICATION`. Other actions remain review only.
The flag is not enabled by this change.

## Durable lifecycle

1. The Gmail observer persists `gmail-reply:<provider message ID>` with the
   Gmail message, thread, RFC message and sender IDs, plus its deterministic
   `genuineHuman` and recovery verdict.
2. After the existing reply policy selects a qualification send, the handler
   appends `reply_decision_pending_execution` to `ColdCallActivity`. Its event
   ID is `reply-decision-pending:<lead ID>:<provider message ID>`, its version
   is `reply_decision_pending_execution_v1`, and its execution status is
   `pending_execution`. The event is accepted only when the observer's human
   and provider fields match. Duplicate observation reuses the event ID.
3. Phase 1 gives a later `reply_decision_recorded` final event precedence over
   pending. Phase 3 and Phase 5 accept pending only when its proof still
   matches the source Gmail event. Historical final statuses are not recast as
   pending.
4. The existing Phase 2 one-shot claims in the restricted Supabase Postgres
   ledger before its model call and reuses completed decisions on retry.
   Phase 3 permission, Phase 4 wording, and Phase 5 readiness then run on
   fresh deterministic Phase 1 state.
5. Phase 6 reloads lead, suppression, activity and Phase 1 evidence, verifies
   the Gmail thread's latest message, sender ownership and eligibility, human
   and repeat guards, quota and window, send authorization, and the existing
   reservation. It sends only approved Phase 4 wording through
   `deliverHardenedWarmReply` → `deliverProspectReply` → `sendEmail` and the
   existing durable send lock. The hardened path checks fresh state again
   before provider delivery.
6. The handler appends the normal `reply_decision_recorded` final event with
   `sent`, `already_sent`, `blocked`, `failed`, or human review status. For a
   Phase 6 pending inbound, that final append is required before writing
   `gmail_reply_evaluated`. A confirmed delivery can be recovered from the
   exact delivered activity and confirmed send reservation without another
   Agent v2 model or provider call. Ambiguous transport remains in the existing send
   reconciliation path.

The Phase 6 result has `version`, deterministic `decisionId`, lead/message
IDs, Agent v2 `actionId`, `executionVerdict`, machine-readable
`executionReasonCode`, `executionAuthorized`, `executionStatus`, sender ID,
and provider message ID. `executionAuthorized=true` is returned only after a
confirmed qualification delivery. A blocked or uncertain delivery never
claims authorization.

With the flag off, the existing warm-reply call remains the selected branch.
There is no Agent v2 model call, pending event, or Phase 6 reservation lookup
on that branch. Existing send authorization and the global send lock still
govern the legacy handler.

## Final freshness (2026-10-01)

Inside the hardened warm-reply final revalidation, Phase 6 rebuilds Phase 1 from
a snapshot read at that moment and runs `agentV2FinalFreshness`
(`integrations/agent-v2-freshness.js`). It refuses unless the inbound is still
the newest inbound; no human outbound and no answer to it exist; there is no
human takeover, automation hold or terminal state; no call is scheduled, live
or requested; the lead, email, thread, sender inbox and explicit ScaleLab client
are unchanged; there is no evidence conflict; and the lead is not suppressed.
`deliverProspectReply` then runs `verifyThread` (Gmail: the thread's newest
message is still this inbound, which also catches a manual reply the ledger has
not observed) immediately before the reservation and the provider call.

Qualification wording (`SLOT_CLAUSES`, at most two) renders as, for example:
"Got it. To make sure we'd target the right employer accounts for you, what
roles or trades do you place most often, and which locations do you cover?"
It is sent exactly like the legacy staffing warm replies (same delivery
primitive, no added signature or footer).

## Controlled canary (2026-10-01)

Execution needs BOTH `AGENT_V2_EXECUTION_ENABLED=true` (with the shadow
prerequisites) AND the runtime kill switch ARMED. Anything else leaves every
reply on the legacy path exactly as when execution is disabled.

**Scope** (`integrations/agent-v2-canary.js`, `CANARY`): Industrial Staffing
Agency; ScaleLab with an explicit `client_id`; lead pinned to and reply observed
on `primary`; the prospect's first genuine-human message, under 90 minutes old,
with no human or automated warm outbound; the deterministic policy chose
`AUTO_STAFFING_QUALIFY_QUESTION`; Agent v2 `SUGGEST_QUALIFICATION`, 1–2 slots,
confidence >= 0.90, no risk flag, objection, referral or meeting intent. Cap:
3 attempts per Vancouver day, counted from `reply_decision_pending_execution`
records (an unresolved attempt still counts). An in-scope message Agent v2
declines goes to human review (draft), never to a legacy auto-send.

**Kill switch** (`integrations/agent-v2-kill-switch.js`, migration
`20261001000000_agent_v2_runtime_control.sql`): one row in Supabase, read live
with no cache in routing, before readiness, immediately before delivery, and in
the final gate. Missing configuration, any HTTP/network error, a timeout, a
missing or malformed row, armed without expiry, or an expired arm all read as
DISARMED. Arming needs a reason, a named person and an expiry within 15 days.
Every change is written with its audit record in one transaction.

```
# disarm (always accepted)
POST /api/ops/agent-v2/kill-switch {"armed": false, "reason": "...", "by": "Deins"}
# arm (refused unless the execution flag is configured)
POST /api/ops/agent-v2/kill-switch {"armed": true, "armedUntil": "<ISO, <=15 days>", "reason": "...", "by": "Deins"}
GET  /api/ops/agent-v2      # flags, kill switch, effectiveSendAuthority, canary scope, cap use, sends, outcomes
```

**Send recovery** (`integrations/agent-v2-send-recovery.js`): Gmail replaces the
RFC Message-ID we write, so a send is proven only by Gmail's own identity — the
provider message id the durable reservation recorded, or the
`X-ScaleLab-Action-Id` header on a SENT message in the expected thread after
the inbound, from our inbox, to the lead. Proven + the reservation holds that id:
the delivered row is written and the reservation confirmed (ALREADY_SENT).
Anything else — including "nothing found" — is RECONCILIATION_REQUIRED for a
person. A lost acknowledgment is never resent.

**Replay gate** (`scripts/agent-v2-replay-eval.js`,
`test/fixtures/agent-v2-replay-corpus.js`): 49 labeled cases (12 real
historical, 37 synthetic). `test/agent-v2-replay-corpus.test.js` proves that no
proposal at any confidence can send outside the cases labeled permitted.

