# Staffing segment demand signals: 2026-11-26

Read-only research pass. Window: last 90 days (2026-08-28 to 2026-11-26) where dates were visible. No personal data: counts, company-level competitor names and paraphrases only. Working files (raw search results, parsed postings) stay in the git-ignored `runs-private/demand-2026-11-26/`.

## Ranked result

Weights: paid requests 30, BD hiring 25, pain 20, competitors 15, search 10. Each signal is scored 0-100 across the seven segments (method below), then weighted.

| Rank | Segment | Total | Paid (30) | BD hiring (25) | Pain (20) | Competitors (15) | Search (10) |
|---|---|---|---|---|---|---|---|
| 1 | IT contract | **72.0** | 58 | 63 | 76 | 90 | 100 |
| 2 | Healthcare | **70.7** | 100 | 22 | 71 | 100 | 59 |
| 3 | Industrial (baseline) | **47.4** | 21 | 60 | 39 | 100 | 34 |
| 4 | Engineering / technical contract | **27.7** | 4 | 52 | 39 | 30 | 11 |
| 5 | Construction labor | **16.1** | 0 | 32 | 17 | 20 | 18 |
| 6 | Office / admin | **15.6** | 0 | 6 | 29 | 30 | 38 |
| 7 | CDL / driver | **5.3** | 0 | 2 | 17 | 10 | 0 |

**Read this with the caveats.** IT and healthcare are effectively tied. IT leads only because two software-engineering-talent Upwork posts counted as IT paid requests; without them, healthcare ranks first (about 71 vs 60). Industrial is a clear third and well ahead of the rest. CDL / driver shows almost no client-acquisition demand in any channel.

### Raw inputs behind the scores

| Segment | Paid posts (total / dated 90d) | BD postings, est. at agency-named companies | BD postings with segment in title | Pain threads (total / 90d) | Intensity 1-5 | Segment-specific competitors | Search share change vs control |
|---|---|---|---|---|---|---|---|
| Industrial (baseline) | 5 / 0 | ~79 | 11 | 12 / 3 | 2 | 10 | -26% |
| Engineering / technical contract | 1 / 0 | ~73 | 7 | 7 / 3 | 2 | 3 | -39% |
| CDL / driver | 0 / 0 | ~1 | 1 | 6 / 1 | 1 | 1 (weak only) | -45% |
| Construction labor | 0 / 0 | ~43 | 5 | 6 / 1 | 1 | 2 | -35% |
| IT contract | 6 / 2 | ~21 | 57 | 20 / 8 | 3 | 9 | +11% |
| Healthcare | 12 / 3 | ~2 | 24 | 18 / 7 | 3 | 10 | -12% |
| Office / admin | 0 / 0 | ~10 | 0 | 7 / 1 | 2 | 3 | -24% |

## Top 10 pain phrases per segment

Ordered by mention count across the items found (small samples: these are tallies, not prevalence). A segment with fewer than 10 recurring phrases lists only what was found.

**Industrial (baseline)** (10 found): vendor lists consolidating (3); temps cut first when clients tighten costs (2); manufacturing/logistics client demand down (2); margin pressure (2); clients switch providers easily (1); can't book meetings with prospects (1); lost the biggest client (client concentration) (1); clients hiring temps directly (1); platforms promising faster fills (1); clients slow to pay (1)

**Engineering / technical contract** (8 found): job orders softening (2); VMS/MSP fees eating margin (2); oil and gas headcount cuts (1); wind projects cooled after policy change (1); slower hiring velocity (1); pure-play staffing headwinds (1); new clients take more effort (1); openly asking for new clients (1)

**CDL / driver** (5 found): freight demand soft (3); shipment volumes falling (1); carriers not hiring (1); carriers doubt third-party recruiters (1); driver cost-per-hire rising (1)

**Construction labor** (5 found): non-data-center projects soft (2); hiring flat (2); contractors holding workers instead of adding temps (1); projects delayed or scaled back (1); cold calling GCs ineffective (1)

**IT contract** (10 found): vendor rosters cut / consolidation (4); fewer job orders / reqs (4); clients insourcing or direct sourcing (4); hiring freezes / budget caution (3); slow client decisions and feedback (2); can't get direct clients or prime-vendor status (2); VMS fees and platform tax (2); AI lets clients hire without agencies (2); bench sales: no vendors with open reqs (2); must-fill roles only (1)

**Healthcare** (10 found): MSP/VMS controls access (5); margins compressed (4); bill rates pushed down / rebates demanded (3); agency-free push by hospitals (2); fear of failing first clients (new agencies) (2); facilities already have enough vendors (1); demand only propped up by strikes (1); agency-owned MSPs favor own staff (1); facilities bringing per diem in-house (1); no clients despite trying everything (1)

**Office / admin** (4 found): clerical demand shrinking (4); AI replacing admin tasks (3); orders below last year (2); clients converting to contractors or automation (1)

## Per-segment detail

### IT contract: 72.0

