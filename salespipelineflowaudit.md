# SalesPipeline2 CRM decision-flow audit

**Date:** 2026-09-21
**Audited code:** production commit `442ba70` (branch `cursor/staffing-agent-shadow-production-7402`, Railway project `modest-peace`)
**Method:** read-only. No code, flags, records or queue state were changed and nothing was sent. The production commit was exported to a scratch folder for reading; Railway deployments and deploy logs were read.

> **Scope correction.** Production does **not** run the locally checked-out branch (`codex/research-icp-v1`). Railway deploys `cursor/staffing-agent-shadow-production-7402` at `442ba70` (deployed 2026-09-21), which has **53 commits the checkout lacks**, including staffing reply qualification, the shadow staffing Conversation Agent, the third Gmail sender and token-usage tracking.
>
> Production logs also contradict `OWNER_OPERATOR_GUIDE.md`. Calendar sync **is running** (a "[Calendar sync] complete" line every 5 minutes), the staffing Conversation Agent shadow is **enabled** (`[staffing-shadow] init enabled=true mode=shadow`), and a Research/ICP run happened at 21:57 UTC on 2026-09-21. The guide's flag statements are stale.

---

## A. Executive summary

**There is no single CRM brain. There are four layers, and two of them overlap.**

1. **The execution brain: `outreach-agent.js` `run()`.** It is one long procedure, started by 6 cron schedules. Each tick it observes Gmail, classifies replies, acts on them (tags, promotes, auto-replies, suppresses), runs recovery sequences, runs demo-intent triggers, then sends cold steps 1–3. Every executed decision happens here.
2. **The derivation brain: pure modules.** `canonical-reply` → `reply-operations` → `pipeline-state.deriveNextAction` → `automation-ownership`. They compute "what did they say / what should happen / who owns it". The agent uses **only `deriveAutomationOwnership`**, as a send gate. `deriveNextAction` drives the UI, Inbox, CRM Health and Resume, and never executes anything.
3. **The offline brain: batch scripts and Cowork sessions.** Apollo discovery and ICP screens, and the staffing personalization pipeline (3–5 Haiku calls per company). Their results arrive in the CRM already decided, as columns and tags.
4. **Shadow agents.**
   - Staffing Conversation Agent: live in shadow and writes `staffing_agent_shadow` events.
   - Research/ICP V1: deployed, manual only, writes to `research_icp_runs`.

**State is spread across five stores:**
- ColdEmail `stage`, `emailStatus` and `emailStep`
- Tags inside the notes field (`[REPLY: …]`, `MANUAL HOLD`, `[RESUME:]`, `[STAFFING QUALIFY ASKED]` and others)
- The Leads board stage
- The append-only activity ledger
- The suppression list

The ledger plus the pure derivations is the real state machine. The notes tags are a second, overlapping one.

**AI is a thin layer.** It is used in 4 live decisions:
- Fallback reply classification
- Answering questions
- Offline staffing research, ICP fit and opening line
- Roofing reply classification (turned off by a flag)

Everything else is deterministic, and that is mostly correct.

**Bottom line: build 3 intelligent components, not 7.** Consolidate Research/ICP, formalize a Conversation Agent (absorbing "Opportunity" and "Scheduling"), and build an Evaluator. Outreach should be formalized from existing code, not built. Campaign Manager should be deferred.

---

## B. Current end-to-end decision flow (production `442ba70`)

