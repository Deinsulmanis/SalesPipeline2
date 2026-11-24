# Four GetLeads enrichment lists (2026-11-24): counts only

Read-only, ScaleLab only. Built by `tools/enrich_lists4.py` from every run folder and production (snapshot taken after
the 124 imports). Excluded everywhere: EXCLUDE companies, ICP REJECT, chains, non-US, anyone in
buyer_ready_combined.csv or a pending batch, role mailboxes, and companies with an active Campaign 3 contact
(fewer than 3 branches). Private key files: `runs-private/enrich-lists-4/*_key.csv`.

| List | Rows | Source runs |
|---|---|---|
| no_buyer_domains.csv (PASS, no buyer on any path) | 326 | shortfall 226, v4-3000 47, jobs-discovery 27, w2k 15, c1k 6, pilot 2, wave 1 2, regate-551 1 |
| reengage_emails.csv (V1 / C2, no reply / opt-out / bounce / suppression) | 505 | V1 503, C2 2; eligible now 0, within 30 days 505 |
| linkedin_no_email.csv | 1 | v4-3000 Apollo reveal with no email |
| owner_names.csv (team-page owners / executives, no verified email) | 1,459 at 822 companies | v4-3000, w2k, c1k, jobs-discovery, second-buyer, wave 1; ICP PASS 174 / HOLD 1,285 |
| owner_names_pass_only.csv | 174 | the PASS subset of the list above |

Re-engage exclusions: active second buyer 583, too recent (< 30 days) 388, excluded company 127, manual hold
(human-owned) 39, reply / opt-out / bounce / suppression 19, non-US 14, ICP reject 5, chain 1.
LinkedIn-without-email is small because GetLeads decision-maker lookups only return contacts with a VALID email, and
Apollo reveals almost always returned one; no BUYER_NO_EMAIL results file was in the uploads.
GetLeads decision-makers batch link created for list 1 (per_domain_limit 2; 1 credit per returned contact).
