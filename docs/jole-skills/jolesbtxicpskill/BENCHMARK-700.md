# Benchmark plan: scaling toward 700 sendable Jole prospects

Part of shared policy 4.1.0 (2026-11-03). **A plan only.** Running any part of it needs the user's authorization: sourcing, an Apollo credit cap for Stage 3, reviewer time, and later any import, classification entry or sending.

## What "sendable" means

A contact is sendable when it reaches READY FOR APPROVED SEQUENCE and a person has reviewed it. That needs ICP QUALIFIED, NET NEW at account and contact level, no feasibility block or open condition, BUYER VERIFIED, CONTACT ACCEPTED FOR REVIEW, and an approved copy path.

Today the copy paths are:
- V5 `exact` or `role_only`, which need a verified craft posting confirmed within 30 days when Touch 1 renders;
- V5 `general_craft` for lists not sourced from signals.

Signal-sourced leads cannot become sendable until a signal-aware variant, or `general_craft` for signal lists, is approved. Every new lead also needs a reviewed V5 classification entry, which is a production data change.

## Baselines already measured

| Source | Figure |
|---|---|
| Phases 3 to 5 (Oct 2026, hiring-based ICP) | About 1,765 companies classified; 616 strict ICP; 476 with a usable buyer contact; 422 companies with an approved contact. |
| Phase 5 QC | 726 contacts audited, 689 approved (95%); 1.63 approved contacts per company; about 1.0 credit per approved contact, 1.1 per usable contact including holds |
| Deliverability, sends to 2026-11-01 | Proofpoint catch-all 93 of 510 sent (18%), with 16.1% true failures; other catch-all 6.4%; non-catch-all 0.7%; Proofpoint non-catch-all 0 of 41. Proofpoint catch-all contacts are now HOLD. |
| The 38 strong-signal companies (v4) | ICP 21 QUALIFIED, 16 CONDITIONAL, 1 EXCLUDED. Buyers 16 verified, 12 partial, 4 not site-connected, 6 not identified. |
| Buying-signal test (145 companies) | 63 with a verified signal (43%) |
| Fresh single-question sessions | $0.31 to $0.39 each, mostly the cost of loading skills; batch subjects to spread it |

None of these is a human-audited precision figure. The benchmark adds that.

## Two-stage qualification (plus a paid third stage)

Deep research is never done on every company. Each stage runs only on what the previous stage passed, in rank order, and stops when the projected yield meets the target.

| Stage | Runs on | Skills | Depth | Output |
|---|---|---|---|---|
| 1. Screen | Every sourced company | dedupe (account), ICP | Level 1, at most 3 lookups; batches of 20 to 25 companies per session | QUALIFIED, CONDITIONAL with its gap, EXCLUDED; the sourcing signal recorded as found |
| 2. Target | QUALIFIED, plus CONDITIONAL whose single gap takes one lookup | signals (when the list is signal-based or ranking needs it), feasibility (triggers only), buyer, dedupe (contact) | Level 2, at most 8 lookups; free Apollo people search only | Buyer status, the people to reveal, a credit estimate |
| 3. Contact (needs a cap) | BUYER VERIFIED people | contact deliverability, same-day live dedupe, readiness | Free MX lookup of the company domain before any reveal; reveal only with phone, waterfall and personal email off | Accepted contacts for human review; nothing imported |

**Stop rules:**
- Stage 1 never goes past Level 1. A CONDITIONAL that needs more than one lookup waits, and is researched only if the pool runs short.
- Stage 2 stops when projected accepted contacts reach the target plus 15%.
- Level 3 is only for PRIORITY A subjects with an open question that would change a decision.
- **Before any reveal, check the company domain's MX.** If it is Proofpoint (`*.pphosted.com`, `*.ppe-hosted.com`), expect a catch-all HOLD and do not spend the credit until the hold policy changes. On the 2026-11-01 sends, this would have saved about 18% of reveals.

## Pilot before scaling

- **Sample:** 200 companies, stratified across the seven sectors (about 28 each). Half come from a general industrial list, half from signal sources, and 30 are from "Where the next wave should look first" in `reference.md`.
- **Stage 1** on all 200; Stage 2 on those it passes.
- **Stage 3** on up to 60 people, which needs a cap of about 70 credits. Without a cap, Stage 3 rates come from the baselines above.
- **Human audit.** The user or Jorge reviews, without seeing the labels:
  - 40 QUALIFIED;
  - 20 CONDITIONAL;
  - every EXCLUDED, up to 20.
- **Consistency:** 25 companies re-screened in a fresh session on another day.

