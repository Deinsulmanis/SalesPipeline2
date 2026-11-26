# Non-staffing niche scan: 2026-11-26

Read-only market-demand pass. It applies the segment method from `demand-signals-2026-11-26.md` (Layer A demand signals, Layer B scorecard, kill rules; on branch `claude/eloquent-sagan-oh7bu6`) to five **non-staffing** client niches. The ScaleLab offer is the same in every case: we find US employers through hiring signals and book meetings for the client firm with those employers' decision-makers.

- **Window:** last 90 days (2026-08-28 to 2026-11-26) where dates were visible.
- **Privacy:** no personal data. Only counts, company-level names, public prices and paraphrases are recorded. Posts by named individuals were counted but not linked.
- **Spend:** 0 credits (details at the end).

## Ranked result

Combined score = 50% Layer A + 50% Layer B. A niche that trips a kill rule is ranked below every surviving niche, whatever its score.

| Rank | Niche | Combined | Layer A (demand) | Layer B (scorecard) | Kill rule | Supportable $ / meeting |
|---|---|---|---|---|---|---|
| 1 | Freight brokers / 3PLs | **70.3** | 80.6 | 60 | pass | $250-600 (agents ~1/3 lower) |
| 2 | Industrial & facility services (best sub-trade: **fire protection ITM**) | **67.5** | 59.1 | 76 | pass | fire $150-375 first year (recurring); roofing $450-1,125; cleaning $108-270 |
| 3 | Commercial / WC insurance agencies (industrial & construction) | **66.2** | 64.4 | 68 | pass | $250-600 realistic ($360-900 on paper) |
| 4 | *Industrial staffing (baseline)* | *63.7* | *43.4* | *84* | *pass* | *~$570-3,500 (estimate, see below)* |
| 5 | PEO / payroll / HR outsourcing | 45.6 | 39.3 | 52 | **KILL: core pool < 1,500** | PEOs $600-1,800; brokers $100-250 |
| 6 | Background screening & drug testing | 32.9 | 17.9 | 48 | **KILL: client value too low** (employers < 250 staff) | $43-108 (100 staff) to $135-338 (250 staff) |

### Layer A components (0-100 within these six; weights 30/25/20/15/10)

| Niche | Paid requests (30) | BD hiring (25) | Pain (20) | Competitors (15) | Search (10) |
|---|---|---|---|---|---|
| Freight brokers / 3PLs | 100 | 100 | 48 | 92 | 21 |
| Industrial & facility services | 28 | 87 | 36 | 100 | 68 |
| Commercial / WC insurance | 47 | 85 | 76 | 92 | 0 |
| Industrial staffing (baseline) | 28 | 38 | 54 | 77 | 31 |
| PEO / payroll / HR | 36 | 14 | 46 | 38 | 100 |
| Background screening | 17 | 2 | 34 | 15 | 34 |

The baseline is rescored inside this six-niche set using its raw inputs from 2026-11-26 (5 paid posts with 0 dated, pain intensity 2 with 3 items in 90 days, 10 competitors). That is why it shows 43.4 here and 47.4 in the staffing-only report.

### Layer A raw inputs

| Niche | Paid posts (total / dated 90d) | BD hiring: est. distinct US companies, Sales/BD role with niche word in title, since 2026-08-28 | Pain items (total / 90d) | Intensity 1-5 | Niche-specific competitors | Search: share change vs "industrial staffing" (last 13 wk vs prior 13) |
|---|---|---|---|---|---|---|
| Industrial staffing (baseline) | 5 / 0 | ~75 (222 "staffing" titles x ~34% industrial share from the baseline) | 12 / 3 | 2 | 10 | 0 (control: raw -41%) |
| Commercial / WC insurance | 4 / ~0.5 (one "posted 2 weeks ago" snippet, unverified) | ~165 (236 "commercial insurance" titles, ~70% assumed in-niche) | ~14 / 4 | 3 | 12 | -22% ("workers comp insurance" raw -54%) |
| PEO / payroll / HR | 2 / ~0.5 (one snippet, about 2 months old) | 27 ("PEO" titles; payroll-only firms missed) | ~11 / 1 (vendor) | 3 | 5 | +49% ("peo"; ambiguous term, low confidence) |
| Background screening | 3 / 0 | ~3 (11 "screening" titles, mostly medical screening) | 8 / ~1 | 2 | 2 | +2% ("background check company") |
| Industrial & facility services | 5 contractor-direct / 0 (9 incl. lead-gen agencies reselling) | ~170 (182 "fire" titles at ~80% in-niche per a 40-company sample, ~120 net of duplicate slugs; plus ~50 commercial-roofing titles) | ~9 / 0 | 3 | 13 | +26% (average of commercial roofing +25%, commercial cleaning +18%, fire inspection terms +34%) |
| Freight brokers / 3PLs | 9 / 1 (2026-11-03) | ~195 (245 "freight" titles, ~80% assumed brokers/3PLs; carriers mixed in) | 11 / 0 | 4 | 12 | -7% ("freight broker" raw -45%) |