**1. Paid requests.** 6 posts found (2 dated inside 90 days). Budgets seen: INR 600-150,000 (payout-based); INR 1,500-12,500 (~$18-150); commission-only.
- Upwork, undated: UK tech recruitment firm wants cold caller to fill the founder's diary with client meetings. Budget: not visible. https://www.upwork.com/freelance-jobs/apply/Cold-Caller-SDR-for-Tech-Recruitment_~022103242433465686024/
- Freelancer.com, ~2026-04 (posted '7 months ago'): US IT staffing agency seeks freelance BDM for US lead gen and client acquisition. Budget: INR 600-150,000 (payout-based). https://www.freelancer.com/projects/business-development/freelance-bdm-for-staffing
- Freelancer.com, ~2026-07/08 (posted '4 months ago'): Specialist IT recruitment agency wants freelance BD partner to win domestic India IT clients. Budget: INR 1,500-12,500 (~$18-150). https://www.freelancer.com/projects/business-development/recruitment-freelance-business
- Upwork, within 90d (search date filter): appointment setting / cold email to CTOs and heads of engineering for a software-engineering talent firm. Budget: not visible. https://www.upwork.com/freelance-jobs/apply/B2B-Appointment-Setter-Technical-Engineering_~022123406506382523402/
- Upwork, within 90d (search date filter): lead gen + appointment setting to US buyers for an engineering-talent and hiring firm (software). Budget: hourly, <30 hrs/wk, 1-3 months. https://www.upwork.com/freelance-jobs/apply/B2B-Lead-Generation-Appointment-Setter-for-Buyers-Automation-Engineering-Talent-Hiring_~022124885390217291912/

**2. BD hiring (GetLeads jobs, Sales & BD, US, posted since 2026-08-28).** About 21 own-BD postings estimated at companies with an agency word in their name (sample of 11 in this segment); 57 postings whose title names the segment and 'staffing'. Top states in the sample: TX (3), GA (2), CA (1), PA (1), NY (1).

**3. Pain conversations.** 20 items (8 in 90 days). Intensity **3/5**: Recurring complaints: SIA says IT sales is at its hardest since early 2020 (35% name new orders or clients as the top challenge), vendor rosters are being cut to 3-4, and clients are insourcing or direct sourcing. Demand is only slowly recovering (+1-2%).
- (news, 2025-11-06) About a third of IT staffing firms say getting new orders or clients is their biggest challenge, the worst since early 2020. https://www.staffingindustry.com/editorial/it-staffing-report/solving-the-sales-problem-in-it-staffing
- (news, 2025-11-06) IT sales yields about 4 orders per 1,000 calls, versus 9 in healthcare and 16 in industrial. https://www.staffingindustry.com/editorial/it-staffing-report/solving-the-sales-problem-in-it-staffing
- (news, 2026-04-17) Clients are typically cutting a dozen staffing vendors down to three or four. https://www.kore1.com/it-staffing-trends-2026/
- (forum, undated) Q&A answer: winning direct clients or prime-vendor status is the hardest part, because nobody disturbs the current setup without a reason. https://www.quora.com/How-do-I-get-direct-clients-for-IT-staffing-business
- (news, 2026-11-02) Analysts: AI lets clients do some hiring themselves and lets new staffing firms enter easily, so margins will be structurally lower. https://www.staffingindustry.com/news/global-daily-news/reluctant-improvement-seen-for-staffing-industry
- Also counted: Five more first-hand Reddit threads in the 90-day window (no stable link returned): an IT-staffing seller asking how to win B2B accounts; two bench-sales recruiters struggling to find vendors with open requirements; US IT recruiters calling the market frustrating; and an IT-staffing worker saying requirements that used to arrive in the thousands have collapsed.

Already tried: cold calling hiring managers (3); VMS/MSP bids (speed/volume play) (3); LinkedIn outreach and email (2); subcontracting through prime vendors / implementation partners (2); shift to SOW/solutions or engaged/retained searches (3); AI tools for business development (2); account mining existing clients (1); networking and referrals (2).

**4. Competitors** (9 selling to this segment):
- Belkins (belkins.io): appointment setting / omnichannel outbound (cold email, LinkedIn, calling, paid ads). Pricing: Custom; third-party estimate ~$5,000-$14,800+/mo (Cleverly list); search snippet of Belkins blog: from $8,000/mo for 100 guaranteed appointments/yr. Reviews: Clutch 230 reviews @ 4.9; G2 93 reviews @ 4.8.
- Launch Leads (launchleads.com): appointment setting (US SDRs, phone + email); retainer. Pricing: Retainer, custom quote (no public rate; explicitly not pay-per-lead). Reviews: Clutch 4 reviews @ 4.9; G2 7 reviews @ 4.5.
- CFE Marketing Services (cfemarketingservices.com): appointment setting (US callers, cold calling + cold email); separate pages per staffing vertical. Pricing: Custom per project, month to month (no public figure).
- Agency Leads (agency-leads.com): lead lists / job-posting-based lead database for staffing agencies (hiring-company + hiring-manager contacts). Pricing: $486-$625/mo for 500 exports/mo (term-dependent); 'Open Web Leads' plan ~$142-$167/mo.
- Rev-Empire (rev-empire.com): appointment setting or pay-per-qualified-lead introductions to employers with live vacancies. Pricing: Pay-per-lead or managed campaign; no public figures.
- Callbox (callboxinc.com): appointment setting / multichannel outsourced SDR for IT staffing companies. Pricing: Quote only; third-party estimate ~$5,000-$15,000/mo (Cleverly list). Reviews: Google 85 reviews @ 4.5; Clutch 100 reviews; G2 90 reviews @ 4.5.
- eGrabber JobGrabber (egrabber.com): lead lists from job postings for staffing agencies (positions itself as tool for IT staffing lead generation). Pricing: Not captured (pricing page 404).
- Appointment Setter Online (appointmentsetteronline.com): appointment setting / IT recruitment lead generation (month-to-month). Pricing: Month-to-month; no public figure captured.
- AInora (ainora.lt): AI SDR / AI voice agent that finds employers with live hiring needs and books meetings for agencies. Pricing: Not public.

