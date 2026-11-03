---
name: jole-dedupe-suppression
description: Jole BTX duplicate, client-family and suppression control (v1.0.0). Decides whether an account or contact is genuinely net-new and eligible for further sourcing - checks the live CRM across all clients, prior Jole sourcing waves, previously purchased contacts, client families, named competitors, corporate subsidiaries, normalized domains, DNC and global or client suppression by email, domain and company. Returns NET NEW, EXISTING ACCOUNT — NEW OPPORTUNITY, EXISTING CONTACT, FAMILY MATCH — REVIEW, SUPPRESSED or PROHIBITED. Read-only. Requires the jolesbtxicpskill shared policy.
version: 1.0.0
---

# Jole duplicate, client and suppression control

**Question: is this account genuinely net-new and eligible for further sourcing?**

Version 1.0.0, 2026-11-03. Load the shared policy first (skill `jolesbtxicpskill`). The client families and named competitors are defined only in its section 2. Everything here is read-only: `SELECT` queries and file reads, never a write.

## Use it when

- **Account level, early and cheap (Level 1):** right after sourcing, before any research spend.
- **Contact level, before any reveal, purchase, import or queue:** a fresh same-day check.
- **Family level, only for ambiguous cases:** a possible parent, subsidiary or sister of a client, competitor or existing account.

## Inputs

- **Required:** company name, plus website domain or email domain. For contacts: email, Apollo person id, or name + company.
- **Optional:** parent or subsidiary names, prior-wave file paths, a CRM export with its date.

## Sources, in order of authority

| Source | Role | Live or mirror |
|---|---|---|
| Shared policy section 2 (client families, named competitors) | Authoritative for PROHIBITED | Policy |
| Supabase project `lasyefxhuwysjebasdbf`, table `outreach_leads`, every client | Authoritative for existing leads and contacts. Email uniqueness is global, so an address belonging to ScaleLab or anyone else is refused, not reassigned. | Live |
| Supabase `client_suppressions` (client `jole`; match types email, domain, company) | Authoritative client suppression | Live |
| Global suppression: the CRM sheet's `Suppression` tab (emails), plus lead-note tags for opt-out, bounce, archive and manual hold | Authoritative global suppression | Live sheet |
| Prior Jole wave files (listed in `jolesbtxicpskill/reference.md`): approved, hold and removed contacts, Apollo person ids, company rejects and holds | History of purchased and reviewed contacts | Static mirror |
| Research files in Downloads (150 and 38 company lists) | Company candidates, no contacts | Static mirror |
| ColdEmail sheet, CSV exports | Convenience copies. Supabase is canonical (`SUPABASE_OUTREACH_MODE=primary`). | Mirror, may be stale |

Use authoritative records. When only mirrors were available, say so: a NET NEW from mirrors alone is provisional, confidence at most MEDIUM, and it must be re-checked live before any purchase or import.

## Matching

- **Email:** trimmed, lowercased.
- **Domain:** lowercased, without scheme, `www.` or path. Compare the website domain and the email domain.
- **Company key:** the production rule. Lowercase; `&` becomes "and"; strip punctuation and the words inc, incorporated, llc, ltd, limited, corp, corporation, co, company, lp, llp, plc and "the"; collapse spaces.
- **Named lists:** whole-word matches, so Bay Area Shipyard, Ticona and Brockway do not match Bay Ltd., TIC or Brock. Resolve a near-match by its domain.
- **Families:** check the company's own site (about, locations, "a member of"), press releases on acquisitions, and the free `apollo_organizations_lookup`. Investigate this only when a name, domain or ownership hint makes a family link plausible.

## Procedure

1. **Account pass (cheap).** Check the company key and domains against the named lists, `client_suppressions`, `outreach_leads` (all clients), and prior-wave company files.
2. **Stop early** on PROHIBITED or SUPPRESSED.
3. **Account exists?** If the company or domain already exists, record the existing state: client, stage, contacts, last touch. Attach any new signal, site or buyer role found by the other skills.
4. **Contact pass.** Before a reveal, purchase, import or queue, check the person against `outreach_leads` and the suppression sheet, plus prior-wave emails, Apollo person ids and person + company.
5. **Family pass.** Only for ambiguous cases.

## Decisions

Report the first that applies:

| Label | Rule |
|---|---|
| PROHIBITED | Confirmed client family or named competitor (shared policy section 2) |
| SUPPRESSED | Global or client suppression match. Say the scope: company or domain (stops the account) or email (stops that contact only). |
| EXISTING CONTACT | The person, email or Apollo person id already exists in the CRM (any client) or in a prior wave, approved, held or removed. Do not purchase the same contact twice, and never re-queue it. A held or removed contact returns only after its hold reason is resolved. |
| FAMILY MATCH — REVIEW | A plausible but unconfirmed family link to a client, competitor or existing account, or a name collision the domain cannot settle |
| EXISTING ACCOUNT — NEW OPPORTUNITY | The company or domain already exists. Keep it as an opportunity on that account: record the new signal, site or buyer role against it; do not create a duplicate company row; do not re-purchase or re-queue its contacts. If nothing new was found, set `new_information` to none. |
| NET NEW | No match in any source checked |

**Do not confuse an existing customer record with proof that a newly identified project is worthless.** An existing account is not a rejection: preserve the new buying-signal information without re-purchasing or re-queuing the same contact.

**Confidence:** HIGH after live CRM and suppression checks on the same day; MEDIUM on mirrors, or on live data older than the reuse window; LOW when a source was unavailable. Name the missing source.

## Escalate to the user

- Any FAMILY MATCH — REVIEW involving a client family or competitor.
- An existing account with an open thread where a new signal suggests a different buyer: the user decides whether a second contact is allowed.
- The suppression source is unreadable. Never treat that as "not suppressed".

## Output

Envelope from `jolesbtxicpskill/CONTRACT.md`, plus:

```json
"details": {"level": "account | contact | family",
  "sources_checked": [{"source": "outreach_leads", "live": true, "as_of": "YYYY-MM-DD"}],
  "matches": [{"source": "...", "match_type": "email | domain | company | person_id | family | named_list", "value": "...", "record": "..."}],
  "suppression_scope": "", "existing_state": {"client": "jole", "stage": "...", "contacts": 0, "last_touch": ""},
  "new_information": "none | signal | site | buyer_role"}
```

## Examples

| Case | Correct | Incorrect |
|---|---|---|
| Company already in the Jole CRM with one contact in sequence, and a new $8M expansion found | EXISTING ACCOUNT — NEW OPPORTUNITY; record the signal; do not re-queue the contact | Rejected as a duplicate, or re-sourced as new |
| No match in last month's CSV exports; live CRM not checked | NET NEW, provisional, MEDIUM; re-check live before purchase | NET NEW, HIGH |
| Prior-wave removed contact (left company) returned again by Apollo search | EXISTING CONTACT | Revealed again |
| `client_suppressions` has a company entry for the company | SUPPRESSED (company scope) | Contact sourcing continues |
| Bay Area Shipyard | NET NEW (no whole-word match to Bay Ltd.) | PROHIBITED |
| EQT in a search for "QT Corporation" | Not a match: different domain | Duplicate |

## Tests

`python tests/test_dedupe.py` from this folder. `tests/dedupe_logic.py` restates the mechanical rules; this file wins any disagreement.

## Change log

**1.0.0 (2026-11-03).** Split from jolesbtxicpskill 3.0.0, sections 3 (DNC and client families) and 10. Added the six outcomes, the source authority table, live versus mirror confidence, account, contact and family passes, and the production company-key rule.