```text
OFFLINE (outside the app)
  Apollo search (Cowork/MCP) → website screen (screen.cjs regex scoring, Batch 2)
    → HIGH / MEDIUM / HOLD  → Apollo email reveal (verified, catch-all tiering)
  staffing-personalization.js (scripts/staffing-*-batch):
    crawl ≤6 pages → Haiku extract(+icpFit) → Haiku fact_audit(+icpFit)
    → code draft checks → Haiku opening_audit ×≤2 → HIGH/MEDIUM/RETRY/REVIEW/ICP_MISMATCH
  → CSV export → human review → POST /api/coldemail/import
─────────────────────────────────────────────────────────────────────────────
IN APP
Import  → routing check (campaign-routing: template↔niche↔family) → ColdEmail row
   ↓  human sets stage = "Queued"  (POST /api/coldemail/queue)   ← HUMAN
Cron tick (08:00–11:30 :00/:30 weekdays Vancouver)
   ↓ runHumanOutboundPass      — detect Deins' manual Gmail replies
   ↓ runReplyCheckPass         — Gmail History observer → per reply:
   │     deterministic classifyReplyText → (low conf) Haiku classifier → staffing overlay
   │     → handler switch (see G) → tags/stage/promotion/auto-reply/suppression
   │     → staffing shadow Conversation Agent (recommend only)
   ↓ runLateReplyCheckPass, runBounceCheckPass → suppression
   ↓ runStageSequencePass      — 5 recovery journeys (flag-gated)
   ↓ runIntentTriggerPass      — demo "both audios played" → booking-link email → Follow Up
   ↓ selectFollowUps (3d, then 5d) + selectQueued
   ↓ per candidate: suppression → coldSendGate(deriveAutomationOwnership) → template
   │   → sender choice/thread proof → staffing launch gate → reservation → Gmail
   ↓ Email 1 content: dental = deterministic regex personalization;
   │                   staffing = pre-approved offline opening merged into locked copy;
   │                   roofing = locked copy
Reply positive → Hot (board) → auto booking/qualify reply (if confidence ≥85)
Booking link → prospect self-books (Google Appointment Schedule)
   ↓ Calendar sync (every 5 min) → call_booked → meeting owns lead
Human → call-lifecycle (completed / no-show / cancelled) → close Won/Lost  ← HUMAN
```

---

## C. The CRM state machines (four of them overlap)

**1. ColdEmail row** (`stage` × `emailStatus` × `emailStep`):
```text
stage:  '' → Queued(human) → Contacted(send) → Replied | Review | Done | Unsub
status: '' → emailed → replied | done | bounced          step: 0→1→2→3
```
- **Automation allowed:** Queued with status `''`; or `emailed` with step 1–2 and cadence elapsed.
- **Paused:** Review; `replied`; MANUAL HOLD.
- **Terminal:** Done, Unsub, bounced.

**2. Notes-tag state machine** (it is also the staffing qualification machine):
- `[REPLY: Interested | Not Interested | Unsubscribed | Needs human | Timing — …]`, `[BOUNCED`, `MANUAL HOLD`, `[RESUME: iso]`
- `[STAFFING QUALIFY ASKED] → [STAFFING QUALIFY RECEIVED] → [STAFFING QUALIFIED]`, read by `staffingConversationState(notes)`
- `sendSuppressionReason` treats several of these tags as permanent send blocks.

**3. Pipeline board** (`Leads` sheet, `cold-call-pipeline.js`):
```text
(none) ─positive reply (AI/rule)→ Hot ─booking (Calendar, det.)→ Call Booked
(none) ─dated timing reply (det.)→ Follow Up ─timing_recontact_v1
(none) ─demo pair + link sent (det.)→ Follow Up
Hot/Call Booked ─human→ Closed Won | Closed Lost(outcome; some "recoverable")
Call Booked: scheduled → rescheduled | cancelled | outcome_pending → completed | no_show (human only)
```
Promotion never downgrades (`promotion-policy`). Entering Hot, Call Booked or Follow Up structurally blocks the cold cadence.

**4. Derived ownership** (`automation-ownership`): `human | cold_automation | recovery_sequence | meeting | waiting | none`. There is at most one executable owner. It is recomputed every pass from states 1–3 plus the ledger. It is derived, not stored.

| Transition | Driver |
|---|---|
| Queued | Human |
| Send, cadence, bounce, suppression | Deterministic |
| Reply category | Hybrid (rules first; LLM only when rules are low-confidence) |
| Auto-reply send decision | Deterministic confidence floor (85) computed from **rule** signals |
| Hot promotion | Follows the LLM/rule category |
| Booking | Deterministic (Calendar) |
| Outcomes, close, resume, overrides, contact approval | Human |

---

## D. Decision-making components