**5. Search interest.** "it staffing" share of the control term "staffing agency" moved +11% (last 13 weeks vs the 13 before). "it staffing clients / marketing" had too little volume to trend.

### Healthcare: 70.7

**1. Paid requests.** 12 posts found (3 dated inside 90 days). Budgets seen: base hourly + commission (amount not visible); 30+ hrs/wk, 6+ months; hourly or milestone, rate TBD; $250-750 fixed; INR 1,000-3,000 fixed; INR 750-1,250/hr (~$9-15/hr); PHP 24,000-26,000/mo + commission (~$410-445/mo); PHP 24,000-26,000/mo; PHP 24,000-26,000/mo.
- Upwork, undated: Healthcare staffing and home care agency needs US BD rep to win facility staffing contracts. Budget: base hourly + commission (amount not visible); 30+ hrs/wk, 6+ months. https://www.upwork.com/freelance-jobs/apply/Business-Development-Rep-Medical-Staffing-Contracts-Hospitals-SNFs-ALFs-Home-Health_~022074359445906193895/
- Upwork, undated: Healthcare staffing firm wants experienced contract acquisition manager for facility clients. Budget: hourly or milestone, rate TBD. https://www.upwork.com/freelance-jobs/apply/Healthcare-staffing-contracts-acquisition-manager_~022061801118143306378/
- Upwork, undated: Healthcare recruitment agency wants German-speaking cold caller to win healthcare facility clients. Budget: not visible. https://www.upwork.com/freelance-jobs/apply/German-Speaking-Cold-Caller-B2B-Healthcare-Recruitment_~022118399564295544564/

**2. BD hiring (GetLeads jobs, Sales & BD, US, posted since 2026-08-28).** About 2 own-BD postings estimated at companies with an agency word in their name (sample of 2 in this segment); 24 postings whose title names the segment and 'staffing'. Top states in the sample: NJ (1), PA (1).

**3. Pain conversations.** 18 items (7 in 90 days). Intensity **3/5**: Recurring complaints after a multi-year decline: about 74-87% of travel revenue runs through MSP/VMS, clients want an 'agency-free' model with rebates, margins are near 20%, and facilities say they already have enough vendors. 2026 growth is propped up by strike work. No widespread public closure talk from small owners was found.
- (reddit, within 90d) New healthcare staffing founder: roughly $700K revenue in under 10 months; the thread digs into running cold email from about 100 mailboxes and how to keep doing BD with 20+ open roles. https://www.reddit.com/r/RecruitmentAgencies/comments/1xuluhc/just_passed_700k_in_revenue_less_than_10_months/
- (reddit, within 90d) Agency founder: generic cold emails to other agencies were mostly ignored. https://www.reddit.com/r/RecruitmentAgencies/comments/1xrx763/built_a_recruiter_agency/
- (reddit, within 90d) Founder launching a respiratory-therapy staffing agency: has interested clients and clinicians, but can't find a reliable employer-of-record to start. https://www.reddit.com/r/smallbusiness/comments/1xav0nc/why_is_it_so_hard_to_find_a_reliable_employer_of/
- (news, 2026-06-16) The 'agency-free' push from 2023 brought rate pressure, then demands for rebates and concessions, with little relief in 2026. https://staffinghub.com/healthcare-staffing/healthcare-staffing-reset-2026/
- (news, 2026-05-14) About three-quarters of travel nurse revenue now comes through MSPs, and median gross margin fell to about 20%. https://www.staffingindustry.com/editorial/healthcare-staffing-report/signs-of-stability-in-travel-nursing-but-profitability-challenges-remain
- Also counted: Two more founder threads (starting a medical staffing agency and fearing failure with first clients; seeking a co-founder) and a locum-agency BD fireside chat on LinkedIn.

Already tried: joining MSP/VMS programs (3); cold calling facilities (2); calling former managers / warm contacts (1); undercutting bill rates to get started (1); state/government contract bids (1); hiring a consultant from an established agency (1); preferred-vendor agreements with SLAs (1); SEO / marketing (1).

