# Commercial / WC insurance agencies: deep dive (2026-11-26)

This is a read-only pass on commercial / workers' comp (WC) insurance agencies as ScaleLab's next client niche. It follows `niche-scan-2026-11-26.md`, where the niche ranked #3 on combined score with the strongest pain and the most direct reuse of our employer data.

No personal data is recorded here: only counts, company-level names, public prices and paraphrases. Spend is at the end.

**How the model works in this niche:**

- **ScaleLab's client:** an independent commercial-lines agency.
- **The meeting:** with an employer (manufacturer, contractor, trucking or logistics firm) whose WC policy renews soon.
- **The employer data:** the same employer universe ScaleLab already sources for industrial staffing, so data and hiring signals carry over.

## Summary

- **Renewal data is the unlock, and it exists in bulk in two states.**
  - **Texas** (data.texas.gov) and **Oregon** (data.oregon.gov) publish free, current WC policy datasets that can be queried by expiration date.
  - Live counts today for renewals 60-120 days out (2027-01-25 to 2027-03-26):
    - Texas: **5,528** insured employers at $10k-500k standard premium, of which **2,592** are at ≥ $25k.
    - Oregon: **379** construction / manufacturing / trucking-warehousing employers with 11-499 staff.
  - **Florida** has a statewide policy export by effective month, but it sits behind reCAPTCHA (manual pulls or a public-records request).
  - **California** publishes WC policy dates in bulk only for licensed contractors (CSLB).
  - Everywhere else is single lookup, and the NCCI lookup that about 32 states use **bans commercial use and scripting**.
- **Pool:** about **6,500 reachable owner-run commercial agencies with 2-50 staff**; about 2,500-3,000 have a decision-maker with a valid email today. WC / industrial specialists alone are about 1,000-1,500, so use specialisation as a score, not a filter.
- **Competitors:** about **$150-550 per held meeting**.
  - VA Horizon publishes $300-550 per held meeting plus $300 setup.
  - LeadSureX publishes $50-150 per appointment.
  - Free no-show replacement is universal; only Maxion Labs offers money back per missed meeting.
  - Lead Orchard, CallingAgency, CFE and Maxion all claim renewal-window targeting (30-120 / 60-90 / ≤90 days), but mostly collect the date on the call.
- **Positioning:** "renewal-timed meetings sourced from public coverage filings plus hiring signals, pay per held meeting, credit for every miss." Pilot in **Texas** first, where the data is complete and free.

## 1. WC renewal data: which states publish coverage / policy data

**Low-value states.** ND, OH, WA and WY are monopolistic state-fund states: there is no private-carrier WC renewal to compete for. Washington's L&I contractor "insurance" dataset is general liability, not WC.