| Component | Location | Decides | Type | Mutates prod? | Trigger |
|---|---|---|---|---|---|
| Apollo discovery + screen | `Claude outputs/batch2-work/screen.cjs`, Cowork sessions | Company ICP HIGH/MED/HOLD, reveal | Rules + manual | No (CSV) | Manual |
| Staffing personalization | `integrations/staffing-personalization.js`, `staffing-research.js` | Research, ICP fit, facts, opening, send-safety grade | LLM (3–5 Haiku) + code checks | No (CSV/preview) | Scripts / preview route |
| Dental personalization | `dental-personalization.js` | Angle, facts, demo choice | Deterministic regex | Writes `siteContext` | Step-1 send |
| `generateOpener` | `outreach-agent.js:1015` | Opener for other niches | LLM | No | Step-1 send (effectively unreachable; see O) |
| Routing / campaign | `campaign-routing.js`, `campaign-versions.js`, `offer-config.js`, `staffing-launch-gate.js` | Template, family, offer, staffing send switch | Deterministic + env | Import validation | Import / send |
| Send selection | `selectQueued`, `selectFollowUps`, `scheduler-fairness`, `scheduled-slot-allocator` | Who is sent to, order, 4:1 follow-up and 3:2 staffing share | Deterministic | Yes | Cron |
| Send gate | `coldSendGate` → `deriveAutomationOwnership` / `mayColdSend` | Permission | Deterministic | No (verdict) | Every send |
| Sender / quota / reservation | `gmail-sender-routing`, `sending-window-quota`, `send-lock`, `send-reservation-*` | Inbox, caps, idempotency | Deterministic | Yes | Every send |
| Mailbox observer | `gmail-mailbox-observer`, `mailbox-observation-events` | Reply/bounce/human-outbound evidence | Deterministic | Yes (ledger, suppression) | Cron |
| Canonical classifier | `canonical-reply.classifyReplyText` | Reply state/reason/dates/contact | Deterministic (marker lists) | Via callers | Every reply |
| LLM classifier | `reply-classifier.classifyReply` | Action category when rules are low-confidence | Hybrid | Via handlers | Reply |
| Staffing overlay | `staffing-reply-policy` | Candidate-side, qualification, send-info, interest | Deterministic + notes state | Via handlers | Staffing reply |
| Reply response policy | `reply-response-policy.decideReplyResponse` | Auto-send or human | Deterministic (floor 85) | No | Positive / staffing |
| Question answerer | `answerQuestion` + `product-facts.js` | Answer text and confidence | LLM + regex vetoes | Sends or drafts | QUESTION |
| Warm-reply delivery | `deliverHardenedWarmReply` | Idempotent send, live-booking check | Deterministic | Yes | Auto-reply |
| Promotion | `handleInterested`, `promotion-policy` | Hot / Follow Up | Deterministic on category | Yes | Reply / intent / timing |
| Stage sequences | `stage-sequences.js`, `generic-reengagement.js` | 5–6 recovery journeys | Deterministic | Yes when enabled | Cron |
| Demo intent | `runIntentTriggerPass`, `demo-intent-state` | Booking-link email, Follow Up | Deterministic | Yes | Every 3 minutes plus cron |
| Next Action | `pipeline-state.deriveNextAction`, `reply-operations` | UI "what next", Hot staleness | Deterministic | **No** | UI / health |
| Calendar | `google-calendar.js`, `live-booking-gate.js`, `call-booking.js` | Booking, reschedule, cancel | Deterministic | Yes | Every 5 minutes |
| Human routes | `server.js` (~25 POST/PUT/PATCH routes) | Queue, stage, override, hold/resume, lifecycle, close, contact change | Human | Yes | UI |
| Staffing Conversation Agent | `staffing-conversation-agent.js`, `-shadow.js`, `-context.js` | Recommended action | LLM, shadow | Ledger event only | Staffing reply |
| Research/ICP V1 | `integrations/research-icp/*` | Research + campaign fit | LLM, shadow | Own table only | Manual API |
| CRM Health | `crm-health.js` | Integrity findings | Deterministic, read-only | No | UI |

---

## E. Research / ICP audit

**What exists today:**
- **Apollo (offline).** Company search. Batch 1 used a Cowork/manual fit-check before each paid reveal. Batch 2 ran 2,272 companies through `screen.cjs` rule scoring to 764 approved (356 HIGH, 408 MEDIUM). Apollo also verifies emails and gives the catch-all tiering, which feeds `emailAdmission()`.
- **Website research.** `staffing-research.js` crawls up to 6 pages with SSRF protection. `scrapeSite` in the agent reads a 1,500-character homepage for dental.
- **LLM ICP.** `staffing-personalization.js` asks Haiku for `icpFit` **twice** (extract and fact_audit) and reconciles the two answers in code.
- **Hardcoded ICP.**
  - The `POLICY` prompt string (staffing)
  - The `screen.cjs` thresholds (3 roles / majority for HIGH, 35% for MEDIUM)
  - `qualifyRoofingLead` (roofing)
  - Dental has no ICP step: any dental clinic qualifies.