## Metrics

| Metric | Definition | Baseline | Target before scaling |
|---|---|---|---|
| ICP precision | QUALIFIED the reviewer confirms as a fit, as a share of QUALIFIED reviewed | Not yet measured | 90% or more |
| False exclusions | EXCLUDED the reviewer would qualify, as a share of EXCLUDED reviewed. This is the failure that v4 was built to prevent. | Not yet measured | 5% or less |
| Conditional rate | CONDITIONAL as a share of Stage 1; share resolved within one lookup; mix of gaps | 16 of 38 (42%) on a deep-researched set | 30% or less at Stage 1; half resolved within one lookup |
| Label consistency | Same label on the fresh re-run | Not yet measured | 90% or more |
| Buyer identification | BUYER VERIFIED as a share of Stage 2 companies, and the PARTIAL, NOT SITE-CONNECTED and NOT IDENTIFIED shares | 16 of 38 verified (42%), 12 partial (32%); 77% of Phase 3 companies had an Apollo contact | 55% or more verified with free tools |
| Research time | Lookups and minutes per company, per stage, from each record's `assessed` field and start and end times | Not yet measured | Stage 1: 3 lookups, 3 minutes. Stage 2: 8 lookups, 10 minutes |
| Model and tool cost | Model dollars per company per stage (each session's `total_cost_usd`); Apollo credits per accepted contact; total cost per sendable contact | $0.31 to $0.39 per single-question session; about 1.0 to 1.1 credits per contact | Set by the user before scaling |
| Duplicate rate | Account-level EXISTING ACCOUNT, FAMILY MATCH, SUPPRESSED and PROHIBITED as a share of Stage 1; EXISTING CONTACT as a share of planned reveals; duplicates within the wave | Not yet measured for new sources | Over 20% means the source overlaps earlier waves: change sources |
| Email-quality acceptance | CONTACT ACCEPTED as a share of revealed contacts; HOLD and REJECT shares; then true-failure rate by MX class on the first 100 sends | 95% QC approval; 0.7% true failures for non-catch-all | 80% or more accepted; 2% or less true failures outside Proofpoint |
| End-to-end yield | Sendable contacts per company screened, and per Stage 2 company | Planning value below | Replaced by the pilot |

**Priority calibration.** The 64 and 53 bands stay provisional. After the pilot, report the demand-score distribution. Later, check whether priority predicted buyer success or replies, and propose new cut-offs to the user. Priority is never used as a gate in the benchmark.

## Sizing (planning values, replaced by the pilot)

Sendable contacts = companies screened × q × u × b × k × a × r, where:
- q: share QUALIFIED after Stage 1;
- u: share net-new;
- b: share of Stage 2 companies with BUYER VERIFIED;
- k: accepted contacts per verified company;
- a: share of reveals accepted;
- r: share with an approved copy path.

With q = 0.55, u = 0.85, b = 0.60, k = 1.4, a = 0.78 (Phase 5 QC less the Proofpoint hold) and r = 1.0 (general lists only), each screened company yields about 0.31 sendable contacts. 700 then needs about:
- 2,300 companies at Stage 1;
- 1,070 at Stage 2;
- 900 reveals, or about 990 credits.

With the MX check before reveal, a rises to about 0.93, and the credits fall to about 830. Phases 3 to 5 needed about 1,765 classified companies for 689 contacts under a stricter ICP, which is the same order of magnitude.

**Timing.** Hiring-lane leads need their posting confirmed within 30 days when Touch 1 renders. Buyer employment must be confirmed within 30 days, and dedupe on the same day, before import. Source in batches of no more than about four weeks of authorized Touch 1 capacity, or plan to re-verify.

## Logging

Add these columns to the batch CSV in CONTRACT.md for benchmark runs: `Stage reached, Stage 1 lookups, Stage 1 minutes, Stage 2 lookups, Stage 2 minutes, Model cost USD, Apollo credits, Reviewer label, Reviewer note`.

Report each pilot with:
- the metrics table filled in;
- counts per label;
- the credits used, checked against the Apollo balance;
- a confirmation that nothing was imported, queued or sent.

## Go or no-go

Scale only if:
- precision, false exclusions and consistency meet their targets;
- acceptance is 80% or more;
- cost per sendable contact fits the user's budget.

If a target fails, fix the owning skill, not the threshold, and re-run the affected part of the pilot.

**Blockers to 700 sendable today:**
- No approved signal-aware copy.
- No V5 classification entries for new leads.
- No Apollo cap.
- No sending authorization for a new wave.
