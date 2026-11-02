---
name: jolesbtxicpskill
description: Canonical Jole BTX ICP and prospect-qualification policy (v3.0.0). Use for ANY Jole / Jole BTX / Jorge prospecting work - sourcing companies, researching buying signals, qualifying or requalifying companies, scoring opportunity, selecting buyers, planning Apollo enrichment, deduping, QC, or preparing Jole leads for import. Covers US industrial employers and eligible contractors that could buy skilled-trade labor from Jole, with separate ICP eligibility, opportunity score and outreach readiness. Load this before judging any Jole company, even when older notes or prior reports say otherwise. Not for any other client or ICP (for example ScaleLab staffing agencies); those have their own skills.
version: 3.0.0
---

# Jole BTX ICP and prospect qualification

**Version 3.0.0, effective 2026-11-02.** This file is the only source of truth for Jole ICP decisions. If a memory note, a prior report or an older copy disagrees, this file wins. Change it only with the user's approval, and record the change in the change log at the end.

Jole BTX LLC (CEO Jorge Guerrero) supplies skilled-trade labor, contract and permanent, to US industrial employers and eligible contractors. Three separate decisions are made for every company: can it buy from Jole, how good is the opening now, and is a contact ready.

Optimize for consistent, accurate qualification and commercially useful prospects, not for acceptance counts. Never broaden the ICP to hit a volume target; report the shortfall instead. Never tighten it by adding a test this file does not contain.

Before starting, read [reference.md](reference.md) for prior-wave files and output schemas, and confirm the current production state (Jole lead count, campaign, suppressions) rather than assuming the last wave's numbers.

## Standing safety rules

- **Apollo credits: 0 unless the user gives an explicit cap for this run.** See section 11.
- Never send, queue, assign senders, or enable Jole sending. Never import unless the user asks for the import in that task.
- **No contact may be queued or sent merely because a company passes ICP qualification.**
- Do not modify or activate V5. A signal-based lead needs a separate approved signal-aware campaign or variant, which needs its own authorization.
- Client id is always `jole`, never `jole-btx`. Campaign is `jole-btx-employer-acquisition`, template `jole-industrial-employer-v1`, lead niche `jole_employer`.
- Never guess or pattern-build emails. No phone, waterfall or personal-email reveals.
- Don't touch ScaleLab leads, campaigns or senders.

## 1. Confirmed Jole capabilities

Confirmed in the user's 2026-11-02 brief. These supersede every older assumption, including the 30-day answer on Jorge's October 2026 onboarding form.

| Capability | Status | How to apply it |
|---|---|---|
| Industrial contractors | **YES** | Do not exclude a contractor simply because it provides industrial construction, fabrication, plant maintenance or mechanical services to others. See section 3. |
| Aluminum welders | **YES** | Shipyards, marine manufacturers and fabricators needing aluminum welding are eligible. No penalty. |
| Geographic coverage | **YES** | Do not penalize a company for being outside TX, LA or the Gulf. Still verify the actual operating facility and the buyer's site connection. |
| Navy and defense | **YES** | Do not auto-exclude defense shipyards or contractors. General defense capability does not prove eligibility for every individual contract, so keep the project checks in section 3. |
| Strict 30-day need | **NO** | Not mandatory. A company does not fail ICP because demand is 60, 90 or 180+ days out. Project timing should affect outreach priority, not automatically determine ICP eligibility. Still distinguish active from speculative demand. |

**Crafts on Jole's published list:** supervisors, pipe fitter leadmen, pipe fitters, pipe welders, structural welders, ship fitters, marine electricians, sheet metal mechanics, outside and inside machinists, QA inspectors, riggers, blasters, painters, tackers, crane operators, skilled helpers, firewatchers, plus aluminum welders as confirmed above.

A craft missing from that list (boilermakers, millwrights, I&E technicians, panel builders) is not an exclusion. Record it as a question for Jole. Do not read broader capability into work Jole has not confirmed. Jole's onboarding form lists no certifications, so never claim any.