| State / source | Access | Fields | Cost / barriers | Terms of use | Confidence |
|---|---|---|---|---|---|
| **TX: TDI-DWC "Workers' Compensation Insurance Coverage Subscriber Information"** ([API](https://data.texas.gov/resource/c4xz-httr.json), [catalog](https://catalog.data.gov/dataset/workers-compensation-insurance-coverage-subscriber-information)) | **Bulk CSV/JSON plus SoQL API, filterable by date** | Employer name and address; carrier name and NCCI carrier ID; **policy effective and expiration dates**; governing class code; **state standard premium**; PEO / employee-leasing flag; record type (I = insured, E = endorsement). No policy number, FEIN, phone or NAICS (the class code is the industry proxy) | Free, no login. Quarterly refresh; latest effective date 2026-09-30. About 2.2M rows including endorsements | None seen on the dataset. Data comes from carrier proof-of-coverage (POC) filings | **High** (queried 2026-11-26) |
| **OR: DCBS "Oregon Active Workers' Compensation Employer Database"** ([API](https://data.oregon.gov/resource/q9zj-c8r2.json), [DCBS](https://www.oregon.gov/dcbs/reports/compensation/pages/wc-employers.aspx)) | **Bulk CSV/JSON plus API** | Legal and DBA name; **NAICS**; **employee range**; physical and mailing address; **business phone**; insurer; **liability begin and end dates**; NCCI code; ownership type | Free, monthly refresh, ~131k rows. Contact names, possible-SSN FEINs and PEO client employers are withheld | No use restriction stated by DCBS | **High** (queried 2026-11-26) |
| **FL: DFS Division of Workers' Comp Digital Download / Proof of Coverage** ([download](https://dwcdataportal.fldfs.com/DigitalDownload.aspx), [POC search](https://dwcdataportal.fldfs.com/POCData.aspx)) | Bulk **Excel export** by employer-name initial, **effective month/year range** and county; search by policy number or dates | Policy number, insurer, effective and expiration dates (per a [third-party guide](https://www.zyphe.com/resources/blog/florida-workers-comp-proof-of-coverage)); 5 years of data. Export columns unverified | Free, but **reCAPTCHA** on each export. Public-records route via the Division (email published on the portal) | Hold-harmless disclaimer only; no marketing ban seen. Bypassing the CAPTCHA is a terms risk | Med-High |
| **CA: CSLB Data Portal, workers' comp file** ([portal](https://www.cslb.ca.gov/OnlineServices/DataPortal/ContractorList)) | **Bulk XLS/CSV** | License number, coverage type, **WC carrier, policy number, policy dates**; joins to the License Master file (name, address, phone, classification) | Free. Paid full and custom files also exist ([order form](https://WWW.CSLB.CA.GOV/Resources/FormsAndApplications/FULL_FILE_-_UPDATE_FILE_ORDER_FORM.pdf), $245 custom list per [this form](https://www.cslb.ca.gov/resources/formsandapplications/publicsalesorderformlabelslistscd.pdf)) | **Contractors only.** No emails released (B&P §27). Portal conditions of use not yet reviewed | High (per page text; file not downloaded) |
| **CA: WCIRB Coverage Inquiry** ([lookup](https://caworkcompcoverage.com/)) | Single lookup by name or FEIN plus date (last 5 years) | Insurer only | Free; paid research $20 per employer-year ([WCIRB](https://www.wcirb.com/products-and-services/coverage-research-service)) | Any use not expressly permitted is prohibited. Assume no solicitation use | Med |
| **NCCI Coverage Verification Service (CVS)** ([lookup](https://www.ewccv.com/cvs/)), used by CT, AZ, IL, MD, NV and others (~32 states per older NCCI material) | Single lookup | Insurer on a given date | Free; reCAPTCHA; terms acceptance | **"Personal, non-commercial use only… scripted queries and automatic retrieval(s) expressly prohibited."** Do not use for prospecting | High |
| **NY: WCB Employer Coverage Search** ([overview](https://www.wcb.ny.gov/content/ebiz/icempcovsearch/icempcovsearch_overview.jsp)) | Search by name prefix (up to 750 results) | Policy number, coverage type, cancellation dates; carrier and expiration date unverified. data.ny.gov has claims data only | Free | None shown on overview | Med |
| **WI: DWD Employer Insurance Lookup** ([lookup](https://www.dwd.wisconsin.gov/wc/er-ins-lookup.htm)) | Lookup | Carrier and contact only | Free, weekly refresh | Intended for claims use | Med |
| NJ (CRIB), PA, DE, MA, MI, MN, NC, IL, GA, VA, TN, IN, CO, AZ | Single lookups (NCCI CVS or state bureau sites) | Insurer, sometimes policy dates | Free | Mostly NCCI terms | **Low: no bulk access found** |
| *Contractor-board liability data* (OR CCB [g77e-6bhs](https://data.oregon.gov/resource/g77e-6bhs.json); WA L&I [ciwg-agsx](https://data.wa.gov/resource/ciwg-agsx.json)) | Bulk API | Liability carrier and expiration dates (not WC) | Free, open data | Open | Med-High (useful only for GL / package timing) |

**Commercial resellers (what the market charges):**

- **Insurance Xdate:** national WC x-dates with premium, mod, carrier, incumbent agency, class code and payroll, sourced from carrier filings. From about **$50-100/month per state**, starter plans capped at 200 exports a month. [WC page](https://insurancexdate.com/workers-comp-insurance/), [support](https://www.insurancexdate.com/support/)
- **Apify "CA Contractor Insurance Leads":** resold CSLB data, from **$20 per 1,000**. [listing](https://apify.com/deadwood_data_solutions/ca-contractor-insurance-leads)
- **Another x-date vendor:** about $650/yr in a forum report (unverified). [thread](https://www.insurance-forums.com/community/threads/cole-x-dates.47066/page-2)

**Live counts, queried 2026-11-26** (window 2027-01-25 to 2027-03-26 = 60-120 days out):

| Query | Count |
|---|---|
| TX: insured records (I) expiring in window | 60,428 (plus 99,922 endorsement rows) |
| TX: insured records with $10k-500k standard premium | **5,528** (99.5% flagged non-PEO, code 1) |
| TX: insured records with ≥ $25k standard premium | **2,592** |
| OR: policies ending in window | 17,226 (14,915 of them 1-10 employees) |
| OR: NAICS 23 / 31-33 / 484 / 493 with 11-499 employees | **379** |

### Top 5 by usefulness (renewals 60-120 days out)

1. **Texas TDI-DWC open dataset.**
   - Statewide bulk data, an API filter on expiration date, carrier, class code and **premium** (the best size proxy available anywhere). About 2,600 employers at ≥ $25k premium renew in any 60-day window.
   - Limits: quarterly lag; no phone or FEIN, so match to GetLeads by name and address. Texas is opt-in WC, so non-subscribers never appear.
2. **Oregon DCBS open dataset.**
   - Monthly, with NAICS, employee range and phone already attached.
   - Limits: small state (~380 target employers per window), and ~40% of rows are SAIF (the state-chartered carrier).
3. **Florida DWC Digital Download.**
   - Statewide, filterable by effective month and county, so it maps directly to renewal timing.
   - Limits: reCAPTCHA means a manual monthly pull or a public-records request; export columns are still to be verified.
4. **California CSLB WC file.**
   - Free bulk carrier, policy number and dates for every licensed contractor; joins to license address, phone and class.
   - Limits: contractors only, no headcount, many tiny or exempt licensees. Size must come from GetLeads.
5. **Insurance Xdate (paid).**
   - The only national route for manufacturers and trucking firms outside TX, OR and FL, at about $50-100 per state per month.
   - Limits: its resale / use terms need review before any purchase. Not authorised in this task.

### Risks and rules for using renewal data

- **Allowed sources:** use only open-data or bulk sources whose terms permit reuse (TX, OR, CSLB after reading its conditions).
- **Never automate** NCCI CVS, WCIRB, or anything behind reCAPTCHA.
- **Florida:** use the public-records route.
- **Outreach law:** CAN-SPAM for email; TCPA and state do-not-call rules if phones are ever used.
- **Exclude PEO-leased records.** Their WC belongs to the PEO, not the employer.
- **Data lag:** expiration dates go stale when policies cancel or rewrite early, and TX refreshes only quarterly. Always **confirm the renewal date with the employer** before counting a meeting as in-window.
- **Not checked:** no state statute barring commercial solicitation with public WC data was found, but not every state code was checked.

## 2. Pool size: agencies writing commercial lines / WC

### Association figures

- **Independent agency count:** about **37,000** in 2026, down from 39,000 (2024) and 40,000 (2022). Average staff is **9.9** (8.2 in 2024).
- **Commercial revenue trend:** 2 in 3 agencies grew commercial-lines revenue from 2024 to 2025.
- **Top challenge:** finding strong candidates (45%).
- **Marketing spend:** the average agency marketing budget rose from **$14,300 to $20,600**. That is a budget line ScaleLab can sell into.

Source for the above: [Insurance Journal, 2026-09-24](https://www.insurancejournal.com/news/national/2026/09/24/886639.htm).

From the 2024 study:

- Agencies are appointed with an average of **17 carriers**.
- 1 in 3 expect an ownership change within five years, so M&A churn shrinks the owner-run pool.

Source: [Big "I" 2024 findings](https://www.independentagent.com/news/big-i-and-future-one-release-2024-agency-universe-findings/).

The public pages give no breakdown of agencies by size band or by commercial vs personal revenue share. That sits in the paid full report.

### GetLeads company counts (free)

All counts below use US headquarters and the LinkedIn industries "Insurance" or "Insurance Agencies and Brokerages". The commercial filter matches company descriptions containing *commercial insurance, business insurance, commercial lines, workers compensation, workers comp, commercial auto, general liability* or *surety*.

| Cut | Companies |
|---|---|
| All US insurance-industry companies (carriers, agencies, captives) | 70,839 |
| Commercial-described agencies, all sizes | **8,473** |
| … 1-10 staff band | 5,894 |
| … 11-50 staff band | 1,961 |
| … 51-200 staff band | 312 |
| … 201+ staff band (mega brokers / platforms) | 166 |
| … 2-50 staff by exact LinkedIn profile count | **6,832** |
| … whose name carries a captive brand (State Farm, Allstate, Farmers, American Family, Farm Bureau, Country, Shelter, GEICO, Liberty Mutual, Erie, Auto-Owners) | 163 |
| 1-50 staff, commercial-described, and "independent" in description | 1,905 |
| 1-50 staff, WC named in description | 933 |
| 1-50 staff, construction / contractors / manufacturing / trucking / transportation named in description | 2,049 |

**Google Maps cross-check.** GetLeads Places counts 278,315 US locations categorised Insurance agency or Insurance broker. That figure counts locations, not firms, and is dominated by captive storefronts: State Farm 27,636, Farmers 16,322, Allstate 11,785, American Family 5,134, Farm Bureau 5,094. It confirms that captives must be excluded before any count is meaningful.

### Decision-makers reachable (GetLeads contact counts, free)

These counts cover the same commercial-described pool with 1-50 staff, contacts located in the US.

| Cut | Contacts |
|---|---|
| C-level seniority | 7,374 |
| … with VALID email status | **3,107** |
| Owner / principal / president / founder / CEO / managing-partner titles | 7,683 |
| Commercial lines manager / commercial producer / commercial AE titles | 341 |

C-level contacts by state. These are contact counts, not agency counts; GetLeads company counts cannot be filtered by HQ state.

| State | CA | FL | TX | NY | PA | IL | OH | MI | GA | NC | NJ | AZ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| C-level contacts | 694 | 519 | 476 | 398 | 250 | 207 | 184 | 182 | 170 | 169 | 159 | 108 |

These 12 states hold about 47% of the national 7,374. CA, FL, TX and NY alone hold 28%.

### Estimate: reachable, owner-run independent agencies with 2-50 staff

| Step | Figure | Basis |
|---|---|---|
| Independent agencies (all) | ~37,000 | Agency Universe Study 2026 |
| Write meaningful commercial lines | ~20,000-25,000 | Most independents write some commercial business; 2/3 reported commercial growth. Assumption |
| On LinkedIn with a commercial description, 1-50 staff | 7,855 | GetLeads (5,894 + 1,961) |
| Minus captives (~2%) and 1-person shells (6,832 have ≥2 staff profiles) | **~6,500-6,800** | GetLeads |
| With a C-level contact holding a VALID email today | **~2,500-3,000 agencies** | 3,107 contacts, about 1.1-1.2 per agency (assumed) |
| Industrial / construction / trucking specialists inside that | **~800-1,500** | 933 WC-described plus 2,049 industry-described (they overlap) |

Working number:

- **About 6,500 reachable owner-run commercial agencies.**
- **About 2,500-3,000** can be emailed today without paid enrichment.
- The initial ICP slice (WC / industrial specialists) is **~1,000-1,500**. On its own it falls just under the 1,500 kill threshold, so the campaign should take the wider commercial pool and use specialisation as a priority score, not a filter.

### Employer side (meeting supply)

US HQ companies in manufacturing, construction, trucking, warehousing and logistics industries (GetLeads):

- **101,550** with 11-50 staff
- **29,087** with 51-500 staff

A WC policy renews once a year. About **1 in 6** of any employer list therefore renews inside a rolling 60-120 day window (two months of twelve), assuming renewal dates are spread evenly. In practice 1/1 and 7/1 renewals cluster.

## 3. Draft ICP: agency (ScaleLab's client)

**PASS (all required):**

- **Independent agency.** Multi-carrier appointments, typically 5-20+ carriers; the average is 17. Not a captive or single-carrier office.
- **Commercial lines are material.** The website, LinkedIn or a services page shows business insurance, WC, GL, commercial auto, property, surety or bonds as core lines, not an afterthought behind auto and home. As a guide: commercial pages at least equal personal pages, or the agency names commercial producers or a commercial lines manager.
- **Writes our employer industries.** At least one of manufacturing, construction / contractors, trucking / transportation, warehousing / logistics is named, or there is a WC programme, safety / loss-control service or x-mod (experience modification) help.
- **Size: 2-50 staff**, with the sweet spot at **5-25 staff and 1-6 producers**. That is big enough to staff meetings and pay, and small enough that the owner decides.
- **US-licensed** in the states where we would book meetings. Note the licensed states, because meetings must fall inside them.
- **Identifiable budget owner** who can decide quickly on pay-per-meeting.

**Buyer titles (in order):**

1. Agency principal / owner / president / CEO / founder
2. Managing partner / partner (producer-owners)
3. VP or director of commercial lines, commercial lines manager
4. Sales manager / director of business development

Default to **HOLD** for producers without ownership, account managers, CSRs and marketing coordinators. Reject role mailboxes (`info@`) as the primary buyer.

**Priority signals (score, don't filter):**

- Hiring producers or commercial account managers; job postings of this kind are common (see `niche-scan-2026-11-26.md`, BD hiring).
- A recent acquisition or second office.
- A niche page (contractors, trucking, manufacturing).
- Visible ad spend or website lead forms.
- An x-mod / safety / loss-control service.
- A "we write WC in [states]" page.
- Membership in Big "I" (IIABA) or a state association, which marks an independent.

**Exclusions:**

- **Captive or exclusive agents:** State Farm, Allstate, Farmers, American Family, Farm Bureau, Country Financial, Shelter, GEICO, Liberty Mutual exclusive agents, Erie and Auto-Owners storefronts that are single-carrier, and similar brands.
- **Personal-lines-only** agencies (auto, home, life, Medicare, health-only).
- **Benefits-only / life & health brokers**, unless they also run a P&C book.
- **Mega brokers and national platforms.** Roughly 200+ staff or a top-100 broker (Marsh, Aon, Gallagher, Brown & Brown, Hub, Acrisure, Alliant, USI, Lockton and similar), plus PE-platform HQs. Their local acquired offices go to **HOLD**, because buying decisions move to the platform.
- **Wholesalers, MGAs, carriers, TPAs, premium finance and claims adjusters.** These are not retail agencies.
- **PEOs.** Separate niche; killed in the scan.
- Agencies whose licensed states don't overlap the states we can source employers in.

**Separation rule** (from the playbook): keep this campaign's agency prospects, employer data use, senders and copy separate from Jole BTX, and from the staffing campaign's suppressions and copy.

## 4. Qualified-meeting definition (employer side)

A **qualified meeting** is a scheduled call or visit between the client agency's producer and an employer that meets **all** of the criteria below and actually takes place. "Actually takes place" follows the playbook's "no qualified meetings that actually take place, no meeting fees" positioning.

| # | Criterion | Standard | Notes |
|---|---|---|---|
| 1 | **Industry** | Manufacturing, construction / contractors, trucking / transportation, warehousing / logistics, or other classes inside the agency's written appetite | The agency lists its appetite (and excluded classes) at kickoff |
| 2 | **Size** | **20-500 employees** (default floor 20). Equivalent floor: estimated WC premium **≥ $25k**, or total commercial premium ≥ $40k | A floor near $25k matches Maxion's published example. Older forum anchors want over $10k minimum and an average of $25k+. Our arithmetic: ~$12k a year commission at $100k total premium |
| 3 | **Renewal window** | WC (or package) **renewal 60-120 days out** at booking | Source the date from public proof-of-coverage data where available (section 1) and **confirm it on the call**. 30-59 days counts only if the agency opts in. Over 120 days goes to nurture, not a meeting |
| 4 | **Decision-maker** | Owner, president, CEO, CFO, controller or VP finance. HR director or safety / risk manager only if they control the WC decision or the decision-maker also attends | Brokers of record and office managers on their own don't qualify |
| 5 | **Open to a quote** | The employer explicitly agrees to review a quote or a coverage / x-mod review, and to share a loss run, payroll by class code, or a current dec page. No opt-out or "just renewed and locked in" | Signing a broker-of-record (BOR) letter is a bonus, not required |
| 6 | **Not an existing client** of the agency, and not quoted by it in the last 12 months | Dedupe against the agency's book list at kickoff | |
| 7 | **Within licensed states** and not in a monopolistic state-fund state for WC (ND, OH, WA, WY) | Packages for GL / auto can still apply there if the agency opts in | |
| 8 | **Held** | Both parties attend for ≥ 15 minutes, within 14 days of booking. Reconfirmed by email or SMS 24-48 hours before | No-show or reschedule beyond 14 days: replaced free, not billed |

Disqualifiers that void the fee:

- Wrong contact or no decision authority
- Renewal outside the window
- Below the size floor
- Already a client
- Outside appetite
- Monopolistic-state WC-only prospect

The agency must flag a disqualifier within **3 business days** of the meeting, giving the reason.

## 5. Competitors selling meetings to insurance agencies

| Vendor | Model | Price | Setup / term | Guarantee | Renewal-timing claim | Their "qualified" definition |
|---|---|---|---|---|---|---|
| [VA Horizon](https://www.vahorizon.site/b2b/statistics/insurance-appointment-vendor-pricing/) | Pay per held meeting; SMS-first, human + AI SDRs | **$300-550 per held, double-confirmed meeting** | **$300 one-time setup**; no retainer; cancel anytime | Free no-show replacement | None | Criteria set at kickoff; no premium floor published |
| [Maxion Labs](https://www.maxionlabs.com/) | Monthly plan sized in meetings (standard 15/mo) | Not published | Month to month | **Money back / credit for every missed meeting**; no-shows replaced | **Inside the 90 days before renewal**; uses Form 5500 plan years; date taken at confirmation | Premium above the agency's floor (example **$25k+ premium or 20+ lives**), need within 3 months, in appetite, decision-maker present. Only accepts agencies with ~$2-15M revenue and 2+ producers |
| [LeadSureX](https://www.leadsurex.com/for-agencies) | Monthly fee + performance | **$50-150 per appointment** (example $2,280/mo ÷ 24 = $95) | n/s | 5 free appointments if fewer than 7 of the first 10 show | "Approaching renewal"; dates from x-dates, Form 5500, OSHA, DOT and public WC databases, reconfirmed on the call | Decision-maker or influencer; current carrier and date checked; claims a 72% show rate |
| [Lead Orchard](https://www.leadorchard.com/) | Exclusive appointments | Not published | **No setup, no minimum, no long contract** | Replaced if outside class / territory or cancelled | **30-120 days from renewal** | Decision-maker; agency picks SIC class and territory; under 10 vs 10+ employee tiers; supervisor confirm plus day-before confirm |
| [CallingAgency](https://callingagency.com/lead-generation-services/commercial-insurance-lead-generation/) | Monthly SDR seats (~$1,699 FT, secondhand) | Per meeting n/p | No setup, no long contract (per G2 snippet) | No-shows and below-standard meetings replaced | **60-90 days before renewal**, collected on the call | Decision-maker title, x-date in window, open to a quote or BOR |
| [CFE Marketing](https://cfemarketingservices.com/leads/commercial-insurance) | Flat monthly retainer per producer | n/p | 1-month pilot, then month to month (30 days' notice) | No-shows rebooked; no meeting-count promise | **60-90 days before renewal** (enrichment + filings + call) | BANT; exclusive per producer and territory |
| [TopLead](https://www.toplead.io/book-qualified-workers-compensation-appointments-for-your-agency/) | Pay per qualified appointment (WC only) | n/p | No retainer / upfront | Cancels and no-shows replaced | None | Owner / HR / CFO, "right size", actively shopping |
| [MarketReach](https://marketreachresults.com/industries/insurance-2/) | Hourly pilot | n/p | **800-hour pilot over 6-9 months** | None | Renewal quarter as a filter | 40-75 appointments per pilot, ~20% close; filters: staff, lives, mod, owner / CEO / CFO |
| [SalesHive](https://saleshive.com/pricing/) | Flat monthly | Custom; no per-meeting price | 12-month or month to month | **No meeting-count guarantee** | None | Case study: 596 meetings for one commercial agency over ~4 years |
| [Superhuman Prospecting](https://www.superhumanprospecting.com/pricing) | Subscription | Calls from **$1,998/mo**; SDR from **$4,995/mo**; lists $3/contact | Setup fee may apply | None | None | Not insurance-specific |
| [Hit Rate Solutions](https://hitratesolutions.com/industries/cold-calling-for-insurance-agents) | Hourly blocks | **$7-8/hr** | Block minimums | None | None | n/a |
| Data / live transfers | Data | Insurance Xdate ~$50-100/state/mo; commercial live transfers **$30-120** ([Phonexa](https://phonexa.com/blog/insurances-leads-cost/)) or $80-200+ ([ActiveProspect](https://activeprospect.com/blog/insurance-leads-cost/)) | n/a | n/a | X-date search | Not meetings |

Also found, with no public pricing: Intelemark, Abstrakt, Client Focus Corp (mainly retention calling), Quality Contact Solutions, Insurance Telemarketer and Option1 Marketing (site looks stale). The old "RelEvent $269 for 4 appointments" figure is an unverified forum post from about 2011.

**Price band.** About **$150-550 per held commercial / WC meeting**:

- Published low end: $50-150 per set appointment (LeadSureX).
- Published high end: $300-550 per held meeting (VA Horizon).
- Retainers: ~$1,700-5,000 per seat-month.
- Old forum anchors: $100-250 per prequalified WC appointment ([2008](https://www.insurance-forums.com/community/threads/whats-the-going-rate-for-prequalified-wc-appointments-knowadays.3712/)); $175-250 and $400-700 per commercial appointment ([2008](https://www.insurancejournal.com/forums/viewtopic.php?p=9300)).

**Guarantees.**

- Free no-show replacement is universal.
- Replacement for meetings outside class or territory is common.
- **Money back per missed meeting is rare** (Maxion only).
- Most have no setup fee and run month to month; VA Horizon's $300 setup is the exception.

**Renewal-timing claims.** 60-90 days (CallingAgency, CFE), ≤ 90 days (Maxion), 30-120 days (Lead Orchard). Most **collect or confirm the date on the call** rather than sourcing it first. Only LeadSureX and Maxion name public data sources.

**Agency complaints about vendors** (forums; mostly old):

- Per-appointment setters "force appointments" ([2016](https://insurance-forums.com/community/threads/commercial-appointment-setters.80894)).
- Vendors are "uniformly bad", with poor close rates ([2008](https://www.insurancejournal.com/forums/viewtopic.php?p=9300)).
- Callers can't explain complex coverage.
- No-shows.
- $10/hr in-house callers look cheaper unless premiums are large.
- Owners don't remember the x-date call.

### Implications for ScaleLab's offer

- **Price** at **$300-450 per held, qualified meeting**: inside the band, below VA Horizon's top, and supportable by the ~$12k first-year commission on a $100k account. No setup fee.
- **Guarantee:** credit for every meeting that fails the definition in section 4, a stronger promise than free rebooking.
- **Differentiate on sourcing.** Renewal dates come from public filings (TX / OR / FL / CA) before outreach, plus hiring and new-location signals that show payroll growth (a WC premium driver). Competitors mostly guess the date and confirm it on the call.
- **Answer the main complaints in writing:**
  - A premium / size floor (≥ 20 employees or ≥ $25k WC premium).
  - Decision-maker attendance.
  - Double confirmation.
- **First pilot:** Texas agencies, plus multi-state agencies licensed in TX, booking against the TDI dataset. Florida (manual monthly export) and Oregon come next.

## Not authorised / next steps (not done)

- No agency or employer lists were exported. No paid data was bought (Insurance Xdate, CSLB paid files). No forms were submitted and no public-records requests were filed. No copy was written.
- To check before any build:
  - CSLB portal conditions of use.
  - Florida export columns.
  - Texas class-code to industry mapping.
  - Insurance Xdate terms.

## Spend

| Tool | Used | Notes |
|---|---|---|
| Firecrawl | **3 credits** (cap 40) | 1 for the NCCI CVS terms page, 2 for two insurance-forums threads |
| GetLeads plan credits | 0 (5,164 before and after) | Free `count_companies`, `count_contacts`, `count_places` only |
| Texas / Oregon open-data APIs | free | Read-only aggregate counts |
| WebSearch / web fetches | free | |
| Apify / Adyntel / Jev / Apollo | not used | |
