# Jole BTX qualification skills (source)

This folder is the **source of truth** for the nine Jole qualification skills. Nothing in the application reads it, and nothing here deploys.

The skills are used from an installed copy in `~/.claude/skills/`, which Claude Code loads in every session and on every branch. The installation also includes the Codex pointers in `~/.agents/skills/` and the Jole sections of `~/.claude/CLAUDE.md`, `~/AGENTS.md` and `~/.codex/AGENTS.md`. All of it is generated from this folder by `jolesbtxicpskill/tools/sync.py`, which also detects drift.

| Skill | Version | Answers |
|---|---|---|
| `jolesbtxicpskill` | 4.1.0 | Shared policy: capabilities, hard exclusions, safety, labels, precedence, evidence and freshness standards |
| `jole-icp-qualification` | 1.1.0 | Can Jole realistically provide industrial skilled labor to this company? |
| `jole-buying-signals` | 1.1.0 | What evidence suggests the employer needs more skilled workers, and when? |
| `jole-buyer-identification` | 1.0.1 | Who is the most relevant person to approach? |
| `jole-site-labor-feasibility` | 1.0.1 | Is there a practical commercial path to supply workers to this operation? |
| `jole-dedupe-suppression` | 1.0.1 | Is this account or contact net-new and allowed? |
| `jole-contact-deliverability` | 1.0.1 | Is the recipient's email suitable for outbound? |
| `jole-outreach-readiness` | 1.1.0 | Can this contact be approached with accurate, approved messaging? |
| `jole-qualification-orchestrator` | 1.1.0 | Which specialists does a multi-question task need, in what order, and what happens next? |

Start with `jolesbtxicpskill/ARCHITECTURE.md`. It covers routing, installation, the change procedure and integration into `main`. `jolesbtxicpskill/MIGRATION-v4.md` maps every v3 rule to its new home, and `jolesbtxicpskill/BENCHMARK-700.md` is the plan for scaling toward 700 sendable prospects.

**Install or check** (on the machine that runs the sessions):

```
python %USERPROFILE%\.claude\skills\jolesbtxicpskill\tools\sync.py status
python <this folder>\jolesbtxicpskill\tools\sync.py install --ref origin/main
```

`install` backs up the current copies to `~/.claude/backups/jole-skills/`, and refuses to overwrite local edits that are not committed here.

**Tests.** `python jolesbtxicpskill/tests/run_all.py` from this folder runs every skill's tests. The installation check and the discovery tests (Codex pointers, instruction files) run only from the installed copy. The fresh-session check is `jolesbtxicpskill/tests/cold_session/run_cold.py`; it uses real model sessions and costs money.

**Updating.**
1. Edit the installed copy.
2. Run its tests.
3. Run `sync.py export` into this folder on a docs-only branch, and commit.
4. Run `sync.py install --ref <branch>`.

Merging into `main` deploys nothing (`CURRENT_PRODUCTION_BASELINE.md`). Never merge `main` into a production branch.

Before 4.0.0, the single v3 skill lived at `docs/jole-icp-skill/`. That history is on branch `docs/jole-icp-skill-v3-20261102`.
