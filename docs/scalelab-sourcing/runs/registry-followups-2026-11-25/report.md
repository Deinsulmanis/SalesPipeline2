# Registry follow-ups: Illinois gaps, Massachusetts, NYC (2026-11-25): counts only

ScaleLab only. **Nothing imported or queued.** This report contains no names or email addresses.

Illinois source and method: [../il-registry-2026-11-25/report.md](../il-registry-2026-11-25/report.md).

**Sources:**

- **Massachusetts:** DLS licensed employment, placement and staffing agencies (.xls, updated 2026-11-16). Only rows
  flagged staffing were kept.
- **NYC:** DCWP Issued Licenses on NYC Open Data, business category Employment Agency, active licenses only.

## Funnel per registry

| Stage | Illinois | Massachusetts | NYC |
|---|---|---|---|
| Registry rows | 1,141 | 1,192 (863 flagged staffing, which includes 142 branch rows) | 365 (248 active) |
| Unique agencies | 470 | 720 | 247 |
| Dropped by name before lookup: off-ICP / already known / corporate chain / franchise flow | 8 / – / 16 / 18 | 208 / 43 / 27 / 4 | 71 / – / – / 1 |
| **Domains found** | **242** (Apollo 186, web 54, GetLeads 2) | **160** (GetLeads 87, web 38, Apollo 35) | **31** (GetLeads 18, Apollo 10, web 3) |
| No domain | 194 | 278 | 144 |
| Already known (production all clients, every run, V4 master) | 128 | 76 | 2 |
| **Net-new** | **98** (was 86) | **82** | **29** |
| **PASS / HOLD / REJECT** | **29** / 54 / 15 | **9** / 37 / 36 | **0** / 19 / 10 |
| PASS via job postings | 2 | 0 | 0 |
| **Contacts ready now** (Apollo reveal + QC) | **8** (5 verified, 3 catch-all) | **2** (1 verified, 1 catch-all) | 0 |
| Held at QC | 0 | 2 (see below) | – |
| PASS with no ready contact → decision-makers batch | 21 (batch 1: 19 already sent + batch 2: 2) | 7 | – |

Notes:

- **Illinois.** Closing the gaps added 28 domains and 12 net-new, but no new PASS. All 12 new net-new were HOLD or
  REJECT; 4 were held by hand as IT-primary or an on-demand app (playbook).
- **Massachusetts QC holds:**
  - The UK-based owner of a UK parent company: the email domain is the UK site, and the buyer is outside the US. The
    domain goes to the decision-makers batch to find a US contact instead.
  - One email whose local part uses initials and doesn't match the buyer's name, so QC can't confirm it belongs to
    them. Held, fail closed; the domain also goes to the batch.
- **NYC.** The active licenses are mostly domestic, home-care, entertainment and executive-search agencies. Of the 29
  net-new, none showed an industrial or skilled-trades line on its own site, so nothing passed.

## GetLeads `lookup_company` (domain lookups)

Match rule: a normalised name match plus the HQ city matching the registry city or a branch city. Anything else was
marked AMBIGUOUS and went to web search.

| | Illinois | Massachusetts | NYC | Total |
|---|---|---|---|---|
| Looked up | 193 | 395 | 171 | **759** |
| Matched | 2 | 87 | 18 | **107** |
| Ambiguous | 78 | 162 | 53 | **293** |
| Not found | 113 | 146 | 100 | **359** |
| Credits (1 per company found, ambiguous included) | 80 | 249 | 71 | **400** |

The 293 ambiguous results went to web search; 41 of them were resolved there at high or medium confidence. The paced
free Apollo lookups ran alongside the GetLeads lookups, and any agency GetLeads resolved was skipped by Apollo.

## Spend this task

| | Illinois | Massachusetts | NYC | Total | Cap |
|---|---|---|---|---|---|
| GetLeads lookups | 80 | 249 | 71 | 400 (+1 test) | 700 for lookups |
| Apollo reveals | 12 | 4 | 0 | 16 | IL 12 / MA 60 |
| Jev | $0.012 | $0.011 | $0.002 | $0.025 | $0.10 |
| GetLeads decision-makers batch | 0 so far | 0 so far | – | at most 18 when you upload (2 per domain × 9 domains) | 400 |

**Credits per contact ready now:**

| Registry | Apollo credits per contact | GetLeads lookup credits per contact |
|---|---|---|
| Illinois | 1.5 | 10 |
| Massachusetts | 2 | about 125 |
| NYC | – (no contacts) | – (71 credits spent, no contacts) |

## Projection

- **Ready now:** 10 buyer-ready contacts: Illinois 8, Massachusetts 2.
- **From the decision-makers batches:** at the usual 30–50% yield on 28 domains, roughly 8–14 more. Those addresses
  need your verification first.
- **Total for the three registries:** about **18–24 contacts**.
- **Yield by registry:**
  - Illinois is the most productive (29 PASS from 1,141 rows).
  - Massachusetts is much thinner: its staffing flag includes many healthcare, office and executive agencies.
  - NYC adds nothing for this ICP.

## STOP: next steps need the owner

1. **Illinois batch 2:** upload `runs-private/il-registry-2026-11-25/pass_domains_batch2.csv` (2 domains) at
   decision-makers link 01M8A3JFRZR8KJFVZZXN85EZK0, max 2 per domain.
2. **Massachusetts:** upload `runs-private/ma-registry-2026-11-25/pass_domains.csv` (7 domains) at decision-makers
   link 01M8A3JG21FKX6CS1H9E3Z87YW, max 2 per domain.
3. Both links expire at 20:40 UTC. A new link can be made at any time.
4. Verify the returned addresses. The 3 Illinois catch-alls and the 1 Massachusetts catch-all queue last.
5. No import, queue or send until you approve.
