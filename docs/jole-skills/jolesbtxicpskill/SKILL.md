---
name: jolesbtxicpskill
description: Shared policy and index for all Jole BTX (Jorge Guerrero) prospecting and qualification (v4.1.0) - confirmed capabilities, hard exclusions and client/competitor lists, safety and Apollo-credit rules, decision labels, precedence, evidence and freshness standards, plus the map of the seven Jole specialist skills and the orchestrator. Load it first for any Jole sourcing, ICP, buying-signal, buyer, feasibility, dedupe, contact, deliverability or outreach-readiness work, together with the one specialist that owns the question; every Jole specialist depends on it. Not for ScaleLab or any other client.
version: 4.1.0
---

# Jole BTX shared qualification policy

**Version 4.1.0, effective 2026-11-03.** This file holds what every Jole skill shares: what Jole can supply, the hard exclusions, the safety rules, the decision labels and how decisions combine. Each decision belongs to one specialist skill (section 3), which owns its procedure. If a memory note, a prior report, an older copy or a specialist disagrees with this file, this file wins. Change it only with the user's approval, and record the change in the change log.

Jole BTX LLC (CEO Jorge Guerrero) supplies skilled-trade labor, contract and permanent, to US industrial employers and eligible contractors.

Optimize for consistent, accurate decisions and commercially useful prospects, not for acceptance counts. Never broaden the ICP to hit a volume target; report the shortfall instead. Never tighten a decision with a test that no Jole skill contains.

## How to use the Jole skills

1. Load this policy.
2. **Route by question, not by the number of companies.** A task that asks one qualification question, about one company or a list of any length, needs only the specialist that owns that question (section 3). Do not load the orchestrator for it. Load `jole-qualification-orchestrator` only when the task needs answers from two or more specialists, a next action per subject, or a plan for sourcing, requalification or a contact wave. **Do not run all seven specialists on every lead.**
3. Read [CONTRACT.md](CONTRACT.md) only when writing output that another skill or file will consume, and [reference.md](reference.md) when you need data locations, prior waves or schemas. [ARCHITECTURE.md](ARCHITECTURE.md) is for maintaining the skills.

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
- **Opportunity priority is a provisional research-ranking band.** PRIORITY A (64 to 75 demand points), PRIORITY B (53 to 63) and NURTURE / RESEARCH (52 or less) were rescaled from v3 and rest on 38 companies, so they stay provisional until the benchmark in [BENCHMARK-700.md](BENCHMARK-700.md) recalibrates them. Priority only orders work: which subjects get research and free buyer work first, and where credits go inside a cap the user has authorized. It never determines ICP eligibility, dedupe or suppression, feasibility, contact acceptance, outreach readiness, or authorization to enrich, import, queue or send. Only `jole-buying-signals` computes it, and no other skill's decision reads it.
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

## 7. Evidence age and re-verification

Record three things separately for every finding you reuse:
- **Evidence age:** the date the finding was last confirmed at its source.
- **Status of the thing itself:** what the source says, such as a project's stage and dates, whether a posting is open, a person's current title, or an agreement's term. These dates decide signal timing; evidence age does not.
- **Intended use:** research and ranking; a spend, import or queue; or a claim in copy.

How long a finding may be relied on, by use, counted from the date it was last confirmed:

| Finding | Changes | For research and ranking | Before spend, import or queue | Before a claim in copy |
|---|---|---|---|---|
| Craft posting (hiring evidence) | Fast | 30 days | 30 days | 30 days when Touch 1 renders (production V5 rule) |
| Project, award, expansion, turnaround or backlog status | Medium | 90 days | 90 days | 30 days when Touch 1 renders |
| Business model, crafts, US site | Slow | 12 months | 12 months | Not a claim in copy |
| Union representation, labor agreements, vendor rules | Slow | 12 months, or the agreement's expiry if sooner | 12 months, or the agreement's expiry if sooner | Not a claim in copy |
| Buyer employment and title | Fast | 90 days | 30 days | Not a claim in copy |
| CRM, suppression and dedupe state | Fast | 30 days | Same day, live sources | Not a claim in copy |
| Email status, catch-all, mail gateway | Medium | 30 days | 30 days | Not a claim in copy |

