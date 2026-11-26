"""Ingest GetLeads enrichment results for the two enrichment lists (owner brief 2026-11-24). Offline except DNS MX.

Usage: python3 -I enrich_ingest.py <dir> [--credits-before N --credits-after M] [--copy-worktree <path to the copy v2 tree>]

<dir> holds list1_key.csv / list2_key.csv (from enrich_lists.py) and the owner's enriched_list1.csv / enriched_list2.csv.
Matching: list 1 by email; list 2 by first name + last name + company domain (case-insensitive). Phone numbers and personal
addresses are ignored entirely (never read into the outputs).
Status: VALID -> verified; catch-all / accept-all -> keep, flag, queue last; anything else -> HOLD.
Then, as a run folder <dir>/ingest_run: buyer tiers (buyer_pick.py rules), the second-buyer filter (never anyone already
emailed or approved, a different buyer role than prior contacts), contact QC (contact_qc.py, section 9: domain, MX,
person match, dedupe against the V4 master and every production address), build_outputs.py against a SCRATCH copy of
the master (the V4 master is never written here), build_evidence.py + the copy v2 preview. Prints counts only.
Companies without a V4 PASS (production never-emailed rows) are reported as needing a re-gate, not output.
"""
import collections
import csv
import glob
import json
import os
import re
import shutil
import subprocess
import sys

TOOLS = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(TOOLS, '..', '..', '..'))
PERSONAL = {'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com', 'live.com', 'msn.com', 'comcast.net',
            'att.net', 'sbcglobal.net', 'verizon.net', 'me.com', 'ymail.com', 'protonmail.com', 'bellsouth.net', 'cox.net'}
SP = '/tmp/claude-0/-home-user-SalesPipeline2/2ac8488f-fce7-5c12-b5fb-d98394461a32/scratchpad'


def arg(n, d=None):
    return sys.argv[sys.argv.index(n) + 1] if n in sys.argv else d


def norm_row(r):
    """Lower-cased, underscore keys; phone and personal-email columns dropped."""
    out = {}
    for k, v in r.items():
        kk = re.sub(r'[^a-z0-9]+', '_', (k or '').strip().lower()).strip('_')
        if 'phone' in kk or 'mobile' in kk or 'personal' in kk:
            continue
        out[kk] = (v or '').strip()
    return out


def pick(r, *names):
    for n in names:
        if r.get(n):
            return r[n]
    return ''


def status_of(r):
    s = re.sub(r'[^a-z]', '_', pick(r, 'email_status', 'work_email_status', 'status', 'validity', 'verification_status').lower())
    if 'catch' in s or 'accept' in s:
        return 'catch_all'
    if s.strip('_') in ('valid', 'verified', 'deliverable'):
        return 'valid'
    return s.strip('_') or 'unknown'


