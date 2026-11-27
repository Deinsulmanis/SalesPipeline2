# Manual GetLeads runs for the 428 PASS agencies with no contact (2026-11-26): counts only

Source: the leak audit's 428 PASS agencies with no contact in production or the V4 master.

## Routing

| Route | Agencies |
|---|---|
| Site-named owner, never enriched before → `owner_names.csv` (60 names) | 58 |
| Site owners already enriched in earlier Names + companies runs | 41 |
| Already looked up by GetLeads decision makers earlier: contacts returned but none usable | 104 |
| Already looked up by GetLeads decision makers earlier: nothing returned | 186 |
| Fresh → `no_name_domains.csv` (decision-makers batch, max 2 per domain) | 80 |

Some agencies fall in more than one row; the 290 already-looked-up agencies are 104 + 186.

## Results (the owner ran both)

| | Names + companies | Decision-makers batch |
|---|---|---|
| Sent | 60 names | 80 domains |
| Matched | 7 (12%); 5 with a work email (4 VALID, 1 UNKNOWN) | 21 contacts at 12 domains (15%), all VALID |

About 18 of the 60 names were page phrases the name extractor mistook for people ("All Testimonials", "Machine
Shop"). None of them matched.

## Contact QC

**Rules applied:**
- buyer tiers from `buyer_pick.py`, plus the multi-site rule (none of these agencies has 3+ branches);
- dedupe against production, the V4 master and every pending reveal or verification list;
- VALID = verified; catch-all = flagged and queued last (none this time); anything else = HOLD;
- phone numbers and personal emails ignored.

| Result | Agencies |
|---|---|
| **Contact-ready, Campaign 3 copy v2 (COPY_C fallback)** | **4** |
| Contact-ready but copy HOLD (no variant has verified evidence) | 2 |
| Duplicate: this address is already in the master or pending | 3 |
| Company already has an approved contact pending (Illinois registry run, 11-25) | 2 |
| Buyer found, no work email | 2 |
| Stale organisation (the person now works elsewhere) | 1 |
| GetLeads status UNKNOWN | 1 |
| No buyer-tier person returned | 4 |

**New contact-ready:** 6 contacts, 4 of them with copy. None are catch-all.

The V4 master was not written (checksum unchanged); outputs were built against a scratch copy. Nothing was imported or
queued.

## Files (private)

All under `runs-private/manual-enrich-428-2026-11-26/`:
- `combined_contacts.csv`: every contact found, with its result;
- `out/approved-contacts.csv`;
- `out/preview/v4-preview.html`;
- the key files.

## Import and queue, and pool closed (owner go-ahead 2026-11-27)

**Imported:** only the 4 READY contacts: Genesis10, Integrity Trade Services, Select Source International and South 6.
Select Source's company name was cleaned of trailing characters copied from the site.
- Dry run: 4 accepted. Live: 4 written, 0 refused. All COPY_C on copy v2, none catch-all.
- Added to the V4 master (644 → 648) as `IMPORTED_QUEUED_CAMPAIGN_3`.

**Queued:** one lead each to primary, outreachplateau_dave, outreachplateau_merrick and outreachplateau_zoe. Deniels,
the most loaded inbox, got none.
- Launch readiness: 4 of 4 Queued, `wouldSendIfSendingEnabled` true.
- Sender balance: 0 moves, none into held inboxes.

**Everything else from this pool is dropped,** including the 2 copy holds and every held contact.

**The 428-agency pool is marked EXHAUSTED** (`runs-private/manual-enrich-428-2026-11-26/POOL_EXHAUSTED.json`): 4
imported, 424 with no further work.
