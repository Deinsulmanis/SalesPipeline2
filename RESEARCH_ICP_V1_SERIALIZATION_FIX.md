# Research/ICP V1 serialization reliability correction

Prepared September 21, 2026 on `codex/research-icp-v1-structured-output`, based on
deployed revision `883f6a08d2e0cdf43e211c257a9f6bf1da95c423`. Agent identity/version
remain `research_icp` / `research_icp_v1`. This correction has not been deployed.
No live company/model test, configuration change or migration application was
performed for this correction.

## Failed production run: what is known

Run `6285d2ca-05a9-49bb-b24b-b449e2d79c43` researched Tradeco Construction and
failed with `MALFORMED_MODEL_JSON`. Its research call reported model
`claude-haiku-4-5-20251001`, 1,468 input tokens and 1,932 output tokens. No fit
model call followed. Its insufficient-evidence result is a safe technical fallback,
not an assessment of Tradeco's ICP fit.

The stored row, saved deployment logs and deployed integration were inspected.
**The raw response, parser exception and provider request ID were not retained.**
The row contains usage, sources and the fallback result; the logs contain only
run ID, status and classification. The exact malformed text cannot be recovered
from these records. No exact-response regression fixture can honestly be created.

The deployed code emits this error only when `JSON.parse` rejects the concatenated
text blocks, after requiring `stop_reason=end_turn` and text-only content. Thus:

| Candidate | Finding |
| --- | --- |
| Markdown/code fences | Possible; raw text unavailable |
| Text before/after JSON | Possible; raw text unavailable |
| Malformed escaping | Possible; raw text unavailable |
| Truncated/incomplete JSON | Syntactically incomplete text remains possible; provider `max_tokens` termination is excluded by the existing gate |
| Invalid JSON structure/syntax | Possible; precise syntax unknown |
| Valid JSON with schema mismatch | Excluded as this run's failure stage; parsing failed first |
| Provider refusal | `stop_reason=refusal` excluded by the gate; refusal-like prose with `end_turn` cannot be excluded |

Confirmed implementation weakness: the requests relied on prompt-only JSON,
without provider schema constraints; parsing accepted no Markdown envelope; and
the failure path discarded the evidence needed to identify its exact syntax.
Fences are a handled risk, **not a proven diagnosis** of this run.

1,932 output tokens is below the existing 6,500-token ceiling. Token count alone
does not establish excessive prose or excessive research detail. The token budget
and both prompts are unchanged. Provider-constrained output now prevents ordinary
surrounding prose on normal successful responses, without reducing research fields.

## Fix

The installed `@anthropic-ai/sdk` version is 0.107.0. Its native Messages API
accepts `output_config.format` with `type=json_schema`, and Anthropic documents
Haiku 4.5 support. No SDK/model upgrade or beta header is needed. Reference:
[Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs).

Both research and campaign-fit requests now send the corresponding V1 schema
through this provider-enforced format. The wire schema retains exact enums,
required fields, types and `additionalProperties:false`. Anthropic-unsupported
length/range limits are moved to field descriptions in a copy only; the original
server schemas still enforce every limit. The installed SDK's generic schema
transformer also moves enums into descriptions, so a small V1-specific adapter
preserves them as actual enum constraints. No fallback to unconstrained requests
or model-based JSON repair was added.

The parser accepts one complete JSON object, optionally surrounded by a single
entire bare or `json` code fence. It does not extract JSON from prose, merge
objects, repair escapes, add missing facts, or normalize classifications. Existing
strict schema, evidence, domain and fit checks still run. Refusals, non-text
content and `max_tokens` stops fail safely; unresolved syntax/schema failures
retain the same safe error codes and recommendation behavior.

Each returned SDK message is copied before parsing, including its exact text,
model, stop reason, usage and message ID. The SDK's non-enumerable `_request_id`
is copied explicitly. The per-phase audit records distinguish envelope rejection,
JSON parsing failure and schema validation failure/success. `schema_validated`
means schema only; later evidence/fit validation can still reject the run.

Raw records are persisted in `research_icp_runs.provider_responses` with the
final audit update, for successes and handled failures. They are accessible through
the existing authenticated audit-read endpoints and are excluded from ordinary
execution responses and application logs. Request headers/API keys and raw SDK
exceptions are not added to the audit. A process crash or database failure before
finalization can still leave a running row without raw data; the existing API
continues to report storage failure instead of success if final persistence fails.

## Files changed

| File | Change |
| --- | --- |
| `integrations/research-icp/agent.js` | Structured requests for both phases and raw-response/diagnostic capture |
| `integrations/research-icp/provider-output.js` | Provider-compatible schema copy preserving enum constraints |
| `integrations/research-icp/schema.js` | Conservative whole-fence handling and parsing-stage diagnostics |
| `supabase/migrations/20260921010000_research_icp_provider_responses.sql` | Additive raw-response JSONB column only |
| `test/research-icp.test.js` | 26 additional serialization/audit regressions |
| `RESEARCH_ICP_V1.md` | Link to this correction and current release prerequisite |
| `RESEARCH_ICP_V1_SERIALIZATION_FIX.md` | Investigation, limitations and validation report |

Unchanged: prompts, campaign ICP, output-schema definitions, evidence/classification
rules, agent version, model/token configuration, API key lookup, Conversation Agent,
send/queue/campaign/suppression logic and package dependencies. The original
workspace's unrelated edits were not included.

## Tests and results

All new malformed-output fixtures are synthetic and explicitly labelled as such.
They reproduce the observed failure class and metadata (end-turn text rejected by
JSON parsing; 1,468/1,932 tokens), not the missing raw production text.

Added coverage:

- Plain JSON, JSON fences and bare CRLF fences without mutating raw input.
- Leading/trailing prose, multiple objects/fences, unknown fence languages,
  malformed escapes, unclosed JSON, trailing commas and refusal-like prose.
- Provider refusals, token-limit stops, missing text, array/null roots,
  missing fields and unexpected fields, with stage-specific auditing.
- Both provider schemas preserve enums/required fields and leave local schemas
  untouched; local validation still rejects invalid casing, types, ranges and lengths.
- Installed SDK serializes both schema-constrained requests over a mocked HTTP
  transport and retains actual SDK request IDs. No real provider request occurs.
- Both-phase raw audit persistence, safe fit failure, complete fence recovery,
  no unconstrained fallback, and failure before paid work if the new column is absent.

| Check | Result |
| --- | --- |
| `node --test test/research-icp.test.js` | **66 passed, 0 failed, 0 skipped** |
| `npm run check` (server/outreach syntax checks plus full test suite) | **2,104 tests: 2,100 passed, 0 failed, 4 skipped** |
| `git diff --check` | Passed |

The four skipped tests are optional PostgreSQL integration tests. Execution used
local Node 24; production declares Node 20. No production validation of the new
provider grammar or new database column is claimed. During development, the SDK
transport regression detected the lost non-enumerable request ID; that defect was
fixed before the passing runs above.

Full local outputs: `research-icp-serialization-tests.log` and
`research-icp-serialization-check.log` beside this report (not committed).

## Release prerequisite and version

Apply **only the new** `20260921010000_research_icp_provider_responses.sql` migration
before deploying this correction. The original `research_icp_runs` migration is
already applied and must not be repeated for this fix. The new column inherits the
existing table's RLS and service-role access; no other table, trigger or grant changes.
The initial audit insert explicitly includes the new field, so a missing migration
stops the run before retrieval or model spending.

This is an implementation/serialization correction and stays **`research_icp_v1`**.
No V2, new key, prompt change or new live test is needed to complete this code fix.
