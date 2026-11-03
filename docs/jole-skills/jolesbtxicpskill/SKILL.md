---
name: jolesbtxicpskill
description: Shared policy and index for all Jole BTX (Jorge Guerrero) prospecting and qualification (v4.0.0) - confirmed capabilities, hard exclusions and client/competitor lists, safety and Apollo-credit rules, decision labels, precedence and evidence standards, plus the map of the seven Jole specialist skills and the orchestrator. Load it first for any Jole sourcing, ICP, buying-signal, buyer, feasibility, dedupe, contact, deliverability or outreach-readiness work; every Jole specialist depends on it. Not for ScaleLab or any other client.
version: 4.0.0
---

# Jole BTX shared qualification policy

**Version 4.0.0, effective 2026-11-03.** This file holds what every Jole skill shares: what Jole can supply, the hard exclusions, the safety rules, the decision labels and how decisions combine. Each decision belongs to one specialist skill (section 3), which owns its procedure. If a memory note, a prior report, an older copy or a specialist disagrees with this file, this file wins. Change it only with the user's approval, and record the change in the change log.

Jole BTX LLC (CEO Jorge Guerrero) supplies skilled-trade labor, contract and permanent, to US industrial employers and eligible contractors.

Optimize for consistent, accurate decisions and commercially useful prospects, not for acceptance counts. Never broaden the ICP to hit a volume target; report the shortfall instead. Never tighten a decision with a test that no Jole skill contains.

## How to use the Jole skills

1. Load this policy.
2. Load the specialist that owns the question (section 3). For a list of companies, or any task with more than one question, load `jole-qualification-orchestrator`; it chooses the specialists and their order. **Do not run all seven specialists on every lead.**
3. Read [ARCHITECTURE.md](ARCHITECTURE.md) for dependencies, invocation examples and test commands, and [CONTRACT.md](CONTRACT.md) before writing output that another skill or file will consume. [reference.md](reference.md) lists data locations, prior waves and schemas.

Confirm the current production state (Jole lead count, campaign, suppressions) rather than assuming a past wave's numbers.

## Standing safety rules

- **Apollo credits: 0 unless the user gives an explicit cap for this run.** See section 8.
- Never send, queue, assign senders, or enable Jole sending. Never import unless the user asks for the import in that task.
- **No contact may be queued or sent merely because a company passes ICP qualification.** No skill authorizes import, sending, enrichment spend or a new campaign; each needs the user's explicit instruction for that task.
- Do not modify or activate V5. A signal-based lead needs a separately approved signal-aware campaign or variant, which needs its own authorization.
- CRM, lead, suppression and production tables are read with `SELECT` only. Never change CRM records, leads, queues, suppressions, sender allocation or caps.
- Client id is always `jole`, never `jole-btx`. Campaign is `jole-btx-employer-acquisition`, template `jole-industrial-employer-v1`, lead niche `jole_employer`.
- Never guess or pattern-build emails. No phone, waterfall or personal-email reveals. Never send test emails.
- Don't touch ScaleLab leads, campaigns or senders.

## 1. Confirmed Jole capabilities

Confirmed in the user's 2026-11-02 brief. These supersede every older assumption, including the 30-day answer on Jorge's October 2026 onboarding form.

| Capability | Status | How to apply it |
|---|---|---|
| Industrial contractors | **YES** | Do not exclude a contractor simply because it provides industrial construction, fabrication, plant maintenance or mechanical services to others. Staffing companies and labor brokers are excluded; mixed contractors are reviewed individually. |
| Aluminum welders | **YES** | Shipyards, marine manufacturers and fabricators needing aluminum welding are eligible. No penalty. |
| Geographic coverage | **YES** | Do not penalize a company for being outside TX, LA or the Gulf. Still verify the actual operating facility and the buyer's site connection. |
| Navy and defense | **YES** | Do not auto-exclude defense shipyards or contractors. General defense capability does not prove eligibility for every individual contract, so the per-contract checks in `jole-site-labor-feasibility` still apply. |
| Strict 30-day need | **NO** | Not mandatory. A company does not fail ICP because demand is 60, 90 or 180+ days out. Project timing should affect outreach priority, not automatically determine ICP eligibility. Still distinguish active from speculative demand. |

**Crafts on Jole's published list:** supervisors, pipe fitter leadmen, pipe fitters, pipe welders, structural welders, ship fitters, marine electricians, sheet metal mechanics, outside and inside machinists, QA inspectors, riggers, blasters, painters, tackers, crane operators, skilled helpers, firewatchers, plus aluminum welders as confirmed above.

