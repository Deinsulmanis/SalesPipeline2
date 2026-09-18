# Batch 3 duplicate / exclusion report (continuation)

Comparison baseline: live staffing corpus (**327** leads after the 58 imported Batch 3 rows) + Apollo list `ScaleLab — Staffing — Already Sourced` + this batch's own approved set.

**58** approved sourcing emails overlap live corpus. Those are the previously imported Batch 3 pass-1 leads, not Phase 2. The **73** continuation candidates have **0** live email overlap. The six Phase 1 retry emails are still sourcing-approved and still absent from live (never imported).

## Post-reveal held / rejected (150 rows)

See `batch3-rejected-held.csv`.

| Reason | Count | Treatment |
| --- | ---: | --- |
| email_domain_mismatch | 32 | Held; not auto-approved |
| held_white_collar_mix | 28 | Held |
| held_weak_industrial_evidence | 21 | Held |
| held_white_collar_or_off_niche_keywords | 19 | Held |
| held_it_mix | 10 | Held |
| held_medical_mix | 9 | Held |
| held_exec_search_mix | 8 | Held |
| held_hospitality_event_mix | 5 | Held |
| other off-niche / professional / HRO / RPO / entity mismatch | 16 | Held |
| national_exclusion (PROSTAR / Proman) | 1 | Rejected |

Related-domain emails (hyphen / substring ≥6 on the registrable name) were approved when the domains clearly matched.

## Pre-reveal exclusions (current dumps)

| Class / skip | Count | Credits spent |
| --- | ---: | --- |
| Duplicate company name vs live / already-sourced / Batch 3 | 330 | 0 |
| Already revealed or dispositioned | 289 | 0 |
| Generic staffing already website-rejected | 230 | 0 |
| ICP name reject (healthcare, IT-only, legal, PEO/payroll, dental, etc.) | 70 | 0 |
| National / enterprise name | 44 | 0 |
| Construction contractor without staffing language | 12 | 0 |
| Weak title (non-buyer) | 10 | 0 |
| Duplicate company domain | 1 | 0 |

Banned before reveal: Integrity Staffing (`integritystaffing.com`), Quinyx (`quinyx.com`).

Skipped after free site/org review this continuation: Applied Staffing (entity mismatch), CitiStaffing (nationwide), Innovative Anesthesia, Scion, MDS, LIVIT (white-collar professionals), Spak/Spark unresolved domain, Vital Staffing (healthcare), Bear Staffing (no industrial evidence), Hatch Staffing (no industrial evidence), APR / Structure / Move (403 / unreadable).

## One-buyer rule

One contact per company. Additional people at already-approved or corpus companies were not revealed.

## Not imported

This report is sourcing/screening only. Held rows are preserved for human review. Phase 2 approved rows are **not** queued.
