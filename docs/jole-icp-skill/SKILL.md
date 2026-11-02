---
name: jolesbtxicpskill
description: Jole BTX ICP skill. Source, qualify, enrich and QC new outreach leads for Jole BTX LLC (Jorge Guerrero) — US industrial end employers with verified skilled-trade hiring at a named site. Use ONLY when the user wants more leads for Jole / Jole BTX / Jorge, or is auditing, deduping, tiering or preparing Jole leads for import. Do not use for lead requests about any other client or ICP (e.g. ScaleLab staffing agencies); those have their own ICP skills.
---

# Jole BTX lead sourcing

Jole BTX LLC supplies **skilled-trade labor to industrial end employers** (CEO Jorge Guerrero). A lead is a site-level buyer at a US employer that is hiring craft workers *right now* and could take contract labor from Jole instead. The approved 689-lead corpus (Oct 2026) was built with the rules below; new waves must match it, not loosen it. Never broaden the ICP to hit a volume target — report the shortfall instead.

Before starting, check what exists: read [reference.md](reference.md) for prior-wave files and the output schema, and confirm the current production state (Jole lead count, campaign, suppressions) rather than assuming the last wave's numbers.

## Standing safety rules

- **Apollo credits: 0 unless the user gives an explicit cap for this run.** Searches are free; reveals cost 1 credit each. Ask for the cap before any reveal. Keep a reserve (Phase 4 used a 900 cap with a 75-credit floor) and report spend at checkpoints, verified against the Apollo balance.
- Never send, queue, assign senders, or enable Jole sending. Never import unless the user asks for the import in that task.
- Client id is always `jole` — never `jole-btx`. Campaign is `jole-btx-employer-acquisition`, template `jole-industrial-employer-v1`, lead niche `jole_employer`.
- Never guess or pattern-build emails. No phone, waterfall or personal-email reveals.
- Don't touch ScaleLab leads, campaigns or senders.

## 1. Company ICP (all gates must pass)

**Geography:** United States sites.

**Sector — exactly one of seven:**
1. Industrial fabrication / machinery
2. Metals / mining / paper / heavy industrial
3. Refining / petrochemical / LNG / chemical
4. Power / utilities
5. Shipyard / marine
6. Pipeline / midstream
7. Oil & gas producers / operators

**Manufacturing gate.** A manufacturer counts only as "industrial fabrication / machinery": machinery, industrial machinery, fabricated metal, metalworking, rail equipment, electrical equipment, oilfield equipment, or a manufacturer whose own description shows heavy fabrication (steel structures, tanks, pressure vessels, trailers, truck bodies, cranes, boilers, turbines, transformers). It also needs at least one **core-trade** opening, not just maintenance or operator roles.

**Business-model gate — end employers only.** The company must hire the trades for its own plant, yard, mill or site. Exclude anything that sells crews or labor, because that competes with Jole rather than buying from it:
- Staffing, recruiting, PEO and labor-service firms.
- Contractors-for-hire and industrial service firms. Named negative examples: Zachry, Turner Industries, Brock, Austin Industrial, TEAM Inc., Bilfinger, Koch Engineered Solutions, Bay Ltd., Taurus Industrial, and Upchurch (which sells workforce augmentation).
- Field-service-heavy companies (Martin Engineering and Nalco Water were held).
- Construction, EPC, mechanical and electrical contractors, Cat and John Deere dealers, and oilfield services go to **HOLD**, not ACCEPT. Contractors stay out unless the user or Jorge explicitly reopens them.

**Do-not-contact list:**
- SpaceX and SpaceXAI.
- The Kiewit family: Kiewit Offshore Services (KOS), TIC, and Weeks Marine.
- Karpower.
- Any current Jole client. Ask the user if this list may have changed.

**Outside the ICP by default (expansion pool — not rejected, not sourced):**
- Food, pharma/medical, consumer goods, packaging, plastics and packaging products.
- General aerospace/defense, electronics/semiconductors, automotive.
- Rail operators, and battery/solar component makers.
- Recreational or consumer boat builders.

