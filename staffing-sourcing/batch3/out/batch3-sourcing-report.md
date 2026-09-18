# Batch 3 staffing sourcing report

Status: **candidate list only**. No import, queue, send, campaign, cron, template, or dental changes.

Worktree: `/tmp/staffing-batch3` on `cursor/staffing-batch3-sourcing-964b`.  
Active Gmail worktree `/workspace` (`main`) was not used.

## Campaign context reconstructed from prior Opus work

Live staffing corpus at sourcing time: **269 leads** (261 queued, 8 sent). Target ~500, so ~231 additional imported leads. Batch 1/2 schema and ICP were reused from `scripts/staffing-final-export.js`, `scripts/staffing-personalization-qa.js`, the live CRM export, and Apollo list `ScaleLab — Staffing — Already Sourced` (227 accounts).

Batch 3 email policy change vs Batch 1/2: **verified catch-all is admitted** (Tier 2). Still rejected: invalid, undeliverable, unverified, unknown, disposable, do-not-mail, bounced. No second-pass verifier.

## Process (not rebuilt from scratch)

1. Free Apollo people search (US, SIC 7361/7363, 1–200 employees, senior buyer titles, industrial/warehouse/construction/light-industrial/skilled-trades/logistics keywords).
2. Name-level national / ICP / contractor / corpus-duplicate screen **before** reveal.
3. Free org lookup or guessed-domain website fetch for generic names; require industrial/trades SITE_FIT (or keep_name from SIC staffing search).
4. One buyer per company (`title_rank`).
5. Standard `apollo_people_bulk_match` only (1 credit/person). **No waterfall, no phone.** Catch-all admitted after verified status.

## Funnel

| Step | Count |
| --- | ---: |
| Apollo people rows across search dumps | 5,200 |
| Unique people IDs screened | 2,590 |
| Unique companies in dumps | 1,549 |
| National/enterprise name exclusions (pre-reveal) | 36 |
| ICP name rejects (healthcare/IT/legal/PEO/etc.) | 31 |
| Contractor-not-staffing skips | 8 |
| Duplicate company names vs live corpus / already-sourced / this batch | 305+ |
| Reveals attempted | 111 |
| Credits spent | **114** |
| Remaining of 400-credit cap | **286** |
| Verified non-catch-all | 65 |
| Verified catch-all | 19 |
| Invalid / unusable emails | 0 |
| Duplicate contacts after reveal | 0 |
| Duplicate companies after reveal | 0 |
| National exclusion after reveal (PROSTAR / Proman) | 1 |
| Final approved candidates | **84** |
| Held for review | 26 |
| Rejected (national) | 1 |

Pre-reveal website qualification remains the bottleneck, not the 400-credit cap. Hundreds of generic-named staffing agencies still lack public industrial evidence and were not revealed.

## Efficiency

- Credits per approved candidate: **114 / 84 = 1.36**
- Approved candidates per 100 Apollo credits: **73.7**
- Prior campaign figure of ~2.43 credits per **imported** lead is not comparable: these 84 have not gone through personalization, research, or import.

## Quality

**Titles:** President 31, owner/founder/partner 26, CEO 15, branch/regional manager 9, sales/BD 3. Senior buyers dominate; junior contacts were not revealed when a stronger buyer was present.

**Lane:** 74 Lane A (light industrial / warehouse / manufacturing / logistics), 10 Lane B (construction / skilled trades). Lane B is thinner because many construction hits were recruiting/exec-search or contractors.

**Geography:** Broad US mix; largest states CA (8), IL (6), TX (6), OH (5), NC (5), PA (5). No non-US approvals.

**Email mix:** 65 verified non-catch-all (Tier 1), 19 verified catch-all (Tier 2, admitted per Batch 3 policy). 0 invalid.

**Size:** 1–10: 26; 11–50: 38; 51–200: 20. No 201+ approvals.

**Fit:** Approved set is industrial/skilled-trades staffing agencies (manufacturing, warehouse, logistics, construction labor, welding/trades). Weak generic homepages were held post-reveal when Apollo keywords showed medical, IT, executive search, HRO/PEO, or no industrial evidence.

**Obvious weaknesses**

- Approved count (84) is below the 180–220 quality-volume goal. Credit cap was **not** the limiter; website ICP evidence for generic-named agencies was.
- Lane B construction/trades is light.
- Some approved generics (Associated Staffing, CSI, America's Staffing Partner) are industrial-origin but less sharply specialized than name-fit agencies such as Fordified, Xander, Lone Wolf, UCP-adjacent holds, MCM.
- Guessed-domain SITE_FIT produced some false positives (white-collar / medical / IT) that were caught **after** reveal and moved to held.

## Safety

- 400-credit cap not exceeded (114 spent, 286 remaining).
- No live staffing lead imported.
- No lead queued.
- No email sent.
- No dental data modified.
- Gmail Cursor worktree `/workspace` on `main` untouched.
- Standard match only; waterfall/phone not used despite waterfall being enabled on the Apollo team.

## Output files

- `out/batch3-approved-candidates.csv`
- `out/batch3-rejected-held.csv`
- `out/batch3-credit-ledger.csv`
- `out/batch3-duplicate-exclusion-report.csv`
- `out/batch3-sourcing-report.md` (this file)
- `out/approved.jsonl`, `held.jsonl`, `rejected.jsonl`
- `state.json` credit ledger

## Follow-on (not done)

Remaining allowance **286 credits**. A later pass can keep qualifying generic-named agencies from the people dumps (still ~300+ without a proven industrial website) and revealing only SITE_FIT / keep_name survivors. Do not import this file until personalization/research is authorized.