## 2. Three separate decisions

| Dimension | Question | Output |
|---|---|---|
| A. ICP eligibility | Could this company realistically purchase skilled labor from Jole? | QUALIFIED, CONDITIONAL or EXCLUDED |
| B. Buying opportunity | How good is the opening right now? | Score 0 to 100, then PRIORITY A, PRIORITY B or NURTURE / RESEARCH |
| C. Outreach readiness | What is the first gate still blocking contact? | One readiness state |

Never merge them. A low score must not turn a qualified employer into an exclusion. A company can be ICP QUALIFIED and NURTURE. Passing ICP does not make a contact ready.

## 3. Dimension A: ICP eligibility

- **QUALIFIED:** all six checks below pass.
- **CONDITIONAL:** no hard disqualification, but specific evidence is missing. Always name what is missing.
- **EXCLUDED:** a verified hard disqualification. If evidence is inconclusive, use CONDITIONAL rather than inventing certainty. Do not classify QUALIFIED when trade fit cannot be established.

**Evaluate these six:**
1. Real industrial employer or eligible contractor.
2. Actual operations with Jole-relevant crafts at this site.
3. Credible use case for contract or permanent skilled-trade workers.
4. US operating location.
5. No prohibited competitor, client-family or suppression match.
6. Plausible ability to procure workers.

**Do NOT require:** an active job posting, an open vacancy, need within 30 days, an identified decision-maker, proof of prior contract-labor purchasing, or an arbitrary minimum employee count. Missing proof of prior subcontract use is not a hard exclusion.

**Sectors to source:**
1. Industrial fabrication / machinery
2. Metals / mining / paper / heavy industrial
3. Refining / petrochemical / LNG / chemical
4. Power / utilities
5. Shipyard / marine
6. Pipeline / midstream
7. Oil & gas producers / operators

**Manufacturers** count as industrial fabrication / machinery when they make machinery, industrial machinery, fabricated metal, metalworking, rail equipment, electrical equipment or oilfield equipment, or when their own description shows heavy fabrication (steel structures, tanks, pressure vessels, trailers, truck bodies, cranes, boilers, turbines, transformers). The company's work decides this, not its customers' sector.

**Outside default sourcing (expansion pool):** food, pharma/medical, consumer goods, packaging, plastics products, electronics/semiconductors, automotive, rail operators, battery/solar component makers, general aerospace, and recreational or consumer boat builders. Do not source these by default. Membership alone is not a verified disqualification: if one reaches you with Jole crafts at the site, assess it normally. Defense shipyards and contractors are not in this pool.

### Business model

| Company type | Decision |
|---|---|
| Contractor purchasing extra skilled labor for its own work | Eligible. Assess normally. |
| Contractor with both self-performing projects and a workforce-supply business | CONDITIONAL. Review individually for actual buyer fit and competition. |
| Staffing company or labor broker primarily reselling workers, recruiter, PEO, labor-service firm | EXCLUDED. It competes with Jole. |
| Generic staffing, professional recruiting, IT staffing, healthcare staffing, commercial service companies | EXCLUDED |
| Equipment service firm with no Jole crafts of its own | EXCLUDED |
| Cat and John Deere dealers, oilfield services | HOLD. These were not reopened. |
| Field-service-heavy companies (Martin Engineering, Nalco Water) | HOLD |

**Pipeline contractors** are assessed under the contractor rule. Check for a workforce-supply business before treating any contractor as a clean buyer: read its service pages, not only its name.

### Hard exclusions

These stand regardless of signal strength:

