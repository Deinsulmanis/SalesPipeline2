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
5. Company / website validation — `sectorScreen` on name, domain and the
   company site (reachable over verified TLS), then `evaluateHiringEvidence`:
   a public posting by the same employer for an approved craft role at a US
   site, with an https URL, posted ≤30 days ago. Otherwise HOLD.
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

## Free search filters (`integrations/sourcing/jole-search.js`)

Apollo industry codes only find candidates; they are never proof of ICP fit.

| Sector (ICP label) | NAICS used for discovery |
|---|---|
| Industrial fabrication / machinery | 332, 333 |
| Metals / mining / paper / heavy industrial | 331, 212, 322, 327 |
| Refining / petrochemical / LNG / chemical | 324, 3251, 3252, 3253, 3255, 3259 (never 325, 3254 pharma, 3256 consumer care) |
| Power / utilities | 2211, 2212, 2213 (never the 221 umbrella) |
| Shipyard / marine | 33661 (4883 port/stevedoring not used) |
| Pipeline / midstream | 486 |
| Oil & gas producers / operators | 211 (213 oilfield-service contractors not used) |

- Search-time exclusions are staffing only: SIC 7361/7363, NAICS 5613.
  Excluding 23, 2131, 3254, 3256 or 92 at search time removed 12 of the 339
  organizations behind the approved 689, so those are screened after the search.
- Geography is the hiring site: `organization_job_locations: ["United States"]`
  and `organization_job_posted_at_range` = trailing 30 days. Headquarters and
  contact location do not define the ICP; contact location only orders contacts.
  The earlier under-covered-state slice is removed.
- Buyer families: five approved roles, exact titles, `include_similar_titles: false`.

## Post-search screens

- `joleExclusionReason`: staffing/national brands, SpaceX, Kiewit/KOS, Karpower,
  Jorge's named competitors (Brock Group, Austin Industrial/Industries, Zachry,
  Turner Industries; full names/domains only), and the current-client list
  (onboarding form 2026-10-01: Karpower, Kiewit Offshore Services, SpaceX —
  operator must confirm it is current before a paid run).
- `sectorScreen`: rejects pharma/biotech/consumer care and governments; holds
  solar, contractor names/sites, unchecked sites and sites without industrial
  evidence.
- `evaluateHiringEvidence`: Apollo's "has postings" signal and its paid
  job-postings endpoint are never used. Search public postings with both
  `evidenceSearchKeywords` queries (name only, then name + craft words; the
  name-only query misses craft roles at large employers).

## Open decisions (not changed in production)

- Evidence age: ICP admission is ≤30 days; production `maxEvidenceAgeDays` is 45
  (age of `verifiedAt` at send). Recommendation: one 30-day rule — posting ≤30
  days at verification, re-verify once `verifiedAt` is older than 30 days.
- Buyer priority: no written Tier A/B buyer definition exists (Phase 5 A/B is a
  hiring-volume grade). Proposed order for approval: plant/operations at the
  hiring site → HR/talent acquisition → maintenance/reliability →
  superintendent/site → owner/executive (small/mid only); within a family,
  exact site → region → state, non-catch-all before catch-all.
- Delivery: production currently runs with the recipient-provider rule off,
  all senders pooled and sender holds lifted (set by Railway variables, not
  recorded). Recommended before Jole sends: placement tests from Jole inboxes
  to Microsoft/Gmail/gateway seeds, 8–10/inbox/day start, restore holds on
  SURBL-listed domains, and a per-client provider policy.
