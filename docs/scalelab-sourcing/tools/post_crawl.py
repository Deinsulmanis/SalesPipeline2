"""Stage 4 follow-up (free): redirect duplicates, reserve backfill and the thin-site lists for pw_fetch.js.

Usage: python3 -I post_crawl.py <run> [--backfill] [--workers 6] [--thin-chars 1500]

1. A company whose homepage finally redirects to a host that is already in exclude_domains.json, or to
   another company's domain in this run, is a duplicate: pre_gate "REJECT", pre_reason DUPLICATE_REDIRECT.
2. --backfill appends the same number of companies from discovery_overflow.json (in its round-robin
   order) so the run stays at N, and removes them from the overflow. Crawl again afterwards: cached
   sites are skipped.
3. Writes thin_<i>.txt (space-separated domains, one file per worker) for every crawled company still
   in play whose pages hold fewer than --thin-chars characters and that is not already in pwcache/.
"""
import collections
import json
import os
import re
import sys

RUN = sys.argv[1]
WORKERS = int(sys.argv[sys.argv.index('--workers') + 1]) if '--workers' in sys.argv else 6
THIN = int(sys.argv[sys.argv.index('--thin-chars') + 1]) if '--thin-chars' in sys.argv else 1500


def root(d):
    d = re.sub(r'^https?://', '', (d or '').strip().lower()).split('/')[0].split(':')[0]
    return d[4:] if d.startswith('www.') else d


def load(dom):
    p = os.path.join(RUN, 'sitecache', dom + '.json')
    if not os.path.exists(p):
        return None
    try:
        return json.load(open(p))
    except ValueError:
        return None


comps = json.load(open(os.path.join(RUN, 'companies.json')))
exclude = json.load(open(os.path.join(RUN, 'exclude_domains.json')))
run_doms = {c['domain'] for c in comps}
stats = collections.Counter()
seen_hosts = {}
newly = 0
for c in comps:
    if c['pre_gate'] is not None:
        continue
    rec = load(c['domain'])
    if rec is None:
        stats['not_crawled'] += 1
        continue
    pages = rec.get('pages') or []
    host = root(pages[0].get('final_url')) if pages else ''
    if host and host != c['domain']:
        why = None
        if host in exclude:
            why = f'DUPLICATE_REDIRECT: redirects to {host} ({exclude[host].split(":")[0]})'
        elif host in run_doms or host in seen_hosts:
            why = f'DUPLICATE_REDIRECT: redirects to {host}, another company in this run'
        if why:
            c['pre_gate'], c['pre_reason'] = 'REJECT', why
            stats['duplicate_redirect'] += 1
            newly += 1
            continue
        seen_hosts[host] = c['domain']
    chars = sum(len(p.get('text') or '') for p in pages)
    stats['readable' if chars >= THIN else 'thin'] += 1

if '--backfill' in sys.argv and newly:
    ov_path = os.path.join(RUN, 'discovery_overflow.json')
    ov = json.load(open(ov_path))
    take, keep = ov[:newly], ov[newly:]
    for r in take:
        comps.append(dict(domain=r['domain'], company_name=r['company_name'], hq_city='', hq_state=r['slice'],
                          hq_country='United States', employee_band='11-500 (Apollo filter)', industry='Staffing (Apollo tag)',
                          source_desc='', source_id=r['source_id'], batch=r['batch'], intent_ads=None, pre_gate=None,
                          pre_reason='', dedupe_status='NEW', groups=r.get('groups', []), backfill=True))
    json.dump(keep, open(ov_path, 'w'), indent=1)
    stats['backfilled'] = len(take)

json.dump(comps, open(os.path.join(RUN, 'companies.json'), 'w'), indent=1)

pw = os.path.join(RUN, 'pwcache')
thin = []
for c in comps:
    if c['pre_gate'] is not None or os.path.exists(os.path.join(pw, c['domain'] + '.json')):
        continue
    rec = load(c['domain'])
    if rec is not None and sum(len(p.get('text') or '') for p in rec.get('pages') or []) < THIN:
        thin.append(c['domain'])
for i in range(WORKERS):
    open(os.path.join(RUN, f'thin_{i}.txt'), 'w').write(' '.join(thin[i::WORKERS]))
stats['thin_for_headless'] = len(thin)
stats['in_play'] = sum(1 for c in comps if c['pre_gate'] is None)
print(dict(stats))
