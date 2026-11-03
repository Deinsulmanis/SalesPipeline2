# Jole qualification skills: architecture and index

Part of shared policy 4.0.0 (2026-11-03). This page maps the eight Jole skills: what each answers, when it runs, what it depends on, and how a session finds them. The rules themselves are in the SKILL.md files.

## Skills and versions

| Skill | Version | Answers | Folder |
|---|---|---|---|
| `jolesbtxicpskill` | 4.0.0 | Shared policy: capabilities, hard exclusions, safety, labels, precedence, evidence standard | `~/.claude/skills/jolesbtxicpskill/` |
| `jole-icp-qualification` | 1.0.0 | Can Jole realistically provide industrial skilled labor to this company? | `~/.claude/skills/jole-icp-qualification/` |
| `jole-buying-signals` | 1.0.0 | What evidence suggests the employer may need more skilled workers, and when? | `~/.claude/skills/jole-buying-signals/` |
| `jole-buyer-identification` | 1.0.0 | Who is the most relevant person to approach? | `~/.claude/skills/jole-buyer-identification/` |
| `jole-site-labor-feasibility` | 1.0.0 | Is there a practical commercial path to supply workers to this operation? | `~/.claude/skills/jole-site-labor-feasibility/` |
| `jole-dedupe-suppression` | 1.0.0 | Is this account or contact net-new and allowed? | `~/.claude/skills/jole-dedupe-suppression/` |
| `jole-contact-deliverability` | 1.0.0 | Is the recipient's email suitable for outbound? | `~/.claude/skills/jole-contact-deliverability/` |
| `jole-outreach-readiness` | 1.0.0 | Can this contact be approached with accurate, approved messaging? | `~/.claude/skills/jole-outreach-readiness/` |
| `jole-qualification-orchestrator` | 1.0.0 | Which of the above does this task need, in what order, and what happens next? | `~/.claude/skills/jole-qualification-orchestrator/` |

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
                         orchestrator: chooses, orders, reuses, stops, consolidates
```

- Specialists never call each other. Each reads the shared policy and its inputs, and writes one envelope (CONTRACT.md).
- Readiness reads the others' recorded results and does not repeat their research.
- Feasibility runs only when another skill records a trigger (union, labor agreement, clearance, nuclear, new owner, local-hire pledge, EPC or prime purchasing, required certification).

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
- Opportunity priority uses demand only. Buyer, feasibility, contact and copy are separate dimensions.

## Output contracts

See [CONTRACT.md](CONTRACT.md). In short: one envelope per skill per subject, with ten mandatory fields, plus skill-specific `details`; one consolidated record per subject from the orchestrator; one batch CSV schema.

## How sessions find the skills

- **Claude Code:** personal skills in `~/.claude/skills/` load in every session and every repository branch. The skill listing shows each name and description, and the descriptions are written so a task's wording selects its owner. The `~/.claude/CLAUDE.md` section "Jole BTX Prospecting" names the shared policy and the orchestrator. Each specialist tells the session to load the shared policy first.
- **Codex:** `~/.agents/skills/` is one of Codex's skill roots (its session logs list it as `r1`). Each Jole skill has a pointer there with the same name and description; the pointer only says to read the canonical file. `~/AGENTS.md` and `~/.codex/AGENTS.md` carry the same section. A Codex runtime test has not been run on this machine, because no Codex CLI is installed (only the desktop app).
- **Fresh-session check:** `tests/cold_session/` holds eight prompts (one per skill) and a checker. A run must not read any `tests/` folder. Move them aside first; `tests/cold_session/run_cold.py` does this and restores them.

## Invocation examples

| You ask | Skills that should load |
|---|---|
| "Is Bayou Hull Works a fit for Jole?" | `jolesbtxicpskill`, `jole-icp-qualification` |
| "Which of these 200 companies should Jole look at?" | `jolesbtxicpskill`, `jole-qualification-orchestrator`, then dedupe and ICP |
| "Build a signal-based shortlist of Gulf yards" | orchestrator, then dedupe, ICP and signals |
| "What does this expansion news mean for demand at X?" | `jole-buying-signals` |
| "Who should Jorge contact at X's Odessa plant?" | `jole-buyer-identification` |
| "X's plant has a project labor agreement. Can Jole work there?" | `jole-site-labor-feasibility` |
| "Is X already in the CRM or suppressed?" | `jole-dedupe-suppression` |
| "This email is on a pphosted.com catch-all. OK to send?" | `jole-contact-deliverability` |
| "Can we use the 'Saw you're hiring' opener for these contacts?" | `jole-outreach-readiness` |

Explicitly: `/jole-icp-qualification`, or "use the jole-buyer-identification skill".

## Tests

| Command (from `~/.claude/skills/`) | Checks |
|---|---|
| `python jolesbtxicpskill/tests/run_all.py` | Everything below |
| `python jolesbtxicpskill/tests/test_policy.py` | Shared clauses, lists and labels in sync, no list copies, versions match this page, frontmatter, Codex pointers, instruction files, the 38-company regression |
| `python jole-icp-qualification/tests/test_icp.py` | ICP fixtures and independence |
| `python jole-buying-signals/tests/test_signals.py` | Signal status, demand score, anchors |
| `python jole-buyer-identification/tests/test_buyer.py` | Site gate, roles, statuses |
| `python jole-site-labor-feasibility/tests/test_feasibility.py` | Agreements, defense, triggers |
| `python jole-dedupe-suppression/tests/test_dedupe.py` | Matching, precedence, live versus mirror |
| `python jole-contact-deliverability/tests/test_contact.py` | Proofpoint, verification, rejects |
| `python jole-outreach-readiness/tests/test_readiness.py` | Approaches, 30-day rule, gates |
| `python jole-qualification-orchestrator/tests/test_orchestrator.py` | Routing, stops, reuse, conflicts, worked examples A to F |

**Regression material.** The 38 companies of November 2026 live in `tests/regression_38.json`. It holds the facts each specialist needs, the expected decisions, and the v3 decision. When a decision differs from v3, the file must carry a documented `change_reason`; the test fails only if the reason is missing or the decisions drift from the facts. Historical scores are not ground truth.

## Changing a skill

1. Edit the owning SKILL.md, never a copy.
2. If a shared rule changes, edit the shared policy instead, with the user's approval.
3. Bump the version and add a change-log line.
4. Update the logic or fixtures under that skill's `tests/`, then run `run_all.py`.
5. Update this page's version table.
6. Refresh the repo snapshot under `docs/jole-skills/` on a docs-only branch.
