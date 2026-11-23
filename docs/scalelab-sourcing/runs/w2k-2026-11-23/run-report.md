# 2,000-company run: discovery to contact-ready list (2026-11-23)

**Wave:** `w2k-2026-11-23`. **Toolkit:** `docs/scalelab-sourcing/tools/` (run date 2026-11-23, Jev `jev-1.14.0`, scoring `initial-2026-11-18`).

**Owner brief:** run the workflow on 2,000 net-new companies (after dedupe) through to a reviewed list of contact-ready leads. Adyntel option A: Google + Meta only, only for companies with a confirmed buyer, checked before the reveal. Stop before import and queue.

**Production side effects:** none. Supabase was read only. Nothing was imported, queued or sent.

## Spend

| Tool | Cap | Used | Measured by |
|---|---|---|---|
| Jev | $0.40 | **$0.249** (1,624 ICP gate requests plus 13 ad-classification requests) | `jev_usage.jsonl`; hard stop in `qualify.py` |
| Adyntel | 400 | **202** (228 requests; 24 returned 204 no-content and were not billed) | balance 4,077 → 3,875 |
| Apollo | 200 | **114** (standard reveal; no waterfall, phone or personal email) | credit stats 874 → 988 |
| GetLeads | 150 | **0** | — |

Discovery (Apollo organization lookup) and buyer search (Apollo people search) are free and did not change the Apollo balance.

## Funnel

| Stage | Count |
|---|---|
| Unique candidates found (Apollo organization lookup, 51 states and DC, 11–500 employees, 17 industrial staffing tags) | 4,787 |
| Excluded before any spend | 2,192 |
| Net-new | 2,595 |
| **Run set** (round-robin across states) | **2,000** (595 kept as a free reserve) |
| Readable first-party site (≥1,500 characters after plain HTTP plus headless retry) | 1,607 |
| **ICP PASS** | **212** |
| PASS with a named buyer who has an email on file (free search) | 114 |
| Revealed (all matched, all verified) | 114 |
| **Contact-ready** (READY_FOR_REVIEW, appended to the V4 master) | **100** |
| Industrial Campaign 3 copy selected (read-only preview) | 96 (94 COPY_C, 2 COPY_A); 4 copy holds |

## Dedupe (free, before any paid step)

Exclusion set of 5,978 domains:

- **Production `outreach_leads`, all clients:** 4,919 website and email domains. The 4,487 company names were checked too.
- **Pilot, wave 1 and the Codex re-check research:** 1,045 domains, including redirect and email domains.
- **The V4 master.**

| Reason left out | Count |
|---|---|
| Domain already in production or earlier research | 1,502 |
| Company-name collision with a production lead (owner review, never paid) | 219 |
| No domain in Apollo | 156 |
| Name clearly outside the ICP (IT, healthcare, legal, executive search, accounting) | 297 |
| National chain or franchise system | 18 |

After the crawl, 9 more companies were found to redirect to a domain already in production or earlier research. They were marked duplicate and replaced from the reserve.

## Crawl and ICP gate

The crawl ran plain HTTP first, then default headless Chromium for 516 thin or blocked sites. Final outcome: 1,607 readable sites and 393 thin, blocked or dead.

Two toolkit fixes came out of this run:

- **Plain HTTP crawl:** a malformed link no longer stops the whole crawl. It had stopped at site 282.
- **Headless retry:** each site has a 90-second watchdog. Three workers had hung for an hour.

| Decision | Count | Main reasons |
|---|---|---|
| PASS | 212 | Verified US employer-facing staffing with a substantive industrial or skilled-trades line placing hands-on workers |
| HOLD | 1,149 | Industrial line not established (379); site not readable (373); only excluded verticals at the threshold (124); placement model unclear (62); hands-on placement not shown (58); US operations not corroborated (42); executive search possible (~25); manual review (16) |
| REJECT | 648 | Only excluded verticals: IT, healthcare, office or executive (461); a contractor or employer hiring for itself (101); unrelated business, HR tech, job board or training (~45); hands-on placement not shown (16); redirect duplicate (9) |

