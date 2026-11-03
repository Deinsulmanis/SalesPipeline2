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

Also in `C:\Users\deins\Downloads\` (Nov 2026 buying-signal work, no contacts purchased):

| File | What it holds |
|---|---|
| `Jole_150_Company_Buying_Signal_Test.csv`, `Jole_150_Removed_Log.csv` | 145 signal-test companies and removals |
| `Jole_38_Requalified_Companies.csv`, `Jole_38_Requalification_Report.md` | The current decisions on the 38, under v3 of this skill |
| `Jole_38_Qualified_Companies_and_Buyers.csv`, `Jole_38_Buyer_Research_List.csv`, `Jole_38_Research_Findings.md` | The pre-v3 research. Its tiers are superseded, but its evidence and 72 buyer records remain useful. |

Also dedupe against the live database:
- Supabase project `lasyefxhuwysjebasdbf`, table `outreach_leads`, every client.
- Global suppression.

Run these as read-only `SELECT`s.

## Requalification and research output columns (keep this order)

```
Company,Website,Industrial sector,Original qualification,Original score,Original deduction reasons,Newly resolved assumptions,Revised ICP eligibility,Revised opportunity score,Revised opportunity priority,Outreach readiness,Verified buying signal,Signal evidence URL,Signal date,Project stage,Relevant trades,Evidence of outside-labor use,Primary buyer,Buyer verification status,Procurement restrictions,Remaining research gaps,Reason for revised classification,Recommended next action
```

For a new research run with no prior decision, drop the three `Original` columns and `Newly resolved assumptions`.

## Approved-corpus column schema (keep this exact order)

This schema is for contact waves destined for live V5. `priority_tier`, `verified_role`, `posting_date` and `hiring_evidence_url` are hiring-lane fields.

```
source,final_status,reason_code,reason_detail,first_name,last_name,title,buyer_type,company,company_domain,website,email,email_domain,email_status,email_domain_catch_all,apollo_person_id,apollo_organization_id,apollo_organization_name,linkedin_url,contact_city,contact_state,hiring_site,hiring_location_verified_role,site_tie,sector,priority_tier,company_size,verified_role,secondary_role,posting_date,hiring_evidence_url,relevant_roles_30d,core_trade_roles_30d,why_contact_is_relevant,company_contact_number,apollo_credits_used,apollo_organization_id_source
```

**Allowed values:**

| Column | Allowed values |
|---|---|
| `sector` | One of the seven ICP sectors, written exactly as in SKILL.md |
| `priority_tier` | `Tier A` or `Tier B` (V5 hiring-lane tier, not the opportunity priority) |
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
| Archived Jole campaigns | Data-center, Gulf industrial and shipyard. Never route new leads to them. This is a routing rule, not a ban on contractors. |
| Code | SalesPipeline2 on Railway. The production branch moves, so check `CURRENT_PRODUCTION_BASELINE.md` on `main` and the Railway deployment record instead of trusting a name here. Jole config is in `integrations/clients/campaigns.js` and `client-configs.js`; copy is in `jole-copy.js`; holds are in `integrations/clients/data/jole-deliverability-holds.json`. |
