"""Stage 9: contact QC (skill section 9) over all three buyer paths, and the run files build_outputs.py reads.

Usage: python3 -I contact_qc.py <run> [--master <V4 master csv>]

Paths (one buyer per PASS company, in this order; a company only reaches a later path when the earlier
one found no eligible buyer):
  apollo     reveal/apollo.rows (parse_reveal.py output) + reveal/targets_ordered.json   source apollo_free_search
  getleads   gl/D*.txt lookup lines (domain|first|last|title|seniority|work_email|email_status|employer|
             employer_site|company_domain|role_start|credits)                           source getleads_decision_makers
  owner-gap  owner_gap/candidates.json (guess 1 first@, guess 2 first.last@)             source getleads_owner_gap_pattern

Verification (owner decision 2026-11-24): the OWNER verifies GetLeads-sourced and owner-gap addresses by uploading
<run>/to_verify.csv to GetLeads; Claude Code never submits or polls verification jobs and never uses Apollo
validation. Results come back through tools/ingest_verification.py into <run>/verification.json
(email -> {validity, catch_all, gateway}); the legacy gl/verify.json and owner_gap/verify.json are still read
(verification.json wins). Without a result the contact is held as VERIFY_PENDING. Mapping:
  valid -> keep;  catch-all / accept-all -> keep, flag, queue last;  invalid / unknown / risky -> HOLD.
  Owner-gap: only guess 1 goes out first; guess 2 only after guess 1 is invalid; a catch-all domain is a HOLD
  for a guessed address (accept-all proves nothing about a guess). Proofpoint + catch-all stays a HOLD.
Apollo-revealed emails are not re-verified: Apollo's own "verified" status is required.

Writes: reveal/all.rows (all paths, renumbered), targets.json (one per row, with source), contact_qc.json,
buyer_shortfalls.json, contact_qc_summary.json (per-company path and result, no personal data in the counts),
to_verify.csv (one column "email", deduped: the addresses still waiting on the owner) and verify_pending.json
([{domain, path, email}], for the next run's carry-over check).
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


_proof = {}


def reverse_proof(edom, d):
    """Skill section 9, redirect 'either way': the email domain's own homepage redirects to, or links to,
    the company domain. Cached in <run>/email_domain_proof.json. Fails closed (unproven) on any error."""
    path = os.path.join(RUN, 'email_domain_proof.json')
    if not _proof and os.path.exists(path):
        _proof.update(json.load(open(path)))
    key = f'{edom}->{d}'
    if key not in _proof:
        ok, how = False, 'unreachable'
        for start in (f'https://{edom}', f'https://www.{edom}', f'http://{edom}'):
            try:
                req = urllib.request.Request(start, headers={'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html'})
                with urllib.request.urlopen(req, timeout=15) as r:
                    final = root(r.geturl())
                    body = r.read(800_000).decode('utf-8', 'ignore').lower()
                if final == d or final.endswith('.' + d):
                    ok, how = True, f'redirects to {final}'
                elif re.search(r'(https?:)?//(www\.)?' + re.escape(d) + r'\b', body):
                    ok, how = True, 'links to the company domain'
                else:
                    how = f'final host {final}, no link to the company domain'
                break
            except Exception as e:
                how = type(e).__name__
        _proof[key] = {'proven': ok, 'how': how}
        json.dump(_proof, open(path, 'w'), indent=1)
    return _proof[key]['proven']


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
        elif reverse_proof(edom, d):
            flags.append(f'EMAIL_DOMAIN_DIFFERS (proven: {edom} redirects or links to {d})')
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


PENDING = 'VERIFY_PENDING: awaiting the owner\'s GetLeads verification (to_verify.csv)'


def load_verification(run):
    """email -> {validity, catch_all, gateway}: legacy per-path files, then the owner's ingested results (win)."""
    v = {}
    for f in (os.path.join(run, 'gl', 'verify.json'), os.path.join(run, 'owner_gap', 'verify.json'), os.path.join(run, 'verification.json')):
        if os.path.exists(f):
            v.update({k.strip().lower(): x for k, x in json.load(open(f)).items()})
    return v


