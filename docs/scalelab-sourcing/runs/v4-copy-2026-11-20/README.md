# Industrial Staffing V4: copy variant assignment (2026-11-20)

Read-only. Nothing was imported, queued, enrolled or sent. No paid calls were made.

## How to regenerate

```bash
python3 -I docs/scalelab-sourcing/runs/v4-copy-2026-11-20/scripts/build_evidence.py <scratchpad> docs/scalelab-sourcing/runs/V4_APPROVED_CONTACTS_MASTER.csv docs/scalelab-sourcing/runs/v4-copy-2026-11-20/v4-copy-evidence.json
node scripts/staffing-v4-preview.js docs/scalelab-sourcing/runs/v4-copy-2026-11-20/v4-copy-evidence.json docs/scalelab-sourcing/runs/v4-copy-2026-11-20/preview
```

`v4-copy-evidence.json` and `preview/` name buyers and emails, so both are git-ignored.

## Result (33 sourced rows)

| Variant | Leads | Basis |
|---|---|---|
| COPY_A | 3 | A current, attributed, employer-facing ad (Jev employer p ≥ 0.7, seen within 30 days) |
| COPY_B | 3 | A current job ad that quotes both the role and the location |
| COPY_C | 26 | No qualifying signal; the specialization is backed by a quoted first-party excerpt |
| COPY_D / E / F | 0 | Internal BD hiring, expansion and new-leader signals were never searched in V4 sourcing |
| HOLD | 1 | The evidence supports COPY_A, but the contact is NEEDS_EVIDENCE (possible affiliate collision) |

Against the expected 2 A / 5 B / 24 C for the original 31 rows:

- **A: 2, as expected.** The two added rows split: TPI is a third A, and AMMON is on hold.
- **B: 3, not 5.**
  - Coastal Careers' only ads are from 2021.
  - GraceMark's ads are undated LinkedIn event promotions, not job ads.
  - Both therefore fall to C.
- **C: 26, not 24.** Those same two rows account for the difference.

Delivery admission: 7 of 33 mailboxes are Google-hosted. Under the current `RECIPIENT_PROVIDER_POLICY=google_only`, the other 26 would be held at queue time.