The search terms all fell 30-55% raw (Aug-Nov vs May-Aug seasonality), so each is shown as a share of "industrial staffing". The client-side phrases ("staffing agency leads", "freight broker leads", "commercial cleaning appointment setting") were near zero and could not be trended. Only "roofing leads" (mostly residential) and "insurance appointment setting" had volume, and both fell about 46%.

### Layer B scorecard (1-5 each; 5 = best; headwinds 5 = mild)

| Niche | Growth | Client value | Firm pool | Headwinds | Fulfilment fit | /25 |
|---|---|---|---|---|---|---|
| Industrial staffing (baseline) | 4 | 5 | 4 | 3 | 5 | 21 |
| Industrial & facility services | 4 | 3 | 5 | 3 | 4 | 19 |
| Commercial / WC insurance | 2 | 4 | 5 | 2 | 4 | 17 |
| Freight brokers / 3PLs | 3 | 2 | 5 | 2 | 3 | 15 |
| PEO / payroll / HR | 3 | 4 | 1 | 2 | 3 | 13 |
| Background screening | 2 | 2 | 2 | 2 | 4 | 12 |

### Kill-rule check

| Niche | >= 1,500 reachable firms? | Value supports pay-per-meeting? | Buyers reachable by email with our signals? |
|---|---|---|---|
| Freight / 3PL | Yes: 25,087 active brokerage MCs (Apr 2025, down 18% in 2 years); GetLeads 2,681 broker/3PL companies | Marginal: $250-600 supportable, but the market anchor is an offshore setter at $400-1,400/mo | Yes: logistics/transport managers; new DCs and plants, logistics hiring |
| Facility services | Yes: fire 6,044 (description) / 720 (LinkedIn industry) / 19,845 fire & security installers (IBISWorld); commercial roofing 1,583; commercial electrical 2,061; millwright/rigging 2,088; industrial cleaning 1,093 | Yes for fire (recurring, >50% GM) and roofing; cleaning is capped at about $135 | Yes: facility/plant/maintenance managers; new locations and permits create code-driven need |
| Insurance | Yes: ~37,000 independent agencies; GetLeads 7,640 commercial-insurance agencies (2,116 with 11+ staff). WC/construction specialists by description are only 983-1,076 | Yes: $12k commission per $100k-premium account | Yes: the same manufacturers and contractors ScaleLab already targets. Renewal timing is the weak point |
| PEO / payroll | **No for the core**: ~502 PEOs (NAPEO, end-2025) + ~300 payroll bureaus ≈ 800-1,000. GetLeads: 597 PEO-described, 3,001 with HR-consulting dilution | Yes for PEOs; no for brokers | Partly: renewal timing is invisible, and the buyer profile skews white-collar |
| Background screening | Borderline: IBISWorld 1,018-1,597 screeners; GetLeads 3,058 by description, 1,180 in relevant industries, 797 with 11+ staff | **No for employers < 250 staff** ($43-108 per meeting) | Yes, best signal match of all (high-volume hourly hiring) |

## How to read this