**4. Competitors** (10 selling to this segment):
- Belkins (belkins.io): appointment setting / omnichannel outbound (cold email, LinkedIn, calling, paid ads). Pricing: Custom; third-party estimate ~$5,000-$14,800+/mo (Cleverly list); search snippet of Belkins blog: from $8,000/mo for 100 guaranteed appointments/yr. Reviews: Clutch 230 reviews @ 4.9; G2 93 reviews @ 4.8.
- Launch Leads (launchleads.com): appointment setting (US SDRs, phone + email); retainer. Pricing: Retainer, custom quote (no public rate; explicitly not pay-per-lead). Reviews: Clutch 4 reviews @ 4.9; G2 7 reviews @ 4.5.
- CFE Marketing Services (cfemarketingservices.com): appointment setting (US callers, cold calling + cold email); separate pages per staffing vertical. Pricing: Custom per project, month to month (no public figure).
- Agency Leads (agency-leads.com): lead lists / job-posting-based lead database for staffing agencies (hiring-company + hiring-manager contacts). Pricing: $486-$625/mo for 500 exports/mo (term-dependent); 'Open Web Leads' plan ~$142-$167/mo.
- StaffingFuture (staffingfuture.com): full-service marketing tech (staffing websites, job boards, lead generation platform). Pricing: Pricing page exists; figures not captured.
- Rev-Empire (rev-empire.com): appointment setting or pay-per-qualified-lead introductions to employers with live vacancies. Pricing: Pay-per-lead or managed campaign; no public figures.
- Definitive Healthcare (definitivehc.com): lead data / healthcare commercial intelligence for staffing firms (facility contacts, RFPs, contract-labor spend). Pricing: Quote / free trial; no public figure.
- Ampliz (ampliz.com): lead data for healthcare staffing companies (hospital contacts, RFPs, contract labor). Pricing: Not captured.
- SalesPro Leads (salesproleads.com): appointment setting / lead generation for healthcare sellers incl. 'Staffing & Travel Nurse Agencies'. Pricing: Not public on page; Sales.co comparison cites $3,000-$8,000/mo typical, pay-per-meeting $150-$600 (attribution uncertain).
- Blueprint Business Solutions (blueprintbusinesssolutionscorp.com): lead generation / SDR for healthcare staffing agencies (facility outreach). Pricing: not public.

**5. Search interest.** "healthcare staffing" share of the control term "staffing agency" moved -12% (last 13 weeks vs the 13 before). "healthcare staffing clients / marketing" had too little volume to trend.

### Industrial (baseline): 47.4

**1. Paid requests.** 5 posts found (0 dated inside 90 days). Budgets seen: $15-25/hr; $1,000 fixed shown; pay per qualified held meeting + success fee per converted account; 1000/mo (currency unstated, likely USD); INR 100-400/hr (~$1.2-4.8/hr); INR 1,500-12,500 (~$18-150).
- Upwork, undated: Light-industrial and general-labor staffing firm needs US caller for manufacturing/construction leads. Budget: $15-25/hr. https://www.upwork.com/freelance-jobs/apply/Outbound-Caller-for-Staffing-Leads_~022080685435340250044/
- Upwork, undated: Staffing firm wants performance-paid appointment setter targeting warehouse and plant buyers. Budget: $1,000 fixed shown; pay per qualified held meeting + success fee per converted account. https://www.upwork.com/freelance-jobs/apply/Performance-Based-B2B-Appointment-Setter-and-Sales-Closer-Staffing-Industry_~022082507675855543261/
- OnlineJobs.ph, updated 2026-03-16: US staffing firm supplying manufacturing, food processing, farm, warehouse labor needs full-time cold caller. Budget: 1000/mo (currency unstated, likely USD). https://www.onlinejobs.ph/jobseekers/job/1602367

**2. BD hiring (GetLeads jobs, Sales & BD, US, posted since 2026-08-28).** About 79 own-BD postings estimated at companies with an agency word in their name (sample of 42 in this segment); 11 postings whose title names the segment and 'staffing'. Top states in the sample: TX (8), AZ (5), NC (5), VA (5), CA (3).

**3. Pain conversations.** 12 items (3 in 90 days). Intensity **2/5**: Complaints focus on clients cutting vendor lists, little client loyalty and margin pressure, but 2026 demand is recovering (SIA raised its industrial forecast from +1% to +7% on 2026-09-18). No public 'we may close' talk was found.
- (reddit, within 90d) Agency owners comparing client-acquisition methods: pick one sector and cold call; one says about 90% of their business comes from cold calling. https://www.reddit.com/r/RecruitmentAgencies/comments/1wnc08c/getting_clients/
- (news, 2026 (exact date not shown)) Big manufacturing and logistics employers are cutting vendor lists and giving volume to fewer, larger staffing partners. This is called the main cause of 2026 margin pressure. https://www.avionte.com/blog/light-industrial-staffing-in-2026-whats-changing-and-how-to-stay-competitive-moving-into-2027/
- (news, 2025-2026 (date not confirmed)) Survey: most industrial buyers have switched staffing providers at some point, usually over slow fills or unreliable workers. Some now hire temps directly. https://www.staffingindustry.com/news/global-daily-news/industrial-firms-rely-on-temp-staffing-but-show-little-loyalty
- (news, 2026-04-02) Commentary: during the three-year temp downturn, temps were the first cost lever clients pulled, and direct sourcing is now building client talent pipelines in-house. https://www.staffingindustry.com/editorial/staffing-stream/the-rolling-recession-no-one-s-talking-about
- (news, 2026-04-10) From July 2022 to July 2025, staffing jobs fell about a quarter in manufacturing and about a fifth in transportation and logistics, two of the client sectors squeezing agencies most. https://www.kaplancollectionagency.com/debt-collection-2/which-industries-are-putting-staffing-agencies-under-the-most-pressure/