def verdict(v, g):
    """Verification result -> (hold reason or None, flag, verification label)."""
    if not v:
        return PENDING, None, 'pending'
    val = str(v.get('validity') or '').lower()
    catch = bool(v.get('catch_all')) or val in ('catch_all', 'accept_all')
    pp = g == 'proofpoint' or v.get('gateway') == 'proofpoint'
    if val == 'risky':
        return 'VERIFY_RISKY: GetLeads says risky', None, 'risky'
    if val == 'unknown':
        return 'VERIFY_UNKNOWN: GetLeads says unknown', None, 'unverified'
    if pp and catch:
        return 'PROOFPOINT_CATCHALL', None, 'catch_all'
    if val == 'valid' and not catch:
        return None, 'VERIFIED', 'verified'
    if val in ('valid', 'catch_all', 'accept_all') or (val == 'ambiguous' and catch):
        if pp:
            return 'VERIFY_UNKNOWN: catch-all behind Proofpoint', None, 'catch_all'
        return None, 'CATCH_ALL (queue last)', 'catch_all'
    if val == 'invalid':
        return 'VERIFY_INVALID: GetLeads says invalid', None, 'invalid'
    if val == 'job_failed':
        return 'VERIFY_UNKNOWN: verification batch failed twice at the provider (not charged)', None, 'unverified'
    if val == 'not_completed':
        return 'VERIFY_UNKNOWN: verification batch still queued at the provider after the final poll', None, 'unverified'
    return f'VERIFY_UNKNOWN: GetLeads result {val}' + (' behind Proofpoint' if pp else ''), None, 'unverified'


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
    ver = load_verification(RUN)
    glv = ogv = ver
    pending = []  # [{domain, path, email}] still waiting on the owner's verification
    # ---- owner-gap path: one address per person. Guess 1 (first@) first; guess 2 (first.last@) only after guess 1 is
    # invalid; never more than 2. Legacy third patterns (flast@) are used only if they already carry a result.
    og, og_state = {}, {}
    oc_p = os.path.join(RUN, 'owner_gap', 'candidates.json')
    og_tried = set()
    if os.path.exists(oc_p):
        def guess_no(c):
            if c.get('guess'):
                return int(c['guess'])
            local, first = c['email'].split('@')[0], c['name'].split()[0].lower()
            return 1 if local == first else 2 if '.' in local else 3
        bydom = collections.defaultdict(list)
        for c in json.load(open(oc_p)):
            bydom[c['domain']].append(dict(c, email=c['email'].strip().lower(), guess=guess_no(c)))
        def clean(v):
            return v and str(v.get('validity') or '').lower() == 'valid' and not v.get('catch_all') and v.get('gateway') != 'proofpoint'
        for d, cs in bydom.items():
            og_tried.add(d)
            # an address already in the master first, so a re-run never swaps an approved contact's email
            ok = [c for c in sorted(cs, key=lambda c: (c['email'] not in master_emails, c['guess'])) if clean(ogv.get(c['email']))]
            if ok:  # a clean valid guess always wins (legacy runs verified several patterns at once)
                og_state[d], og[d] = ('ok', ok[0]), ok[0]
                continue
            for c in sorted(cs, key=lambda c: c['guess']):
                v = ogv.get(c['email'])
                if not v:
                    if c['guess'] <= 2:
                        og_state[d] = ('pending', c)
                    break
                val = str(v.get('validity') or '').lower()
                if val == 'invalid':
                    og_state[d] = ('invalid', c)
                    continue
                # catch-all (a guess on an accept-all domain proves nothing), unknown, risky: hold, no further guesses
                og_state[d] = ('hold', c, 'VERIFY_CATCHALL_GUESS: guessed address on a catch-all domain proves nothing'
                               if val in ('catch_all', 'accept_all') or v.get('catch_all') else f'VERIFY_{val.upper() or "UNKNOWN"}: owner-gap guess')
                break

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
                nm = (name or '').split()
                why, fl, g = domain_checks(d, e, names.get(d), exclude, master_emails,
                                           first=nm[0] if nm else t.get('first'), last=nm[-1] if len(nm) > 1 else '')
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
                    rec['verification'] = lab
                    if f2:
                        fl.append(f2)
                    if lab == 'pending':
                        pending.append({'domain': d, 'path': 'getleads', 'email': e})
            est = ('verified ' + str(v.get('validity'))) if v else f"{p['gl_status'] or 'UNKNOWN'} (GetLeads flag), unverified"
            rows.append([0, d, name, '', name, p['title'], e, est, 'True' if v.get('catch_all') else 'False', '', p['role_start'], '', d, 'OK'])
            targets.append({'domain': d, 'first': p['first'], 'last': p['last'], 'title': p['title'], 'tier': tr[0], 'source': SRC['getleads']})
        elif d in og_state and og_state[d][0] in ('ok', 'pending', 'hold'):
            rec['path'] = 'owner_gap'
            state, c = og_state[d][0], og_state[d][1]
            nm = c['name'].split()
            why, fl, g = domain_checks(d, c['email'], names.get(d), exclude, master_emails)
            if not why and state == 'pending':
                why = PENDING + f" (owner-gap guess {c['guess']} of 2)"
                rec['verification'] = 'pending'
                pending.append({'domain': d, 'path': 'owner_gap', 'email': c['email']})
            elif not why and state == 'hold':
                why = og_state[d][2]
                rec['verification'] = 'unverified'
            elif not why:
                fl.append('VERIFIED (owner-gap pattern address; owner named on the company site)')
                rec['verification'] = 'verified'
            rows.append([0, d, c['name'], '', c['name'], c['title'], c['email'], 'verified valid (pattern on site-confirmed owner)', 'False', '', '', '', d, 'OK'])
            targets.append({'domain': d, 'first': nm[0], 'last': nm[-1], 'title': c['title'], 'tier': c['tier'], 'source': SRC['owner_gap']})
        else:
            rec['result'] = 'NO_BUYER'
            if d in og_tried:
                short[d] = 'Owner-gap pattern guesses: both guesses came back invalid'
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
                    ('contact_qc_summary.json', summ), ('verify_pending.json', pending)]:
        json.dump(obj, open(os.path.join(RUN, nm), 'w'), indent=1)
    # The owner's upload file: ONE column, header "email", deduped, nothing else (no names, no companies).
    to_verify = sorted({p['email'] for p in pending})
    with open(os.path.join(RUN, 'to_verify.csv'), 'w', newline='') as f:
        wr = csv.writer(f)
        wr.writerow(['email'])
        wr.writerows([e] for e in to_verify)
    print(f'to_verify.csv: {len(to_verify)} addresses awaiting the owner -> {os.path.join(RUN, "to_verify.csv")}')
    by = collections.defaultdict(collections.Counter)
    for s in summ:
        by[s['path'] or 'none'][s['result']] += 1
        if s.get('verification'):
            by[s['path']]['verification:' + s['verification']] += 1
    print(json.dumps({k: dict(v) for k, v in by.items()}, indent=1))


if __name__ == '__main__':
    main()
