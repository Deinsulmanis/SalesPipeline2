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
`AGENT_V2_SHADOW_DATABASE_URL`, plus `--lead=<lead id> --message=<provider message id>`.
The identified message must be the latest inbound for that lead and have a
recorded production reply decision. One invocation can evaluate at most that
one inbound. The worker reads Sheets with a read-only scope, never reads Gmail,
and writes only `agent_v2_shadow_decisions`. Apply the SQL migration separately
before running the worker. Give the worker database role `SELECT`, `INSERT`, and
`UPDATE` on this table only; it does not need access to send reservations or
other production tables, and it performs no runtime DDL. It is not called by the production
reply handler, send path, or scheduler. The operational trigger is an explicit
one-shot invocation after a natural inbound has been recorded. A future
independent scheduler may invoke the same command with genuine IDs; no scheduler
is installed by Phase 2.

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
Before a model call, the worker takes a PostgreSQL session advisory lock and
commits an incomplete claim row. It then durably marks the model attempt as
started before making exactly one API request. A second worker sees the held
lock and spends no model tokens. Completion updates that row only while the
same session holds the lock. A crash releases the lock; the next worker can
take over the incomplete claim. If the model-start marker exists, recovery
saves a coded, empty `MODEL_ERROR` handoff without another API request. A
completed record is immutable and returned on replay.
The model request receives an abort signal if the database session fails.
Model and validation errors produce a saved coded, empty `MODEL_ERROR` handoff.
Database failures surface as errors and never count as completed decisions.
Inbound rows without a provider message ID are not assigned a guessed ID.

Each run emits bounded counts for attempts, completions, busy claims, reuse,
handoffs, model failures, validation failures, tokens, latency, estimated cost,
and a coded cross-tab against the recorded production policy action. The saved
record includes the exact model version returned by the API, token usage,
latency, cost estimate, and recorded production decision for later comparison.
The estimate uses the published standard Haiku 4.5 API rates of $1 per million
input tokens and $5 per million output tokens; actual billing may differ.

This design gives one durable shadow record for each selected processable
inbound while the worker is run. An unscheduled worker does not evaluate new
messages automatically. It does not rewrite historical evidence. An incomplete
claim may be evaluated after a crash only if no model attempt was marked. The
marker can precede an API request that never actually reached the provider; in
that case recovery deliberately records an unresolved model attempt rather
than spending tokens again. A lost database session during an in-flight API
call is aborted locally; provider-side token accounting may still be uncertain.

## Evaluation limits

The fixture and tests cover interested, information, qualification, pricing,
how-it-works, proof/results, objections, referral, candidate confusion,
unclear messages, unsubscribe, rejection, OOO, human takeover, booking,
reschedule, conflicting evidence, multiple threads, unsupported commercial
requests, and complaints. No live Anthropic call is part of the test suite.
Rule-based risk recognition is conservative but not a complete language
understanding system. Fixed rendering prevents unsupported outbound claims,
and every output remains advisory even if a risk phrase is missed.
