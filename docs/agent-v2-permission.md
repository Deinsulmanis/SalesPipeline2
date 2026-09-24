# Agent v2 deterministic permission evaluation

`evaluateAgentV2Permission(phase1State, completedShadowRecord)` is pure and is
not imported by the production worker, the one-shot runner, or a send path.
It consumes the `conversation_state_v1` Phase 1 state and the completed Agent v2
shadow record for one inbound message. The caller must obtain that record from
the completed shadow ledger; the evaluator performs no database read.

The result is `{ version: 'agent_v2_permission_v1', verdict, reasonCode,
actionId, leadId, messageId, executionAuthorized: false, authority }`.
`verdict` is `ALLOW`, `DENY`, or `HANDOFF`. `ALLOW` means only that a structured
advisory proposal passed these rules. Every authority flag remains false.
The result is never a send, draft, booking, CRM, suppression, reservation, or
sequence authorization.

Rules run in the order below; the first match wins. Unless stated otherwise,
the rule applies to every action.

| Deterministic condition | Verdict | Reason code |
| --- | --- | --- |
| Missing/malformed state or record | DENY | `STATE_OR_RECORD_UNAVAILABLE` or `STATE_UNAVAILABLE` |
| Wrong record version, ID, lead/message, or nonzero authority | DENY | `DECISION_IDENTITY_MISMATCH` |
| Target is no longer the latest inbound | DENY | `STALE_INBOUND` |
| Target has no usable content | HANDOFF | `UNCLEAR_INTENT` |
| Target is an autoresponder, or human origin is unproven | DENY / HANDOFF | `NON_HUMAN_INBOUND` / `HUMAN_INBOUND_UNPROVEN` |
| Unsubscribe or rejection | DENY | `UNSUBSCRIBE` / `NOT_INTERESTED` |
| OOO, other terminal hold, human takeover or staffing automation hold | HANDOFF | `OUT_OF_OFFICE` / `HUMAN_TAKEOVER` |
| Production decision absent; unclear intent; conflicting evidence; multiple threads | HANDOFF | `PRODUCTION_DECISION_MISSING`, `UNCLEAR_INTENT`, `CONFLICTING_EVIDENCE`, `MULTIPLE_THREADS` |
| Complaint, reschedule/live call, proof, results, commercial terms or pricing amount | HANDOFF | `COMPLAINT`, `BOOKING_OR_RESCHEDULE`, `PROOF_UNSUPPORTED`, `RESULTS_UNSUPPORTED`, `COMMERCIAL_UNSUPPORTED`, `PRICING_UNSUPPORTED` |
| Candidate-side objection | HANDOFF | `CANDIDATE_SIDE` |
| Human outbound exists, or reply already sent/answered | HANDOFF / DENY | `HUMAN_TAKEOVER` / `ALREADY_HANDLED` |
| Response status inconsistent, missing recorded production decision, or production action blocked/failed | HANDOFF | `RESPONSE_STATE_UNAVAILABLE`, `PRODUCTION_DECISION_MISSING`, `PRODUCTION_ALREADY_HANDLED` |
| Production classification needs human review or is a wrong-person referral | HANDOFF | `HUMAN_REVIEW_REQUIRED` / `WRONG_PERSON_REFERRAL` |
| Ownership or thread sender proof unavailable | HANDOFF | `OWNERSHIP_UNPROVEN` |
| Other evidence warning or relevant ambiguity | HANDOFF | `EVIDENCE_WARNING` / `UNCLEAR_INTENT` |
| Phase 1 digest changed since the shadow decision | HANDOFF | `STATE_CHANGED` |
| Model result invalid, incomplete, malformed, or inconsistent with the existing validator | DENY | `INVALID_DECISION` |
| Pricing question without a validator-approved pricing fact answer | HANDOFF | `PRICING_UNSUPPORTED` |

After those common gates, the action rules are:

| Agent v2 action | Additional condition | Verdict and reason |
| --- | --- | --- |
| `NO_ACTION` | Always | DENY `NO_ACTION_REQUIRED` |
| `HANDOFF` | Valid handoff code | HANDOFF with that code |
| `SUGGEST_BOOKING_COORDINATION` | Current meeting intent, no live call/reschedule, link not already sent or unknown | ALLOW `BOOKING_COORDINATION_ADVISORY`; otherwise HANDOFF |
| Any other suggestion while meeting intent is active | Always | HANDOFF `BOOKING_INTENT_ACTION_MISMATCH` |
| `SUGGEST_QUALIFICATION` | Interested/qualification inbound, unasked `unknown` slots, no prior qualification send or qualified state | ALLOW `OPEN_QUALIFICATION_SLOT`; otherwise HANDOFF `QUALIFICATION_NOT_APPROPRIATE` |
| `SUGGEST_INFO` | No prior info or qualified send, including Phase 0 legacy tags | ALLOW `INFORMATION_ADVISORY`; otherwise HANDOFF `STAFFING_INFO_ALREADY_SENT` |
| `SUGGEST_FACT_ANSWER` | Approved fact/template validation passed | ALLOW `APPROVED_FACT_ADVISORY` |
| `SUGGEST_OBJECTION_RESPONSE` | Even if structurally valid | HANDOFF `OBJECTION_REQUIRES_HUMAN` |
| `SUGGEST_REFERRAL_ACK` | Even if structurally valid | HANDOFF `REFERRAL_REQUIRES_HUMAN` |
| Unknown action | Always | DENY `UNSUPPORTED_ACTION` |

The evaluator re-runs Agent v2's existing strict validator and compares its
normalized output with the stored decision, including deterministic wording.
Confidence is validated for shape but never used to override a safety rule.
Phase 0's live mailbox observation, repeat-send veto, staffing question
draft-only rule, and booking wording remain separate production gates. A future
execution design must recheck them using fresh evidence; this evaluator grants
no execution authority.
