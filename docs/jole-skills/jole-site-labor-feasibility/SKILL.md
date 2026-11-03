---
name: jole-site-labor-feasibility
description: Jole BTX commercial-path check (v1.0.1). Decides whether Jole has a practical way to supply workers to a specific site, project or contract when a material question is raised - union representation, hiring halls, project labor agreements, Navy, defense, federal or nuclear requirements, clearances and site access, approved-vendor rules, new-owner onboarding, local-hire pledges, or an owner that buys craft labor through an EPC or prime. Returns FEASIBLE, FEASIBLE WITH CONDITIONS, UNKNOWN or BLOCKED BY VERIFIED REQUIREMENT. Use only when such a trigger exists; load it directly, without the orchestrator, when access is the only question. Requires the jolesbtxicpskill shared policy.
version: 1.0.1
---

# Jole site, labor and procurement feasibility

**Question: is there a practical commercial path for Jole to supply workers for this specific operation?**

Version 1.0.1, 2026-11-03. Load the shared policy first (skill `jolesbtxicpskill`).

## Use it only when a trigger exists

Invoke this skill when the facility, project or contract raises a material feasibility question:
- Union representation at the site, a hiring-hall model, or a project labor agreement.
- Federal, Navy, defense or nuclear work with a stated clearance, installation-access, citizenship or export, or qualification requirement.
- An approved-vendor or prequalification program, or a new owner whose vendor rules are unknown.
- An incentive-linked local-hire pledge or another term that may require direct employees.
- An owner that buys craft labor through an EPC, prime or managing contractor.
- A certification or site-access credential the work requires.

**Do not invoke it for general defense capability alone.** Record "per-contract checks apply at engagement" as a note and move on.

**Do not assume that a Navy contract is inaccessible.** Do not assume that a unionized facility is automatically inaccessible. But do not ignore verified restrictions. This skill never changes the ICP label or the priority.

## Inputs

- **Required:** company; the specific site, project or contract (the scope); the trigger and its source.
- **Optional:** agreement or contract text, contract numbers, ownership history, the signal's purchasing notes.

## Procedure

1. **Scope.** Name the operation being judged. A company can be blocked on one project and open elsewhere.
2. **Purchasing route.** Who buys craft labor for that work: the owner, an EPC or prime, or the contractor itself? Name the party when you can.
3. **Read the requirement at its source:** the agreement, contract, solicitation, vendor-program page, or a reliable report of it. Never decide on the word "union" or "defense" alone.
4. **Classify each requirement:**
   - **VERIFIED BLOCK:** binding terms that route the covered crafts through another channel and leave no supplier route.
   - **VERIFIED REQUIREMENT:** a requirement Jole must meet, for example installation access, a credential, vendor onboarding, or contractor rules at a union plant.
   - **POSSIBLE CHECK:** may apply per contract, not verified.
   - **TERMS UNKNOWN:** the trigger is verified but its terms were not found.
5. **Compare with Jole's capabilities** (shared policy section 1): published crafts, nationwide coverage, no listed certifications.
6. **Decide.** Name the clause or source, the covered scope, any exceptions, and who must confirm each condition (usually Jorge).
7. **Stop** once the label is set. Read full agreements (Level 3) only for a high-priority subject, or when the text decides between BLOCKED and FEASIBLE.

## Rules

**Labor agreements.**

| Situation | Decision |
|---|---|
| Hiring-hall employer, or a project labor agreement that binds suppliers and routes crafts through union referral, so Jole cannot supply its own workers | BLOCKED BY VERIFIED REQUIREMENT for covered work. Name the clause and the exceptions. |
| In-plant union, subcontracting terms unknown | UNKNOWN |
| In-plant union, outside contractors documented | FEASIBLE WITH CONDITIONS: confirm the contractor rules |

**Defense, federal and nuclear work.** Preserve these project-specific checks:
- security clearance;
- installation access;
- citizenship or export rules;
- contract-specific compliance, including nuclear quality programs;
- union or project labor agreements;
- approved-vendor requirements and procurement restrictions.

Record them per contract. A check that only "may" apply is a note and leaves the decision FEASIBLE. A verified requirement gives FEASIBLE WITH CONDITIONS. Only a verified barrier gives BLOCKED.

