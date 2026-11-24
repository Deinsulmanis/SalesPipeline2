"""Second-buyer filter for the GetLeads (6b) and owner-gap paths, before contact_qc.py. Free, offline.

Usage: python3 -I second_buyer_filter.py <run> gl|owner_gap

Applies the owner's second-buyer rules (same as second_buyer_pick.py) to candidates found by domain:
  - drop anyone already emailed (same email, or same first name with a matching or unknown last name);
  - keep only a DIFFERENT buyer-role family than every prior contact (when a prior title is known, from the record or
    the free Apollo search); with no known prior title, any tier 1-2 person is acceptable.
gl:        moves gl/D*.txt to gl/raw/ (once) and writes filtered gl/D*.txt with the same line format.
owner_gap: moves owner_gap/candidates.json to owner_gap/candidates_raw.json (once) and writes the filtered file.
Prints counts only.
"""
import collections
import glob
import importlib.util
import json
import os
import shutil
import sys

RUN, PATH = sys.argv[1], sys.argv[2]
TOOLS = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('sbp', os.path.join(TOOLS, 'second_buyer_pick.py'))
_argv, sys.argv = sys.argv, [sys.argv[0], RUN]
sbp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sbp)
sys.argv = _argv


def prior_info():
    prior = json.load(open(os.path.join(RUN, 'prior_contacts.json')))
    people = json.load(open(os.path.join(RUN, 'people_by_domain.json'))) if os.path.exists(os.path.join(RUN, 'people_by_domain.json')) else {}
    out = {}
    for d, ps in prior.items():
        fams, emails, names = set(), set(), []
        for p in ps:
            t = p.get('title') or ''
            if not t:
                m = [x for x in people.get(d, []) if sbp.first_key(x.get('first')) == sbp.first_key(p.get('first'))
                     and sbp.last_initial(x) == sbp.last_initial(p)]
                t = m[0].get('title') if m else ''
            fams |= sbp.families(t)
            emails.add((p.get('email') or '').lower())
            names.append((sbp.first_key(p.get('first')), (p.get('last') or '')[:1].lower()))
        out[d] = (fams, emails, names)
    return out


def keep(d, first, last, email, title, info, st):
    fams, emails, names = info.get(d, (set(), set(), []))
    if (email or '').lower() in emails:
        st['dropped_prior_email'] += 1
        return False
    fk, li = sbp.first_key(first), (last or '')[:1].lower()
    if any(fk == n and (not li or not l or li == l) for n, l in names):
        st['dropped_prior_name'] += 1
        return False
    fam = sbp.families(title)
    if fams and (not fam or fam & fams):
        st['dropped_same_role'] += 1
        return False
    st['kept'] += 1
    return True


def main():
    info = prior_info()
    st = collections.Counter()
    if PATH == 'gl':
        raw = os.path.join(RUN, 'gl', 'raw')
        if not os.path.isdir(raw):
            os.makedirs(raw)
            for f in glob.glob(os.path.join(RUN, 'gl', 'D*.txt')):
                shutil.move(f, raw)
        for f in sorted(glob.glob(os.path.join(raw, 'D*.txt'))):
            out = []
            for line in open(f, encoding='utf-8', errors='replace'):
                x = line.rstrip('\n').split('|')
                if len(x) < 12 or x[1] in ('NONE', 'ERROR') or keep(x[0], x[1], x[2], x[5], x[3], info, st):
                    out.append(line.rstrip('\n'))
            open(os.path.join(RUN, 'gl', os.path.basename(f)), 'w').write('\n'.join(out) + ('\n' if out else ''))
    else:
        cp, rp = os.path.join(RUN, 'owner_gap', 'candidates.json'), os.path.join(RUN, 'owner_gap', 'candidates_raw.json')
        if not os.path.exists(rp):
            shutil.move(cp, rp)
        cands = json.load(open(rp))
        keepset = []
        for c in cands:
            nm = c['name'].split()
            if keep(c['domain'], nm[0] if nm else '', nm[-1] if len(nm) > 1 else '', c['email'], c['title'], info, st):
                keepset.append(c)
        json.dump(keepset, open(cp, 'w'), indent=1)
    print(PATH, dict(st))


if __name__ == '__main__':
    main()
