"""Stage 9: contact QC (skill section 9) over all three buyer paths, and the run files build_outputs.py reads.

Usage: python3 -I contact_qc.py <run> [--master <V4 master csv>]

Paths (one buyer per PASS company, in this order; a company only reaches a later path when the earlier
one found no eligible buyer):
  apollo     reveal/apollo.rows (parse_reveal.py output) + reveal/targets_ordered.json   source apollo_free_search
  getleads   gl/D*.txt lookup lines (domain|first|last|title|seniority|work_email|email_status|employer|
             employer_site|company_domain|role_start|credits) + gl/verify.json         source getleads_decision_makers
  owner-gap  owner_gap/candidates.json + owner_gap/verify.json                         source getleads_owner_gap_pattern
gl/verify.json and owner_gap/verify.json map email -> {validity, catch_all, gateway} from GetLeads verify_emails
(validity "job_failed" when a batch failed twice). Apollo emails are not re-verified: Apollo's own
"verified" status is required.

Writes: reveal/all.rows (all paths, renumbered), targets.json (one per row, with source), contact_qc.json,
buyer_shortfalls.json, contact_qc_summary.json (per-company path and result, no personal data in the counts).
Personal emails and phones are never read or written. Network: DNS-over-HTTPS MX lookups only.
"""
import collections
import csv
import glob
import importlib.util
import json
import os
import re
import sys
import urllib.parse
import urllib.request

RUN = sys.argv[1]
TOOLS = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(TOOLS, '..', '..', '..'))
MASTER = sys.argv[sys.argv.index('--master') + 1] if '--master' in sys.argv else f'{REPO}/docs/scalelab-sourcing/runs/V4_APPROVED_CONTACTS_MASTER.csv'

spec = importlib.util.spec_from_file_location('bp', os.path.join(TOOLS, 'buyer_pick.py'))
_argv, sys.argv = sys.argv, [sys.argv[0], 'x']
bp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bp)
sys.argv = _argv

ROLE = {'info', 'office', 'sales', 'admin', 'contact', 'hr', 'jobs', 'careers', 'hello', 'support', 'staffing', 'recruiting',
        'team', 'mail', 'accounting', 'billing', 'payroll', 'service', 'inquiries', 'marketing', 'help', 'general'}
OPS_ONLY = re.compile(r'(?i)\b(operations manager|director of operations|vp,? operations|vice president,? operations|ops)\b')
EMP_STOP = {'inc', 'llc', 'the', 'of', 'and', 'staffing', 'services', 'group', 'solutions', 'co', 'corp', 'company', 'personnel',
            'employment', 'agency', 'resources', 'workforce', 'international', 'usa', 'ltd', 'service'}
SRC = {'apollo': 'apollo_free_search', 'getleads': 'getleads_decision_makers', 'owner_gap': 'getleads_owner_gap_pattern'}


def root(d):
    d = re.sub(r'^https?://', '', (d or '').strip().lower()).split('/')[0].split(':')[0]
    return d[4:] if d.startswith('www.') else d


_mx = {}


def mx(dom):
    if dom not in _mx:
        try:
            r = json.loads(urllib.request.urlopen('https://dns.google/resolve?' + urllib.parse.urlencode({'name': dom, 'type': 'MX'}), timeout=20).read())
            v = ' '.join(a['data'] for a in r.get('Answer', [])).lower()
        except Exception:
            v = 'ERROR'
        _mx[dom] = ('proofpoint' if any(x in v for x in ('pphosted', 'ppe-hosted', 'gpphosted')) else 'google' if 'google' in v
                    else 'microsoft' if 'outlook' in v else 'mimecast' if 'mimecast' in v else 'barracuda' if 'barracuda' in v
                    else 'DNS_ERROR' if v == 'ERROR' else ('NO MX' if not v else 'other'))
    return _mx[dom]


def site(dom):
    t, hosts = '', set()
    for sub in ('sitecache', 'sitecache2', 'pwcache'):
        p = os.path.join(RUN, sub, dom + '.json')
        if os.path.exists(p):
            try:
                pages = json.load(open(p)).get('pages') or []
            except ValueError:
                continue
            for pg in pages:
                t += ' ' + (pg.get('text') or '') + ' ' + ' '.join(pg.get('links') or [] if isinstance(pg.get('links'), list) else [])
                h = root(pg.get('final_url'))
                if h:
                    hosts.add(h)
    return t.lower(), hosts


