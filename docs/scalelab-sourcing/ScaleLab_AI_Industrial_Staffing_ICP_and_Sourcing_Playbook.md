# ScaleLab AI — Industrial Staffing ICP & Lead-Sourcing Operating Playbook

**Document status:** Approved business direction; operational reference for Claude Code  
**Version:** 1.0  
**Effective date:** November 18, 2026  
**Owner:** ScaleLab AI  
**Primary use:** Instruct Claude Code how to source, qualify, prioritize, enrich, and prepare ScaleLab AI's *own* prospects.  
**Do not confuse with:** Jole BTX's separate campaign targeting industrial *employers* who may purchase skilled labor.

---

## 1. Mission and offer

ScaleLab AI targets **US-based industrial and skilled-trades staffing agencies** that want to acquire more employer clients. ScaleLab's offer is **performance-based employer-account acquisition / qualified employer meetings**. Our outbound system identifies potential employer accounts, reaches decision-makers, qualifies interest, and works to book meetings. The commercial positioning is **no qualified meetings that actually take place, no meeting fees**, subject to the actual client agreement.

**A prospect for ScaleLab** is a staffing/recruiting company (potential ScaleLab customer). **A prospect for Jole BTX** is an industrial employer (potential buyer of Jole's labor services). These are different account types, campaigns, target persons, and suppression domains. Never transfer Jole's industrial-employer location rules, lead list, sending capacity, or copy into ScaleLab sourcing.

### Guiding principles

1. **Quality before volume:** A small, validated pool is preferable to a large list of loosely matched companies.
2. **ICP fit and buying intent are separate judgments:** A company must first meet the ICP. Advertising activity cannot rescue a failed ICP.
3. **Employer acquisition is the primary buying-intent signal:** Ads aimed at getting *employer customers* matter far more than ads aimed at attracting job candidates.
4. **Evidence, not inference:** Preserve URLs, dates, exact excerpts, and confidence; do not invent service lines, ad spend, buyers, or intent.
5. **Spend late:** De-duplicate and qualify companies before paid signal checks and contact reveals wherever feasible.
6. **Reuse what exists:** Use SalesPipeline2's existing Claude Haiku personalization, validation, suppression, and routing paths. Do not build replacement agents.
7. **Separation of responsibilities:** Sourcing approves ICP; personalization validates the accuracy of message claims. Do not silently rerun a different, broader or narrower ICP gate in personalization.

---

## 2. Locked target ICP — mandatory PASS conditions

| Dimension | Hard requirement |
|---|---|
| Country | **United States**; operational business serving US employers. |
| Company type | Genuine **employer-facing staffing, recruiting, labor, or workforce-supply company**. It places/supplies people to external employer clients, not just its own worksites. |
| Specialization | **Meaningful, verifiable industrial, manufacturing, light-industrial, construction-craft, or skilled-trades staffing service**. A mixed-service agency passes if this is a genuine established service line. |
| Valid service models | Temporary/contract labor, temp-to-hire, contract-to-hire; **industrial skilled-trades direct hire** is eligible as a secondary segment. Contract/temporary labor gets priority. |
| Evidence | Company identity, website/domain, staffing service, and industrial specialization verifiable with source evidence (prefer first-party site). |
| Decision-maker | A current person with owner/executive or senior **commercial/budget authority** to buy employer-acquisition services. |
| Contact | Legitimate, company-associated business contact; verify employment, domain, status, and permissions/suppression before outreach. |
| Uniqueness | De-duplicate at company/domain and contact levels against all historical ScaleLab campaigns and suppressions. Default to **one best buyer per organization**. |

### Explicitly eligible staffing verticals

Welding, fabrication, electricians, millwrights, pipefitters/plumbers, CNC/machining, industrial maintenance, skilled construction crafts, manufacturing/production, industrial warehouse/distribution, heavy equipment, shipyards/marine industrial labor, oil-and-gas industrial craft staffing, light-industrial/warehouse labor **when genuinely employer-facing staffing**.

An agency need not cover every trade. A verified staffing service in one or more qualifying categories suffices.

### Preferred company characteristics (priority, **not** hard exclusions)

- **Independent/regional agencies** rather than large national chains.
- **~10–200 employees** as the initial *test* sweet spot. Do not reject a qualified agency solely for being smaller or larger; assign a lower priority or HOLD for manual review as appropriate.
- Established, functioning employer-facing operations.
- Recurring **temporary or contract labor** capability (potential for repeat employer revenue).
- Clear business-development or sales ownership.
- Multiple relevant trades or service markets; expansion evidence is a bonus.
- An identifiable budget owner who can quickly decide on performance-based meetings.

**No validated universal minimum revenue threshold exists.** Do not invent one or treat the 10–200 preference as historically proven conversion data.

### Buyer order

1. **Owner / Founder / President / CEO / Managing Partner** with current authority.
2. **Chief Revenue Officer / VP Sales / VP Business Development / senior commercial executive** with purchasing responsibility.
3. **Director of Sales / Director of Business Development** with demonstrable employer-acquisition and budget influence.
4. Other titles (e.g., Managing Director) **HOLD** unless their role and decision authority are independently supported.

Default **HOLD**, not automatic PASS, for generic managers, recruiters, account managers, branch/operations managers, weak or departed contacts, or ambiguous commercial authority. Reject role mailboxes (e.g., `info@`) as primary personalized buyers unless a separately approved exception exists. Do not lower buyer standards just to fill a list.

### Hard REJECT categories

- No substantive industrial/skilled-trades staffing service: IT-only, healthcare-only, executive/white-collar-only, finance/accounting-only, admin/office-only, hospitality/event-only, legal-only, agricultural-only, or cannabis-only recruiting.
- PEO/EOR/RPO-only businesses, HR software vendors, applicant systems, job boards, training firms, and general marketing/HR consultants without actual staffing delivery.
- General contractors, industrial service providers, defense contractors, maintenance contractors, or manufacturers **that merely hire tradespeople for themselves** and do not place staff with third-party employers.
- Outside the United States for this campaign.
- Fraudulent/inactive/unverifiable company identity, disallowed or suppressed prospect, duplicate organization/contact, or no eligible buyer after appropriate review.
- Huge national chains/franchise networks are generally out of target; classify **HOLD or REJECT with the specific commercial reason**, rather than inventing an absolute employee-count threshold.

**Mixed agencies:** Never reject a real industrial staffing agency just because it also recruits IT, healthcare, or professional staff. Verify its industrial line is meaningful and employer-facing.

---

## 3. Locked end-to-end sourcing workflow

**GetLeads → Jev ICP gate → Adyntel advertising evidence → Jev buying-intent classification and score → GetLeads/Apollo buyer discovery and contact reveal → verification → existing Claude personalization agent → SalesPipeline2 review/admission/measurement.**

### Stage 0 — Scope, deduplicate, and preserve costs

- Read the requested target count, geography, budget, campaign, and any additional constraints. If missing, use **US nationwide / industrial and skilled-trades agencies / read-only pilot of up to 100 companies / zero paid contact reveals or paid enrichments until authorized** as safe defaults.
- Inspect current ScaleLab source lists, V1, Campaign 2, active queue, sent/contacted, client records, domain-level and email-level suppressions, and previous enrichment outputs.
- Match exact domains plus normalized firm names; avoid accidental mergers of franchises or unrelated firms with similar names.
- **Do not modify or re-contact already contacted, unsubscribed, bounced, or suppressed records.**
- Check tool balances and rates before batch operations. Use checkpoints, caches, deduplication, sampling, and explicit budget ceilings.

### Stage 1 — GetLeads: broad *company* discovery

Find candidate US staffing/recruiting/labor firms using multiple relevant keywords and industry descriptions, including industrial staffing, skilled trades staffing, construction labor staffing, manufacturing staffing, fabrication recruiting, contract labor, light industrial, industrial warehouse, and related workforce solutions.

Required output: normalized organization name, website/domain, location, company category, available employee band, source record ID, source/provider, and any verified description. Do **not** pay to reveal all individuals at this stage. Broad discovery is *not* ICP approval.

### Stage 2 — Jev: hard ICP qualification

Supply Jev **only evidence obtained**, including first-party website/service excerpts and structured company data. Ask for structured **PASS / HOLD / REJECT** with reasons and citations.

- **PASS:** substantive US industrial/skilled-trades employer-facing staffing proved, identity supported, no known exclusion.
- **HOLD:** site inaccessible, mixed/ambiguous services, unclear company identity/geography, unclear decision-maker; evidence incomplete. HOLD is not a disqualification.
- **REJECT:** positive evidence of excluded business, non-US, contractor rather than labor provider, duplicate/suppression.

For each decision, save the exact industrial service evidence, source URL, observed date, source reliability, and rationale. Review borderline/HOLD cases separately. **An ad signal never overrides REJECT.**

### Stage 3 — Adyntel: capture advertising activity

Run Adyntel on **PASS companies first** to conserve lookups. Collect available platform, ad ID, creative text/landing page, advertised offer, active status, date last seen, count of ads, and source link. If Adyntel is unavailable or finds no ads, record **UNKNOWN/NO OBSERVED ADS**, not proof the company has no budget or desire for customers.

**Crucial:** Adyntel ad counts/activity are **not verified dollar ad spend**. Never translate ad counts to dollars or claim a company's budget without an independent credible source.

Classify observed creatives:

- `EMPLOYER_ACQUISITION`: Promotes staffing/labor services to *companies* (e.g., “Need welders for your facility? Get contract tradespeople”). **Strong primary intent evidence.**
- `CANDIDATE_RECRUITMENT`: Promotes jobs to workers (e.g., “Welders wanted; apply now”). **Operational activity, not proof of employer-client acquisition.**
- `MIXED`: Both buyer and candidate calls to action; preserve distinct examples and assess employer-facing proportion.
- `UNRELATED_OR_UNCLEAR`: Brand/ad intent cannot be resolved; do not score as employer acquisition.
- `NO_ADS_OBSERVED`: Absence of evidence, not negative commercial intent.

Require review of ad **creative/landing destination**, not merely a vendor label. Validate the ad belongs to the exact staffing company/domain and is current enough for a time-sensitive opener.

### Stage 4 — Collect other growth signals (where accessible and cost-effective)

- **Sales/BD hiring (25 pts):** Own-company positions specifically responsible for *winning employer accounts* (BDM, Director of Sales, Account Executive, new-client growth). Do not confuse staffing agency's advertised jobs *for client workers* with its internal commercial hiring.
- **Market/service expansion (15 pts):** Recent new branch, territory, industrial vertical, acquisition, or opening; source and date mandatory.
- **Sustained employer-facing ads (10 pts):** Several recent employer-facing campaigns or continued advertising over time. Ad count alone does not prove spend; prevent counting repeated creative duplicates as independent campaigns.
- **Other verified growth indicators (10 pts):** e.g., documented new sales leadership or commercial-team expansion; use evidence, not speculation.

Only run supplementary external lookups where access and budget allow; a missing signal is `UNKNOWN`, not a known negative. Do not fabricate or extrapolate job postings from the agency's worker job board.

### Stage 5 — Jev: buyer-demand / opportunity scoring

Use only **Stage 2 PASS** companies. Score with the following **approved initial experimental weights** (100 possible):

| Signal | Max points | Evidence threshold |
|---|---:|---|
| **Active employer-facing advertising** | **40** | Recent verified advertising directly offering staffing services to employers. |
| Own-company **sales/business-development hiring** | 25 | Dated company job posting explicitly describing employer-client acquisition. |
| Geographic/service-line expansion | 15 | Credible dated company announcement or comparable source. |
| Multiple/sustained employer-facing advertising campaigns | 10 | Independent current ad records and timeline; no creative double counting. |
| Other verified commercial-growth indicators | 10 | Supported new sales leader, sales-team growth, or similar. |
| **Total** | **100** | These weights are a hypothesis, not a validated statistical model. |

Save each component **separately**, supporting source, confidence, observed_at, score reason, and coverage/missingness. Never award advertising points for candidate-only ads. Do not infer money spent or willingness to buy ScaleLab from ad count. Score low-evidence qualified firms as **standard outreach/test cohort**, not automatic REJECT. Prioritize high-scoring companies for first contact while preserving a comparison/control group of ICP-qualified no-ad companies.

**Suggested operational buckets (testing defaults, not proven cutoffs):** `HIGH_PRIORITY >= 60`, `STANDARD 20–59`, `LOW_SIGNAL < 20`, and `INSUFFICIENT_EVIDENCE` when confidence is too low to interpret the score. Scores cannot replace the mandatory ICP gate or suppression checks.

### Stage 6 — Buyer discovery and contact enrichment

1. Identify the **single best current commercial decision-maker** at each priority PASS company.
2. Use company/people data already returned by GetLeads **if available**. Check current employment and matching domain.
3. Use **Apollo selectively** to reveal missing/insufficient contact information after eligibility and pre-reveal dedupe, within the explicit credit budget.
4. Validate deliverability and company association. Reject invalid, bounced, suppressed, and do-not-mail contacts; review catch-all addresses under the preapproved safety rules (never treat catch-all as assured delivery).
5. Avoid provider-only recipient restrictions: Gmail, Microsoft, and other valid hosted business emails may be eligible. The actual email status and safety policy decide.
6. Save provenance for buyer name, exact job title, contact source, verification status and date, and Apollo/GetLeads IDs for repeatable idempotent updates.

### Stage 7 — Personalize with SalesPipeline2's **existing** Claude agent

- Use the established SalesPipeline2 research/personalization paths such as `researchStaffingCompany`, `previewStaffingPersonalization`, `personalizeStaffingLead`, and `flagBatchDuplicates`, **after verifying the current repository paths**.
- Existing configured model was `claude-haiku-4-5` at last confirmed state; verify active production configuration instead of assuming.
- Produce verified Tier A (direct supported role-to-market fact) or Tier B (supported industrial-staffing positioning). **Tier B is valid; do not invent Tier A.**
- Verify factual email claims against saved evidence. **Do not promise that “10 employers” were actually found unless a real ten-account list exists for that contact** or the approved delivery process explicitly supports the claim.
- Preserve the latest explicitly approved ScaleLab campaign template/version, sender identity, email sequence, company data, attribution, and footer. Don't silently reuse an outdated V1 or rewrite the active V2 copy.
- **Do not rerun a separate industrial-only ICP pass over already approved contacts** during personalization. Flag genuine contradictory identity/eligibility evidence for human review.
- Cache results; do not repeat successful Claude calls. Distinguish website research failures from ICP failures.

### Stage 8 — SalesPipeline2 review, admission, and measurement

- Prepare an **import/review artifact** first; do not import or queue until instructed.
- Before admission: re-check suppression, dedupe, current contact state, correct campaign owner/version, verified personalization, all three email renders, current sender registry, reply/stop flags, and sending authorization.
- Never trigger test, manual, catch-up, or live sends without explicit user authorization. Existing sender health, per-sender caps, campaign-wide cap, per-window limits, follow-up reservations, and runtime holds are binding; don't assume historical `170/day` remains the current authorized cap.
- Keep ScaleLab and Jole sender pools, data, suppressions, clients, offers, and copy separate.
- Measure actual **positive replies, qualified meetings booked, meetings held, clients closed**, as well as bounce/deferral, unsubscribe and spam metrics. Ad/spend score is not a success metric by itself.

---

## 4. Required decision and evidence rules

**PASS / HOLD / REJECT is a company-level ICP gate.** `HIGH_PRIORITY / STANDARD / LOW_SIGNAL` is a downstream prioritization result. `READY_FOR_REVIEW / NEEDS_EVIDENCE / SUPPRESSED` is a contact/pre-send result. Do not collapse them into one yes/no field.

- **Evidence hierarchy:** first-party company site and careers page, official ad/landing-page artifacts, credible dated business announcement, verified provider records. Vendor classification alone is weaker evidence.
- **Time-sensitive data:** capture `observed_at` and `source_published_at`; mark older signals `STALE` rather than describing them as active. Do not impose an undisclosed fixed time window; report the one actually used in each batch.
- **Site inaccessible (403/timeout):** HOLD; reuse cached first-party data and corroborated records; don't label company off-ICP solely because retrieval failed.
- **Uncertain company identity:** HOLD until domain and business align. No confident identity = no reveal or sending.
- **Conflict:** preserve contradictory evidence and stop; human review rather than blindly overriding source data.
- **Invalid sender/recipient state:** no queue even for highest-scoring opportunities.
- **No advertising data:** keep company eligible; do not assert that it has no marketing budget.
- **Confidence:** provide separate classification confidence and evidence coverage. Never present AI confidence as factual validation.

### Required record schema (minimum)

```json
{
  "company_name": "Example Industrial Staffing",
  "domain": "example.com",
  "country": "US",
  "employee_band": "11-50",
  "company_source": "GetLeads",
  "company_source_id": "provider-record-id",
  "icp_decision": "PASS",
  "icp_reason": "First-party site documents contract welders and millwrights supplied to employers",
  "industrial_specializations": ["welding", "industrial maintenance"],
  "staffing_model": ["contract", "temporary"],
  "icp_evidence": [{"url": "https://example.com/services", "quote": "...", "observed_at": "YYYY-MM-DD"}],
  "advertising": {
    "lookup_status": "FOUND",
    "ad_platforms": ["Google"],
    "ad_type": "EMPLOYER_ACQUISITION",
    "active_ad_count": 2,
    "observed_at": "YYYY-MM-DD",
    "evidence": [{"url": "https://example.com/ad-evidence", "claim": "Employer-facing labor-services ad"}],
    "actual_ad_spend_usd": null
  },
  "signal_scores": {
    "employer_facing_ads": 40,
    "own_company_bd_hiring": 0,
    "market_expansion": 0,
    "sustained_employer_ads": 0,
    "other_commercial_growth": 0,
    "total": 40,
    "scoring_version": "initial-2026-11-18",
    "evidence_coverage": "partial"
  },
  "priority_bucket": "STANDARD",
  "buyer": {"name": null, "title": null, "email": null, "email_status": "NOT_REVEALED"},
  "contact_status": "NEEDS_CONTACT",
  "suppression_status": "UNKNOWN_NOT_YET_CHECKED",
  "personalization_status": "NOT_STARTED",
  "review_notes": []
}
```

**Schema examples are illustrative only.** Do not treat placeholder company details, links, dates, or scores as real evidence. Extend existing SalesPipeline2 schemas rather than migrating the database without approval.

---

## 5. Claude Code execution contract

Whenever instructed to source ScaleLab prospects:

1. **Read this playbook first.** Confirm the target campaign is ScaleLab's own customer acquisition, not Jole BTX. Check for superseding explicit user instructions.
2. **Inspect existing project integration and tool availability** before recommending or creating new code. Verify GetLeads, Jev/TypeSafe, Adyntel, Apollo, Anthropic and SalesPipeline2 capabilities instead of assuming endpoints or paid entitlements are connected.
3. **Plan a small read-only pilot** or execute the specifically authorized batch. State intended source counts, API/credit budgets, and checks before any paid reveal.
4. **Run the defined pipeline in order**: discover → dedupe → Jev ICP gate → Adyntel evidence → other signals → Jev score → buyer/contact → validation → existing personalization → review artifact.
5. **Use existing agents and checkpoints** wherever available. Don't invent APIs, spend unapproved credits, or silently substitute vendors/models.
6. **Return auditable outputs**, not just a count. Include PASS/HOLD/REJECT and reason distributions, evidence coverage, ad-intent distributions, score buckets, contact yield, per-provider credit usage, duplicate suppression, personalization readiness, and outstanding risks.
7. **Stop at review by default**: no production writes, queueing, changes to caps, or email sends unless explicitly authorized in the current task.
8. **On tool/data failure**, preserve checkpoints, fail closed, report precisely what was not verified, and propose the smallest safe next step.

### Required output files for a sourced batch

- `run-report.md` — counts, methods, cost, evidence coverage, decisions, blockers.
- `company-qualification.csv` — each discovered company and PASS/HOLD/REJECT with source evidence.
- `ad-intent-and-signals.csv` — each ad classification and dated secondary signal.
- `ranked-companies.csv` — signal breakdown, total score, confidence, priority bucket.
- `approved-contacts.csv` — only safe validated buyers, with source/verification metadata and no exposed secret tokens.
- `review-holds.csv` — every unresolved/rejected reason and what evidence would resolve it.
- Optional `import-ready.json` in existing SalesPipeline2 schema after proper guards.

Include a brief sample of highly ranked prospects with **actual evidence**; never create sample leads as though they were verified leads.

---

## 6. Historical evidence and lessons (not current production telemetry)

The following are previously reported ScaleLab campaign snapshots; reconcile against live data when asked about the current state.

- **Industrial Staffing Agency V1:** ~1,002 leads, ~2,522 emails in one campaign summary, ~938 first touches, 2 booked calls, 1 acquired customer (Jole). The approximate booked-call-per-first-touch ratio was **0.21%**. Other audit exports used different send-event definitions; do not combine their raw totals without ledger reconciliation.
- **Staffing Outreach Campaign 2:** Initial source list ~539 records, later production 537 contacts. Approximately **523/539 (97%)** buyer titles aligned with the intended commercial hierarchy. Broad V3 vertical screening was previously adopted, but **this new ICP intentionally narrows future ScaleLab sourcing back to industrial/skilled trades**.
- **Campaign 2 personalization recovery:** 195 previously held Tier B profiles adopted and queued, with 27 further review-only Tier B profiles prepared during a cache-only salvage. This experience demonstrated why ICP screening and personalization must remain distinct, and why the agent must reuse cached facts rather than refetch whole batches.
- **Current business goal:** Build toward **300–400 daily ScaleLab emails**, but this is an aspiration, not authorization to raise production caps or send unapproved emails. Capacity must be supported by verified sender health, lead supply, and current system permissions.

**Do not infer from these historical data that advertising intent, company size, sector, or score has been proven to predict meetings.** Run controlled comparisons of employer-facing advertisers, internal BD hirers, expanding firms, and qualified no-ad controls. Optimize using positive replies, meetings held, and customers—not unvalidated scores or raw send volume.

---

## 7. Short reusable command for future sourcing

> **Claude Code:** Follow `ScaleLab_AI_Industrial_Staffing_ICP_and_Sourcing_Playbook.md` for a ScaleLab prospect-sourcing run. Apply the industrial/skilled-trades ICP, source via GetLeads, qualify with Jev, use Adyntel employer-facing ad evidence as the strongest buying signal, score additional BD hiring/expansion signals, find the best buyer with GetLeads/Apollo, and prepare evidence-backed, de-duplicated leads for review. Reuse the existing Claude personalization agent only when authorized. **Do not spend unapproved credits, modify production, queue, or send.** Report results, costs, and holds with source evidence.

---

**Change control:** This playbook is the default for **new ScaleLab sourcing**. The user may change its rules explicitly. Changes to existing production contacts, current campaign copy, sender capacity, sending authorization, or Jole operations always require separate scoped instructions. The scoring weights and company-size preference are **locked as the initial test configuration**, not treated as scientifically validated facts.
