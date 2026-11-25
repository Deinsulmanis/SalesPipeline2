"""Franchise owners, final step (owner decision 2026-11-25): per-brand outcome, copy evidence from the office's own
postings, the owner's to_verify.csv and the Express test wave. Free; writes nothing to production.

Usage: python3 -I franchise_select.py <run> [--wave 25]

Inputs: <run>/owners.json (franchise_owners.py), <run>/location_icp.json + <run>/express_offices.json (express_offices.py)
Writes:
  <run>/franchise_leads.json   one record per eligible owner: import-shaped {row, evidence} plus status / wave
  <run>/to_verify.csv          header "email", deduped (GetLeads-sourced: VERIFY_PENDING until the owner verifies)
  <run>/brand_counts.json      per-brand funnel counts
Rules:
  - ICP: brand industrial-capable (franchise_rule) AND the office's own postings pass the job-posting rule
    (express_offices.py). Brands without a location check yet -> HOLD_LOCATION_UNCHECKED.
  - COPY_B: a hands-on posting of the matched office, posted within 30 days (build_evidence.posting_role rules); the
    quote is built from the posting title and its city/state only. The selector re-checks role and city in the quote.
  - franchise identity: brand + owner, territory = brand + office city + state; city = the office's city name.
  - Test wave: Express only, one office match (not a multi-office city), COPY_B evidence, best title first, at most
    2 per state. Everything else stays HELD until the owner reviews replies and bounces after the wave.
"""
import collections
import csv
import json
import os
import re
import sys
from datetime import date

TOOLS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TOOLS)
import franchise_rule as fr  # noqa: E402
import jobs_rule  # noqa: E402

AS_OF = '2026-11-25'
POSTING_DAYS = 30
ROLE_OK = re.compile(r"[A-Za-z][A-Za-z /&]{2,40}")
CITY_OK = re.compile(r"^[A-Z][A-Za-z.']*(?: [A-Z][A-Za-z.']*){0,3}$")
FIRST_OK = re.compile(r"^[A-Za-z][A-Za-z'.]*(?:-[A-Za-z][A-Za-z'.]*)?$")


def posting_role(title):
    """Same rule as build_evidence.posting_role: a clean hands-on role phrase from a posting title, or None."""
    role = re.split(r"\s+[-|:(]|[,(|:]|\s+-$", title or "")[0].strip()
    if not ROLE_OK.fullmatch(role) or len(role.split()) > 5 or role.endswith(("/", "&")):
        return None
    role = re.sub(r"\s*/\s*", "/", role)
    if role.isupper() or role.islower():
        role = role.title()
    return role if jobs_rule.is_hands_on(role) else None


def best_posting(offices, office_city):
    best = None
    for o in offices:
        for p in o.get('postings', []):
            try:
                age = (date.fromisoformat(AS_OF) - date.fromisoformat(p['date'])).days
            except ValueError:
                continue
            cs = jobs_rule.city_state(p.get('location'))
            role = posting_role(p['title'])
            if age < 0 or age > POSTING_DAYS or not cs or not role:
                continue
            cand = {'url': p['url'], 'quote': f"{p['title']} | {cs[0]}, {cs[1]}", 'role': role, 'location': f"{cs[0]}, {cs[1]}",
                    'current': True, 'lastSeen': p['date'], 'source': 'franchise_office_posting'}
            key = (cs[0].lower() == office_city.lower(), p['date'])
            if best is None or key > best[0]:
                best = (key, cand)
    return best[1] if best else None


