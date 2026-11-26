"""Ingest the owner's GetLeads verification results, then rebuild the affected contacts (owner decision 2026-11-24).

Claude Code never submits or polls verification jobs and never uses Apollo validation. The owner uploads
runs-private/<run>/to_verify.csv (written by contact_qc.py) to GetLeads and drops the results CSV at
runs-private/<run>/verified_results.csv. This script:

  1. maps each result:  valid -> keep;  catch-all / accept-all -> keep, flag, queue last;
                        invalid / unknown / risky (anything else) -> HOLD
     and merges it into runs-private/<run>/verification.json (email -> {validity, catch_all, gateway}).
     Owner-gap guesses: a catch-all guess stays a HOLD; an invalid guess 1 sends guess 2 (first.last@) to the
     next to_verify.csv; never more than 2 guesses per person (contact_qc.py applies this).
  2. re-runs contact_qc.py, build_outputs.py, then build_evidence.py and the preview for the contacts this
     ingest released (newly added to the master);
  3. prints counts only (no names, no emails).

Usage (repository root, V4_RUN_DATE / V4_WAVE / V4_DISCOVERY_SOURCE as for the run; V4_WAVE defaults to the run name):
  python3 -I docs/scalelab-sourcing/tools/ingest_verification.py runs-private/<run> [--out docs/scalelab-sourcing/runs/<run>]
         [--master <csv>] [--evidence-runs <dir> ...]
  python3 -I docs/scalelab-sourcing/tools/ingest_verification.py --pending     carry-over check: every run whose
         VERIFY_PENDING addresses have no result yet, and any verified_results.csv not yet ingested. Run at the start
         of every sourcing run.

Accepted results formats: GetLeads bulk export (email/normalized, validity, is_domain_catchall, gateway) or any CSV with
an email column and a status column (status / result / verification_status / validity).
Backups of every file it changes go to runs-private/<run>/ingest_<UTC stamp>/.
"""
import collections
import csv
import datetime
import glob
import json
import os
import shutil
import subprocess
import sys

TOOLS = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(TOOLS, '..', '..', '..'))
DEFAULT_MASTER = os.path.join(REPO, 'docs/scalelab-sourcing/runs/V4_APPROVED_CONTACTS_MASTER.csv')
CATCH = {'catch_all', 'catchall', 'accept_all', 'acceptall'}


def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def norm(s):
    return str(s or '').strip().lower().replace('-', '_').replace(' ', '_')


def truthy(s):
    return norm(s) in ('true', '1', 'yes', 'y')


def load_verification(run):
    v = {}
    for f in (os.path.join(run, 'gl', 'verify.json'), os.path.join(run, 'owner_gap', 'verify.json'), os.path.join(run, 'verification.json')):
        if os.path.exists(f):
            v.update({k.strip().lower(): x for k, x in json.load(open(f)).items()})
    return v


def map_row(r):
    """One results row -> (email, {validity, catch_all, gateway}) or None."""
    low = {norm(k): v for k, v in r.items()}
    email = (low.get('normalized') or low.get('email') or low.get('email_address') or '').strip().lower()
    if '@' not in email:
        return None
    status = norm(low.get('validity') or low.get('status') or low.get('result') or low.get('verification_status'))
    catch = truthy(low.get('is_domain_catchall')) or truthy(low.get('catch_all')) or status in CATCH
    if status in CATCH or (status == 'valid' and catch) or (status == 'ambiguous' and catch):
        val = 'catch_all'
    elif status in ('valid', 'invalid', 'unknown', 'risky'):
        val = status
    else:
        val = status or 'unknown'  # anything unrecognized is held by contact_qc
    return email, {'validity': val, 'catch_all': val == 'catch_all', 'gateway': norm(low.get('gateway')),
                   'source': 'owner_getleads_upload'}


def pending_report():
    found = False
    for vp in sorted(glob.glob(os.path.join(REPO, 'runs-private', '*', 'verify_pending.json'))):
        run = os.path.dirname(vp)
        ver = load_verification(run)
        left = [p for p in json.load(open(vp)) if p['email'].lower() not in ver]
        waiting = os.path.exists(os.path.join(run, 'verified_results.csv'))
        if left or waiting:
            found = True
            c = collections.Counter(p['path'] for p in left)
            print(f"{os.path.relpath(run, REPO)}: VERIFY_PENDING {len(left)} ({dict(c)})"
                  + (f" | to_verify.csv: {os.path.relpath(os.path.join(run, 'to_verify.csv'), REPO)}" if left else '')
                  + (' | verified_results.csv present, NOT YET INGESTED' if waiting else ''))
    if not found:
        print('No VERIFY_PENDING carry-over.')


def run_step(cmd, env):
    p = subprocess.run(cmd, cwd=REPO, env=env, capture_output=True, text=True)
    if p.returncode != 0:
        sys.stderr.write(p.stdout[-2000:] + p.stderr[-2000:])
        raise SystemExit(f'step failed ({p.returncode}): {" ".join(os.path.basename(c) for c in cmd[:3])}')
    return p.stdout