1. **Freight ranks first on demand, not on economics.** It has the most paid requests and BD hiring, but the budgets anchor to $400-1,400/month offshore setters and $50 Fiverr gigs. No freight vendor publishes a per-appointment price. Shippers are flooded with broker outreach, and a new shipper starts with trial lanes. Treat it as a large, noisy, price-sensitive market. A pay-per-meeting test would need a floor price that brokers rarely post.
2. **Fire protection is the cleanest new fit.**
   - Our new-location and permit signals map causally onto a code-mandated need (NFPA 25/72 inspection).
   - The work recurs at >50% gross margin, and the market grows ~7%/yr.
   - About 120 distinct fire firms (many PE-backed roll-ups) posted sales roles in 90 days.
   - No competitor publishes a fire-specific per-appointment price.
   - Weak spot: almost no public paid requests (0 found), so demand is inferred, not observed.
   - Within the niche, janitorial is saturated ($110-225 per appointment, 15+ Fiverr sellers). Roofing has high tickets but weak hiring signals (only permits fit).
3. **Insurance has the strongest pain and reuses our employer data directly.** The prospects are the same manufacturers and contractors. Organic growth is slowing (7.1% in Q4 2025, down from 11.2%), and new business now drives revenue. Vendors already charge $300-550 per held meeting.
   - Against it: the soft WC market, PE roll-ups, distrust of appointment vendors, and annual renewal timing that hiring signals can't see.
   - Public WC expiration (x-date) data could fix the timing gap.
4. **None of the new niches beats the baseline on Layer B.** Industrial staffing still has the best client value and signal fit. The new niches win on Layer A only because staffing-agency demand is weak in public channels.
5. **PEO and background screening fail kill rules.**
   - PEO: the core pool is too small. It only clears 1,500 by adding brokers, HR consultancies and CPA payroll shops, which are different buyers with far lower value.
   - Background screening: the value per employer account is too small for pay-per-meeting except at 250+ staff or DOT fleets.

## Top pain phrases (all niches)

Tallies are counts across items found, not prevalence. Samples are small.

**Cross-niche, most repeated:**
1. Organic growth / new-business pipeline slowing (insurance 6, PEO 2)
2. Margin or price compression and commoditized pricing (freight 5, PEO 3, screening 3, facility 3)
3. Decision-maker hard to reach / gatekeepers (facility 4, PEO 2)
4. Prospects saturated or bombarded by sellers (freight 3, insurance 2)
5. Bad timing: "just renewed", reached too late (PEO 3, insurance renewal windows)
6. Cold calling is a grind / a volume game (freight 3, insurance 3)
7. Locked out by an incumbent vendor or broker (PEO broker RFPs 5, facility 2)
8. Hiring slowdown cutting volume (screening 4)
9. Long time to first revenue (freight "weeks-months to first load" 3; insurance 2-year cycles 1)
10. Referrals don't scale (PEO 2, facility 2)

**Per niche:**
- **Freight:** margin squeeze (5); shippers bombarded (3); shippers ghost (3); volume game (3); weeks to first load (3); need warm leads (2); "everyone goes direct in a soft market" (1).
- **Facility services:** decision-maker hard to reach (4); dependent on GC bids / bid boards (3); lowest-bid race (3); want recurring maintenance agreements (3); incumbent lock-in (2); reliant on referrals (2).
- **Insurance:** organic growth slowing (6); soft market / rate headwinds (5); need more producers (3); producer failure / validation (3); cold calling a grind (3); new business now the growth driver (2); owners bombarded before renewal (2); vendor appointments close poorly (2).
- **PEO:** broker gatekeeping / blind RFPs (5); PEPM commoditization (3); "just renewed" timing (3); referrals don't scale (2); hard to reach decision-makers (2); long multi-stakeholder cycles (2); poor inbound / CRM data (2).
- **Background screening:** hiring slowdown cuts volume (4); commodity / price competition (3); hard to beat large providers (2); buyer inertia (1).

**Already tried, most common:**
- In-house cold calling (freight 5, PEO 5, insurance 4, facility 4)
- Offshore VA setters (freight 5)
- Appointment vendors (insurance 4)
- Referrals (most niches)
- Bid portals (facility 3)
- SEO/PPC (screening 6)

