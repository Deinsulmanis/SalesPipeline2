# Agent v2 Phase 5 readiness boundary

`integrations/agent-v2-orchestration.js` is a shadow-only, zero-authority
boundary for industrial staffing. It is not imported by `outreach-agent.js` or
`server.js`. Existing prospect reply behavior remains under Phase 0. There is
no Agent v2 executor.

The explicit `runAgentV2OneShotReadiness` path requires a latest, genuine human
inbound with a provider message ID and recorded production decision in Phase 1.
It calls the existing Phase 2 worker: session advisory lock, durable claim,
`model_started_at`, model call at most once, completed ledger write. It then
discards the in-memory result for readiness and reads the row through
`getDecisionRow(decisionId)`. Replay uses Phase 2's completed-decision reuse;
the row read never creates a claim or calls a model.

`evaluateAgentV2Readiness` is the read-only entrypoint. It requires a row with
matching deterministic decision, lead, and provider message IDs, a completed
timestamp, claim metadata, consistent stored action/creation time, and
`model_started_at` for a model-produced record. Partial and malformed rows
cannot proceed. New shadow records include `stateAsOf`, the clock used to build
the original Phase 1 input digest. The caller's `loadCurrentState` must read
current evidence and rebuild Phase 1 using that same `asOf` clock. A missing
clock, changed evidence, or changed input digest fails closed. Older records
without `stateAsOf` are not ready.

After the ledger read and Phase 1 rebuild, Phase 3 runs unchanged. Only
`ALLOW` proceeds. The caller must then provide `checkPhase0`, a read-only
observation made after completion and after the Phase 1 snapshot. The result
must match the lead, message, and evidence digest and explicitly report:

```js
{
  leadId, messageId, stateDigest, observedAt,
  outboundObservationOk: true,
  alreadyHandled: false,
  humanTouchBlock: null,
  repeatReason: '',
  suppressionReason: ''
}
```

The future production adapter must obtain those values from the existing live
mailbox observation, `inboundWarmReplyAlreadySent`, `staffingHumanTouchBlock`,
`staffingRepeatReason`, and suppression checks. Phase 5 has no Gmail or CRM
access and does not claim that a caller-supplied observation authorizes a send.
Phase 6 must recheck live safety immediately before any action and preserve
staffing questions' draft-only behavior and approved booking wording.

Only after a passing Phase 0 observation does Phase 4 render wording. It runs
unchanged and must return `RENDERED` with nonempty approved wording. Raw model
tool input is audit data only and never used as wording or authority.

The result is:

```js
{
  version: 'agent_v2_readiness_v1', decisionId, leadId, messageId,
  decisionStatus: 'MISSING' | 'INCOMPLETE' | 'INVALID' | 'COMPLETE' | 'UNAVAILABLE',
  permissionVerdict: 'ALLOW' | 'DENY' | 'HANDOFF' | null,
  permissionReasonCode: string | null,
  wordingStatus: 'NOT_RUN' | 'RENDERED' | 'HANDOFF',
  wording: string | null,
  reasonCode: string,
  executionReady: boolean,
  executionAuthorized: false,
  authority: { send: false, reserve: false, crm: false, /* all other flags false */ }
}
```

`executionReady` only says the prerequisite artifacts passed at observation
time. It is not an execution permit or a durable lease. No send, draft,
Calendar, CRM, suppression, sender, sequence, or booking code consumes it.

## Failure order

| Condition | Readiness reason | Result |
| --- | --- | --- |
| Identity/store missing or unreadable | `INBOUND_IDENTITY_MISSING`, `LEDGER_UNAVAILABLE` | Not ready |
| No row | `LEDGER_MISSING` | Not ready |
| Claim or model attempt without completion | `LEDGER_INCOMPLETE` | Not ready |
| Row/record identity, timestamps, action, or claim metadata inconsistent | `LEDGER_IDENTITY_MISMATCH`, `LEDGER_INVALID` | Not ready |
| Fresh Phase 1 unavailable or wrong clock | `PHASE1_UNAVAILABLE`, `STATE_CLOCK_MISMATCH` | Not ready |
| Changed state, conflict, safety hold, malformed proposal | Phase 3 reason code | Not ready; no wording |
| Phase 3 throws | `PHASE3_UNAVAILABLE` | Not ready; no wording |
| Live Phase 0 observation missing, stale, unsafe, or unavailable | `PHASE0_UNAVAILABLE`, `PHASE0_BLOCKED` | Not ready; no wording |
| Phase 4 rejects or fails | Phase 4 reason, `PHASE4_UNAVAILABLE` | Not ready |
| Completed row, current state, Phase 3, Phase 0, and Phase 4 all pass | `READY` | `executionReady: true`, all authority false |

The future cutover is in the industrial staffing reply path before
`handlePositiveAutomation` reaches `deliverHardenedWarmReply`, and before
`handleQuestion` can auto-send or queue a draft. It must follow the existing
Phase 0 mailbox, repeat, human takeover, suppression, and booking checks.
Current handlers are untouched; placing Phase 5 into them now would change
existing production reply behavior, which is outside this phase.
