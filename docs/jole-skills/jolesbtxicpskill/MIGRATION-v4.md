# Migration from jolesbtxicpskill 3.0.0 to the modular skills (4.0.0)

2026-11-03. Each v3 section is listed with where its rules now live and what happened to them:
- **Preserved:** same substance, maybe reworded.
- **Moved:** preserved in a different file.
- **Replaced:** a different rule now applies, for the reason given.
- **Corrected:** v3 was factually wrong.
- **Deprecated:** no longer used.

The v3 text is kept in the SalesPipeline2 repo, on branch `docs/jole-icp-skill-v3-20261102`, at `docs/jole-icp-skill/SKILL.md`.

## Section by section

| v3 section | Now | Status |
|---|---|---|
| 0 Header, authority, "optimize for accuracy", read reference.md first | Shared policy, preamble | Preserved. Authority now covers all eight skills. |
| 0 Standing safety rules | Shared policy, Standing safety rules | Preserved. Added: read-only CRM rule, no test emails, no skill authorizes import, sending or spend. |
| 1 Confirmed capabilities and crafts | Shared policy section 1 | Preserved. The contractor row now also states the staffing and mixed-contractor rule; the Navy row points to feasibility for per-contract checks. |
| 2 Three separate decisions | Shared policy sections 3 and 4 | Replaced by nine owned dimensions, labels and precedence. The "never merge" rule is preserved and widened. |
| 3 Dimension A: six checks | `jole-icp-qualification` procedure | Moved. Checks 1-4 are preserved. Check 5 is split: named lists go to ICP, suppression to dedupe. Check 6, "plausible ability to procure", goes to `jole-site-labor-feasibility`. |
| 3 Do-not-require list | `jole-icp-qualification` | Preserved, plus the brief's additions (verified expansion, contract award, labor shortage). |
| 3 Sectors, manufacturers, expansion pool | `jole-icp-qualification` | Preserved word for word. |
| 3 Business-model table | `jole-icp-qualification` | Preserved. HOLD rows (dealers, oilfield services, field-service-heavy) became CONDITIONAL with a credit hold, which has the same effect. Added the `labor_supply_overlap` field. |
| 3 Hard exclusions | Shared policy section 2 | Preserved. This is now the only copy of the lists, and a test enforces that. |
| 3 Labor agreements and restricted work | `jole-site-labor-feasibility` | Moved and relabelled: binding agreement EXCLUDED became BLOCKED BY VERIFIED REQUIREMENT; in-plant union with unknown terms became UNKNOWN; documented contractors became FEASIBLE WITH CONDITIONS. Same substance. |
| 3 Defense, federal and nuclear checks | `jole-site-labor-feasibility` | Preserved. |
| 3 Holds before credits | Shared policy section 2 | Preserved, as CONDITIONAL with a credit hold. |
| 4 Buying signals and evidence levels | `jole-buying-signals`; evidence levels in shared policy section 5 | Preserved. Taxonomy extended to 8 types (stated shortage; mobilizations under awards). Added five signal statuses and the separate outside-labor field. |
| 4 Hiring evidence sources | `jole-buying-signals` | Preserved. |
| 5 Opportunity score (100 points) | `jole-buying-signals`, demand score | **Replaced.** Buyer (15) and procurement (10) points were removed because they are separate dimensions now; the three demand components keep their v3 anchors; bands rescaled to 75 points (A 64+, B 53-63). |
| 6 Readiness gates | `jole-outreach-readiness` outcomes, plus orchestrator next actions | **Replaced** (mapping below). |
| 7 V5 lane and hiring modes | `jole-outreach-readiness` | Preserved, with one correction: the hiring window is 30 days from the last evidence check (`jole-personalization.js` `FRESHNESS_DAYS = 30`), not "posting date within 45 days". The 45 in `campaigns.js` does not govern v4 or v5. |
| 7 Old posting gates, tiers, single-posting gate | `jole-outreach-readiness`, "V5 hiring-lane wave rules"; core trades in `jole-buying-signals` | Preserved. |
| 8 Buyers | `jole-buyer-identification` | Preserved: hierarchy, weak roles, site gate, tie labels, multi-site rule, holds, contact count. Added roles by operating model, `HQ-AUTHORITY` and `Procurement / subcontracts`. Status labels renamed (below). |
| 9 Email and deliverability | `jole-contact-deliverability` | Preserved. Bounce figures updated to the 2026-11-01 remediation; Proofpoint Essentials (`ppe-hosted.com`) added; four outcomes added. |
| 10 Dedupe and suppression | `jole-dedupe-suppression` | Preserved. Sources named (`outreach_leads`, `client_suppressions`, the `Suppression` sheet, prior waves), six outcomes, live-versus-mirror confidence. |
| 11 Apollo credit protection | Shared policy section 8 | Preserved. Email validation added to the paid list. |
| 12 QC: research runs | CONTRACT.md (envelope, consolidated record, batch CSV) | Replaced by the shared contract. The v3 requalification columns stay in reference.md as history. |
| 12 QC: contact waves, reason codes, files, `why_contact_is_relevant` | reference.md, "Contact-wave QC files"; the format is in `jole-outreach-readiness` | Moved. |
| 13 Import | Shared policy section 9 | Preserved. Notes that new leads need a V5 classification entry. |
| 14 Freshness and send order | Shared policy section 7; send order in `jole-outreach-readiness` | Preserved. Reuse windows added as working defaults. |
| 15 Examples | The owning skill's Examples table | Moved: all 14 v3 examples are kept with the skill that decides them. |
| 16 Where the next wave should look | reference.md | Moved. |
| 17 Tests and maintenance | Shared policy section 10; ARCHITECTURE.md | Replaced: per-skill tests, orchestration tests, `run_all.py`. The v3 `decide.py`, `fixtures.json` and `test_skill.py` were retired; their 45 cases are redistributed across the specialists' fixtures. |

