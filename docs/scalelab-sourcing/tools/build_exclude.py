"""Stage 1: build <run>/exclude_domains.json ({domain: why}) before discovery. Free, no network.

Usage:  python3 -I build_exclude.py <run> --master <master.csv> --runs <earlier run dir> [<dir> ...]

Inputs:
  <run>/prod_domains.json   list of production domains (website + email domains, all clients), parsed
                            from the stage-1 Supabase query in the skill.
  --master                  the V4 approved-contacts master (company and email domains).
  --runs                    earlier run working folders. From each: companies.json domains, the final
                            redirect host of every cached page (sitecache/, sitecache2/, pwcache/), email
                            domains in reveal/*.rows, and any exclude_domains.json it carried (inherited
                            with its original reason). discovery_overflow.json is NOT read: overflow was
                            never researched or paid for, so it may be re-found.

Output: <run>/exclude_domains.json, and counts per reason on stdout.
"""
import collections
import csv
import glob
import json
import os
import re
import sys

RUN = sys.argv[1]
args = sys.argv[2:]
MASTER = args[args.index('--master') + 1] if '--master' in args else None
RUNS = []
if '--runs' in args:
    for a in args[args.index('--runs') + 1:]:
        if a.startswith('--'):
            break
        RUNS.append(a)


def root(d):
    d = (d or '').strip().lower()
    d = re.sub(r'^https?://', '', d).split('/')[0].split(':')[0].split('?')[0]
    return d[4:] if d.startswith('www.') else d


ex = {}


def add(d, why):
    d = root(d)
    if d and '.' in d and d not in ex:
        ex[d] = why


for d in json.load(open(os.path.join(RUN, 'prod_domains.json'))):
    add(d, 'production')
if MASTER and os.path.exists(MASTER):
    for r in csv.DictReader(open(MASTER)):
        add(r.get('company_domain'), 'research: V4 master')
        add((r.get('email') or '').split('@')[-1], 'research: V4 master email domain')
for rd in RUNS:
    tag = os.path.basename(os.path.normpath(rd))
    p = os.path.join(rd, 'exclude_domains.json')
    if os.path.exists(p):
        for d, why in json.load(open(p)).items():
            add(d, why)
    p = os.path.join(rd, 'companies.json')
    if os.path.exists(p):
        for c in json.load(open(p)):
            add(c.get('domain'), f'research: {tag}')
    for sub in ('sitecache', 'sitecache2', 'pwcache'):
        for f in glob.glob(os.path.join(rd, sub, '*.json')):
            try:
                pages = json.load(open(f)).get('pages') or []
            except (ValueError, OSError, AttributeError):
                continue
            for pg in pages[:1]:
                add(pg.get('final_url'), f'research: {tag} redirect host')
    for f in glob.glob(os.path.join(rd, 'reveal*', '*.rows')):
        for line in open(f, errors='replace'):
            x = line.rstrip('\n').split('|')
            if len(x) > 6 and '@' in x[6]:
                add(x[6].split('@')[-1], f'research: {tag} email domain')

json.dump(ex, open(os.path.join(RUN, 'exclude_domains.json'), 'w'), indent=0, sort_keys=True)
print(len(ex), dict(collections.Counter(v.split(':')[0] for v in ex.values())))