**Rules:**
1. **Old evidence lowers reliance, never the decision.** When a finding is past its window for the intended use, keep its recorded label. Mark it `reverify` (what, and before which use), and lower the confidence of any decision resting on it by one step. Only new contrary evidence, or a date the finding records passing, changes a label. This rule governs reuse. A specialist judging an old source now applies its own evidence standard; for example, a years-old press mention makes a buyer BUYER PARTIAL, because employment changes fast.
2. **Stale evidence is never an ICP exclusion.** Old fit evidence leaves the ICP label as recorded. Re-check it at Level 1 before any spend.
3. **Age is not status.** A verified build program that runs to 2028, last confirmed 150 days ago, is still a current signal; it needs re-verification before it supports a claim in copy. A turnaround whose dates have passed is CONTRADICTORY / STALE SIGNAL, even if the article was read yesterday.
4. **Re-verify by risk.** The more harm a wrong fact would do, the tighter its window: claims made to a recipient are tightest, then spend and import, then research ordering. Re-verify only when the next use needs it, at the cheapest source that settles it (usually one lookup at the original source), higher-priority subjects first.
5. **Events end windows early.** Re-check a finding once a date it records passes (a project start or end, an agreement expiry, a posting's close date), and after an ownership change, closure, rebrand, layoff or new site.

Only the 30-day hiring rule is enforced by production code (`jole-personalization.js`, `FRESHNESS_DAYS = 30`). The other windows are Jole guidance, set at the user's request on 2026-11-03. Change them only in this table, with the user's approval.

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
- [BENCHMARK-700.md](BENCHMARK-700.md): the two-stage benchmark to run before scaling toward 700 sendable prospects (not authorized to run).
- `python tests/run_all.py` from this folder runs every Jole skill's tests, then checks the installation against its source. Run it after changing any Jole skill. The `tests/` folders restate the mechanical rules so drift is caught; the SKILL.md files win any disagreement. Do not open, search for or run any `tests/` folder to decide a company, real or fictional; decide from the SKILL.md files.

**Source and installation.** The source of truth is the SalesPipeline2 repository, folder `docs/jole-skills/`, at the commit recorded in `.jole-install.json` (on `main` once integrated). The folders under `~/.claude/skills/`, the Codex pointers in `~/.agents/skills/` and the Jole sections of the instruction files are installed from it by `tools/sync.py`, which also detects drift. An edit made here must be exported and committed before anything else relies on it (ARCHITECTURE.md, "Source and installation").

## Change log

**4.1.0 (2026-11-03).** Stabilization pass requested by the user; no new skills.
- *Routing:* route by question, not by the number of companies. A single question loads only its specialist; the orchestrator is for multi-question tasks.
- *Priority:* the 64 and 53 bands are stated as provisional research-ranking bands that never decide eligibility, suppression, readiness or authorization.
- *Freshness:* section 7 now separates evidence age, the status of the thing itself and the intended use, with a window per use. Old evidence lowers reliance and confidence but never a label, and is never an ICP exclusion. Claims in copy about projects, expansions or turnarounds need evidence confirmed within 30 days, matching the production hiring rule (previously 90 days).
- *Source:* the repository folder `docs/jole-skills/` is now the source of truth; the local folders are installations checked by `tools/sync.py`.

**4.0.0 (2026-11-03).** Requested by the user: split qualification into independent specialist skills.
- *Why:* v3 still evaluated eligibility, demand, buyers, access and readiness in one file and folded buyer and procurement points into the opportunity score, so research effort went into rejecting or deprioritizing legitimate employers for reasons unrelated to fit.
- *Added:* seven specialist skills and an orchestrator; one table of decision owners and labels; precedence and conflict rules; the evidence standard; research levels; freshness defaults; a shared output contract; per-skill and orchestration tests.
- *Changed:* this file now holds only shared rules. Opportunity priority is demand-only (signal, outside labor, timing), because buyer and procurement are separate dimensions. Union, PLA and defense access moved from ICP to feasibility; DNC and suppression moved to dedupe. v3 readiness states were replaced by the outreach-readiness labels and orchestrator next actions. The V5 hiring window is 30 days from the last evidence check, matching production, not the 45 days v3 stated.
- *Kept:* capabilities, crafts list, every DNC entry and named negative, staffing exclusions, holds, the site-connection rule, email and Proofpoint rules, dedupe sources, Apollo rules, import rules, safety rules.
- *Moved, not lost:* see MIGRATION-v4.md for the location of every v3 rule.

**3.0.0 (2026-11-02).** Separate eligibility, opportunity score and readiness; confirmed capabilities; contractors eligible; posting gates moved to the V5 lane.

**2.0 and earlier (to 2026-10-12).** Unversioned, hiring-based ICP built from the 689-lead corpus.
