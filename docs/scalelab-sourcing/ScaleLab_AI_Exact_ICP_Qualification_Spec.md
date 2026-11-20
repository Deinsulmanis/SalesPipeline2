# ScaleLab AI — Exact ICP, Buying Signals & Lead Qualification Rules

**Status:** Operational source of truth for new ScaleLab AI prospect sourcing  
**Version:** 1.0 — November 19, 2026  
**Owner:** Deins Ulmanis / ScaleLab AI  
**Audience:** Claude Code and the SalesPipeline2 sourcing, enrichment, and personalization workflows  
**Scope:** ScaleLab AI's **own** customer-acquisition campaign ONLY. **Never apply these rules to Jole BTX.**

## 1. What we are selling and who buys it

ScaleLab AI sells a performance-based **employer-account acquisition** service to industrial and skilled-trades staffing agencies. We prospect employers on the staffing agency's behalf, qualify their interest, and generate qualified employer meetings. The commercial positioning is performance-based; the exact pricing and meeting-fee conditions must come from the current signed offer/agreement, not assumptions.

Our **target prospect is the staffing agency**, **not** the factory, shipyard, construction company, or industrial employer that needs staff. Those industrial employers are the staffing agency's potential customers. Jole BTX separately targets industrial employers and has its own ICP, data, and campaigns.

**Ideal prospect in one sentence:** An independent or regional **US industrial/skilled-trades staffing company** that genuinely supplies workers to external employers, has a reachable owner or senior revenue decision-maker, and shows evidence of actively trying to win more employer accounts.

## 2. Mandatory company ICP gates (all must pass)

| Gate | Exact PASS rule | HOLD when | REJECT when |
|---|---|---|---|
| **Geography** | Operates in the **United States** and serves US employer clients. | US operations cannot be corroborated. | Outside the US with no qualifying US operation. |
| **Actual business** | A real employer-facing staffing, recruiting, temporary labor, or workforce-supply company placing people with **third-party employer clients**. | The site is inaccessible or service model ambiguous. | Employer only hires its own workers, or is a contractor, software, job board, training, or marketing company without staffing delivery. |
| **Industrial specialization** | First-party or corroborated evidence of a **meaningful established industrial/manufacturing/light-industrial/construction-craft/skilled-trades staffing line**. | Industrial staffing is alleged by a database but not verified. | IT-only, healthcare-only, white-collar-only, or other excluded vertical with no substantive industrial line. |
| **Service model** | Supplies temps, contract workers, temp-to-hire, contract-to-hire, or industrial skilled-trades direct-hire placements. | Specific model unclear; industrial service may exist. | Merely publishes jobs or advises employers without staffing/placement services. |
| **Identity and evidence** | Exact company, website/domain, US operation, staffing service, and industrial line are supported by saved source URLs and dated excerpts. | Conflicting identities, 403/timeout, missing corroboration. | Inactive, fraudulent, irreconcilably unverifiable organization. |
| **Ownership and uniqueness** | Belongs to the ScaleLab prospect universe and is not already in ScaleLab's active/historical contacted or suppressed organization set. | Possible affiliate/franchise collision requires review. | Duplicate, previously contacted in a disallowed way, opted out, or otherwise suppressed. |

**Important distinction:** Company ICP eligibility is separate from buyer/contact readiness. A company can pass all company gates and still be **HELD FOR CONTACT** when no suitable senior buyer or safe email can be verified. Never send to it until the contact gate passes.

### Eligible specializations

- Welding, fabrication, structural steel, machining/CNC, industrial maintenance, millwrights, electricians, pipefitters, plumbers, and other skilled industrial crafts.
- Manufacturing, production, assembly, light industrial, warehouse/distribution **staffing**.
- Skilled construction-trades labor staffing, heavy-equipment trades, shipyard/marine industrial, and oil-and-gas industrial craft staffing.
- Mixed-service agencies **if** their industrial/skilled-trades line is substantive and visibly offered to employer clients. **Do not disqualify an agency merely for also offering healthcare, IT, or office staffing.**

### Preferred characteristics — scoring preferences, **not** mandatory exclusions

1. Independent/regional firms rather than enormous national chains or sprawling franchises.
2. Initial experimental sweet spot of approximately **10–200 employees**. Smaller/larger does **not** automatically fail.
3. Temporary/contract labor capability, because recurring employer business can make the acquisition offer attractive; qualified industrial direct-hire agencies remain eligible.
4. An established industrial staffing service, clear employer-client sales owner, and ability to decide quickly.
5. Multiple relevant trades, branch locations, or employer verticals where supported.

