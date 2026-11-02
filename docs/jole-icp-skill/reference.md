# Jole lead sourcing: reference

## Prior waves (dedupe against all of these)

Root: `C:\Users\deins\OneDrive\JoleBTXOutBound\JoleBTXLeadSample\`

| File | What it holds |
|---|---|
| `Phase5_Final_Corpus/Jole_Final_Approved_Corpus.csv` | 689 approved contacts at 422 companies. Imported to production on 2026-10-08 (client `jole`, batch `jole-phase5-689-20261008`). |
| `Phase5_Final_Corpus/Jole_Final_Review_Hold.csv` | 34 held contacts, with reasons |
| `Phase5_Final_Corpus/Jole_Final_Removed.csv` | 3 removed contacts |
| `Phase5_Final_Corpus/Jole_Final_Audit_All_726.csv` | Every Phase 5 decision and its reason |
| `Phase4_Enrichment/Jole_Phase4_Review_Hold.csv` | 46 contact holds and 11 company holds |
| `Phase4_Enrichment/Jole_Phase4_No_Valid_Contact.csv` | 140 companies and 2 contacts with no usable buyer |
| `Phase3_Strict_ICP/Jole_Phase3_Strict_Launch_Cohort.csv` | 616 ICP companies (333 Tier A, 283 Tier B) |
| `Phase3_Strict_ICP/Jole_Phase3_Expansion_Pool.csv` | 1,149 companies outside the strict ICP |
| `Phase3_Strict_ICP/Jole_Phase3_HOLD.csv`, `Jole_Phase3_REJECT.csv` | Company holds and rejects, with reasons |
| `Phase2_Corpus/Jole_REJECT_2026-10-05.csv`, `Jole_HOLD_2026-10-05.csv` | Phase 2 company rejects (staffing, labor overlap, DNC) and holds (contractors, service firms) |
| `Phase3_Strict_ICP/Phase3_Strict_ICP_Report.md`, `Phase4_Enrichment/Phase4_Jole_Enrichment_Report.md`, `Phase5_Final_Corpus/Jole_Final_Audit_Report.md` | How each gate was applied, worked examples |

Also dedupe against the live database:
- Supabase project `lasyefxhuwysjebasdbf`, table `outreach_leads`, every client.
- Global suppression.

Run these as read-only `SELECT`s.

## Approved-corpus column schema (keep this exact order)

```
source,final_status,reason_code,reason_detail,first_name,last_name,title,buyer_type,company,company_domain,website,email,email_domain,email_status,email_domain_catch_all,apollo_person_id,apollo_organization_id,apollo_organization_name,linkedin_url,contact_city,contact_state,hiring_site,hiring_location_verified_role,site_tie,sector,priority_tier,company_size,verified_role,secondary_role,posting_date,hiring_evidence_url,relevant_roles_30d,core_trade_roles_30d,why_contact_is_relevant,company_contact_number,apollo_credits_used,apollo_organization_id_source
```

**Allowed values:**

| Column | Allowed values |
|---|---|
| `sector` | One of the seven ICP sectors, written exactly as in SKILL.md |
| `priority_tier` | `Tier A` or `Tier B` |
| `buyer_type` | `Plant / operations / production`, `HR / talent acquisition`, `Maintenance / reliability`, `Owner / executive`, or `Superintendent / site leadership` |
| `site_tie` | `EXACT`, `REGION` or `STATE` |
| `email_status` | `VERIFIED` only |
| `email_domain_catch_all` | `Y` or `N` |
| `posting_date` | `YYYY-MM-DD` |
| `hiring_evidence_url` | The live posting: a LinkedIn job view or the employer's ATS |

## Import payload row shape

```json
{
  "company": "...", "contactName": "First Last", "email": "...", "city": "<hiring site, e.g. Lake Charles, LA>",
  "website": "...", "tradeType": "<sector>", "evidence": "<why_contact_is_relevant>",
  "research": { "first_name": "...", "last_name": "...", "title": "...", "buyer_type": "...", "contact_city": "...",
    "contact_state": "..", "linkedin_url": "...", "company_domain": "...", "company_size": "...",
    "company_contact_number": "...", "priority_tier": "Tier A", "email_status": "VERIFIED",
    "email_domain_catch_all": "N", "site_tie": "EXACT", "verified_role": "...", "secondary_role": "...",
    "posting_date": "YYYY-MM-DD", "hiring_evidence_url": "...", "relevant_roles_30d": "3",
    "core_trade_roles_30d": "2", "apollo_person_id": "...", "apollo_organization_id": "..." }
}
```

**How the server uses this row:**
- It builds the `client_lead_profile_v1` profile from `research`.
- It cleans `verified_role` into a trade name; for example, "Welder - 2nd Shift" becomes "Welders".
- Helper, apprentice, supervisor and bare "Technician" / "Operator" roles are marked `needs_review`, so prefer a specific trade title in `verified_role`.

## Production identifiers

| Item | Value |
|---|---|
| Client | `jole` ("Jole BTX LLC") |
| Sender name | Jorge Guerrero, CEO |
| Campaign | `jole-btx-employer-acquisition` (the only campaign Jole's sender policy allows) |
| Template | `jole-industrial-employer-v1`, a three-touch sequence |
| Archived Jole campaigns | Data-center, Gulf industrial and shipyard. These were contractor ICPs; never route new leads to them. |
| Code | SalesPipeline2 on Railway, production branch `cursor/staffing-agent-shadow-production-7402`. Jole config is in `integrations/clients/campaigns.js` and `client-configs.js`. |
