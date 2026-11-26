"""GetLeads enrichment lists from HELD / unsent ScaleLab contacts across every run (owner brief 2026-11-24). Read-only.

Usage: python3 -I enrich_lists.py <out_dir>     (e.g. runs-private/enrich-lists)

Inputs (already saved; nothing is fetched): every run folder in RUNS, <out_dir>/prod_snapshot.json (Supabase ScaleLab
staffing rows), the V4 master, the spreadsheet export's Suppression tab and the second-buyer company master.

LIST 1  list1_emails.csv  (one column "email"): an address exists, the person's name or title is missing or unclear:
        reveal rows held as PERSON_MISMATCH or NOT_BUYER with no usable title, the next owner-gap guess (first@, then
        first.last@ only after first@ came back invalid), personal-looking addresses found on the company's own site,
        and production rows never emailed that lack a name or title.
LIST 2  list2_names.csv   (first_name,last_name,company_name,company_domain): a full name is known, the email is missing:
        reveals with no email, GetLeads decision-makers without an email, people whose address verified invalid / unknown
        or sat on an unproven domain, owner-gap people whose two guesses were invalid, team-page owners and executives.
Excluded everywhere: anyone already in production or the V4 master (address or same person at the company), suppressed
addresses, role mailboxes, personal mailboxes, companies that are EXCLUDE (opt-out, reply, suppression, chain, non-US),
latest V4 gate not PASS (production never-emailed rows: not REJECT), companies with an approved or active contact unless
they have 3+ branches (multi-site rule; the ingest then applies role / branch distinctness), addresses already waiting in
an un-ingested to_verify.csv (counted). Apollo search previews (masked last name, not revealed) are counted, not listed.
Writes list1_emails.csv, list2_names.csv, list1_key.csv, list2_key.csv (private: run, lead, company, reason) and
counts.json (counts only).
"""
import collections
import csv
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
SP = '/tmp/claude-0/-home-user-SalesPipeline2/2ac8488f-fce7-5c12-b5fb-d98394461a32/scratchpad'
RUNS = [('v4-pilot', f'{SP}/v4run'), ('v4-pilot-p2', f'{SP}/v4run_p2'), ('wave1', f'{SP}/w1'), ('codex48', f'{SP}/c48'),
        ('c1k', f'{SP}/c1k'), ('w2k', f'{REPO}/runs-private/w2k'), ('shortfall', f'{REPO}/runs-private/shortfall-2026-11-23'),
        ('v4-3000', f'{REPO}/runs-private/v4-3000-2026-11-23'), ('c2-recovery', f'{REPO}/runs-private/recovery-c2-import-2026-11-24'),
        ('regate-551', f'{REPO}/runs-private/regate-551-2026-11-24'), ('jobs-discovery', f'{REPO}/runs-private/jobs-discovery-2026-11-24'),
        ('second-buyer', f'{REPO}/runs-private/second-buyer-2026-11-24')]
ROLE = re.compile(r'^(info|jobs?|hr|careers?|office|admin|contact|hello|sales|support|staffing|recruit\w*|team|mail|accounting|'
                  r'billing|payroll|service|inquir\w*|marketing|help|general|apply|resumes?|hiring|employment|dispatch|orders?|'
                  r'frontdesk|reception|operations|ops|noreply|no-reply|webmaster|customerservice|work|talent|people|ap|ar|'
                  r'invoices?|timesheets?|hrdept|humanresources|workforce|labor|temps?|placement|branch\w*|main|website|web)\d*$')
PERSONAL = {'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com', 'live.com', 'msn.com', 'comcast.net',
            'att.net', 'sbcglobal.net', 'verizon.net', 'me.com', 'ymail.com', 'protonmail.com', 'bellsouth.net', 'cox.net'}
