---
name: jole-buyer-identification
description: Jole BTX buyer selection (v1.1.0). Identifies who is the most relevant person to approach about additional skilled labor at a qualified company - yard or plant GM, operations, project, construction, turnaround, maintenance or fabrication leaders, owners at small firms, procurement where supplier approval is required, HR for permanent hires - tied to the actual facility or project. Applies the site-connection rule, returns BUYER VERIFIED, BUYER PARTIAL, BUYER NOT SITE-CONNECTED or BUYER NOT IDENTIFIED, never invents a name and never spends Apollo credits. Load it directly, without the orchestrator, when the buyer is the only question. Requires the jolesbtxicpskill shared policy.
version: 1.1.0
---

# Jole buyer identification

**Question: who is the most relevant person to approach about additional skilled labor?**

Version 1.1.0, 2026-11-10. Load the shared policy first (skill `jolesbtxicpskill`). Apollo credit rules are in its section 8.

## Use it when

- A company is not EXCLUDED, PROHIBITED, SUPPRESSED or BLOCKED.
- The task needs a person: buyer research, enrichment planning, or a contact wave.

A company may remain ICP-qualified without a named buyer. This skill never changes the ICP label or the priority, and a verified buyer is not a verified contact (`jole-contact-deliverability` checks the email).

## Inputs

- **Required:** company, the facility or project in question, a company size band (1-1,000, 1,001+ or unknown).
- **Optional:** the signal (type, site), the purchasing route from feasibility (owner, EPC or prime), and prior buyer records such as `Jole_38_Buyer_Research_List.csv`.

## Procedure

1. **Decide the purchasing role before searching for names**, from the operating model and the signal (table below).
2. **Search free sources for that role at the site:**
   - Company leadership and news pages, and press releases naming site leaders.
   - Public LinkedIn profiles.
   - Apollo `apollo_mixed_people_api_search`, using `person_locations` as a site test.
   No reveals without an authorized cap.
   Before any reveal or import, re-confirm the current title and site with the free people search when the record is older than 30 days (shared policy section 7).
3. **Apply the site-connection gate** (below).
4. **Check authority and currency:** a dated source; current employment; a re-check after an acquisition.
5. **Pick a primary buyer.** Add a secondary only when it is justified by a different buyer role or a different site.
6. **Stop** when a BUYER VERIFIED primary exists, or when the free sources are exhausted; then record BUYER NOT IDENTIFIED with the target role. If the facility buyer is obvious, do not research unrelated corporate departments.

## Who buys, by operating model

Prioritize authority over seniority: the person who decides how a site's craft work gets staffed, not the most senior name.

| Operating model and signal | Primary buyer | Justified secondary |
|---|---|---|
| Shipyard or yard (backlog, award) | Shipyard General Manager, VP or Director of Operations, Production Manager | Craft Workforce Manager, or site HR for permanent hires |
| Plant or mill (expansion, production growth) | Plant Manager or site GM | Operations Director, Maintenance Manager |
| Plant turnaround, outage or shutdown | Turnaround or Outage Manager, Maintenance Manager | Plant Manager; procurement if approved vendors are required |
| Industrial contractor with a project or contract | Project Director, Construction Manager or Superintendent on that work | Craft Workforce Manager, regional Operations VP, subcontracts lead |
| Fabrication shop | Fabrication or Production Manager | Owner or GM |
| Smaller industrial business (up to about 200 staff) | Owner, CEO or President | Operations Manager |
| Supplier approval verified as required | Procurement or subcontracts leader for the site or region | The operating buyer above, still required |
| Permanent-hire need | Site HR or talent acquisition lead | The operating manager |

**Weak buyer roles (hold):** engineering managers with no workforce ownership, production supervisors, TA coordinators, and vague titles ("Manager", "Assistant Manager", "Plant Lead").

**Company heads at smaller companies.** At a company of 1 to 1,000 staff, with the size taken from a recorded source, the head of the company is a strong buyer role on title alone: the President, CEO, Owner, COO or the company's General Manager. Do not also require evidence that the title "manages operations", and read their authority as company-wide. Identity (a dated source within 12 months), current employment and the site gate still apply. This does not cover founder-only titles; Vice, Assistant or Deputy titles; division, regional or segment heads; or companies of 1,001+ or unknown size. When a company also has a site or operations leader who qualifies on their own role, keep that person as the primary.

## Site-connection gate

- **The gate applies to the buyer, never to the company.**
- For a company of 1,001+ employees or unknown size, the buyer must be at the operating site, within about 50 miles, or hold verified centralized authority over the site's labor. An unrelated corporate executive fails.
- For smaller companies, a company-level buyer passes.

**Site tie labels:**
- `EXACT`: at the site.
- `REGION`: within commuting distance. Name the relationship, e.g. "Lake Charles is adjacent to Westlake, LA".
- `STATE`: same state, different city. Acceptable only when the company is single-site or small and the contact is a company-level buyer, or when the title names the site. Review every STATE record by hand.
- `HQ-AUTHORITY`: at headquarters, acceptable only if the HQ is the plant or the authority is verified.

