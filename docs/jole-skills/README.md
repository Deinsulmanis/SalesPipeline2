# Jole BTX qualification skills (snapshot)

This folder is a version-history snapshot of the nine Jole skills. It is **not** the source of truth, and nothing in the application reads it.

The canonical skills live outside git, in `~/.claude/skills/`, so they load in every Claude Code session on every branch:

| Skill | Version | Answers |
|---|---|---|
| `jolesbtxicpskill` | 4.0.0 | Shared policy: capabilities, hard exclusions, safety, labels, precedence, evidence standard |
| `jole-icp-qualification` | 1.0.0 | Can Jole realistically provide industrial skilled labor to this company? |
| `jole-buying-signals` | 1.0.0 | What evidence suggests the employer needs more skilled workers, and when? |
| `jole-buyer-identification` | 1.0.0 | Who is the most relevant person to approach? |
| `jole-site-labor-feasibility` | 1.0.0 | Is there a practical commercial path to supply workers to this operation? |
| `jole-dedupe-suppression` | 1.0.0 | Is this account or contact net-new and allowed? |
| `jole-contact-deliverability` | 1.0.0 | Is the recipient's email suitable for outbound? |
| `jole-outreach-readiness` | 1.0.0 | Can this contact be approached with accurate, approved messaging? |
| `jole-qualification-orchestrator` | 1.0.0 | Which of these does a task need, in what order, and what happens next? |

Start with `jolesbtxicpskill/ARCHITECTURE.md`. `jolesbtxicpskill/MIGRATION-v4.md` maps every v3 rule to its new home.

**Tests.** From this folder: `python jolesbtxicpskill/tests/run_all.py`. The discovery tests check this machine's Codex pointers and instruction files, so they pass only where those exist. The fresh-session check is `jolesbtxicpskill/tests/cold_session/run_cold.py`; it uses real model sessions and costs money.

**Updating.** Change the canonical files, run the tests there, then copy the folders here on a docs-only branch. Nothing here deploys. Merging into `main` deploys nothing (see `CURRENT_PRODUCTION_BASELINE.md`), and `main` must never be merged into the production branch.

Before 4.0.0, the single v3 skill lived at `docs/jole-icp-skill/`. That history is on branch `docs/jole-icp-skill-v3-20261102`.