**Hiring evidence (required):**
- At least one live **craft** posting at a named US site, posted in the last 30 days, and re-opened to confirm it is still accepting applications.
- **Core trades:** welder, fitter / pipefitter / shipfitter, machinist / CNC, millwright, boilermaker, electrician, I&E / instrument tech, and similar.
- **Relevant craft roles** also include maintenance mechanic or technician, mechanical technician, fabricator, rigger, and line or plant mechanic.
- **Sources:**
  - LinkedIn public job search (no login, last 30 days, by craft role and state, then by company).
  - The employer's own ATS or careers board (Workday, UKG, ADP, Paylocity, BambooHR, Workable, JazzHR, Oracle).
  - Indeed, ZipRecruiter, Glassdoor and SimplyHired block automated checks. Never use them as evidence.
- An undated "always hiring" page does not count, and neither do non-craft postings only. Union hiring-hall employers are out.

**Single-posting gate.** If the only evidence is one generic maintenance or mechanic posting, the company goes to the expansion pool, even in a core sector. A 10,001+ employee company with only one relevant posting goes to HOLD.

**Tiers:**
- **Tier A:** 2 or more core-trade openings, or 3 or more relevant craft openings, in the last 30 days.
- **Tier B:** valid ICP employer with 1 core-trade opening or thinner demand.

Record `relevant_roles_30d` and `core_trade_roles_30d` for each company.

**Hold these companies before spending credits:**
- Pre-revenue or early-stage developers.
- Borderline aerospace fabricators.
- Fuel distributors whose only opening is a single technician role.

## 2. Contacts (site-level buyers)

**Buyer roles, in rough order of yield:**
- Plant, operations or production manager / GM.
- HR / talent acquisition (site or regional).
- Maintenance or reliability manager.
- Owner or executive — at small and mid-size companies, or an executive based at the hiring site.
- Superintendent or site leadership (yards, mills, utilities).

**Hold — weak buyer role:** engineering managers with no workforce ownership, production supervisors, TA coordinators, and vague titles ("Manager", "Assistant Manager", "Plant Lead").

**Site tie** — the contact must be tied to the hiring site in the posting:
- `EXACT`: at the hiring site.
- `REGION`: within commuting distance. Name the relationship, e.g. "Lake Charles is adjacent to Westlake, LA".
- `STATE`: same state, different city. Acceptable only when the company is single-site or small and the contact is a company-level buyer (plant manager, GM, owner, HR), or when the title names the site. Review every STATE record by hand.
- Never corporate HQ, unless the HQ is the plant.

For very large multi-site employers (Parker, Emerson, Honeywell, Caterpillar, Trane, Dow, Bobcat and similar), work the posting's plant only. For Bobcat, use manufacturing sites, not dealers.

**Hold these contacts:**
- Remote executives, such as PE-owner CEOs in another state.
- Contacts at the wrong site, or too far from it.
- Possible job changes: check Apollo employment history, and remove anyone who has retired or left.

**How many per company:**
- 1 contact by default.
- A 2nd for high-value companies.
- A 3rd only for large, multi-site companies.
- Extra contacts must be at a different hiring site or in a different buyer role (operations vs HR).

**Apollo workflow** (only with an authorized cap):
1. Free people search.
2. Check title and location.
3. Reveal through people-match with phone, waterfall and personal email switched off.

Expect about 1.1 credits per usable contact. Stop when late rounds produce more holds than ready contacts; don't burn the cap.

## 3. Email rules

- Only Apollo work emails marked **VERIFIED**. Drop UNVERIFIED, INVALID and blank emails, and drop personal domains.
- **Catch-all domains are kept but flagged** with `email_domain_catch_all = Y`. About 43% of the approved corpus is catch-all.
- **When the email domain differs from the company website**, check whether it redirects to the company site, or whether the company's own site confirms the link (parent, sister or legacy domain).
  - Approve corporate mail domains such as cat.com, uss.com, p66.com and bepc.com.
  - Hold unresolved domains.
  - Remove when the domain belongs to an unrelated company (for example, alloy.com is a fintech).