FOREIGN = re.compile(r'\.(ca|uk|au|nz|in|mx|ie|de|fr|ph|za|sg|ae|br)$')
NAME_OK = re.compile(r"^[A-Za-z][A-Za-z'’.-]{1,30}$")
BAD_TITLE = re.compile(r'(?i)^(letter|message|meet|our|about|from|welcome)\b|\b(letter from|message from)\b')
MAILBOX_WORD = re.compile(r'(?i)payroll|support|apply|apps|online|jobs|career|resume|recruit|staff|office|admin|info|sales|service|'
                          r'billing|account|hiring|team|branch|dispatch|order|onboard|benefit|safety|compliance|quality|hr$|^hr|'
                          r'verif|opportunit|hire|facilit|email|finance|help|contact|inquir|marketing|talent|people|work|'
                          r'(ville|burg|borough|county|city)$')
ORG_TAIL = re.compile(r'(?:[,–—·|-]|\bat\b)\s*([A-Za-z][A-Za-z&.\' ]{2,60})\.?$')
EMAIL_RX = re.compile(r'\b([A-Za-z0-9._%+-]{2,40})@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b')


def load_mod(name, path, argv):
    spec = importlib.util.spec_from_file_location(name, path)
    old, sys.argv = sys.argv, argv
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    sys.argv = old
    return m


bp = load_mod('bp', os.path.join(TOOLS, 'buyer_pick.py'), ['x', 'x'])
dm = load_mod('dm', os.path.join(TOOLS, 'discover_merge.py'), ['x', 'x', '--'])
sbp = load_mod('sbp', os.path.join(TOOLS, 'second_buyer_pick.py'), ['x', 'x'])


def root(d):
    d = re.sub(r'^https?://', '', (d or '').strip().lower()).split('/')[0].split(':')[0]
    return d[4:] if d.startswith('www.') else d


def jload(p, default=None):
    try:
        return json.load(open(p))
    except (OSError, ValueError):
        return default


def tier(title):
    t = bp.tier(title or '')
    return t[0] if t else None  # buyer_pick.tier is the whole rule (no second exclusion pass)


def split_name(n):
    parts = [p for p in re.sub(r'\s+', ' ', (n or '').replace(',', ' ')).strip().split(' ')
             if p.lower().strip('.') not in ('jr', 'sr', 'ii', 'iii', 'mr', 'ms', 'mrs', 'dr')]
    if len(parts) < 2:
        return None
    f, l = parts[0], parts[-1]
    if '*' in f + l or not NAME_OK.match(f) or not NAME_OK.match(l) or len(f.strip('.')) < 2 or len(l.strip('.')) < 2:
        return None
    return f.strip('.'), l.strip('.')


