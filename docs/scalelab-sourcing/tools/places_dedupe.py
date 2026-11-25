"""Google Maps (GetLeads places) export -> net-new companies (owner brief 2026-11-25). Free; reads files only.

Usage: python3 -I places_dedupe.py <run>

Inputs:
  <run>/raw/<keyword>.csv     GetLeads export_places CSVs (one per business_name keyword)
  <run>/prod_domains.json     every production domain, all clients (website host, email domain, profile domain)
Kept per location: business name, website domain, city, state, phone, listed emails (company records only).
Steps:
  1. Normalize to the website root domain. No website / social / directory / .gov / .edu -> dropped.
  2. Franchise brands (franchise_rule.py) are keyed by brand + city, never by domain -> franchise flow (HELD).
     Corporate chains and franchisor sites are excluded.
  3. The rest is deduped against the FULL exclusion set (exclusion_domains below): production (all clients, so Jole
     domains are excluded too and never used), every run's companies / exclusions, the V4 master, every enrichment
     list and result, the franchise runs, and the 300 places rows sampled on 2026-11-24.
  4. Clearly off-ICP names (IT, healthcare, legal, executive search: discover_merge.OFF_ICP) -> dropped.
Writes <run>/locations.json, <run>/net_new.json, <run>/companies.json (crawl input), <run>/franchise_locations.json,
<run>/dedupe_counts.json (per keyword: locations -> unique domains -> net-new).
"""
import collections
import csv
import glob
import json
import os
import re
import sys

TOOLS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TOOLS)
import franchise_rule as fr  # noqa: E402

ROOT_DIR = os.path.abspath(os.path.join(TOOLS, '..', '..', '..'))
PRIVATE = os.path.join(ROOT_DIR, 'runs-private')
SCRATCH_GLOB = '/tmp/claude-0/*/*/scratchpad/*/companies.json'
NOT_COMPANY = re.compile(r'(^|\.)(facebook|linkedin|indeed|google|instagram|yelp|wixsite|business\.site|godaddysites|square\.site|'
                         r'linktr\.ee|ziprecruiter|glassdoor|bbb|mapquest|yellowpages)\.|\.(gov|edu|mil|us)$|^sites\.google\.com$')
OFF_ICP = re.compile(r"\b(software|infotech|it solutions|it services|it staffing|cyber|nurs\w*|medical|health\w*|dental|"
                     r"pharma\w*|clinical|therap\w*|home care|homecare|caregiv\w*|senior care|legal|attorney\w*|paralegal|"
                     r"executive search|accounting|cpa|locum\w*)\b")


def root(d):
    d = (d or '').strip().lower()
    d = re.sub(r'^https?://', '', d).split('/')[0].split(':')[0].split('?')[0]
    return d[4:] if d.startswith('www.') else d


def exclusion_domains(run):
    ex = set(json.load(open(os.path.join(run, 'prod_domains.json'))))
    for f in glob.glob(os.path.join(PRIVATE, '*', 'exclude_domains.json')):
        try:
            ex |= set(json.load(open(f)))
        except Exception:
            pass
    for f in glob.glob(os.path.join(PRIVATE, '*', 'companies.json')) + glob.glob(SCRATCH_GLOB):
        if os.path.abspath(os.path.dirname(f)) == os.path.abspath(run):
            continue
        try:
            ex |= {root(c.get('domain')) for c in json.load(open(f))}
        except Exception:
            pass
    master = os.path.join(ROOT_DIR, 'docs', 'scalelab-sourcing', 'runs', 'V4_APPROVED_CONTACTS_MASTER.csv')
    if os.path.exists(master):
        ex |= {root(r.get('company_domain')) for r in csv.DictReader(open(master))}
    for f in glob.glob(os.path.join(PRIVATE, 'enrich-lists*', '**', '*.csv'), recursive=True):
        try:
            for r in csv.DictReader(open(f, encoding='utf-8-sig')):
                for k in ('domain', 'company_domain', 'source_domain', 'Company Domain', 'website'):
                    if r.get(k):
                        ex.add(root(r[k]))
                e = r.get('email') or r.get('Email') or ''
                if '@' in e:
                    ex.add(e.split('@')[1].lower())
        except Exception:
            pass
    sample = os.path.join(PRIVATE, 'places-pilot-2026-11-24', 'places_sample.json')
    if os.path.exists(sample):
        ex |= {r['domain'] for r in json.load(open(sample)) if r.get('domain')}
    ex.discard('')
    return ex


