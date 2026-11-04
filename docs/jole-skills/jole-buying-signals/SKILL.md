---
name: jole-buying-signals
description: Jole BTX demand-signal assessment (v1.1.0). Weighs what evidence suggests a company may need more skilled-trade workers, and when - craft hiring, project or contract awards, shipbuilding or fabrication backlog, facility expansion, production growth, turnarounds and outages, documented subcontract labor, stated shortages, contract mobilizations. Returns a signal status and a demand-only opportunity priority (PRIORITY A, PRIORITY B or NURTURE / RESEARCH), a provisional research-ranking band. Use for Jole signal research, demand questions and prioritizing prospects; load it directly, without the orchestrator, when demand or priority is the only question, for one company or a list. Never decides ICP fit. Requires the jolesbtxicpskill shared policy.
version: 1.1.0
---

# Jole buying-signal intelligence

**Question: what evidence suggests the employer may need additional skilled workers, and when?**

Version 1.1.0, 2026-11-03. Load the shared policy first (skill `jolesbtxicpskill`). Its evidence levels, freshness windows and labels apply here.

## Use it when

- Building a signal-based shortlist.
- Prioritizing or requalifying companies that are not EXCLUDED or PROHIBITED.
- Recording hiring evidence that copy may later rely on.

No buying signal is not equivalent to failed ICP qualification. This skill never changes the ICP label, and it does not choose buyers or copy.

## Inputs

- **Required:** the company and site; its ICP label (do not score an EXCLUDED company); why the task needs a signal (shortlist, priority, copy).
- **Optional:** evidence already found and its dates, prior research files, the ICP output's notes.

## Procedure

1. **Reuse first.** Start from evidence already recorded within the freshness windows (shared policy section 7). Cite it rather than searching again.
2. **Look where this kind of company shows demand.** Do not investigate every signal category for every company:
   - Shipyards: backlog and awards.
   - Plants and mills: expansions, outages and turnarounds.
   - Contractors: awards and mobilizations.
   - Anyone: craft hiring.
3. **Search in cost order:** the company's newsroom; its careers page or ATS; one news search (state economic development releases, trade press, award notices); filings at Level 3 only.
4. **Record each signal:** type, evidence level, date, labor window, crafts, scale (job counts or net new roles), source URL.
5. **Assess outside-labor evidence separately** (below).
6. **Set the status, then score demand.**
7. **Stop** once one verified current signal with a craft link and the outside-labor evidence are recorded, or when no remaining question could change the priority band. Name the highest-value open question.

## Signal types

| # | Signal | What must be confirmed |
|---|---|---|
| 1 | Active craft hiring | Verified posting with role, location and date. The only signal that supports a hiring claim in copy. |
| 2 | Project or contract award, contract mobilization | Scope, location and stage. Evidence of workload, not automatic proof of hiring. |
| 3 | Facility expansion | When labor is likely required. |
| 4 | Turnaround, outage or shutdown | Dates, trade relevance, buyer access and how labor is procured. |
| 5 | Production increase, shipbuilding or fabrication backlog | Current capacity versus distant, speculative work. |
| 6 | Existing use of subcontract labor | Strong signal, especially with active workload. Conrad's filings are the model example. |
| 7 | Stated workforce shortage | Who said it, when, and for which crafts. |
| 8 | Other verified operational trigger | The trigger and its link to craft work. |

**Separate a public announcement from a demonstrated need to purchase outside labor.** An award or expansion shows workload. Only type 6, or an explicit statement, shows that the company buys outside workers.

## Signal status