## Label mapping

| v3 | 4.0.0 |
|---|---|
| Buyer VERIFIED / PARTIAL / NOT SITE-CONNECTED / NOT FOUND | BUYER VERIFIED / BUYER PARTIAL / BUYER NOT SITE-CONNECTED / BUYER NOT IDENTIFIED |
| Readiness HOLD | STOP (excluded, prohibited, suppressed, blocked) or HOLD (policy hold) |
| COMPLIANCE / PROCUREMENT REVIEW | Feasibility UNKNOWN (next RESEARCH FEASIBILITY) or FEASIBLE WITH CONDITIONS (next REVIEW); a mixed contractor's competition call is ICP CONDITIONAL (next REVIEW) |
| SIGNAL VERIFICATION REQUIRED | ICP CONDITIONAL (next RESEARCH FIT). An unverified or stale signal now lowers priority and blocks only signal-based copy, not buyer research. |
| BUYER RESEARCH REQUIRED | Next action RESEARCH BUYER |
| CONTACT VERIFICATION REQUIRED | Next action SOURCE CONTACT or VERIFY CONTACT; readiness CONTACT VERIFICATION REQUIRED |
| READY FOR CONTACT REVIEW | Readiness READY FOR APPROVED SEQUENCE, next HUMAN REVIEW |
| "Only the variant is missing: HOLD" | COPY / SIGNAL REVIEW REQUIRED (next COPY REVIEW) |

## Effect on the 38 companies (tests/regression_38.json)

| Measure | v3 | 4.0.0 |
|---|---|---|
| ICP | 17 qualified, 19 conditional, 2 excluded | 21 qualified, 16 conditional, 1 excluded |
| Priority | 1 A, 7 B, 28 nurture, 2 not scored | 1 A, 5 B, 30 nurture, 2 not evaluated |
| Stopped | TVA, Arc Solutions (HOLD) | Arc Solutions (ICP EXCLUDED), TVA (feasibility BLOCKED) |

Ten decisions changed, each with a recorded reason:
- **ICP:**
  - Atalco and INNIO: union terms moved to feasibility.
  - Hyundai Translead: trailer manufacturing is process-level craft fit.
  - TVA: fit QUALIFIED; access BLOCKED, so the outcome is unchanged.
- **Priority:** Leading Edge and Walashek, B to nurture, because their v3 scores relied on buyer and procurement points.
- **Next action:**
  - Cenovus: a passed signal no longer blocks buyer research.
  - Niagara, CP Industries and Fairbanks Morse: the cheaper fit gap is now resolved before union or clearance terms.

## Deprecated or retired

- The v3 readiness labels listed above.
- The single 100-point opportunity score.
- "Do not create a second Jole ICP skill" in the instruction files. It is replaced by "do not create other Jole qualification skills or copies; shared rules change only in the shared policy".
- `~/.agents/skills/jolesbtxicpskill` as the only Codex entry. There are now nine pointers, one per skill.
