"""Illinois registry agencies with resolved domains -> net-new companies for the crawl (owner brief 2026-11-25). Free.

Usage: python3 -I il_dedupe.py <run>
Inputs: <run>/agencies.json, <run>/domains_apollo.json, <run>/web_result*.json (optional), <run>/prod_domains.json
Franchise brands / franchisor sites -> franchise flow (held) by brand + city; corporate chains excluded; the rest deduped
against the full exclusion set (places_dedupe.exclusion_domains: production for all clients, every run, V4 master,
enrichment lists, the places samples). Off-ICP names dropped.
Writes <run>/companies.json (net-new, crawl input), <run>/il_counts.json, <run>/il_franchise.json.
"""
import collections
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import franchise_rule as fr  # noqa: E402
import places_dedupe as pd  # noqa: E402


def main():
    run = sys.argv[1]
    ag = json.load(open(os.path.join(run, 'agencies.json')))
    dom = {k: v['domain'] for k, v in json.load(open(os.path.join(run, 'domains_apollo.json'))).items()}
    src = {k: 'apollo_lookup' for k in dom}
    for f in sorted(glob.glob(os.path.join(run, 'web_result*.json'))):
        for r in json.load(open(f)):
            if r.get('domain') and r.get('confidence') in ('high', 'medium') and r['name'] not in dom:
                dom[r['name']] = pd.root(r['domain'])
                src[r['name']] = 'web_search'
    ex = pd.exclusion_domains(run)
    c = collections.Counter()
    seen, net, fran = set(), [], []
    for a in ag:
        c['company_rows'] += 1
        if a['key'] in seen:
            c['dup_name'] += 1
            continue
        seen.add(a['key'])
        c['unique_agencies'] += 1
        route = a.get('route')
        if route == 'CORPORATE_CHAIN':
            c['corporate_chain'] += 1
            continue
        if route == 'FRANCHISE_FLOW':
            kind, brand = fr.classify_company(a['name'])
            fran.append({'brand': brand, 'name': a['name'], 'city': a['city'], 'state': a['state'],
                         'il_branches': sum(1 for b in a['branches'] if b['state'] == 'IL'), 'status': 'HELD_FRANCHISE_FLOW'})
            c['franchise_flow'] += 1
            continue
        d = dom.get(a['name'])
        if not d:
            c['no_domain'] += 1
            continue
        c['domain_found_' + src[a['name']]] += 1
        block = fr.chain_block(a['name'], d)
        if block:
            c[block] += 1
            continue
        if pd.NOT_COMPANY.search(d):
            c['not_company_site'] += 1
            continue
        if d in seen:
            c['dup_domain'] += 1
            continue
        seen.add(d)
        if d in ex:
            c['already_known'] += 1
            continue
        if pd.OFF_ICP.search(fr.norm(a['name'])):
            c['off_icp_name'] += 1
            continue
        c['net_new'] += 1
        net.append({'domain': d, 'company_name': a['name'], 'hq_city': a['city'], 'hq_state': a['state'],
                    'hq_country': 'United States', 'employee_band': '', 'industry': 'Staffing (IL DTLSA registry)',
                    'source_desc': 'Illinois DTLSA registered agencies as of 2026-11-02', 'source_id': 'il_dtlsa:' + src[a['name']],
                    'batch': 'IL_REGISTRY', 'intent_ads': None, 'pre_gate': None, 'pre_reason': '', 'dedupe_status': 'NET_NEW',
                    'groups': ['IL_REGISTRY'], 'il_branches': sum(1 for b in a['branches'] if b['state'] == 'IL')})
    json.dump(net, open(os.path.join(run, 'companies.json'), 'w'), indent=1)
    json.dump(fran, open(os.path.join(run, 'il_franchise.json'), 'w'), indent=1)
    json.dump(dict(c), open(os.path.join(run, 'il_counts.json'), 'w'), indent=1)
    print(dict(c))


if __name__ == '__main__':
    main()
