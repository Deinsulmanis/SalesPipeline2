"""Four GetLeads enrichment lists from every ScaleLab run + production (owner brief 2026-11-24). Read-only.

Usage: python3 -I enrich_lists4.py <out_dir>     (e.g. runs-private/enrich-lists-4)

Excluded everywhere: EXCLUDE companies (opt-out, negative / positive / neutral reply, suppression), latest V4 gate
REJECT, chains / franchises, non-US, anyone in buyer_ready_combined.csv or a pending batch (V4 master, un-ingested
to_verify), role mailboxes; and (owner rule: one active contact per company) companies with an active Campaign 3
contact unless they have 3+ branches.

1. no_buyer_domains.csv (domain): latest gate PASS, no buyer on any path (no production lead, no approved or pending
   contact, nothing in the enriched file).
2. reengage_emails.csv (email): V1 / Campaign 2 contacts with no reply, opt-out, bounce or suppression, last emailed
   >= 60 days ago or becoming eligible within 30 days (>= 30 days ago), at companies with no active second buyer.
   [MANUAL HOLD] rows are human-owned and left out (counted).
3. linkedin_no_email.csv (linkedin_url): buyers (buyer_pick Tier 1/2) found with a LinkedIn URL but no email:
   Apollo reveals that returned no email, GetLeads lookups without a work email.
4. owner_names.csv (first_name,last_name,company_name,company_domain): team-page owners / executives (buyers_site,
   owner-gap picks; Tier 1/2) who never got a verified email. Full names only.
Each list has a private <name>_key.csv; counts.json holds counts only.
"""
import collections
import csv
import datetime
import glob
import importlib.util
import json
import os
import re
import sys

OUT = sys.argv[1]
TOOLS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import franchise_rule as fr  # noqa: E402  (the one chain / franchise rule)
REPO = os.path.abspath(os.path.join(TOOLS, '..', '..', '..'))
AS_OF = datetime.date(2026, 11, 24)
TASKS = '/tmp/claude-0/-home-user-SalesPipeline2/2ac8488f-fce7-5c12-b5fb-d98394461a32/tasks'
MAIN_TRANSCRIPT = '/root/.claude/projects/-home-user-SalesPipeline2/2ac8488f-fce7-5c12-b5fb-d98394461a32.jsonl'


def load_mod(name, path, argv):
    spec = importlib.util.spec_from_file_location(name, path)
    old, sys.argv = sys.argv, argv
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    sys.argv = old
    return m


el = load_mod('el', os.path.join(TOOLS, 'enrich_lists.py'), ['x', OUT])
bp, dm = el.bp, el.dm


def jload(p, d=None):
    try:
        return json.load(open(p))
    except (OSError, ValueError):
        return d


NOT_NAMES = {'instagram', 'facebook', 'linkedin', 'twitter', 'marketing', 'services', 'staffing', 'solutions', 'contact', 'team',
             'about', 'our', 'home', 'office', 'careers', 'jobs', 'company', 'group', 'meet', 'leadership', 'management', 'click'}


def buyer(title):
    t = bp.tier(title or '')
    return t[0] if t and t[0] in (1, 2) else None


