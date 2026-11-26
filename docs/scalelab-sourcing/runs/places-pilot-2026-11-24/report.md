# Google Maps discovery pilot (GetLeads places, 2026-11-24): counts only

Categories Staffing agency / Employment agency / Temp agency, has_website = true. Free counts: TX 5,038, OH 2,123,
GA 2,178 locations (9,339). A full export (1 credit per row) was over the 1,500 cap, so the owner chose a
300-credit sample: 100 rows per state (search_places, default sort, which runs alphabetically by city, so the
sample leans to early-alphabet cities). No import or queue.

| State | Locations | Unique domains | Already known | Chain | Net-new | PASS (website) | HOLD | REJECT |
|---|---|---|---|---|---|---|---|---|
| TX | 100 | 88 | 20 | 4 | 63 | 1 | 45 | 17 |
| OH | 100 | 82 | 20 | 4 | 55 | 7 | 38 | 10 |
| GA | 100 | 89 | 19 | 3 | 64 | 4 | 32 | 28 |
| Total | 300 | 259 | 59 | 11 | 182 | 12 | 115 | 55 |

(Domain dedupe also dropped 3 duplicates across states and 4 non-company sites; crawl merged 2 redirect duplicates.)
REJECT reasons: no industrial line 43, not staffing 10, duplicate 2.

Job-posting rule: not applied. GetLeads enrich_company_jobs timed out on every call (and once returned "too many
concurrent queries"), so the 115 HOLDs stay HOLD (fail closed) and can be re-checked when the jobs service recovers.

Spend: GetLeads plan 300 credits (8,403 -> 8,103 across the three calls); Jev $0.018; no Apollo, Adyntel or wallet.

Projection (sample rates, website gate only): PASS per net-new TX 1.6%, OH 12.7%, GA 6.3%. A full export would be
roughly TX 5,038 credits -> ~50 PASS, OH 2,123 -> ~150 PASS, GA 2,178 -> ~85 PASS. At the GetLeads decision-maker
yield seen on fresh PASS domains (about 25-35% end up contact-ready after the buyer rule and QC), the 12 PASS here
project to about 3-4 contacts, and a full OH export to about 40-50.