def main():
    d = os.path.abspath(sys.argv[1])
    run = os.path.join(d, 'ingest_run')
    os.makedirs(os.path.join(run, 'gl'), exist_ok=True)
    keys1 = {r['email'].lower(): r for r in csv.DictReader(open(os.path.join(d, 'list1_key.csv')))} if os.path.exists(os.path.join(d, 'list1_key.csv')) else {}
    keys2 = {(r['first_name'].lower(), r['last_name'].lower(), r['company_domain'].lower()): r
             for r in csv.DictReader(open(os.path.join(d, 'list2_key.csv')))} if os.path.exists(os.path.join(d, 'list2_key.csv')) else {}
    st = collections.Counter()
    found = []  # (key row, name, title, email, status)
    for n, keys in (('1', keys1), ('2', keys2)):
        p = os.path.join(d, f'enriched_list{n}.csv')
        if not os.path.exists(p):
            continue
        seen = set()
        for raw in csv.DictReader(open(p, newline='', encoding='utf-8-sig')):
            r = norm_row(raw)
            st[f'list{n}_result_rows'] += 1
            email = pick(r, 'work_email', 'email', 'business_email', 'email_address').lower()
            if n == '1':
                k = keys.get(pick(r, 'email', 'input_email', 'original_email').lower() or email)
            else:
                k = keys.get((pick(r, 'first_name', 'first').lower(), pick(r, 'last_name', 'last').lower(),
                              pick(r, 'company_domain', 'domain', 'website').lower().replace('www.', '').split('/')[0]))
            if not k:
                st[f'list{n}_unmatched'] += 1
                continue
            kid = k.get('email') or (k['first_name'], k['last_name'], k['company_domain'])
            if kid in seen:
                continue
            seen.add(kid)
            st[f'list{n}_matched'] += 1
            name = pick(r, 'full_name', 'name') or f"{pick(r, 'first_name', 'first')} {pick(r, 'last_name', 'last')}".strip()
            title = pick(r, 'current_title', 'title', 'job_title', 'position')
            if not email or '@' not in email or email.split('@')[1] in PERSONAL:
                st[f'list{n}_no_work_email'] += 1
                email = '' if n == '2' else k.get('email', '')
            if email:
                st[f'list{n}_with_email'] += 1
            found.append((k, name or f"{k.get('known_name', '')}", title or k.get('known_title', ''), email, status_of(r)))
    # ---- assemble a run folder for the standard QC / outputs tools
    gate, srcdir = {}, {}
    import importlib.util
    spec = importlib.util.spec_from_file_location('el', os.path.join(TOOLS, 'enrich_lists.py'))
    old, sys.argv = sys.argv, ['x', d]
    el = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(el)
    sys.argv = old
    for label, rd in el.RUNS:
        for x in json.load(open(os.path.join(rd, 'icp_decisions.json'))) if os.path.exists(os.path.join(rd, 'icp_decisions.json')) else []:
            if x.get('icp_reason_code') != 'DUPLICATE':
                gate[x['domain']] = x
                srcdir[x['domain']] = rd
    doms = sorted({k['company_domain'] for k, *_ in found})
    regate = [x for x in doms if (gate.get(x) or {}).get('company_icp') != 'PASS']
    st['companies_needing_regate'] = len(regate)
    dec = [gate[x] for x in doms if x not in regate]
    json.dump(dec, open(os.path.join(run, 'icp_decisions.json'), 'w'), indent=1)
    json.dump([{'domain': x['domain'], 'company_name': x.get('company_name', ''), 'source_id': 'enrich', 'pre_gate': None} for x in dec],
              open(os.path.join(run, 'companies.json'), 'w'), indent=1)
    json.dump([], open(os.path.join(run, 'exclude_domains.json'), 'w'))
    os.makedirs(os.path.join(run, 'sitecache'), exist_ok=True)
    for x in dec:
        src = os.path.join(srcdir[x['domain']], 'sitecache', x['domain'] + '.json')
        dst = os.path.join(run, 'sitecache', x['domain'] + '.json')
        if os.path.exists(src) and not os.path.exists(dst):
            os.symlink(src, dst)
    ver, lines = {}, []
    for k, name, title, email, s in found:
        dd = k['company_domain']
        if dd in regate:
            continue
        parts = name.split()
        if len(parts) < 2:
            st['dropped_no_full_name'] += 1
            continue
        if email:
            ver[email] = {'validity': s if s in ('valid', 'catch_all') else ('invalid' if s == 'invalid' else s or 'unknown'),
                          'catch_all': s == 'catch_all', 'gateway': '', 'source': 'getleads_enrichment'}
        lines.append('|'.join(v.replace('|', '/') for v in [dd, parts[0], parts[-1], title, '', email, s.upper(),
                                                              gate[dd].get('company_name', ''), dd, dd, '', '0']))
    open(os.path.join(run, 'gl', 'D1.txt'), 'w').write('\n'.join(lines) + ('\n' if lines else ''))
    json.dump(ver, open(os.path.join(run, 'verification.json'), 'w'), indent=1)
    # prior people: everyone in production (ScaleLab staffing) and the V4 master, per company
    prior = collections.defaultdict(list)
    for p in json.load(open(os.path.join(REPO, 'runs-private', 'enrich-lists', 'prod_snapshot.json'))):
        dd = el.root(p['domain']) or p['email'].split('@')[-1]
        nm = (p.get('contact_name') or '').split()
        prior[dd].append({'lead_id': p['lead_id'], 'first': nm[0] if nm else '', 'last': nm[-1] if len(nm) > 1 else '',
                          'email': p['email'], 'title': ''})
    mpath = os.path.join(REPO, 'docs/scalelab-sourcing/runs/V4_APPROVED_CONTACTS_MASTER.csv')
    mrows = list(csv.DictReader(open(mpath)))
    for r in mrows:
        nm = (r.get('buyer_name') or '').split()
        prior[r['company_domain']].append({'lead_id': r.get('apollo_id', ''), 'first': nm[0] if nm else '', 'last': nm[-1] if len(nm) > 1 else '',
                                           'email': r['email'], 'title': r.get('buyer_title', '')})
    json.dump(prior, open(os.path.join(run, 'prior_contacts.json'), 'w'))
    cols = list(mrows[0].keys())
    with open(os.path.join(run, 'master_with_prior.csv'), 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction='ignore')
        w.writeheader()
        w.writerows(mrows + [{**{c: '' for c in cols}, 'company_domain': dd, 'buyer_name': f"{p['first']} {p['last']}".strip(),
                              'email': p['email']} for dd, ps in prior.items() for p in ps])
    env = dict(os.environ, V4_WAVE=os.environ.get('V4_WAVE', 'enrich-' + os.path.basename(d)))
    py = [sys.executable, '-I']
    subprocess.run(py + [os.path.join(TOOLS, 'second_buyer_filter.py'), run, 'gl'], check=True, env=env, capture_output=True)
    qc = subprocess.run(py + [os.path.join(TOOLS, 'contact_qc.py'), run, '--master', os.path.join(run, 'master_with_prior.csv')],
                        check=True, env=env, capture_output=True, text=True)
    os.makedirs(os.path.join(run, 'ads'), exist_ok=True)
    subprocess.run(py + [os.path.join(TOOLS, 'ads_score.py'), run], check=True, env=dict(env, V4_JEV_BUDGET_USD='0.01'), capture_output=True)
    out = os.path.join(d, 'ingest_out')
    scratch = os.path.join(run, 'master_scratch.csv')
    shutil.copy(mpath, scratch)
    subprocess.run(py + [os.path.join(TOOLS, 'build_outputs.py'), run, out, scratch], check=True, env=env, capture_output=True)
    approved = list(csv.DictReader(open(os.path.join(out, 'approved-contacts.csv')))) if os.path.exists(os.path.join(out, 'approved-contacts.csv')) else []
    wt = arg('--copy-worktree', f'{SP}/c3v2')
    variants = {}
    if approved:
        ev = os.path.join(out, 'v4-copy-evidence.json')
        be = os.path.join(wt, 'docs/scalelab-sourcing/tools/build_evidence.py')
        subprocess.run(py + [be if os.path.exists(be) else os.path.join(TOOLS, 'build_evidence.py'), os.path.join(out, 'approved-contacts.csv'), ev, run],
                       check=True, env=env, capture_output=True)
        subprocess.run(['node', 'scripts/staffing-v4-preview.js', ev, os.path.join(out, 'preview')], cwd=wt if os.path.exists(wt) else REPO,
                       check=True, capture_output=True)
        pv = json.load(open(os.path.join(out, 'preview', 'v4-preview.json')))
        variants = dict(collections.Counter(x.get('variant') or 'HOLD' for x in (pv if isinstance(pv, list) else pv.get('leads') or [])))
    summ = json.load(open(os.path.join(run, 'contact_qc_summary.json')))
    bp_tiers = collections.Counter()
    spec = importlib.util.spec_from_file_location('bp', os.path.join(TOOLS, 'buyer_pick.py'))
    old, sys.argv = sys.argv, ['x', 'x']
    bp = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bp)
    sys.argv = old
    for _, _, title, _, _ in found:
        t = bp.tier(title or '')
        bp_tiers[str(t[0]) if t else 'not_a_buyer'] += 1
    cb, ca = arg('--credits-before'), arg('--credits-after')
    report = {
        **dict(st), 'returned_titles_by_tier': dict(bp_tiers),
        'qc_results': dict(collections.Counter(f"{s['path'] or 'none'}:{s['result']}" for s in summ)),
        'new_contact_ready': len(approved), 'catch_all_queue_last': sum(1 for r in approved if r.get('catch_all') == 'True'),
        'copy_variants': variants, 'to_verify_not_needed': 'statuses come from the enrichment',
        'credits_used': (int(cb) - int(ca)) if cb and ca else 'give --credits-before / --credits-after',
        'outputs': os.path.relpath(out, REPO), 'v4_master_written': False,
    }
    json.dump(report, open(os.path.join(d, 'ingest_report.json'), 'w'), indent=1)
    print(json.dumps(report, indent=1))


if __name__ == '__main__':
    main()