## Typical per-appointment prices competitors charge

| Niche | Pay-per-appointment seen | Retainers seen | Notes |
|---|---|---|---|
| Insurance (commercial / WC) | **$300-550 per held meeting** + $300 setup (VA Horizon); older forum quotes $175-250 and $400-700; insurance in general $100-250; a low-end $67 (4 for $269) | Superhuman Prospecting $1,197-2,950/mo; telemarketers $25-49/hr | MarketReach: 40-75 appointments in 6-9 months at ~20% close |
| Facility: commercial cleaning | **$110-225** (Janitorial Appointment $135 if held; Janitorial Leads Pro $110-150; Gatekeepers $225); one cited Upwork deal at $125 | CallingAgency $1,699-9,500/mo | Saturated |
| Facility: commercial roofing | **$150-250 per confirmed appointment**; one platform $350 | Abstrakt quote-based (one roofer per market) | Abstrakt claims a $60.2k average deal |
| Facility: fire protection | **None published** | Belkins fire-safety case (345 appointments in 8 months) | Gap |
| Freight / 3PL | **None freight-specific**; generic Belkins $750 + $1,500 setup | SalesRoads ~$9,950 / 4 weeks; Abstrakt from $5,250/mo; Martal from $4,500/mo; Rev-Empire from $3,500/mo | Real anchor: offshore setters $400-1,400/mo; Fiverr from $50 |
| PEO / payroll | **None PEO-specific**; TopLead advertises pay-per-appointment without figures; generic $150-900 | Abstrakt from $5,000/mo ($6,500 bundle) | Paychex pays brokers $500 per small referred client |
| Background screening | **None**; served by SEO/PPC shops | n/a | Generic market $75-500/meeting |
| *Industrial staffing (baseline)* | *Rev-Empire pay-per-lead (no public figure)* | *Alleyoop $5,250-14,750/mo* | *Same baseline report* |

## Per-niche detail

### 1. Freight brokers / 3PLs: 70.3

- **Paid requests:**
  - Upwork, 2026-11-03: a brokerage wants ≥5 shipper appointments a day for $400/mo plus commission. https://www.upwork.com/freelance-jobs/apply/Freight-Brokerage-Appointment-Setter_~022117734530697563628/
  - Four OnlineJobs.ph setter posts (~800/mo; "up to $30/h"), e.g. https://www.onlinejobs.ph/jobseekers/job/1606952
  - Talentmate PH $925-1,400/mo; Indeed from $15/h; two undated Upwork lead-gen posts.
- **Pain:**
  - Shippers get "dozens of calls a day": https://www.freightwaves.com/news/check-call-enter-the-glengarry-glen-ross-era
  - A wave of broker failures expected in 2026: https://www.freightwaves.com/news/the-perfect-storm-why-freight-brokerages-face-a-wave-of-failures-in-2026
  - Awarded broker margin down to 16.9%: https://www.sdcexec.com/transportation/trucking/news/22972781/tabi-connect-why-broker-margins-are-narrowing-despite-rising-freight-volume
  - Forum accounts of thousands of calls before a consistent shipper: https://www.thetruckersreport.com/truckingindustryforum/threads/new-broker.2429964/page-2
- **Market:**
  - US 3PL market +5.0% in 2025 to $323.4B: https://www.ttnews.com/articles/3pl-market-volatility-2025
  - TIA Q2 2026 revenue +25.7% YoY, gross margin 17.8% (-120 bp): https://www.logisticsmgmt.com/article/tia_report_signals_continued_recovery_in_freight_brokerage_market
- **Value:**
  - About $200 gross profit per load.
  - Year-1 GP per won shipper: $9.6k (4 loads/mo) to $19.2k (8 loads/mo).
  - Supportable price, assuming 20-30% of year-1 GP and 10-20% of meetings turning into active shippers: $190-1,150, so **~$250-600**.
  - Freight agents keep 60-70% of margin, which lowers their ceiling: https://freightcaviar.com/stories/before-you-ask-about-the-freight-broker-agent-agency-split