**Do not invent a revenue minimum, absolute employee ceiling, or proof that these size preferences predict conversion.** For very large chains, HOLD/REJECT only with a recorded specific reason (e.g., central procurement or franchise complexity), not an arbitrary number.

### Hard exclusions (even if they have active ads, hiring, or revenue)

- IT-only, healthcare-only, executive search/white-collar-only, finance/accounting-only, general office/admin-only, hospitality/events-only, legal-only, agriculture-only, or cannabis-only agencies **without** a substantive industrial staffing line.
- PEO/EOR/RPO-only companies, HR consultants, training vendors, workforce software, ATS products, job boards, and pure recruitment-marketing businesses that do not actually fill positions for employer clients.
- Industrial employers, construction contractors, manufacturers, maintenance vendors, and defense contractors hiring tradespeople **for their own teams** rather than supplying workers to other businesses.
- Non-US agencies without verified US employer-facing operations.
- Fraudulent/inactive/unverifiable companies, duplicates, previously disallowed contacts, unsubscribe/suppression matches.
- Candidate-only recruitment sites with no validated offer to business customers.

**Hard gates always overrule intent.** A healthcare-only agency buying thousands of dollars in ads is still an ICP rejection; an industrial manufacturer opening a plant is still *not a ScaleLab prospect*.

## 3. Required buyer and email qualification

### Buyer priority

1. **Owner / Founder / Co-founder / President / CEO / Managing Partner** (current position).
2. **CRO / VP Sales / VP Business Development / senior commercial executive** able to purchase employer acquisition.
3. **Director of Sales / Director of Business Development** with documented responsibility for new employer/client accounts and budget influence.
4. Managing Director or equivalent only when authority is independently clear; otherwise HOLD.

Do **not** automatically choose recruiters, staffing coordinators, branch managers, operations managers, generic HR managers, or account managers. A person responsible only for **finding candidates** is normally not the buyer for employer-account acquisition. Default to **one best buyer per company**; additional contacts require a reason and separate authorization.

### Contact admission gates

- Verify that the named person currently works for this exact company, the title is current enough, the email belongs to that business, and the person has commercial/budget authority.
- Verify deliverability and safety status according to SalesPipeline2's current recipient policy; catch-all is **not** equivalent to verified deliverability.
- De-duplicate company domain **and** individual email against all current and retired ScaleLab campaigns, queued/sent leads, replies, opt-outs, bounce holds, and suppression tables.
- `info@`, `sales@`, and other role inboxes do not qualify as the default named decision-maker. Hold unless explicitly approved.
- Do not reveal/purchase a contact just because a tool has an available email. ICP approval, company deduplication, and buying relevance come **first**.

If the company qualifies but the buyer/email fails, output `company_icp=PASS`, `contact_status=HOLD`, and the exact missing verification. **Never silently downgrade the buyer requirement to fill a quota.**

## 4. Buying intent signals — what matters most

These are **priority signals after the hard ICP gates**, not mandatory proof that the agency is ready to pay ScaleLab. Classify the underlying evidence correctly; jobs advertised *on behalf of client employers* are not the agency's internal sales hiring.

| Signal | What qualifies | What does **not** qualify | Initial weight |
|---|---|---|---:|
| **Active ads seeking employers** | Verified current Google/LinkedIn/Meta/etc. ad offering staffing services **to business customers** (e.g., “Need contract welders at your plant?”); confirm ad creative and destination belong to target agency. | “Welders wanted—apply today,” general brand exposure, platform tag without creative, ad count without buyer-directed offer. | **40** |
| **Own-company BD/sales hiring** | Dated internal posting for BDM, employer-account AE, staffing sales, VP Sales, or similar whose role includes winning **new client/employer accounts**. | Candidate roles posted for third-party clients, recruiter/candidate-sourcing jobs, generic undated sales references. | **25** |
| **Market/service expansion** | Dated credible evidence of a new staffing branch/market, industrial vertical, service territory, or strategic acquisition. | Opening of a customer's factory, unverified aspirations, ancient announcements presented as current. | **15** |
| **Sustained employer-facing ads** | Multiple distinct, verified employer-client acquisition campaigns/creatives observed over time; require evidence beyond one repeated ad. | Raw ad quantity or duplicated creatives assumed to represent spend or new campaigns. | **10** |
| **Other commercial-growth evidence** | Newly appointed commercial VP, expanded employer-sales team, substantial employer-targeted sales/marketing initiative with credible source. | Candidate job-board volume alone, vague growth language, inferred marketing budgets. | **10** |
| **Maximum** | Five independently justified components; cap each at its assigned value. | No extra points for hallucinated or inferred signals. | **100** |

