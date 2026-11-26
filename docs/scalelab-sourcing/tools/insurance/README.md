# Insurance niche toolkit (pilot)

ScaleLab client = commercial / workers' comp insurance agency; meetings are booked with employers whose WC policy
renews soon. Design and ICP: [`../../segments/insurance-deep-dive-2026-11-26.md`](../../segments/insurance-deep-dive-2026-11-26.md).
First run: [`../../runs/insurance-pilot-2026-11-26/run-report.md`](../../runs/insurance-pilot-2026-11-26/run-report.md).

Everything insurance-specific lives here; the staffing tools one level up are reused unchanged (`fetch_sites.py`,
`pw_fetch.js`, `jevlib.py`, `apollo_lines.py`, `gl_lines.py`, `parse_reveal.py`, `buyer_pick.norm`,
`ingest_verification.map_row`). Private data stays in `runs-private/<run>/`. Run Python with `python3 -I` from the
repository root.

| Step | Script | Notes |
|---|---|---|
| Config | `ins_config.py` | window, premium floor, class-code -> industry map, metros, employer buyer rule, agency exclusions |
| Employer list | `tx_renewals.py <run> --download --run-date D` | Texas TDI-DWC open data, non-PEO, $25k+, 60-120 days; counts.json is counts only |
| Sample | `match_sample.py <run>` | random employers + lookup query lists for helper agents |
| Domains | `domain_resolve.py <run> <transcripts...>` | free Apollo organization lookups parsed from helper transcripts (`transcripts.py`) |
| Batches | `buyer_batches.py <run>` | excludes production domains and staffing agencies |
| People | `apollo_lines.py` (shared) then `employer_pick.py <run> E1 [E2]` | free Apollo people search; insurance buyer order |
| Reveal | Apollo `people_bulk_match` ids only, then `parse_reveal.py` (shared) | owner cap; check id order |
| GetLeads | `lookup_decision_makers` (domain, limit 2) via a helper, then `gl_lines.py` (shared) | owner cap |
| QC | `ins_contact_qc.py <run>` | domain / title / US / MX / catch-all; GetLeads -> VERIFY_PENDING -> to_verify.csv |
| Verification | `ingest_ins_verification.py <run>` | after the owner drops verified_results.csv |
| Funnel | `match_funnel.py <run> <apollo> <gl_dm> <gl_co>` | counts-only funnel, cost per contact, projection |
| Sample lists | `node renewal_sample_list.js <run>` | company-level renewal lists (no personal data) |
| Agencies | `agency_merge.py <run>`, `fetch_sites.py`/`pw_fetch.js` on `<run>/agency`, then `V4_JEV_BUDGET_USD=<cap> agency_gate.py <run>/agency` | Jev gate with the insurance ICP; no reveals |

No import, queue, send, cap change or deploy without the owner's go-ahead. Never use Insurance Xdate data on a
client's behalf (terms prohibit it; see the run report).