def employer_matches(employer, employer_site, company_name, dom):
    if not employer:
        return True
    if employer_site and employer_site == dom:
        return True
    et = [t for t in re.sub(r'[^a-z0-9 ]', ' ', employer.lower()).split() if t not in EMP_STOP]
    ct = {t for t in re.sub(r'[^a-z0-9 ]', ' ', (company_name or '').lower()).split() if t not in EMP_STOP}
    stem = dom.split('.')[0].replace('-', '')
    if any(t in ct for t in et if len(t) >= 2) or any(len(t) >= 3 and t in stem for t in et):
        return True
    words = [w for w in re.sub(r'[^a-z0-9 ]', ' ', employer.lower()).split() if w != 'the']
    acro = ''.join(w[0] for w in words)
    return len(acro) >= 2 and stem.startswith(acro)


def person_match(local, first, last):
    local = re.sub(r'[^a-z]', '', local.lower())
    first = re.sub(r'[^a-z]', '', (first or '').lower())
    last = re.sub(r'[^a-z]', '', (last or '').lower())
    if not local or not first:
        return False
    if (len(first) >= 3 and first in local) or (len(last) >= 3 and last in local):
        return True
    if last and (local.startswith(first[0] + last[:3]) or local == first[0] + last[0] or local.endswith(last[:3] + first[0])):
        return True
    return False


def domain_checks(d, e, company_name, exclude, master_emails, employer=None, employer_site=None, first=None, last=None):
    """Shared checks: returns (hold_reason or None, caution flags, mail gateway)."""
    local, edom = e.split('@', 1)
    text, hosts = site(d)
    related = {d} | hosts
    flags = []
    if e in master_emails:
        return 'DUPLICATE: email already in the V4 master', flags, None
    if local in ROLE:
        return 'ROLE_MAILBOX: shared/role address, not a named buyer', flags, None
    if edom.endswith('.edu') or edom.endswith('.gov'):
        return f'STALE_ORG: email at another organization ({edom.rsplit(".", 1)[-1]})', flags, None
    if edom not in related:
        if edom in text:
            flags.append(f'EMAIL_DOMAIN_DIFFERS (proven: {edom} referenced on the company site)')
        else:
            return f'DOMAIN_UNPROVEN: email on {edom}, not proven to belong to the agency', flags, None
    elif edom != d:
        flags.append(f'EMAIL_DOMAIN_DIFFERS (proven by redirect to {edom})')
    if edom != d and edom in exclude:
        return 'EXCLUDED_DOMAIN: email domain is already in production or earlier research', flags, None
    if employer is not None and ((employer_site and employer_site not in related and employer_site != edom) or
                                 not employer_matches(employer, employer_site, company_name, d)):
        return 'STALE_ORG: current employer is another organization', flags, None
    if first is not None and not person_match(local, first, last):
        return 'PERSON_MISMATCH: email address does not belong to the named buyer', flags, None
    g = mx(edom)
    if g in ('NO MX', 'DNS_ERROR'):
        return f'NO_MX: {g}', flags, g
    return None, flags, g


def verdict(v, g):
    """GetLeads verify_emails result -> (hold reason or None, flag, verification label)."""
    catch, val = bool(v.get('catch_all')), v.get('validity')
    pp = g == 'proofpoint' or v.get('gateway') == 'proofpoint'
    if not v:
        return 'VERIFY_UNKNOWN: not verified (no verification result)', None, 'unverified'
    if pp and catch:
        return 'PROOFPOINT_CATCHALL', None, 'catch_all'
    if val == 'valid' and not catch:
        return None, 'VERIFIED', 'verified'
    if val == 'valid' or (val == 'ambiguous' and catch):
        if pp:
            return 'VERIFY_UNKNOWN: catch-all behind Proofpoint', None, 'catch_all'
        return None, 'CATCH_ALL (queue last)', 'catch_all'
    if val == 'invalid':
        return 'VERIFY_INVALID: verify_emails says invalid', None, 'invalid'
    if val == 'job_failed':
        return 'VERIFY_UNKNOWN: verification batch failed twice at the provider (not charged)', None, 'unverified'
    return f'VERIFY_UNKNOWN: verify_emails result {val}' + (' behind Proofpoint' if pp else ''), None, 'unverified'