def main():
    os.makedirs(OUT, exist_ok=True)
    st = collections.Counter()
    # ---- company facts
    gate, names, branches = {}, {}, collections.Counter()
    for label, run in RUNS:
        for x in jload(os.path.join(run, 'icp_decisions.json'), []) or []:
            if x.get('icp_reason_code') == 'DUPLICATE':
                continue
            gate[x['domain']] = (x['company_icp'], x.get('icp_reason_code'), (x.get('jev') or {}).get('large_national_chain'),
                                 (x.get('jev') or {}).get('us_operations'))
            names.setdefault(x['domain'], x.get('company_name') or '')
        for d, v in (jload(os.path.join(run, 'branches.json'), {}) or {}).items():
            branches[d] = max(branches[d], v.get('branches', 0))
    cm = jload(f'{REPO}/runs-private/second-buyer-2026-11-24/company_master.json', []) or []
    excluded_co = {c['domain']: c['exclude_reasons'] for c in cm if c.get('status') == 'EXCLUDE'
                   and not str((c.get('exclude_reasons') or [''])[0]).startswith('manual_hold')}
    prod = jload(os.path.join(OUT, 'prod_snapshot.json'), [])
    prod_emails = {p['email'] for p in prod if p['email']}
    active, people_at = set(), collections.defaultdict(list)
    for p in prod:
        d = root(p['domain']) or p['email'].split('@')[-1]
        names.setdefault(d, '')
        if p['stage'] in ('Queued',) or (p['campaign'] == 'Industrial Campaign 3' and p['stage'] == 'Contacted'):
            active.add(d)
        if p['emailed'] or p['stage'] in ('Queued',):
            people_at[d].append(p.get('contact_name') or '')
    master = list(csv.DictReader(open(f'{REPO}/docs/scalelab-sourcing/runs/V4_APPROVED_CONTACTS_MASTER.csv')))
    master_emails = {r['email'].lower() for r in master}
    revealed = {r.get('apollo_id') for r in master if r.get('apollo_id')}
    for r in master:
        people_at[r['company_domain']].append(r.get('buyer_name') or '')
        if not str(r.get('contact_status', '')).startswith('HOLD'):
            active.add(r['company_domain'])
    supp = set()
    try:
        import openpyxl
        wb = openpyxl.load_workbook(f'{REPO}/runs-private/second-buyer-2026-11-24/sheet/ScaleLabPipeline.xlsx', read_only=True)
        it = wb['Suppression'].iter_rows(values_only=True)
        next(it)
        supp = {str(r[0]).strip().lower() for r in it if r and r[0]}
    except Exception:  # noqa: BLE001 - fail closed below: without the list nothing is excluded by it, so say so
        st['WARNING_suppression_sheet_unreadable'] += 1
    pending = set()
    for label, run in RUNS:
        ver = {}
        for f in ('gl/verify.json', 'owner_gap/verify.json', 'verification.json'):
            ver.update({k.lower(): v for k, v in (jload(os.path.join(run, f), {}) or {}).items()})
        for p in jload(os.path.join(run, 'verify_pending.json'), []) or []:
            if p['email'].lower() not in ver:
                pending.add(p['email'].lower())
        for f in glob.glob(os.path.join(run, 'reveal', '*.rows')):
            for line in open(f, errors='replace'):
                x = line.split('|')
                if len(x) > 3:
                    revealed.add(x[3])

    def company_ok(d, prod_row=False):
        g = gate.get(d)
        if d in excluded_co:
            return 'company_excluded:' + str(excluded_co[d][0]).split(':')[0]
        if FOREIGN.search(d) or (g and g[3] is not None and g[3] < 0.3 and g[0] != 'PASS'):
            return 'non_us'
        chain = fr.chain_block(names.get(d, ''), d, g[2] if g else None)
        if chain:
            return chain
        if prod_row:
            if g and g[0] == 'REJECT':
                return 'icp_reject'
        elif not g:
            return 'no_gate'
        elif g[0] == 'REJECT':
            return 'icp_reject'
        elif g[0] != 'PASS':
            return 'icp_not_pass'
        if d in active and branches[d] < 3:
            return 'has_active_contact'
        return None

    def same_person(d, first, last):
        for n in people_at.get(d, []):
            sp = split_name(n)
            if sp and sp[0].lower() == first.lower() and sp[1][:1].lower() == last[:1].lower():
                return True
        return False

    # place names seen in any crawled street address: branch mailboxes (tacoma@, springfield@) are not people
    places = set()
    try:
        bc = load_mod('bc', os.path.join(TOOLS, 'branch_count.py'), ['x', 'x'])
        for label, run in RUNS:
            for f in glob.glob(os.path.join(run, 'sitecache', '*.json')):
                for pg in (jload(f, {}) or {}).get('pages') or []:
                    for m in bc.ADDR.finditer(pg.get('text') or ''):
                        places.add(re.sub(r'[^a-z]', '', m.group(1).lower()))
    except Exception:  # noqa: BLE001
        st['WARNING_place_list_unavailable'] += 1

    # first / last names seen anywhere in the runs (search results, reveals, team pages, production contacts)
    FIRST, LAST = set(), set()
    def learn(n, first_only=False):
        parts = re.sub(r'[^a-z ]', ' ', (n or '').lower()).split()
        if parts and len(parts[0]) >= 2:
            FIRST.add(parts[0])
        if len(parts) >= 2 and not first_only and len(parts[-1]) >= 2:
            LAST.add(parts[-1])
    for p in prod:
        learn(p.get('contact_name'))
    for r in master:
        learn(r.get('buyer_name'))
    for label, run in RUNS:
        for ps in (jload(os.path.join(run, 'people_by_domain.json'), {}) or {}).values():
            for p in ps:
                learn(p.get('first'), first_only=True)
        for ps in (jload(os.path.join(run, 'buyers_site.json'), {}) or {}).values():
            for p in ps or []:
                learn(p.get('name'))
        rp = os.path.join(run, 'reveal', 'all.rows')
        for line in open(rp, errors='replace') if os.path.exists(rp) else []:
            x = line.split('|')
            if len(x) > 4:
                learn(x[4])

    def personal_local(loc, d):
        low = loc.lower()
        flat = re.sub(r'[^a-z]', '', low)
        if not flat or len(flat) < 3 or MAILBOX_WORD.search(loc) or flat in places or flat == re.sub(r'[^a-z]', '', d.split('.')[0]):
            return False
        m = re.fullmatch(r'([a-z]+)[._]([a-z]+)', low)
        if m:  # first.last / f.last
            a, b = m.groups()
            return (a in FIRST or len(a) == 1) and (b in LAST or len(b) >= 3 and a in FIRST)
        if not re.fullmatch(r'[a-z]+', low):
            return False
        return low in FIRST or (low[1:] in LAST and len(low) >= 5) or (low[2:] in LAST and len(low) >= 6) \
            or any(low.startswith(f) and low[len(f):] in LAST for f in FIRST if 3 <= len(f) < len(low) - 2)

    def other_org(title, d):
        m = ORG_TAIL.search(title or '')
        if not m:
            return False
        tail = {w for w in re.sub(r'[^a-z ]', ' ', m.group(1).lower()).split() if len(w) > 2} - {
            'inc', 'llc', 'the', 'and', 'certified', 'group', 'sales', 'business', 'development', 'operations', 'founder',
            'owner', 'president', 'ceo', 'partner', 'managing', 'principal', 'chief', 'officer', 'executive', 'vice', 'coo'}
        own = set(re.sub(r'[^a-z ]', ' ', (names.get(d, '') + ' ' + d.split('.')[0]).lower()).split())
        lab = d.split('.')[0]
        return bool(tail) and not (tail & own) and not any(w in lab for w in tail)

    L1, L2 = {}, {}

    def add1(email, d, run, lead, reason, name='', title=''):
        e = email.strip().lower()
        loc, _, edom = e.partition('@')
        if not loc or not edom:
            return
        if ROLE.match(re.sub(r'[._-]', '', loc)) or ROLE.match(loc):
            st['excluded_role_mailbox'] += 1
            return
        if edom in PERSONAL:
            st['excluded_personal_mailbox'] += 1
            return
        for why, bad in (('already_in_production', e in prod_emails), ('already_approved', e in master_emails),
                         ('suppressed', e in supp), ('pending_owner_verification', e in pending)):
            if bad:
                st['excluded_' + why] += 1
                return
        why = company_ok(d, prod_row=reason == 'PROD_NEVER_EMAILED')
        if why:
            st['excluded_' + why] += 1
            return
        if e not in L1:
            L1[e] = {'email': e, 'run': run, 'lead_id': lead, 'company_domain': d, 'company_name': names.get(d, ''),
                     'hold_reason': reason, 'known_name': name, 'known_title': title, 'branches': branches[d],
                     'multi_branch_second': str(d in active).lower()}

    def add2(name, d, run, lead, reason, title='', apollo_id=''):
        sp = split_name(name)
        if not sp:
            st['excluded_not_full_name'] += 1
            return
        f, l = sp
        if same_person(d, f, l):
            st['excluded_already_contacted_person'] += 1
            return
        why = company_ok(d)
        if why:
            st['excluded_' + why] += 1
            return
        k = (f.lower(), l.lower(), d)
        if k not in L2:
            L2[k] = {'first_name': f, 'last_name': l, 'company_name': names.get(d, '') or d, 'company_domain': d, 'run': run,
                     'lead_id': lead, 'hold_reason': reason, 'known_title': title, 'apollo_id': apollo_id,
                     'branches': branches[d], 'multi_branch_second': str(d in active).lower()}

    masked = collections.defaultdict(list)
    for label, run in RUNS:
        holds = (jload(os.path.join(run, 'contact_qc.json'), {}) or {}).get('holds', {})
        targets = {t['domain']: t for t in (jload(os.path.join(run, 'targets.json'), []) or []) if isinstance(t, dict)}
        # A) reveal / QC rows
        for line in open(os.path.join(run, 'reveal', 'all.rows'), errors='replace') if os.path.exists(os.path.join(run, 'reveal', 'all.rows')) else []:
            x = line.rstrip('\n').split('|')
            if len(x) < 8:
                continue
            d, name, title, email = x[1], x[4] or x[2], x[5], x[6].strip().lower()
            h = holds.get(d, '')
            code = h.split(':')[0]
            src = (targets.get(d) or {}).get('source', 'apollo')
            if '@' not in email or code == 'NO_EMAIL' or 'NO MATCH' in x[2]:
                add2(name, d, label, x[3], 'NO_EMAIL', title, x[3])
            elif code == 'PERSON_MISMATCH':
                add1(email, d, label, x[3], 'PERSON_MISMATCH', name, title)
            elif code == 'NOT_BUYER' and (not title.strip() or title.strip().lower() in ('none', 'executive', 'n/a')):
                add1(email, d, label, x[3], 'NOT_BUYER_UNKNOWN_TITLE', name, title)
            elif code in ('VERIFY_UNKNOWN', 'VERIFY_INVALID', 'VERIFY_RISKY', 'DOMAIN_UNPROVEN'):
                add2(name, d, label, x[3], code + ('_GETLEADS' if str(src).startswith('getleads') else ''), title, '')
            elif code == 'VERIFY_PENDING':
                st['skipped_pending_owner_verification'] += 1
        # B) GetLeads lines without an email
        for f in glob.glob(os.path.join(run, 'gl', 'raw', 'D*.txt')) or glob.glob(os.path.join(run, 'gl', 'D*.txt')):
            for line in open(f, errors='replace'):
                x = line.rstrip('\n').split('|')
                if len(x) >= 12 and x[1] not in ('NONE', 'ERROR') and '@' not in x[5] and tier(x[3]):
                    add2(f'{x[1]} {x[2]}', root(x[0]), label, '', 'GETLEADS_NO_EMAIL', x[3])
        # C) owner-gap guesses
        cands = jload(os.path.join(run, 'owner_gap', 'candidates_raw.json')) or jload(os.path.join(run, 'owner_gap', 'candidates.json'), []) or []
        ver = {}
        for vf in ('owner_gap/verify.json', 'verification.json'):
            ver.update({k.lower(): v for k, v in (jload(os.path.join(run, vf), {}) or {}).items()})
        byp = collections.defaultdict(list)
        for c in cands:
            byp[(c['domain'], c['name'])].append(c)
        for (d, name), cs in byp.items():
            first = name.split()[0].lower()
            order = sorted(cs, key=lambda c: c.get('guess') or (1 if c['email'].split('@')[0].lower() == first else 2 if '.' in c['email'] else 3))[:2]
            vs = [str((ver.get(c['email'].lower()) or {}).get('validity', '')).lower() for c in order]
            if 'valid' in vs:
                continue
            if vs and vs[0] == '':
                add1(order[0]['email'], d, label, '', 'OWNER_GAP_GUESS_1', name, order[0].get('title', ''))
            elif len(vs) > 1 and vs[0] == 'invalid' and vs[1] == '':
                add1(order[1]['email'], d, label, '', 'OWNER_GAP_GUESS_2', name, order[1].get('title', ''))
            elif all(v == 'invalid' for v in vs):
                add2(name, d, label, '', 'OWNER_GAP_GUESSES_INVALID', order[0].get('title', ''))
        # D) team-page owners / executives
        for d, ps in (jload(os.path.join(run, 'buyers_site.json'), {}) or {}).items():
            for p in ps or []:
                t = (p.get('title') or '').strip()
                if t and len(t) <= 70 and not BAD_TITLE.search(t) and not re.search(r'\d', t) and tier(t) and not other_org(t, d):
                    add2(p.get('name', ''), d, label, '', 'TEAM_PAGE', t)
        # E) personal-looking addresses on the company's own site (eligible companies only)
        for f in glob.glob(os.path.join(run, 'sitecache', '*.json')):
            d = os.path.basename(f)[:-5]
            if company_ok(d):
                continue
            try:
                pages = (jload(f, {}) or {}).get('pages') or []
            except AttributeError:
                continue
            for pg in pages:
                for loc, edom in EMAIL_RX.findall(pg.get('text') or ''):
                    if root(edom) == d and personal_local(loc, d):
                        add1(f'{loc}@{edom}', d, label, '', 'SITE_EMAIL')
        # G) masked Apollo previews (counted, not listed)
        for d, ps in (jload(os.path.join(run, 'people_by_domain.json'), {}) or {}).items():
            if company_ok(d):
                continue
            for p in ps:
                if p.get('has_email') and p.get('id') not in revealed and tier(p.get('title')) \
                        and not any(sbp.first_key(p.get('first')) == sbp.first_key((split_name(n) or ('', ''))[0])
                                    for n in people_at.get(d, [])):
                    masked[d].append(p.get('id'))
    # F) production rows never emailed, missing a name or title
    pl = {l['lead_id']: l for l in (jload(f'{REPO}/runs-private/second-buyer-2026-11-24/prod_leads.json', []) or [])}
    for p in prod:
        if p['emailed'] or p['stage'] in ('Queued',) or p['campaign'] == 'Industrial Campaign 3' or not p['email']:
            continue
        title = (pl.get(p['lead_id']) or {}).get('title') or ''
        if not split_name(p.get('contact_name')) or not title:
            d = root(p['domain']) or p['email'].split('@')[-1]
            # the row's own address is in production by definition; judge it on everything else
            prod_emails.discard(p['email'])
            add1(p['email'], d, 'production', p['lead_id'], 'PROD_NEVER_EMAILED', p.get('contact_name') or '', title)
            prod_emails.add(p['email'])
    # people already listed in list 2 do not need list 1 for the same company+name
    l1, l2 = list(L1.values()), list(L2.values())
    with open(os.path.join(OUT, 'list1_emails.csv'), 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['email'])
        w.writerows([r['email']] for r in l1)
    with open(os.path.join(OUT, 'list2_names.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=['first_name', 'last_name', 'company_name', 'company_domain'], extrasaction='ignore')
        w.writeheader()
        w.writerows(l2)
    for name, rows in (('list1_key.csv', l1), ('list2_key.csv', l2)):
        if rows:
            with open(os.path.join(OUT, name), 'w', newline='') as f:
                w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
                w.writeheader()
                w.writerows(rows)
    mc = {d: v for d, v in masked.items()}
    counts = {
        'list1_rows': len(l1), 'list2_rows': len(l2),
        'list1_by_run_reason': dict(collections.Counter(f"{r['run']}|{r['hold_reason']}" for r in l1)),
        'list2_by_run_reason': dict(collections.Counter(f"{r['run']}|{r['hold_reason']}" for r in l2)),
        'list1_companies': len({r['company_domain'] for r in l1}), 'list2_companies': len({r['company_domain'] for r in l2}),
        'companies_covered_either': len({r['company_domain'] for r in l1} | {r['company_domain'] for r in l2}),
        'multi_branch_second_rows': sum(1 for r in l1 + l2 if r['multi_branch_second'] == 'true'),
        'masked_apollo_people_excluded': sum(len(set(v)) for v in mc.values()), 'masked_apollo_companies': len(mc),
        'masked_companies_not_in_lists': len(set(mc) - ({r['company_domain'] for r in l1} | {r['company_domain'] for r in l2})),
        'exclusions': dict(st),
    }
    json.dump(counts, open(os.path.join(OUT, 'counts.json'), 'w'), indent=1)
    print(json.dumps(counts, indent=1))


if __name__ == '__main__':
    main()