**The PASS rate (13% of readable sites) is well below wave 1's 37%.** Apollo's broad "temporary staffing" and "temp agency" tags pulled in many office, IT and healthcare agencies, and the "labor" tags pulled in contractors. A future run should drop those two tags or pre-filter on Apollo's industry before the crawl.

**Manual review: 16 Jev PASS companies moved to HOLD for the owner.** `manual_review.json` is a tighten-only override in `icp_decide.py`.

| Reason | Count | Companies |
|---|---|---|
| IT-primary homepage | 7 | Techgene, Vastika, Cook Systems, Pantheon, MillenniumSoft, Infosoft, Acruex |
| Consulting, training and mobility firm | 1 | BSL Consulting |
| Healthcare staffing | 1 | Anodyne |
| Executive headhunting | 1 | Boutique Recruiting |
| Gig apps | 2 | Jobble, GigWorx |
| Nonprofits | 2 | CIERTO, Valeo Vocation |
| Strike and labor-dispute workforce | 1 | Special Response |
| Government and shipyard contracting workforce, possible chain | 1 | TAD PGS |

## Buyers, ads and reveals

**Free buyer search:** Apollo people search covered all 212 PASS companies and the 16 manual holds. It returned owners, founders, C-suite, partners and VPs. Picks followed the playbook order with no randomization (`buyer_pick.py`):

- tier 1: owner, founder, president, CEO, managing partner;
- tier 2: commercial executives;
- never picked: finance, technology, HR, recruiting and operations-only titles, and managing directors.

**114 PASS companies had a buyer with an email on file: 54%, against 27% in the Codex batch.** The other 98 PASS companies are listed as NO_ELIGIBLE_BUYER holds; waterfall enrichment was not used.

Two title-rule bugs were found and fixed during the run:

- "Product Owner" was counted as an owner. It was caught before the reveal.
- "Talent Partner" matched the partner rule. It was caught after the reveal and cost 2 credits on recruiters, both now held.

**Adyntel (option A):** Google + Meta for the 114 buyer companies before the reveal. 25 companies had ads.

| Ad class (Jev) | Companies |
|---|---|
| No ads observed | 89 |
| Unclear audience | 14 |
| Candidate recruitment | 9 |
| Employer acquisition (current) | 2 |

Only the 2 companies with current employer-facing ads score above zero (40). PASS companies without a buyer were not looked up; they score `NOT_CHECKED`, labelled INSUFFICIENT_EVIDENCE rather than LOW_SIGNAL.

**Reveals:** 114 in score order. All 114 matched at the right organization, with Apollo-verified emails.

## Contact QC

Rules:

- The email domain must be the company domain or proven related by a redirect, an on-site reference or a cross-link.
- Proofpoint plus catch-all is HOLD.
- No MX is HOLD (none found).
- Other catch-alls are kept, flagged and queued last.

| Result | Count | Detail |
|---|---|---|
| Differing email domain, proven related | 15 | Redirect or on-site reference; flagged on the row |
| Differing email domain, unproven: **HOLD** | 6 | Pathfinders, Sterling Personnel, United Staffing Solutions, Flash Staffing, Greenlight Connects, Pivotal Solutions |
| Email at another organization: **HOLD** | 2 | One buyer's email is at a national staffing firm (stale or departed); one is at a university domain |
| Revealed person is a recruiter: **HOLD** | 2 | ProRecruiters, Greene Resources |
| Proofpoint plus catch-all: **HOLD** | 4 | |
| **READY_FOR_REVIEW** | **100** | 91 tier 1 and 9 tier 2. 28 catch-all (queue last), 9 behind Proofpoint without catch-all. One buyer is a site-confirmed "Partner" at Gabriele & Company (caution flag) |

Dedupe at the email level: no revealed email domain is in production or earlier research, and no email is already in the V4 master.

## Industrial Campaign 3 copy (read-only preview, all 228 master leads)

**New leads:**

- **94 COPY_C:** each has a verified first-party specialty line.
- **2 COPY_A:** each has a current ad aimed at employers.
- **4 HOLD:** no first-party specialty quote could be extracted for Genuine Search Group, Innovative Labor and Cleaning Service, Labor Source Companies and New Wave People. They need a specialty line confirmed before import.

**Display names:** cleaned from legal names, for example "Premier Placements" for apartmentstaffing.com and "The Arnold Group". Review them in the preview before import.

