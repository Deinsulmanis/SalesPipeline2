"""Labor Finders franchise expansion (owner brief 2026-11-25), held behind the Express test wave.

laborfinders.com disallows crawling (robots.txt "Disallow: /"), so owner names come from a GetLeads search_contacts
export instead (owner decision 2026-11-25): company "Labor Finders", US, titles owner / franchise owner / co-owner /
president / general manager / branch manager / area / operations manager.

Usage: python3 -I franchise_lf_names.py <franchise run> <places run>
Rules (franchise_rule.py):
  - brand must be Labor Finders; franchisor HQ (Palm Beach Gardens / "International") and corporate roles dropped;
  - territory = the Labor Finders Google Maps location city in the person's state when it matches, else their city;
  - one contact per owner (brand + owner key); one per territory, best role first:
    owner / franchisee / president > general manager > branch / operations / area manager;
  - deduped against the Labor Finders owners already exported, production, and names already sent to enrichment.
Writes (private):
  <run>/owner_names_laborfinders.csv   first_name,last_name,company_name ("Labor Finders {city}"),company_domain
                                       = people still needing GetLeads Names + companies enrichment (no VALID email)
  <run>/to_verify_laborfinders.csv     email (people whose export email is VALID: owner verifies, VERIFY_PENDING)
  <run>/laborfinders_selected.json     the selection with role, territory and status (HELD_BEHIND_EXPRESS_WAVE)
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

PRIVATE = os.path.abspath(os.path.join(TOOLS, '..', '..', '..', 'runs-private'))
STATE = {'alabama': 'AL', 'arkansas': 'AR', 'arizona': 'AZ', 'california': 'CA', 'colorado': 'CO', 'florida': 'FL', 'georgia': 'GA',
         'iowa': 'IA', 'idaho': 'ID', 'illinois': 'IL', 'indiana': 'IN', 'kansas': 'KS', 'kentucky': 'KY', 'louisiana': 'LA',
         'mississippi': 'MS', 'missouri': 'MO', 'north carolina': 'NC', 'nebraska': 'NE', 'new mexico': 'NM', 'nevada': 'NV',
         'ohio': 'OH', 'oklahoma': 'OK', 'oregon': 'OR', 'south carolina': 'SC', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT',
         'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV', 'wisconsin': 'WI', 'michigan': 'MI', 'minnesota': 'MN',
         'maryland': 'MD', 'pennsylvania': 'PA', 'new york': 'NY', 'new jersey': 'NJ', 'south dakota': 'SD', 'north dakota': 'ND',
         'montana': 'MT', 'wyoming': 'WY', 'delaware': 'DE', 'connecticut': 'CT', 'massachusetts': 'MA'}
GM = r'\bgeneral manager\b'
MANAGER = r'\b(branch|operations|area|regional)\b.*\bmanager\b|\bbranch manager\b'


def role_rank(title):
    r = fr.title_rank(title)
    if r < 9:
        return r  # owner / franchisee / co-owner / president
    t = fr.norm(title)
    if re.search(GM, t):
        return 5
    if re.search(MANAGER, t):
        return 6
    return 9


def main():
    run, places = sys.argv[1], sys.argv[2]
    rows = list(csv.DictReader(open(os.path.join(run, 'raw_lf', 'laborfinders_all_titles.csv'))))
    locs = [l for l in json.load(open(os.path.join(places, 'franchise_locations.json'))) if l['brand'] == 'labor_finders']
    loc_by_state = collections.defaultdict(set)
    for l in locs:
        loc_by_state[l['state'].upper()].add(l['city'].strip())
    prior = {r['owner_key'] for r in json.load(open(os.path.join(run, 'owners.json'))) if r.get('brand') == 'labor_finders'}
    prior_emails = {r['work_email'] for r in json.load(open(os.path.join(run, 'owners.json'))) if r.get('brand') == 'labor_finders'}
    prod = json.load(open(os.path.join(run, 'prod_matches.json')))
    prior_emails |= set(prod.get('emails', []))
    prior |= set(prod.get('owner_keys', []))
    enriched = set()
    for f in glob.glob(os.path.join(PRIVATE, 'enrich-lists*', '**', '*.csv'), recursive=True):
        try:
            for r in csv.DictReader(open(f, encoding='utf-8-sig')):
                fn = r.get('first_name') or r.get('First Name') or ''
                ln = r.get('last_name') or r.get('Last Name') or ''
                co = (r.get('company_name') or r.get('Company Name') or '') + ' ' + (r.get('company_domain') or r.get('domain') or '')
                if fn and ln and re.search(r'labor ?finders', co.lower()):
                    enriched.add(fr.owner_key('labor_finders', fn, ln))
        except Exception:
            pass
    counts = collections.Counter()
    cands = []
    for x in rows:
        counts['exported'] += 1
        email = (x.get('work_email') or '').strip().lower()
        brand = fr.brand_of(x['company_name'], x.get('current_employer'), x.get('linkedin_headline'), email=email)
        if brand != 'labor_finders':
            counts['drop_not_brand'] += 1
            continue
        title, head = x['current_title'].strip(), x.get('linkedin_headline', '')
        t = fr.norm(title)
        city, state = x.get('contact_city', '').strip(), x.get('contact_state', '').strip()
        if re.search(fr.CORPORATE_ROLE, t):
            counts['drop_corporate_role'] += 1
            continue
        hq_city, hq_state = fr.BRANDS['labor_finders']['hq']
        if re.search(r'international|headquarters|corporate', fr.norm(head + ' ' + x['company_name'])) or \
                (city.lower() == hq_city and state.lower() == hq_state):
            counts['drop_franchisor_hq'] += 1
            continue
        rank = role_rank(title)
        if rank == 9:
            counts['drop_other_title'] += 1
            continue
        if x.get('contact_country') and x['contact_country'] != 'United States':
            counts['drop_non_us'] += 1
            continue
        st = STATE.get(state.lower(), state.upper()[:2])
        terr_city = next((c for c in loc_by_state.get(st, []) if c.lower() == city.lower()), '')
        cands.append({'first': x['first_name'].strip(), 'last': x['last_name'].strip(), 'title': title, 'rank': rank,
                      'email': email, 'email_status': x.get('email_status', ''), 'city': terr_city or city, 'state': st,
                      'territory_matched': bool(terr_city),
                      'owner_key': fr.owner_key('labor_finders', x['first_name'], x['last_name'])})
    sel, seen_owner, seen_terr = [], set(), set()
    for c in sorted(cands, key=lambda c: (c['rank'], not c['territory_matched'], c['email_status'] != 'VALID', c['owner_key'])):
        if c['owner_key'] in prior or (c['email'] and c['email'] in prior_emails):
            counts['dup_already_exported_or_production'] += 1
            continue
        if c['owner_key'] in enriched:
            counts['dup_already_enriched'] += 1
            continue
        if c['owner_key'] in seen_owner:
            counts['dup_same_person'] += 1
            continue
        seen_owner.add(c['owner_key'])
        terr = fr.territory_key('labor_finders', c['city'], c['state'])
        if not c['city']:
            counts['drop_no_city'] += 1
            continue
        if terr in seen_terr:
            counts['held_same_territory'] += 1
            continue
        seen_terr.add(terr)
        c['territory'] = terr.replace(' ', '')
        c['status'] = 'HELD_BEHIND_EXPRESS_WAVE'
        sel.append(c)
    need_enrich = [c for c in sel if c['email_status'] != 'VALID']
    have_valid = [c for c in sel if c['email_status'] == 'VALID']
    with open(os.path.join(run, 'owner_names_laborfinders.csv'), 'w', newline='') as fh:
        w = csv.writer(fh)
        w.writerow(['first_name', 'last_name', 'company_name', 'company_domain'])
        for c in need_enrich:
            w.writerow([c['first'], c['last'], f"Labor Finders {c['city']}", 'laborfinders.com'])
    with open(os.path.join(run, 'to_verify_laborfinders.csv'), 'w', newline='') as fh:
        w = csv.writer(fh)
        w.writerow(['email'])
        for e in sorted({c['email'] for c in have_valid}):
            w.writerow([e])
    json.dump(sel, open(os.path.join(run, 'laborfinders_selected.json'), 'w'), indent=1)
    roles = collections.Counter('owner/president' if c['rank'] < 5 else 'general manager' if c['rank'] == 5 else 'branch/ops manager' for c in sel)
    summary = {'counts': dict(counts), 'selected': len(sel), 'roles': dict(roles),
               'territory_matched_to_maps_location': sum(c['territory_matched'] for c in sel),
               'maps_locations': len(locs), 'maps_cities_covered': len({c['territory'] for c in sel if c['territory_matched']}),
               'csv_rows_need_enrichment': len(need_enrich), 'to_verify_valid_emails': len(have_valid)}
    json.dump(summary, open(os.path.join(run, 'laborfinders_counts.json'), 'w'), indent=1)
    print(json.dumps(summary, indent=1))


if __name__ == '__main__':
    main()
