# Agent v2: structured shadow decisions

Agent v2 reads the existing Phase 1 `conversation_state_v1` result. The
standalone worker never runs in `outreach-agent.js` or `server.js`, and its
recommendation cannot be consumed by a send, reservation, CRM, calendar,
sequence, suppression, ownership, or reply-policy function.

## Execution

`node scripts/agent-v2-replay.js --snapshot=test/fixtures/agent-v2-snapshot.json --now=2026-09-23T18:00:00Z`
replays a local snapshot with zero API calls and zero writes.

`node scripts/agent-v2-replay.js --live --limit=50` reads the four Phase 1
datasets in one read-only Sheets batch request. It makes no model calls or
writes. `--model` calls the dedicated Anthropic key, but does not persist.

Persisting requires all of `--live --model --persist`,
`AGENT_V2_SHADOW_ENABLED=true`, `ANTHROPIC_AGENT_V2_KEY`, and
`SEND_LOCK_DATABASE_URL`. The only write is to
`agent_v2_shadow_decisions`. It is intentionally a separate worker; no
production scheduler or reply handler invokes it. A scheduler can be added
only after this shadow behavior is reviewed and approved.

## Contract

- Input `agent_v2_input_v1`: bounded turns from Phase 1, one target inbound,
  Phase 1 qualification/booking/ownership/terminal status, recorded production
  reply decision, evidence warning codes, permitted turn references, and the
  `industrial_staffing_offer_v1` catalog. No second conversation memory is
  built. An older inbound in a current snapshot is recorded as
  `STATE_UNAVAILABLE`, because today's lead/board state cannot prove its
  historical context.
- Output `agent_v2_decision_v1`: action ID, handoff code, catalog fact IDs,
  qualification slot IDs, objection type, evidence references, template ID,
  reason code, and confidence. The model must make exactly one structured tool
  call. Unknown fields, IDs, evidence references, or malformed output result
  in a `MODEL_ERROR` handoff. Confidence is stored for evaluation only.
- Suggested wording is rendered from fixed templates and approved fact
  sentences. The model does not supply prospect-facing free text. The catalog
  has no pricing amount, guarantee, case study, results, demand, volume, or
  availability claims.

## Persistence and failure behavior

`decisionId = agent-v2:sha256(leadId + NUL + providerMessageId)`. The Postgres
table has both a decision primary key and `UNIQUE (lead_id, message_id)`.
`INSERT ... ON CONFLICT DO NOTHING` and readback return the first saved record;
replay does not create another. Model errors produce a saved coded handoff.
Database failures surface as errors and the worker exits nonzero after the
batch; they are never reported as persisted decisions. Inbound rows without a
provider message ID are reported as errors rather than assigned a guessed ID.

This design gives one durable shadow record for each processable inbound while
the worker is run. It does not promise that a disabled or unscheduled worker
has evaluated production messages. It does not rewrite historical evidence.

## Evaluation limits

The fixture and tests cover interested, information, qualification, pricing,
how-it-works, proof/results, objections, referral, candidate confusion,
unclear messages, unsubscribe, rejection, OOO, human takeover, booking,
reschedule, conflicting evidence, multiple threads, unsupported commercial
requests, and complaints. No live Anthropic call is part of the test suite.
Rule-based risk recognition is conservative but not a complete language
understanding system. Fixed rendering prevents unsupported outbound claims,
and every output remains advisory even if a risk phrase is missed.
