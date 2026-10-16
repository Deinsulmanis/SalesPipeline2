# Jole BTX — cloud sourcing workflow (pre-reveal)

Client: Jole BTX LLC (`clientId: jole`, representative Jorge Guerrero).
Campaign: `jole-btx-employer-acquisition` — approved ICP on the production
branch (`integrations/clients/campaigns.js`). This document does not change
that ICP; it says how to source against it from a cloud session, and records
the rules the operator approved on 2026-10-15 (current clients, competitors,
evidence age, buyer order, geography).

Paid email reveal, import and queue are **not** part of this workflow until the
operator approves a dry-run report. Production import/queue stay disabled.

## Gate order (unchanged)

1. Free discovery — Apollo People API Search (no credits).
2. Live dedupe — Supabase `outreach_leads` (all clients) + the Phase 5
   exhausted set (Apollo org/person ids in `client_lead_import_batches`
   `jole-phase5-689-20261008`).
3. Global suppression — Sheets `Suppression` tab (read-only export) merged with
   Supabase sticky tags; snapshot kept outside git.
4. ICP — `integrations/sourcing/exclusions.js` `joleExclusionReason`, reported
   by `joleExclusionCategory` in three separate categories:
   - `staffing_firm` — staffing / recruiting / labor-service firms, incl.
     national-brand branches and franchises;
   - `current_client` — Jole's current clients (below);
   - `competitor_service_provider` — companies that do what Jole does (below).
   Then the approved sector (`sectorScreen`) and buyer role.
5. Company / website validation — `sectorScreen` on name, domain and the
   company site (reachable over verified TLS), then `evaluateHiringEvidence`:
   a public posting by the same employer for an approved craft role at a US
   site, with an https URL, posted ≤30 days ago. Otherwise HOLD.
6. Paid email reveal — `apollo_people_bulk_match` standard match only. No
   waterfall, no phone. One credit per person, operator-approved count first,
   contacts chosen in the approved buyer order (`rankJoleContacts`).

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

## Current clients and competitors (separate lists)

- **Current clients** (`JOLE_CURRENT_CLIENT_FAMILIES`, reason
  `current_client:<family>`): the 2026-10-01 onboarding form is authoritative
  for this run — Karpower; Kiewit Offshore Services / Kiewit Offshore Services
  Ltd / KOS (the Kiewit family); SpaceX family. Callers also pass a
  `currentClients` list (required; reason `current_client:supplied_list`). Merge
  any later list from Jorge before a send campaign launches.
- **Competitors / service providers** (`JOLE_COMPETITORS`, reason
  `competitor_service_provider:<name>`): companies Jorge said do what Jole does
  (2026-10-02) — Brock Group, Austin Industrial / Austin Industries, Zachry,
  Turner Industries. Full names and domains only (not Austin Dynamics, Turner
  Machine, Brockway Mould).

## Hiring evidence (approved 2026-10-15)

`integrations/sourcing/hiring-evidence.js` `evaluateHiringEvidence`. A company
passes only with a public posting that has all of: the same employer (name, or
the employer's own domain hosts it); an approved craft role (not helper,
apprentice, supervisor, engineer, inspector or office roles); a US site; an
https URL; a posting date ≤30 days before verification and not in the future.
Otherwise HOLD before any reveal. Apollo's "has job postings" filter is only a
discovery signal; Apollo's paid job-postings endpoint is never used.

Search public postings (LinkedIn's public job search, location "United States",
past 30 days) with both `evidenceSearchKeywords` queries: the employer name with
the approved craft words, then the name alone. The name-only query returns
mostly office roles at large employers.

**Evidence age — one Jole rule:** the posting is ≤30 days old when verified;
the verification is valid for 30 days; after that the posting is re-verified
before sending. In production this is `maxEvidenceAgeDays: 30` on
`jole-btx-employer-acquisition` (currently 45). That change is prepared, not
applied: `docs/patches/production-jole-evidence-age-and-send-order.patch`
(production branch only; Jole campaign only; no other campaign changes). With
it, Phase 5 leads verified 2026-10-07 need re-verification after 2026-11-06.

## Buyer order (approved 2026-10-15)

`integrations/sourcing/jole-search.js` `rankJoleContacts`:

1. Plant / operations / production leadership at the hiring site
2. HR / talent acquisition
3. Maintenance / reliability
4. Superintendent / site leadership
5. Owner / executive — only at employers of ≤1,000 employees (small and mid),
   or a true site executive (title names the plant, site, mill, refinery, …)