A craft missing from that list (boilermakers, millwrights, I&E technicians, panel builders) is not an exclusion. Record it as a question for Jole. Do not read broader capability into work Jole has not confirmed. Jole's onboarding form lists no certifications, so never claim any.

## 2. Hard exclusions and named lists

This is the only place these lists are defined. Specialist skills cite this section; they never copy the lists.

- **Clients and client families (PROHIBITED, never contacted):** Karpower (including Karpowership); Kiewit Offshore Services and the Kiewit family (KOS, TIC, Weeks Marine and any other Kiewit entity); the SpaceX client family (SpaceX, SpaceXAI); any current Jole client. Ask the user if this list may have changed.
- **Named negatives that sell crews or labor (competitors: ICP EXCLUDED and PROHIBITED):** Brock, Austin Industrial, Zachry, Turner Industries, TEAM Inc. (Team Industrial Services), Bilfinger, Koch Engineered Solutions, Bay Ltd., Taurus Industrial, Upchurch.
- **Category exclusions (ICP EXCLUDED, with evidence):** staffing companies, labor brokers, recruiters, PEOs and labor-service firms whose business is reselling workers; generic, professional, IT, healthcare and commercial staffing; equipment-service firms with no Jole crafts of their own; employers without relevant industrial trades; no US operating location.
- **Not reopened (ICP CONDITIONAL with a credit hold):** Cat and John Deere dealers; oilfield services; field-service-heavy companies (Martin Engineering, Nalco Water).
- **Hold before spending credits (ICP CONDITIONAL with a credit hold):** pre-revenue or early-stage developers; borderline aerospace fabricators; fuel distributors whose only opening is a single technician role.
- **Any DNC entry, global or client suppression match:** SUPPRESSED, decided by `jole-dedupe-suppression`.
- **A verified labor agreement or contract term that closes the route for an outside supplier:** BLOCKED BY VERIFIED REQUIREMENT for the covered work, decided by `jole-site-labor-feasibility`.

Every hard exclusion needs cited evidence. Names are matched as whole words, so a name that only resembles a listed one (Bay Area Shipyard, Ticona, Brockway) stays open.

## 3. Decisions and their owners

| Dimension | Question | Owner skill | Labels |
|---|---|---|---|
| Company ICP eligibility | Can Jole realistically provide industrial skilled labor to this company? | `jole-icp-qualification` | QUALIFIED, CONDITIONAL, EXCLUDED |
| Buying signal | What evidence suggests the employer may need more skilled workers, and when? | `jole-buying-signals` | VERIFIED CURRENT SIGNAL, VERIFIED FUTURE SIGNAL, POTENTIAL SIGNAL, NO VERIFIED SIGNAL, CONTRADICTORY / STALE SIGNAL |
| Opportunity priority | How attractive and timely is the potential need? | `jole-buying-signals` | PRIORITY A, PRIORITY B, NURTURE / RESEARCH |
| Buyer identification | Do we know the correct person? | `jole-buyer-identification` | BUYER VERIFIED, BUYER PARTIAL, BUYER NOT SITE-CONNECTED, BUYER NOT IDENTIFIED |
| Commercial feasibility | Can Jole plausibly access the work? | `jole-site-labor-feasibility` | FEASIBLE, FEASIBLE WITH CONDITIONS, UNKNOWN, BLOCKED BY VERIFIED REQUIREMENT |
| Duplicates and permission | Is it genuinely net-new and allowed? | `jole-dedupe-suppression` | NET NEW, EXISTING ACCOUNT — NEW OPPORTUNITY, EXISTING CONTACT, FAMILY MATCH — REVIEW, SUPPRESSED, PROHIBITED |
| Contact quality | Is the recipient's email suitable for outbound? | `jole-contact-deliverability` | CONTACT ACCEPTED FOR REVIEW, ADDITIONAL VERIFICATION REQUIRED, HOLD, REJECT |
| Outreach readiness | Is there an approved, truthful campaign path? | `jole-outreach-readiness` | READY FOR APPROVED SEQUENCE, COPY / SIGNAL REVIEW REQUIRED, CONTACT VERIFICATION REQUIRED, HOLD, EXCLUDED |
| Orchestration | What is the next useful action? | `jole-qualification-orchestrator` | STOP, HOLD, REVIEW, RESEARCH FIT, RESEARCH FEASIBILITY, RESEARCH SIGNAL, RESEARCH BUYER, SOURCE CONTACT, VERIFY CONTACT, COPY REVIEW, HUMAN REVIEW |

A dimension the task did not need is reported as **NOT EVALUATED**, with the reason. NOT EVALUATED is never a failure. Use these labels exactly; do not invent others.

## 4. Independence and precedence