## 4. Dedupe and suppression (before approving)

Check every candidate against:
- **Prior Jole waves:** emails, Apollo person IDs and person+company in the approved, hold and removed files listed in reference.md. Don't re-reveal anyone already held or removed unless the hold reason has been resolved.
- **Production `outreach_leads`, all clients:** email uniqueness is global, so an address that already belongs to ScaleLab or anyone else is refused, not reassigned.
- **Global suppression and DNC.**
- **Duplicates within the wave:** person, email and Apollo ID. Merge subsidiaries into one company row.

## 5. Final QC and output

Give every record a decision of `APPROVED`, `HOLD` or `REMOVE`, with a reason code:
- `weak_buyer_role`
- `location_too_remote`
- `wrong_site`
- `employment_uncertain`
- `no_longer_employed`
- `email_issue`
- `not_icp`
- `duplicate`
- `dnc`

Write the files to a new dated folder next to the earlier phases, e.g. `JoleBTXLeadSample/Wave2_<YYYY-MM-DD>/`:
- Approved CSV, using the exact column schema in reference.md.
- Hold, removed, and no-valid-contact CSVs, each with its reasons.
- An import payload JSON. Each row has `company`, `contactName`, `email`, `city` (the hiring site), `website`, `tradeType` (the sector), `evidence` (`why_contact_is_relevant`), and a `research` object holding the snake_case corpus columns. This feeds the `client_lead_profile_v1` profile.
- A short report covering:
  - Totals by bucket, sector, tier and buyer type.
  - The EXACT / REGION / STATE split, and catch-all vs non-catch-all.
  - Credits spent and remaining balance.
  - Questionable accounts.
  - Confirmation that nothing was sent, queued or imported.

**`why_contact_is_relevant` format:**

> "{title} at {company}, based at the hiring site [({site note})]; {company} posted {role} at {site}; {n} craft postings in the last 30 days ({m} core-trade)."

## 6. Import (only when asked)

- Import into client `jole` through the managed-client path: the authenticated client import route, or rows inserted into `client_lead_import_batches` in hash-checked chunks, staged and then set to pending so the server's import job processes them.
- Never use the legacy ColdEmail import — it stamps rows `scalelab`.
- Never create anonymous upload rules or weaken RLS.
- After import, reconcile:
  - Jole total = previous total + new approved.
  - Every new lead is at stage `Import`.
  - 0 queued, 0 senders, 0 sends.
  - Correct campaign and template.
  - No ScaleLab rows touched.

## 7. Freshness and send order

- **Evidence goes stale.** The live campaign refuses personalization when hiring evidence is older than 45 days (`maxEvidenceAgeDays: 45`). Re-verify postings close to launch, and don't source more than a few weeks ahead of sending.
- **Send order:** Tier A before Tier B. Within a tier, non-catch-all EXACT-site contacts go first. Lead with the non-fabrication sectors (Jorge named yards, refineries and pipelines first), then fabrication.
- **Copy** is role- and location-driven: "Saw {company} is hiring {role} in {location}". Every lead needs a verified role, a hiring site and a posting date, or it can't be personalized.

## Where the next wave should look first

- **Expansion-pool names that one new trade posting would qualify:** General Dynamics Electric Boat, Great Lakes Dredge & Dock, Edison Chouest Offshore, Aries Marine, Texas International Terminals, Devon Energy, Ascent Resources and Cheniere Energy.
- **The 140 strict-cohort companies with no Apollo contact.** Try LinkedIn or company sites rather than Apollo.
- **Pipeline / midstream**, the thinnest sector (15 contacts). Grow it with midstream operators; pipeline contractors stay held unless Jorge confirms they buy outside labor.
- **The 34 records in `Jole_Final_Review_Hold.csv`**, if their hold reason can be cleared with free checks.
