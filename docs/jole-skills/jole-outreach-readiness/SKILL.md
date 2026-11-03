---
name: jole-outreach-readiness
description: Jole BTX message fit and outreach readiness (v1.1.0). Decides whether a contact can be approached with accurate, evidence-supported, approved messaging - chooses the campaign approach (hiring trigger, project or contract award, expansion or production growth, turnaround or maintenance, general industrial workforce), checks every claim against verified, fresh evidence and the approved V5 modes, and checks company, buyer, contact and suppression prerequisites. Returns READY FOR APPROVED SEQUENCE, COPY / SIGNAL REVIEW REQUIRED, CONTACT VERIFICATION REQUIRED, HOLD or EXCLUDED; load it directly, without the orchestrator, when copy or readiness is the only question, for one contact or a wave. Cannot authorize import or sending. Requires the jolesbtxicpskill shared policy.
version: 1.1.0
---

# Jole outreach readiness and message fit

**Question: can this contact be approached using accurate, evidence-supported messaging?**

Version 1.1.0, 2026-11-03. Load the shared policy first (skill `jolesbtxicpskill`). Do not modify or activate V5.

## Use it when

- Preparing a contact wave.
- Choosing a campaign approach for contacts that already have results from the other skills.
- Checking whether a planned opener is truthful.

**This skill cannot authorize sending or importing contacts on its own.** READY means a person may review the contact for that sequence. Import, classification entries, queueing and sending each need the user's explicit instruction.

## Inputs

- **Required:** the subject's results from `jole-icp-qualification`, `jole-dedupe-suppression`, `jole-buyer-identification` and `jole-contact-deliverability`, with versions and dates; the intended approach.
- **Optional:** `jole-buying-signals` evidence (required for approaches 1 to 4); a `jole-site-labor-feasibility` result if one was triggered; the list's sourcing basis (signal-based or general).

Use the recorded results. Do not redo their research; if one is missing or stale, the answer is the gate it blocks.

## Campaign approaches

Do not require a job posting for project-based or general-workforce prospecting.

| # | Approach | The claim it makes | Evidence it needs | Approved sequence today |
|---|---|---|---|---|
| 1 | Hiring trigger | "Saw {company} is hiring {role} [in {site}]" | A verified posting for a Jole craft. Role, and site for `exact`. Evidence last checked within 30 days. | V5 `exact` or `role_only` |
| 2 | Project or contract award | Names the award or project | VERIFIED CURRENT or VERIFIED FUTURE signal with a craft link, confirmed within 30 days when Touch 1 renders | None |
| 3 | Expansion or production growth | Names the expansion or growth | Same as approach 2 | None |
| 4 | Turnaround or maintenance | Names the outage or turnaround | Same as approach 2, with dates | None |
| 5 | General industrial workforce | No trigger claim | ICP fit only | V5 `general_craft`, subject to the list rule below |

**V5 facts (production, read-only; check them again before relying on them):**
- `integrations/clients/jole-personalization.js` defines the modes `exact`, `role_only`, `general_craft` and `hold`.
- `exact` and `role_only` claim current hiring. Their evidence must have been checked within 30 days when Touch 1 renders (`FRESHNESS_DAYS = 30`). Older evidence falls to `general_craft`, which claims no current opening.
- A lead with no classification entry resolves to `hold`, so every new lead needs a reviewed classification entry. That is a production data change and needs separate authorization.
- `campaigns.js` also declares `maxEvidenceAgeDays: 45`. The 30-day check governs v4 and v5.

**Rules:**
- **Claims in copy have the tightest freshness** (shared policy section 7): every factual claim about hiring, a project, an expansion or a turnaround must rest on evidence confirmed at its source within 30 days when Touch 1 renders. Only the hiring rule is enforced by production code; the others are Jole guidance. Opportunity priority never makes a claim acceptable or a contact ready.
- Existing V5 hiring copy is used only where its hiring claim is actually supported. A signal-based company without a verified hiring role must not use a hiring-based V5 variant.
- Do not invent a role, project, hiring requirement or labor shortage. Every claim in copy cites the evidence it rests on.
- `general_craft` is not an approved signal-aware variant. Using it for a signal-sourced list needs the user's separate authorization; without it, such leads are COPY / SIGNAL REVIEW REQUIRED.
- Approaches 2 to 4 have no approved copy. A new signal-aware variant needs its own authorization and Jorge's approval of the messaging.

## Decisions

Report the first that applies:

