# SalesPipeline2: notes for Claude Code

## ScaleLab lead sourcing (Industrial Staffing V4)

For any ScaleLab prospect-sourcing task, read these two files **before doing anything**:

1. [`docs/scalelab-sourcing/ScaleLab_AI_Industrial_Staffing_ICP_and_Sourcing_Playbook.md`](docs/scalelab-sourcing/ScaleLab_AI_Industrial_Staffing_ICP_and_Sourcing_Playbook.md): the approved ICP, workflow and scoring.
2. [`docs/scalelab-sourcing/V4_DECISIONS.md`](docs/scalelab-sourcing/V4_DECISIONS.md): the owner's decisions for the new V4 campaign, current tool connection status, and the first-run checklist.

Key points (the files above are authoritative):

- **ScaleLab prospects are US industrial and skilled-trades staffing agencies.** They are not Jole BTX's industrial employers. Never mix the two campaigns' data, suppressions, senders or copy.
- **Pipeline order:** GetLeads (companies) → Jev ICP PASS/HOLD/REJECT → Adyntel ad evidence → other signals → Jev score (40/25/15/10/10) → buyer (playbook order, no randomization) → verify → personalization → review artifacts.
- **Adyntel** is reached through the env vars `ADYNTEL_EMAIL` / `ADYNTEL_API_KEY` (REST API, body auth). **Jev** is not connected until the owner says so. Fail closed, never substitute.
- **No paid credits, imports, queueing, cap changes or sends** without explicit authorization in the current task. The owner writes V4 copy after seeing the leads.

## Safety

Anything that can send, suppress, classify replies or change lead state: follow `.claude/skills/salespipeline2-outreach-safety/` first. Production state and deploy rules: `CURRENT_PRODUCTION_BASELINE.md`.