- **What HIGH/MEDIUM means differs by system.** In the personalization output, HIGH/MEDIUM is a **personalization-quality** grade: concrete role plus market, `companySpecific`. It is not a pure ICP grade. In `screen.cjs`, HIGH/MEDIUM is a pure ICP grade. **Same labels, different meanings.**
- **Manual review.** Every batch goes CSV → human → import.

**Research/ICP V1:** a 4-page crawl plus 2 Haiku phases (neutral research, then campaign fit), with exact-quote citations. It persists to `research_icp_runs` and has no CRM authority. Its ICP (`research-icp/campaigns.js`) is a **fourth copy** of the staffing ICP, snapshotted from the other three. It deliberately does not read `staffing-personalization`'s stored research. It writes no opening.

**Verdict: it duplicates today, and could consolidate later.** It re-does the crawl and the ICP judgment that `staffing-personalization` already performs on the same companies, while that pipeline stays the one that actually admits leads. It becomes consolidation only if personalization is changed to **consume** a Research run: facts plus fit in, and only the opening written. Its unique value today is campaign-neutral, cited, versioned and stored research that can be reused across campaigns. No existing system provides that.

---

## F. Hyper-personalization / Outreach audit

| Question | Staffing (the real hyper-personalization) | Dental | Other |
|---|---|---|---|
| Trigger | Offline script or preview route, before import | Step-1 send | Step-1 send |
| Own research? | Yes, crawls ≤6 pages | Homepage scrape, cached in `siteContext` | Same scrape |
| LLM / key | Haiku, `ANTHROPIC_API_KEY` (shared) | None | Haiku, shared key |
| Prompt / config | `POLICY`, `STYLE`, `SYSTEM`, `FACT_AUDIT_SYSTEM`, `AUDIT_SYSTEM`; staffing-specific and hardcoded | `FACT_DEFINITIONS` regexes + `angleCopy` | Inline prompt + `niche.openerFewShot` |
| Chooses an angle? | Implicitly (roles + market) | Yes, `selectPersonalizationAngle` | No |
| Output | **One opening sentence**; the rest is locked template (`renderStaffingEmail`) | Personalization blocks inside a locked template | One opener sentence |
| Stored / reused | Yes: `hyperPersonalizedOpening` column plus facts, read later by the Conversation Agent | `siteContext` | Not cached |
| ICP reasoning | **Yes**, it is the admission gate | No | No |

**Verdict: an Outreach Agent would be formalization, not new intelligence.** The staffing pipeline already is an audited "research → fit → write → self-check" agent. What it lacks:
- a campaign-neutral shape (it is staffing-only)
- durable run storage
- reuse of a shared research record

The gap is structural, not intelligence.

---

## G. Reply / Conversation audit

**Production (executing today):**
1. The mailbox observer finds a reply.
2. `stripQuotedReply` removes quoted text.
3. `classifyReplyText` runs. If it reads "unsubscribe" or "explicit rejection", the result is set with no LLM.
4. Otherwise `classifyReply` runs: deterministic first, and **Haiku only when the rules are low-confidence** (20-token call, `NEEDS_HUMAN` fallback).
5. For staffing leads, the staffing overlay can re-label the reply (SEND_INFO, STAFFING_QUALIFICATION, INTERESTED) or block it (candidate-side, referral).
6. The handler switch acts:
   - UNSUBSCRIBE / NOT_INTERESTED → suppression, Done
   - Dated timing → Follow Up plus `timing_recontact_v1` enrolment
   - Undated timing → Review plus hold
   - OOO → wait
   - WRONG_PERSON / ALREADY_HANDLED → human review
   - QUESTION → `answerQuestion` (Haiku). Auto-sends at confidence ≥85 unless it is pricing, an objection or `needs_human`; otherwise a draft.
   - INTERESTED / MEETING_REQUEST → Hot promotion, then `decideReplyResponse` → auto booking/qualify reply if the **rule-derived** confidence is ≥85, otherwise human review.
7. A `gmail_reply_evaluated` checkpoint is written.

**Shadow (enabled in production):** the staffing Conversation Agent. Haiku returns intent, fit and one of 10 recommended actions, stored as a `staffing_agent_shadow` event with `broadlyAgree` against production. It has no authority. It reuses the stored opening and facts, so it does not re-research.

**Not active:** stage sequences (flag off per the guide; generic_follow_up_v1 is also held by three locks), Smartlead live mutations, and the roofing reply flow.