Already tried: referral programs / asking current clients for referrals (4); cold calling factories and warehouses (3); cold email to hiring or plant managers (2); case studies and fill-rate proof points (2); free trial hours or discounted first order (1); bidding through MSP/VMS programs (1).

**4. Competitors** (10 selling to this segment):
- Launch Leads (launchleads.com): appointment setting (US SDRs, phone + email); retainer. Pricing: Retainer, custom quote (no public rate; explicitly not pay-per-lead). Reviews: Clutch 4 reviews @ 4.9; G2 7 reviews @ 4.5.
- CFE Marketing Services (cfemarketingservices.com): appointment setting (US callers, cold calling + cold email); separate pages per staffing vertical. Pricing: Custom per project, month to month (no public figure).
- CallingAgency (callingagency.com): appointment setting / cold calling + email for contract, direct-hire and temp staffing agencies. Pricing: not public. Reviews: Clutch 19 reviews @ 5.0; G2 20 reviews @ 5.0; Trustpilot 19 reviews @ 4.6.
- Alleyoop (alleyoop.io): appointment setting dedicated to industrial & light-industrial staffing (meetings with plant/warehouse/ops managers). Pricing: $5,250/mo (1 dedicated rep) to $14,750/mo (3 reps), six-month terms.
- Agency Leads (agency-leads.com): lead lists / job-posting-based lead database for staffing agencies (hiring-company + hiring-manager contacts). Pricing: $486-$625/mo for 500 exports/mo (term-dependent); 'Open Web Leads' plan ~$142-$167/mo.
- IndustrySelect (MNI) (industryselect.com): lead lists: manufacturer/industrial database marketed to staffing & recruiting firms. Pricing: Not public; free demo (500 demo leads).
- StaffingFuture (staffingfuture.com): full-service marketing tech (staffing websites, job boards, lead generation platform). Pricing: Pricing page exists; figures not captured.
- Rev-Empire (rev-empire.com): appointment setting or pay-per-qualified-lead introductions to employers with live vacancies. Pricing: Pay-per-lead or managed campaign; no public figures.
- RipeLeads (ripeleads.eu): outbound lead generation for recruitment agencies with blue-collar niches (warehouse, production, drivers, trades). Pricing: Possibly EUR 3,750 first month then EUR 2,850/mo (attribution in comparison table unverified).
- Haley Marketing (haleymarketing.com): full-service marketing for staffing firms (websites, SEO, PPC, content, recruitment marketing). Pricing: Not public.

**5. Search interest.** "industrial staffing" share of the control term "staffing agency" moved -26% (last 13 weeks vs the 13 before). "industrial staffing clients / marketing" had too little volume to trend.

### Engineering / technical contract: 27.7

**1. Paid requests.** 1 posts found (0 dated inside 90 days). Budgets seen: commission-only.
- Company job board (SmartRecruiters; mirrored on DailyRemote), undated: Engineering and technology recruiting firm seeks 1099 commission-only rep to open client relationships. Budget: commission-only. https://jobs.smartrecruiters.com/talentconnection1/744000113069044

**2. BD hiring (GetLeads jobs, Sales & BD, US, posted since 2026-08-28).** About 73 own-BD postings estimated at companies with an agency word in their name (sample of 28 in this segment); 7 postings whose title names the segment and 'staffing'. Top states in the sample: NJ (10), NC (4), FL (4), PA (4), CA (1).

**3. Pain conversations.** 7 items (3 in 90 days). Intensity **2/5**: Engineering staffing is growing (+3% forecast for 2026, data centers and energy). Pain is limited to wind and oil and gas pockets, an April 2026 softening in job orders, and VMS/MSP fee creep.
- (news, 2026-09-23) Oil and gas demand is holding flat because the major producers have spent two years cutting headcount. https://www.staffingindustry.com/editorial/engineering-staffing-report/engineering-staffing-rebounds-with-3-growth
- (news, 2026 (exact date not shown)) Staffing demand in wind energy has cooled sharply since the federal policy changes. https://www.asme.org/topics-resources/content/as-energy-needs-rise,-demand-for-temporary-engineers-grows
- (news, 2026-06-05) IT and engineering staffing executives saw softening in April, and early Q2 new-job-order numbers signal caution. https://techservealliance.org/reports/may-executive-insights-the-it-staffing-market-is-bifurcating/
- (news, 2026-06-05) New VMS 'platform tax' fees on top of MSP fees make mid-tier accounts uneconomic. Several firms are walking away from MSP programs. https://techservealliance.org/reports/may-executive-insights-the-it-staffing-market-is-bifurcating/
- (news, 2026-02-18) Pure-play staffing still faces headwinds from slower hiring and low worker mobility. Project-based work has held up better. https://techservealliance.org/the-it-engineering-staffing-market-in-early-2026-signals-of-movement-tests-of-execution/
- Also counted: Two LinkedIn items in the 90-day window (not linked, they carry personal names): an engineering-staffing recruiter openly asking for new clients, and an IT & engineering staffing commentary saying new clients now take more effort.

