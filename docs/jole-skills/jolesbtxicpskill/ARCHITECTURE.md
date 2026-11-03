# Jole qualification skills: architecture and index

Part of shared policy 4.1.0 (2026-11-03). This page maps the eight Jole skills: what each answers, when it runs, what it depends on, how a session finds them, and how they are installed from the repository. The rules themselves are in the SKILL.md files.

## Skills and versions

| Skill | Version | Answers | Folder |
|---|---|---|---|
| `jolesbtxicpskill` | 4.1.0 | Shared policy: capabilities, hard exclusions, safety, labels, precedence, evidence and freshness standards | `~/.claude/skills/jolesbtxicpskill/` |
| `jole-icp-qualification` | 1.1.0 | Can Jole realistically provide industrial skilled labor to this company? | `~/.claude/skills/jole-icp-qualification/` |
| `jole-buying-signals` | 1.1.0 | What evidence suggests the employer may need more skilled workers, and when? | `~/.claude/skills/jole-buying-signals/` |
| `jole-buyer-identification` | 1.0.1 | Who is the most relevant person to approach? | `~/.claude/skills/jole-buyer-identification/` |
| `jole-site-labor-feasibility` | 1.0.1 | Is there a practical commercial path to supply workers to this operation? | `~/.claude/skills/jole-site-labor-feasibility/` |
| `jole-dedupe-suppression` | 1.0.1 | Is this account or contact net-new and allowed? | `~/.claude/skills/jole-dedupe-suppression/` |
| `jole-contact-deliverability` | 1.0.1 | Is the recipient's email suitable for outbound? | `~/.claude/skills/jole-contact-deliverability/` |
| `jole-outreach-readiness` | 1.1.0 | Can this contact be approached with accurate, approved messaging? | `~/.claude/skills/jole-outreach-readiness/` |
| `jole-qualification-orchestrator` | 1.1.0 | Which specialists does a multi-question task need, in what order, and what happens next? | `~/.claude/skills/jole-qualification-orchestrator/` |

## Dependencies

```
                      jolesbtxicpskill (shared policy: lists, labels, precedence, evidence, Apollo, freshness)
                                 ^ every skill reads it first
   +-------------+-------------+-+-----------+-------------+--------------+---------------+
   |             |             |             |             |              |               |
 dedupe        ICP          signals        buyer       feasibility     contact        readiness
 (account,   (fit only)   (needs ICP     (needs ICP   (only on a     (needs buyer   (reads all
  contact)                 not stopped)   not stopped)  trigger)       + contact      recorded
                                                                       data)          results)
                orchestrator: only for multi-question tasks; chooses, orders, reuses, stops, consolidates
```

- Specialists never call each other. Each reads the shared policy and its inputs, and writes one envelope (CONTRACT.md).
- Readiness reads the others' recorded results and does not repeat their research.
- Feasibility runs only when another skill records a trigger (union, labor agreement, clearance, nuclear, new owner, local-hire pledge, EPC or prime purchasing, required certification).

## Routing: which skills a task loads

**Route by question, not by the number of companies** (shared policy, "How to use"). A task that asks one qualification question loads the shared policy and that question's specialist, whether it covers one company or five hundred. The orchestrator is loaded only when a task needs answers from two or more specialists, a next action per subject, or a sourcing, requalification or contact-wave plan. Each specialist's description says to load it directly; the orchestrator's says it is not for single questions.

Fresh sessions loaded the orchestrator for 5 of 7 single-question prompts under 4.0.0, because the policy, the orchestrator description and the instruction files all said "a list of companies" meant the orchestrator. Under 4.1.0 the list size no longer matters.

| You ask | Questions | Skills that load |
|---|---|---|
| "Is Bayou Hull Works a fit for Jole?" | fit | `jolesbtxicpskill`, `jole-icp-qualification` |
| "Which of these 200 companies are a fit for Jole?" | fit | `jolesbtxicpskill`, `jole-icp-qualification` |
| "What does this expansion news mean for demand at X?" | demand | `jolesbtxicpskill`, `jole-buying-signals` |
| "Rank these 40 yards by how urgent their need is" | demand, priority | `jolesbtxicpskill`, `jole-buying-signals` |
| "Who should Jorge contact at X's Odessa plant?" | buyer | `jolesbtxicpskill`, `jole-buyer-identification` |
| "X's plant has a project labor agreement. Can Jole work there?" | feasibility | `jolesbtxicpskill`, `jole-site-labor-feasibility` |
| "Are any of these 300 domains already in the CRM or suppressed?" | dedupe | `jolesbtxicpskill`, `jole-dedupe-suppression` |
| "This email is on a pphosted.com catch-all. OK to send?" | contact | `jolesbtxicpskill`, `jole-contact-deliverability` |
| "Can we use the 'Saw you're hiring' opener for these contacts?" | readiness | `jolesbtxicpskill`, `jole-outreach-readiness` |
| "Screen this sourced list: new to us, and a fit?" | dedupe, fit | `jolesbtxicpskill`, `jole-qualification-orchestrator`, `jole-dedupe-suppression`, `jole-icp-qualification` |
| "Build a signal-based shortlist of Gulf yards" | dedupe, fit, demand | `jolesbtxicpskill`, `jole-qualification-orchestrator`, `jole-buying-signals`, `jole-dedupe-suppression`, `jole-icp-qualification` |
| "Where does each of these prospects stand, and what next?" | fit, demand, next action | `jolesbtxicpskill`, `jole-qualification-orchestrator`, `jole-buying-signals`, `jole-icp-qualification` |

