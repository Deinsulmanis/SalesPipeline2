# Industrial Staffing V2 lead import

The only way an Industrial Staffing V2 lead (`industrial_staffing_employer_acquisition_v2`) enters storage.

- **Code:** `integrations/staffing-v2-import.js` and `integrations/staffing-v2-profile.js`.
- **Route:** `POST /api/staffing/v2/leads/import` (dashboard Basic Auth).
- **Safe by default:** the route is a dry run unless the body sends `"dry_run": false`.
- **Never through the legacy importer:** `POST /api/coldemail/import` refuses V2 identity with `use_staffing_v2_import`.

## What an import does

- Writes **Import-stage** leads only.
  - One ColdEmail append, then the background `outreach_leads` mirror, using the same primitives as the managed-client import.
  - Each lead has its full V2 identity (`campaign`, `emailTemplateId`, `intendedCampaignVersion`) and its typed sourcing profile.
- It never queues, assigns a sender, reserves, schedules, creates sequence state, or activates V2. `STAFFING_V2_LIVE` stays `false`.
- Queueing is a separate operator action, and it re-checks everything.

## Request

```json
{
  "schema": "staffing_v2_import_v1",
  "campaign_id": "industrial_staffing_employer_acquisition_v2",
  "template_id": "industrial-staffing-employer-v2",
  "dry_run": true,
  "run": {
    "sourcing_run_id": "v2src-20261020-01",
    "catch_all_allowed": true,
    "allow_over_500_ready": false,
    "allowed_buyer_cohorts": ["P1A_OWNER_EXEC", "P1B_REVENUE", "P2_COMMERCIAL"]
  },
  "records": [ { "...": "one V2_READY sourcing record per lead" } ]
}
```

The V2 sourcing skill writes this body as each run's `09-v2-import-candidate.json` (rows 501 onward in `09-v2-import-candidate-2.json`, and so on), always with `"dry_run": true`.

| Field | Rule |
|---|---|
| `campaign_id`, `template_id` | Required, and must be V2's. If either is missing, or names V1, the whole request is refused (`invalid_payload`). The campaign is never inferred from `industrial_staffing`. |
| `run.catch_all_allowed` | Required, `true` or `false`. |
| `run.allowed_buyer_cohorts` | Required. Lists the buyer cohorts this run allows. |
| `run.allow_over_500_ready` | Optional; defaults to `false`. |
| `run.sourcing_run_id` | Required; every record must carry the same value. |
| `records` | 1–500 per request. |

## Record

A record uses the V2 sourcing skill's field names: its `reference.md` §1 data model plus the Apollo execution spec's experiment fields.

- **Field transport:** values may be JSON-typed or text. List fields accept arrays or `|`-separated text. Integer fields accept numbers or digit strings.
- **`alternate_buyers`** must be an array of whole entries, each `name | title | cohort | apollo_person_id` with a buyer cohort. Pipe-separated text would split an entry into its parts, so it is refused (`invalid_buyer`).
- **Unknown keys are refused** (`unknown_field`), never dropped silently. So a numbered run artifact (`06-v2-ready.csv` / `09-v2-import-candidate.csv`) whose columns are these field names maps 1:1: one CSV row becomes one record.

