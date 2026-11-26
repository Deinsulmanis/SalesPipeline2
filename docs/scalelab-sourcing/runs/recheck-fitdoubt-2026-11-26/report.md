# Import-stage cleanup (2026-11-26): counts only

There were 121 ScaleLab leads left in Import after the 2026-11-24 Campaign 2 / V1 recovery: 86 from Campaign 2 and 35
from V1. None had ever been emailed.

## Re-check of the 57 V4_FIT_DOUBT leads

**Method:** fresh crawl (51 readable, 6 sent to the headless retry), then the Jev ICP gate.

**Jev spend:** $0.009 (run ledger).

| Result | Leads |
|---|---|
| PASS | 1 (a Canadian company: excluded under the owner's 2026-11-24 CASL rule) |
| HOLD (industrial line not established) | 21 |
| REJECT (no industrial line) | 35 |

None of the 57 could be converted. On the owner's instruction ("I need the import empty") they were archived too; see below.

## Archived: the other 64 (owner instruction)

**Method:** archived one by one through the production endpoint `POST /api/archive/leads/:id`
(reason `manual_archive`). This is reversible: `/api/archive/leads/:id/restore` brings a lead back.

| Why they were left behind on 2026-11-24 | Leads |
|---|---|
| ICP reject (15 non-industrial, 10 ICP reject) | 25 |
| Contact problems (5 not a buyer, 4 verification unknown, 2 person mismatch, 1 invalid) | 12 |
| Site unreadable | 9 |
| Owner-excluded on 2026-11-24 (5 contact problems, 3 Canadian) | 8 |
| Copy hold | 7 |
| Contact [MANUAL HOLD] | 3 |

**Pre-check:** all 64 were ScaleLab rows in stage Import, never emailed, with no sender and no sequence step.

**Results:** 64 succeeded, 0 refused, 0 conflicts.

**Post-check (Supabase):**
- all 64 are in stage Archived;
- each `revision` went up by exactly one (3–6 → 4–7);
- every row carries the archive marker;
- none has a sender or a send.

## Archived: the 57 re-checked leads (owner instruction: empty Import)

**Method:** the same endpoint and reason as the 64. The 57 were exactly the re-checked set: 55 from Campaign 2 and 2
from V1. None had been emailed, and none had a sender.

**Results:** 57 succeeded, 0 refused, 0 conflicts.

**Post-check (Supabase):**
- all 57 are Archived, with the archive marker;
- each `revision` went up by exactly one (3 → 4 and 6 → 7);
- none has a sender or a send.

**Leads in Import now, all clients: 0.**