def main():
    os.makedirs(OUT, exist_ok=True)
    st = collections.Counter()
    gate, names, branches, shortfall = {}, {}, collections.Counter(), {}
    for label, run in el.RUNS:
        for x in jload(os.path.join(run, 'icp_decisions.json'), []) or []:
            if x.get('icp_reason_code') != 'DUPLICATE':
                gate[x['domain']] = (x['company_icp'], (x.get('jev') or {}).get('large_national_chain'), (x.get('jev') or {}).get('us_operations'), label)
                names.setdefault(x['domain'], x.get('company_name') or '')
        for d, v in (jload(os.path.join(run, 'branches.json'), {}) or {}).items():
            branches[d] = max(branches[d], v.get('branches', 0))
        for d, why in (jload(os.path.join(run, 'buyer_shortfalls.json'), {}) or {}).items():
            shortfall[d] = (label, why)
    cm = {c['domain']: c for c in jload(f'{REPO}/runs-private/second-buyer-2026-11-24/company_master.json', []) or []}
    excluded = {d: c['exclude_reasons'][0] for d, c in cm.items() if c.get('status') == 'EXCLUDE'
                and not str(c['exclude_reasons'][0]).startswith('manual_hold')}
    prod = jload(f'{REPO}/runs-private/enrich-lists/prod_snapshot.json', [])
    prod_emails = {p['email'] for p in prod if p['email']}
    prod_dom, active = collections.defaultdict(list), set()
    for p in prod:
        d = el.root(p['domain']) or p['email'].split('@')[-1]
        prod_dom[d].append(p)
        if p['stage'] == 'Queued' or (p['campaign'] == 'Industrial Campaign 3' and p['stage'] == 'Contacted'):
            active.add(d)
    master = list(csv.DictReader(open(f'{REPO}/docs/scalelab-sourcing/runs/V4_APPROVED_CONTACTS_MASTER.csv')))
    m_emails = {r['email'].lower() for r in master}
    m_dom = {r['company_domain'] for r in master}
    br_rows = list(csv.DictReader(open(f'{REPO}/runs-private/enrich-lists/buyer_ready_combined.csv')))
    br_emails = {r['email'].strip().lower() for r in br_rows}
    br_dom = {r['domain'].strip().lower() for r in br_rows}
    br_people = {(el.split_name(f"{r['first_name']} {r['last_name']}") or ('', ''))[0].lower() + '|' + r['domain'].lower() for r in br_rows}
    pending, ver = set(), {}
    for label, run in el.RUNS:
        v = {}
        for f in ('gl/verify.json', 'owner_gap/verify.json', 'verification.json'):
            v.update({k.lower(): x for k, x in (jload(os.path.join(run, f), {}) or {}).items()})
        ver.update(v)
        for p in jload(os.path.join(run, 'verify_pending.json'), []) or []:
            if p['email'].lower() not in v:
                pending.add(p['email'].lower())
    pending_dom = {e.split('@')[-1] for e in pending}
    people_known = collections.defaultdict(set)  # first-name keys of everyone emailed / approved / enriched, per company
    for p in prod:
        sp = el.split_name(p.get('contact_name'))
        if sp:
            people_known[el.root(p['domain']) or p['email'].split('@')[-1]].add(sp[0].lower())
    for r in master:
        sp = el.split_name(r.get('buyer_name'))
        if sp:
            people_known[r['company_domain']].add(sp[0].lower())

    def company_block(d, need_pass=False):
        g = gate.get(d)
        if d in excluded:
            return 'company_excluded'
        if el.FOREIGN.search(d) or (g and g[2] is not None and g[2] < 0.3 and g[0] != 'PASS'):
            return 'non_us'
        chain = fr.chain_block(names.get(d, ''), d, g[1] if g else None)
        if chain:
            return chain
        if g and g[0] == 'REJECT':
            return 'icp_reject'
        if need_pass and (not g or g[0] != 'PASS'):
            return 'icp_not_pass'
        if d in active and branches[d] < 3:
            return 'has_active_contact'
        return None

    lists = {k: {} for k in ('no_buyer_domains', 'reengage_emails', 'linkedin_no_email', 'owner_names')}

    # ---- 1. PASS companies with no buyer on any path
    for d, g in gate.items():
        if g[0] != 'PASS':
            continue
        if prod_dom.get(d) or d in m_dom or d in br_dom or d in pending_dom:
            continue
        why = company_block(d, need_pass=True)
        if why:
            st['1_excluded_' + why] += 1
            continue
        lists['no_buyer_domains'][d] = {'domain': d, 'company_name': names.get(d, ''), 'gate_run': g[3],
                                        'shortfall_run': (shortfall.get(d) or ('', ''))[0], 'shortfall': (shortfall.get(d) or ('', ''))[1][:120],
                                        'branches': branches[d]}

    # ---- 2. re-engage (V1 / Campaign 2 contacts)
    for d, c in cm.items():
        if c.get('status') == 'NEVER_EMAILED':
            continue
        if d in active:
            st['2_excluded_active_second_buyer'] += 1
            continue
        why = company_block(d)
        if why:
            st['2_excluded_' + why] += 1
            continue
        for k in c['contacts']:
            if not k.get('sent') or k['campaign'] not in ('Industrial Staffing Agency', 'Staffing Outreach Campaign 2'):
                continue
            e = (k.get('email') or '').lower()
            if any(k.get(f) for f in ('negative', 'positive', 'neutral', 'bounced', 'suppressed_non_bounce', 'suppressed_bounce')):
                st['2_excluded_reply_unsub_bounce_suppression'] += 1
                continue
            if k.get('manual_hold'):
                st['2_excluded_manual_hold_human_owned'] += 1
                continue
            loc = e.split('@')[0]
            if el.ROLE.match(re.sub(r'[._-]', '', loc)) or el.ROLE.match(loc):
                st['2_excluded_role_mailbox'] += 1
                continue
            if e in br_emails or e in m_emails or e in pending:
                st['2_excluded_in_enriched_file_or_pending'] += 1
                continue
            if not k.get('last_sent'):
                continue
            last = datetime.date.fromisoformat(str(k['last_sent'])[:10])
            days = (AS_OF - last).days
            if days < 30:
                st['2_excluded_too_recent'] += 1
                continue
            lists['reengage_emails'][e] = {'email': e, 'lead_id': k['lead_id'], 'campaign': k['campaign'], 'company_domain': d,
                                           'last_sent': str(last), 'eligible_on': str(last + datetime.timedelta(days=60)),
                                           'eligible_now': str(days >= 60).lower()}

    # ---- 3. buyers with a LinkedIn URL but no email
    def add3(url, first, last, title, d, src, run):
        url = (url or '').strip()
        if not url or 'linkedin.com/in/' not in url.lower():
            return
        if not buyer(title):
            st['3_excluded_not_buyer'] += 1
            return
        why = company_block(d)
        if why:
            st['3_excluded_' + why] += 1
            return
        if (first or '').lower() in people_known.get(d, set()) or f"{(first or '').lower()}|{d}" in br_people:
            st['3_excluded_already_contacted_or_enriched'] += 1
            return
        key = re.sub(r'^https?://(www\.)?', '', url.lower()).rstrip('/')
        lists['linkedin_no_email'].setdefault(key, {'linkedin_url': 'https://www.' + key if not key.startswith('linkedin') else 'https://www.' + key,
                                                    'first_name': first, 'last_name': last, 'title': title, 'company_domain': d, 'source': src, 'run': run})
    for label, run in el.RUNS:
        p = os.path.join(run, 'reveal', 'all.rows')
        for line in open(p, errors='replace') if os.path.exists(p) else []:
            x = line.rstrip('\n').split('|')
            if len(x) >= 10 and '@' not in x[6]:
                sp = el.split_name(x[4]) or ('', '')
                add3(x[9], sp[0], sp[1], x[5], x[1], 'apollo_reveal_no_email', label)
    files = sorted(glob.glob(os.path.join(TASKS, '*.output'))) + [MAIN_TRANSCRIPT]
    for f in files:
        try:
            fh = open(f, errors='replace')
        except OSError:
            continue
        for ln in fh:
            if 'linkedin_url' not in ln or 'work_email' not in ln:
                continue
            for m in re.finditer(r'\{[^{}]*"work_email"[^{}]*\}', ln.replace('\\"', '"')):
                try:
                    c = json.loads(m.group(0))
                except ValueError:
                    continue
                if not c.get('work_email') and c.get('linkedin_url'):
                    add3(c['linkedin_url'], c.get('first_name', ''), c.get('last_name', ''), c.get('current_title', ''),
                         el.root(c.get('company_domain') or c.get('current_employer_website') or ''), 'getleads_lookup_no_email', 'getleads')

    # ---- 4. team-page owners / executives without a verified email
    def other_org(title, d):
        m = el.ORG_TAIL.search(title or '')
        if not m:
            return False
        tail = {w for w in re.sub(r'[^a-z ]', ' ', m.group(1).lower()).split() if len(w) > 2} - {
            'inc', 'llc', 'the', 'and', 'certified', 'group', 'sales', 'business', 'development', 'operations', 'founder',
            'owner', 'president', 'ceo', 'partner', 'managing', 'principal', 'chief', 'officer', 'executive', 'vice', 'coo'}
        own = set(re.sub(r'[^a-z ]', ' ', (names.get(d, '') + ' ' + d.split('.')[0]).lower()).split())
        return bool(tail) and not (tail & own) and not any(w in d.split('.')[0] for w in tail)

    def add4(name, title, d, src, run):
        sp = el.split_name(name)
        if not sp or {sp[0].lower(), sp[1].lower()} & NOT_NAMES:
            st['4_excluded_not_full_name'] += 1
            return
        t = (title or '').strip()
        if not buyer(t) or len(t) > 70 or el.BAD_TITLE.search(t) or re.search(r'\d', t) or other_org(t, d):
            st['4_excluded_not_owner_or_executive'] += 1
            return
        why = company_block(d)
        if why:
            st['4_excluded_' + why] += 1
            return
        if sp[0].lower() in people_known.get(d, set()) or f"{sp[0].lower()}|{d}" in br_people:
            st['4_excluded_already_contacted_or_enriched'] += 1
            return
        k = (sp[0].lower(), sp[1].lower(), d)
        lists['owner_names'].setdefault(k, {'first_name': sp[0], 'last_name': sp[1], 'company_name': names.get(d, '') or d, 'company_domain': d,
                                            'title': t, 'source': src, 'run': run, 'icp': (gate.get(d) or ('',))[0]})
    for label, run in el.RUNS:
        for d, ps in (jload(os.path.join(run, 'buyers_site.json'), {}) or {}).items():
            for p in ps or []:
                add4(p.get('name', ''), p.get('title', ''), d, 'team_page', label)
        for d, p in (jload(os.path.join(run, 'owner_gap', 'picks.json'), {}) or {}).items():
            if isinstance(p, dict):
                guesses = [c for c in (jload(os.path.join(run, 'owner_gap', 'candidates_raw.json')) or jload(os.path.join(run, 'owner_gap', 'candidates.json'), []) or [])
                           if c.get('domain') == d]
                if any(str((ver.get(c['email'].lower()) or {}).get('validity', '')).lower() == 'valid' for c in guesses):
                    continue  # already has a verified address
                add4(p.get('name', ''), p.get('title', ''), d, 'owner_gap_pick', label)

    # ---- write
    cols = {'no_buyer_domains': ['domain'], 'reengage_emails': ['email'], 'linkedin_no_email': ['linkedin_url'],
            'owner_names': ['first_name', 'last_name', 'company_name', 'company_domain']}
    counts = {}
    for name, rows in lists.items():
        rows = list(rows.values())
        with open(os.path.join(OUT, name + '.csv'), 'w', newline='') as f:
            w = csv.DictWriter(f, fieldnames=cols[name], extrasaction='ignore')
            w.writeheader()
            w.writerows(rows)
        if rows:
            with open(os.path.join(OUT, name + '_key.csv'), 'w', newline='') as f:
                w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
                w.writeheader()
                w.writerows(rows)
        by = 'gate_run' if name == 'no_buyer_domains' else 'campaign' if name == 'reengage_emails' else 'run'
        counts[name] = {'rows': len(rows), 'by_source': dict(collections.Counter(f"{r.get(by, '')}|{r.get('source', '')}".strip('|') for r in rows)),
                        'companies': len({r.get('company_domain') or r.get('domain') for r in rows})}
    counts['reengage_emails']['eligible_now'] = sum(1 for r in lists['reengage_emails'].values() if r['eligible_now'] == 'true')
    counts['reengage_emails']['eligible_within_30_days'] = counts['reengage_emails']['rows'] - counts['reengage_emails']['eligible_now']
    counts['owner_names']['by_icp'] = dict(collections.Counter(r['icp'] for r in lists['owner_names'].values()))
    # PASS-only cut of list 4 (owner's choice: HOLD companies have not passed the ICP gate)
    po = [r for r in lists['owner_names'].values() if r['icp'] == 'PASS']
    with open(os.path.join(OUT, 'owner_names_pass_only.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=cols['owner_names'], extrasaction='ignore')
        w.writeheader()
        w.writerows(po)
    counts['owner_names']['pass_only_rows'] = len(po)
    counts['exclusions'] = dict(st)
    json.dump(counts, open(os.path.join(OUT, 'counts.json'), 'w'), indent=1)
    print(json.dumps(counts, indent=1))


if __name__ == '__main__':
    main()
