---
name: jole-icp-qualification
description: Jole BTX company-fit screen (v1.1.0). Decides whether Jole could realistically supply industrial skilled-trade labor to a company - industrial employer or eligible contractor versus staffing firm, real operations and Jole crafts at a US site, client and competitor exclusions. Returns QUALIFIED, CONDITIONAL or EXCLUDED. Use to qualify or requalify companies for Jole, or to answer "is this company a fit for Jole?"; load it directly, without the orchestrator, when fit is the only question, for one company or a list. It never judges demand, timing, buyers, union access, contacts or copy. Requires the jolesbtxicpskill shared policy.
version: 1.1.0
---

# Jole industrial ICP qualification

**Question: can Jole realistically provide industrial skilled labor to this company?**

Version 1.1.0, 2026-11-03. This is the first substantive gate for every Jole company. Load the shared policy first (skill `jolesbtxicpskill`, file `~/.claude/skills/jolesbtxicpskill/SKILL.md`). Its capabilities, crafts list, hard exclusions, evidence standard and labels apply here and are not repeated.

## Use it when

- Screening a sourced list or a single company.
- Requalifying companies after a policy change.
- Deciding whether a company deserves any further Jole work.

Do not use it for demand or timing (`jole-buying-signals`), buyers (`jole-buyer-identification`), unions, labor agreements or defense access (`jole-site-labor-feasibility`), CRM duplicates or suppression (`jole-dedupe-suppression`), emails (`jole-contact-deliverability`) or copy (`jole-outreach-readiness`).

## Inputs

- **Required:** company name, and its website or another way to read what it does.
- **Optional:** the site in question, a sector guess, how it was sourced, and earlier findings with their dates (reuse them inside the shared freshness windows).

## What this decision may and may not use

**Uses only:** business model, actual operations, Jole crafts at a US site, and the named lists.

**Do not require:** a recent job advertisement, a verified expansion, a contract award, an identified decision-maker, a current labor shortage, a 30-day requirement, proof the company previously purchased outside labor, or an arbitrary minimum employee count. Geography inside the US, aluminum work, Navy or defense work and union presence never lower this decision. Record union, labor-agreement, clearance, nuclear, new-owner and local-hire facts as feasibility triggers for the orchestrator, without judging them.

## Procedure

Level 1 by default. Stop at the first hard exclusion with evidence; otherwise stop once the label is set.

1. **Named lists.** Check the company and any parent you know against shared policy section 2, matching whole words. A match is EXCLUDED, citing the list. A possible family relation you cannot confirm goes to `jole-dedupe-suppression` as `family_check`; it does not change this label.
2. **Business model.** Read the service pages, not only the name.
3. **Actual operations.** Establish what the company does at a US site from its own operations, products, services, facility or careers pages, a filing, or a reliable news source. Keywords alone ("industrial solutions", "fabrication and maintenance") with no description of the work or a site are not operational evidence. That gives CONDITIONAL with the gap "actual operations", never QUALIFIED.
4. **Craft fit.** Map the operations to Jole's crafts:
   - **DIRECT:** the company's materials, postings or a reliable source show the craft at this site.
   - **PROCESS:** the verified operation at the site cannot run without the craft. Examples: ship construction or repair (ship fitters, welders); structural steel or plate fabrication (structural welders, fitters); tank, pressure-vessel, trailer or truck-body fabrication (welders, fabricators); refinery or chemical-plant maintenance and turnarounds (pipe fitters, pipe welders).
   - **UNCLEAR:** operations are verified, but the site's use of the craft is uncertain, for example assembly only, fabrication done elsewhere, or only technicians seen.
   - **NONE:** verified operations use no Jole craft (an insurer, a software firm, an equipment-service firm with no crafts of its own).
   If the only crafts are off Jole's published list, the label is CONDITIONAL with the gap "Jole to confirm the craft".
5. **US operating site.** An existing site, or an announced site of an operating company, counts. A pre-revenue developer is CONDITIONAL with a credit hold.

**Old evidence.** Fit facts may be reused for 12 months (shared policy section 7). Older fit evidence never changes the label and is never an exclusion. Keep the label, lower the confidence one step, and set `reverify` so it is re-checked at Level 1 before any spend. Only new evidence changes the label, for example a closure, a sale to a staffing firm, or the site no longer doing the work.
6. **Use case.** An employer with Jole crafts at a site has a credible use for permanent or contract skilled-trade workers. Whether it buys contract labor now is a demand question for `jole-buying-signals`. Missing proof of prior subcontract use is not a hard exclusion.

Go to Level 2 only when one check, usually craft fit at the site, would move CONDITIONAL to QUALIFIED or EXCLUDED and the company looks worth it.

## Sectors and manufacturers

**Sectors to source by default:**
1. Industrial fabrication / machinery
2. Metals / mining / paper / heavy industrial
3. Refining / petrochemical / LNG / chemical
4. Power / utilities
5. Shipyard / marine
6. Pipeline / midstream
7. Oil & gas producers / operators

**Manufacturers** count as industrial fabrication / machinery when they make machinery, industrial machinery, fabricated metal, metalworking, rail equipment, electrical equipment or oilfield equipment, or when their own description shows heavy fabrication (steel structures, tanks, pressure vessels, trailers, truck bodies, cranes, boilers, turbines, transformers). The company's work decides this, not its customers' sector.

**Outside default sourcing (expansion pool):** food, pharma/medical, consumer goods, packaging, plastics products, electronics/semiconductors, automotive, rail operators, battery/solar component makers, general aerospace, and recreational or consumer boat builders. Do not source these by default. Membership alone is not a verified disqualification: if one reaches you with Jole crafts at the site, assess it normally. Defense shipyards and contractors are not in this pool.

## Business model