- **Clients and families:** Karpower; Kiewit Offshore Services and the Kiewit family (KOS, TIC, Weeks Marine); the SpaceX client family (SpaceX, SpaceXAI); any current Jole client. Ask the user if this list may have changed.
- **Named negatives that sell crews:** Brock, Austin Industrial, Zachry, Turner Industries, TEAM Inc., Bilfinger, Koch Engineered Solutions, Bay Ltd., Taurus Industrial, Upchurch.
- **Any DNC entry, suppression or client-family match.**
- **Employers without relevant industrial trades.**
- **No US operating location.**
- **A binding labor agreement that closes the route** (below).

### Labor agreements and restricted work

Read the agreement or a reliable source. Never decide on the word "union" alone, and never treat defense capability as an answer.

| Situation | Decision |
|---|---|
| Hiring-hall employer, or a project labor agreement that binds suppliers and routes crafts through union referral, so Jole cannot supply its own workers | EXCLUDED for covered work. Name the clause. |
| In-plant union, subcontracting terms unknown | CONDITIONAL, readiness COMPLIANCE / PROCUREMENT REVIEW |
| In-plant union, outside contractors documented | Can be QUALIFIED, readiness COMPLIANCE / PROCUREMENT REVIEW |

Preserve these project-specific checks for defense, federal and nuclear work: security clearance, installation access, contract-specific compliance, union or project labor agreements, approved-vendor requirements and procurement restrictions. Record them per contract. A check that "may" apply lowers the procurement score. Only a verified barrier changes readiness.

### Holds

Keep these on hold before spending credits:
- Pre-revenue or early-stage developers (CONDITIONAL, readiness HOLD).
- Borderline aerospace fabricators.
- Fuel distributors whose only opening is a single technician role.

## 4. Buying signals

| # | Signal | What must be confirmed |
|---|---|---|
| 1 | Active craft hiring | Verified posting with role and location. Supports hiring-based V5 (section 7). |
| 2 | Project or contract award | Scope, location and stage. Evidence of workload, not automatic proof of hiring. |
| 3 | Facility expansion | When labor is likely required. |
| 4 | Turnaround, outage or shutdown | Dates, trade relevance, buyer access and how labor is procured. |
| 5 | Production or backlog growth | Current capacity versus distant, speculative work. |
| 6 | Existing use of subcontract labor | Strong signal, especially with active workload. Conrad's filings are the model example. |
| 7 | Other verified operational trigger | The trigger and its link to craft work. |

**Evidence levels:**
- **VERIFIED:** dated and attributable to a named source.
- **POTENTIAL:** plausible but undated, unattributed, or not confirmed at the source.
- **INDUSTRY FIT ONLY:** the kind of company that might have this need.

Never present a potential signal as verified. Do not invent job postings, labor shortages or project details. Label every inference as inference. A signal whose window has passed is expired, whatever its source. Large dollar announcements must not inflate scores: read job counts and net new roles.

**Hiring evidence sources:** LinkedIn public job search (no login, last 30 days, by craft role and state, then by company), and the employer's own ATS or careers board (Workday, UKG, ADP, Paylocity, BambooHR, Workable, JazzHR, Oracle). Indeed, ZipRecruiter, Glassdoor and SimplyHired block automated checks, so never use them as evidence. An aggregator page is POTENTIAL until confirmed on the employer's own board. An undated "always hiring" page shows which crafts exist but is not a hiring signal.

## 5. Dimension B: opportunity score

| Component | Max |
|---|---|
| Verified demand signal strength | 30 |
| Likelihood of relevant external skilled-labor demand | 25 |
| Project timing and current stage | 20 |
| Buyer accessibility and relevance | 15 |
| Procurement and operational accessibility | 10 |

**PRIORITY A** 85 to 100. **PRIORITY B** 70 to 84. **NURTURE / RESEARCH** below 70.

