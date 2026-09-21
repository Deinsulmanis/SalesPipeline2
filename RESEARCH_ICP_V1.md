# Research/ICP Agent V1

**September 21 serialization update:** V1 was subsequently deployed and its first
production test failed JSON parsing. The implementation-only correction remains
`research_icp_v1`; see [the investigation, fix and validation report](RESEARCH_ICP_V1_SERIALIZATION_FIX.md).
That report supersedes the original implementation-time deployment/setup status
below. The correction is local only and requires the new additive provider-response
audit migration before deployment; do not repeat the original applied migration.

Implemented as manual, shadow-only company research and campaign evaluation. It is
disabled by default. No deployment, migration application, live model call, Apollo
call, or production lead change was performed during implementation.

## Architecture reused

- CommonJS/Express, existing global HTTP Basic Auth and isolated staffing-preview
  route registration convention.
- Existing `@anthropic-ai/sdk` and injected `createMessage` testing convention.
  The inspected research and reply modules construct SDK clients themselves;
  there is no shared generic Anthropic wrapper to reuse. This implementation adds
  one dedicated client at execution time without refactoring other agents.
- The safe first-party website fetch transport from `staffing-research.js`:
  DNS/IP checks, same-domain redirects, response limits and timeouts. The existing
  staffing crawler is unchanged. A neutral link selector visits at most four pages.
- Existing campaign ID/name/aliases from `staffing-campaign.js`.
- Supabase/PostgREST configuration through `mirrorConfig`, including its legacy
  server-key fallback. Research has a separate table; it never writes `crm_events`.
- Canonical outreach field mapping, write-authority selection and the existing
  Supabase lead getter. When Sheets owns writes, an independent Sheets client uses
  only the `spreadsheets.readonly` scope and values.get. No sheet creation/header
  repair, dashboard loaders, mirroring or authority changes occur.

Older project documentation describes Supabase as mirror-only. Current code
supports a configurable write authority, so lead lookup follows that authority.
Research is deliberately not wired into the existing Conversation Agent/reply path.

## Files

Added under `integrations/research-icp/`:

| File | Purpose |
| --- | --- |
| `agent.js` | Durable run lifecycle, dedicated SDK call, separate research/fit phases |
| `config.js` | Agent name, fixed V1 version, shadow mode, flags, model/key configuration |
| `prompts.js` | Dedicated campaign-neutral research and campaign-fit system prompts |
| `schema.js` | Strict JSON schemas, runtime validation, exact citations, fit references |
| `campaigns.js` | Shadow campaign ICP registry and inline campaign configuration |
| `input.js` | Normalization, stored-lead projection and historical comparison |
| `sources.js` | Bounded neutral website research and existing-data sources |
| `read-lead.js` | Read-only access to an existing ColdEmail lead |
| `store.js` | Audit-table-only persistence and review reads |
| `routes.js` | Authenticated manual execution and review endpoints |

Also added:

- `supabase/migrations/20260921000000_research_icp_runs.sql`
- `test/research-icp.test.js`
- `RESEARCH_ICP_V1.md` (this guide)

Modified:

- `server.js`: one registration line after existing global authentication.
- `integrations/staffing-research.js`: export existing `fetchPage`; implementation
  and existing crawler behavior unchanged.
- `.env.example`: eight documentation/configuration lines.

Pre-existing uncommitted work in sending, outreach state, server and other files
is preserved and excluded from this implementation's commit.

## Database setup and storage

Apply **only** `supabase/migrations/20260921000000_research_icp_runs.sql` to the
intended Supabase project during your normal release process. Do not indiscriminately
apply unrelated pending migrations. This migration has not been applied here.

The new `public.research_icp_runs` table has RLS enabled and no anon/authenticated
access. Server service-role access permits insert, select and update. There are no
CRM foreign keys, triggers or changes to existing tables.

Every execution first inserts a unique UUID row with `status=running`, agent,
version, mode, configured model, lead/company/campaign identity and normalized input.
Only after that succeeds can lead retrieval, website research and model calls run.
Completion updates that same **still-running** row with:

- Start/completion timestamps, success/failure status, safe error code and latency.
- Final normalized input including exact campaign ICP and its policy version.
- Source text snapshots and complete structured research, evidence, fit and warnings.
- Classification/confidence and historical comparison.
- Each completed model call's reported model and input/output token counts.
- Optional source research run ID for explicit reuse.

Re-running creates another row. Finalized runs are never updated by the agent, so
future versions can be compared. No dollar-cost estimate is fabricated; token
metadata is available for later pricing analysis.

If insertion fails, execution stops before paid calls and returns storage unavailable.
If final persistence fails, the API returns storage unavailable instead of claiming
success; the initial row stays `running`. A process crash can also leave a `running`
row. That means interrupted/unfinalized, not a completed recommendation. There is no
automatic retry queue, cleanup job or cron schedule.