## Waiting on the owner

1. **Import and queue the 96 copy-selected leads into Industrial Campaign 3.** Use explicit routing to the cold-eligible inboxes, catch-alls last. Not done without your go-ahead.
2. **Review the holds:**
   - the 16 manual-review companies;
   - the 219 name-collision candidates (never paid for);
   - the 4 copy holds;
   - the 10 QC holds.
3. **Optional, no spend yet:**
   - the 595-company reserve can be run the same way;
   - the 98 PASS companies with no buyer email could be tried with waterfall enrichment, at about 2–2.5 Apollo credits each.

## Files (CSV, evidence and preview are git-ignored)

- `approved-contacts.csv` (100)
- `review-holds.csv`
- `company-qualification.csv`
- `ranked-companies.csv`
- `ad-intent-and-signals.csv`
- `v4-copy-evidence.json`
- `preview/v4-preview.html` (all 228 master leads)
- Master: `docs/scalelab-sourcing/runs/V4_APPROVED_CONTACTS_MASTER.csv`, now 228 rows
- Working folder: `runs-private/w2k/` (local only)

## Follow-up (2026-11-23): import and queue

The owner approved importing and queueing the 96 copy-selected leads, routed explicitly to the eligible inboxes, with catch-alls last.

**Pre-checks (read only):**

- Cold-delivery gate: policy off, pool all. Eligible ScaleLab inboxes: `primary`, `deniels`, `outreachplateau_zoe`, `outreachplateau_merrick`, `outreachplateau_dave`.
- No agent pass running.
- 00:40 Pacific, outside the send windows.

**Import (production):** two calls so that catch-alls sort last. The send cron reads queued leads in `lead_id` order, and an id starts with the import time.

| Call | Received | Accepted and written | Refused | Variants |
|---|---|---|---|---|
| Non-catch-all | 69 | 69 | 0 | 68 COPY_C, 1 COPY_A |
| Catch-all | 27 | 27 | 0 | 26 COPY_C, 1 COPY_A |

Every catch-all id sorts after every non-catch-all id (checked). Both dry runs matched the live result.

**Queue:** explicit per-inbox calls, the non-catch-alls first. The split keeps each inbox's total load in line with its daily limit. All 96 queued: 0 refused, 0 conflicts, 0 failures.

| Inbox | Non-catch-all | Catch-all | Total new |
|---|---|---|---|
| primary | 24 | 9 | 33 |
| deniels | 21 | 9 | 30 |
| outreachplateau_zoe | 7 | 3 | 10 |
| outreachplateau_merrick | 8 | 3 | 11 |
| outreachplateau_dave | 9 | 3 | 12 |

**Post-checks:** live readiness shows `wouldSendIfSendingEnabled: true` for all 96.

**Refill fix deployed:** after queueing, the refill planner on `bf9ed96` proposed 60 moves into the three held inboxes (`tryscalelabai`, `scalelabaiteam`, `deniels_tryscalelabai`). The final gate would have blocked those sends, so the leads would have sat unsent. The scheduled refill applies its plan at 06:40 Pacific on weekdays.

The owner had already approved deploying the routing fix (`44679ab`, on the production branch). The deploy followed runbook §6:

- Railway was live on `bf9ed96`, the base of the fix.
- Full suite: 3,553 pass and 4 fail, all time-dependent and failing on `bf9ed96` too: 2 DST round-trips, the live-refill window, and a Jole fixture whose evidence date passed 45 days on 2026-11-23.
- Railway was re-pinned to `44679ab`. Deployment SUCCESS: all crons scheduled, send-lock enabled, refill plan 0 moves, eligible inboxes healthy, caps unchanged (ScaleLab 170/day).

**Industrial Campaign 3 after this run:** 217 leads (Supabase).

| State | Count |
|---|---|
| Queued for Email 1, all send ready | 185 (89 from the Codex re-check and 96 from this run) |
| In sequence after Email 1 | 32 (2 opted out and are stopped by the global suppression list) |
| **Send ready** (will receive their next email) | **215** |

The eligible ScaleLab inboxes send about 155 per day, so the Email 1 queue drains over about two weekday send days, with catch-alls last.