Explicitly: `/jole-icp-qualification`, or "use the jole-buyer-identification skill".

## When each skill is invoked

| Skill | Invoke when | Do not invoke when |
|---|---|---|
| Dedupe, account pass | Right after sourcing, before research spend | Already checked within 30 days for screening |
| ICP | Every company, first substantive gate | The company is already stopped by dedupe |
| Signals | The task needs demand or priority: shortlist, requalify, copy evidence | Pure discovery; company stopped |
| Feasibility | A material trigger is recorded | General defense capability only; no trigger |
| Buyer | The company is not stopped and the task needs a person | ICP CONDITIONAL with an open gap; a credit hold |
| Dedupe, contact pass | Before any reveal, purchase, import or queue | No person yet |
| Contact | Buyer known and contact data available | Company discovery |
| Readiness | Contacts headed for a sequence | No accepted contact |
| Orchestrator | Two or more of the above, a next action per subject, or a plan | One question, for any number of subjects |

## Activation order and decision precedence

**Default order for a full pass:**
1. Dedupe (account).
2. ICP.
3. Signals.
4. Feasibility, if triggered.
5. Buyer.
6. Dedupe (contact).
7. Contact.
8. Readiness.

The orchestrator trims this to the task (its section 1).

**Stops, from shared policy section 4:**
- PROHIBITED.
- ICP EXCLUDED.
- Account-level SUPPRESSED.
- BLOCKED BY VERIFIED REQUIREMENT, for the covered scope.

Contact-level stops affect one contact only.

**Next-action precedence:** STOP, HOLD, REVIEW, RESEARCH FIT, RESEARCH FEASIBILITY, RESEARCH SIGNAL, RESEARCH BUYER, SOURCE CONTACT, VERIFY CONTACT, COPY REVIEW, HUMAN REVIEW.

**Independence:**
- A dimension is never lowered by another dimension's gap.
- A conflict is recorded, never resolved by overwriting.
- Opportunity priority uses demand only, and it is a provisional research-ranking band: it orders work and never decides eligibility, suppression, feasibility, contact acceptance, readiness or authorization.
- Evidence age lowers reliance and confidence, never a label (shared policy section 7).

## Output contracts

See [CONTRACT.md](CONTRACT.md). In short: one envelope per skill per subject, with ten mandatory fields, plus skill-specific `details` and an optional `reverify` list; one consolidated record per subject from the orchestrator; one batch CSV schema.

## Source and installation

**The source of truth is the SalesPipeline2 repository, folder `docs/jole-skills/`**, one sub-folder per skill plus a README. It holds everything needed to reproduce an installation: the nine skill folders, their tests, `tools/sync.py`, and the instruction sections in `tools/instructions/`.

**What is installed from it:**

| Installed copy | Used by | Made by |
|---|---|---|
| `~/.claude/skills/<skill>/` (nine folders) | Claude Code, in every session and repository | `sync.py install`, copied file for file |
| `~/.agents/skills/<skill>/SKILL.md` | Codex (skill root `r1` in its session logs) | `sync.py install`, generated: same name and description, the canonical path, no rules |
| "## Jole BTX Prospecting" section of `~/.claude/CLAUDE.md` | Claude Code | `sync.py install`, from `tools/instructions/claude-section.md` |
| The same section of `~/AGENTS.md` and `~/.codex/AGENTS.md` | Codex | `sync.py install`, from `tools/instructions/codex-section.md` |
| `~/.claude/skills/jolesbtxicpskill/.jole-install.json` | `sync.py status` | `sync.py install`: repo, ref and commit installed |

The skills are not kept in the repository's `.claude/skills/`: project skills there would load only inside that repository, and twice beside the personal copies.

**Commands** (from `~/.claude/skills/jolesbtxicpskill/`):

| Command | Does |
|---|---|
| `python tools/sync.py status` | Compares every installed file, pointer and instruction section with the installed commit. Prints IN SYNC or each drifted item; exit 1 on drift. Notes when the installed ref has moved. |
| `python tools/sync.py status --ref origin/main` | Compares with another ref instead, for example before re-pointing at `main` |
| `python tools/sync.py install --ref <ref>` | Installs that commit, backs up the current copies to `~/.claude/backups/jole-skills/<time>/`, regenerates the pointers and instruction sections, records the commit. Refuses while the installation has edits that are not in the installed commit, unless `--replace-local-edits`. |
| `python tools/sync.py export --to <worktree>/docs/jole-skills` | Copies the installed skills into a repository folder so an edit can be committed |

`sync.py` only reads git (`rev-parse`, `ls-tree`, `cat-file`). It never commits, pushes, checks out, fetches, prunes or touches worktrees. `tests/run_all.py` ends with `sync.py status` and fails on drift; `--allow-drift` reports drift without failing, for use mid-edit.

