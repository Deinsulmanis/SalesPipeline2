"""Second-buyer pick (owner brief 2026-11-24): from free Apollo people-search results, pick a NEW buyer at a company
ScaleLab already emailed, under the multi-site rule. Free; reveals nothing.

Usage: python3 -I second_buyer_pick.py <run> [--branches <run>/branches.json]

Inputs:
  <run>/icp_decisions.json      PASS companies only
  <run>/people_by_domain.json   buyer_pick.py output (every mapped person, with title and has_email)
  <run>/prior_contacts.json     {domain: [{lead_id, first, last, email, title}]}: everyone already emailed there
  <run>/branches.json           {domain: {"branches": n, "evidence": [urls]}} from the cached crawl (optional)

Rules:
  - Prior contacts with no recorded title get it from the same free search (first name + last initial match);
    if still unknown, any different tier 1-2 person is acceptable.
  - Never a person already emailed (first name + last initial, or Apollo id), never recruiters, HR, finance, IT,
    ops-only or "Talent Partner" (buyer_pick.py NEVER), never anyone without an email on file.
  - Distinct = a DIFFERENT BUYER ROLE family than every prior contact (owner -> president, CEO, CRO / VP sales or BD,
    COO ...), or, at a multi-branch company (3+ branches), a branch / area / regional manager (a different branch).
  - Default 1 new contact per company; multi-branch companies up to 2, each in a different role family or at a
    branch level. Tier order per buyer_pick.py (tier, then its rank).
Writes <run>/second_picks.json, <run>/reveal/targets_ordered.json (first picks) and
<run>/reveal2/targets_ordered.json (second picks at multi-branch companies), <run>/second_pick_stats.json.
"""
import collections
import importlib.util
import json
import os
import re
import sys

RUN = sys.argv[1]
TOOLS = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('bp', os.path.join(TOOLS, 'buyer_pick.py'))
_argv, sys.argv = sys.argv, [sys.argv[0], 'x']
bp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bp)
sys.argv = _argv

FAMILIES = [
    ('OWNER', r'(?<!product )\b(owner|co-?owner|founder|co-?founder|proprietor)\b'),
    ('PRESIDENT', r'(?<!vice )\bpresident\b'),
    ('CEO', r'\bceo\b|chief executive'),
    ('PARTNER', r'managing partner|managing principal|^principal$|^(senior |founding |equity )?partner$'),
    ('SALES', r'chief revenue|\bcro\b|chief sales|chief commercial|chief growth|chief business development|'
              r'(vp|vice president|svp|evp)\b.*\b(sales|business development|growth|revenue|commercial|client|account)'),
    ('COO', r'\bcoo\b|chief operating'),
    ('CMO', r'\bcmo\b|chief marketing'),
    ('VP', r'^(vp|vice president|svp|evp)$'),
]
BRANCH = re.compile(r'(?i)\b(branch|area|regional|district|market)\s+(manager|director|vice president|vp|leader|lead)\b|'
                    r'\b(vp|vice president|director)\b.*\b(region|regional|branch)')


def families(title):
    t = (title or '').lower().strip()
    return {f for f, rx in FAMILIES if re.search(rx, t)}


def first_key(s):
    return re.sub(r'[^a-z]', '', (s or '').lower())


def last_initial(x):
    """Search results carry the obfuscated last name as last_obf ('Ke***y'); prior contacts carry last."""
    v = x.get('last_obf') or x.get('last') or x.get('last_name_obfuscated') or ''
    return v[:1].lower()