**Findings from the code:**
- **Action and analytics use different classifiers.** The action path routes on the LLM/overlay category. The stored `canonicalState` is always the deterministic classifier's result, because `canonical.state || LEGACY_TO_CANONICAL_STATE[...]` never falls through. Two consequences:
  - An LLM-only NOT_INTERESTED suppresses the lead, but analytics records Needs Human.
  - An LLM-only INTERESTED promotes the lead to Hot but never auto-replies, because the confidence score comes from rule signals (score about 40, below 85).

  This is partly intentional (the comments say so). But in effect the LLM decides promotion and suppression while the rules decide auto-send and analytics.
- **The shadow agent misrecords what production did.** `observableProductionAction` calls `decideReplyResponse` without confidence, so every auto-send path is recorded as `HUMAN_REVIEW`. Agreement is computed on the classification, so the headline agreement rate survives. But any action-level comparison drawn from this data is invalid.
- **The shadow prompt restates the rules.** The Conversation Agent's prompt re-encodes the overlay and response-policy rules in English ("interest without qualificationAsked → ASK_QUALIFICATION" and so on). It is a third copy of the same business logic.

---

## H. Opportunity / qualification audit

An "Opportunity Agent" already exists, in pieces:

| Concept | Who decides it now |
|---|---|
| Interested | Rule/LLM category → `[REPLY: Interested]` → Hot |
| Qualified (staffing) | `staffing-reply-policy` notes state machine plus `classifyStaffingQualificationAnswer` (deterministic) |
| Qualified (dental) | Nothing. Positive means Hot, and booking is the qualification. |
| Meeting requested | `MEETING_REQUEST` category |
| Human-owned | `automation-ownership` / `pipeline-state` |
| Nurture | `timing_recontact_v1`, `hot_stale_v1`, generic_follow_up_v1 (all gated) |
| Not interested / lost | Reply category, or a human close with an outcome |
| Stale | `deriveHotState` (2 business days, then 7/21-day staleness) |

There is no single source of truth: notes tags, board stage, ledger events and derived ownership all carry part of it. The shadow Conversation Agent already outputs `fit` and `intent`.

**The real gap is small and specific.** There is no qualification model for non-staffing campaigns, and no "is this still a live opportunity?" judgement for stale Hot leads (today a human does it, and nothing closes automatically). Both are conversation-context judgements. **Merge them into the Conversation Agent.** A separate Opportunity Agent would be a fourth component reading the same thread.

---

## I. Follow-up / next-action audit

This is decided by **two engines that do not share code for the reply step**:

- **Execution** (what actually happens): the fixed cadence (3d / 5d, in `FOLLOW_UP_SEQUENCE`), cron windows, `coldSendGate` ownership, the reply-handler switch, `decideReplyResponse`, stage-sequence evaluation and the demo-intent trigger. Human routes cover the rest.
- **Display** (what the operator is told): `deriveNextAction` → `deriveOperationalAction`, a precedence ladder:
  1. Won/Lost
  2. Hold
  3. Sequence
  4. Call
  5. Hot
  6. Suppression
  7. Reply operations
  8. Hold again
  9. Demo pair
  10. Follow Up
  11. Cadence
  12. Nothing

**Confirmed divergence.** The agent's own automated replies write `booking_link_sent`. But `HUMAN_TOUCH_EVENTS` / `MEANINGFUL_HUMAN_EVENTS` in `pipeline-state.js:586,663` include only `human_response_sent`, `conversation_note`, `call_booked` and `meeting_rescheduled`. The consequences, which follow from the code (not measured against production data):
- After an automated booking or qualification reply, `deriveHotState` still says "they replied and we have not answered" (waiting on us), and the lead goes overdue, then stale.
- `answeredAfter` never fires, so the Inbox still shows "Respond".
- `hot_stale_v1` can never become eligible, because it requires waiting on the prospect.

**Duplicated constants that currently agree:**
- The cadence [3, 5] is defined 3 times: `outreach-agent` `FOLLOW_UP_SEQUENCE`, `pipeline-state` `FOLLOW_UP_DELAY_DAYS`, and `staffing-campaign` `STAFFING_FOLLOW_UP_DELAY_DAYS`.
- Pricing detection is defined in 3 regexes that differ: `answerQuestion` includes "budget" and "quote"; the other two don't.

---

## J. Scheduling audit

