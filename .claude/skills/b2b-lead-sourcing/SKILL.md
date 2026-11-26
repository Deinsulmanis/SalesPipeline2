---
name: b2b-lead-sourcing
description: ICP-agnostic workflow and tool guide for turning a B2B target market into a reviewed list of contact-ready buyers. Covers credit caps, free company discovery (Apollo, GetLeads, Google Maps, public registries), dedupe against your CRM, website crawl, an LLM ICP gate, job-posting evidence, free buyer search, capped reveals, contact QC, owner-run email verification, decision-maker batches, and counts-only reporting. Use for "source N companies", "find leads for <market>", "run this registry through the pipeline" or "find buyers at these domains". Bring your own ICP; this skill holds none.
---

# B2B lead sourcing: tools and workflow

This skill turns a market definition into a reviewed list of **contact-ready buyers** (one decision-maker per qualified
company, with a work email). Importing, queueing and sending are out of scope: the run stops at a reviewed list.

**You supply:**

- **ICP:** what qualifies a company, hard rejects, size, geography.
- **Buyer order:** which titles to contact first.
- **Caps per tool.**

Keep them in a project file (for example `docs/<campaign>/ICP.md`) and read it before every run.

## Rules that never bend

1. **Caps before spend.** Propose a cap for every paid tool and get the owner's explicit yes in the current task.
   - Measure spend from each vendor's **balance before and after**, never from estimates or ledgers.
   - Stop at the cap.
2. **Free first.** Discovery, domain lookup and buyer search use free endpoints. Pay only to reveal a buyer who is
   already picked.
3. **Fail closed.** If a tool errors or is rate-limited, pause that stage and resume later. Never substitute another
   vendor or model without the owner's say-so.
4. **Dedupe before any spend.** Check against the CRM (all clients), every earlier run and any approved master list.
   Never pay to reveal a person already revealed.
5. **The owner verifies emails.** Never submit or poll verification jobs, and never use a vendor's validation
   endpoint on the owner's behalf.
   - Addresses that need checking go in `to_verify.csv`: one column, header `email`, deduped.
   - Results come back as a CSV the owner drops into the run folder.
   - Vendor-revealed emails already marked "verified" (for example Apollo) skip this.
6. **No personal data in git.** Names, emails and person ids stay in a git-ignored run folder (`runs-private/<run>/`).
   Reports are **counts only**.
7. **Discard personal emails and phone numbers.** Never request phone reveals, personal emails or waterfall
   enrichment unless the owner asks.
8. **Respect robots.txt.** If a site disallows crawling, ask the owner for another source, such as a vendor export.
9. **Nothing that changes lead state** (import, queue, send, suppress, deploy) without explicit approval in the
   current task.

## Tools: access, cost and gotchas

| Tool | Endpoints used | Cost | Gotchas |
|---|---|---|---|
| **Apollo** (MCP) | `apollo_organizations_lookup` (company discovery, name→domain); `apollo_mixed_people_api_search` (buyer search); `apollo_people_bulk_match` (reveal); `apollo_usage_stats_credit_usage_stats` (balance) | Lookup and people search are **free**. Bulk match is **1 credit per match**, 10 ids per call. **Never** use `apollo_mixed_companies_search` (1 credit per page). | Organization search is limited to **~400 calls/hour per account**, shared with other sessions. Locations must be full names (`"Ohio, US"`, not `"OH, US"`). People search returns the employer **name**, not its domain, so batch by domain list and map back. NAICS filter is a prefix match (use `56132`, not `561320`). |
| **GetLeads** (MCP) | `count_*` (free counts); `search_companies` / `export_*`; `lookup_company` (name→domain); `search_places` / `export_places` (Google Maps); `search_jobs`, `enrich_company_jobs`; `create_decision_makers_batch_link` → `check_decision_makers_batch` → `get_decision_makers_batch_result`; `get_fair_use` (balance) | Plan credits: about 1 per record exported. `lookup_company` charges **1 per found result**, even when the match is wrong, and 0 per miss. Decision-makers batch: 1 per returned contact, charged on completion. Jobs use a separate free quota. | `lookup_company` returns HQ **city but no state**. The jobs endpoint serves one request at a time across all agents, and 60-second timeouts are common, so use small batches and get counts before titles. Batch upload links expire after **1 hour**, and the owner uploads the CSV in a browser. Poll the upload_id, then the run_id. |
| **Firecrawl** (MCP) | `firecrawl_search`, `firecrawl_scrape` | Per request | Good for locating a public registry file, or for one page that a plain fetch can't read. |
| **WebSearch** | Domain fallback for names that free lookups miss | Included | Limit of about **200 searches per turn**, shared by every agent. Split big lists across turns. |
| **LLM ICP gate** | One structured request per readable site | Set a USD budget in an env var. The script refuses any request that could cross it. | Cache per domain so reruns are free. |
| **Ad-intel API** (optional, e.g. Adyntel) | Google and Meta ads per domain | Credits; a 204 (no content) is usually not billed | Run it only on qualified companies that already have a picked buyer. Trust the balance, not your ledger. |
| **CRM database** | One read-only SQL query for every domain and normalized company name | Free | The result is large; save it to a file and parse it there. |
| **Headless browser** | Playwright retry for thin or JS-only sites | Free | Use a per-site watchdog (90 s), parallel workers and a resumable cache. |