| Label | Rule |
|---|---|
| EXCLUDED | ICP EXCLUDED, dedupe PROHIBITED, or feasibility BLOCKED BY VERIFIED REQUIREMENT for the work being pitched |
| HOLD | Dedupe SUPPRESSED, EXISTING CONTACT already in a sequence or held, or FAMILY MATCH — REVIEW; ICP CONDITIONAL or a credit hold; feasibility UNKNOWN, or FEASIBLE WITH CONDITIONS with a condition still open; contact HOLD |
| CONTACT VERIFICATION REQUIRED | No BUYER VERIFIED contact, or the contact is not CONTACT ACCEPTED FOR REVIEW (including REJECT, where another contact is needed) |
| COPY / SIGNAL REVIEW REQUIRED | The approach's claim is not supported by verified evidence at the required freshness, or no approved sequence exists for the approach or list |
| READY FOR APPROVED SEQUENCE | Every prerequisite is met, and an approved sequence exists whose claims the evidence supports |

**Confidence:** HIGH when every input is current and verified; MEDIUM when an input is near the end of its freshness window; LOW when an input is a mirror or older record.

## Escalate to the user

- Any READY result, which needs human review and an import or classification decision.
- A group of strong leads waiting only on copy: the user decides whether a signal-aware variant should be written.
- Evidence that will expire before the planned send date.

## Output

Envelope from `jolesbtxicpskill/CONTRACT.md`, subject = the contact, plus:

```json
"details": {"approach": 1, "sequence": "v5_exact | v5_role_only | v5_general_craft | none",
  "claims": [{"claim": "hiring Pipe Welders in Lake Charles, LA", "evidence": "URL", "checked": "YYYY-MM-DD", "valid_until": "YYYY-MM-DD"}],
  "prerequisites": {"icp": "...", "dedupe": "...", "feasibility": "NOT EVALUATED", "buyer": "...", "contact": "..."},
  "blocking": "", "why_contact_is_relevant": "..."}
```

**`why_contact_is_relevant` for V5 hiring leads:**

> "{title} at {company}, based at the hiring site [({site note})]; {company} posted {role} at {site}; {n} craft postings in the last 30 days ({m} core-trade)."

For other approaches, state the buyer's role at the site and the verified signal in one sentence, with no claim the evidence does not support.

## V5 hiring-lane wave rules

These are copy rules, not ICP rules. They apply only to a wave destined for the V5 hiring modes.

- At least one live craft posting at a named US site, posted in the last 30 days, and re-opened to confirm it still accepts applications.
- A manufacturer needs at least one core-trade opening. Core trades and relevant craft roles are defined in `jole-buying-signals`.
- If the only evidence is one generic maintenance or mechanic posting, the company does not go into the V5 lane. A 10,001+ employee company with only one relevant posting goes to HOLD.
- **V5 Tier A:** 2 or more core-trade openings, or 3 or more relevant craft openings, in 30 days. **V5 Tier B:** 1 core-trade opening or thinner demand. This is `priority_tier` in the import schema, not the opportunity priority.

**Send order:**
- V5 Tier A before Tier B.
- Within a tier, non-catch-all EXACT-site contacts first.
- Lead with the non-fabrication sectors (Jorge named yards, refineries and pipelines first), then fabrication.
- Don't source more than a few weeks ahead of sending: evidence goes stale.

## Examples

| Case | Correct | Incorrect |
|---|---|---|
| Yard with a verified Navy award, no posting; plan is "Saw you're hiring…" | COPY / SIGNAL REVIEW REQUIRED | Hiring opener sent |
| LinkedIn Pipe Welder posting in Lake Charles, re-checked 12 days ago; buyer and email accepted | READY FOR APPROVED SEQUENCE (V5 `exact`), for human review | Imported or queued by this skill |
| Same posting last checked 40 days ago | COPY / SIGNAL REVIEW REQUIRED until it is re-checked | READY because 40 is under 45 |
| Expansion-sourced shop, general opener, no approval for this list | COPY / SIGNAL REVIEW REQUIRED | READY on `general_craft` |
| Proofpoint catch-all contact at a Priority A company | HOLD | READY because the signal is strong |
| Qualified company, buyer not found | CONTACT VERIFICATION REQUIRED | Failed ICP |

## Tests

`python tests/test_readiness.py` from this folder. `tests/readiness_logic.py` restates the mechanical rules; this file wins any disagreement.

## Change log

**1.1.0 (2026-11-03).** Claims in copy about a project, award, expansion or turnaround now need evidence confirmed within 30 days when Touch 1 renders, not 90, matching the hiring rule (shared policy section 7). Priority is stated as never deciding readiness. The description now says to load this skill directly for a copy-only question.

**1.0.0 (2026-11-03).** Split from jolesbtxicpskill 3.0.0, sections 6, 7, 12 (`why_contact_is_relevant`) and 14. Replaced the v3 readiness states with these five outcomes, added the five campaign approaches, and corrected the hiring freshness rule from 45 to 30 days to match `jole-personalization.js`.
