# Batch 3 duplicate / exclusion report

Comparison baseline: live staffing CRM export (269 leads) + Apollo list `ScaleLab — Staffing — Already Sourced` (227 accounts) + this batch's own approved set.

Approved candidates were checked on normalized email and company domain. **0 approved emails and 0 approved domains overlap the live corpus.**

## Post-reveal held / rejected (27 rows)

See `batch3-duplicate-exclusion-report.csv` and `batch3-rejected-held.csv`.

| Reason | Count | Treatment |
| --- | ---: | --- |
| email_domain_mismatch (unrelated email vs company domain) | 10 | Held for review; not auto-approved |
| held_weak_industrial_evidence | 4 | Held |
| held_white_collar_mix | 3 | Held |
| national_exclusion (PROSTAR / Proman group keywords) | 1 | Rejected, not approved |
| medical / professional / admin / exec-search / HRO / IT / event-legal mixes | 8 | Held |
| guessed-domain entity mismatch | 1 | Held |

Related-domain emails (e.g. `laborrocket.com` vs `laborrocketjobs.com`, hyphen variants) were approved when the registrable names clearly matched.

## Pre-reveal exclusions (people-dump unique companies)

| Class / skip | Count | Credits spent |
| --- | ---: | --- |
| National/enterprise name (Randstad, Manpower, Adecco, Employbridge, TrueBlue, Aerotek, Actalent, Kelly, Insight Global, Kforce, Proman/PROSTAR, Express, Staffmark, Allegis, etc.) | 36 | 0 (plus 1 post-reveal PROSTAR credit, then rejected) |
| ICP name reject (healthcare, IT-only, legal, PEO/payroll, dental, etc.) | 31 | 0 |
| Construction contractor without staffing language | 8 | 0 |
| Duplicate vs live corpus / already-sourced / Batch 3 approved name | 305+ | 0 |
| Weak title (non-buyer) | 6 | 0 |
| Generic staffing already website-rejected | 31+ | 0 |

Integrity Staffing (`integritystaffing.com`) and Quinyx (SaaS false-positive domain guess) were banned before reveal.

## One-buyer rule

One contact per company. Additional people at already-approved or corpus companies were not revealed.

## Not imported

This report is sourcing/screening only. Held rows are preserved for human review, not queued.