def main():
    dec = json.load(open(os.path.join(RUN, 'icp_decisions.json')))
    names = {x['domain']: x.get('company_name') for x in dec}
    passing = [x['domain'] for x in dec if x['company_icp'] == 'PASS']
    exclude = json.load(open(os.path.join(RUN, 'exclude_domains.json')))
    master_emails = {(r.get('email') or '').lower() for r in csv.DictReader(open(MASTER))} if os.path.exists(MASTER) else set()

    # ---- apollo path
    apollo, tord = {}, []
    tp = os.path.join(RUN, 'reveal', 'targets_ordered.json')
    if os.path.exists(tp):
        tord = json.load(open(tp))
    ap = os.path.join(RUN, 'reveal', 'apollo.rows')
    if os.path.exists(ap):
        for line in open(ap, errors='replace'):
            x = line.rstrip('\n').split('|')
            if len(x) >= 3 and x[0].isdigit():
                apollo[x[1]] = x
    # ---- getleads path
    gl = {}
    for f in sorted(glob.glob(os.path.join(RUN, 'gl', 'D*.txt'))):
        for line in open(f, encoding='utf-8', errors='replace'):
            x = line.rstrip('\n').split('|')
            if len(x) < 12:
                continue
            dom = root(x[0])
            rec = gl.setdefault(dom, {'people': [], 'status': 'ok'})
            if x[1] in ('NONE', 'ERROR'):
                rec['status'] = x[1].lower()
                continue
            rec['people'].append({'first': x[1], 'last': x[2], 'title': x[3], 'work_email': x[5].strip().lower(), 'gl_status': x[6],
                                  'employer': x[7], 'employer_site': root(x[8]), 'role_start': x[10]})
    glv_p = os.path.join(RUN, 'gl', 'verify.json')
    glv = json.load(open(glv_p)) if os.path.exists(glv_p) else {}
    # ---- owner-gap path: one address per person, preference first.last@ > flast@ > first@, valid non-catch-all only
    og = {}
    oc_p, ov_p = os.path.join(RUN, 'owner_gap', 'candidates.json'), os.path.join(RUN, 'owner_gap', 'verify.json')
    ogv = json.load(open(ov_p)) if os.path.exists(ov_p) else {}
    og_tried = set()
    if os.path.exists(oc_p):
        def pref(c):
            local = c['email'].split('@')[0]
            return (c['domain'], 0 if '.' in local else 2 if local == c['name'].split()[0].lower() else 1)
        for c in sorted(json.load(open(oc_p)), key=pref):
            og_tried.add(c['domain'])
            v = ogv.get(c['email']) or {}
            if c['domain'] in og or v.get('validity') != 'valid' or v.get('catch_all') or v.get('gateway') == 'proofpoint':
                continue
            og[c['domain']] = c

    rows, targets, holds, caution, short, summ = [], [], {}, {}, {}, []
    tmap = {t['domain']: t for t in tord}
    for d in sorted(passing):
        rec = {'domain': d, 'path': None, 'result': None}
        t = tmap.get(d)
        if d in apollo and t:
            x = apollo[d]
            rec['path'] = 'apollo'
            name, title = x[4] if len(x) > 4 else '', x[5] if len(x) > 5 else ''
            e = (x[6] if len(x) > 6 else '').strip().lower()
            est = (x[7] if len(x) > 7 else '').lower()
            catch = (x[8] if len(x) > 8 else '') == 'True'
            flagset = x[13] if len(x) > 13 else ''
            why, fl = None, []
            if len(x) < 6 or 'NO MATCH' in x[2]:
                why = 'NO_MATCH: Apollo reveal returned no match'
            elif '@' not in e:
                why = 'NO_EMAIL: the reveal returned no email'
            elif 'WRONG PERSON' in flagset:
                why = 'PERSON_MISMATCH: the reveal matched a different person'
            elif title.strip().lower() not in ('', 'none', 'executive') and (not bp.tier(title) or OPS_ONLY.search(title)):
                why = 'NOT_BUYER: revealed title is not a tier 1-2 buyer'
            else:
                why, fl, g = domain_checks(d, e, names.get(d), exclude, master_emails, first=t.get('first'), last=None)
                if not why:
                    if est != 'verified':
                        why = f'APOLLO_UNVERIFIED: Apollo email status "{est or "none"}"'
                    elif g == 'proofpoint' and catch:
                        why = 'PROOFPOINT_CATCHALL'
                    else:
                        fl.append('CATCH_ALL (queue last)' if catch else 'VERIFIED (Apollo)')
                        rec['verification'] = 'catch_all' if catch else 'verified'
            rows.append(x[:14] + [''] * (14 - len(x[:14])))
            targets.append(dict(t, source=SRC['apollo']))
        elif d in gl and any(bp.tier(p['title']) and not OPS_ONLY.search(p['title']) for p in gl[d]['people']):
            rec['path'] = 'getleads'
            elig = sorted([p for p in gl[d]['people'] if bp.tier(p['title']) and not OPS_ONLY.search(p['title'])], key=lambda p: bp.tier(p['title']))
            p = elig[0]
            tr = bp.tier(p['title'])
            name, e = f"{p['first']} {p['last']}".strip(), p['work_email']
            why, fl, v = None, [], glv.get(p['work_email']) or {}
            if '@' not in e:
                why = 'NO_EMAIL: buyer found, no work email'
            else:
                why, fl, g = domain_checks(d, e, names.get(d), exclude, master_emails, p['employer'], p['employer_site'], p['first'], p['last'])
                if not why:
                    why, f2, lab = verdict(v, g)
                    if f2:
                        fl.append(f2)
                        rec['verification'] = lab
            est = ('verified ' + str(v.get('validity'))) if v else f"{p['gl_status'] or 'UNKNOWN'} (GetLeads flag), unverified"
            rows.append([0, d, name, '', name, p['title'], e, est, 'True' if v.get('catch_all') else 'False', '', p['role_start'], '', d, 'OK'])
            targets.append({'domain': d, 'first': p['first'], 'last': p['last'], 'title': p['title'], 'tier': tr[0], 'source': SRC['getleads']})
        elif d in og:
            rec['path'] = 'owner_gap'
            c = og[d]
            nm = c['name'].split()
            why, fl, g = domain_checks(d, c['email'], names.get(d), exclude, master_emails)
            if not why:
                fl.append('VERIFIED (owner-gap pattern address; owner named on the company site)')
                rec['verification'] = 'verified'
            rows.append([0, d, c['name'], '', c['name'], c['title'], c['email'], 'verified valid (pattern on site-confirmed owner)', 'False', '', '', '', d, 'OK'])
            targets.append({'domain': d, 'first': nm[0], 'last': nm[-1], 'title': c['title'], 'tier': c['tier'], 'source': SRC['owner_gap']})
        else:
            rec['result'] = 'NO_BUYER'
            if d in og_tried:
                short[d] = 'Owner-gap pattern guesses: none verified valid and not catch-all'
            elif d in gl:
                short[d] = ('GetLeads decision-maker lookup: no one returned' if not gl[d]['people'] else
                            'GetLeads decision-maker lookup: only non-buyer titles (recruiting, HR, finance, operations, technology)')
            else:
                short[d] = 'No tier 1-2 buyer in Apollo free search, the company site or GetLeads'
            summ.append(rec)
            continue
        if why:
            holds[d] = why
            rec['result'] = why.split(':')[0]
        else:
            caution[d] = '; '.join(fl)
            rec['result'] = 'PASS'
        summ.append(rec)

    out_rows = []
    for i, r in enumerate(rows):
        r = [str(z).replace('|', '/').replace('\n', ' ') for z in r]
        r[0] = str(i)
        out_rows.append('|'.join(r))
    os.makedirs(os.path.join(RUN, 'reveal'), exist_ok=True)
    open(os.path.join(RUN, 'reveal', 'all.rows'), 'w').write('\n'.join(out_rows) + ('\n' if out_rows else ''))
    for nm, obj in [('targets.json', targets), ('buyer_shortfalls.json', short), ('contact_qc.json', {'holds': holds, 'caution': caution}),
                    ('contact_qc_summary.json', summ)]:
        json.dump(obj, open(os.path.join(RUN, nm), 'w'), indent=1)
    by = collections.defaultdict(collections.Counter)
    for s in summ:
        by[s['path'] or 'none'][s['result']] += 1
        if s.get('verification'):
            by[s['path']]['verification:' + s['verification']] += 1
    print(json.dumps({k: dict(v) for k, v in by.items()}, indent=1))


if __name__ == '__main__':
    main()