| Component | High | Middle | Low |
|---|---|---|---|
| Signal | 26-30: verified, current, tied to craft work, more than one signal | 20-25: one verified current signal with a clear craft link. 12-19: verified but small, distant or loosely linked | 1-11: potential, expired or speculative |
| External labor | 21-25: documented current use of outside labor | 15-20: documented through another channel or period, or a stated shortage under active load. 8-14: plausible from workload, undocumented | 1-7: direct-hire plan, in-sourcing or a very small need |
| Timing | 17-20: active or within 90 days | 12-16: 90-180 days, or active with unknown dates. 7-11: no dates, or 6-18 months | 1-6: more than 18 months out, or passed |
| Buyer | 13-15: verified operating buyer, with a second route | 9-12: verified with limited authority, or older proof. 4-8: partial | 0-3: none, or fails the site gate |
| Procurement | 8-10: nothing found | 5-7: project checks likely | 0-4: verified restriction |

Geography is not a scoring factor. Dollar size is not an input. Do not score EXCLUDED companies.

## 6. Dimension C: outreach readiness

Report the **first** gate not cleared, in this order:

1. **HOLD:** excluded, suppressed, early-stage hold, or a sending-quality hold on the contact.
2. **COMPLIANCE / PROCUREMENT REVIEW:** a verified barrier must be cleared first (labor agreement, cleared facility, nuclear qualification, new-owner vendor rules, incentive-linked hiring pledge, overlap with a labor seller).
3. **SIGNAL VERIFICATION REQUIRED:** the signal is not verified and current, or fit evidence is still missing.
4. **BUYER RESEARCH REQUIRED:** no verified, site-connected buyer or validated buying authority.
5. **CONTACT VERIFICATION REQUIRED:** no contact data that passes the email rules.
6. **READY FOR CONTACT REVIEW:** all gates cleared, including a suitable approved email variant. If only the variant is missing, the state is HOLD.

Ready requires all of these: a verified relevant buyer or validated buying authority; adequate company and facility fit; accurate, supportable personalization; a suitable approved email variant; contact data passing the deliverability rules; and no suppression or hard exclusion. Ready means a person reviews the contact. It does not authorize sending.

## 7. V5 and the hiring lane

V5 modes: `exact` and `role_only` state that Jole saw the company hiring. `general_craft` makes no hiring claim.

- A lead may use `exact` or `role_only` only with a verified role, verified location where the mode needs it, and a posting date within 45 days (`maxEvidenceAgeDays: 45`).
- A signal-based company without a verified hiring role must not use a hiring-based V5 variant.
- `general_craft` is not an approved signal-aware variant. Using it for a signal-based list needs separate authorization.

**For a wave destined for live V5 only**, these older gates still apply, because the live copy depends on them. They are not ICP rules:
- At least one live craft posting at a named US site, posted in the last 30 days, and re-opened to confirm it still accepts applications.
- **Core trades:** welder, fitter / pipefitter / shipfitter, machinist / CNC, millwright, boilermaker, electrician, I&E / instrument tech, and similar. **Relevant craft roles** also include maintenance mechanic or technician, mechanical technician, fabricator, rigger, and line or plant mechanic.
- A manufacturer needs at least one core-trade opening.
- If the only evidence is one generic maintenance or mechanic posting, it does not go into the V5 lane. A 10,001+ employee company with only one relevant posting goes to HOLD.
- **V5 Tier A:** 2 or more core-trade openings, or 3 or more relevant craft openings, in 30 days. **V5 Tier B:** 1 core-trade opening or thinner demand. Record `relevant_roles_30d` and `core_trade_roles_30d`.

## 8. Buyers

**Selection hierarchy, in rough order of yield:**
1. Plant, operations or production manager / GM, including yard general managers.
2. HR / talent acquisition (site or regional).
3. Maintenance or reliability manager.
4. Procurement or subcontract owner, where the company demonstrably buys subcontracted work.
5. Owner or executive, at small and mid-size companies, or an executive based at the site.
6. Superintendent or site leadership (yards, mills, utilities).

**Weak buyer roles (hold):** engineering managers with no workforce ownership, production supervisors, TA coordinators, and vague titles ("Manager", "Assistant Manager", "Plant Lead").