**This weighting is the approved initial TEST rubric, not a statistically validated prediction model.** Treat scores as internal prospect priority, not factual buying readiness. Retain version `initial-2026-11-18` until Deins explicitly approves changing it.

### Practical buying-signal interpretation

- **Highest-value near-term targets:** An ICP-PASS agency running employer-acquisition ads **and/or** hiring its own business-development representatives to win employer accounts. Combination and independent corroboration are especially interesting.
- **Strong secondary evidence:** New territory/branch/service-line expansion and new senior commercial leadership.
- **Weak alone:** A large list of job openings for forklift operators/welders, high candidate ad volume, recruiter hiring, general site traffic, or growing LinkedIn following. These can prove the business is operating; they do **not** prove it is investing in employer acquisition.
- **No ads detected** does not mean zero advertising spend, no growth, no budget, or no demand for our service. Keep ICP-PASS companies eligible for the no-ads comparison group.
- **Adyntel activity/ad counts do not show verified spend.** Never estimate ad budget, ad spend, CAC, or willingness to outsource from ad count; actual verified budget may only be recorded from an independent credible source.

### Priority buckets (separate from existing personalization tiers)

| `signal_priority` | Default cutoff | Meaning |
|---|---:|---|
| `HIGH_PRIORITY` | 60–100 | First prospecting/research priority; evidence for points still required. |
| `STANDARD` | 20–59 | Qualified and worth testing, even with only one strong signal. |
| `LOW_SIGNAL` | 0–19 | Qualified but relatively little observed commercial growth evidence. Not an ICP rejection. |
| `INSUFFICIENT_EVIDENCE` | N/A | Not enough reliable/dated information to interpret score fairly; hold for research. |

**Do not overwrite SalesPipeline2's existing personalization `leadTier` (Tier A/Tier B) with these buckets.** Existing Tier A/B describes supported personalized email claims and must remain independent from buying-signal priority. Score a company only after its company ICP is PASS.

## 5. Evidence, freshness, and decision policy

**Each qualification claim must have:** source URL, directly relevant quote/summary, access/observation date, publication date when available, what the evidence proves, and confidence/coverage. First-party service/careers pages, actual live ad creatives and landing pages, and dated official announcements take priority over vendor labels or model guesses.

- **Company identity:** Match legal/trading name and domain. Avoid merging unrelated firms with similar names or separate franchisees without support.
- **Industrial service:** Cite wording that proves staffing **for client businesses**, not just a list of industrial job postings.
- **Ad classification:** Store `EMPLOYER_ACQUISITION`, `CANDIDATE_RECRUITMENT`, `MIXED`, `UNRELATED_OR_UNCLEAR`, or `NO_ADS_OBSERVED`. Verify creative/landing page, not a platform category alone.
- **Freshness:** Record `observed_at` and `published_at` for every temporal signal. Before each research batch, define/report the actual lookback windows used; older evidence becomes `STALE`, not "currently active." Never quietly impose a different window.
- **Missing page/403/timeouts:** `HOLD`, with a research reason. Reuse previous verified cached evidence if still credible. Absence of accessible evidence is not proof of non-fit.
- **Conflicting evidence:** `HOLD` for manual reconciliation. Higher confidence does not permit rewriting a contradicted source.
- **Human/AI classifier uncertainty:** Structured `HOLD`; no forced PASS/REJECT based on weak guesses. Keep provider/model classification separate from factual evidence.
- **False implication:** Do not say a firm *needs* ScaleLab or is willing to outsource employer acquisition merely because it is advertising, hiring, or growing.

### Three independent decisions

1. `company_icp`: `PASS` / `HOLD` / `REJECT` — industrial staffing business fit.
2. `signal_priority`: `HIGH_PRIORITY` / `STANDARD` / `LOW_SIGNAL` / `INSUFFICIENT_EVIDENCE` — **only after company PASS**.
3. `contact_status`: `READY_FOR_REVIEW` / `NEEDS_EVIDENCE` / `SUPPRESSED` — buyer, email, dedupe, and outreach eligibility.