- **Never merge the dimensions into one score.** A company can be ICP QUALIFIED, PRIORITY A, BUYER NOT IDENTIFIED and not ready for outreach at the same time; those statuses are not contradictory.
- Never downgrade ICP fit because of missing contact data, a missing buyer, missing copy, a weak or absent signal, distant timing or an unresolved feasibility question. A low score must not turn a qualified employer into an exclusion. A company can be ICP QUALIFIED and NURTURE.
- A strong buying signal does not override deliverability, suppression or compliance restrictions.
- **Stops.** Spend nothing more on the subject, for the stated scope, after any of these:
  1. PROHIBITED (client family or named competitor).
  2. ICP EXCLUDED.
  3. SUPPRESSED at company or domain level. An email-level suppression stops that contact only.
  4. BLOCKED BY VERIFIED REQUIREMENT, for the covered work only.
- **No silent overwrites.** A specialist never changes another specialist's decision. When two disagree (for example ICP QUALIFIED, but dedupe finds a client family that the name check missed), keep both results with their skill and version, apply the stop, and state the conflict.
- **Next-action precedence:** STOP, then HOLD, REVIEW, RESEARCH FIT, RESEARCH FEASIBILITY, RESEARCH SIGNAL, RESEARCH BUYER, SOURCE CONTACT, VERIFY CONTACT, COPY REVIEW, HUMAN REVIEW. The orchestrator applies it.

## 5. Evidence standard (every skill)

Keep these apart in every decision:
- **Known fact:** dated and attributable to a named source.
- **Reasonable inference:** labelled as inference, with what it rests on.
- **Missing evidence:** what was not found, and where you looked.
- **Contradictory evidence:** both sources, and which is newer.
- **Actual disqualification:** a hard exclusion with its evidence.

**Evidence levels for a claim:** VERIFIED (dated, attributable, confirmed at the source); POTENTIAL (plausible but undated, unattributed, or not confirmed at the source); INDUSTRY FIT ONLY (the kind of company that might have this).

- Never present a potential claim as verified. Do not invent job postings, labor shortages, project details, names, emails or requirements.
- **A missing field is not a failed criterion.** Only a hard exclusion with evidence produces EXCLUDED, PROHIBITED, SUPPRESSED, BLOCKED BY VERIFIED REQUIREMENT or REJECT.
- Generic industrial keywords on a website are not operational evidence.
- Do not force a binary answer. Use the uncertain label (CONDITIONAL, POTENTIAL SIGNAL, BUYER PARTIAL, UNKNOWN, ADDITIONAL VERIFICATION REQUIRED, FAMILY MATCH — REVIEW) and name the gap.
- Indeed, ZipRecruiter, Glassdoor and SimplyHired block automated checks, so never use them as evidence.

**Every decision briefly answers:** What do we know? What does that imply? What remains uncertain? Would further research be worth the effort? What should happen next?

**Confidence:** HIGH when the decision rests on verified facts and new evidence is unlikely to change it; MEDIUM when it rests partly on inference or on one source; LOW when evidence is thin and the decision is provisional.

## 6. Research depth and cost

| Level | Use | Typical effort |
|---|---|---|
| 1. Fast screen | Industrial fit and obvious exclusions: the company's own operations, services, facility and careers pages, the named lists, and an inexpensive dedupe | About 3 lookups |
| 2. Targeted | Relevant facility, buyer role and available demand signals; one feasibility trigger check | About 8 lookups |
| 3. Deep | Filings, agreements, ownership, union contracts, several sources. Only for high-value subjects, or when an unresolved fact would change a decision | As needed, stated up front |

- Stop when more evidence would not change the decision or the next action, and name the highest-value open question instead.
- Do not require deep project research to establish that a legitimate industrial employer belongs in the ICP.
- Never repeat research another skill already recorded within its freshness window (section 7). Cite it.
- Record for each subject: depth, number of lookups, Apollo credits (0 unless a cap was authorized).

## 7. Freshness and reuse (working defaults)

| Finding | Reuse it for | Re-check |
|---|---|---|
| Craft posting used for a hiring claim | 30 days from the last check (production V5 rule) | Before Touch 1 renders |
| Project, award, expansion, turnaround or backlog status | 90 days | Sooner if its window starts within 90 days or has passed |
| Business model, crafts, US site | 12 months | After an ownership change, rebrand or new site |
| Union representation, labor agreements, vendor rules | 12 months | After a contract renewal or ownership change |
| Buyer employment and title | 90 days | Before any reveal or import |
| CRM, suppression and dedupe state | 30 days for screening | Same day before any purchase, import or queue |
| Email status, catch-all, mail gateway | 30 days | Before import |

