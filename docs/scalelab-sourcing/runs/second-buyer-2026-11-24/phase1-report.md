# Second-buyer pool: Phase 1 (read-only, 2026-11-24)

ScaleLab data only (client_id = scalelab; Jole ignored). Staffing campaigns: Industrial Staffing Agency (V1),
Staffing Outreach Campaign 2 (C2), Industrial Campaign 3 (C3). No credits spent. Script:
`docs/scalelab-sourcing/tools/second_buyer_pool.py`; per-company file in `runs-private/second-buyer-2026-11-24/`.

Sources: dashboard spreadsheet export (ColdEmail, Suppression, Leads, ReplyDrafts), Supabase outreach_leads +
crm_events + scalelab reply actions/classifications, the V4 master and every V4 run folder (gate, saved Apollo
searches, cached crawls). ColdEmail and Supabase agree row for row (1,838 staffing rows, 0 id or stage differences).
client_suppressions is empty; the Suppression sheet has 135 addresses (108 bounce, 26 unsubscribe, 1 not interested).

## Companies ever contacted

| | Companies |
|---|---|
| Ever emailed (one contact each; no company was emailed in two campaigns) | 1,684 |
| V1 | 939 |
| C2 | 403 |
| C3 | 342 |
| Imported but never emailed (not counted above) | 153 |

## Classification

| Status | Companies |
|---|---|
| EXCLUDE | 186 |
| WAIT | 734 |
| ELIGIBLE (V4 gate PASS/HOLD, finished, >= 30 days) | 0 |
| ICP_UNKNOWN (never V4-gated; re-gate before spend) | 764 |

EXCLUDE by primary reason: non-US 101 (V1 only: Canadian TLD or city), [MANUAL HOLD] with no reply 58 (V1 sender-auth
holds, mostly stopped after step 1; human-owned, owner decides), unsubscribe or negative reply 11, positive reply or
pipeline 9, national chain / franchise 6, neutral reply 1. Any-reason counts: non-US 106, suppressed (non-bounce) 10,
positive 10. Bounced contacts do not exclude: 21 bounced contacts sit at non-excluded companies.

Why ELIGIBLE is 0: every C3 company is still in sequence, and no V1 or C2 company has a V4 gate result (V4 runs
excluded production domains, so they were never crawled or gated). ICP_UNKNOWN = 757 V1 + 7 C2.

## WAIT, by the date the company becomes eligible

| Becomes eligible | Companies |
|---|---|
| 2026-11-25 to 11-27 | 5 |
| 2026-11-29 | 102 |
| 2026-12-02 | 72 |
| 2026-12-03 | 99 |
| 2026-12-05 | 98 |
| 2026-12-06 | 18 |
| After the C3 sequence ends (+30 days; started 11-20 to 11-24) | 340 |

The 394 C2 companies in WAIT were never V4-gated either, so they join ICP_UNKNOWN when they become eligible.

## Eligible split (ICP_UNKNOWN pool, 764)

- Branch count: unknown for all 764. No cached crawl exists for any of them (0 of 764), so single-site vs
  multi-branch needs the free crawl in the Phase 2 re-gate.
- Saved second candidate in earlier free Apollo searches: 0 of 764 (those searches only covered newly discovered
  companies). All 764 need a new free search.
- Contact already emailed: tier 1 (owner/president/CEO) 231, tier 2 21, branch/regional 14, title not recorded 498.
- Stalled sequences (V1 stopped before the last step, no hold): 133.

## Re-engage pool (size only)

Same contact, V1 (pre-v2) copy, no bounce, last emailed >= 60 days ago: 0 today (V1's last sends were
2026-09-28 to 10-22). It grows to 41 by 11-30, 123 by 12-07, 317 by 12-14 and 749 by 12-21.

## Phase 2 estimate (known rates; ranges, not commitments)

For the 764 ICP_UNKNOWN companies (the 394 C2 companies would add about half as much again from 12-06):

| Step | Rate used | Estimate |
|---|---|---|
| Free crawl + Jev re-gate | about $0.0002-0.0003 per company | Jev $0.15-0.25; 420-570 not rejected |
| Free Apollo people search (exclude everyone emailed) | a different tier 1-2 buyer for 25-35% | 105-200 companies |
| GetLeads lookup_decision_makers by domain | about 27% eligible, about 1.5 credits each | 250-350 plan credits, 50-90 companies |
| Owner-gap (first@ only) | about 3 of 8 remaining | 20-40 addresses to the owner's upload |
| Adyntel (Google + Meta) on companies with a buyer | 2 credits | 300-500 credits |
| Apollo reveal (ids only) | about 1.14 credits per approved contact | 120-230 credits |
| Owner verification (GetLeads upload) | $0.0005 per address | about $0.05, owner-run |

Expected yield: about 150-280 second-buyer contacts from the 764 (more where crawls show 3+ branches).
