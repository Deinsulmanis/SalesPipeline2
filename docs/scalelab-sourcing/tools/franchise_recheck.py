"""Re-check earlier chain / franchise holds under the franchise rule (owner decision 2026-11-25). Free, read-only.

Usage: python3 -I franchise_recheck.py <runs-private dir> <out.json>
Sources: v4-3000 and jobs-discovery discovery holds (FRANCHISE_OR_NATIONAL_CHAIN) and the second-buyer exclusions
(national_chain_or_franchise). Verdicts (franchise_rule.chain_block):
  STAYS_EXCLUDED_CORPORATE, FRANCHISOR_HQ (never contacted), FRANCHISE_OWNER_FLOW (brand's shared domain: sourced per
  owner), FRANCHISE_OWN_DOMAIN_NEEDS_LOCATION_GATE, NO_LONGER_A_CHAIN_MATCH_NEEDS_GATE, STAYS_HOLD_CHAIN_SIGNAL;
  '+OTHER_EXCLUSION' when another exclusion (non-US, reply, ...) still applies.
"""
import collections
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import franchise_rule as fr  # noqa: E402

VERDICT = {'corporate_chain': 'STAYS_EXCLUDED_CORPORATE', 'franchisor_hq': 'FRANCHISOR_HQ',
           'franchise_shared_domain': 'FRANCHISE_OWNER_FLOW', 'chain_signal': 'STAYS_HOLD_CHAIN_SIGNAL'}


def main():
    base, out_path = sys.argv[1], sys.argv[2]
    out = []
    for run in ('v4-3000-2026-11-23', 'jobs-discovery-2026-11-24'):
        for r in json.load(open(os.path.join(base, run, 'discovery_excluded.json'))):
            if 'FRANCHISE' in str(r.get('excluded', '')):
                out.append({'run': run, 'domain': r['domain'], 'name': r['company_name'], 'chain_p': None, 'other': []})
    for c in json.load(open(os.path.join(base, 'second-buyer-2026-11-24', 'phase1_companies.json'))):
        rs = c.get('exclude_reasons') or []
        if 'national_chain_or_franchise' in rs:
            out.append({'run': 'second-buyer-2026-11-24', 'domain': c['domain'], 'name': ' / '.join(c['names']),
                        'chain_p': (c.get('gate') or {}).get('chain_p'), 'other': [r for r in rs if r != 'national_chain_or_franchise']})
    counts = collections.Counter()
    for o in out:
        kind, brand = fr.classify_company(o['name'], o['domain'])
        blk = fr.chain_block(o['name'], o['domain'], o['chain_p'])
        v = VERDICT.get(blk) or ('FRANCHISE_OWN_DOMAIN_NEEDS_LOCATION_GATE' if kind == 'FRANCHISE' else 'NO_LONGER_A_CHAIN_MATCH_NEEDS_GATE')
        if o['other']:
            v += '+OTHER_EXCLUSION'
        o.update(verdict=v, brand=brand)
        counts[(o['run'], v)] += 1
    json.dump(out, open(out_path, 'w'), indent=1)
    for k, n in sorted(counts.items()):
        print(k[0], k[1], n)


if __name__ == '__main__':
    main()