- **Booking link:** a Google Appointment Schedule (`booking.js` `BOOKING_URL`), included by the auto-replies and the demo-intent email.
- **Detection:** incremental Calendar sync every 5 minutes (running in production), recording booked, rescheduled and cancelled.
- **Pre-send check:** `findLiveBooking` re-reads the calendar right before a warm reply.
- **Manual path:** `commitCallBooked` does a two-step write with read-back.
- **Outcomes:** no-show, completed and outcome are human only, by design.
- **Automation:** no automatic slot proposal and no availability negotiation. `cancelled_rebook_v1` and `no_show_recovery_v1` exist but require explicit enrolment.

**Verdict: a Scheduling Agent is not justified.** Self-booking plus sync is deterministic and complete. The only reasoning gap is replying to "can we do Tuesday at 3?", which is a conversation reply. The Conversation Agent can offer the link or escalate. It should never hold calendar write authority.

---

## K. Campaign management audit

**Operational control is deterministic and scattered across 6 places:**
- `offer-config` (offers, claims, FAQ, pricing — pricing is `null` for dental)
- `campaign-routing` (templates, lead types, roofing flag)
- `campaign-versions` (families, attribution)
- `staffing-campaign` (copy, model, cadence)
- `staffing-launch-gate` (the `STAFFING_LAUNCH_ACTIVATED_AT` switch)
- Sender capacity and fairness (40 per inbox per day, 5 per window, 4:1 follow-up and 3:2 staffing reservation)

Product facts live in **two** places: `product-facts.js`, used by the LLM answerer, and `offer-config` approved claims and FAQ, used by the templated replies. They also appear inside the Conversation Agent prompt.

**Strategic reasoning:** none in code. Analytics exist (funnel, reply analytics, the staffing funnel, token-usage tracking). There are no recommendations and no automatic reallocation. Optimization is human-driven, from the dashboards and batch reports.

**A Campaign Manager Agent would read analytics and suggest changes to copy, ICP or allocation.** Two things make that premature now:
- Measured cohorts are young: `dental_v1_measured`, staffing launched Sept 10–14, and much history is `legacy_unknown`.
- Any authority to change sends or allocation would bypass hard gates.

**Defer.** A weekly read-only report would capture most of the value.

---

## L. Deterministic vs AI responsibilities

**Must stay deterministic.** Each of these exists and works:
- Suppression and unsubscribe (the rule layer runs before any LLM, and suppression-list load failure aborts the cycle)
- Bounce handling
- Identity validation and contact-change approval
- MANUAL HOLD and Resume
- `deriveAutomationOwnership` (single executable owner)
- Gmail observation freshness (fail closed)
- Reservations, send-lock and deterministic ids / recovery
- Quotas, windows and fairness
- Sender and thread pinning
- The staffing launch gate and campaign routing
- Promotion never downgrading
- Calendar booking truth
- Outcome and close decisions (human)
- Pricing (configured wording only)
- Cadence timing

**Good candidates for AI judgment:**
- ICP fit from website evidence. It is currently hardcoded 4 times, including regex thresholds in `screen.cjs`.
- Reply intent when the rules are low-confidence. This already exists; formalize it with context.
- Staffing qualification answers. `classifyStaffingQualificationAnswer` is marker lists, and "unclear" goes to a human.
- Interpreting undated deferrals ("once things settle"), which are currently always human.
- Decision-maker and referral handling.
- Stale-Hot triage ("is this deal still alive?").
- The personalization angle for non-staffing campaigns.

In every case the AI proposes and the deterministic code decides.

---

## M. Agent duplication matrix

| Proposed agent | Existing equivalent(s) | Coverage | Real gap | Duplication risk | Verdict |
|---|---|---|---|---|---|
| Research/ICP | `staffing-personalization` (research + 2× fit), `screen.cjs`, Cowork fit checks, V1 | High for staffing, none for dental | One reusable, cited, campaign-neutral record; one ICP definition | **High**: V1 re-crawls and re-judges | **BUILD as consolidation.** V1 becomes the only research/fit source; personalization consumes it. |
| Conversation | Rule classifier + Haiku classifier + staffing overlay + response policy + `answerQuestion` + shadow agent | High (deterministic) | Context-aware intent/qualification for low-confidence and multi-turn replies; one place for reply reasoning | Medium: its prompt restates the overlay rules | **FORMALIZE EXISTING SYSTEM** (promote the shadow once measured) |
| Opportunity | Hot promotion, staffing qualify state, `deriveHotState`, ownership | Medium | Non-staffing qualification, stale-deal triage | High: same thread and context as Conversation | **MERGE with Conversation** |
| Outreach | `staffing-personalization` opening + audit; dental deterministic; locked templates | High | Campaign-neutral shape; consume Research output | High | **FORMALIZE EXISTING SYSTEM** (refactor, no new intelligence) |
| Evaluator | Staffing shadow `broadlyAgree`, V1 `historicalDecision` comparison, CRM Health | Low | Labelled outcomes, agreement dashboards, promotion criteria for shadow → live | Low | **BUILD** (mostly code plus human labels, not an LLM) |
| Scheduling | Appointment Schedule + Calendar sync + `findLiveBooking` + lifecycle | Complete for self-booking | Time-negotiation replies | High | **NOT NEEDED** (Conversation escalates or sends the link) |
| Campaign Manager | Config modules + analytics + usage tracking | Operational: complete. Strategic: none | Performance insight | Low now, but the risk is authority | **DEFER** (read-only report first) |

