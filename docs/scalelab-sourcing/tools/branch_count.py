"""Branch count per company from the cached crawl (second-buyer multi-site rule). Free, offline.

Usage: python3 -I branch_count.py <run>
Counts distinct US "street ..., City, ST 12345" addresses across the company's crawled pages (sitecache/ and pwcache/)
and writes <run>/branches.json: {domain: {"branches": n, "evidence": [up to 3 page urls]}}. 3+ = multi-branch.
"""
import glob
import json
import os
import re
import sys

ADDR = re.compile(r'\b\d{1,6}\s+[A-Za-z0-9.#\' -]{2,40}?\b(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Hwy|Highway|Pkwy|'
                  r'Parkway|Way|Ln|Lane|Ct|Court|Pl|Place|Cir|Circle|Pike|Trl|Trail|Suite|Ste)\b\.?[^\n]{0,60}?,?\s+'
                  r'([A-Z][A-Za-z .\'-]{2,30}),\s*(A[LKZR]|C[AOT]|D[EC]|FL|GA|HI|I[DLNA]|K[SY]|LA|M[EDAINSOT]|N[EVHJMYCD]|'
                  r'O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[TA]|W[AVIY])\.?,?\s+(\d{5})\b')


def main():
    run = sys.argv[1]
    out = {}
    files = {}
    for cdir in ('sitecache', 'pwcache'):
        for f in glob.glob(os.path.join(run, cdir, '*.json')):
            files.setdefault(os.path.basename(f)[:-5], []).append(f)
    for d, fs in files.items():
        found, ev = set(), []
        for f in fs:
            try:
                pages = json.load(open(f)).get('pages') or []
            except (ValueError, OSError):
                continue
            for p in pages:
                for m in ADDR.finditer(p.get('text') or ''):
                    k = (m.group(1).strip().lower(), m.group(2), m.group(3))
                    if (k[0], k[1]) not in {(a, b) for a, b, _ in found}:
                        found.add(k)
                        ev.append(p.get('final_url') or p.get('url'))
        out[d] = {'branches': len({(a, b) for a, b, _ in found}), 'evidence': sorted(set(ev))[:3]}
    json.dump(out, open(os.path.join(run, 'branches.json'), 'w'), indent=1)
    n = [v['branches'] for v in out.values()]
    print({'companies': len(n), 'multi_branch_3plus': sum(1 for x in n if x >= 3), 'two': sum(1 for x in n if x == 2),
           'one': sum(1 for x in n if x == 1), 'none_found': sum(1 for x in n if x == 0)})


if __name__ == '__main__':
    main()