**Site-connection gate.** It applies to the buyer, never to the company. A company can qualify while a site buyer is unidentified. For a company of 1,001+ employees or unknown size, the buyer must be at the operating site, within about 50 miles, or hold verified centralized authority. An unrelated corporate executive fails. For smaller companies, a company-level buyer passes.

**Site tie labels:**
- `EXACT`: at the site.
- `REGION`: within commuting distance. Name the relationship, e.g. "Lake Charles is adjacent to Westlake, LA".
- `STATE`: same state, different city. Acceptable only when the company is single-site or small and the contact is a company-level buyer, or when the title names the site. Review every STATE record by hand.
- Corporate HQ only if the HQ is the plant, or the authority is verified.

For very large multi-site employers (Parker, Emerson, Honeywell, Caterpillar, Trane, Dow, Bobcat and similar), work the relevant plant only. For Bobcat, use manufacturing sites, not dealers.

**Hold these contacts:** remote executives such as PE-owner CEOs in another state; contacts at the wrong site or too far from it; possible job changes (check employment history, remove anyone retired or gone). After an acquisition, re-check authority.

**How many:** 1 contact by default; a 2nd for high-value companies; a 3rd only for large multi-site companies. Extra contacts must be at a different site or in a different buyer role.

**Buyer status values:** VERIFIED (role and employer confirmed by a dated public or company source), PARTIAL (old, undated, Apollo-only or unclear authority), NOT SITE-CONNECTED (fails the gate), NOT FOUND. An Apollo preview alone is PARTIAL at best, and a verified buyer is not a verified contact.

## 9. Email and deliverability

- Only Apollo work emails marked **VERIFIED**. Drop UNVERIFIED, INVALID and blank emails, and drop personal domains.
- **Do not bypass safeguards on risky Proofpoint catch-all addresses.** A Proofpoint catch-all contact stays on the sending-quality hold (readiness HOLD). A strong buying signal does not override deliverability, suppression or compliance restrictions. The live holds are in `integrations/clients/data/jole-deliverability-holds.json` on the production branch.
- **Other catch-all domains are kept but flagged** with `email_domain_catch_all = Y` and sent after non-catch-all contacts.
- Before a reveal, a free MX lookup shows the mail gateway. It can flag Proofpoint, but only a reveal shows catch-all status.
- **When the email domain differs from the company website**, check whether it redirects to the company site, or whether the company's own site confirms the link (parent, sister or legacy domain). Approve corporate mail domains such as cat.com, uss.com, p66.com and bepc.com. Hold unresolved domains. Remove when the domain belongs to an unrelated company (for example, alloy.com is a fintech).

## 10. Dedupe and suppression

Before approving, check every candidate against:
- **Prior Jole waves:** emails, Apollo person IDs and person+company in the files listed in reference.md. Don't re-reveal anyone already held or removed unless the hold reason has been resolved. Do not purchase the same contact twice.
- **Production `outreach_leads`, all clients:** email uniqueness is global, so an address that already belongs to ScaleLab or anyone else is refused, not reassigned. Dedupe by normalized domain and by company family, not by exact name.
- **Global suppression, `client_suppressions` and DNC.**
- **Duplicates within the wave:** person, email and Apollo ID. Merge subsidiaries into one company row.

## 11. Apollo credit protection