**Required, with the values a V2_READY record must carry:**
- **Identity:**
  - `campaign_id` and `template_id` (V2's), `email` (verified work email, not a personal mailbox), `company`, `first_name`, `last_name`.
  - `country` must be `US`.
  - `contact_name`, if present, must equal first name + last name.
- **Touch 1:**
  - `roles`: 1–3 short worker roles (no ` and ` inside a role when several are given).
  - `market`: a short employer description.
  - `roles_evidence`, `market_evidence` and `role_market_evidence_source`.
  - Nothing is inferred and there is no fallback.
- **Status:**
  - `v2_status` = `V2_READY`.
  - `hard_gate_status`, `pre_reveal_gate_status` and `post_reveal_gate_status` = `PASS`, and `hard_gate_failures` is empty.
  - `company_fit_status` = `ICP_CONFIRMED`, `copy_readiness_status` = `ROLE_MARKET_VERIFIED`, `buyer_status` = `BUYER_CONFIRMED`.
  - `duplicate_status` and `suppression_status` = `CLEAR`.
- **ICP:**
  - `icp_lane`: `TIER_A_STAFFING` or `TIER_B_RECRUITING`.
  - `icp_priority_band`: `PRIORITY_A` or `PRIORITY_B`, matching the total score.
  - `staffing_model`, plus a `vertical` other than `NOT_APPROVED`.
- **Buyer:**
  - `buyer_cohort` must be in the run's allowed cohorts. `buyer_priority`, `buyer_family`, `buyer_assignment_method` and `buyer_score` must match it:
    - P1A goes with `RANDOMIZED_P1A`, `FALLBACK_P1A` or `ONLY_P1A`.
    - P1B goes with `RANDOMIZED_P1B`, `FALLBACK_P1B` or `ONLY_P1B`.
    - P2 goes with `P2_FALLBACK`.
    - P3 and P4 go with `P3_REVIEW` and `P4_REVIEW`.
  - `buyer_randomization_bucket` must be `0`, `1` or blank. It is required as `0` for `RANDOMIZED_P1A` and `1` for `RANDOMIZED_P1B`.
- **Scores:**
  - The locked anchor values, with `pre_reveal_subtotal` = the sum of the six pre-reveal scores, at least 70.
  - `total_icp_score` = subtotal + email score.
  - `email_quality_score`: 5 when not catch-all, 3 when catch-all.
- **Email:** `email_status` = `verified`, `catch_all_status` = `Y` or `N` (`Y` only if the run allows catch-all), a matching `email_readiness_status`, and `reveal_result` = `MATCHED_EMAIL`.
- **Run restriction:** an `employee_count` over 500 is refused unless `allow_over_500_ready` is true. A blank count means unknown and is allowed.
- **Provenance:** `sourcing_run_id`, `source`, a dated `source_checked_at`, and `reveal_credit_cost` of 0 or 1.

**Optional:** `company_domain`, the Apollo IDs, `job_title`, `buyer_evidence`, `alternate_buyers`, `vertical_sublane`, `specialty_tags`, `city`, `state`, `qualification_reason`, `review_flags`, `source_batch`, `search_stream`, `source_query`, `source_url_or_reference`, `reveal_attempted` and `reveal_attempted_at`.

**Refusal codes:**
- Field rules: `unknown_field`, `campaign_identity_missing`, `v1_identity_refused`, `campaign_identity_mismatch`, `invalid_email`, `personal_email`, `company_missing`, `contact_missing`, `contact_mismatch`, `invalid_domain`, `not_us`.
- Touch 1 copy: `roles_missing`, `roles_invalid`, `market_missing`, `market_invalid`, `evidence_missing`.
- Sourcing status: `not_v2_ready`, `gate_not_passed`, `status_not_ready`, `declared_duplicate`, `declared_suppressed`.
- ICP, buyer and scores: `invalid_lane`, `invalid_band`, `invalid_icp`, `invalid_buyer`, `cohort_not_allowed`, `invalid_assignment`, `invalid_score`.
- Email and run policy: `email_not_verified`, `email_not_ready`, `catch_all_not_allowed`, `run_restriction`, `invalid_provenance`, `profile_too_large`.
- Live checks against existing data: `suppressed`, `duplicate_in_batch`, `duplicate_email`, `cross_client_duplicate`, `duplicate_company`, `duplicate_person`, `staffing_v2_profile_integrity_failed` (the stored V2 lead for this address fails its integrity check; it is never overwritten or repaired).
- `profile_too_large`: the serialized profile would exceed 30,000 characters. The record is refused, never truncated.

## Storage

**First-class columns:** the ColdEmail sheet A:Y, mirrored to Supabase `outreach_leads`.

| Column | Value |
|---|---|
| `company`, `email` (lower-cased), `city` | From the record |
| `contactName` | first name + last name |
| `website` | `https://` + `company_domain` |
| `stage` | `Import` |
| `campaign` | `Industrial Staffing Agency V2` |
| `emailTemplateId` | V2 template |
| `intendedCampaignVersion` | V2 id |
| `leadNiche` | `industrial_staffing` |
| `clientId` | `scalelab` |
| `routingRequired` | `true` |
| `senderInboxId`, `emailStatus`, `emailStep`, `lastEmailedAt` | blank |
| `tradeType`, `tier`, `siteContext`, `notes` | **blank**, because these columns carry V1 meanings |

**Structured profile:** `campaign_notes` holds JSON with schema `staffing_v2_lead_profile_v1`.
- **Contents:** every record field, typed, plus `import_schema`, `import_key`, `imported_at` and `profile_digest`.
- **Size:** at most 30,000 characters (`MAX_STAFFING_V2_PROFILE_CHARS`). A full record is about 2,600; Sheets allows 50,000 per cell.
- **Read-only:** only the V2 import writes it, once, on a new row (see *Guards after import*).
- **Why this column:** it already exists in both stores and is carried by every full-row write and mirror, so the stores never disagree. No migration is needed.
- **Query example:**

  ```sql
  select lead_id, campaign_notes::jsonb ->> 'buyer_cohort', campaign_notes::jsonb ->> 'buyer_assignment_method'
  from outreach_leads where intended_campaign_version = 'industrial_staffing_employer_acquisition_v2';
  ```

## Profile integrity

- **Digest:** `profile_digest` is SHA-256 (lowercase hex) of the profile's canonical form.
- **Canonical form:** a JSON array of `[key, value]` pairs, sorted by key, for exactly these keys:
  - `schema`, `import_schema`, `import_key`;
  - every record field.
- **Not covered:** `profile_digest` itself, and `imported_at` (the import clock). So the same record always seals to the same digest, and the digest can be recomputed from the run artifact.
- **Verified on every read** (`readStaffingV2Profile`). That covers the import's own read-back and re-import check, the V2 renderer (all three touches and the preview), queue validation and send selection.
- **Fails closed:** any of these reads as `staffing_v2_profile_integrity_failed`, with a `detail` for operators:
  - an oversized profile;
  - invalid JSON or the wrong schema;
  - an unexpected or missing field;
  - a wrongly typed value;
  - a missing or mismatched digest.
- **Effect of a failed profile:**
  - the lead stays V2-marked;
  - it does not render;
  - `staffingV2SendBlock` and `routedLeadReady` hold it with exactly that reason.
- **No repair:** nothing ever rebuilds or repairs the profile.
- **Limit of the digest:** it is unkeyed. It catches any generic or accidental change, but not a writer that deliberately recomputes it. The read-only rule below is what stops generic writers.

## Idempotency and duplicates

- **Import key:** `sha256(campaign_id | normalized email | apollo_person_id)`, first 32 hex characters, stored in the profile.
- **Re-submitting** a record whose address is already stored under the same key returns it as `alreadyImported` and writes nothing.
- **Refused as duplicates:**
  - any other existing lead with the same address, in any client;
  - any ScaleLab lead with the same company domain (website or email domain; V1 companies are duplicates for V2);
  - an existing V2 lead with the same Apollo person or organization ID.
- **Within one request,** records sharing an email, company domain or Apollo identity are all refused.

## Guards after import

| Guard | Effect |
|---|---|
| V2 Touch 1 | Renders `Saw {{company}} places {{roles}} for {{market}}.` from the profile's structured `roles` (joined as "a", "a and b", "a, b and c") and `market`. It never reverse-parses an opener. An unusable profile refuses to render. |
| `activeVersionForLead` | A V2-marked lead (label, template, version or profile) resolves to V2 or throws. A blank or V1 version never makes it V1. |
| `staffingCampaignFor` | A lead with a V2 profile is V2 or nothing, whatever its other fields say. |
| `routedLeadReady` (agent send selection, readiness) and `queueSelectedLeads` | A V2-marked lead is held unless campaign, template and version all name V2, its profile has roles + market, and V2 is live. |
| `staffing-preview-route` (V1 personalization) | Refuses V2 leads, so it can never overwrite their profile or opener. |
| `replaceStaffingReviewTag`, `withStaffingHold` | Refuse a V2 profile. |
| Profile integrity | Every reader verifies `profile_digest`. A failed profile is held as `staffing_v2_profile_integrity_failed`, never repaired. |
| `campaign_notes` read-only (`staffingV2CampaignNotesRefusal`) | A write that changes a V2-marked lead's `campaign_notes`, or puts a V2 profile on any other lead, is refused before anything is written. It is checked against the stored row: the CAS read in `applyCanonicalChange` (Supabase authority), a row read in `applyLeadChange` and `applyLeadChanges` (Sheets authority), and a row read in the dashboard's `PUT /api/coldemail/:id`. Rewriting the same value is allowed, so other field edits still land. |
| `POST /api/coldemail` (manual add) | Refuses V2 identity with `use_staffing_v2_import`. |
