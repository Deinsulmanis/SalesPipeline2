# Franchise locations in the ICP (owner decision 2026-11-25)

Counts only. No names, emails or companies. Private data: `runs-private/franchise-2026-11-25/`.
**Nothing was imported, queued, sent or deployed.** The production change sits on a local branch, unpushed (patch in this folder).

## 1. Rule (one source of truth)

`tools/franchise_rule.py`. Every tool imports it; none keeps a copy. Tests: `tools/test_franchise_rule.py` (11, pass).

- **Franchise brands** (independently owned, industrial-capable): Express Employment Professionals, PrideStaff, Spherion,
  Snelling, Labor Finders, HireQuest Direct, Trojan Labor, Link Staffing, Remedy Intelligent Staffing.
  - A location is ICP-eligible when its own page or postings show industrial roles (the job-posting rule).
  - Office-only locations are HOLD.
- **Corporate chains stay excluded:** PeopleReady, Aerotek, Kelly, Adecco, Manpower-branded offices, Staffmark,
  Robert Half, Randstad and the rest of the old list.
  - "Manpower" now matches only the brand itself, not independent firms with the word in their name.
- **Franchisor HQ is never contacted.** That covers HQ titles and headlines, franchise sales and development roles,
  past/interim/VP roles, the franchisor's HQ city without owner evidence, and franchisor sites such as the franchising domain.
- **Identity:**
  - Contacts are keyed by brand + owner, with the territory (office city + state) recorded.
  - They are never keyed by the shared email domain.
  - One contact per owner, and one owner per office.
- **Rewired to the rule:**
  - discover_merge, enrich_lists, enrich_lists4 and second_buyer_pool use `fr.chain_block`.
  - icp_decide no longer holds a recognised franchise brand on Jev's chain signal, and excludes corporate chains by name.

## 2. Sourcing: GetLeads search_contacts

Filters: US, VALID email, titles Owner / Franchise Owner / Co-Owner / President. Vice president, assistant, product owner
and former titles were excluded in the query.

**Cost: 735 plan credits** (balance 8,103 → 7,368; cap 900).

Free counts first, then the export. By email domain where the brand has one, else by company name:

| Brand | Exported rows | Unique people | Owners after HQ / role filter and dedupe |
|---|---|---|---|
| Express Employment Professionals | 594 | 544 | 517 |
| PrideStaff | 66 | 64 | 48 (+11 co-owners of the same office held) |
| Spherion | 52 | 50 | 42 (+6 same office held) |
| Labor Finders | 9 | 9 | 8 |
| Remedy Intelligent Staffing | 6 | 6 | 4 |
| Snelling | 5 | 2 brand (3 look-alike companies dropped) | 2 |
| HireQuest Direct | 2 | 2 | 2 |
| Link Staffing | 1 | 0 (a look-alike company, dropped) | 0 |
| Trojan Labor | 0 | 0 | 0 |

What the filters dropped or held, all brands:

- 6 franchisor HQ;
- 7 corporate or non-owner roles;
- 14 presidents with no owner or office evidence;
- 10 whose headline shows another business;
- 4 not the brand.

Production check: none of the people match an existing lead or suppression. The 3 brand leads already in production
are other people, and their owner keys are blocked.

## 3. Location ICP check (Express)

Each office's own job-openings page on the brand site was checked (free).

- **Job-posting rule:** 2+ hands-on industrial or trades postings in the last 60 days, at least 1/3 of the office's postings.
- **Offices checked:** 352. Of these, 202 are industrial, 102 office-only and 48 have no postings.

Express owners (517):

