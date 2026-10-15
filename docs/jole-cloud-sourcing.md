# Jole BTX — cloud sourcing workflow (pre-reveal)

Client: Jole BTX LLC (`clientId: jole`, representative Jorge Guerrero).
Campaign: `jole-btx-employer-acquisition` — approved ICP on the production
branch (`integrations/clients/campaigns.js`). This document does not change
that ICP; it only says how to source against it from a cloud session.

Paid email reveal, import and queue are **not** part of this workflow until the
operator approves a dry-run report. Production import/queue stay disabled.

## Gate order (unchanged)

1. Free discovery — Apollo People API Search (no credits).
2. Live dedupe — Supabase `outreach_leads` (all clients) + the Phase 5
   exhausted set (Apollo org/person ids in `client_lead_import_batches`
   `jole-phase5-689-20261008`).
3. Global suppression — Sheets `Suppression` tab (read-only export) merged with
   Supabase sticky tags; snapshot kept outside git.
4. ICP — `integrations/sourcing/exclusions.js` `joleExclusionReason` (staffing /
   recruiting / labor-service firms incl. national-brand branches and
   franchises, SpaceX family, Kiewit family / KOS, Karpower, current Jole
   clients — the client list is mandatory) + approved sector and buyer role.
5. Company / website validation — company site reachable over verified TLS and
   a public hiring posting for a listed craft role at a named site, posted in
   the last 30 days (evidence must still be ≤45 days old when sent).
6. Paid email reveal — `apollo_people_bulk_match` standard match only. No
   waterfall, no phone. One credit per person, operator-approved count first.

Any read failure in steps 2–3 stops the run before step 6.

## Environment requirements

- Network access must allow arbitrary company websites (an allowlist cannot
  cover them): cloud environment settings → Network access → the unrestricted
  level. Fetch through the session proxy (`HTTPS_PROXY`), as the shell tools and
  Python `urllib` do. The WebFetch tool cannot be used for validation here: it
  resolves DNS inside the container, which has no external resolver.
- Never fall back to unverified TLS. The Batch 3 `fetch_site` retries with
  `ssl._create_unverified_context()`; a cloud run must treat a TLS failure as
  `website_unreadable` (hold), not retry without verification.
- Apollo's job-postings endpoint costs 1 credit per company, so hiring evidence
  in the free stage comes from public posting pages (LinkedIn jobs or the
  employer's careers page), as Phase 5 did.

## What Phase 5 already used (exhausted)

The exact Apollo filters for Phase 5 were not recorded in git, Supabase or
Drive. Its results are: corpus `Phase5_Final_Corpus 2026-10-07`, 689 contacts
at 340 Apollo organizations in 37 states, hiring evidence from LinkedIn job
postings dated 2026-09 to 2026-10-07, all emails `VERIFIED`. By sector
(organizations): fabrication / machinery 175, metals / mining / paper 60,
refining / chemical 44, power / utilities 29, shipyard / marine 18, pipeline 8,
oil & gas producers 6. Densest states: TX, WI, OH, LA, MN, IN. Exclude these
org ids, person ids and domains before any reveal.

## Free search plan (approved ICP only)

Common filters on every query:

- `person_locations: ["United States"]`, `organization_locations: ["United States"]`
- `person_titles` (exact, `include_similar_titles: false`) mapped from the
  approved buyer roles: plant manager, operations manager, production manager,
  director of operations, general manager, maintenance manager, reliability
  manager, human resources manager, hr manager, talent acquisition manager,
  superintendent, site manager, owner, president
- `q_organization_job_titles` from the approved worker categories: welder,
  maintenance technician, machinist, cnc machinist, electrician, industrial
  electrician, maintenance mechanic, diesel mechanic, instrument technician,
  fabricator, fitter, millwright, pipefitter
- `organization_job_posted_at_range`: the trailing 30 days
- `not_organization_sic_codes: ["7361","7363"]`, `not_organization_naics_codes: ["5613"]`

Slices (one query each; page with `per_page: 100`, each stays under Apollo's
50,000-record display limit). Counts are from 2026-10-15:

| Slice | `organization_naics_codes` (approved sectors) | Buyer contacts |
|---|---|---:|
| A | 332, 333 (fabrication / machinery) | 26,311 |
| B | 331, 212, 322, 327 (metals / mining / paper / heavy industrial) | 17,125 |
| C | 324, 325, 221, 486, 211, 213, 33661, 4883 (refining / chemical, power / utilities, pipeline, oil & gas, shipyard / marine) | 34,570 |
| D | all of the above, `person_locations` limited to states absent or thin in Phase 5 (CT, MA, NH, VT, ME, RI, DE, NE, SD, MT, ID, NV, WA, NJ, MD, NM, WV) | 7,067 |

Run D first (least overlap with Phase 5), then C and B, then A from page 1.
Variants allowed later, still inside the ICP: equivalent title spellings
(e.g. "plant mgr", "hr business partner", "maintenance supervisor"), single
craft titles per query to surface different employers, and the employee-range
filter for owner/executive titles at small and mid companies.