- Spend stays 0 unless the user gives an explicit cap for that run. Ask for the cap before any reveal. Keep a reserve (Phase 4 used a 900 cap with a 75-credit floor) and report spend at checkpoints, verified against the balance.
- Check `apollo_usage_stats_credit_usage_stats` before and after a run.
- **Confirmed free (balance-checked, Nov 2026):** `apollo_mixed_people_api_search` and `apollo_organizations_lookup`. People search masks last names and hides location, but `person_locations` works as a free site test. A preview is not a verified contact.
- **Do not use without a cap:** enrichment, `people_match`, `bulk_match`, `apollo_mixed_companies_search`, the job postings tool and the `apollo_agent_*` tools.
- Enrich only a company that is not EXCLUDED, has no open compliance gate, and is worth the credit on priority. Never enrich a corporate contact to get around the site gate.
- **Workflow with a cap:** free people search; check title and location; reveal through people-match with phone, waterfall and personal email off. Expect about 1.1 credits per usable contact. Stop when late rounds produce more holds than ready contacts.

## 12. Final QC and output

**Research runs** use the requalification columns in reference.md. Every company gets eligibility, score, priority and readiness, each with its evidence.

**Contact waves** give every record `APPROVED`, `HOLD` or `REMOVE` with a reason code: `weak_buyer_role`, `location_too_remote`, `wrong_site`, `employment_uncertain`, `no_longer_employed`, `email_issue`, `not_icp`, `duplicate`, `dnc`.

Write contact-wave files to a new dated folder next to the earlier phases, e.g. `JoleBTXLeadSample/Wave2_<YYYY-MM-DD>/`:
- Approved CSV, using the exact column schema in reference.md.
- Hold, removed, and no-valid-contact CSVs, each with reasons.
- An import payload JSON (shape in reference.md).
- A short report: totals by bucket, sector, priority and buyer type; the EXACT / REGION / STATE split; catch-all vs non-catch-all; credits spent and remaining balance; questionable accounts; and confirmation that nothing was sent, queued or imported.

**`why_contact_is_relevant` format for V5 leads:**

> "{title} at {company}, based at the hiring site [({site note})]; {company} posted {role} at {site}; {n} craft postings in the last 30 days ({m} core-trade)."

## 13. Import (only when asked)

- Import into client `jole` through the managed-client path: the authenticated client import route, or rows inserted into `client_lead_import_batches` in hash-checked chunks, staged and then set to pending so the server's import job processes them.
- Never use the legacy ColdEmail import. It stamps rows `scalelab`.
- Never create anonymous upload rules or weaken RLS.
- After import, reconcile: Jole total = previous total + new approved; every new lead at stage `Import`; 0 queued, 0 senders, 0 sends; correct campaign and template; no ScaleLab rows touched.

## 14. Freshness and send order

- **Evidence goes stale.** The live campaign refuses personalization when hiring evidence is older than 45 days. Re-verify close to launch, and don't source more than a few weeks ahead of sending.
- **V5 send order:** V5 Tier A before Tier B. Within a tier, non-catch-all EXACT-site contacts first. Lead with the non-fabrication sectors (Jorge named yards, refineries and pipelines first), then fabrication.

## 15. Examples

| Case | Correct | Incorrect |
|---|---|---|
| Contractor with verified workload (Walashek: $42.7M Navy boiler contract, self-performs) | QUALIFIED | Excluded or held for being a contractor |
| Group that self-performs and lists "Contract/Supplemental Labor" (Quality Companies) | CONDITIONAL, review competition | QUALIFIED because contractors are allowed, or EXCLUDED as a staffing firm |
| Aluminum boat builder short of welders (SAFE Boats) | QUALIFIED, no penalty | Marked down for aluminum or for Washington State |
| Navy repair yard, no verified restriction (East Coast Repair) | QUALIFIED; record per-contract checks | Excluded for Navy work, or assumed cleared for every contract |
| Project 90 days out, or 2030 first phase (Shintech) | Eligible; timing sets priority | Failed for missing a 30-day window |
| Qualified company, buyer not found | QUALIFIED, BUYER RESEARCH REQUIRED | Failed ICP, or a guessed buyer |
| 3,750 jobs with a local-hire pledge (Hyundai Translead), or $60M with 20 net new jobs (Fairbanks Morse Defense) | Score the reachable labor need | Score the headline |
| Project agreement with union referral (TVA) | EXCLUDED, naming the clauses and exceptions | "Union, so out" with no reading, or "defense-capable, so in" |
| USW plant with documented outside contractors (Metallus) | QUALIFIED, COMPLIANCE / PROCUREMENT REVIEW | Excluded for the union, or READY |
| Welding-equipment service firm (Arc Solutions) | EXCLUDED, no Jole crafts | Eligible because "welding" is in its description and contractors are allowed |
| Passed turnaround (Cenovus Lima) | Eligible, expired signal, NURTURE | Excluded, or shown as a live signal |
| Backlog growth, no posting | No hiring claim in copy | "Saw you were hiring welders" |
| Verified role in an aggregator listing with conflicting dates (Metal Shark) | Signal 1 POTENTIAL until confirmed at the source | Stated as verified hiring |
| Proofpoint catch-all at a Priority A company | HOLD | Sent because the signal is strong |