def main():
    if '--pending' in sys.argv:
        return pending_report()
    run = os.path.abspath(sys.argv[1])
    name = os.path.basename(run.rstrip('/'))
    out = os.path.abspath(arg('--out', os.path.join(REPO, 'docs/scalelab-sourcing/runs', name)))
    master = os.path.abspath(arg('--master', DEFAULT_MASTER))
    ev_runs = sys.argv[sys.argv.index('--evidence-runs') + 1:] if '--evidence-runs' in sys.argv else []
    res_p = os.path.join(run, 'verified_results.csv')
    if not os.path.exists(res_p):
        raise SystemExit(f'no results file at {res_p}')
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    bk = os.path.join(run, f'ingest_{stamp}')
    os.makedirs(bk)
    for f in (os.path.join(run, 'verification.json'), os.path.join(run, 'contact_qc.json'), os.path.join(run, 'verify_pending.json'),
              os.path.join(run, 'to_verify.csv'), os.path.join(out, 'approved-contacts.csv'), master):
        if os.path.exists(f):
            shutil.copy2(f, bk)

    # 1. map and merge
    pend = {p['email'].lower(): p for p in json.load(open(os.path.join(run, 'verify_pending.json')))} \
        if os.path.exists(os.path.join(run, 'verify_pending.json')) else {}
    vj = os.path.join(run, 'verification.json')
    store = json.load(open(vj)) if os.path.exists(vj) else {}
    mapped = collections.Counter()
    matched = 0
    for r in csv.DictReader(open(res_p, newline='', encoding='utf-8-sig')):
        m = map_row(r)
        if not m:
            continue
        e, v = m
        store[e] = dict(v, ingested_at=stamp)
        mapped[v['validity']] += 1
        matched += e in pend
    json.dump(store, open(vj, 'w'), indent=1)
    shutil.move(res_p, os.path.join(bk, 'verified_results.csv'))  # ingested: the carry-over check no longer flags it

    # 2. rebuild
    env = dict(os.environ)
    env.setdefault('V4_WAVE', name)
    before = {r['email'].lower() for r in csv.DictReader(open(master))} if os.path.exists(master) else set()
    prev = list(csv.DictReader(open(os.path.join(out, 'approved-contacts.csv')))) if os.path.exists(os.path.join(out, 'approved-contacts.csv')) else []
    qc = run_step([sys.executable, '-I', os.path.join(TOOLS, 'contact_qc.py'), run, '--master', master], env)
    run_step([sys.executable, '-I', os.path.join(TOOLS, 'build_outputs.py'), run, out, master], env)
    after = list(csv.DictReader(open(master)))
    released = [r for r in after if r['email'].lower() not in before]
    # build_outputs rewrites approved-contacts.csv with only the rows not yet in the master: keep the run file
    # cumulative, and write the released rows on their own.
    cols = list(after[0].keys()) if after else []
    keep = prev + [r for r in released if r['company_domain'] not in {p['company_domain'] for p in prev}]
    pcols = list(prev[0].keys()) if prev else cols
    for path, rows, cc in ((os.path.join(out, 'approved-contacts.csv'), keep, pcols),
                           (os.path.join(out, f'approved-contacts-verified-{stamp}.csv'), released, cols)):
        with open(path, 'w', newline='') as f:
            w = csv.DictWriter(f, fieldnames=cc, extrasaction='ignore')
            w.writeheader()
            w.writerows(rows)
    variants = collections.Counter()
    if released:
        ev = os.path.join(out, f'v4-copy-evidence-verified-{stamp}.json')
        pv = os.path.join(out, f'preview-verified-{stamp}')
        run_step([sys.executable, '-I', os.path.join(TOOLS, 'build_evidence.py'), os.path.join(out, f'approved-contacts-verified-{stamp}.csv'),
                  ev, run, *ev_runs], env)
        run_step(['node', os.path.join(REPO, 'scripts/staffing-v4-preview.js'), ev, pv], env)
        d = json.load(open(os.path.join(pv, 'v4-preview.json')))
        variants = collections.Counter(x.get('variant') or 'HOLD' for x in (d if isinstance(d, list) else d.get('leads') or []))

    # 3. counts only
    holds = json.load(open(os.path.join(run, 'contact_qc.json')))['holds']
    vholds = collections.Counter(h.split(':')[0] for h in holds.values() if h.startswith('VERIFY_'))
    nxt = sum(1 for _ in open(os.path.join(run, 'to_verify.csv'))) - 1
    print(json.dumps({
        'results_rows_mapped': dict(mapped), 'matched_pending': matched, 'pending_before': len(pend),
        'released_contacts': len(released), 'released_catch_all_queue_last': sum(1 for r in released if str(r.get('catch_all')) == 'True'),
        'released_copy_variants': dict(variants), 'verification_holds_now': dict(vholds),
        'next_to_verify': nxt, 'next_to_verify_path': os.path.relpath(os.path.join(run, 'to_verify.csv'), REPO),
        'backup': os.path.relpath(bk, REPO)}, indent=1))
    if nxt:
        print(f'{nxt} address(es) still need the owner (round-2 owner-gap guesses or new pending): upload to_verify.csv again.')


if __name__ == '__main__':
    main()