Only the 30-day hiring rule is enforced by production code. The other windows are working defaults; change them with the user's approval.

## 8. Apollo credit protection

- Spend stays 0 unless the user gives an explicit cap for that run. Ask for the cap before any reveal. Keep a reserve (Phase 4 used a 900 cap with a 75-credit floor) and report spend at checkpoints, verified against the balance.
- Check `apollo_usage_stats_credit_usage_stats` before and after a run.
- **Confirmed free (balance-checked, Nov 2026):** `apollo_mixed_people_api_search` and `apollo_organizations_lookup`. People search masks last names and hides location, but `person_locations` works as a free site test. A preview is not a verified contact.
- **Do not use without a cap:** enrichment, `people_match`, `bulk_match`, `apollo_mixed_companies_search`, the job postings tool, email validation and the `apollo_agent_*` tools.
- Enrich only a company that is not EXCLUDED, PROHIBITED or SUPPRESSED, has no open feasibility block, and is worth the credit on priority. Never enrich a corporate contact to get around the site gate.
- **Workflow with a cap:** free people search; check title and location; reveal through people-match with phone, waterfall and personal email off. Expect about 1.1 credits per usable contact. Stop when late rounds produce more holds than ready contacts.

## 9. Import (only when the user asks for it in that task)

- Import into client `jole` through the managed-client path: the authenticated client import route, or rows inserted into `client_lead_import_batches` in hash-checked chunks, staged and then set to pending so the server's import job processes them.
- Never use the legacy ColdEmail import. It stamps rows `scalelab`.
- Never create anonymous upload rules or weaken RLS.
- After import, reconcile:
  - Jole total = previous total + new approved;
  - every new lead at stage `Import`;
  - 0 queued, 0 senders, 0 sends;
  - correct campaign and template;
  - no ScaleLab rows touched.
- A new lead also needs a reviewed V5 classification entry before it can send (see `jole-outreach-readiness`). That is a production change, authorized separately.

## 10. Files, versions and tests

- [ARCHITECTURE.md](ARCHITECTURE.md): responsibilities, invocation conditions, dependencies, activation order, versions of all eight skills, invocation examples, how sessions load the skills.
- [CONTRACT.md](CONTRACT.md): the shared output envelope, each skill's details fields and the consolidated row.
- [reference.md](reference.md): prior waves, research files, column schemas, production identifiers.
- [MIGRATION-v4.md](MIGRATION-v4.md): what v3 rules were preserved, moved, replaced or deprecated.
- `python tests/run_all.py` from this folder runs every Jole skill's tests. Run it after changing any Jole skill. The `tests/` folders restate the mechanical rules so drift is caught; the SKILL.md files win any disagreement. Do not open, search for or run any `tests/` folder to decide a company, real or fictional; decide from the SKILL.md files.

This folder and its sibling `jole-*` folders under `~/.claude/skills/` are canonical. They sit outside any git branch so they load in every session. A snapshot for version history lives in the SalesPipeline2 repo under `docs/jole-skills/` and is never the source of truth. `~/.agents/skills/` holds pointers for Codex and no rules.

## Change log

**4.0.0 (2026-11-03).** Requested by the user: split qualification into independent specialist skills.
- *Why:* v3 still evaluated eligibility, demand, buyers, access and readiness in one file and folded buyer and procurement points into the opportunity score, so research effort went into rejecting or deprioritizing legitimate employers for reasons unrelated to fit.
- *Added:* seven specialist skills and an orchestrator; one table of decision owners and labels; precedence and conflict rules; the evidence standard; research levels; freshness defaults; a shared output contract; per-skill and orchestration tests.
- *Changed:* this file now holds only shared rules. Opportunity priority is demand-only (signal, outside labor, timing), because buyer and procurement are separate dimensions. Union, PLA and defense access moved from ICP to feasibility; DNC and suppression moved to dedupe. v3 readiness states were replaced by the outreach-readiness labels and orchestrator next actions. The V5 hiring window is 30 days from the last evidence check, matching production, not the 45 days v3 stated.
- *Kept:* capabilities, crafts list, every DNC entry and named negative, staffing exclusions, holds, the site-connection rule, email and Proofpoint rules, dedupe sources, Apollo rules, import rules, safety rules.
- *Moved, not lost:* see MIGRATION-v4.md for the location of every v3 rule.

**3.0.0 (2026-11-02).** Separate eligibility, opportunity score and readiness; confirmed capabilities; contractors eligible; posting gates moved to the V5 lane.

**2.0 and earlier (to 2026-10-12).** Unversioned, hiring-based ICP built from the 689-lead corpus.