## 16. Where the next wave should look first

- **Expansion-pool names that one new trade posting would qualify:** General Dynamics Electric Boat, Great Lakes Dredge & Dock, Edison Chouest Offshore, Aries Marine, Texas International Terminals, Devon Energy, Ascent Resources and Cheniere Energy.
- **The 140 strict-cohort companies with no Apollo contact.** Try LinkedIn or company sites rather than Apollo.
- **Pipeline / midstream**, the thinnest sector (15 contacts). Grow it with midstream operators, and assess pipeline contractors under the contractor rule.
- **The 34 records in `Jole_Final_Review_Hold.csv`**, if their hold reason can be cleared with free checks.
- **The 38 requalified companies:** see `Jole_38_Requalified_Companies.csv` in Downloads. Priority A and B companies first.

## 17. Tests and maintenance

Run `python tests/test_skill.py` from this folder. It checks required clauses, superseded language, the regression fixtures and the 38 recorded decisions. Run it after any change here. `tests/decide.py` restates the mechanical rules, and SKILL.md wins any disagreement. Do not use `tests/` to decide a real company; apply this file. `tests/cold_session_check.py` explains how to test the policy text in a fresh session.

This folder is canonical, and it is deliberately outside any git branch so it loads in every session. A snapshot for version history lives in the SalesPipeline2 repo under `docs/jole-icp-skill/` and is never the source of truth. `~/.agents/skills/jolesbtxicpskill` is a pointer for Codex and holds no rules.

## Change log

**3.0.0 (2026-11-02).** Requested by the user after the 38-company research.
- *Why:* the old skill made hiring the definition of the ICP, so companies with strong non-hiring signals failed, and one tier mixed eligibility, demand and buyer quality.
- *Added:* confirmed capabilities; three separate dimensions; six-check eligibility; seven-signal taxonomy and evidence levels; a 100-point opportunity score with no geography or dollar input; ordered readiness gates; labor-agreement rules; Proofpoint hold; Apollo free and paid lists; examples; test suite.
- *Changed:* contractors moved from HOLD to eligible, with mixed firms reviewed and labor sellers excluded. Posting gates, single-posting gate and Tier A/B moved from ICP rules to the V5 lane. Aerospace/defense split so defense is no longer in the expansion pool. HQ rule now allows verified centralized authority. Buyer identity no longer affects eligibility.
- *Kept:* all DNC entries and named negatives, staffing exclusions, site-tie rules, email rules, dedupe, import rules, safety rules, early-stage holds, dealer and oilfield holds.
- *Superseded:* "end employers only"; "contractors stay out"; hiring evidence as a universal requirement; the 30-day need; any penalty for aluminum, geography or Navy work.
- *Verified:* `tests/test_skill.py` passed (16 tests). A fresh session with `tests/` removed loaded this skill unprompted and matched 14 of 14 cold-session cases.

**2.0 and earlier (to 2026-10-12).** Unversioned. Built from the 689-lead corpus (October 2026). Hiring-based ICP.
