"""Free GetLeads jobs sweep (leak audit 2026-11-26): staffing agencies hiring for hands-on industrial titles in the US.

Usage: python3 -I jobs_sweep.py <out_dir> <transcript|dir> [...]
Reads every search_jobs call (title_keywords + company_name keyword, group_by company, posted_since 60 days) from helper
transcripts (jobs_rule.collect), keeps company rows with a domain, applies jobs_discover.py's free name/domain filters
(non-US TLD, public bodies, direct employers on weak keywords), and splits net-new vs known against the full exclusion
set (places_dedupe.exclusion_domains: production, every run, V4 master, enrichment lists) plus every gated domain.
Writes <out>/jobs_sweep_raw.json, <out>/jobs_sweep_counts.json and <out>/jobs_sweep_netnew.csv
(company_domain, company_name, postings, titles, keywords) for the owner's own GetLeads run.
"""
import collections
import csv
import glob
import importlib.util
import json
import os
import sys

TOOLS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TOOLS)
from jobs_rule import collect, root  # noqa: E402


def load(name, argv):
    spec = importlib.util.spec_from_file_location(name, os.path.join(TOOLS, name + '.py'))
    old, sys.argv = sys.argv, argv
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    sys.argv = old
    return m


def drop_reason(jd, d, name, keywords):
    """The same free filters as jobs_discover.py (kept in step with it)."""
    tld = d.rsplit('.', 1)[-1]
    if d.endswith(('.co.uk', '.com.au', '.co.nz', '.com.mx', '.co.in')) or (len(tld) == 2 and tld not in ('us', 'co', 'io', 'ai', 'me')) \
            or (len(tld) > 2 and tld not in jd.US_TLDS):
        return 'NON_US_DOMAIN'
    if d in jd.DIRECT_EMPLOYERS or any(d.endswith('.' + x) for x in jd.DIRECT_EMPLOYERS):
        return 'DIRECT_EMPLOYER'
    if jd.PUBLIC.search(name):
        return 'PUBLIC_BODY_UNION_OR_SCHOOL'
    if set(keywords) <= jd.WEAK and not (jd.STAFFING_WORD.search(name) or jd.STAFFING_DOMAIN.search(d)) and jd.NON_STAFFING_INDUSTRY.search(name):
        return 'KEYWORD_ONLY_DIRECT_EMPLOYER'
    return None


def main():
    out = sys.argv[1]
    calls = [c for c in collect(sys.argv[2:]) if c['input'].get('group_by') == 'company' and c['input'].get('title_keywords')]
    jd = load('jobs_discover', ['jobs_discover.py', out])
    pdd = load('places_dedupe', ['places_dedupe.py', out])
    excl = set(pdd.exclusion_domains(out))
    latest = json.load(open(os.path.join(out, 'latest_decisions.json')))
    excl |= set(latest)
    comp = {}
    qcount = collections.Counter()
    for c in calls:
        q = ' '.join(c['input']['title_keywords'])
        kw = c['input'].get('company_name', '')
        rows = (c.get('result') or {}).get('data') or []
        qcount[(q, kw)] += len(rows)
        for r in rows:
            d = root(r.get('company_domain') or '')
            if not d:
                continue
            x = comp.setdefault(d, {'domain': d, 'name': r.get('company_name') or '', 'postings': 0, 'titles': set(), 'keywords': set()})
            x['postings'] += r.get('role_count') or 0
            x['titles'].add(q)
            x['keywords'].add(kw)
    keep, drop = {}, collections.Counter()
    for d, x in comp.items():
        why = drop_reason(jd, d, x['name'], x['keywords'])
        if why:
            drop[why] += 1
            continue
        keep[d] = x
    netnew = {d: x for d, x in keep.items() if d not in excl}
    counts = {'calls': len(calls), 'company_rows_with_domain': len(comp), 'after_free_filters': len(keep),
              'filtered_out': dict(drop), 'known_already': len(keep) - len(netnew), 'net_new': len(netnew),
              'postings_total': sum(x['postings'] for x in keep.values()),
              'by_title_unique_domains': dict(collections.Counter(t for x in keep.values() for t in x['titles']).most_common()),
              'net_new_by_title': dict(collections.Counter(t for x in netnew.values() for t in x['titles']).most_common())}
    json.dump({d: dict(x, titles=sorted(x['titles']), keywords=sorted(x['keywords'])) for d, x in comp.items()},
              open(os.path.join(out, 'jobs_sweep_raw.json'), 'w'), indent=1)
    json.dump(counts, open(os.path.join(out, 'jobs_sweep_counts.json'), 'w'), indent=1)
    with open(os.path.join(out, 'jobs_sweep_netnew.csv'), 'w', newline='') as fh:
        w = csv.writer(fh)
        w.writerow(['company_domain', 'company_name', 'industrial_postings_60d', 'titles', 'found_by_keyword'])
        for x in sorted(netnew.values(), key=lambda x: -x['postings']):
            w.writerow([x['domain'], x['name'], x['postings'], '; '.join(sorted(x['titles'])), '; '.join(sorted(x['keywords']))])
    print(json.dumps({k: v for k, v in counts.items() if not k.startswith('by_') and not k.startswith('net_new_by')}, indent=1))


if __name__ == '__main__':
    main()
