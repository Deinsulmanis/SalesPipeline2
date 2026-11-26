"""Express Employment Professionals: map franchise owners to their office and check the office's own postings
(franchise ICP step 4, owner decision 2026-11-25). Free: public expresspros.com pages only.

Usage: python3 -I express_offices.py <run>

  1. Office list from the 50 state locator pages: office name ("Canton, OH"), address city, state, slug.
  2. Each Express OWNER in <run>/owners.json is matched to offices in their state: by a place named after the brand in
     their title / headline ("... Express Employment Professionals of Joliet, IL"), else by their city (office name city
     or office address city). No match -> HOLD_OFFICE_NOT_FOUND.
  3. Each matched office's /job-seekers/job-openings page (first page) is parsed: title, date, location.
     Job-posting rule (jobs_rule.is_hands_on): 2+ hands-on industrial/trades postings in the last 60 days that are at
     least 1/3 of the office's postings -> INDUSTRIAL. Postings but not industrial -> HOLD_OFFICE_ONLY.
     No postings -> HOLD_NO_POSTINGS. Several offices match and they disagree -> HOLD_OFFICE_AMBIGUOUS
     (accepted only when every candidate office is INDUSTRIAL and they share one city name).
Writes <run>/express_offices.json (office list + postings) and <run>/location_icp.json {owner_key: decision}.
"""
import concurrent.futures as cf
import html
import json
import os
import re
import ssl
import sys
import urllib.request
from datetime import date, datetime, timedelta

TOOLS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TOOLS)
import franchise_rule as fr  # noqa: E402
import jobs_rule  # noqa: E402

BASE = 'https://www.expresspros.com'
AS_OF = date(2026, 11, 25)
WINDOW = AS_OF - timedelta(days=60)
STATES = {'AL': 'alabama', 'AK': 'alaska', 'AZ': 'arizona', 'AR': 'arkansas', 'CA': 'california', 'CO': 'colorado',
          'CT': 'connecticut', 'DE': 'delaware', 'FL': 'florida', 'GA': 'georgia', 'HI': 'hawaii', 'ID': 'idaho',
          'IL': 'illinois', 'IN': 'indiana', 'IA': 'iowa', 'KS': 'kansas', 'KY': 'kentucky', 'LA': 'louisiana',
          'ME': 'maine', 'MD': 'maryland', 'MA': 'massachusetts', 'MI': 'michigan', 'MN': 'minnesota',
          'MS': 'mississippi', 'MO': 'missouri', 'MT': 'montana', 'NE': 'nebraska', 'NV': 'nevada',
          'NH': 'new-hampshire', 'NJ': 'new-jersey', 'NM': 'new-mexico', 'NY': 'new-york', 'NC': 'north-carolina',
          'ND': 'north-dakota', 'OH': 'ohio', 'OK': 'oklahoma', 'OR': 'oregon', 'PA': 'pennsylvania',
          'RI': 'rhode-island', 'SC': 'south-carolina', 'SD': 'south-dakota', 'TN': 'tennessee', 'TX': 'texas',
          'UT': 'utah', 'VT': 'vermont', 'VA': 'virginia', 'WA': 'washington', 'WV': 'west-virginia',
          'WI': 'wisconsin', 'WY': 'wyoming', 'DC': 'district-of-columbia'}
NAME_TO_ABBR = {v.replace('-', ' '): k for k, v in STATES.items()}


def get(url, cache):
    path = os.path.join(cache, re.sub(r'[^a-z0-9]+', '_', url.lower())[-150:] + '.html')
    if os.path.exists(path):
        return open(path, encoding='utf-8', errors='replace').read()
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (compatible; research)'})
    try:
        with urllib.request.urlopen(req, timeout=30, context=ssl.create_default_context()) as r:
            body = r.read().decode('utf-8', 'replace')
    except Exception as e:  # recorded, never guessed
        return 'FETCH_ERROR ' + str(e)[:100]
    open(path, 'w').write(body)
    return body