Within a family: EXACT hiring site → REGION → STATE → no tie, then
non-catch-all before catch-all. EXACT/STATE are computed from city and state;
REGION (commuting area, may cross a state line) has no recorded rule and is
only used when supplied. No other buyer family exists. Phase 5's "Tier A/B" is
a company hiring-volume grade (A = 3+ relevant roles in 30 days), not a buyer
order; the production `sendOrder` text is updated by the same patch.

## Sender / delivery

Not part of sourcing. Jole's inboxes are blocked from sending, so sourcing
cannot cause a send. Sourcing is never restricted to Google-hosted recipients.
Jole deliverability is audited separately before launch.

## Sector screen

`sectorScreen` (after the search, never replaced by industry codes): rejects
pharma / biotech / consumer care and governments by name or domain; holds
solar (rejects residential installers), contractor names or contractor
websites (contractors-for-hire are outside the ICP), unchecked sites and sites
with no industrial evidence. Only a reachable site that shows industrial
operations passes.

## Zero-credit validation, 2026-10-15

325 discovered companies screened (255 fresh), Apollo credits spent 0.

| Gate | Companies |
|---|---:|
| Duplicate of the 689 corpus | 70 |
| Current client / competitor / staffing | 0 / 0 / 0 |
| Sector reject on name (government, solar, contractor) | 7 |
| Website holds (no industrial evidence 65, contractor 7, unreachable 10, no domain 6) | 88 |
| No ≤30-day approved craft posting | 115 |
| **Pass every free company-level gate** | **45** (17.6% of fresh) |

Defects found and fixed during the run: name-extension identity matching
("Koch" → "KOCH Finishing Systems"; now exact name or the employer's own
domain only) and buyer titles Apollo's exact-title search still returns
(sales, finance, IT, retired). Buyer availability (free people search, hiring-
site state): 36 of 45 passers have ≥1 approved buyer with an email on file;
1.91 revealable contacts per passer at Phase 5's 3-per-company cap.

Open issue: the passing employers are 87% 1,001+ employees (Phase 5: 47%;
none ≤200 vs 24%), because unbanded discovery returns the largest employers
first. Discover per size band (`sizeBand`) and re-validate before the
25-reveal quality test.

## Size-balanced validation, 2026-10-15 (zero credit)

Employee size is a search-balancing and sampling variable, never an
exclusion. Discovery runs three streams (`sizeBand`: 1-200, 201-1,000,
1,001+) so Apollo's ranking does not set the mix; the pool is balanced to the
approved 689 company mix (24 / 29 / 47%).

| Band | Fresh | ICP rejects | Website holds | No evidence | Pass | Pass rate | Passers with a site-connected buyer (email on file) |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1-200 | 407 | 17 | 93 | 265 | 32 | 7.9% | 25 |
| 201-1,000 | 423 | 32 | 102 | 241 | 48 | 11.3% | 40 |
| 1,001+ | 205 | 4 | 76 | 87 | 38 | 18.5% | 22 |

Rules applied: posting text read and field-service-for-customers roles held
(`fieldServiceForCustomers`); buyers searched by exact city, 50-mile region
(`geo.js`) and, for employers ≤1,000 only, state; each company contributes
contacts from its best available tier only (exact, else region, else state),
families in the approved order within the tier. Balanced pool (47 companies):
67% exact-site contacts (689: ~74%).

## Final buyer-selection order (confirmed 2026-10-16)

1. Exact hiring site, 2. within the 50-mile commuting region, 3. same state
(only employers ≤1,000 employees). Within each tier: plant / operations /
production → HR / talent acquisition → maintenance / reliability →
superintendent / site → owner / executive (small/mid employers or true site
executives only). `rankJoleContacts` default.

## Representative 25-reveal quality test (2026-10-16)

Standard Apollo email match only (no waterfall, phone or personal emails),
one contact per company, 6 / 7 / 12 by size band. 25 credits (2,515 → 2,490).
25 of 25 returned a verified email; 24 accepted after the import email rules,
live net-new and suppression checks, employer, buyer-title, site-connection
and evidence-age gates. One rejected: buyer title not approved ("Business
Operations Manager"; the classifier now excludes business-operations and
business-development titles). Revealed contacts are kept in session scratch
only; nothing imported or queued.