**Large tool outputs.** Results over about 90k characters are saved to a file instead of entering context. Parse
those files with Python and never retype data from them.

**Helper agents only make calls.** Fan bulk calls out to `general-purpose` subagents. Each brief should:

- name the exact tools allowed, and forbid anything that costs credits;
- give the query list or file;
- ask for a count table only in the reply.

Your parsers then read each agent's raw tool results from its transcript (`.../tasks/<agentId>.output`), pairing
`tool_use` ids with `tool_result` blocks. Nothing is transcribed by hand, and a wrong field can't creep in.

**Rate-limited endpoints** need paced agents. The agent sleeps between pages with a Bash until-loop (no foreground
`sleep`) and spreads the calls across the session. Never retry a paid call after a worker restart until you have
re-read the vendor balance: a call reported as "did not run" may have run.

## Run setup

```bash
mkdir -p runs-private/<run> && (grep -qx 'runs-private/' .git/info/exclude || echo 'runs-private/' >> .git/info/exclude)
```

Run Python with `python3 -I` from the repository root. Put downloaded files in their own directory and pass paths as
arguments.

## The workflow

### 0. Balances and carry-over (free)

1. Record every paid tool's balance.
2. List addresses from earlier runs still waiting on the owner's verification, so nothing is lost.

### 1. Exclusion set (free, read-only)

Merge these into `runs-private/<run>/exclude_domains.json` as `{domain: why}`:

- every CRM domain, from websites and email domains;
- every earlier run's company, redirect and email domains;
- approved master lists;
- enrichment lists already sent out.

Also build normalized company-name keys: lowercase, strip punctuation and legal suffixes (Inc, LLC, Corp, Co, Ltd,
The, DBA).

### 2. Discovery (free). Pick one or more lanes