Already tried: MSP/VMS program participation (some firms now exiting) (2); shift to project/SOW and consulting work (2); referrals and industry networks (1).

**4. Competitors** (3 selling to this segment):
- Belkins (belkins.io): appointment setting / omnichannel outbound (cold email, LinkedIn, calling, paid ads). Pricing: Custom; third-party estimate ~$5,000-$14,800+/mo (Cleverly list); search snippet of Belkins blog: from $8,000/mo for 100 guaranteed appointments/yr. Reviews: Clutch 230 reviews @ 4.9; G2 93 reviews @ 4.8.
- Launch Leads (launchleads.com): appointment setting (US SDRs, phone + email); retainer. Pricing: Retainer, custom quote (no public rate; explicitly not pay-per-lead). Reviews: Clutch 4 reviews @ 4.9; G2 7 reviews @ 4.5.
- AInora (ainora.lt): AI SDR / AI voice agent that finds employers with live hiring needs and books meetings for agencies. Pricing: Not public.

**5. Search interest.** "engineering staffing" share of the control term "staffing agency" moved -39% (last 13 weeks vs the 13 before). "engineering staffing clients / marketing" had too little volume to trend.

### Construction labor: 16.1

**1. Paid requests.** 0 posts found (0 dated inside 90 days). Budgets seen: none.
- None found.

**2. BD hiring (GetLeads jobs, Sales & BD, US, posted since 2026-08-28).** About 43 own-BD postings estimated at companies with an agency word in their name (sample of 22 in this segment); 5 postings whose title names the segment and 'staffing'. Top states in the sample: TX (6), NC (4), FL (2), KS (1), WI (1).

**3. Pain conversations.** 6 items (1 in 90 days). Intensity **1/5**: Construction demand is soft outside data centers, but contractors are keeping workers and labor shortages persist. No staffing-owner complaints about winning clients were visible.
- (reddit, within 90d) Counter-signal: a salesperson recommends construction staffing as a career because a handful of big projects or the right customer lets you grow fast with good margins. https://www.reddit.com/r/sales/comments/1w7qedn/tech_sales_isnt_what_it_used_to_be_what_other/
- (news, 2026-09-03) Data-center work keeps labor tight even as demand for many other project types stays soft. https://www.agc.org/news/2026/09/03/construction-workforce-shortages-remain-acute-despite-soft-market-conditions-data-centers-strain
- (news, 2026-05-18) Construction hiring has slowed, but contractors are holding on to the workers they have. https://www.enr.com/articles/63012-construction-hiring-slows-but-contractors-keep-workers
- (news, 2026 (exact date not shown)) Construction hiring stays flat as the industry faces soft 2026 demand. https://www.constructionowners.com/news/construction-hiring-remains-flat-as-industry-faces-soft-demand-in-2026
- (forum, older (pre-2024)) Contractor forum: you land work far more often talking face to face than by cold calling or faxing. https://www.contractortalk.com/threads/ideas-to-attract-clients.155176/

Already tried: face-to-face job-site visits / networking with GCs (2); referrals via suppliers and subcontractors (2); one-page intro mailers to local contractors (1); cold calling (said to be weak) (1).

**4. Competitors** (2 selling to this segment):
- Agency Leads (agency-leads.com): lead lists / job-posting-based lead database for staffing agencies (hiring-company + hiring-manager contacts). Pricing: $486-$625/mo for 500 exports/mo (term-dependent); 'Open Web Leads' plan ~$142-$167/mo.
- Elevato Digital (elevatodigital.com): full-service digital marketing (paid media, local SEO); case study for a national construction staffing agency. Pricing: Not public.

**5. Search interest.** "construction staffing" share of the control term "staffing agency" moved -35% (last 13 weeks vs the 13 before). "construction staffing clients / marketing" had too little volume to trend.

### Office / admin: 15.6

**1. Paid requests.** 0 posts found (0 dated inside 90 days). Budgets seen: none.
- None found.

**2. BD hiring (GetLeads jobs, Sales & BD, US, posted since 2026-08-28).** About 10 own-BD postings estimated at companies with an agency word in their name (sample of 4 in this segment); 0 postings whose title names the segment and 'staffing'. Top states in the sample: GA (1), CT (1), MA (1), TX (1).

