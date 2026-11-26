# Google Maps keyword pilot (GetLeads places, 2026-11-25): counts only

ScaleLab only. **No import or queue.**

## Filter

- US-wide, categories Staffing agency / Employment agency / Temp agency, `has_website = true`, one `business_name`
  keyword per count.
- The healthcare / IT `exclude_category_contains` filter changed **no** count. The category filter already limits rows
  to the three staffing categories, so there is nothing for it to remove. Off-ICP names are dropped at dedupe instead.

| Keyword | Free count | With exclusions | Known chain / franchise rows in it |
|---|---|---|---|
| workforce | 1,161 | 1,161 | 563 "workforce solutions" (mostly public job centers) |
| labor | 964 | 964 | 195 Labor Finders, 128 LaborMAX, 11 Labor Ready, 7 Labor Smart, 6 Trojan |
| manpower | 691 | 691 | mostly the Manpower brand |
| trades | 345 | 345 | 206 Tradesmen International |
| temps | 231 | 231 | |
| tradesmen | 216 | 216 | 206 Tradesmen International |
| industrial | 139 | 139 | |
| construction | 127 | 127 | |
| skilled | 118 | 118 | |
| warehouse | 7 | 7 | |
| welding | 2 | 2 | |

**Exported:** labor, industrial, construction, skilled, warehouse, welding = **1,357 rows**. That is the highest
industrial signal per credit under the 1,500 cap. Left out:

- temps: generic, often office temping;
- trades: 60% Tradesmen International;
- workforce: about half public job centers;
- manpower: mostly the chain.

The 300 rows sampled on 2026-11-24 are excluded at dedupe.

## Funnel per keyword

| Keyword | Exported | Unique domains | Franchise locations (held) | Corporate chain rows | Net-new | PASS | PASS rate | HOLD | REJECT | Contacts ready | To decision-makers batch | Projected contacts* |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| labor | 964 | 275 | 196 | 148 | 194 | 30 | 15% | 140 | 22 | 3 | 27 | ~11 |
| industrial | 139 | 85 | 0 | 0 | 58 | 7 | 12% | 42 | 9 | 0 | 7 | ~2 |
| construction | 127 | 67 | 0 | 22 | 45 | 5 | 11% | 30 | 10 | 0 | 5 | ~1-2 |
| skilled | 118 | 28 | 0 | 50 | 13 | 4 | 31% | 8 | 1 | 0 | 4 | ~1 |
| warehouse | 7 | 6 | 0 | 0 | 5 | 1 | 20% | 3 | 1 | 0 | 1 | ~0 |
| welding | 2 | 2 | 0 | 0 | 0 | 0 | - | 0 | 0 | 0 | 0 | 0 |
| **Total** | **1,357** | **463** | **196** | **220** | **315** | **47** | **15%** | **223** | **43** | **3** | **44** | **~16** |

\* Projected contacts = ready contacts + 30% of batch domains. The 30% is the decision-maker yield seen on fresh PASS
domains (25-35% contact-ready after the buyer rule and QC).

### Notes on the funnel

- **Unique domains** count each domain once, in the first keyword it appeared in. Rows also removed before net-new:
  - duplicate locations of the same domain (413);
  - no company website (59);
  - already known (144: production for all clients, every run, the V4 master, enrichment lists, the 2026-11-24 sample);
  - off-ICP names (4).
- **Franchise locations** (190 Labor Finders, 5 Trojan Labor, 1 HireQuest) are keyed by brand + city and held for the
  franchise flow. Their owners come from GetLeads contacts, not from these rows.
- **Corporate chains excluded:** PeopleReady Skilled Trades, LaborMAX, Labor Ready, Labor Smart, Tradesmen International.
- **PASS:** 49 on the website gate. 2 were removed after reveal: both Quality Labor Services domains belong to qls1.com,
  which is already in production.
- **HOLD (223):** mostly unreadable sites. 130 were unreachable even with the headless browser, and the plain crawl had
  37 DNS failures. Google Maps carries many stale websites. All of them fail closed.

## Job-posting rule

- The GetLeads jobs service responded this time.
- Calls: 315 companies counted, 13 industrial-function batches (3 timed out once, then succeeded on retry), titles for
  the 11 companies with 2+ industrial postings. Free jobs quota only.
- 3 companies met the rule:
  - 2 were already PASS on their websites;
  - 1 has an unreadable site, so identity and business type can't be confirmed, and it stays HOLD.
- **Promotions: 0.**

## Buyers

- **Free Apollo search** (owner / founder / c-suite / partner / VP / director) on the 49 PASS companies found people at
  9 domains and a buyer at 7, all Tier 1.
- The same person appeared under two Quality Labor Services domains; deduped to 6 reveals.
- **Reveal:** 6 Apollo credits, 6 matched, verified, no phones and no personal emails. Contact QC:
  - 3 ready (2 verified, 1 catch-all);
  - 2 held: the email domain is a different company or branch, so the company is unproven;
  - 1 duplicate (the existing company).
- **Decision-makers batch:** the 44 PASS companies without a ready contact go in `pass_domains.csv`, max 2 contacts per
  domain. This includes the 2 with an unproven Apollo contact. GetLeads bills 1 credit per returned contact, at most 88.

## Spend

| | Amount |
|---|---|
| GetLeads plan | 1,357 credits (7,368 → 6,011). The decision-makers batch adds up to 88 when uploaded. |
| Apollo | 6 lead credits (1,158 → 1,152 left) |
| Jev | $0.024 |
| GetLeads jobs | free quota |
| Adyntel | 0 |

**Credits per contact:** about 1,451 GetLeads + Apollo credits for about 16 projected contacts, i.e. **about 90 credits
per contact**. On 3 contacts ready now it is about 450.

The cost is driven by the 1,357-row export, of which 77% was removed before the gate:

- chains, franchises and duplicate locations: 42%;
- already known, no site or off-ICP: 15%;
- the rest of the drop: dead sites.

## STOP

Nothing imported or queued. Next steps need the owner:

1. Upload `pass_domains.csv`. The link expires at 08:12 UTC; a new one can be made any time.
2. Verify the GetLeads results (to_verify).
3. Decide on the 3 ready contacts: import as a small batch, or wait for the batch.
