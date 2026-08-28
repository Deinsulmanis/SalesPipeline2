# SalesPipeline2 Owner & Operator Guide

**For:** ScaleLab owner/operator  
**Production CRM:** <https://receptionist.scalelabai.ca>  
**Guide version:** Final production behavior at commit `38a759626628a2e5e30ec249df5a397fb05e5e09`

This is the practical operating manual for SalesPipeline2. Keep it open while working replies, opportunities, meetings, and campaign reporting.

> **Current production status**
>
> - Regular cold outreach sending is enabled.
> - Stage/recovery sequences are disabled.
> - Google Calendar booking sync is disabled but configured.
> - Do not enable a disabled automation merely because it appears available.

## Table of contents

1. [What the CRM does](#1-what-the-crm-does)
2. [Daily operating workflow](#2-daily-operating-workflow)
3. [The nine workspaces](#3-the-nine-workspaces)
4. [Replies and Next Actions](#4-replies-and-next-actions)
5. [Automation ownership](#5-automation-ownership)
6. [Manual Gmail responses](#6-manual-gmail-responses)
7. [MANUAL HOLD](#7-manual-hold)
8. [Pipeline, promotion, and Hot leads](#8-pipeline-promotion-and-hot-leads)
9. [Contact changes and automated replies](#9-contact-changes-and-automated-replies)
10. [Sequences](#10-sequences)
11. [Bookings and call lifecycle](#11-bookings-and-call-lifecycle)
12. [Campaigns and attribution](#12-campaigns-and-attribution)
13. [Analytics, funnel, and Daily Sends](#13-analytics-funnel-and-daily-sends)
14. [CRM Health](#14-crm-health)
15. [Settings](#15-settings)
16. [How the CRM prevents bad sends](#16-how-the-crm-prevents-bad-sends)
17. [Troubleshooting](#17-troubleshooting)
18. [What not to do](#18-what-not-to-do)
19. [Quick reference](#19-quick-reference)
20. [Glossary](#20-glossary)
21. [Technical appendix](#21-technical-appendix)

## 1. What the CRM does

SalesPipeline2 manages the journey from a cold prospect to a sales outcome. It keeps outreach history, replies, current work, meetings, and analytics connected without treating them as the same thing.

```text
Prospect
   ↓
Cold outreach
   ↓
Inbound message → Reply classification: “What did they say?”
   ↓
Next Action: “What should happen now?”
   ↓
Ownership: “Who controls the next move?”
   ↓
Opportunity → Booking → Call → Outcome
   ↓
Historical analytics and CRM Health
```

These layers are intentionally separate:

- A reply classification records what the prospect communicated.
- A Next Action says what should happen now.
- Ownership says whether the next move belongs to you, cold automation, a recovery sequence, a meeting, a waiting state, or nobody.
- The send gate makes the final safety decision before an automated message can leave.
- Analytics preserves what historically happened even after the current work changes.

This separation is why an answered positive reply stays historically Positive but may disappear from the Inbox's “Needs response” view.

## 2. Daily operating workflow

### Morning — about 10 minutes

1. Open **CRM Health**. Investigate any Critical finding first. Warnings are review items, not automatic emergencies.
2. Open **Inbox → Needs response**. Work human-owned replies from oldest/most overdue to newest, with urgent positive or meeting requests first.
3. Open **Pipeline**. Review overdue actions and Hot leads marked overdue, stale, or severely stale.
4. Open **Bookings**. Confirm today's calls and any past calls showing Outcome Pending.
5. Respond from Gmail when appropriate. The CRM is designed to observe those manual responses.

### During the day

- Read the prospect's message and the lead timeline before responding.
- Follow the displayed Next Action and owner; do not send just because a cadence date is due.
- Use Gmail normally for personal replies. Avoid sending a second follow-up while the CRM already shows Waiting on prospect.
- When a call is booked, rescheduled, cancelled, completed, or missed, record the lifecycle change in the supported CRM controls while Calendar sync is off.
- Record the sales outcome after a completed call.

### End of day — about 5 minutes

1. Recheck **Inbox → Needs response**.
2. Review overdue Hot and Pipeline actions.
3. Confirm completed calls have outcomes and cancelled/no-show calls have the correct lifecycle state.
4. Glance at **Analytics** and **Campaigns** for trends; do not rewrite attribution to improve a report.
5. Check **CRM Health** again if you changed identities, contact decisions, meetings, or automation state.

## 3. The nine workspaces

### Pipeline

**Use it for:** active sales opportunities and their current stage, urgency, waiting state, and Next Action.

**Pay attention to:** human-owned actions, due/overdue badges, Hot staleness, meeting state, MANUAL HOLD, and terminal outcomes.

**Common actions:** open a lead, inspect its timeline, update supported stages, set follow-up timing, record call lifecycle or outcome, and apply supported reply/contact decisions.

**Do not:** treat moving a card as permission to send, downgrade a later-stage opportunity casually, or remove a hold merely to clear a warning.

**Use it when:** working an active opportunity or deciding what happens next.

### Outreach

**Use it for:** searching and filtering the complete cold-prospect dataset and opening a lead's outreach drawer/timeline.

**What appears:** cold-email state, campaign/version information, delivery/reply signals, filters, and a bounded first page. The CRM loads more or retrieves an exact lead when needed rather than rendering the entire dataset at once.

**Pay attention to:** identity, stage, send history, reply evidence, suppression/hold state, and campaign version.

**Common actions:** search, filter, open the drawer, inspect the canonical timeline, and use supported queue controls.

**Do not:** infer that an old `emailed` state means the lead is currently safe to contact. Pipeline ownership can still block it.

### Inbox

**Use it for:** current reply work.

**What appears:** the prospect's message, reply category, Next Action, owner, waiting state, and due date. Filters include Needs response, Positive/evaluation, Needs Human, Revisit later, Decision maker, Contact review, Automated/OOO, Unknown/investigate, and All replies.

**Pay attention to:** **Needs response** first. A filter can overlap another; for example, a reply may be Positive and also need a response.

**Common actions:** open the existing lead drawer, read the timeline, respond in Gmail, set a supported follow-up decision, or review a proposed contact change.

**Do not:** expect Inbox counts to equal analytics counts. Inbox is operational; Analytics is historical.

### Campaigns

**Use it for:** understanding campaign-level performance and provider-reported campaign information.

**What appears:** measured campaigns, campaign versions, and legacy/unknown attribution kept separate.

**Pay attention to:** whether a row is a canonical CRM count or explicitly described as provider-reported.

**Common actions:** compare campaign cohorts and inspect the source campaign/version.

**Do not:** assign old leads to a measured campaign without evidence or overwrite the campaign that originally acquired a lead.

### Analytics

**Use it for:** historical performance—reply outcomes, conversion funnel, engagement signals, and daily send activity.

**What appears:** reply cards and drilldowns, campaign/version filters, funnel stages and rates, demos/opens, and All Outbound Sends.

**Pay attention to:** the selected cohort, the denominator named by each rate, and whether a value is `—` because no valid denominator exists.

**Common actions:** switch between Lifetime, measured campaign versions, and Legacy/Unknown; open bounded drilldowns; compare rates over time.

**Do not:** read an empty newly measured cohort as broken analytics or treat `—` as 0%.

### Sequences

**Use it for:** viewing stage-sequence status, current step, and next scheduled action.

**Current state:** **disabled**. No stage-specific recovery sequence can send. Regular cold outreach is controlled separately.

**Common actions:** review visible sequence state. Enrollment/pause/resume/cancel controls appear in the lead drawer only where supported and require confirmation.

**Do not:** enable sequences casually or assume an enrolled sequence is currently executing while the production flag is off.

### Bookings

**Use it for:** upcoming calls and unresolved meeting outcomes.

**What appears:** Call Booked opportunities, scheduled times, cancellations, no-shows, and Outcome Pending work.

**Common actions:** open the opportunity and record the supported lifecycle transition or outcome.

**Current empty state:** “No current calls” means no Call Booked opportunity or unresolved meeting outcome is currently visible.

**Do not:** mark a cancellation as Closed Lost automatically. Cancellation and sales outcome are separate decisions.

### CRM Health

**Use it for:** read-only safety and data-integrity checks.

**What appears:** Healthy, Info, Warning, and Critical findings grouped by identity, replies, outreach, holds, pipeline, calls, Hot state, sequences, Calendar, attribution, funnel, activities, and ownership.

**Common actions:** expand a finding, inspect affected leads, and correct the underlying issue through supported workflows.

**Do not:** treat every Warning as a reason to disable all sending. Read the finding's explanation and whether current send eligibility is implicated.

### Settings

**Use it for:** read-only operational status.

**What appears:** cold outreach sending and daily cap, stage-sequence state, Calendar sync state, Smartlead integration mode, roofing reply-flow state, and the agent status/log panel.

**Do not:** expect credentials or secrets here; they are intentionally not displayed. Settings status is not an invitation to change production flags casually.

## 4. Replies and Next Actions

### Reply categories

| Category | Genuine human engagement? | Meaning | Normal owner action | Automatic behavior |
|---|---:|---|---|---|
| Positive | Yes | Clear interest, evaluation intent, or meeting intent | Continue the conversation or book the call | May promote safely to Hot; does not replace the need for human follow-up |
| Negative | Yes | Decline or unsubscribe | Usually no sales follow-up; confirm suppression where applicable | Stops inappropriate automation |
| Needs Human | Yes | A question, objection, administrative response, deferral, decision-maker situation, or unclear human intent | Read the message and follow the specific Next Action | Human ownership blocks conflicting cold automation |
| Automated Reply | No | Autoresponder, out-of-office, or temporary closure | Usually wait; inspect exact return timing if present | Excluded from genuine-reply rates; may create a waiting state |
| Contact Change Review | No—not yet a sales sentiment | A mailbox migration or proposed replacement contact | Review identity evidence; approve/reject only through supported controls | Blocks automation while unresolved |
| Unknown | Unknown | Evidence is missing, malformed, or insufficient | Investigate the lead and provider evidence | Fails closed rather than guessing |

### Inbound Messages versus Genuine Replies

**Inbound Messages** counts every inbound message category, including automated replies, contact-change messages, and unknown evidence.

**Genuine Replies** counts only Positive, Negative, and Needs Human replies.

Example: an out-of-office message increases Inbound Messages but does not increase Genuine Replies. This is intentional and keeps reply rates honest.

### Next Action

Reply classification answers **“What did they say?”** Next Action answers **“What should happen now?”**

Major operator-facing actions include:

| Next Action | What it means |
|---|---|
| Continue evaluation | The prospect shows real evaluation intent; continue the sales conversation |
| Respond to reply | A person asked something or is waiting for an answer |
| Book call | They want to meet and no valid future booking exists |
| Revisit later | They deferred; use their stated date or set a manual date if wording was vague |
| Decision-maker follow-up | The message was forwarded; follow up on the outcome |
| Review supplied contact | Another address/person was supplied but cannot be mailed automatically |
| Review contact change | A proposed mailbox requires an identity decision |
| Wait until return | A trustworthy exact return date was found in an automated message |
| Investigate reply | Evidence or identity is insufficient to act safely |
| Sales call / confirm meeting | A meeting owns the next move |
| Record call outcome | A past meeting needs an explicit outcome |
| Hot follow-up / Hot review | A live opportunity is due, overdue, stale, or unclear |
| Sequence step / sequence review | A stage journey is scheduled or needs review; production sequences are currently disabled |
| Automated first send / follow-up | Ordinary cold automation owns a valid due action |
| No next action / Won / Lost | Nothing executable is currently appropriate |

Due status uses Vancouver business dates: Upcoming, Due today, Overdue, Waiting, Blocked, or None.

> **No invented dates**
>
> If a prospect says “maybe later” without a trustworthy date, the CRM does not manufacture one. The action remains human review until you deliberately set a supported follow-up date.

## 5. Automation ownership

Only one executable owner should control the next move.

| Owner | Meaning | What you should do | Can automation send? |
|---|---|---|---:|
| Human | You own a reply, identity decision, overdue sales action, or unresolved outcome | Read the timeline and complete the displayed action | No conflicting cold/recovery send |
| Cold Automation | A valid cold lead is due and all safety checks pass | Usually leave it alone; investigate only if it remains blocked unexpectedly | Yes, subject to every send gate and flag |
| Recovery Sequence | An active eligible stage journey owns the next automated step | Review sequence state; do not duplicate its planned follow-up | Only when sequences are enabled and every stop/gate passes |
| Meeting | A scheduled or unresolved call controls the workflow | Prepare for the call or record its outcome | No inappropriate cold follow-up |
| Waiting | The prospect or a known date is the legitimate next event | Wait until the displayed condition/date; avoid duplicate nudges | No while the waiting condition applies |
| None | Terminal, suppressed, invalid, or no safe action | No outreach unless the underlying state is deliberately and safely changed | No |

Ownership prevents two systems—or you and a system—from independently sending conflicting messages.

## 6. Manual Gmail responses

You can reply directly from Gmail. The CRM observes provider-backed sent messages and records that you responded, then updates conversation ownership so inappropriate automation stays out of the way.

- The activity is internally called `human_response_sent`.
- The CRM records provider identity and timing; it does not need to copy the message body.
- The same Gmail message is replay-safe and does not create duplicate activities.
- A cold outbound opener is not mistaken for a personal response. Gmail must show that the prospect previously wrote into that thread.
- A response to a supplied decision-maker in the same verified Gmail thread remains conversation evidence; it does not silently change the lead's canonical email.
- Observation occurs before reply auto-response, recovery-sequence evaluation, demo-intent follow-up, and ordinary cold execution.
- If observation fails, automated execution that could conflict with a human answer fails closed or degrades to a draft.

> **Core promise:** If you manually answer a prospect, the CRM should not immediately send that prospect another automated follow-up.

If the CRM still says “Respond” after you replied:

1. Refresh the lead and inspect its timeline for your manual response.
2. Confirm you replied from the connected ScaleLab Gmail account and in the prospect's real thread.
3. Check **Settings → agent status** and **CRM Health → ownership/Gmail human outbound**.
4. Do not send another automated follow-up while evidence is uncertain.

## 7. MANUAL HOLD

MANUAL HOLD is an independent safety tag that stops ordinary cold cadence. It is useful when a human has taken over, a lead has been promoted, or cold follow-up must remain paused regardless of timing.

It blocks:

- ordinary cold initial/follow-up cadence where the hold applies;
- accidental re-entry caused by an old cold-email state;
- automatic reactivation before an explicitly supported resume condition.

It does not automatically mean:

- the lead is suppressed forever;
- the lead is Closed Lost;
- every explicitly enrolled recovery journey is forbidden.

An explicitly enrolled stage sequence may historically run despite MANUAL HOLD because enrollment is a separate deliberate authorization. Permanent suppression, human takeover, replies, meetings, terminal stages, identity conflicts, and sequence stop conditions still outrank it. Sequences are currently disabled.

> **Warning — removing MANUAL HOLD should be deliberate.**
>
> Understand why it exists and inspect ownership, suppression, stage, identity, replies, and meetings first. Removing the tag does not by itself make a send safe; all other gates still apply.

Use MANUAL HOLD when you need cold cadence kept off while you manage the relationship manually. Do not remove it merely to tidy a record or silence a non-critical warning.

## 8. Pipeline, promotion, and Hot leads

### Current Pipeline stages

| Stage | Operational meaning |
|---|---|
| Follow Up | Early active opportunity, including verified demo engagement |
| Hot | Canonical positive reply requiring human sales follow-up |
| Call Booked | A valid meeting time exists |
| Closed / Won | Explicit successful sales outcome |
| Closed / Lost | Explicit unsuccessful sales outcome; may still be recoverable in limited cases |

Legacy values remain visible through safe display mappings; the CRM does not silently migrate historical rows.

### Automatic promotion rules

- Canonical Positive or late-positive reply → **Hot**.
- Verified demo pair **and** booking link sent → **Follow Up**.
- Valid meeting booked with a meeting time → **Call Booked**.
- Other signals—including opens, warm activity, Needs Human, and sequence completion—do not meet automatic promotion thresholds by themselves.
- Automatic promotion does not downgrade an opportunity already at an equal or later stage.
- Ambiguous identity, invalid stage, missing required meeting time, or suppression fails closed.

Once a lead is promoted into the Pipeline, ordinary cold follow-up is structurally blocked even if the old outreach row still says `emailed` or a cadence appears due.

### Hot lead timing

Hot leads distinguish:

- **Waiting on us:** you owe the prospect an action.
- **Waiting on prospect:** they owe the next response.
- **Meeting scheduled:** the meeting owns the next event.
- **Waiting until date:** a trustworthy date controls follow-up.
- **Human review required / Unknown:** evidence is insufficient for an automatic conclusion.

When waiting on a prospect, the CRM derives a human follow-up deadline two business days after the last meaningful interaction. It then marks the lead:

- Active: not due yet
- Follow-up due: due today
- Overdue: past due
- Stale: at least 7 days past due
- Severely stale: at least 21 days past due

Owner-specified follow-up timing outranks a derived timing rule where supported and remains visibly sourced as manual. Prospect-stated dates remain visibly sourced to the prospect.

For overdue or stale Hot leads, read the last meaningful interaction, decide whether the opportunity is still live, follow up personally if appropriate, and record the outcome. Nothing is closed automatically merely because it became stale.

## 9. Contact changes and automated replies

### Supplied or changed contacts

If someone says “Email my manager instead” or supplies another address:

1. The address becomes evidence attached to the conversation.
2. It is not automatically adopted as the lead's canonical identity.
3. The CRM routes it to human review where applicable.
4. Approval is a separate decision and does not itself send an email.
5. Approval does not automatically resume cold outreach.
6. Suppression, ownership, meeting, hold, and identity gates still apply.

Never copy a supplied address into the canonical identity merely because it appeared inside a message. Confirm that the supported review/approval workflow has trustworthy evidence and no duplicate or suppressed identity conflict.

### Autoresponders, out-of-office, temporary closure, and migration

- Autoresponders and out-of-office messages are Inbound Messages but not Genuine Replies.
- A temporary closure is not automatically Negative.
- A trustworthy exact return date can create **Wait until return**.
- Vague wording such as “back sometime next month” does not create a fabricated date.
- A mailbox migration is normally Contact Change Review, not Positive or Negative.
- Automated replies do not inflate Genuine Reply Rate or Positive Reply Rate.

## 10. Sequences

> **Production stage sequences are currently disabled.** Existing state may be visible, but no stage/recovery sequence can send while the flag is off. Regular cold outreach has a separate control and may continue.

The system contains five bounded recovery journeys:

| Sequence | Purpose | Enrollment | Maximum steps | Timing |
|---|---|---|---:|---|
| `demo_follow_up_v1` | Continue after verified demo engagement and a booking-link message | Automatic continuation when its qualifying evidence exists | 2 | Business-day delays from the booking-link event and prior step |
| `hot_stale_v1` | Follow up a Hot lead waiting on the prospect after it becomes due/stale | Explicit enrollment required | 2 | Business-day delays from enrollment/prior step |
| `no_show_recovery_v1` | Recover an explicitly recorded no-show | Explicit enrollment required | 2 | Business-day delays from no-show/enrollment and prior step |
| `cancelled_rebook_v1` | Invite rebooking after a recorded cancellation | Explicit enrollment required | 2 | Business-day delays from cancellation/enrollment and prior step |
| `timing_recontact_v1` | Recontact on a human-chosen future date | Explicit enrollment and date required | 1 | The chosen date |

Sequences stop or refuse execution for replies, human intervention, a new booking, incompatible call/stage state, terminal state, opt-out/bounce/durable suppression, identity conflict, completion, pause/cancel state, disabled feature flag, failed Gmail observation, daily cap, or sender kill switch.

No sequence removes MANUAL HOLD or rewrites ordinary cold cadence history.

### Before enabling sequences

- [ ] CRM Health has no Critical finding.
- [ ] Gmail manual-response observation is working.
- [ ] Ownership reports zero executable conflicts.
- [ ] Suppression and bounce handling are functioning.
- [ ] Sending configuration, inbox, and daily limit are understood.
- [ ] Every sequence's audience, copy, enrollment, timing, and stop behavior has been intentionally reviewed.
- [ ] Existing enrolled/paused sequence state has been reviewed lead by lead.
- [ ] Calendar/meeting state is accurate enough for no-show and cancellation journeys.
- [ ] The owner deliberately accepts the MANUAL HOLD versus explicit-enrollment distinction.

## 11. Bookings and call lifecycle

### Current Calendar status

Google Calendar sync is **disabled but configured**. The CRM does not currently read/write booking events automatically through the sync.

While it remains disabled, use the supported lead/call controls to keep meeting state current. Do not create fake bookings for testing.

### Meeting ownership

A valid future meeting owns the next move and blocks inappropriate cold automation. A past unresolved meeting becomes human-owned Outcome Pending until you record what happened.

### Lifecycle

| State | What it means | Owner action |
|---|---|---|
| Scheduled | A valid future meeting exists | Prepare; avoid duplicate cold follow-up |
| Rescheduled | A newer valid time supersedes the old occurrence | Confirm the new time |
| Cancelled | The meeting was cancelled | Decide whether to rebook; do not assume the sale is lost |
| Completed | The call was held | Record the sales outcome |
| No Show | A human explicitly recorded that the prospect missed a past call | Decide whether to recover; no automatic close |
| Outcome Pending | The meeting time passed without a recorded result | Record Completed, No Show, Cancelled, or the appropriate supported outcome |
| Closed / Won | Explicit sale won | Ensure final outcome is recorded for analytics |
| Closed / Lost | Explicit sale lost | Record the real loss; do not use it merely to clear a task |

A later valid booking supersedes an older cancellation or no-show. Meeting outcome and sales outcome remain separate: “call completed” does not mean “deal won.”

## 12. Campaigns and attribution

**Acquisition attribution** records which campaign originally acquired the lead. A later stage/recovery message records its own sequence identity without replacing that acquisition history.

Current measured campaign versions include:

- `dental_v1_measured`
- `roofing_survey_v1_measured`

`legacy_unknown` means historical activity lacks trustworthy evidence tying it to a measured campaign version. This is honest reporting, not a defect. The CRM does not guess historical leads into a campaign merely to fill a chart.

Use Campaigns to compare known cohorts. Use Lifetime when you want the complete eligible history. Remember that a provider-reported count is labelled as such and may not use the same canonical CRM definition as a funnel metric.

## 13. Analytics, funnel, and Daily Sends

### Metric definitions

| Metric | Definition |
|---|---|
| Inbound Messages | Unique leads/messages represented in the complete canonical reply partition, including automated/contact-change/unknown |
| Genuine Replies | Positive + Negative + Needs Human |
| Positive Replies | Canonically Positive genuine replies |
| Negative Replies | Canonically Negative genuine replies, including opt-outs where classified negative |
| Needs Human | Genuine human replies requiring interpretation or action |
| Automated Replies | Autoresponders, OOO, and temporary closures |
| Contact Change Review | Proposed mailbox/contact changes needing review |
| Unknown | Reply-like evidence that cannot be safely classified |
| Unique Contacted | Unique leads with qualifying outbound-contact evidence |
| Delivered | Unique Contacted minus bounced/undelivered leads under the canonical delivery definition |
| Genuine Reply Rate | Genuine Replies ÷ Delivered |
| Positive Reply Rate | Positive Replies ÷ Delivered |
| Positive of Replies | Positive Replies ÷ Genuine Replies |
| All Outbound Sends | Outbound message events, deduplicated by event identity and bucketed in Vancouver time |
| Reply Rate / Sent | Replied leads in the selected funnel cohort ÷ sent leads in that cohort |
| Show Rate | Held calls ÷ (Held calls + No Show calls) |
| Win Rate | Won ÷ (Won + Lost) |

`—` means there is no valid denominator yet. It does not necessarily mean 0%.

### Funnel

```text
Sent/Contacted → Replied → Positive → Demo → Hot → Booked → Held → Won/Lost
```

The funnel uses evidence-backed historical progression. It does not fabricate missing stages. A lead currently Closed Lost is not automatically assumed to have once been Hot, booked, or held.

**Lifetime** includes the complete qualifying history. A campaign/version cohort includes only leads with qualifying evidence for that attribution boundary. A new measured campaign can legitimately be empty while Lifetime and Legacy/Unknown contain historical activity.

### Daily Sends

All Outbound Sends is message/event-based, while Unique Contacted is lead-based. One lead can receive an initial message and later follow-ups, producing multiple outbound events but remaining one uniquely contacted lead.

Daily send counts use the full cached activity snapshot, deduplicate event IDs, and use Vancouver calendar days. Counts change as outreach continues; examples in audits are not permanent targets.

### Inbox versus Analytics

- **Inbox:** “What needs attention now?”
- **Analytics:** “What historically happened?”

A positive reply remains Positive in historical analytics after you answer it, but its current owner may become Waiting and it may no longer appear under Needs response.

## 14. CRM Health

CRM Health is read-only. It detects issues but never repairs or mutates records.

| Level | Meaning | Owner response |
|---|---|---|
| Healthy | The check passed | No action required |
| Info | Useful visibility, expected configuration, or historical context | Read for awareness |
| Warning | Actionable operational/data-quality issue that is not necessarily an active send danger | Inspect and resolve through supported workflows |
| Critical | Potentially unsafe behavior or serious integrity failure | Investigate before expanding automation; determine whether sending is implicated |

Major monitored areas include:

- canonical and malformed identity;
- reply evidence, classification, overrides, and overdue human work;
- activity event identity and metadata;
- ownership and multiple executable owners;
- suppression and send eligibility;
- MANUAL HOLD consistency;
- Pipeline/Hot/call lifecycle integrity;
- campaign attribution and funnel reconciliation;
- Calendar and sequence configuration;
- Gmail human-outbound observation;
- provider/send consistency.

### If a Critical appears

1. Open and read the exact finding and affected leads.
2. Avoid enabling any additional automation.
3. Determine whether regular sending is implicated. Do not blindly stop everything for an unrelated historical issue.
4. Inspect the lead drawer/timeline, identity, ownership, suppression, hold, meeting, and provider evidence.
5. Resolve the underlying issue through supported workflows before expanding automation.

Warnings often represent overdue human work, malformed historical data already blocked from sending, or redundant-hold cleanup. Read the summary before deciding severity.

## 15. Settings

Settings displays non-secret operational status:

| Item | What it tells you |
|---|---|
| Cold outreach sending | Whether regular sending is enabled and the configured daily cap |
| Stage sequences | Whether recovery/stage journeys can execute |
| Google Calendar sync | Whether automatic booking sync is active; manual lifecycle controls remain available when off |
| Smartlead integration | Whether it is enabled and whether live mutations are active or it is read-only/test mode |
| Roofing reply flow | Whether the specialized roofing reply workflow is enabled |
| Agent panel | Current/recent agent mode, run state, and safe logs |

Settings never displays API keys, OAuth tokens, passwords, service-account credentials, or raw secret values.

## 16. How the CRM prevents bad sends

The protections stack. Passing one check does not make a lead sendable.

1. **Suppression:** opt-out, bounce, hard tags, and the durable suppression list block sending.
2. **Identity validation:** malformed or ambiguous identities fail closed.
3. **Canonical identity:** supplied addresses are evidence until explicitly approved through a safe workflow.
4. **MANUAL HOLD:** ordinary cold cadence stays stopped during manual control.
5. **Pipeline exclusion:** promoted/non-cold opportunities cannot re-enter ordinary cold follow-up merely because an old cadence is due.
6. **Human ownership:** actionable replies and unresolved human decisions block conflicting automation.
7. **Gmail response observation:** manual replies are observed before automated execution; stale mailbox context fails closed.
8. **Meeting ownership:** future or unresolved meetings block inappropriate cold contact.
9. **Contact-change review:** unresolved proposed identities cannot become automatic targets.
10. **Terminal stages:** Won/Lost/terminal states own no automated cold action.
11. **Sequence stop conditions:** replies, human intervention, bookings, suppression, identity conflict, pause/cancel, and incompatible lifecycle stop recovery steps.
12. **Feature flags:** regular sending, stage sequences, Calendar sync, and provider mutations have separate controls.
13. **Daily limit:** automated touches share the configured daily ceiling.
14. **Provider verification and idempotency:** duplicate events do not create duplicate activities; uncertain provider checks refuse unsafe execution.

## 17. Troubleshooting

| Situation | Likely explanation | Inspect | Safe next action |
|---|---|---|---|
| Prospect replied but is not where expected | Filter mismatch, reply category differs, identity is malformed, or evidence is Unknown | Inbox → All replies; lead timeline; CRM Health reply/identity findings | Read provider evidence and use supported review/override controls; do not guess sentiment |
| I replied from Gmail but CRM still says Respond | Observation has not completed, wrong Gmail account/thread, or provider read failed | Timeline for manual response; Settings agent log; CRM Health ownership | Refresh after the observation cycle; avoid duplicate automation while uncertain |
| A lead is not sending | Suppression, invalid identity, hold, Pipeline promotion, human/meeting/waiting ownership, cadence timing, feature flag, route, cap, or provider check | Lead timeline, owner/block reason, Settings, CRM Health | Correct the real blocker; never bypass suppression or force-send |
| Blocked by MANUAL HOLD | Cold cadence was deliberately stopped | Why the hold was applied; current owner; reply/meeting/Pipeline state | Leave it unless you deliberately intend to release cold cadence and all other gates are safe |
| Lead is Waiting | Prospect, meeting, or known date legitimately owns the next event | Waiting-on label and due source | Wait until the condition/date; do not create a duplicate follow-up |
| Automated reply appears in Inbound Messages | Inbound includes all message categories | Reply category/subtype | No correction needed; it remains excluded from Genuine Replies |
| Inbox and Analytics counts differ | Operational versus historical views | Inbox filter and Analytics cohort | Compare definitions, not raw totals |
| Positive Reply Rate is lower than Positive of Replies | Different denominators: Delivered versus Genuine Replies | Metric tooltips and cohort | Interpret outreach conversion separately from conversation quality |
| Show Rate is `—` | No Held + No Show denominator exists | Bookings and call outcomes | Record real outcomes; do not invent a 0% |
| Campaign says `legacy_unknown` | No trustworthy historical version evidence | Timeline attribution and campaign activation boundary | Leave it honest unless provider-backed evidence exists |
| Supplied contact email is not used | It is evidence, not approved identity | Contact review action and identity conflicts | Review/approve safely; approval itself sends nothing |
| Meeting is not appearing | Calendar sync is off, missing manual lifecycle record, invalid/missing time, or identity mismatch | Bookings, Pipeline drawer, Settings Calendar status | Record/repair the supported meeting state manually; do not fake a booking |
| Sequences say disabled | Production sequence flag is off by design | Settings and Sequences | Leave off unless the full enablement checklist is deliberately completed |
| CRM Health shows Warning | Operational or data-quality issue without current critical risk | Exact finding and affected leads | Resolve proportionately; do not shut down all sending automatically |
| CRM Health shows Critical | Possible unsafe execution or serious integrity failure | Finding, affected leads, ownership, suppression, identity, provider evidence | Do not expand automation; determine send impact and resolve the root issue |

## 18. What not to do

- Do not manually change canonical lead or activity IDs.
- Do not bypass suppression, bounce, invalid-recipient, or contact-review blocks.
- Do not treat an autoresponder as genuine engagement.
- Do not invent a follow-up date from vague wording.
- Do not replace canonical contact identity merely because another email appears in a reply.
- Do not remove MANUAL HOLD without understanding why it exists.
- Do not assume removing a hold alone makes a lead safe to send.
- Do not enable stage sequences casually.
- Do not assume Inbox and Analytics counts should match.
- Do not rewrite acquisition attribution to make campaign reports cleaner.
- Do not mark cancellation or no-show as Closed Lost without the real sales outcome.
- Do not send a duplicate message while Gmail observation or ownership evidence is uncertain.
- Do not edit underlying Sheets/database rows directly when a supported CRM control exists.

## 19. Quick reference

### Daily

- [ ] CRM Health: Critical first, then actionable Warnings
- [ ] Inbox: human-owned Needs response
- [ ] Pipeline: overdue and stale Hot actions
- [ ] Bookings: today's meetings and Outcome Pending
- [ ] Outcomes: record completed/no-show/cancelled and sales results
- [ ] Analytics/Campaigns: brief trend check, with cohort and denominators understood

### When a reply arrives

1. Read the reply category: what did they say?
2. Read Next Action: what should happen now?
3. Read Owner: who controls the next move?
4. If Human-owned, inspect the timeline and respond appropriately.
5. Reply from Gmail if preferred; let the CRM observe the response.
6. Confirm the state becomes Waiting/otherwise appropriate before adding another follow-up.

### When something looks wrong

1. Open CRM Health.
2. Open the lead drawer and canonical timeline.
3. Check owner and blocked reason.
4. Check suppression and MANUAL HOLD.
5. Check Pipeline/meeting/contact-review state.
6. Check provider evidence and Settings agent status.
7. Fail safe: do not send while the evidence is uncertain.

### Before enabling automation

- [ ] No CRM Health Critical
- [ ] Gmail response observation working
- [ ] Zero ownership conflicts
- [ ] Suppression/bounce handling working
- [ ] Identity and contact-review backlog understood
- [ ] Daily limits and provider route understood
- [ ] Sequence enrollment, copy, timing, stop conditions, and existing state reviewed
- [ ] Meeting data accurate for lifecycle-driven journeys

## 20. Glossary

| Term | Operator-friendly definition |
|---|---|
| Canonical | The CRM's single trusted record/decision used by every workspace and safety check |
| Inbound Message | Any incoming prospect-side message, including automated and unknown messages |
| Genuine Reply | A Positive, Negative, or Needs Human message from a person |
| Next Action | The CRM's current answer to “What should happen now?” |
| Operational Action | The specific job implied by current evidence, such as respond, book, revisit, or investigate |
| Automation Ownership | Who controls the next move: human, cold automation, recovery sequence, meeting, waiting, or none |
| MANUAL HOLD | Independent tag that stops ordinary cold cadence during manual control |
| Suppression | A hard reason the CRM must not send, such as opt-out, bounce, or durable suppression-list entry |
| Hot | An active opportunity with canonical positive intent and human sales ownership |
| Waiting | Nobody should act yet because the prospect, meeting, or known date owns the next event |
| Recovery Sequence | A bounded stage-specific follow-up journey separate from ordinary cold cadence |
| Acquisition Attribution | The campaign/version that originally acquired the lead |
| `legacy_unknown` | Honest label for historical activity whose campaign version cannot be proven |
| Measured Campaign | A campaign version with a defined evidence-backed activation boundary |
| Human Response | A provider-backed message sent manually from Gmail after the prospect wrote in the thread |
| Contact Change Review | Human review required before a proposed mailbox can affect canonical identity |

## 21. Technical appendix

This section is for future maintenance, not daily operation.

### Major modules

- `integrations/canonical-reply.js` — canonical reply evidence and classification
- `integrations/reply-operations.js` — reply-specific operational actions
- `integrations/pipeline-state.js` — CRM-wide Next Action, Hot, meeting, and hold precedence
- `integrations/automation-ownership.js` — single executable-owner and send permission model
- `integrations/human-outbound.js` — Gmail manual-response evidence and replay safety
- `integrations/stage-sequences.js` — bounded recovery journeys and stop conditions
- `integrations/promotion-policy.js` — safe opportunity promotion and downgrade protection
- `integrations/campaign-versions.js` — acquisition and later-touch attribution
- `integrations/funnel-analytics.js` and `integrations/reply-analytics.js` — canonical historical metrics
- `integrations/crm-health.js` — read-only integrity/safety diagnostics
- `integrations/google-calendar.js` — booking event interpretation; production sync flag is currently off

### Canonical activity concepts

Important activities include provider-backed inbound reply events, `human_response_sent`, outbound send events, sequence lifecycle/step events, booking/reschedule/cancellation/call outcomes, promotion events, and auditable manual decisions. Stable event IDs make provider replay idempotent.

### Major feature flags

- `SENDING_ENABLED` — regular provider execution master switch; currently true
- `STAGE_SEQUENCES_ENABLED` — stage/recovery journey execution; currently false
- `GOOGLE_CALENDAR_BOOKING_SYNC_ENABLED` — Calendar booking sync; currently false
- provider-specific integration/live-mutation flags — displayed only as safe status in Settings

No secret values belong in this guide.

### Safety invariants

- At most one executable owner controls a lead.
- Suppression, invalid/ambiguous identity, terminal state, and unsafe contact change fail closed.
- Promoted Pipeline leads cannot receive ordinary cold cadence.
- A manual Gmail response is observed before automated execution that could conflict with it.
- Human, meeting, and waiting ownership block inappropriate cold automation.
- Sequence execution requires its own flag and passes stop, ownership/freshness, daily-cap, and provider gates.
- Acquisition attribution is not overwritten by later recovery activity.
- Historical analytics are not rewritten by current operational state.

### Final engineering baseline

- Final engineering commit: `38a759626628a2e5e30ec249df5a397fb05e5e09`
- Regression suite: 810/810 passing
- Deployment platform: Railway
- Phase 2.7 production verification: zero unresolved Blocker/Important findings and zero CRM Health Critical findings

