---
name: jole-qualification-orchestrator
description: Jole BTX qualification orchestrator (v1.1.0). Plans and runs Jole prospect work that needs answers from two or more specialist skills - list screens with dedupe and fit, signal-based shortlists, requalification, enrichment planning, contact or wave QC, campaign readiness - choosing only the specialists the task needs, in cost order, reusing prior findings, stopping when more research would not change the decision, and consolidating every dimension separately with one next action per subject. Not for a single qualification question, even over a long list of companies; load that question's specialist directly. Requires the jolesbtxicpskill shared policy.
version: 1.1.0
---

# Jole qualification orchestrator

**Job: run the fewest specialist skills that answer the task, in a cost-effective order, and report each dimension separately with one next useful action.**

Version 1.1.0, 2026-11-03. Load the shared policy first (skill `jolesbtxicpskill`): its labels, stops and next-action precedence (section 4) are what this skill applies. This skill does not redo specialist research and owns no qualification rule of its own.

## 1. Understand the task

**Scope.** Use this skill only when the task needs answers from two or more specialists, a next action per subject, or a plan for sourcing, requalification or a contact wave. One question, even over a long list, goes straight to the specialist that owns it (shared policy, "How to use"). If this skill was loaded for such a task, apply only that specialist.

Identify the task type. If it is unclear, pick the narrowest type that fits and say which you picked.

| Task | Run, in this order | Not run |
|---|---|---|
| Company discovery or a list screen | dedupe (account) → ICP | Signals, buyer, feasibility, contact, readiness |
| Signal-based shortlist | dedupe (account) → ICP → signals; feasibility only if a trigger affects the shortlist | Buyer, contact, readiness |
| Requalify or prioritize existing companies | ICP → signals → feasibility (triggers only); dedupe if older than its reuse window | Contact, readiness |
| Buyer research | buyer, on companies that are not stopped, in priority order | Contact, readiness |
| Enrichment planning (no credits) | buyer → dedupe (contact) → a plan with the credit estimate | Any paid call |
| Contact or wave QC | dedupe (contact) → contact deliverability → readiness | Signal research beyond freshness checks |
| Campaign or copy readiness | readiness, using recorded results | Re-running upstream skills that are still fresh |
| One question for any number of subjects ("is each of these a fit?", "who is the buyer?") | Not this skill: the owning specialist, loaded directly | This skill and every other specialist |

**Do not run all seven skills on every lead.** Specialist names: `jole-icp-qualification`, `jole-buying-signals`, `jole-buyer-identification`, `jole-site-labor-feasibility`, `jole-dedupe-suppression`, `jole-contact-deliverability`, `jole-outreach-readiness`.

## 2. Reuse before research

For each subject, collect earlier outputs: files the user names, `reference.md` locations, and this session's results.
- Reuse any output still inside its window for the task's use (shared policy section 7), citing its skill, version and date. Planning and ranking tasks use the research window; contact or wave QC and readiness use the window before spend, import or queue.
- Re-run a skill when its output is missing, past its window, or was made under an older major version.
- **A past-window result with no new research keeps its label.** Mark it `reverify` with what to re-confirm and before which use, and lower its confidence one step. Never turn it into NOT EVALUATED or a worse label because of its age. An older major version is not reusable; report NOT EVALUATED, "older major version".

## 3. Run, applying the stops

After each specialist, check the shared stops before spending more:
- **Account stops:** PROHIBITED, ICP EXCLUDED, company- or domain-level SUPPRESSED.
- **Scope stop:** BLOCKED BY VERIFIED REQUIREMENT, which stops only the covered work.
- **Contact stops:** contact REJECT, email-level SUPPRESSED, EXISTING CONTACT. Each stops that contact only.

**Skip rules:**
- **ICP CONDITIONAL:** resolve the named gap before buyer or contact work, unless the user asked for that company specifically.
- **Credit hold:** no buyer or contact work.
- **No trigger:** do not run feasibility; report NOT EVALUATED, "no trigger".
- **No buyer or contact data:** do not run contact deliverability or readiness.

**Cost-saving rules:**
- If the company fails industrial ICP, stop expensive buyer research.
- If it is a known suppressed account, stop contact sourcing.
- If the user wants only company discovery, do not run email qualification.
- If a known industrial employer has no recent buying signal, do not automatically reject it.
- If a company has a verified operational trigger and an obvious facility buyer, avoid researching unrelated corporate departments.
- If contract labor is already documented, do not spend excessive time proving that the employer might use outside labor.
- If the user wants a signal-based shortlist, prioritize that signal without redefining the entire ICP.
- If a project labor agreement or hiring hall is already recorded, run feasibility before paying for signal research.

**Depth:** start every subject at Level 1. Go deeper only for subjects whose next action is worth it: higher priority first, and only when the open question could change a decision. Stop when additional research would not materially change the decision, and name the open question instead.

## 4. Consolidate without merging