| Outcome | Owners |
|---|---|
| Office industrial, one owner kept per office | **148** |
| Co-owner of an office already kept (HOLD_SAME_OFFICE) | 120 |
| Office not found (owner's city has no office; likely lives in a suburb) | 112 |
| Office-only postings (HOLD) | 77 |
| No postings (HOLD) | 27 |
| City has several offices with different results (HOLD) | 33 |

Of the 148, **128 are ready pending verification**:

- 19 are held for copy: 10 office cities with no plain city name, 7 first names not usable, 2 with no recent hands-on posting;
- 1 shares a territory with another office.

**Other brands (106 owners): HOLD_LOCATION_UNCHECKED.** Their office pages were not crawled in this pass. They stay held,
as the brief holds everything beyond the Express test wave.

## 4. Copy

- **COPY_B (all 25 test-wave owners)** uses the office's own posting. The quote is built from the posting title and its
  city only. 17 of the 25 postings are in the office's own city; the rest are in nearby towns the office recruits for.
  Posting age is 1 to 20 days.
- **City line:** v2 COPY_C now has the franchise form "Saw your {{franchise_city}} office places {{specialty_line}}."
  - It is used when there is a quote-backed specialty line and no COPY_B posting.
  - A franchise lead never gets the brand-name fallback ("Saw <brand> focuses on ...").
- **Open copy decision for the owner.** The subject and closing still merge {{company}} = "Express Employment
  Professionals", e.g. "Employer accounts for Express Employment Professionals". A per-office name is possible but would be
  new copy, so it is left to the owner.
- Dry run with the new import code (pure, no production call), treating the addresses as verified:
  - wave: 25/25 accepted, all COPY_B;
  - all ready: 128/128 accepted.

## 5. Test wave and verification

| | Count |
|---|---|
| Express test wave (TEST_WAVE_1) | **25 owners, 25 offices, 25 states (one per state), all COPY_B** |
| Ready but held until the owner reviews the test wave's replies and bounces | 103 |
| to_verify.csv (GetLeads-sourced: VERIFY_PENDING, owner verifies) | 128 (includes the 25) |

## 6. Sending safety: per-domain throttle

The production change, tested, not deployed.

- **Cap:** `FRANCHISE_DOMAIN_DAILY_CAP = 10` successful sends per shared franchise domain per Vancouver day.
  - It applies across all 5 inboxes and every step (initial, follow-ups, sequence, booking, placement events).
- **Shared domains (11):**
  - expresspros.com, pridestaff.com, spherion.com, snelling.com, laborfinders.com;
  - hirequestdirect.com, hirequestllc.com, hirequest.com;
  - trojanlabor.com, linkstaffing.com, remedystaff.com.
- **Seed:** each run counts today's successful sends to those domains from the send ledger.
- **Slot:** taken inside `deliverOrdinaryColdStep`, after the client checks and before any Gmail probe or reservation.
  It is synchronous, so parallel sender lanes cannot overshoot. An attempt that defers keeps its slot for that run
  (conservative); the next run re-counts.
- **Fail closed:** with no throttle initialized, a franchise address is refused.
- **Interleave:** step-1 franchise leads are spread evenly through the sender assignment, not sent in one block.
- **Effect on the wave:** all 25 test-wave owners share expresspros.com, so step 1 takes at least 3 send days. Follow-ups
  count against the same 10/day.

## 7. Production change

Local branch `claude/franchise-icp-20261125`, on top of production `792b055`. Patch:
`production-franchise.patch`.

- **Import:**
  - A shared franchise domain is never deduped as one company.
  - It needs `owner_approved_franchise: true` and `row.franchise {brand, owner_key, territory, city}`.
  - The same owner or the same office (already in ScaleLab, or repeated in the batch) is refused.
- **Profile:**
  - Optional franchise fields, sealed into the digest only on franchise profiles.
  - Every existing profile keeps its exact fields and digest.
- **Copy, throttle and interleave** as above.
- **Tests:**
  - `test/staffing-franchise.test.js` (11, pass).
  - Full suite: 3,666 pass, 4 fail. The 4 are the existing DST/date-sensitive tests, unrelated.
- **Not deployed.** Deploying needs owner approval; follow the outreach-safety deploy runbook.

## 8. Re-check of earlier chain / franchise holds

35 holds (`tools/franchise_recheck.py`):

| Earlier run | Held | Stays excluded (corporate) | Franchisor HQ | Franchise owner flow (shared domain) | Franchise on own domain: needs location gate | No longer a chain match: needs normal gate |
|---|---|---|---|---|---|---|
| v4-3000 | 21 | 10 | 1 | 0 | 6 | 4 |
| jobs-discovery | 8 | 5 | 0 | 1 | 2 | 0 |
| second-buyer | 6 | 1 | 0 | 2 | 0 | 3 (1 also non-US) |

- **14 need a crawl + Jev gate** (8 franchise sites on their own domain, 6 no longer chain matches). That was not run here,
  because the brief set no Jev cap.
- Some own-domain Express sites may belong to owners already in this export. Owner-key dedupe applies when they are sourced.

## STOP

Stopped before import. Next steps need the owner:

1. Verify `to_verify.csv` (128) in GetLeads, then run ingest_verification.
2. Approve the production deploy of the franchise branch.
3. Decide the subject/closing company name.
4. Approve importing the 25-owner wave (send-ready, `owner_approved_franchise`) and queueing it interleaved.

---

# Round 2: owner decisions, 2026-11-25

## 1. Verification ingest

`verified_results.csv`, from the owner's GetLeads run:

- 128 checked: **120 valid, 8 invalid, 0 catch-all**.
- Rule: VALID → READY. Catch-all, unknown or invalid → HOLD.
- **All 25 test-wave owners came back VALID**, so the wave is unchanged and has no catch-alls.
- The 8 invalid were all among the held owners. Held after the test wave: **95** (was 103).

## 2. Production branch

- Pushed `claude/franchise-icp-20261125` at **`39697c3d676acf5336c5b928b8aafba435f8a2ca`**.
- It was rebased onto the new production head `39b9b53`: a fast-forward with no overlapping files.
- Not deployed from here. Handoff note: `deploy-handoff.md`. No dedicated deploy session was found, so the owner
  passes it on.

## 3. Franchise copy

Owner decision:

- Subject: "Employer accounts for your {city} office".
- Closing: "Worth a look for your {city} office?".
- The brand is never used as the company. A franchise lead gets only COPY_B or the COPY_C city line, and anything else
  is refused at render.

Role phrases are tidied while staying word-for-word parts of the posting title: no shift, level, temporary or senior
words, singular, single-role postings preferred.

Preview of the 25, rendered by the production renderer on the branch: 25/25 accepted in the dry evaluation,
0 validation problems, 0 brand mentions. The preview is private (has first names).

## 4. Website check on the old holds

- The approved 14 were checked; the 15th re-check row is non-US and stays excluded. Jev spent $0.0015 of the $0.05 cap.

| Outcome | Count |
|---|---|
| PASS | 4: 2 Express offices on their own domains, 1 earlier v4-3000 hold, 1 second-buyer company |
| Brand corporate site (now a shared brand domain: owners only, via the franchise flow) | 1 |
| REJECT (finance-only staffing) | 1 |
| HOLD | 8: 4 sites unreadable or dead, 2 with no industrial line, 1 US not corroborated, 1 Jev chain signal on a name that is not a recognised brand |

- The 2 Express own-domain PASS offices need owner sourcing through the franchise flow; owner-key dedupe applies.
- The second-buyer PASS company becomes eligible for the second-buyer process. Nothing was sourced for these here.

## 5. Import and queue

**Not done.** It waits for the deploy to be confirmed live. The wave is ready:

- 25 owners, VALID;
- COPY_B with the office subject and closing;
- `owner_approved_franchise` and send-ready on the import;
- queue interleaved under the 10/day expresspros.com throttle.

The other 95 ready Express owners and all other brands stay held until the owner reviews the wave in about 7 days.

---

# Round 3: deploy, import and queue (owner: "go ahead and deploy", 2026-11-25)

## Deploy

- `fix/send-throughput-20261020` was fast-forwarded `39b9b53` → **`39697c3`**.
- Railway is pinned to `39697c3`; the deployment finished with SUCCESS at 06:26 UTC (22:26 Pacific, outside the send
  window, with no outreach pass running).

Checks before the deploy:

- the live SHA equalled the production head, which equalled the branch base;
- clean tree;
- full suite 3,676 pass, 4 fail (the pre-existing date tests).

Checks after the deploy:

- Boot logs clean: all crons scheduled, send-lock enabled, staffing-shadow authority all false, no `[FATAL]`, cache
  snapshot built.
- `/api/send-lock/health` ok. Reservations: 0 sent-unconfirmed. 1 reconciliation_required row exists, but it is from
  2026-10-16: it predates this deploy and is operator-only.
- Capacity unchanged: ScaleLab 170/day, 25/run.
- Production dry-run import of the wave: 25/25 accepted, `franchiseLeads: 25`, all COPY_B.

## Import and queue

- Import: **25 written**, all COPY_B, send-ready, franchise identity sealed, 0 refused. Supabase shows 25 rows at
  expresspros.com in Campaign 3.
- Queue: **25 queued**, 0 refused. Auto inbox assignment: primary 8, deniels 6, zoe 4, merrick 4, dave 3.
- Campaign 3 now: **391 Queued**, 340 Contacted, 1 Done, 1 Unsub.
- Sending: all 25 share expresspros.com, so at most 10 sends to that domain per Pacific day across all inboxes
  (follow-ups count too). Step 1 for the wave spreads over at least 3 send days.
- First live proof is the next send window (weekdays 07:00–11:30 Pacific). Watch for `franchise domain
  expresspros.com reached 10 sends today` deferrals once the cap is hit.

## Still held (owner review in about 7 days)

- 95 ready Express owners;
- all other brands (106 owners, location check pending);
- the 19 copy holds and the 8 invalid addresses;
- the 4 old-hold PASS companies (not sourced).