def main():
    run = sys.argv[1]
    locs = []
    for path in sorted(glob.glob(os.path.join(run, 'raw', '*.csv'))):
        kw = os.path.basename(path)[:-4]
        for x in csv.DictReader(open(path, encoding='utf-8-sig')):
            emails = [x.get(k, '').strip().lower() for k in ['Primary Email'] + [f'Email {i}' for i in range(2, 9)] if x.get(k, '').strip()]
            locs.append({'keyword': kw, 'name': x.get('Business Name', '').strip(), 'domain': root(x.get('Website')),
                         'city': x.get('City', '').strip(), 'state': x.get('State', '').strip(), 'phone': x.get('Phone', '').strip(),
                         'emails': emails, 'category': x.get('Category', '').strip()})
    ex = exclusion_domains(run)
    counts = collections.defaultdict(collections.Counter)
    net, franchise, seen_dom = {}, {}, {}
    for loc in locs:
        kw, d = loc['keyword'], loc['domain']
        c = counts[kw]
        c['locations'] += 1
        if not d or NOT_COMPANY.search(d):
            c['no_company_site'] += 1
            continue
        kind, brand = fr.classify_company(loc['name'], d)
        block = fr.chain_block(loc['name'], d)
        if kind == 'FRANCHISE' and block != 'franchisor_hq':
            key = fr.territory_key(brand, loc['city'], loc['state'])
            if key not in franchise:
                franchise[key] = {'brand': brand, 'city': loc['city'], 'state': loc['state'], 'domain': d, 'keyword': kw,
                                  'status': 'HELD_FRANCHISE_FLOW'}
                c['franchise_locations'] += 1
            else:
                c['franchise_dup_location'] += 1
            continue
        if block in ('corporate_chain', 'franchisor_hq'):
            c[block] += 1
            continue
        if d in seen_dom:
            c['dup_domain_in_export'] += 1
            continue
        seen_dom[d] = kw
        c['unique_domains'] += 1
        if d in ex:
            c['already_known'] += 1
            continue
        if OFF_ICP.search(fr.norm(loc['name'])):
            c['off_icp_name'] += 1
            continue
        if fr.FRANCHISOR.search(fr.norm(loc['name'])):
            c['franchisor_hq'] += 1
            continue
        net[d] = {'domain': d, 'company_name': loc['name'], 'keyword': kw, 'city': loc['city'], 'state': loc['state'],
                  'phone': loc['phone'], 'emails': loc['emails']}
        c['net_new'] += 1
    comps = [{'domain': r['domain'], 'company_name': r['company_name'], 'hq_city': r['city'], 'hq_state': r['state'],
              'hq_country': 'United States', 'employee_band': '', 'industry': 'Staffing (Google Maps)',
              'source_desc': f"GetLeads places keyword '{r['keyword']}'", 'source_id': 'places_kw:' + r['keyword'],
              'batch': 'PLACES_KW', 'intent_ads': None, 'pre_gate': None, 'pre_reason': '', 'dedupe_status': 'NET_NEW',
              'groups': ['PLACES_' + r['keyword'].upper()]} for r in net.values()]
    json.dump(locs, open(os.path.join(run, 'locations.json'), 'w'), indent=1)
    json.dump(list(net.values()), open(os.path.join(run, 'net_new.json'), 'w'), indent=1)
    json.dump(comps, open(os.path.join(run, 'companies.json'), 'w'), indent=1)
    json.dump(list(franchise.values()), open(os.path.join(run, 'franchise_locations.json'), 'w'), indent=1)
    json.dump({k: dict(v) for k, v in counts.items()}, open(os.path.join(run, 'dedupe_counts.json'), 'w'), indent=1)
    print('exclusion set', len(ex))
    for kw, c in sorted(counts.items(), key=lambda kv: -kv[1]['locations']):
        print(kw, dict(c))
    print('net-new total', len(net), '| franchise locations', len(franchise))


if __name__ == '__main__':
    main()
