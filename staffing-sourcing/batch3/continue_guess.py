#!/usr/bin/env python3
"""Guess remaining generic-staffing domains that have not already been website-qualified."""
from __future__ import annotations
import json
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from qualify_lib import ROOT, RAW
from guess_qualify import try_company

QUAL = ROOT / 'qualify'


def already_tried() -> set[str]:
    names = set()
    for p in QUAL.glob('*.json'):
        try:
            rows = json.loads(p.read_text())
        except Exception:
            continue
        if not isinstance(rows, list):
            continue
        for r in rows:
            if isinstance(r, dict) and r.get('company'):
                names.add(r['company'])
    return names


def main():
    inv = json.loads((RAW / 'remaining-inventory.json').read_text())
    tried = already_tried()
    rows = [r for r in (inv.get('generic_no_domain') or []) if r.get('company') not in tried]
    keep = [r for r in (inv.get('keep_name') or []) if r.get('company') not in tried and not r.get('domain')]
    # keep_name with no domain can also be guessed; website_qualify still applies later
    work = rows + keep
    work = work[:240]
    print(json.dumps({
        'already_tried': len(tried),
        'generic_untried': len(rows),
        'keep_untried': len(keep),
        'this_pass': len(work),
    }))
    results = []
    if work:
        with ThreadPoolExecutor(max_workers=12) as ex:
            futs = {ex.submit(try_company, r): r for r in work}
            for i, fut in enumerate(as_completed(futs), 1):
                rec = fut.result()
                results.append(rec)
                if i % 20 == 0:
                    print(f'  {i}/{len(work)} done; pass={sum(1 for x in results if x["decision"]=="pass")}')
    results.sort(key=lambda r: (0 if r['decision'] == 'pass' else 1, r.get('title_rank', 99), r.get('company', '')))
    out = QUAL / 'guessed-domains-cont.json'
    out.write_text(json.dumps(results, indent=2))
    passed = [r for r in results if r['decision'] == 'pass']
    print(json.dumps({
        'attempted': len(results),
        'passed': len(passed),
        'decisions': dict(Counter(r['decision'] for r in results)),
        'pass_companies': [(p['company'], p.get('domain'), p.get('person_id')) for p in passed],
    }, indent=2))


if __name__ == '__main__':
    main()