- **Pool:** 25,087 active brokerage MCs, down 18.3% in two years: https://freightcaviar.com/stories/brush-pass-research-7-8-fewer-brokerages-than-a-year-ago
- **Headwinds:** shrinking broker count; the $75k bond rule enforced from 2026-01-16; freight fraud; shipper saturation.
- **Fit: moderate.** Signals map well (new plants/DCs, logistics hiring); willingness to pay and saturation are weak. Better sub-targets: mid-size brokerages and asset-light 3PLs with warehousing or dedicated contracts.
- **Competitor source:** https://martal.ca/logistics-lead-generation-companies/ ; https://salesroads.com/case-study/unishippers

### 2. Industrial & facility services: 67.5 (fire protection leads)

- **Paid requests:** 9 found, 0 verified in 90 days, about half resold through lead-gen agencies. Contractor-direct examples:
  - A commercial roofer's VA cold-calling facility managers, $4-6/hr: https://www.onlinejobs.ph/jobseekers/job/1587430
  - A facility-management cold caller on base plus commission: https://www.upwork.com/freelance-jobs/apply/B2B-Cold-Caller-for-Facility-Management-Base-Pay-Uncapped-Commission_~022081445117159857084/
  - None found for fire protection, electrical or rigging.
- **BD hiring:** strong in fire. A 40-company sample of "fire" sales titles was ~80% fire/life-safety service firms, many of them PE-backed roll-ups.
- **Pain** (practical, intensity 3):
  - Jobber threads on landing commercial contracts: https://community.getjobber.com/discussions/cleaning-and-property-maintenance/what-is-the-best-way-to-land-commercial-cleaning-contracts/11593/replies/12018
  - Incumbent inspection contracts block new sales: https://callingagency.com/?p=41267
- **Market:**
  - Fire & life safety services $62.0B (2025) to $66.3B (2026): https://www.gminsights.com/industry-analysis/fire-and-life-safety-protections-services-market
  - Low-slope reroofing index 60.2 (expanding): https://nrca.net/RoofingNews/results-are-in-from-the-latest-market-index-survey-for-reroofing.7-30-2026.13434/Details/Story
  - Electrical growth is concentrated in large data-center contractors: https://www.ecmweb.com/top-50-electrical-contractors/article/55404067/data-center-buildout-fuels-revenue-blowout-ecms-2026-top-50-electrical-contractors-special-report
- **Value per sub-trade:**

  | Sub-trade | Assumption | Supportable $ / meeting | Notes |
  |---|---|---|---|
  | Fire | $10k first year at 50% GM | $150-375 | Recurring, so lifetime value is far higher |
  | Roofing | $60k at 25% GM | $450-1,125 | Mostly one-off |
  | Cleaning | $12k ACV at 30% GM | $108-270 | |
  | Electrical | | $190-470 | |

- **Pool:** clears 1,500 in every sub-trade (see kill table).
- **Headwinds:** flat construction outside data centers; tariffs on roofing materials; IFM/ServiceChannel price scoring; incumbents.
- **Fit:**

  | Sub-trade | Fit |
  |---|---|
  | Fire | Strong |
  | Cleaning | Moderate |
  | Roofing | Moderate |
  | Electrical | Moderate-weak |
  | Rigging / millwright | Weak-moderate |

### 3. Commercial / WC insurance agencies: 66.2

- **Paid requests:**
  - Upwork appointment setter for an insurance agency (snippet "2 weeks ago"): https://www.upwork.com/jobs/~022067422401815643065
  - Workana senior setter for a commercial division: https://workana.com/job/senior-appointment-setter
  - A setter booking into producers' calendars (CareerBeacon); an Upwork commercial-auto cold-caller team.
  - Plus 5 in-house commercial P&C BDR roles (counted as BD hiring, not paid requests). Most insurance freelance work is life/health, not commercial.