| Status | Rule |
|---|---|
| VERIFIED CURRENT SIGNAL | At least one VERIFIED signal whose labor window is active now or starts within 90 days |
| VERIFIED FUTURE SIGNAL | VERIFIED, but the window starts more than 90 days out or has no stated dates |
| POTENTIAL SIGNAL | Only POTENTIAL evidence: undated, unattributed, or not confirmed at the source (an aggregator listing before the employer's own board confirms it) |
| NO VERIFIED SIGNAL | Nothing beyond INDUSTRY FIT ONLY, or nothing found where you looked |
| CONTRADICTORY / STALE SIGNAL | The only verified signals have passed their window, or newer evidence contradicts them (cancellation, layoffs, closure) |

When a stale verified signal and a live potential one both exist, report POTENTIAL SIGNAL. A signal whose window has passed is expired, whatever its source. An undated "always hiring" page shows which crafts exist but is not a hiring signal.

**Evidence age is not signal status** (shared policy section 7). The status comes from the event's own stage and dates compared with today. "Stale" in CONTRADICTORY / STALE SIGNAL means the window has passed or newer evidence contradicts the signal, not that our check is old. If the check is older than the window for its intended use, keep the status and set `reverify`, naming what to re-confirm and before which use. Lower the confidence one step. Re-confirm only when the next use needs it: ranking needs project evidence from the last 90 days and postings from the last 30; a claim in copy needs either confirmed within 30 days.

## Outside-labor evidence

- **DOCUMENTED:** the company states or files that it uses subcontract, contract or supplemental craft labor. Record the period.
- **PLAUSIBLE:** inference from workload, with what it rests on.
- **CONTRA-INDICATED:** direct-hire plan, in-sourcing, a local-hire pledge, or a very small need.
- **UNKNOWN:** nothing found.

If contract labor is already documented, do not spend more time proving the employer might use outside labor.

## Opportunity priority (demand only)

Score only these three components. Buyer accessibility and procurement are separate dimensions owned by other skills and never enter this score.

| Component | Max | High | Middle | Low |
|---|---|---|---|---|
| Verified demand signal strength | 30 | 26-30: verified, current, tied to craft work, more than one signal | 20-25: one verified current signal with a clear craft link. 12-19: verified but small, distant or loosely linked | 1-11: potential, expired or speculative. 0: none |
| Likelihood of relevant external skilled-labor demand | 25 | 21-25: documented current use of outside labor | 15-20: documented through another channel or period, or a stated shortage under active load. 8-14: plausible from workload, undocumented | 1-7: direct-hire plan, in-sourcing or a very small need |
| Project timing and current stage | 20 | 17-20: active or within 90 days | 12-16: 90-180 days, or active with unknown dates. 7-11: no dates, or 6-18 months | 1-6: more than 18 months out, or passed |

**Demand score** = the sum, 0 to 75. **PRIORITY A** 64 to 75. **PRIORITY B** 53 to 63. **NURTURE / RESEARCH** 52 or less. (These are the v3 bands of 85 and 70 per cent, applied to 75 points.)

**These bands are provisional research-ranking bands.** They rest on 38 companies and will be recalibrated by the benchmark (`jolesbtxicpskill/BENCHMARK-700.md`). Priority orders research, free buyer work and the use of credits inside an authorized cap. It never decides ICP eligibility, dedupe or suppression, feasibility, contact acceptance, outreach readiness, or authorization to enrich, import, queue or send (shared policy section 4).

- Geography is not a scoring factor. Dollar size is not an input. Large dollar announcements must not inflate scores: read job counts and net new roles.
- Anchors bind: a POTENTIAL, expired, contradicted or absent signal scores at most 11 for signal; external labor above 20 needs DOCUMENTED current use; timing above 16 needs a window that is active or within 90 days.
- Do not score EXCLUDED or PROHIBITED companies. A low score never changes the ICP label.

## Hiring facts for copy

When you find craft postings, record each: role, site, posting date, date you last confirmed it accepts applications, URL, and source type. Also record `relevant_roles_30d` and `core_trade_roles_30d`.
- **Core trades:** welder, fitter / pipefitter / shipfitter, machinist / CNC, millwright, boilermaker, electrician, I&E / instrument tech, and similar.
- **Relevant craft roles** also include maintenance mechanic or technician, mechanical technician, fabricator, rigger, and line or plant mechanic.

**Sources:**
- LinkedIn public job search: no login, last 30 days, by craft role and state, then by company.
- The employer's own ATS or careers board (Workday, UKG, ADP, Paylocity, BambooHR, Workable, JazzHR, Oracle).

Never use Indeed, ZipRecruiter, Glassdoor or SimplyHired (shared policy section 5). An aggregator page is POTENTIAL until confirmed on the employer's own board. Whether a posting supports copy is decided by `jole-outreach-readiness`.

**Confidence:** HIGH when the status rests on a dated primary source; MEDIUM on one secondary source or an inferred window; LOW on potential evidence only.

## Escalate to the user

- Major signals contradict each other (an expansion and layoffs at the same site).
- The labor appears to be bought by an EPC, prime or owner rather than this company. Pass this to `jole-site-labor-feasibility` and `jole-buyer-identification`.
- Copy would depend on a figure taken only from a search excerpt. Re-open the source before anyone quotes it.

## Output

Envelope from `jolesbtxicpskill/CONTRACT.md`, decision = the signal status, plus:

```json
"details": {"signals": [{"type": 2, "level": "VERIFIED", "what": "...", "date": "YYYY-MM-DD", "checked": "YYYY-MM-DD", "window": "active | within_90 | later | unknown | passed", "crafts": [], "scale": "40 net new jobs", "source": "https://..."}],
  "outside_labor": "DOCUMENTED | PLAUSIBLE | CONTRA-INDICATED | UNKNOWN", "outside_labor_evidence": "...",
  "demand": {"signal": 0, "external": 0, "timing": 0, "total": 0}, "priority": "PRIORITY A | PRIORITY B | NURTURE / RESEARCH",
  "hiring_facts": [{"role": "...", "site": "...", "posted": "YYYY-MM-DD", "checked": "YYYY-MM-DD", "url": "...", "source": "LinkedIn | ATS"}],
  "relevant_roles_30d": 0, "core_trade_roles_30d": 0, "open_question": "..."}
```

## Examples

| Case | Correct | Incorrect |
|---|---|---|
| Shipyard with no recent award or posting | NO VERIFIED SIGNAL, NURTURE / RESEARCH; ICP untouched | Treated as an ICP failure |
| Verified contract starting in six months | VERIFIED FUTURE SIGNAL; timing 7-12; priority falls, eligibility does not | Failed for missing a 30-day window |
| Filings document 620 subcontract laborers and an active backlog (Conrad) | VERIFIED CURRENT SIGNAL; outside labor DOCUMENTED | Spending more time proving it buys outside labor |
| State release: 940 nested contractor jobs, first phase 2030 (Shintech) | VERIFIED FUTURE SIGNAL; timing low | Scored as current |
| Turnaround that already happened (Cenovus Lima) | CONTRADICTORY / STALE SIGNAL | Shown as a live signal |
| Build program running to 2028, last confirmed 150 days ago, nothing newer | VERIFIED CURRENT SIGNAL, confidence lowered, `reverify` before ranking it as A or using it in copy | CONTRADICTORY / STALE because the check is old |
| Priority A shipyard whose only contact is on a Proofpoint catch-all | PRIORITY A stays; the contact HOLD is decided by `jole-contact-deliverability` | Priority used to release the hold |
| Aggregator Aluminum Welder listing with conflicting dates (Metal Shark) | POTENTIAL for signal 1 until the employer's board confirms it | Recorded as verified hiring |
| 3,750 jobs with a local-hire pledge (Hyundai Translead), or $60M and 20 net new jobs (Fairbanks Morse Defense) | Score the reachable labor need | Score the headline |

## Tests

`python tests/test_signals.py` from this folder. `tests/signal_logic.py` restates the mechanical rules; this file wins any disagreement.

## Change log

**1.1.0 (2026-11-03).** The priority bands are stated as provisional research-ranking bands. Evidence age is separated from signal status: an old check sets `reverify` and lowers confidence but never makes a live signal stale. Signals record the date last checked. The description now says to load this skill directly for a demand-only question.

**1.0.0 (2026-11-03).** Split from jolesbtxicpskill 3.0.0, sections 4, 5 and part of 7. Added the five signal statuses, the outside-labor field, signal type 7 (stated shortage) and mobilizations under type 2. Priority is now demand-only: v3's buyer (15) and procurement (10) points were removed, and the bands were rescaled to 75 points.
