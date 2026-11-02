# Jole ICP skill: version-history snapshot

This folder is a history copy. It is not loaded by any agent and is not the source of truth.

**Canonical skill:** `C:\Users\deins\.claude\skills\jolesbtxicpskill\`

The canonical skill stays outside this repo on purpose. A personal skill loads in every session, while a repo skill exists only on branches that contain it. Nothing here runs in production: no file in this folder is imported by the application or used by sending.

## Why two commits

The first commit on this branch is the old skill unchanged, and the second is v3.0.0, so `git diff` on `SKILL.md` shows exactly what the policy change was.

## Using it

- To change the policy, edit the canonical `SKILL.md` with the user's approval, add a change-log entry, and run `python tests/test_skill.py` in the canonical folder. Then copy the files here.
- To restore on another machine, copy `SKILL.md`, `reference.md` and `tests/` to `~/.claude/skills/jolesbtxicpskill/`.
- Do not add this folder to `.claude/skills/`. That would create a second, competing skill.