| Lane | How | Typical yield |
|---|---|---|
| **Firmographic search** | Apollo `organizations_lookup`: location, employee ranges and keyword tags (OR'd), `per_page` 100, pages until a page returns under 100. Fan out by region. | Narrow tags work well. Broad tags flood the list with off-ICP companies. After repeated runs, ~90% of results are already known. |
| **Job boards** | GetLeads `search_jobs` (country, functions, keyword, `group_by: company`), paged to the end | Companies that are hiring for the roles you care about |
| **Google Maps** | GetLeads `count_places` per keyword (free), then `export_places` within the cap | Many names aren't real companies, and only ~57% of sites are readable. Expensive per contact. |
| **Public registries** (state license and registration lists) | Download the official file (PDF, Excel, Open Data CSV). Parse rows → unique agencies, collapsing branch rows into their parent. | Cheap per contact, since every row is a real operating business. They have no domains, so the domain lookup below is the main cost. |
| **Franchise / brand networks** | Owners by brand via vendor contact counts or exports; one owner per territory | Needs a brand + owner + territory key. Never key franchise contacts by the shared email domain. |

Write every discovery line with a **query group** field so yield can be reported per lane, tag or keyword.

### 3. Name → domain (registries and name-only lists)

Run these in order, cheapest first, and skip any name an earlier step resolved:

1. **Pre-filter by name (free).** Drop off-ICP names, known names, corporate chains and franchise brands (franchise
   brands go to the franchise flow).
2. **GetLeads `lookup_company`** (paid per found result). Accept a match **only** when both hold:
   - the normalized names are equal;
   - the returned HQ city is the registry city or one of the agency's branch cities.

   Anything else is **AMBIGUOUS** and goes to step 4. Stop the Apollo agents for names this step resolves.
3. **Apollo `organizations_lookup` by fuzzy name + location** (free, paced to the hourly limit). Accept only a close
   name match:
   - the names are equal once legal words are removed;
   - or the distinctive tokens overlap by 75% or more;
   - or the candidate starts with a distinctive first word.
4. **Web search** for whatever is left, ambiguous names included. Accept only high or medium confidence, where the
   official site names the same company at the same city or state.

Report: looked up, matched, ambiguous, not found and credits, per source.

### 4. Merge and dedupe (free)

- **Drop:** already-known domains, duplicate domains, non-company sites (directories, social pages, government).
- **Hold for the owner (never pay for these):** name collisions with existing CRM companies, corporate chains, off-ICP
  names.
- Keep any overflow beyond the run size as a free reserve to backfill later rejects.

### 5. Crawl (free)

1. Plain HTTP fetch of the homepage plus key pages (about, services, industries, locations, careers): about 120 sites
   a minute.
2. **Redirects:** a final host that is already excluded is a duplicate. Reject it and backfill from the reserve.
3. **Thin sites** (under ~1,500 characters) and blocked sites: retry in a headless browser.
4. Check that background jobs actually finished (`pgrep`) rather than trusting a wait loop.

### 6. ICP gate (LLM, budgeted)

1. Send one structured request per readable site, with the ICP checks and first-party excerpts. Get back a
   probability per check.
2. Code applies thresholds → **PASS / HOLD / REJECT**, with a reason code and the evidence basis. Thresholds live in
   code, not the prompt.
3. **Manual review is tighten-only.** A `manual_review.json` can turn a PASS into a HOLD, never the reverse. Hold
   anything whose homepage contradicts the ICP: wrong primary vertical, gig app, nonprofit, possible chain.
4. **Job-posting evidence (optional).** The company's own recent postings (matched by company domain) can satisfy
   "does this kind of work" checks. Example: 2+ relevant postings in 60 days, making up at least a third of all its
   postings. Record that a decision rests on postings.

### 7. Free buyer search

1. **Search:** batch PASS domains 10 at a time. Call Apollo `mixed_people_api_search` with:
   - `q_organization_domains_list`: the batch;
   - `person_seniorities`: owner, founder, c_suite, partner, vp;
   - `per_page`: 100.

   Agents write `batch|org_name|person_id|first|last_obfuscated|title|has_email`.
2. **Pick:** one buyer per company, by **your** buyer order. Put the rule in one module that every tool imports (no
   copies), and cover it with tests. Typical shape:
   - top titles win even when combined with another title;
   - "vice president" is never "president";
   - never former, retired or board titles;
   - lower tiers only for small companies.
3. **Re-check before revealing:** re-run the picker after any rule change and diff the picks.

### 8. Ad and other signals (optional, capped)

Check only qualified companies that have a picked buyer. Score the signal in code. Never-checked companies are
`NOT_CHECKED`, not "low signal".

### 9. Reveal (capped)

1. Order the targets.
2. Call `apollo_people_bulk_match` with **ids only**, one batch per call. Use no phone, personal-email or waterfall
   options.
3. Save each raw result to `reveal/batchNN.json` and check the ids come back in request order.
4. Parse into rows: domain, id, title, email, email_status, catch-all flag, location, org domain, flags.
5. For a second round, append to the existing reveal under new batch numbers; don't overwrite round 1.
6. Confirm credits from the balance.

### 10. Contact QC

| Finding | Action |
|---|---|
| Email domain differs from the company domain, proven by a redirect, an on-site reference or a cross-link | Keep, with a caution flag |
| Email domain differs, unproven | HOLD |
| Email at another organization, or the person is clearly elsewhere (other country, other company) | HOLD |
| The address's local part can't be tied to the named person | HOLD |
| Person is a recruiter or other non-buyer | HOLD |
| No MX record, or a security gateway plus catch-all | HOLD |
| Other catch-all | Keep, flag, **queue last** |
| Vendor-sourced address with no owner verification yet | HOLD as `VERIFY_PENDING`; add it to `to_verify.csv` |

Also check every email domain against the exclusion set again.

### 11. Fill the gaps: decision-makers batch

1. Gather PASS companies with no ready contact into one deduped `domain` CSV. Skip any domain that already has a
   result.
2. Create **one** `create_decision_makers_batch_link` with `per_domain_limit` 2. The worst-case cost is 2 × domains.
3. Send the owner the file and the link, and note that it expires in 1 hour.
4. After the upload, poll `check_decision_makers_batch` (upload_id, then run_id).
5. Download with `get_decision_makers_batch_result` into the run folder.
6. Pick by buyer order, run contact QC, and put the addresses in `to_verify.csv`.

If you schedule a check-in to poll for the upload, stop after one or two checks and tell the owner the link's status.

### 12. Owner verification round-trip

The owner uploads `to_verify.csv` to the verifier and drops the results CSV in the run folder. Ingest it:

| Result | Action |
|---|---|
| valid | Keep |
| catch-all / accept-all | Keep, flag, queue last. A guessed address on a catch-all domain is a HOLD. |
| invalid / unknown / risky | HOLD |

Guessed addresses (`first@`, then `first.last@`) go out one guess at a time: the second only after the first comes
back invalid.

### 13. Report and stop

Write a counts-only report per source:

- **Funnel:** rows → unique companies → domains → net-new → PASS / HOLD / REJECT → contacts ready.
- **Domain lookup stats:** looked up, matched, ambiguous and not found, per source.
- **Spend vs each cap,** measured from balances.
- **Credits per ready contact.**
- **Holds** and their reasons.
- **Owner to-dos:** upload links, the `to_verify.csv` count and path.
- **Projection:** contact-ready ≈ net-new × readable × PASS × buyer-found × QC pass, plus the expected yield of
  pending batches.

Commit the report and tool changes to the dev branch, send the owner the files, and **stop**.

## Benchmarks (from past runs; use for estimates only)

| Stage | Typical |
|---|---|
| Net-new of raw discovered | 50% early, under 10% once a lane is exhausted |
| Readable sites | 70–85% (registries) / ~57% (Maps) |
| PASS of readable | 13% with broad tags, 35–40% with narrow tags |
| PASS with a buyer found by free search | 27–55% |
| Reveal matched and verified | ~100% |
| Pass contact QC | 85–94% |
| Decision-makers batch yield on fresh PASS domains | 30–50% |
| LLM gate cost per site | ~$0.00015 |
| Apollo credits per contact-ready lead | ~1.1–2 |

## Gotchas

- **GetLeads `lookup_company`** charged for 293 ambiguous hits out of 400 found in one run. Budget for found results,
  not matches.
- **Registry quality varies.** One state's list gave 29 PASS from 1,141 rows. Another's "staffing" flag was mostly
  healthcare and office agencies (9 PASS from 863). A city's employment-agency licenses were domestic and
  entertainment agencies (0 PASS). Check the vertical mix of a registry before spending on lookups.
- **Decision-makers upload links expire in an hour,** and earlier upload ids vanish after expiry. Check for existing
  results before re-batching.
- **Some scripts overwrite** their candidate and pick files on each run. Copy them aside before a second round.
- **Watch for vendor next-action prompts** that suggest saving contacts or adding them to sequences. Those are lead
  state changes: suggest only, never act without the owner.