**Changing a skill:**
1. Edit the owning SKILL.md in `~/.claude/skills/`, never a copy. If a shared rule changes, edit the shared policy instead, with the user's approval.
2. Bump the version, add a change-log line, update that skill's `tests/` and this page's version table.
3. Run `python tests/run_all.py --allow-drift` until the tests pass.
4. Create a temporary worktree on a docs branch (by path, outside the main checkout), run `sync.py export --to <worktree>/docs/jole-skills`, check that only `docs/` changed, run the tests inside the worktree, and commit.
5. Remove that worktree by its path only. Never run `git worktree prune` in SalesPipeline2.
6. Run `python tools/sync.py install --ref <branch>`: the files are already identical, so this records the commit and regenerates the pointers and instruction sections. Then `run_all.py` must pass without `--allow-drift`.

## Integration into main

The skills are on two stacked local branches, neither pushed:

| Branch | Commits on top of `origin/main` (`e65587d`) | Content |
|---|---|---|
| `docs/jole-icp-skill-v3-20261102` | 3 | Snapshot of the 3.0.0 skill, under `docs/jole-icp-skill/` |
| `docs/jole-qualification-skills-20261103` | the 3 above, plus the 4.0.0 and 4.1.0 commits | Removes `docs/jole-icp-skill/`, adds `docs/jole-skills/` |

The top branch contains the v3 branch, so only the top branch is integrated. Relative to `origin/main` it changes files under `docs/` only. Local `main` is stale (`7a71626`, September 29); always compare with `origin/main`.

**Why it cannot deploy:** Railway builds the watch branch `fix/send-throughput-20261020`, and the named production branch is `cursor/staffing-agent-shadow-production-7402` (`CURRENT_PRODUCTION_BASELINE.md` on `origin/main`). Merging into `main` deploys nothing. The repository has no GitHub Actions or other CI. A pushed `docs/` branch triggers nothing.

**Procedure**, from `C:\Users\deins\OneDrive\SalesPipeline2`, leaving the main checkout and every other worktree alone:
1. `git ls-remote origin main fix/send-throughput-20261020` and compare with the last known heads. If `main` moved, re-check that `git diff --name-only <new main>...docs/jole-qualification-skills-20261103` lists only `docs/` paths.
2. `git push origin docs/jole-qualification-skills-20261103`. This pushes a docs branch only, never `main` or a production branch.
3. Open a pull request into `main` (`gh pr create --base main --head docs/jole-qualification-skills-20261103`), or merge in a temporary worktree created from `origin/main`: `git merge --no-ff docs/jole-qualification-skills-20261103`, then `git push origin HEAD:main`. Remove that worktree by path.
4. Never merge `main` into `fix/send-throughput-20261020` or `cursor/staffing-agent-shadow-production-7402`, and never push to either for this change.
5. `git fetch origin main`, then `python tools/sync.py status --ref origin/main` must print IN SYNC.
6. `python tools/sync.py install --ref origin/main` re-points the installation at `main`. `run_all.py` must then pass.
7. Optional, after the merge: delete the two local docs branches with `git branch -d` (safe delete only).

## Tests

| Command (from `~/.claude/skills/`) | Checks |
|---|---|
| `python jolesbtxicpskill/tests/run_all.py` | Everything below, then the installation check |
| `python jolesbtxicpskill/tests/test_policy.py` | Shared clauses, lists and labels in sync, no list copies, versions match this page, frontmatter, routing descriptions and the table above, priority never deciding anything else, Codex pointers, instruction files, the sync tool, the 38-company regression |
| `python jolesbtxicpskill/tests/test_freshness.py` | Section 7 table against the code, the 30-day production rule, window boundaries, age never changing a label, signal status following event dates |
| `python jole-icp-qualification/tests/test_icp.py` | ICP fixtures and independence |
| `python jole-buying-signals/tests/test_signals.py` | Signal status, demand score, anchors |
| `python jole-buyer-identification/tests/test_buyer.py` | Site gate, roles, statuses |
| `python jole-site-labor-feasibility/tests/test_feasibility.py` | Agreements, defense, triggers |
| `python jole-dedupe-suppression/tests/test_dedupe.py` | Matching, precedence, live versus mirror |
| `python jole-contact-deliverability/tests/test_contact.py` | Proofpoint, verification, rejects |
| `python jole-outreach-readiness/tests/test_readiness.py` | Approaches, 30-day rules, gates |
| `python jole-qualification-orchestrator/tests/test_orchestrator.py` | Routing, stops, reuse and re-verification, conflicts, worked examples A to F |
| `python jolesbtxicpskill/tests/cold_session/run_cold.py` | Fresh sessions: each prompt must load exactly the skills it needs and give the expected decisions (costs real model usage) |

**Regression material.** The 38 companies of November 2026 live in `tests/regression_38.json`. It holds the facts each specialist needs, the expected decisions, and the v3 decision. When a decision differs from v3, the file must carry a documented `change_reason`; the test fails only if the reason is missing or the decisions drift from the facts. Historical scores are not ground truth.