- Keep each specialist's decision, confidence, skill and version, and date as it was given. Never rewrite one to agree with another.
- A dimension that was not run is **NOT EVALUATED**, with the reason (task scope, a stop, no trigger, no contact).
- **Conflicts:** when specialists disagree, record both, apply the precedence, and explain it in one line. Example: ICP QUALIFIED from the name check, dedupe PROHIBITED from a subsidiary link. Result: STOP, conflict noted, ICP left as recorded.
- **Next action:** the first that applies, in shared-policy order.

| Next action | When |
|---|---|
| STOP | PROHIBITED, ICP EXCLUDED, account-level SUPPRESSED, or BLOCKED for the scope pitched |
| HOLD | A policy hold applies: credit hold (early-stage, not reopened), contact HOLD, an existing contact already in sequence |
| REVIEW | A human decision is needed: FAMILY MATCH — REVIEW, EXISTING ACCOUNT — NEW OPPORTUNITY, a mixed contractor's competition call, or FEASIBLE WITH CONDITIONS to confirm with Jorge |
| RESEARCH FIT | ICP CONDITIONAL with a research gap (operations, crafts at the site, US site) |
| RESEARCH FEASIBILITY | Feasibility UNKNOWN on a verified trigger |
| RESEARCH SIGNAL | The task needs a signal (shortlist, priority) and none is recorded, or the recorded one is CONTRADICTORY / STALE. An old check on a live signal goes under `reverify` instead. |
| RESEARCH BUYER | Not BUYER VERIFIED |
| SOURCE CONTACT | BUYER VERIFIED with no usable contact data, or a rejected contact. Apollo reveals need a user cap. |
| VERIFY CONTACT | Contact ADDITIONAL VERIFICATION REQUIRED |
| COPY REVIEW | Readiness COPY / SIGNAL REVIEW REQUIRED |
| HUMAN REVIEW | Readiness READY FOR APPROVED SEQUENCE. A person decides; nothing is imported or sent by this skill. |

A NURTURE / RESEARCH priority does not stop buyer research with free tools. Priority sets the order, not eligibility.

## 5. Output

**One consolidated record per subject.** Schema: `jolesbtxicpskill/CONTRACT.md`, section "Consolidated record". Contact waves also produce the QC files, statuses and reason codes in `jolesbtxicpskill/reference.md`, under "Contact-wave QC files". For new sourcing, start from "Where the next wave should look first" in the same file. For batches, a CSV with the consolidated columns, plus:
- counts per label for each dimension;
- subjects stopped, and why;
- research effort and Apollo credits (0 unless authorized), checked against the balance if Apollo was used;
- a confirmation that nothing was imported, queued or sent.

Every subject's record answers, briefly: what we know, what it implies, what remains uncertain, whether more research is worth it, and what happens next.

## 6. Worked examples

| Case | Skills run | Result |
|---|---|---|
| A. Legitimate shipyard, active fabrication, no recent public award | dedupe, ICP, signals | ICP QUALIFIED; NO VERIFIED SIGNAL, NURTURE / RESEARCH; buyer NOT EVALUATED; next RESEARCH BUYER |
| B. Large shipyard, verified contract, operations manager at the yard named in a dated release | dedupe, ICP, signals, buyer | ICP QUALIFIED; VERIFIED CURRENT SIGNAL; BUYER VERIFIED; contact NOT EVALUATED; next SOURCE CONTACT, needing an Apollo cap |
| C. Staffing company advertising welders | dedupe, ICP | ICP EXCLUDED (labor seller), whatever its demand; next STOP |
| D. Relevant employer, Proofpoint catch-all contact | contact QC chain | ICP QUALIFIED (unchanged); contact HOLD; readiness HOLD; next HOLD |
| E. Relevant company, project starting in six months | dedupe, ICP, signals | ICP QUALIFIED; VERIFIED FUTURE SIGNAL; lower priority; next RESEARCH BUYER |
| F. Industrial contractor providing mechanical services to plant owners | dedupe, ICP | ICP QUALIFIED as a purchaser of skilled labor; labor-supply overlap checked separately (NONE FOUND); next RESEARCH BUYER |
| Utility under a binding project labor agreement (TVA) | ICP, feasibility | ICP QUALIFIED on fit; feasibility BLOCKED for covered work; next STOP |

## Tests

`python tests/test_orchestrator.py` from this folder: routing, stops, reuse, conflicts and the worked examples, run through every specialist's reference logic. `python ../jolesbtxicpskill/tests/run_all.py` runs all Jole tests. The tests exist to maintain these files. Do not open, search for or run them to decide any company, real or fictional; decide from the SKILL.md files.

## Change log

**1.1.0 (2026-11-03).** Scope narrowed: a single question, even over a list, goes to its specialist, not here. Reuse windows now come from the shared freshness table by use, and a past-window result with no new research keeps its label with `reverify` and lower confidence instead of becoming NOT EVALUATED.

**1.0.0 (2026-11-03).** New. Replaces the single-pass flow of jolesbtxicpskill 3.0.0, where every company went through eligibility, score and readiness together.