- **Pain** (intensity 3, 4 items in 90 days):
  - Q3 commercial rates down 5%, so new business replaces pricing as the growth driver: https://www.insurancebusinessmag.com/us/news/breaking-news/commercial-rates-fell-5-in-q3--broker-growth-matched-it--not-evenly-597153.aspx
  - Brown & Brown organic growth 1.2%: https://www.insurancebusinessmag.com/us/news/breaking-news/brown-and-brown-organic-growth-recovers-to-1-2-as-soft-market-weighs-on-results-595056.aspx
  - Agency organic growth 11.2% (Q2 2023) down to 7.1% (Q4 2025): https://www.insurancejournal.com/magazines/mag-features/2026/05/18/869973.htm
  - Agencies told they "need to hire more salespeople": https://www.independentagent.com/news/big-i-and-reagan-consulting-release-2026-best-practices-study-update/
- **Market:**
  - CIAB Q3 2026 average premium -1.3%, with WC and construction down: https://riskandinsurance.com/commercial-insurance-renewal-rates-cooled-across-most-lines-in-q3-2026-ivans/
  - NCCI expects 2026 WC premium about 5% lower: https://www.insurancebusinessmag.com/us/news/workers-comp/twentytwo-years-of-workers-comp-rate-cuts--the-math-is-shifting-597455.aspx
- **Value:**
  - A $100k-premium account at 12% blended commission pays $12k a year. Retention is 84-87%, so lifetime is about $75k.
  - Supportable price: $360-900 per meeting. After a haircut for renewal timing, **$250-600**, which matches current vendor prices.
