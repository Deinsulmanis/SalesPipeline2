# Jole skills: shared input and output contract

Version 1.1.0, part of shared policy 4.1.0. Every Jole specialist reads the minimum it needs and writes one envelope per subject. The orchestrator combines envelopes into one consolidated record without changing them. `tests/jole_common.py` (`validate_output`) checks this shape.

## Inputs

Pass each skill only what it needs:

| Skill | Required | Optional |
|---|---|---|
| ICP | company name; website or another description of its work | site, sector guess, earlier findings |
| Signals | company and site; its ICP label; why a signal is needed | earlier evidence, research files |
| Buyer | company; facility or project; size band | signal, purchasing route, earlier buyer records |
| Feasibility | company; scope (site, project or contract); the trigger and its source | agreement text, contract numbers, ownership |
| Dedupe | company name with website or email domain; for a contact: email, Apollo id or name + company | parent names, file paths, export dates |
| Contact | person, title, company, email, email source | catch-all flag, MX host, history, dedupe result |
| Readiness | ICP, dedupe, buyer and contact results with dates; intended approach | signal evidence, feasibility result, list basis |

## The envelope

```json
{
  "skill": "jole-icp-qualification",
  "version": "1.1.0",
  "subject": {"kind": "company | contact | scope", "key": "conradindustries.com", "name": "Conrad Shipyard", "site": "Morgan City, LA"},
  "decision": "QUALIFIED",
  "confidence": "HIGH | MEDIUM | LOW",
  "evidence": [{"kind": "FACT | INFERENCE", "claim": "Builds and repairs steel and aluminum vessels at its Morgan City yards", "source": "https://...", "date": "2026-08-14"}],
  "unknowns": ["Craft mix at the Orange, TX yard"],
  "hard_exclusions": [],
  "next_step": "Run jole-buying-signals for priority",
  "more_research": {"justified": false, "why": "Fit is settled; more pages would not change it"},
  "reasoning": "Known: ... Implies: ... Uncertain: ... Worth more research: ... Next: ...",
  "assessed": {"date": "2026-11-03", "depth": "L1", "lookups": 2, "apollo_credits": 0},
  "reverify": [],
  "details": {}
}
```

**Mandatory in every envelope:** `skill`, `version`, `subject.key`, `decision`, `confidence`, `evidence`, `unknowns`, `next_step`, `more_research.justified`, `assessed.date`. That is all an early screen needs.

**Rules:**
- `decision` is one label from the owning skill's set in shared policy section 3.
- `evidence` has at least one item. For a "nothing found" decision (NO VERIFIED SIGNAL, BUYER NOT IDENTIFIED, NET NEW), list where you looked.
- `hard_exclusions` must have at least one cited item when the decision is EXCLUDED, PROHIBITED, SUPPRESSED, BLOCKED BY VERIFIED REQUIREMENT or REJECT, and must be empty otherwise.
- An `INFERENCE` item never supports a hard exclusion on its own.
- `reasoning` is one or two sentences at Level 1 and may be longer at Level 3. It answers the five questions in shared policy section 5.
- `subject.key`:
  - **company:** the normalized website domain, or the company key if there is no domain;
  - **contact:** the lowercased email, else `apollo:<person id>`, else `name@domain`;
  - **scope:** `<company key>#<site or project>`.
- `reverify` (optional, 1.1.0) lists findings past their window for the next use (shared policy section 7): `{"finding": "project_status", "checked": "YYYY-MM-DD", "before": "research | action | copy", "why": "..."}`. A listed finding keeps its label; the decision's confidence is one step lower.
- `details` holds the skill's own fields, defined in its SKILL.md under "Output". Keep them short; none is mandatory at Level 1.

## Consolidated record (orchestrator)

```json
{
  "subject": {"kind": "company", "key": "...", "name": "..."},
  "dimensions": {
    "icp":         {"decision": "QUALIFIED", "skill": "jole-icp-qualification@1.1.0", "date": "2026-11-03", "confidence": "HIGH"},
    "signal":      {"decision": "VERIFIED CURRENT SIGNAL", "priority": "PRIORITY A", "demand_score": 70, "skill": "jole-buying-signals@1.1.0", "date": "..."},
    "buyer":       {"decision": "BUYER VERIFIED", "skill": "jole-buyer-identification@1.1.0", "date": "..."},
    "feasibility": {"decision": "NOT EVALUATED", "reason": "no trigger"},
    "dedupe":      {"decision": "NET NEW", "skill": "jole-dedupe-suppression@1.0.1", "date": "...", "live": true},
    "contact":     {"decision": "NOT EVALUATED", "reason": "no contact data"},
    "readiness":   {"decision": "NOT EVALUATED", "reason": "no contact data"}
  },
  "conflicts": [],
  "reverify": [{"dimension": "buyer", "finding": "buyer_employment", "checked": "2026-09-20", "before": "action", "why": "44 days old; buyer_employment allows 30 for action"}],
  "next_action": "SOURCE CONTACT",
  "next_action_detail": "Apollo reveal of the yard GM needs a user cap",
  "stop_reason": "",
  "open_question": "Is the Orange yard staffed separately?",
  "cost": {"lookups": 7, "apollo_credits": 0}
}
```

- Each dimension keeps the specialist's decision exactly, with `skill@version` and its date. A reused finding keeps its original date.
- `dedupe` is the account pass. When the contact pass runs, its result appears as `dedupe_contact`.
- `NOT EVALUATED` always carries a `reason`.
- `conflicts` items: `{"between": ["icp", "dedupe"], "what": "...", "resolution": "STOP by precedence"}`.
- `next_action` is one label from shared policy section 3. `reverify` never changes it; it lists what to re-confirm before or during that action.
- Opportunity priority is reported in `signal` only. No other dimension, and no next action, is derived from it.

## Batch CSV (company screens and requalification)

Keep this column order:

```
Company,Website,Key,ICP,ICP confidence,ICP gap or exclusion,Signal status,Priority,Demand score,Outside labor,Buyer status,Buyer,Feasibility,Dedupe,Contact,Readiness,Next action,Next action detail,Open question,Evidence URLs,Assessed,Depth,Skill versions,Re-verify
```

Leave a column empty when the dimension was not evaluated, and say why in `Next action detail` only if it matters. For contact waves, use the approved-corpus schema in `reference.md` and add `Contact` and `Readiness`.

## Versioning

Each skill has a semantic version in its frontmatter, listed in ARCHITECTURE.md:
- **Major:** a label, a precedence or a hard rule changes. Outputs made under the old major are re-run, not reused.
- **Minor:** a new check, field or example that does not change existing decisions.
- **Patch:** wording only.

Record every change in the skill's change log. Changes to shared rules go into the shared policy's change log, with the user's approval.