## Exact environment variables

Existing `server.js` loads `.env` with dotenv; Railway supplies process variables.

| Variable | Behavior |
| --- | --- |
| `AGENT_RESEARCH_ENABLED` | Exactly `true` permits manual execution; default off |
| `AGENT_RESEARCH_MODE` | `shadow` or unset; any other value refuses execution |
| `AGENT_RESEARCH_API_KEY` | Dedicated Anthropic research key; required; no fallback to another agent's key |
| `AGENT_RESEARCH_MODEL` | Research model override |
| `ANTHROPIC_HAIKU_MODEL` | Existing model alias fallback if the research override is absent |
| `SUPABASE_URL` | Existing server database URL |
| `SUPABASE_SECRET_KEY` | Existing server database secret |
| `SUPABASE_SERVICE_ROLE_KEY` | Existing legacy fallback if `SUPABASE_SECRET_KEY` is absent |
| `SUPABASE_OUTREACH_WRITES` | Existing write-authority setting, read only by this agent; never changed |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Existing credential for read-only Sheets lookup when Sheets is authoritative |
| `SPREADSHEET_ID` | Existing spreadsheet for that lookup |
| `DASHBOARD_USER`, `DASHBOARD_PASSWORD` | Existing HTTP Basic Auth for all endpoints |

Model fallback: `AGENT_RESEARCH_MODEL` → `ANTHROPIC_HAIKU_MODEL` →
`claude-haiku-4-5`, matching existing low-cost research work. Other agents' model
configuration is unchanged. V1 uses up to two model phases, each with one bounded
SDK retry and a 60-second request timeout.

Agent identity is `research_icp`, and `VERSION = 'research_icp_v1'` is centrally
fixed in `config.js`. A free-form version override is intentionally unavailable:
changing an environment label must not falsely turn V1 code into V2. Future code
versions reuse the same agent-owned API key.

The local environment contains `ANTHROPIC_API_KEY` but no dedicated research key.
Railway CLI/access was not available for inspecting the remote variable names.
No Railway variable was renamed or changed. Verify the existing remote dedicated
key is named `AGENT_RESEARCH_API_KEY` before release; if its agreed name differs,
adapt this one configuration lookup rather than renaming production secrets.

## Campaign ICP and evidence

The core prompts contain no industrial-staffing targeting rules. Research phase
one receives company/source data only. Phase two receives validated research and
the campaign's ICP separately, and checks the supporting claims before assessing fit.

The staffing ID is `industrial_staffing_employer_acquisition_v1`. Its current name
and legacy names resolve to the same ID when no explicit ID is supplied. The shadow
ICP is versioned `staffing_research_baseline_20260915` and snapshots the later
September 15 discovery requirements, including temp/contract work, employer-facing
industrial service evidence, the three-role/majority threshold for HIGH, the
35%-or-one-of-three-service-lines criteria for MEDIUM, national/franchise exclusions,
and conservative handling of unknowns/direct-hire-only recruitment.

It also retains the earlier production research rules: diversified agencies are
not automatically disqualified, incidental jobs/client industries are insufficient,
geography requires explicit service coverage, headquarters are not coverage,
Apollo industry labels are not proof, and absence is not mismatch. The source
documents used were the staffing personalization module/refinement report and
`Claude outputs/scalelab_staffing_apollo_batch2_discovery_report.md` plus its
screening code. The old execution logic and original records remain unchanged.

This is company fit only. Buyer title, verified email/catch-all tier, duplicates,
sender selection and permission to send remain separate existing controls.

Other campaigns can pass `campaign: {id, name, icp}` with explicit criteria. Inline
criteria also allow deliberate shadow experiments for a registered campaign; they
are stored with that run, never written back to campaign settings. Missing/empty ICP
fails safely. No generic/default targeting criteria are invented for unknown campaigns.

Existing Apollo/company data can be passed as `company.existingData`. It is labeled
`existing_data`, not verified website evidence. No Apollo API or credit-spending
operation exists. Stored email copy, operational stage and old decisions are not
fed to the model as research evidence.

Each nonempty researched fact must have an exact quote from a supplied source,
a matching source type, a field link and confidence in [0,1]. The model cannot add
unknown fields or new classification names. Fit cites evidence indexes. HIGH needs
first-party evidence; mismatch needs cited affirmative disqualifiers. Semantic
accuracy still needs human evaluation: valid citations are not a guarantee that a
model understood a quotation. The fit phase is instructed to reject unsupported or
contradictory claims conservatively. There is no training or automatic prompt revision.

## Manual tests

After applying the migration and configuring the dedicated key, set
`AGENT_RESEARCH_ENABLED=true` and `AGENT_RESEARCH_MODE=shadow` in the environment
where you intend to test. Merely enabling the flag schedules nothing.

Use your existing dashboard Basic Auth. To test one stored outreach lead, send
`POST /api/agents/research/test` with:

```json
{
  "leadId": "EXISTING_COLD_EMAIL_LEAD_ID",
  "campaign": { "id": "industrial_staffing_employer_acquisition_v1" },
  "historicalDecision": "HIGH"
}
```

The lead's stored identity wins over supplied company/contact overrides. A stored
campaign assignment can be used if `campaign` is omitted. `leadId` refers to the
ColdEmail/outreach identifier, not an unrelated Pipeline-board row ID.

PowerShell example (enter the existing dashboard credentials when prompted):

```powershell
$credential = Get-Credential
$body = @{
  leadId = 'EXISTING_COLD_EMAIL_LEAD_ID'
  campaign = @{ id = 'industrial_staffing_employer_acquisition_v1' }
  historicalDecision = 'HIGH'
} | ConvertTo-Json -Depth 10
Invoke-RestMethod -Method Post -Uri 'https://YOUR_TEST_HOST/api/agents/research/test' -Authentication Basic -Credential $credential -ContentType 'application/json' -Body $body
```

One company/domain without a stored lead:

```json
{
  "company": {
    "name": "Company to review",
    "domain": "example.com",
    "existingData": { "apollo": { "industry": "Staffing & Recruiting" } }
  },
  "campaign": { "id": "industrial_staffing_employer_acquisition_v1" }
}
```

Selected historical batch (maximum five, processed sequentially):

```json
{
  "items": [
    {
      "leadId": "FIRST_LEAD_ID",
      "campaign": { "id": "industrial_staffing_employer_acquisition_v1" },
      "historicalDecision": "HIGH"
    },
    {
      "leadId": "SECOND_LEAD_ID",
      "campaign": { "id": "industrial_staffing_employer_acquisition_v1" },
      "historicalDecision": "held"
    }
  ]
}
```

For historical files not imported into the CRM, submit each selected company using
the company contract and its original `historicalDecision`. This never imports it.
Recognized exact labels produce boolean label agreement; `accepted`, `held`,
`RETRY_REQUIRED`, `REVIEW_REQUIRED` and generic retrieval/audit failures produce
`agreement: null`. They are ambiguous, not silently mapped. Historical HIGH/MEDIUM
also evaluated personalization quality; even matching labels are not proof of
equivalent criteria. Original decisions are retained outside the model input.

Each single response contains `runId`, `status`, `errorCode`, strict JSON `result`,
`comparison`, `model`, `usage` and `latencyMs`. A completed failed run is still HTTP
200 with `status: failed` and its conservative result. Check status/errorCode as well
as classification. Invalid requests return 422; disabled/invalid mode/storage
failures return 503; overlapping manual runs in one process return 409.

Review routes, all protected by the existing authentication:

- `GET /api/agents/research/runs` (latest 20; optional `leadId`/`campaignId` filters)
- `GET /api/agents/research/runs/RUN_UUID` (full audit record)

To reuse research against another campaign, send the same company/domain plus
`researchRunId: "PRIOR_RUN_UUID"` and the new campaign/ICP. This validates the
previous successful V1 snapshot and evaluates only the new fit, without recrawling
or rerunning research extraction. Domain must match. Reuse is explicit, never an
automatic freshness assumption; inspect the prior timestamp. Later versions do not
implicitly reuse incompatible V1 schemas.

## Validation and limits

`node --test test/research-icp.test.js`: **40 passed**. Coverage includes all five
classification schemas; full execution for fit/insufficient/retrieval outcomes;
invalid classifications, malformed/truncated JSON, extra fields/tool calls; missing
key/ICP; exact evidence references and confidence bounds; provider/storage failures;
shadow-only configuration; historical mapping/reuse; authoritative read-only lead
lookup; authenticated bounded manual batches; and overlapping execution control.

The safety tests execute the agent with a constrained persistence transport and
assert its only HTTP mutations are POST/PATCH to `research_icp_runs`. They also
assert no sending/queue/Conversation Agent capabilities in its module boundary,
no write-scoped Sheets access, and no changes to loaded lead state.

`npm run check`: **1,609 passed, zero failures**, including existing send safety,
campaign, staffing, reply and Supabase tests and the final identity-validation
and historical-metadata refinements.

Not verified live: Railway key name/value, live Anthropic responses, live website
quality, or migration execution against Supabase. Unit/integration tests used
fixtures and local HTTP/mock storage. No production validation is implied.

The process-local manual-run lock follows the existing preview convention; it is
not a distributed quota across replicas. A client timeout does not cancel a run
already in progress. Inspect stored results before manually submitting it again.
There is no autonomous action, deployment, lead approval/rejection, lead import,
queue change, campaign activation, sender change, suppression edit, booking,
Conversation Agent change, training, cron change or reconciliation change.

Branch: `codex/research-icp-v1`. The exact implementation commit SHA is reported in
the completion message and can be checked with `git log -1`.
