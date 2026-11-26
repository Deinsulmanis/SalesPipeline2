# GetLeads enrichment lists (2026-11-24): counts only

Read-only, no paid calls. ScaleLab only. Built by `tools/enrich_lists.py` from every run folder (v4 pilot, wave 1,
codex 48, c1k, w2k, shortfall, v4-3000, Campaign 2 recovery, regate-551, jobs-discovery, second-buyer) and the
production rows never emailed. Lists and private key files: `runs-private/enrich-lists/`.

## List 1: email known, name / title missing (374 addresses, 230 companies)

| Source | Rows |
|---|---|
| Production rows never emailed (no name or title on the row) | 105 |
| Personal-looking addresses on the company's own site | 226 (second-buyer 118, w2k 46, c1k 21, c2-recovery 17, v4-3000 10, jobs-discovery 6, wave 1 4, pilot 3, codex 48 1) |
| Reveal held as person mismatch (email not the named buyer) | 26 (second-buyer 14, shortfall 5, v4-3000 4, jobs-discovery 3) |
| Owner-gap guess 1 (first@) not yet verified | 17 (second-buyer) |

## List 2: full name known, email missing (250 people, 188 companies)

| Source | Rows |
|---|---|
| Team-page owners / executives (tier 1-2 titles) | 187 (second-buyer 101, c1k 35, w2k 19, v4-3000 16, wave 1 8, jobs-discovery 8) |
| GetLeads people whose address verified unknown / invalid | 41 (shortfall 28, c2-recovery 8, v4-3000 5) |
| Email on an unproven domain | 16 (second-buyer 6, v4-3000 7, jobs-discovery 2, shortfall 1) |
| Owner-gap people whose two guesses were invalid | 3 (jobs-discovery) |
| Reveal returned no email | 3 |

Companies covered by either list: 368. Rows at a multi-branch company that already has an active contact (the ingest
applies the role / branch rule): 58.

## Excluded

| Reason | Count |
|---|---|
| Company's latest V4 gate HOLD (not PASS) | 1,578 |
| Company ICP REJECT | 1,083 |
| Same person already emailed or approved at the company | 203 |
| Non-US | 154 |
| Address already in production | 134 |
| Company already has an approved / active contact (fewer than 3 branches) | 116 |
| Already waiting in a to_verify.csv for the owner | 126 |
| Not a full name | 8 |
| Chain / franchise | 7 |
| Role mailboxes (info@, jobs@, hr@ ...) among QC'd addresses | 10, plus every branch / role mailbox found on sites |

Apollo search previews with a masked last name (not listed): 104 people at 74 eligible companies (47 of those
companies are not in either list). Revealing them costs 1 Apollo credit each: 104 credits, or 74 for the best one
per company.

Ingest (when enriched_list1.csv / enriched_list2.csv arrive): `tools/enrich_ingest.py runs-private/enrich-lists
--credits-before N --credits-after M`. Production never-emailed companies have no V4 PASS yet, so their results are
reported as needing a re-gate rather than output.