def main():
    run = sys.argv[1]
    wave_n = int(sys.argv[sys.argv.index('--wave') + 1]) if '--wave' in sys.argv else 25
    owners = json.load(open(os.path.join(run, 'owners.json')))
    loc = json.load(open(os.path.join(run, 'location_icp.json')))
    offices = {o['slug']: o for o in json.load(open(os.path.join(run, 'express_offices.json')))}
    counts = collections.defaultdict(collections.Counter)
    leads = []
    for r in owners:
        b = r['brand'] or 'not_brand'
        counts[b]['exported'] += 1
        if r['status'] != 'OWNER':
            counts[b]['contact_' + r['status']] += 1
            continue
        counts[b]['owner_after_dedupe'] += 1
        if not fr.industrial_capable(b):
            counts[b]['HOLD_BRAND_NOT_INDUSTRIAL'] += 1
            continue
        if b != 'express':
            counts[b]['HOLD_LOCATION_UNCHECKED'] += 1
            leads.append({'status': 'HOLD_LOCATION_UNCHECKED', 'brand': b, 'owner_key': r['owner_key'], 'email': r['work_email']})
            continue
        d = loc.get(r['owner_key'], {'decision': 'HOLD_OFFICE_NOT_FOUND', 'offices': []})
        if d['decision'] != 'INDUSTRIAL':
            counts[b][d['decision']] += 1
            continue
        counts[b]['ICP_PASS_LOCATION'] += 1
        offs = [offices[s] for s in d['offices']]
        city = d.get('office_city') or ''
        st = d.get('office_state') or ''
        ad = best_posting(offs, city)
        first = (r['first_name'] or '').strip().title() if (r['first_name'] or '').isupper() or (r['first_name'] or '').islower() else (r['first_name'] or '').strip()
        problems = []
        if not ad:
            problems.append('no hands-on posting within 30 days with a role and city')
        if not CITY_OK.match(city):
            problems.append('office city is not a plain city name')
        if not FIRST_OK.match(first) or len(first) < 2:
            problems.append('first name is not a plain first name')
        status = 'HOLD_COPY' if problems else 'READY_PENDING_VERIFY'
        counts[b][status] += 1
        leads.append({
            'status': status, 'problems': problems, 'brand': b, 'owner_key': r['owner_key'], 'email': r['work_email'],
            'state': st, 'single_office': len(d['offices']) == 1, 'rank': r['rank'], 'wave': '',
            'row': {'company_name': fr.BRANDS[b]['label'], 'company_domain': r['work_email'].split('@')[1], 'email': r['work_email'],
                    'buyer_title': r['current_title'], 'email_status': 'VERIFY_PENDING', 'contact_status': 'VERIFY_PENDING',
                    'v4_tag': 'V4|PASS|LOW_SIGNAL|NO_ADS_OBSERVED|COPY_TIER_PENDING', 'demand_score': '0',
                    'signal_priority': 'LOW_SIGNAL', 'ad_class': 'NOT_CHECKED',
                    'franchise': {'brand': b, 'owner_key': r['owner_key'], 'territory': fr.territory_key(b, city, st).replace(' ', ''),
                                  'city': city, 'office_slugs': d['offices'], 'office_url': offs[0]['jobs_url'] if offs else ''}},
            'evidence': {'asOf': AS_OF, 'firstName': first, 'contactName': f"{first} {r['last_name'].strip()}".strip(),
                         'company': fr.BRANDS[b]['label'], 'contactStatus': 'VERIFY_PENDING', 'emailResolved': True,
                         'attributionP': 1.0, 'employerAds': [], 'candidateAds': [ad] if ad else [], 'salesHiring': [],
                         'expansion': [], 'leadership': [], 'specialization': None,
                         'signalsNotSearched': ['employer_ads', 'own_company_bd_hiring', 'market_expansion', 'new_commercial_leader']},
        })
    # one owner per brand + territory (two offices in one city share the territory key)
    seen_t = set()
    for l in sorted([l for l in leads if l['status'] == 'READY_PENDING_VERIFY'], key=lambda l: (l['rank'], l['email'])):
        t = l['row']['franchise']['territory']
        if t in seen_t:
            l['status'] = 'HOLD_SAME_TERRITORY'
            counts[l['brand']]['READY_PENDING_VERIFY'] -= 1
            counts[l['brand']]['HOLD_SAME_TERRITORY'] += 1
        seen_t.add(t)
    # test wave: Express, single office, COPY_B evidence, best title first, at most 2 per state
    # round-robin across states (freshest office posting first), at most 2 per state
    ready = [l for l in leads if l['status'] == 'READY_PENDING_VERIFY' and l['brand'] == 'express' and l['single_office']]
    by_state = collections.defaultdict(list)
    for l in sorted(ready, key=lambda l: (l['rank'], l['evidence']['candidateAds'][0]['lastSeen'] if l['evidence']['candidateAds'] else ''),
                    reverse=False):
        by_state[l['state']].append(l)
    for st in by_state:
        by_state[st].sort(key=lambda l: (l['rank'], ''.join(chr(255 - ord(c)) for c in l['evidence']['candidateAds'][0]['lastSeen']), l['email']))
    picked = 0
    for round_ in range(2):
        for st in sorted(by_state, key=lambda st: (-len(by_state[st]), st)):
            if picked < wave_n and len(by_state[st]) > round_:
                by_state[st][round_]['wave'] = 'TEST_WAVE_1'
                picked += 1
    for l in leads:
        if l['status'] == 'READY_PENDING_VERIFY' and not l['wave']:
            l['wave'] = 'HELD_AFTER_TEST'
    emails = sorted({l['email'] for l in leads if l['status'] == 'READY_PENDING_VERIFY'})
    with open(os.path.join(run, 'to_verify.csv'), 'w', newline='') as fh:
        w = csv.writer(fh)
        w.writerow(['email'])
        for e in emails:
            w.writerow([e])
    wave = [l for l in leads if l.get('wave') == 'TEST_WAVE_1']
    summary = {'brands': {b: dict(c) for b, c in counts.items()},
               'test_wave': {'owners': len(wave), 'states': len({l['state'] for l in wave}),
                             'variant_evidence': dict(collections.Counter('COPY_B' if l['evidence']['candidateAds'] else 'none' for l in wave)),
                             'office_city_postings': sum(1 for l in wave if l['evidence']['candidateAds'][0]['location'].split(',')[0].lower() == l['row']['franchise']['city'].lower())},
               'held_after_test': sum(1 for l in leads if l.get('wave') == 'HELD_AFTER_TEST'),
               'to_verify': len(emails)}
    json.dump(leads, open(os.path.join(run, 'franchise_leads.json'), 'w'), indent=1)
    json.dump(summary, open(os.path.join(run, 'brand_counts.json'), 'w'), indent=1)
    print(json.dumps(summary, indent=1))


if __name__ == '__main__':
    main()
