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


LEAD_NOISE = re.compile(r"^(?:(?:all shifts?|1st|2nd|3rd|first|second|third|night|day|weekend)\s+shifts?\s+|all shifts\s+|temporary\s+|temp\s+|"
                        r"temp[- ]to[- ]hire\s+|seasonal\s+|senior\s+|sr\.?\s+|junior\s+|jr\.?\s+|entry[- ]level\s+|lead\s+(?=\w+\s+\w)|"
                        r"now hiring\s+|hiring\s+|immediate(?:ly)?\s+)+", re.I)
TAIL_NOISE = re.compile(r"\s+(?:i{1,3}|iv|level\s*\d|[1-4])$", re.I)
SMALL = {"and", "of", "or", "the"}


def tidy_role(role):
    """Readable role phrase that is still a word-for-word part of the posting title: no shift/level/temporary words,
    singular last word, title case ('Warehouse Associates' -> 'Warehouse Associate')."""
    r = TAIL_NOISE.sub("", LEAD_NOISE.sub("", role.strip())).strip()
    words = r.split()
    if words and len(words[-1]) > 3 and words[-1].lower().endswith("s") and not words[-1].lower().endswith(("ss", "us", "is")):
        words[-1] = words[-1][:-1]
    out = []
    cap = lambda w: w if (w.isupper() and len(w) <= 4) or w.lower() in SMALL else w[:1].upper() + w[1:].lower()
    for w in words:
        out.append('/'.join(cap(x) for x in w.split('/')))
    return " ".join(out)


def posting_role(title):
    """Same rule as build_evidence.posting_role (a clean hands-on role phrase from a posting title, or None), then tidied.
    Returns (role, multi) where multi marks a title naming several roles (and / & / slash): used only if nothing else."""
    role = re.split(r"\s+[-|:(]|[,(|:]|\s+-$", title or "")[0].strip()
    if not ROLE_OK.fullmatch(role) or len(role.split()) > 5 or role.endswith(("/", "&")):
        return None, False
    role = tidy_role(re.sub(r"\s*/\s*", "/", role))
    if not role or not jobs_rule.is_hands_on(role):
        return None, False
    return role, bool(re.search(r"\band\b|&|/", role))


def tidy_city(c):
    return re.sub(r"\bMc([a-z])", lambda m: "Mc" + m.group(1).upper(), c)


def best_posting(offices, office_city):
    best = None
    for o in offices:
        for p in o.get('postings', []):
            try:
                age = (date.fromisoformat(AS_OF) - date.fromisoformat(p['date'])).days
            except ValueError:
                continue
            cs = jobs_rule.city_state(p.get('location'))
            role, multi = posting_role(p['title'])
            if age < 0 or age > POSTING_DAYS or not cs or not role:
                continue
            city = tidy_city(cs[0])
            cand = {'url': p['url'], 'quote': f"{p['title']} | {city}, {cs[1]}", 'role': role, 'location': f"{city}, {cs[1]}",
                    'current': True, 'lastSeen': p['date'], 'source': 'franchise_office_posting'}
            # single-role titles first, then a posting in the office's own city, then the freshest
            key = (not multi, cs[0].lower() == office_city.lower(), p['date'])
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
    # owner verification (verified_results.csv from GetLeads, owner decision 2026-11-25): VALID -> READY;
    # catch-all, unknown, risky or invalid -> HOLD (no franchise catch-alls in the test wave)
    vpath = os.path.join(run, 'verified_results.csv')
    verified = {}
    if os.path.exists(vpath):
        for x in csv.DictReader(open(vpath)):
            v = (x.get('validity') or x.get('status') or '').strip().lower()
            if (x.get('is_domain_catchall') or '').strip().lower() == 'true' and v == 'valid':
                v = 'catch_all'
            verified[(x.get('email') or '').strip().lower()] = v
    for l in leads:
        if l['status'] != 'READY_PENDING_VERIFY' or l['email'] not in verified:
            continue
        v = verified[l['email']]
        counts[l['brand']]['READY_PENDING_VERIFY'] -= 1
        if v == 'valid':
            l['status'] = 'READY'
            l['row'].update(email_status='VALID', contact_status='READY_FOR_REVIEW')
            l['evidence']['contactStatus'] = 'READY_FOR_REVIEW'
        else:
            l['status'] = 'HOLD_VERIFY_' + re.sub(r'[^A-Z]+', '_', v.upper()).strip('_')
        counts[l['brand']][l['status']] += 1
    # previous wave members are kept while they stay eligible; the wave is then filled round-robin by state
    prev_path = os.path.join(run, 'franchise_leads.json')
    prev_wave = {l['email'] for l in json.load(open(prev_path)) if l.get('wave') == 'TEST_WAVE_1'} if os.path.exists(prev_path) else set()
    # test wave: Express, single office, COPY_B evidence, best title first, at most 2 per state
    # round-robin across states (freshest office posting first), at most 2 per state
    eligible = 'READY' if verified else 'READY_PENDING_VERIFY'
    ready = [l for l in leads if l['status'] == eligible and l['brand'] == 'express' and l['single_office']]
    by_state = collections.defaultdict(list)
    for l in sorted(ready, key=lambda l: (l['rank'], l['evidence']['candidateAds'][0]['lastSeen'] if l['evidence']['candidateAds'] else ''),
                    reverse=False):
        by_state[l['state']].append(l)
    for st in by_state:
        by_state[st].sort(key=lambda l: (l['rank'], ''.join(chr(255 - ord(c)) for c in l['evidence']['candidateAds'][0]['lastSeen']), l['email']))
    kept = [l for l in ready if l['email'] in prev_wave][:wave_n]
    for l in kept:
        l['wave'] = 'TEST_WAVE_1'
    used_states = collections.Counter(l['state'] for l in kept)
    picked = len(kept)
    for round_ in range(2):
        for st in sorted(by_state, key=lambda st: (used_states[st], -len(by_state[st]), st)):
            free = [l for l in by_state[st] if not l['wave']]
            if picked < wave_n and free and used_states[st] <= round_:
                free[0]['wave'] = 'TEST_WAVE_1'
                used_states[st] += 1
                picked += 1
    for l in leads:
        if l['status'] == eligible and not l['wave']:
            l['wave'] = 'HELD_AFTER_TEST'
    emails = sorted({l['email'] for l in leads if l['status'] == 'READY_PENDING_VERIFY'})
    # to_verify.csv is what the owner verifies; once results are back only still-pending addresses are listed separately
    with open(os.path.join(run, 'to_verify_pending.csv' if verified else 'to_verify.csv'), 'w', newline='') as fh:
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
               'to_verify': len(emails), 'verified': dict(collections.Counter(verified.values())),
               'wave_kept_from_previous': len(kept), 'wave_backfilled': picked - len(kept)}
    json.dump(leads, open(os.path.join(run, 'franchise_leads.json'), 'w'), indent=1)
    json.dump(summary, open(os.path.join(run, 'brand_counts.json'), 'w'), indent=1)
    print(json.dumps(summary, indent=1))


if __name__ == '__main__':
    main()