**3. Pain conversations.** 7 items (1 in 90 days). Intensity **2/5**: Data shows the weakest segment (office/clerical down 12-14% YoY mid-2026 and still about 7% below 2025 in October; AI displacing admin roles), but almost no public practitioner talk about winning clients was visible.
- (news, 2026-06-26) Office/clerical staffing fell 12% year over year, the worst of the commercial segments. https://staffinghub.com/news/staffinghub-brief-sia-confidence-at-4-year-high-ai-adoption-yields-low-roi-and-californias-new-layoff-mandates/
- (news, 2026-10 (indicator)) Office/clerical hours reached a 2026 high but were still about 7% below 2025. https://www.staffingindustry.com/research/research-reports/americas/sia-bullhorn-staffing-indicator-october-20-2026
- (news, 2026-07-02) Admin support unemployment rose, and federal projections expect the occupation to keep shrinking. https://www.ksat.com/business/2026/07/02/a-grim-job-outlook-meets-a-scrappy-workforce-as-administrative-assistants-harness-ai/
- (news, 2026-04-10) Admin and support services put the most pressure on agencies, with staffing jobs down nearly 30% over three years. https://www.kaplancollectionagency.com/debt-collection-2/which-industries-are-putting-staffing-agencies-under-the-most-pressure/
- (news, 2026-06-29) Market share of the largest office/clerical firms keeps slipping, which shifts opportunity to smaller suppliers. https://www.staffingindustry.com/news/cws-global-daily-news/officeclerical-supplier-landscape-shifts-beyond-biggest-firms

Already tried: no first-hand accounts found.

**4. Competitors** (3 selling to this segment):
- Launch Leads (launchleads.com): appointment setting (US SDRs, phone + email); retainer. Pricing: Retainer, custom quote (no public rate; explicitly not pay-per-lead). Reviews: Clutch 4 reviews @ 4.9; G2 7 reviews @ 4.5.
- CFE Marketing Services (cfemarketingservices.com): appointment setting (US callers, cold calling + cold email); separate pages per staffing vertical. Pricing: Custom per project, month to month (no public figure).
- StaffingFuture (staffingfuture.com): full-service marketing tech (staffing websites, job boards, lead generation platform). Pricing: Pricing page exists; figures not captured.

**5. Search interest.** "office staffing" share of the control term "staffing agency" moved -24% (last 13 weeks vs the 13 before). "office staffing clients / marketing" had too little volume to trend.

### CDL / driver: 5.3

**1. Paid requests.** 0 posts found (0 dated inside 90 days). Budgets seen: none.
- None found.

**2. BD hiring (GetLeads jobs, Sales & BD, US, posted since 2026-08-28).** About 1 own-BD postings estimated at companies with an agency word in their name (sample of 1 in this segment); 1 postings whose title names the segment and 'staffing'. Top states in the sample: AZ (1).