**Other terms.**
- An incentive-linked local-hire pledge is a condition or an UNKNOWN until its terms show whether contract labor is compatible.
- A new owner's vendor onboarding is a condition to confirm.
- If an owner buys through an EPC or prime, the feasible route is that contractor. Record it, and tell `jole-buyer-identification` where the buyer probably sits.

**Certifications.** If the work requires certified welders or a quality program, that is a condition for Jole to confirm. Never claim a certification Jole has not listed.

This is a commercial reading, not legal advice.

## Decisions

| Label | Rule |
|---|---|
| FEASIBLE | The trigger was checked and nothing restricts outside craft labor for this scope. Possible per-contract checks may be listed as notes. |
| FEASIBLE WITH CONDITIONS | At least one verified requirement that Jole can plausibly meet but must confirm. Name each, and who confirms it. |
| UNKNOWN | A verified trigger whose terms were not found. Name the document or person that would settle it. |
| BLOCKED BY VERIFIED REQUIREMENT | Read terms close the route for an outside supplier on the covered work. Name the clause, the covered scope and any exceptions. |

BLOCKED stops all further work on the covered scope only. UNKNOWN and FEASIBLE WITH CONDITIONS hold outreach for that scope until they are resolved; they never exclude the company.

**Confidence:** HIGH when the decision rests on agreement or contract text; MEDIUM on a reliable secondary report; LOW on an indirect sign, such as a security-officer posting.

## Escalate to the user

- Any BLOCKED decision, since it stops work on that scope.
- A condition only Jole can answer, such as willingness to sign an agreement, clearances or certifications.
- Conflicting sources on whether an agreement is still in force.

## Output

Envelope from `jolesbtxicpskill/CONTRACT.md`, plus:

```json
"details": {"scope": "Faircrest plant 2027 shutdown", "triggers": ["union_in_plant"],
  "purchasing_route": "owner | via EPC: <name> | via prime: <name> | unknown",
  "requirements": [{"what": "...", "kind": "VERIFIED BLOCK | VERIFIED REQUIREMENT | POSSIBLE CHECK | TERMS UNKNOWN", "source": "...", "who_confirms": "Jorge"}],
  "blocked": {"clause": "", "covered_work": "", "exceptions": ""}, "notes": []}
```

## Examples

| Case | Correct | Incorrect |
|---|---|---|
| TVA project agreement: every contractor and on-site subcontractor signs (specialty work and subcontracts of $100,000 or less excepted), Council is exclusive representative, crafts by union referral, "any source" hiring only after 48 hours | BLOCKED BY VERIFIED REQUIREMENT for covered work, naming Articles I and III | "Union, so out" without reading, or "defense-capable, so in" |
| USW plant where management says shutdowns use outside contractors (Metallus) | FEASIBLE WITH CONDITIONS: confirm whether non-approved contractors can supply shutdown crafts | Blocked for the union, or ignored |
| About 70% USW, agreement terms not found (Atalco) | UNKNOWN: read the subcontracting article | Blocked |
| New owner Centrus and nuclear-grade work (Westerman) | UNKNOWN: vendor onboarding and qualification rules | Ignored, or blocked |
| Navy repair yard with no clearance requirement found (East Coast Repair) | FEASIBLE; note per-availability base-access and citizenship checks | Blocked for Navy work, or assumed cleared for every contract |
| Local-hire pledge tied to incentives (Hyundai Translead) | UNKNOWN: confirm contract labor is compatible | Excluded at ICP |
| Facility Security Officer posted for the site (Fairbanks Morse Defense) | UNKNOWN: confirm clearance needs for craft work | Blocked on an indirect sign |

## Tests

`python tests/test_feasibility.py` from this folder. `tests/feasibility_logic.py` restates the mechanical rules; this file wins any disagreement.

## Change log

**1.0.1 (2026-11-03).** The description now says to load this skill directly for an access-only question.

**1.0.0 (2026-11-03).** Split from jolesbtxicpskill 3.0.0, section 3 ("Labor agreements and restricted work") and the compliance gate of section 6. A binding agreement is now BLOCKED BY VERIFIED REQUIREMENT here, not an ICP exclusion, so fit and access are recorded separately.