def text(s):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', s or ''))).strip()


def offices_of(state_html, abbr):
    out = []
    for m in re.finditer(r'href="https://www\.expresspros\.com/(us-[a-z0-9-]+)/job-seekers/job-openings"', state_html):
        slug = m.group(1)
        block = state_html[max(0, m.start() - 2500):m.start()]
        heads = re.findall(r'class="[^"]*\bh-h5">([^<]+)<', block)
        name = text(heads[-1]) if heads else ''
        addr = block[block.rfind('h-h5">'):] if heads else block
        spans = [text(x) for x in re.findall(r'>([^<>]+)<', addr)]
        spans = [x for x in spans if x and x not in (',', '|')]
        # address city is the token right before ", <ST>"
        city = ''
        for i, x in enumerate(spans):
            if x == abbr and i > 0:
                city = spans[i - 1].strip(' ,')
        if slug not in [o['slug'] for o in out]:
            out.append({'slug': slug, 'name': name, 'name_city': re.sub(r'\s*\(.*?\)', '', name.split(',')[0]).strip(),
                        'addr_city': city, 'state': abbr, 'jobs_url': f'{BASE}/{slug}/job-seekers/job-openings'})
    return out


def postings_of(page):
    rows = []
    for m in re.finditer(r'(?s)<div class="row job--details">(.*?)</div>\s*</div>\s*</div>', page):
        b = m.group(1)
        t = re.search(r'<h3[^>]*><a href="([^"]+)">([^<]+)</a>', b)
        d = re.search(r'<time datetime="(\d{4}-\d{2}-\d{2})"', b)
        loc = re.findall(r'<div class="column lg-6">([^<]+)</div>', b)
        if t:
            rows.append({'title': text(t.group(2)), 'url': t.group(1), 'date': d.group(1) if d else '',
                         'location': re.sub(r'\s*,\s*', ', ', text(loc[0])) if loc else ''})
    return rows


def office_verdict(posts):
    recent = [p for p in posts if p['date'] and datetime.strptime(p['date'], '%Y-%m-%d').date() >= WINDOW]
    hands = [p for p in recent if jobs_rule.is_hands_on(p['title'])]
    if not recent:
        return 'HOLD_NO_POSTINGS', recent, hands
    if len(hands) >= 2 and len(hands) * 3 >= len(recent):
        return 'INDUSTRIAL', recent, hands
    return 'HOLD_OFFICE_ONLY', recent, hands


def place_hint(r):
    """A place named right after the brand in the title or headline ('of Joliet, IL', '- Bozeman, MT')."""
    for s in (r['current_title'], r['linkedin_headline']):
        m = re.search(r'((?i:express employment professionals|express personnel services|express employment|express))'
                      r'\s*(?:of|in|[-–,])?\s*(?:the\s+)?([A-Z][A-Za-z .\'/&-]{2,40})', s or '')
        if m:
            hint = re.split(r'\s*[|;(]|\s+(?:and|&)\s+[A-Z][a-z]+ [A-Z]', m.group(2))[0].strip(' .,-')
            hint = re.sub(r'\b(Professionals?|International|Staffing|Employment|Services|Inc|LLC)\b', '', hint).strip(' .,-')
            if len(hint) >= 3:
                return hint.lower()
    return ''


def match_offices(r, offices):
    abbr = NAME_TO_ABBR.get(r['contact_state'].lower(), '')
    cand = [o for o in offices if o['state'] == abbr] if abbr else []
    hint = place_hint(r)
    if hint:
        st = re.search(r'(?:,\s*|\s)([a-z]{2})$', hint)
        pool = [o for o in offices if st and o['state'] == st.group(1).upper()] or cand or offices
        hit = contained(hint, pool)
        if hit:
            return hit, 'title/headline place'
    hit = contained(r['contact_city'], cand)
    return hit, 'contact city'