---

## N. Major architectural bottlenecks, ranked by impact

1. **Execution and display disagree after an automated reply.**
   - Evidence: `booking_link_sent` is absent from `HUMAN_TOUCH_EVENTS` / `MEANINGFUL_HUMAN_EVENTS` (`pipeline-state.js:586,663`).
   - Impact: the Inbox and Hot views tell you to respond to prospects the system already answered; staleness is false; `hot_stale_v1` can never qualify.
   - Agent helps? No. The fix is a single event taxonomy: an "our last outbound" set shared by both engines.
2. **The reply brain is split into two decision engines plus two vocabularies.**
   - Evidence: the agent switch plus `decideReplyResponse` versus `reply-operations` / `deriveNextAction`; LLM category versus canonical state (see G).
   - Impact: suppression and promotion follow one classifier while analytics and auto-send follow another.
   - Agent helps? Partly. A Conversation Agent gives one output, but first make **one** decision record per inbound message: category, state, action, confidence and source.
3. **ICP / research duplicated four times, with overloaded HIGH/MEDIUM.**
   - Evidence: `screen.cjs`, the `POLICY` prompt, the double `icpFit` in personalization, `research-icp/campaigns.js`.
   - Impact: criteria drift and repeated crawl and LLM spend.
   - Agent helps? Yes. The Research agent becomes the only source, and the other copies retire.
4. **State stored in free-text notes tags.**
   - Evidence: suppression, hold, resume, timing and staffing qualification are all regex-read from `notes`.
   - Impact: fragile parsing; the "stale Not Interested tag" bug (e9e77c2) is an example.
   - Agent helps? No. Move to structured columns or ledger events.
5. **Offline decisions made outside the app.**
   - Evidence: discovery, screening and personalization run in scripts, Cowork and CSVs; only the result is imported.
   - Impact: no audit trail in the CRM of *why* a lead was admitted.
   - Agent helps? Yes, if Research/Outreach runs persist, as V1's table already does.
6. **Shadow measurement is miscaptured.**
   - Evidence: `staffing-agent-shadow.js:40` computes the production action without confidence.
   - Impact: an Evaluator built on this data would conclude the wrong thing.
   - Agent helps? No. Pass the real `policy.action` through `productionByMessageId`.
7. **Product truth duplicated across three places:** `product-facts.js`, `offer-config`, and the prompts. Fix by making one offer registry.
8. **Divergent branches and stale docs.** Production is 53 commits ahead of the local checkout, and the guide's flag statements are wrong. That is a governance risk for any agent work: agents built on the checkout will be built against the wrong baseline.

---

## O. AI / token duplication findings

- **Company research: up to 3 crawls and 4 fit judgements per staffing company.**
  - `screen.cjs` fetch
  - `staffing-personalization`: ≤6 pages, then `icpFit` twice (extract and fact_audit)
  - Research V1: ≤4 pages, then fit again

  The Conversation Agent correctly **reuses** the stored opening and facts (`storedResearch`), which is the pattern to copy.
- **Reply classification.** For staffing leads, the same message gets a Haiku classify call (low-confidence only) plus the shadow agent's Haiku call. Both are cheap (20 and 280 max tokens). The deterministic classifier also runs 3–5 times per message (CPU only).
- **`generateOpener` is effectively unreachable.** Dental uses `buildDentalPersonalization`, staffing and roofing have their own branches, and routing only admits those three templates. Separately, its generic `buildPitch` hardcodes "for dental practices", so if it were reached with a non-dental lead the copy would be wrong. This is a retire candidate, inferred from routing and not proven with production data.
- **Prompt size is not a problem.** All prompts are bounded (1,500-character site text, compact agent payload, 3,000-character context).
- **Actual cost data exists and was not queried.** `anthropic-usage.js` records per-feature token usage (`FEATURES.*`). Use it before any cost decision.