**3. Pain conversations.** 6 items (1 in 90 days). Intensity **1/5**: No public posts by driver-staffing owners about winning clients were found. Trucking coverage shows soft freight volumes, but driver supply is tightening and carriers say they will hold or raise contingent-driver use.
- (forum, 2025-05-07) Forum post: the trucking industry is very slow, and some companies are not hiring anyone. https://www.thetruckersreport.com/truckingindustryforum/posts/13186862
- (news, 2025-11-18) Industry voice: removing non-domiciled CDL drivers will not fix trucking unless freight demand also comes back. https://www.freightwaves.com/news/why-demand-not-truck-attrition-may-decide-the-fate-of-small-carriers-in-2026
- (news, 2026 (exact date not shown)) The 2026 freight market has stabilized without strengthening. Truckload demand is still soft and uneven (driver-staffing firm's blog). https://www.transforce.com/carriers/carrier-resources/trucking-industry-issues-entering-2026
- (news, 2026 (Q2 coverage)) Truck capacity tightened in Q2 2026 even as shipment volumes kept falling. https://www.ccjdigital.com/economic-trends/freight-demand/article/15832004/is-the-truck-driver-shortage-back
- (news, 2026-07 (report)) Survey: most carriers will keep contingent-driver use flat in 2026, and about a third plan to increase it. https://www.centerlinedrivers.com/state-of-trucking-2026/

Already tried: guarantee or replacement periods (60-90 days) to win carriers (1); job-board and digital driver recruiting ads (1); case studies for logistics clients (1).

**4. Competitors** (3 selling to this segment):
- Rev-Empire (rev-empire.com): appointment setting or pay-per-qualified-lead introductions to employers with live vacancies. Pricing: Pay-per-lead or managed campaign; no public figures.
- RipeLeads (ripeleads.eu): outbound lead generation for recruitment agencies with blue-collar niches (warehouse, production, drivers, trades). Pricing: Possibly EUR 3,750 first month then EUR 2,850/mo (attribution in comparison table unverified).
- Haley Marketing (haleymarketing.com): full-service marketing for staffing firms (websites, SEO, PPC, content, recruitment marketing). Pricing: Not public.

**5. Search interest.** "driver staffing" share of the control term "staffing agency" moved -45% (last 13 weeks vs the 13 before). "driver staffing clients / marketing" had too little volume to trend.

## Method

- **Paid requests:** WebSearch over Upwork, Freelancer, PeoplePerHour, Guru, Contra, OnlineJobs.ph, Workana and job boards, plus a capped Firecrawl search of Upwork limited to the 90-day window. Counted only posts where a staffing or recruiting agency of that segment buys lead generation, appointment setting, cold calling or cold email. Upwork and Fiverr block direct fetches, so details come from search snippets; Fiverr buyer requests are not indexed. Score = 50 x total / max + 50 x dated-90d / max.
- **BD hiring:** GetLeads `search_jobs` (free jobs quota), Sales & Business Development function, US, posted since 2026-08-28. Two indices, averaged: (a) postings at companies whose name contains staffing, personnel, workforce, labor, recruiting, temps or employment (2,355 postings; 1,632 sampled), kept only when the title is a BD/sales role and the text describes selling staffing services (job orders, temporary labor, staffing services), segment-tagged from the posting text and scaled by each word's total; (b) postings whose title names the segment plus "staffing". Index (a) favours industrial-style agency names; (b) offsets that, because large IT and healthcare firms rarely use those words in their names. Each index is scored against its max, then averaged.
- **Pain:** WebSearch over forums, Q&A, podcasts and trade press, plus a capped Firecrawl search of Reddit and public LinkedIn posts limited to the 90-day window. Reddit was not reachable directly (blocked) and the public Reddit archive refuses automated agents, so only search-indexed threads are included. Score = 60 x intensity / 5 + 40 x threads in 90d / max.
- **Competitors:** providers whose offer names the segment (appointment setting, cold email, lead data). Generalist "for staffing agencies" providers are listed below. Score = 100 x count / max. More competitors are read as validated demand, not as a deterrent.
- **Search:** Google Trends public API, US, 12 months, weekly. The "clients/marketing" phrases are near zero, so the broad "<segment> staffing" term is used, as a share of "staffing agency" to remove a market-wide drop (the control itself fell 20%). Score = min-max of the share change across segments.

**Generalist providers selling to all staffing agencies** (28): Belkins (Custom; third-party estimate ~$5,000-$14,800+/mo (Cleverly list); search snippet of Belkins blog: from $8,000/mo for 100 guaranteed appointments/yr); Launch Leads (Retainer, custom quote (no public rate; explicitly not pay-per-lead)); CFE Marketing Services (Custom per project, month to month (no public figure)); CallingAgency; SalesHive (Custom monthly fee; does not price per meeting; Sales.co cites month-to-month); Abstrakt Marketing Group (Outbound BDR from $5,000/mo; bundle from $6,500/mo; inbound SDR from $1,000/mo); Sopro (Not public); SalesBread (~$3,000/mo + setup fee (third-party estimates $3,000-$7,000+/mo, Cleverly list)); Cleverly (Cold email from $1,995/mo; LinkedIn from ~$397/mo (provider/third-party)); LeadHaste (Free pilot; no rate published); Sales.co ($1,500/mo (90-day pilot) or $2,500/mo month-to-month, $0 setup; cold calls +$2,000/mo; LinkedIn +$1,000-$2,500/mo); Intelemark (Paid hourly, never per meeting; rate not published); StaffingScale Marketing for Staffing Firms (Not captured); Haley Marketing (Not public); Pivotal Outreach; ProspectOut; FirstSales (From $29/mo; $1 3-day trial); Landbase; TheirStack (Free tier / from $59/mo (third-party comparison, may be stale)); StaffingLeads; Remote CoWorker; Leads2Grow LLC; Growleady; 1Digital Agency; Advance Partners Marketing Services; AInora (Not public); Alleyoop ($5,250/mo (1 dedicated rep) to $14,750/mo (3 reps), six-month terms); Agency Leads ($486-$625/mo for 500 exports/mo (term-dependent); 'Open Web Leads' plan ~$142-$167/mo).

## Caveats

- Most counts are small samples. Paid-request totals are posts actually found, not market size; only 1 paid post had a visible date inside 90 days before the Firecrawl pass.
- Pain evidence is mostly trade press. First-hand owner threads came only through search snippets; candid Reddit discussion is under-represented for every segment, and LinkedIn posts with personal names are counted but not linked.
- BD hiring index (a) misses agencies without an agency word in the name; index (b) misses BD roles whose title omits the segment. Neither is a census.
- Segments overlap: one agency can be industrial, construction and CDL at once, so a posting can count in more than one segment.
- Industry data cuts against pain for industrial, engineering, construction and CDL in 2026 (industrial forecast raised to +7%; driver and construction labor tight). Low pain there may be real.
- SIA benchmark worth noting for outreach: IT staffing sales yields about 4 orders per 1,000 calls, healthcare about 9 and industrial about 16 (2025-11).
- Google Trends values for niche terms are low-volume and noisy.

## Spend

| Tool | Before | After | Used | Notes |
|---|---|---|---|---|
| Firecrawl | n/a | n/a | **50 credits** | 25 charged searches at 2 credits each (4 empty searches were free), from `creditsUsed` on each call |
| GetLeads plan credits | 5,164 | 5,164 | 0 | `search_jobs` uses the separate free jobs quota (about 2,760 of 200,000 daily job records) |
| Adyntel | not touched | | 0 | per-request billing, so not used |
| Apify | not used | | $0 | |
| WebSearch / Google Trends | free | | 0 | |

**Total: 50 of the 100-credit cap.**