def main():
    dec = json.load(open(os.path.join(RUN, 'icp_decisions.json')))
    passing = [x['domain'] for x in dec if x['company_icp'] == 'PASS']
    people = json.load(open(os.path.join(RUN, 'people_by_domain.json'))) if os.path.exists(os.path.join(RUN, 'people_by_domain.json')) else {}
    prior = json.load(open(os.path.join(RUN, 'prior_contacts.json')))
    bpath = sys.argv[sys.argv.index('--branches') + 1] if '--branches' in sys.argv else os.path.join(RUN, 'branches.json')
    branches = json.load(open(bpath)) if os.path.exists(bpath) else {}
    picks, t1, t2 = {}, [], []
    st = collections.Counter()
    for d in passing:
        ps = people.get(d, [])
        pri = [dict(p) for p in prior.get(d, [])]
        for p in pri:
            p['fam'] = families(p.get('title'))
            if not p.get('title'):
                st['prior_title_unknown'] += 1
                m = [x for x in ps if first_key(x.get('first')) == first_key(p.get('first'))
                     and last_initial(x) == last_initial(p)]
                if m and m[0].get('title'):
                    p['title'], p['fam'] = m[0]['title'], families(m[0]['title'])
                    p['title_from'] = 'apollo_free_search'
                    st['prior_title_found_in_search'] += 1
        prior_fam = set().union(*[p['fam'] for p in pri]) if pri else set()
        multi = (branches.get(d) or {}).get('branches', 0) >= 3
        st['multi_branch' if multi else 'single_site_or_unknown'] += 1
        cands = []
        for x in ps:
            if not x.get('has_email'):
                continue
            # same first name = treated as the same person unless the last initials clearly differ (conservative)
            if any(first_key(x.get('first')) == first_key(p.get('first')) and
                   (not last_initial(x) or not last_initial(p) or last_initial(x) == last_initial(p)) for p in pri):
                st['skipped_prior_person'] += 1
                continue
            title = x.get('title') or ''
            fam = families(title)
            tr = bp.tier(title)
            is_branch = bool(BRANCH.search(title)) and not re.search(r'(?i)recruit|talent|\bhr\b|human|payroll|finance|account', title)
            if tr and not re.search(bp.NEVER, title.lower()):
                if prior_fam and fam and fam & prior_fam:
                    continue  # same buyer role as someone already emailed
                if prior_fam and not fam:
                    continue
                cands.append({**x, 'fam': sorted(fam), 'tier': tr[0], 'rank': tr[1],
                              'distinct_by': ('role:' + '/'.join(sorted(fam))) if prior_fam else 'role (prior title unknown)'})
            elif is_branch and multi:
                cands.append({**x, 'fam': ['BRANCH'], 'tier': 3, 'rank': 0, 'distinct_by': 'branch: ' + title})
        cands.sort(key=lambda c: (c['tier'], c['rank']))
        chosen = []
        for c in cands:
            if not chosen:
                chosen.append(c)
            elif multi and len(chosen) < 2 and (c['fam'] == ['BRANCH'] or not set(c['fam']) & set(chosen[0]['fam'])):
                chosen.append(c)
            if len(chosen) >= (2 if multi else 1):
                break
        if not chosen:
            st['no_distinct_buyer'] += 1
            continue
        picks[d] = [{k: c.get(k) for k in ('id', 'first', 'last_obf', 'title', 'tier', 'fam', 'distinct_by')} for c in chosen]
        for i, c in enumerate(chosen):
            rec = {'domain': d, 'id': c['id'], 'first': c.get('first'), 'last': c.get('last_obf') or c.get('last'), 'title': c.get('title'),
                   'tier': c['tier'], 'source': 'apollo_free_search', 'second_buyer': True, 'distinct_by': c['distinct_by']}
            (t1 if i == 0 else t2).append(rec)
        st['companies_with_pick'] += 1
        st['second_picks_at_multi_branch'] += len(chosen) - 1
    for sub, rows in (('reveal', t1), ('reveal2', t2)):
        os.makedirs(os.path.join(RUN, sub), exist_ok=True)
        json.dump(rows, open(os.path.join(RUN, sub, 'targets_ordered.json'), 'w'), indent=1)
    json.dump(picks, open(os.path.join(RUN, 'second_picks.json'), 'w'), indent=1)
    st['pass_companies'] = len(passing)
    json.dump(dict(st), open(os.path.join(RUN, 'second_pick_stats.json'), 'w'), indent=1)
    print(json.dumps(dict(st), indent=1))


if __name__ == '__main__':
    main()