---

## P. Recommended target architecture

**Three intelligent components, plus one deterministic spine.**

```text
            ┌────────────────── deterministic spine (unchanged) ──────────────────┐
            │ routing · launch gate · ownership · suppression · hold · quotas ·    │
            │ reservations · sender/thread · cadence · Calendar · human routes     │
            └──────────────────────────────────────────────────────────────────────┘
 1. Research/ICP agent  → one cited research record + campaign fit per company (V1, stored)
      └─ opening writer (today's staffing pipeline, refactored to consume #1; code-audited)
 2. Conversation agent  → per inbound: intent, fit/qualification, recommended action,
                          draft — proposes; decideReplyResponse + ownership dispose
 3. Evaluator (mostly code) → shadow-vs-production and agent-vs-human agreement,
                          labelled outcomes, gates for any promotion from shadow
```

The opening writer is a stage of #1's pipeline, not an autonomous agent. Opportunity and Scheduling judgements live inside #2. Campaign Manager is a later read-only analytics report.

---

## Q. Migration plan (nothing implemented)

**Stage 0: baseline.** Reconcile branches so the checkout equals production, and correct the operator guide's flags. Do this before any agent work.

**Keep as-is:**
- The send spine: reservations, locks, quotas, sender/thread, suppression, hold/resume
- `deriveAutomationOwnership`
- The mailbox observer
- Calendar sync and booking
- Human outcome and close
- Dental deterministic personalization
- Locked templates
- CRM Health

**Consolidate** (deterministic fixes that come before any agent):
1. One outbound-touch event set shared by `pipeline-state` and the agent (fixes N1).
2. One per-message reply decision record storing both the category and the canonical state, plus the executed action (N2).
3. Pass the real production action to the shadow agent (N6).
4. One cadence constant, one pricing detector, one offer/product-facts registry.
5. Move the notes-tag states (hold, resume, qualification, timing) toward structured fields. This is incremental, and the tags stay readable.

**Agentize:**
1. Research/ICP V1 becomes the only research and fit source. Refactor `staffing-personalization` to take a `researchRunId` and write only the opening.
2. Conversation Agent: extend from staffing to all campaigns, still in shadow. Stop restating rules in its prompt: pass the deterministic verdicts in as inputs and ask only for the judgement.
3. Evaluator: agreement metrics by category, and a human-labelled set drawn from the Inbox. Promote a Conversation recommendation to live only for low-confidence cases, and only behind `decideReplyResponse` and ownership.

**Retire:**
- `screen.cjs`-style ICP rules and the personalization's internal `icpFit` (once Research is authoritative)
- `generateOpener` / generic `buildPitch` (if confirmed unreachable)
- The shadow prompt's embedded rule text
- The duplicated ICP registry copies

**Defer:** Campaign Manager (read-only weekly report first), Scheduling Agent (not needed), and any autonomous send authority for an agent.

---

## R. Files and modules inspected

**Docs:** `OWNER_OPERATOR_GUIDE.md`, `PRODUCTION_AUDIT.md`, `RESEARCH_ICP_V1.md`, `CONSOLIDATION_SPEC.md`, `Claude outputs/scalelab_staffing_apollo_batch1_completion_report.md`, `…batch2_discovery_report.md`.

**Code, at production `442ba70`:**
- `outreach-agent.js`: `run`, `runReplyCheckPass`, handlers, `answerQuestion`, `generateOpener`, `buildEmail`, `buildPitch`, `coldSendGate`, selectors
- `integrations/`: `reply-classifier.js`, `canonical-reply.js`, `reply-operations.js`, `reply-response-policy.js`, `staffing-reply-policy.js`, `staffing-conversation-agent.js`, `staffing-agent-shadow.js`, `staffing-agent-context.js`, `staffing-agent-schema.js`, `staffing-personalization.js`, `staffing-research.js`, `dental-personalization.js`, `pipeline-state.js`, `automation-ownership.js`, `offer-config.js`, `campaign-routing.js`, `staffing-launch-gate.js`, `live-booking-gate.js`, `call-booking.js`, `google-calendar.js`, `research-icp/campaigns.js`
- `product-facts.js`; `server.js` (routes and cron list)

**Runtime:** Railway deployment list and deploy logs (read-only).