def contained(text_, pool):
    """Offices whose name city or address city appears as whole words in the text; the longest match wins."""
    t = ' ' + re.sub(r'[^a-z]+', ' ', (text_ or '').lower()) + ' '
    scored = []
    for o in pool:
        for c in (o['name_city'], o['addr_city']):
            c = ' ' + re.sub(r'[^a-z]+', ' ', c.lower()).strip() + ' '
            if len(c.strip()) >= 3 and c in t:
                scored.append((len(c), o))
    if not scored:
        return []
    best = max(n for n, _ in scored)
    return list({o['slug']: o for n, o in scored if n == best}.values())


def main():
    run = sys.argv[1]
    cache = os.path.join(run, 'express_cache')
    os.makedirs(cache, exist_ok=True)
    owners = [r for r in json.load(open(os.path.join(run, 'owners.json'))) if r['brand'] == 'express' and r['status'] == 'OWNER']
    with cf.ThreadPoolExecutor(8) as ex:
        pages = dict(zip(STATES, ex.map(lambda a: get(f'{BASE}/locations/states/{STATES[a]}', cache), STATES)))
    offices = [o for a, p in pages.items() for o in offices_of(p, a)]
    matches = {r['owner_key']: match_offices(r, offices) for r in owners}
    need = sorted({o['slug'] for hit, _ in matches.values() for o in hit})
    by_slug = {o['slug']: o for o in offices}
    with cf.ThreadPoolExecutor(8) as ex:
        jobs = dict(zip(need, ex.map(lambda s: get(by_slug[s]['jobs_url'], cache), need)))
    for s, page in jobs.items():
        o = by_slug[s]
        o['fetch_error'] = page.startswith('FETCH_ERROR')
        o['postings'] = postings_of(page) if not o['fetch_error'] else []
        o['verdict'], recent, hands = office_verdict(o['postings']) if not o['fetch_error'] else ('HOLD_FETCH_ERROR', [], [])
        o['recent'], o['hands_on'] = len(recent), len(hands)
    decisions = {}
    for r in owners:
        hit, how = matches[r['owner_key']]
        if not hit:
            decisions[r['owner_key']] = {'decision': 'HOLD_OFFICE_NOT_FOUND', 'matched_by': how, 'offices': []}
            continue
        verdicts = {by_slug[o['slug']]['verdict'] for o in hit}
        cities = {o['name_city'].lower() for o in hit}
        if len(hit) == 1:
            dec = by_slug[hit[0]['slug']]['verdict']
        elif verdicts == {'INDUSTRIAL'} and len(cities) == 1:
            dec = 'INDUSTRIAL'
        else:
            dec = 'HOLD_OFFICE_AMBIGUOUS'
        decisions[r['owner_key']] = {'decision': dec, 'matched_by': how, 'offices': [o['slug'] for o in hit],
                                     'office_city': hit[0]['name_city'] if len(cities) == 1 else '',
                                     'office_state': hit[0]['state']}
    # One owner per office: owners mapped to the same office set keep the best title (franchise_rule.title_rank).
    kept = {}
    for r in sorted(owners, key=lambda r: (r['rank'], r['work_email'])):
        d = decisions[r['owner_key']]
        if not d['offices']:
            continue
        office_key = '|'.join(sorted(d['offices']))
        d['territory'] = fr.territory_key('express', d.get('office_city') or d['offices'][0], d.get('office_state', ''))
        if office_key in kept:
            d['decision'], d['same_office_as'] = 'HOLD_SAME_OFFICE', kept[office_key]
        else:
            kept[office_key] = r['owner_key']
    json.dump(offices, open(os.path.join(run, 'express_offices.json'), 'w'), indent=1)
    json.dump(decisions, open(os.path.join(run, 'location_icp.json'), 'w'), indent=1)
    import collections
    print('offices', len(offices), 'fetched', len(jobs), 'errors', sum(1 for s in jobs if by_slug[s]['fetch_error']))
    print(collections.Counter(d['decision'] for d in decisions.values()))
    print(collections.Counter(d['matched_by'] for d in decisions.values() if d['offices']))


if __name__ == '__main__':
    main()