| Company type | Decision | `labor_supply_overlap` |
|---|---|---|
| End employer using Jole crafts at its own site | Assess normally | NONE FOUND |
| Contractor purchasing extra skilled labor for its own work (construction, fabrication, plant maintenance, mechanical services) | Assess normally. Do not exclude it for serving plant owners. | NONE FOUND, after reading its service pages |
| Contractor with both self-performed projects and a workforce-supply business | CONDITIONAL. Review individually for actual buyer fit and competition. | MIXED |
| Staffing company or labor broker primarily reselling workers, recruiter, PEO, labor-service firm, or a named negative | EXCLUDED. It competes with Jole. | PRIMARY |
| Generic, professional, IT, healthcare or commercial staffing | EXCLUDED | PRIMARY |
| Equipment-service firm with no Jole crafts of its own | EXCLUDED | NONE FOUND |
| Cat or John Deere dealer, oilfield services, field-service-heavy company | CONDITIONAL with a credit hold: not reopened | as found |

Check every contractor for a workforce-supply line before treating it as a clean buyer. Pipeline contractors are assessed under the contractor rule.

## Decisions

- **QUALIFIED:** no hard exclusion; an eligible business model with no labor-supply line; operations verified; craft fit DIRECT or PROCESS for at least one craft on Jole's list; a US operating site.
- **CONDITIONAL:** no hard exclusion, but a named evidence gap: operations not verified, craft fit UNCLEAR or off-list only, a mixed contractor, US site unknown, a not-reopened category or a hold category. Always name the gap and the cheapest check that would close it.
- **EXCLUDED:** a proven disqualification from shared policy section 2, with its evidence: a named list, a labor seller, an equipment-service firm without crafts, verified operations with no Jole trades, or no US operating location.

An unanswered secondary question must not automatically become a rejection. Do not classify QUALIFIED when trade fit cannot be established, and do not accept a company merely because its website includes generic industrial keywords.

**Confidence:** HIGH with DIRECT craft evidence and a business model read from the company's own pages; MEDIUM when craft fit is PROCESS or rests on one third-party source; LOW for a CONDITIONAL decision built on thin evidence.

## Escalate to the user

- A possible client or competitor family that is not on the list.
- A mixed contractor with a real self-perform business: the competition call is commercial.
- An off-list craft that is the company's main need: Jole must confirm it.
- A held category (dealers, oilfield services) the user may want reopened.

## Output

Use the envelope in `jolesbtxicpskill/CONTRACT.md` with these details:

```json
"details": {"business_model": "end_employer | contractor | mixed_contractor | labor_seller | service_no_crafts | not_reopened",
  "labor_supply_overlap": "NONE FOUND | MIXED | PRIMARY", "operations": "what it does at which site, with source",
  "craft_fit": "DIRECT | PROCESS | UNCLEAR | NONE", "crafts": ["structural welders"], "off_list_crafts": [],
  "us_site": "City, ST | unknown | none", "sector": "one of the seven, or expansion pool", "credit_hold": "",
  "feasibility_triggers": [], "family_check": false}
```

## Examples

| Case | Correct | Incorrect |
|---|---|---|
| Shipyard with active fabrication, no postings and no recent award | QUALIFIED (PROCESS). Signal unknown, buyer research may proceed. | CONDITIONAL or excluded for having no posting |
| Industrial mechanical contractor serving plant owners with its own crews, no staffing line on its service pages | QUALIFIED; overlap NONE FOUND, recorded separately | Excluded or held for being a contractor |
| Group that self-performs and also lists "Contract/Supplemental Labor" (Quality Companies) | CONDITIONAL; overlap MIXED; competition review | QUALIFIED because contractors are allowed, or EXCLUDED as a staffing firm |
| Staffing company advertising welders, whatever its growth | EXCLUDED; overlap PRIMARY | Qualified because it "needs welders" |
| Aluminum boat builder in Washington State (SAFE Boats) | QUALIFIED, no penalty | Marked down for aluminum or geography |
| Navy repair yard (East Coast Repair) | QUALIFIED; per-contract checks go to feasibility | Excluded for Navy work |
| Welding-equipment service firm (Arc Solutions) | EXCLUDED: no Jole crafts of its own | Qualified because "welding" is in its description |
| Website says only "industrial solutions" with no work or site described | CONDITIONAL: actual operations unverified | QUALIFIED on keywords |
| Utility with pipe fitters and electricians under a binding project labor agreement (TVA) | QUALIFIED on fit; the agreement is decided by feasibility (BLOCKED there) | EXCLUDED here for the agreement |
| New trailer plant of an operating trailer maker (Hyundai Translead, Joliet) | QUALIFIED (PROCESS, MEDIUM); the local-hire pledge goes to feasibility | CONDITIONAL until a craft posting appears |
| Plant that may only assemble (Goldhofer, Hickory) | CONDITIONAL: craft fit UNCLEAR | QUALIFIED by assumption |
| Company with no US site | EXCLUDED | Conditional |

## Tests

`python tests/test_icp.py` from this folder. `tests/icp_logic.py` restates the mechanical rules; this file wins any disagreement.

## Change log

**1.1.0 (2026-11-03).** Added the old-evidence rule: fit evidence older than 12 months lowers confidence and sets `reverify`, but never changes the label. The description now says to load this skill directly for a fit-only question.

**1.0.0 (2026-11-03).** Split from jolesbtxicpskill 3.0.0, sections 1 and 3. Union and labor-agreement decisions moved to `jole-site-labor-feasibility`; DNC and suppression to `jole-dedupe-suppression`. Added craft-fit levels (DIRECT, PROCESS, UNCLEAR, NONE) and the operational-evidence rule, so a legitimate employer qualifies from its verified operations without demand research.