Never collapse these into one "good lead" flag.

## 6. Mandatory workflow for Claude Code

1. **Confirm campaign scope:** ScaleLab AI acquiring staffing agency customers, **not Jole BTX**. Default geography: **US only**.
2. **Read current SalesPipeline2 data:** Inspect past ScaleLab V1, Campaign 2, active/queued/contacted leads, reply and suppression states before sourcing new companies. Do not mutate existing lead states.
3. **Discover companies:** Use GetLeads or already connected approved discovery tools to find **company-level** candidate staffing agencies. Never interpret raw vendor results as ICP-approved.
4. **Dedupe first:** Exact domain, normalized company name plus human review of franchises and related domains. Remove known active/previous/suppressed records.
5. **ICP review with Jev/approved existing classifier:** Verify first-party services, US geography, and employer-facing industrial staffing. Assign `PASS`, `HOLD`, or `REJECT` with evidence and reason code. **No buying-signal or paid contact work on REJECT/HOLD.**
6. **Capture employer ads:** For PASS companies, use Adyntel where configured. Inspect **ad text and landing page** and classify whether it sells staffing to employers or tries to recruit job candidates. Do not infer spend.
7. **Capture other signals:** Own-company BD hiring, expansion, sustained employer ads, new commercial leadership. Save actual sources/dates. Missing signals are `UNKNOWN`, not zero budget or failure.
8. **Score with the fixed 40/25/15/10/10 rubric**, plus evidence coverage and priority. Preserve a test/control set of ICP-PASS firms with no observed ads.
9. **Identify buyer:** GetLeads existing data first, then selectively Apollo for verified senior commercial buyers, **only with explicitly authorized credit budget**. Confirm title, employment, company match, email status and suppressions.
10. **Use existing SalesPipeline2 Claude Haiku personalization agent only when separately authorized.** Validate every factual claim against evidence and preserve the approved campaign template. Never invent a list of ten employers unless that list exists.
11. **Produce review artifacts**, not production changes. No CRM movement, lead import, campaign queueing, email sending, sender-cap change, paid API lookup, or new system deployment without explicit task-specific authorization.

**Safe defaults when user supplies no batch settings:** US nationwide; industrial/skilled-trades staffing; **read-only pilot of up to 100 companies**; **zero paid reveals/enrichments**; no sending or CRM writes. Confirm target counts and cost ceiling for larger or paid runs.

## 7. Required per-company output contract

Adapt to existing SalesPipeline2 schema; preserve these concepts even if field names differ. Do not apply a database migration just to fit this example.

```json
{
  "owner_workspace": "scalelab",
  "company_name": "<verified company name>",
  "company_domain": "<verified domain>",
  "country": "US",
  "company_source": "GetLeads",
  "company_source_id": "<source ID>",
  "employee_band": null,
  "company_icp": "PASS | HOLD | REJECT",
  "icp_reason_code": "VERIFIED_INDUSTRIAL_STAFFING | NO_INDUSTRIAL_LINE | NOT_STAFFING | NON_US | UNVERIFIED | DUPLICATE | SUPPRESSED | OTHER",
  "industrial_service_lines": [],
  "staffing_models": [],
  "icp_evidence": [
    {"url": "<source>", "excerpt": "<factual text>", "observed_at": "YYYY-MM-DD", "published_at": null}
  ],
  "ad_class": "EMPLOYER_ACQUISITION | CANDIDATE_RECRUITMENT | MIXED | UNRELATED_OR_UNCLEAR | NO_ADS_OBSERVED",
  "ad_evidence": [],
  "verified_ad_spend_usd": null,
  "signals": {
    "employer_facing_ads": {"points": 0, "evidence": []},
    "own_company_bd_hiring": {"points": 0, "evidence": []},
    "market_expansion": {"points": 0, "evidence": []},
    "sustained_employer_ads": {"points": 0, "evidence": []},
    "other_commercial_growth": {"points": 0, "evidence": []},
    "total": 0,
    "version": "initial-2026-11-18",
    "evidence_coverage": "FULL | PARTIAL | INSUFFICIENT"
  },
  "signal_priority": "HIGH_PRIORITY | STANDARD | LOW_SIGNAL | INSUFFICIENT_EVIDENCE",
  "buyer": {"name": null, "title": null, "email": null, "employment_verified_at": null},
  "contact_status": "NEEDS_EVIDENCE",
  "dedupe_status": "CHECKED | NEEDS_REVIEW | DUPLICATE",
  "suppression_status": "CLEAR | SUPPRESSED | UNKNOWN",
  "personalization_tier": null,
  "review_notes": []
}
```