For very large multi-site employers (Parker, Emerson, Honeywell, Caterpillar, Trane, Dow, Bobcat and similar), work the relevant plant only. For Bobcat, use manufacturing sites, not dealers.

**Hold these people:**
- Remote executives, such as PE-owner CEOs in another state.
- Anyone at the wrong site, or too far from it.
- Possible job changes: check employment history, and remove anyone who has retired or left.
- After an acquisition, re-check authority.

**How many:** 1 contact by default; a 2nd for high-value companies; a 3rd only for large multi-site companies. Extra contacts must be at a different site or in a different buyer role.

## Decisions

| Status | Rule |
|---|---|
| BUYER VERIFIED | Name, title and employer confirmed by a dated public or company source; the role has purchasing authority for this site; passes the site gate |
| BUYER PARTIAL | Old, undated or Apollo-only evidence, unclear authority, or a weak role. An Apollo preview alone is BUYER PARTIAL at best. |
| BUYER NOT SITE-CONNECTED | A candidate exists but fails the site gate |
| BUYER NOT IDENTIFIED | No usable candidate yet. Record the target role. |

**Do not invent a named buyer.** If only the role is known, leave the name empty. Never fill a gap with a pattern-built email or a guessed person.

**Confidence:** HIGH for a company or press source within 12 months plus a site tie; MEDIUM for a public profile only; LOW for an Apollo preview or an undated source.

## Escalate to the user

- Only a corporate executive can be found at a 1,001+ company.
- The real buyer sits at an EPC or prime that is not yet named.
- An acquisition changed who decides.
- Reaching a buyer would require Apollo reveals: ask for a cap first.

## Import mapping

`buyer_type` uses the approved-corpus values in `jolesbtxicpskill/reference.md`:
- Plant, yard, operations, production and fabrication leaders: `Plant / operations / production`.
- HR and TA: `HR / talent acquisition`.
- Maintenance, reliability, turnaround and outage: `Maintenance / reliability`.
- Owners and executives: `Owner / executive`.
- Superintendents, project directors, construction managers and craft workforce managers: `Superintendent / site leadership`.
- Procurement and subcontracts: `Procurement / subcontracts`.

## Output

Envelope from `jolesbtxicpskill/CONTRACT.md`, decision = the primary buyer's status, plus:

```json
"details": {"size_band": "1-1,000 | 1,001+ | unknown", "target_role": "Yard General Manager",
  "primary": {"name": null, "title": null, "site": "City, ST", "site_tie": "EXACT | REGION | STATE | HQ-AUTHORITY",
    "purchasing_role": "decides craft staffing for the yard", "evidence": "source and date", "status": "BUYER NOT IDENTIFIED", "buyer_type": "..."},
  "secondary": null, "rejected_candidates": [{"title": "CFO, HQ", "why": "fails site gate"}]}
```

## Examples

| Case | Correct | Incorrect |
|---|---|---|
| 5,000-employee company, plant in Tennessee; only the CFO at an out-of-state HQ found | BUYER NOT SITE-CONNECTED; ICP unchanged | Contacting the CFO, or failing the company |
| 40-person fabrication shop; owner confirmed on the company site | BUYER VERIFIED (company-level buyer passes) | Rejected for not being at "the site" |
| 600-person manufacturer; "President" listed on the live leadership page, nothing more about duties | BUYER VERIFIED (company head at a company of 1,000 or fewer staff) | BUYER PARTIAL because the title does not describe managing operations |
| 5,000-person company; President named in a 2026 release, no tie to the plant | BUYER NOT SITE-CONNECTED (the company-head rule stops at 1,000 staff) | BUYER VERIFIED as a company head |
| Large shipyard with a verified contract; Operations Manager named in a 2026 press release at the yard | BUYER VERIFIED; contact verification is separate | Treating the buyer as a ready contact |
| Strong demand, nobody found yet | BUYER NOT IDENTIFIED, target role recorded | A guessed name |
| Apollo preview shows "Plant Manager" with a masked surname | BUYER PARTIAL | BUYER VERIFIED |

## Tests

`python tests/test_buyer.py` from this folder. `tests/buyer_logic.py` restates the mechanical rules; this file wins any disagreement.

## Change log

**1.1.0 (2026-11-10).** Approved by the user. Company heads (President, CEO, Owner, COO, company General Manager) at companies of 1 to 1,000 staff, with a recorded size source, are strong buyer roles on title alone, with company-wide authority. *Why:* on 2026-11-10 Jev-scored verification failed real heads of 40- to 600-person firms only because a bare "President" or "CEO" does not describe managing operations. Identity, freshness and the site gate are unchanged. *Effect that day:* 16 more companies with a verified buyer across the 82, 38 and 156 lists.

**1.0.1 (2026-11-03).** The description now says to load this skill directly for a buyer-only question. Added the shared 30-day re-confirmation before any reveal or import.

**1.0.0 (2026-11-03).** Split from jolesbtxicpskill 3.0.0, section 8. Added role selection by operating model and signal; turnaround, project, construction, fabrication, craft-workforce and procurement roles; `HQ-AUTHORITY` tie; the `Procurement / subcontracts` buyer type. Status labels renamed with a BUYER prefix, and NOT FOUND became BUYER NOT IDENTIFIED.
