"""Read-only leak audit across ScaleLab industrial sourcing runs (owner brief 2026-11-26). Free, offline.

Usage: python3 -I leak_audit.py <out_dir>
Per discovery source: discovered (raw unique, from each run's report or disc/ files) -> net-new after dedupe -> in run
-> readable crawl -> PASS / HOLD / REJECT (top 5 reason clauses each) -> contact-ready. Re-processing runs (re-gates,
second buyers, recovery) are listed separately. Writes <out>/funnel.json and <out>/funnel.csv (counts only).
"""
import collections
import csv
import glob
import json
import os
import re
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..'))
SP = '/tmp/claude-0/-home-user-SalesPipeline2/2ac8488f-fce7-5c12-b5fb-d98394461a32/scratchpad'
P = f'{REPO}/runs-private'
# source label, run dirs, discovered raw unique (documented in each run report), net-new documented, master waves, extra contacts
SOURCES = [
    ('GetLeads company search (V4 pilot)', [f'{SP}/v4run', f'{SP}/v4run_p2'], 104, None, ['pilot-2026-11-19'], 0),
    ('Apollo + Adyntel + GetLeads (wave 1)', [f'{SP}/w1'], 301, None, ['wave1-2026-11-20'], 0),
    ('Codex send-ready list (48)', [f'{SP}/c48'], 48, None, ['codex-send-ready-2026-11-21'], 0),
    ('Codex 1,000-company list', [f'{SP}/c1k'], 909, None, ['codex1k-recheck-2026-11-23'], 0),
    ('Apollo industrial tags (w2k)', [f'{P}/w2k'], 4787, 2595, ['w2k-2026-11-23'], 0),
    ('Apollo tags + NAICS 56132 (v4-3000)', [f'{P}/v4-3000-2026-11-23'], 8607, 3405, ['v4-3000-2026-11-23'], 0),
    ('GetLeads job boards (jobs-discovery)', [f'{P}/jobs-discovery-2026-11-24'], 973, 312, ['jobs-discovery-2026-11-24'], 0),
    ('Google Maps pilot (TX/OH/GA)', [f'{P}/places-pilot-2026-11-24'], 259, 182, [], 0),
    ('Google Maps keywords', [f'{P}/places-kw-2026-11-25'], 463, 315, [], 3),
    ('Illinois DTLSA registry', [f'{P}/il-registry-2026-11-25'], 470, 98, [], 8),
    ('Massachusetts DLS registry', [f'{P}/ma-registry-2026-11-25'], 720, 82, [], 2),
    ('NYC DCWP licenses', [f'{P}/nyc-registry-2026-11-25'], 247, 29, [], 0),
]
REPROCESS = [
    ('Shortfall (GetLeads buyers for PASS without one)', [f'{P}/shortfall-2026-11-23'], ['shortfall-getleads-2026-11-23']),
    ('Re-gate 551 with job postings', [f'{P}/regate-551-2026-11-24'], ['regate-551-2026-11-24']),
    ('Recovery: C2 / V1 Import leads', [f'{P}/recovery-c2-import-2026-11-24'], []),
    ('Second buyer: V1 (822)', [f'{P}/second-buyer-2026-11-24'], ['second-buyer-2026-11-24']),
    ('Second buyer: C2 (388)', [f'{P}/second-buyer-c2-2026-11-26'], ['second-buyer-c2-2026-11-26']),
    ('Franchise re-check', [f'{P}/franchise-recheck-2026-11-25'], []),
    ('Fit-doubt re-check (57)', [f'{P}/recheck-fitdoubt-2026-11-26'], []),
]


def jload(p, d=None):
    try:
        return json.load(open(p))
    except Exception:
        return d


def readable(run, dom):
    n = 0
    for c in ('sitecache', 'pwcache'):
        x = jload(os.path.join(run, c, dom + '.json'), {}) or {}
        n = max(n, sum(len(p.get('text') or '') for p in (x.get('pages') or [])))
    return n >= 1500


def clauses(reason):
    out = []
    for c in re.split(r';\s*', reason or ''):
        c = re.sub(r'\(.*?\)', '', c).strip().rstrip('.').lower()
        c = re.sub(r'\b\d+(\.\d+)?\b', '#', c)
        if c:
            out.append(c[:70])
    return out or ['(no reason text)']


def funnel(runs):
    comps, decs = [], {}
    for r in runs:
        comps += jload(f'{r}/companies.json', []) or []
        for x in jload(f'{r}/icp_decisions.json', []) or []:
            decs[x['domain']] = (x, r)
    dup = [d for d, (x, _) in decs.items() if x.get('icp_reason_code') == 'DUPLICATE']
    live = {d: v for d, v in decs.items() if v[0].get('icp_reason_code') != 'DUPLICATE'}
    rd = sum(1 for d, (x, r) in live.items() if readable(r, d))
    b = collections.Counter(x['company_icp'] for x, _ in live.values())
    top = {}
    for k in ('PASS', 'HOLD', 'REJECT'):
        cc = collections.Counter()
        for x, _ in live.values():
            if x['company_icp'] == k:
                for c in set(clauses(x.get('reason'))):
                    cc[c] += 1
        top[k] = cc.most_common(5)
    return {'in_run': len(comps), 'gate_duplicates': len(dup), 'gated': len(live), 'readable': rd,
            'PASS': b.get('PASS', 0), 'HOLD': b.get('HOLD', 0), 'REJECT': b.get('REJECT', 0), 'top_reasons': top}


def main():
    out = sys.argv[1]
    master = list(csv.DictReader(open(f'{REPO}/docs/scalelab-sourcing/runs/V4_APPROVED_CONTACTS_MASTER.csv')))
    waves = collections.Counter(r['wave'] for r in master)
    rows = []
    for label, runs, raw, nn, wv, extra in SOURCES:
        f = funnel(runs)
        nn = nn if nn is not None else f['in_run'] - f['gate_duplicates']
        f.update(source=label, kind='discovery', discovered=raw, net_new=nn, contacts=sum(waves[w] for w in wv) + extra)
        rows.append(f)
    for label, runs, wv in REPROCESS:
        f = funnel(runs)
        f.update(source=label, kind='reprocess', discovered=None, net_new=None, contacts=sum(waves[w] for w in wv))
        rows.append(f)
    json.dump(rows, open(f'{out}/funnel.json', 'w'), indent=1)

    def pct(a, b):
        return f'{100 * (1 - a / b):.0f}%' if b else ''
    with open(f'{out}/funnel.csv', 'w', newline='') as fh:
        w = csv.writer(fh)
        w.writerow(['kind', 'source', 'discovered', 'net_new', 'drop_dedupe', 'gated', 'readable', 'drop_unreadable',
                    'PASS', 'HOLD', 'REJECT', 'pass_rate_of_gated', 'contacts', 'drop_pass_to_contact'])
        for r in rows:
            w.writerow([r['kind'], r['source'], r['discovered'], r['net_new'],
                        pct(r['net_new'], r['discovered']) if r['discovered'] else '', r['gated'], r['readable'],
                        pct(r['readable'], r['gated']), r['PASS'], r['HOLD'], r['REJECT'],
                        f"{100 * r['PASS'] / r['gated']:.1f}%" if r['gated'] else '', r['contacts'], pct(r['contacts'], r['PASS'])])
    for r in rows:
        print(r['kind'][:4], r['source'][:40].ljust(40), r['discovered'], r['net_new'], r['gated'], r['readable'], r['PASS'], r['HOLD'], r['REJECT'], r['contacts'])


if __name__ == '__main__':
    main()