Literal strings with `|` show **allowed alternatives**, not valid final enum values. Placeholder text and example sources must never appear as real contacts/evidence in output.

### Deliverables for any actual sourcing batch

- `company-qualification.csv` — every evaluated company, company decision, rejection/hold reason, source URLs.
- `ad-intent-and-signals.csv` — actual ad text/landing destination, candidate vs employer intent, dated other signals.
- `ranked-companies.csv` — scoring breakdown, evidence coverage, priority and reason.
- `approved-contacts.csv` — **only** qualified, verified, non-suppressed senior buyers; no exposed tokens/credentials.
- `review-holds.csv` — unresolved companies/contacts, exactly what evidence is missing.
- `run-report.md` — total discovered, PASS/HOLD/REJECT, score bucket distribution, dedupes, verified contact yield, credits used, sources, uncertainty, and what actions (if any) were actually authorized.

## 8. Test examples — expected outcomes

| Prospect scenario | Company ICP | Signals | Admission decision |
|---|---|---|---|
| US staffing agency explicitly supplies contract welders, millwrights and plant maintenance crews to employer clients. CEO's business email verified. Running ads saying "Need skilled tradespeople at your facility?" | **PASS** | +40 ad; consider other independently verified signals | Review-ready if all dedupe, bounce and suppression checks pass. |
| US industrial staffing agency with verified temporary industrial labor service, no ads found, buyer validated. | **PASS** | Lower / unknown; retain no-ad control candidate | Can be review-ready; **never reject for lacking ads**. |
| US industrial staffing agency publishes 200 open welder jobs **for client employers** but no evidence of internal BD hiring. | **PASS** if company service proven | **0** for BD hiring; candidate jobs alone do not score | Review for buyer/contact normally. |
| IT-only recruiter paying for Google ads. | **REJECT** | Do not score | Do not reveal Apollo contact or import. |
| Manufacturer hiring 60 machinists for its own production line. | **REJECT** | Not a ScaleLab staffing-agency prospect | This could be a *different* client's employer lead; do not cross-use. |
| US staffing firm website timed out; vendor claims "industrial" but there is no proof. | **HOLD** | Do not score yet | Investigate first-party/cached/corroborated evidence; no credits or outreach. |
| Qualified regional industrial agency but only a recruiter is found, no owner/sales buyer. | **PASS** | Score normally | **HOLD contact**, not automatic outreach. |
| Mixed industrial + healthcare staffing company with a substantive employer-facing manufacturing staffing division. | **PASS** | Score normally | Eligible; mixed vertical alone is not exclusion. |

## 9. Non-negotiable operating boundaries

- **ScaleLab-only.** Do not change, source, classify, suppress, send for, or otherwise touch Jole BTX.
- **No paid credits without permission.** Check Apollo/GetLeads/Adyntel/Jev entitlements and usage; if uncertain, stop before chargeable operations.
- **No production side effects by default.** A completed analysis does not authorize CRM writes, queueing, migration, deployment, or sending.
- **Never overwrite existing campaigns' lead tiers, templates, ownership, suppression, or advanced CRM stages.** Existing personalization Tier A/B and buying-signal priority are different fields.
- **Never fabricate evidence, ad budgets, email validity, decision authority, or "buying intent" certainty.** A `HOLD` is an honest and valuable outcome.
- **Respect current approved sending caps and identity.** Prior aspirational volumes (e.g. 300–400 ScaleLab emails/day) are not sending authorization.
- **Optimize on actual commercial outcomes:** positive replies, qualified meetings booked/held, customer wins; also track bounces, opt-outs, and spam. Do not claim this scoring system has been validated until measured on new cohorts.

---

**Instruction for Claude Code:** Read this file before sourcing or enriching **ScaleLab AI** leads. Apply hard ICP first, gather buyer-specific evidence, prioritize employer-client acquisition signals, retain auditable HOLD decisions, and deliver reviewable outputs. If live repository configuration conflicts with a stated assumption, inspect and report the discrepancy; do not silently change business rules. Any explicit new instruction from Deins supersedes this document for the authorized task only.