- **Pool:** ~37,000 independent agencies (Agency Universe Study 2026): https://www.insurancejournal.com/news/national/2026/09/24/886639.htm
- **Headwinds:** 695 agency M&A deals in 2025, ~72% by PE-backed buyers (https://www.iamagazine.com/?p=31749); soft WC; vendor distrust; licensing limits on what callers may discuss.
- **Fit: moderate, upgradable to strong.** ScaleLab could combine hiring-growth signals with public WC expiration dates and sell meetings timed to renewal: https://insurancexdate.com/faq.php

### 4. Industrial staffing (baseline): 63.7

- **Layer A inputs:** reused from `demand-signals-2026-11-26.md`.
- **Layer B:** SIA raised its 2026 industrial forecast to +7% (same report).
- **Client value (estimate):**
  - Assumptions: one won account averaging 2-5 temps in year 1 × 2,000 hrs × ~$22 bill rate (assumed) × 21.5% GM (TrueBlue Q4 2025 gross margin; https://finance.yahoo.com/news/trueblue-tbi-q4-2025-earnings-232448347.html).
  - That gives $19-47k first-year GP, and $570-3,500 per meeting at the same 20-30% / 15-25% rule.
- **Pool:** GetLeads finds 1,936 US staffing companies with industrial wording (28,986 staffing companies overall).
- **Fit:** the pipeline is built for it.

### 5. PEO / payroll / HR outsourcing: 45.6, KILLED (pool)

- **Paid requests:**
  - Upwork virtual appointment setter for a PEO at $4-9/hr: https://www.upwork.com/freelance-jobs/apply/Virtual-Appointment-Setter-B2B-PEO-Services_~022052435732211378610/
  - One referral-partner post.
- **Pain:**
  - Blind broker RFPs ("half the time we never had a shot"): https://go.sandler.com/eam/insights/blog/categories/sales-methodology/every-broker-rfp-you-chase-blind-is-margin-youre/
  - Counter-signal: "most PEOs don't have a lead problem": https://leadg2.thecenterforsalesstrategy.com/blog/top-10-peo-revenue-growth-tactics-for-2026
- **Market:** 502 PEOs, 233K clients, 5.4M worksite employees growing ~6%/yr. The PEO count falls ~1%/yr and the top 30 hold 64%: https://hrstacks.com/peo-statistics
- **Value:** at $100 PEPM gross profit, a 20-employee client is worth $24k in year 1, which supports $720-1,800 per meeting ($300-600 at a 5% close rate). For brokers it is $100-250.
- **Pool:** ~800-1,000 core firms.
- **Consolidation:** e.g. Vensure passed 108 acquisitions: https://news.outsourceaccelerator.com/vensure-hits-108-acquisitions/
- **Revive only if:** scoped to blue-collar-friendly PEOs plus benefits brokers, and the kill threshold is re-tested on that wider pool.

### 6. Background screening & drug testing: 32.9, KILLED (value)

- **Paid requests:**
  - A drug-testing firm's appointment-setter job: https://ndasa-careers.careerplug.com/jobs/3008142
  - An outsourced SDR case study: https://ai-bees.io/case-studies/background-partners-case-study
- **Pain:**
  - First Advantage Q3 2026: revenue +14% with Sterling, but hiring "flat": https://www.morningstar.com/news/globe-newswire/9870745/first-advantage-reports-third-quarter-2026-results
  - Buyers are sticky: 81% stay with a provider 3+ years: https://www.bib.com/satisfaction-buyer-report
- **Value:** about $90 per hire (background + drug test) at ~40% GM.

  | Employer size | Supportable $ / meeting |
  |---|---|
  | 100 staff | $43-108 |
  | 250 staff | $135-338 |
  | 500 staff | $324-810 |

- **Pool:** borderline.
- **Fit:** the signal match is the best of all niches, but the economics fail.
- **Revive only if:** limited to screeners and TPAs serving DOT fleets or 250+-staff high-turnover employers, at a hybrid price of about $150-300 per meeting.

## Method

- **Layer A** uses the same five signals, weights and formulas as the baseline:
  - Paid score = 50 × total/max + 50 × dated-90d/max (an unverified "probably in 90d" counts 0.5).
  - Pain score = 60 × intensity/5 + 40 × 90d items/max.
  - Competitors score = 100 × count/max.
  - Search score = min-max of the share change.
  - All maxima are taken within these six niches.
- **Research:** one research pass per niche, using only free WebSearch and WebFetch (about 35 calls each). Reddit, Upwork and some job boards block fetching, so details come from search snippets.
- **BD hiring:** GetLeads `search_jobs` (free jobs quota), Sales & Business Development function, US, posted since 2026-08-28, grouped by company, with a niche word in the job title. Description-keyword versions were discarded as noise ("background screening" matches every "subject to background screening" ad). Fire was checked with a 40-company sample. Insurance and freight in-niche shares are assumed (~70% and ~80%) because the sampling calls timed out.
- **Firm pool:** GetLeads `count_companies` (free), US headquarters, LinkedIn industry plus description keywords, cross-checked against public counts (NAPEO, IBISWorld, FMCSA via FreightCaviar, Agency Universe Study).
- **Search:** Google Trends public endpoint, US, 12 months, weekly. Each term is shown as a share of "industrial staffing", because every term dropped seasonally (Aug-Nov vs May-Aug).
- **Layer B:** 1-5 judgments from the research above, equal weights.
- **Supportable price per meeting:** first-year gross profit (or commission) per won account × 20-30% allowable acquisition spend × 15-25% meeting-to-win rate (10-20% for freight).
- **Kill rules:** fewer than 1,500 reachable firms; value too low for pay-per-meeting; buyers unreachable.

## Caveats

- Small samples everywhere. Paid-request totals are posts found, not market size. Only one paid post (freight) has a verified date inside the 90 days.
- Pain evidence is mostly trade press and vendor content. First-hand Reddit discussion was unreachable for every niche.
- BD-hiring counts are title-based estimates with assumed in-niche shares for insurance and freight. Roll-ups (Pye-Barker, TQL, Insurance Office of America) inflate company counts with many postings.
- Layer B scores and the supportable-price arithmetic rest on stated assumptions (conversion rates, gross margins, loads per shipper, bill rates). Treat the prices as order-of-magnitude.
- The baseline was rescored inside this six-niche set, so its Layer A number is not comparable to the staffing-only report.
- The "peo" Trends term is ambiguous, so the PEO search score is low-confidence.

## Spend

| Tool | Used | Notes |
|---|---|---|
| Firecrawl | **0 credits** | The brief set a 60-credit cap, then "hard credit caps of 0"; the stricter limit was applied |
| GetLeads plan credits | 0 (5,164 before and after) | `count_companies` is free; `search_jobs` uses the separate free jobs quota (~3,300 job records today, of 200,000/day) |
| Apify / Adyntel / Jev | not used | |
| WebSearch / WebFetch / Google Trends | free | |
