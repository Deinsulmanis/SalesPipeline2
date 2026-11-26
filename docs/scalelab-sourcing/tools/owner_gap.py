"""Owner-gap pass (2026-11-23): for PASS companies that still have no buyer after the Apollo free search
and the GetLeads domain lookup, find the owner/founder/president named on the company's own site and
guess at most TWO addresses at the company domain: round 1 first@, round 2 first.last@.
Verification is done by the owner (owner decision 2026-11-24): contact_qc.py puts only the round-1
address in <run>/to_verify.csv; the round-2 address goes in only after round 1 comes back invalid
(tools/ingest_verification.py). Claude Code never submits or polls verification jobs. A guessed address
on a catch-all domain proves nothing, so it is held, never used.

Usage: V4_JEV_BUDGET_USD=<run cap> python3 -I owner_gap.py <run> @<todo domains.json> [--master <csv>]

Names: Jev has no free-text extraction, so candidate "Name - Title" pairs are pulled from the cached
About/Team/Contact text in code (sitecache/, pwcache/), then Jev picks the most senior CURRENT
decision-maker of THIS company, or none. Tier 1-2 titles only (buyer_pick.py rules); recruiters, HR,
finance and managing directors never. Title words mistaken for names ("Executive Chairman") and people
already revealed in this run or the V4 master are dropped. Jev spend shares the run ledger and cap.

Writes <run>/owner_gap/picks.json and <run>/owner_gap/candidates.json ([{domain, email, name, title, tier, guess}]),
guess 1 = first@, guess 2 = first.last@.
"""
import concurrent.futures as cf
import csv
import importlib.util
import json
import os
import re
import sys
import unicodedata

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jevlib  # noqa: E402

RUN = sys.argv[1]
TODO = json.load(open(sys.argv[2][1:]))
TOOLS = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(TOOLS, '..', '..', '..'))
MASTER = sys.argv[sys.argv.index('--master') + 1] if '--master' in sys.argv else f'{REPO}/docs/scalelab-sourcing/runs/V4_APPROVED_CONTACTS_MASTER.csv'
OUT = os.path.join(RUN, 'owner_gap')
os.makedirs(OUT, exist_ok=True)

spec = importlib.util.spec_from_file_location('bp', os.path.join(TOOLS, 'buyer_pick.py'))
_argv, sys.argv = sys.argv, [sys.argv[0], 'x']
bp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bp)
sys.argv = _argv

TITLE = re.compile(r"\b(owner|co-owner|founder|co-founder|president|ceo|chief executive officer|chief revenue officer|"
                   r"chief operating officer|coo|managing partner|principal|vice president|vp|svp|evp)\b", re.I)
NAME = re.compile(r"^(?:Mr\.?|Ms\.?|Mrs\.?|Dr\.?)?\s*([A-Z][a-z'’.-]+(?:\s+[A-Z]\.)?\s+[A-Z][A-Za-z'’-]+(?:\s+(?:Jr\.?|Sr\.?|II|III))?)\s*$")
NAME_IN = r"([A-Z][a-z'’.-]+(?:\s+[A-Z]\.)?\s+[A-Z][A-Za-z'’-]{1,20})"
BAD = re.compile(r"(?i)\b(contact|apply|staffing|services|solutions|industries|careers|jobs|team|about|our|home|search|privacy|"
                 r"terms|copyright|request|employer|employee|clients?|locations?|office|street|suite|avenue|road|drive|"
                 r"monday|friday|click|learn|read|view|hiring|welcome|group|inc|llc|company|news|letter|meet|message|"
                 r"workforce|recruiting|resources|associates|partners|personnel|employment|labor)\b")
TITLEWORD = set('''technical product executive chairman directed project director manager president founder owner chief officer
senior vice sales operations business development general regional national managing principal partner marketing
human finance financial account accounts client service customer recruiting recruiter talent division branch area
corporate strategic strategy industrial staffing skilled trades light construction manufacturing logistics quality
safety compliance team leader lead head new york united states north south east west central meet our the and'''.split())
INLINE = [
    re.compile(r"\b(Owner|Co-Owner|Founder|Co-Founder|President|CEO|Managing Partner|Principal)\s*(?:&\s*\w+\s*)?[:,–-]\s*" + NAME_IN + r"\b"),
    re.compile(NAME_IN + r",?\s+(?:is\s+)?(?:the\s+)?(?:our\s+)?(Owner|Co-Owner|Founder|Co-Founder|President|CEO|Managing Partner)\b"),
    re.compile(r"\b(?:founded|started|established)\s+(?:in\s+\d{4}\s+)?by\s+" + NAME_IN + r"\b"),
]


def nk(name):
    return ' '.join(re.sub(r"[^a-z ]", ' ', (name or '').lower()).split())


def pages_for(dom):
    out = []
    for sub in ('sitecache', 'sitecache2', 'pwcache'):
        p = os.path.join(RUN, sub, dom + '.json')
        if os.path.exists(p):
            try:
                out += [pg for pg in json.load(open(p)).get('pages') or [] if pg.get('text')]
            except (ValueError, OSError):
                pass
    return out


def candidates(dom):
    out, seen = [], set()

    def add(name, title, url):
        name = re.sub(r'\s+', ' ', name).strip()
        title = re.sub(r'\s+', ' ', title).strip()[:80]
        toks = [t.lower().strip(".'’") for t in name.split()]
        if BAD.search(name) or len(toks) < 2 or any(t in TITLEWORD for t in toks) or not bp.tier(title):
            return
        if name.lower() in seen:
            return
        seen.add(name.lower())
        out.append({'name': name, 'title': title, 'url': url})
    for p in pages_for(dom):
        url = p.get('final_url') or p.get('url')
        text = p.get('text') or ''
        lines = [l.strip(" \t|•·–-") for l in text.split('\n')]
        lines = [l for l in lines if l]
        for i, ln in enumerate(lines):
            m = re.match(r"^([A-Z][a-z'’.-]+\s+[A-Z][A-Za-z'’-]+)\s*[,\-–|]\s*(.{3,60})$", ln)
            if m and TITLE.search(m.group(2)):
                add(m.group(1), m.group(2), url)
            nm = NAME.match(ln)
            if nm and len(ln) <= 40:
                for j in (i + 1, i - 1):
                    if 0 <= j < len(lines) and len(lines[j]) <= 70 and TITLE.search(lines[j]) and not NAME.match(lines[j]):
                        add(nm.group(1), lines[j], url)
                        break
        flat = re.sub(r'\s+', ' ', text)
        for m in INLINE[0].finditer(flat):
            add(m.group(2), m.group(1), url)
        for m in INLINE[1].finditer(flat):
            add(m.group(1), m.group(2), url)
        for m in INLINE[2].finditer(flat):
            add(m.group(1), 'Founder', url)
    return out[:8]


def ascii_letters(s):
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'[^a-z]', '', s)


def patterns(name, dom):
    toks = [t for t in name.replace('.', ' ').split() if t.lower().strip('.') not in ('jr', 'sr', 'ii', 'iii', 'mr', 'ms', 'mrs', 'dr')]
    toks = [t for t in toks if len(t.strip('.')) > 1] or toks
    first, last = ascii_letters(toks[0]), ascii_letters(toks[-1])
    if len(first) < 2 or len(last) < 2:
        return []
    # Never more than 2 guesses per person, in this order (owner decision 2026-11-24).
    return [f'{first}@{dom}', f'{first}.{last}@{dom}']


def main():
    revealed = set()
    if os.path.exists(MASTER):
        for r in csv.DictReader(open(MASTER)):
            revealed.add((r.get('company_domain', '').lower(), nk(r.get('buyer_name'))))
    for f in [os.path.join(RUN, 'reveal', 'apollo.rows'), os.path.join(RUN, 'reveal', 'all.rows')]:
        if os.path.exists(f):
            for line in open(f, errors='replace'):
                x = line.rstrip('\n').split('|')
                if len(x) > 5:
                    revealed.add((x[1].lower(), nk(x[4])))
    b = jevlib.Budget(RUN)
    stats = {'companies': len(TODO), 'with_candidates': 0, 'dropped_prior_reveal': 0, 'picked': 0, 'none': 0, 'fails': 0, 'budget_stop': 0}
    jobs = []
    for d in TODO:
        cands = candidates(d)
        before = len(cands)
        cands = [c for c in cands if (d, nk(c['name'])) not in revealed]
        stats['dropped_prior_reveal'] += before - len(cands)
        if cands:
            stats['with_candidates'] += 1
            jobs.append((d, cands))

    def run(job):
        d, cands = job
        if not b.reserve(6000):
            return d, cands, 'budget_stop', None
        excerpts = []
        for p in pages_for(d):
            t = p.get('text') or ''
            for c in cands:
                k = t.find(c['name'])
                if k >= 0:
                    excerpts.append({'url': p.get('final_url') or p.get('url'), 'text': t[max(0, k - 400):k + 400]})
        crit = {f'p{i}': f"{c['name']} - {c['title']}" for i, c in enumerate(cands)}
        crit['none'] = ('None of the listed people is clearly a CURRENT owner, founder, president, CEO, managing partner or senior '
                        'sales/business-development executive of THIS company (or the entries are testimonials, candidates, '
                        'clients, page fragments, title words or people from other companies).')
        st = {'domain': d, 'people': [{'id': f'p{i}', 'name': c['name'], 'title': c['title']} for i, c in enumerate(cands)],
              'first_party_excerpts': excerpts[:8]}
        qs = {'best_buyer': {'type': 'choice', 'criteria': crit, 'instructions':
                             'Using the first-party excerpts, which listed person is the most senior CURRENT decision-maker at THIS '
                             'company: owner/founder/president/CEO/managing partner first, then CRO/VP of sales/VP of business '
                             'development? Never pick recruiters, HR, finance or office staff.'}}
        try:
            res = jevlib.ask(st, qs)
        except Exception as e:
            b.settle(6000, None, 'owner_gap_pick', d, None)
            return d, cands, f'FAIL {type(e).__name__}', None
        b.settle(6000, res.get('usage'), 'owner_gap_pick', d, res.get('model'))
        return d, cands, 'ok', res

    picks, out = {}, []
    with cf.ThreadPoolExecutor(6) as ex:
        for d, cands, st, res in ex.map(run, jobs):
            if st != 'ok':
                stats['budget_stop' if st == 'budget_stop' else 'fails'] += 1
                continue
            a = (res.get('answers') or {}).get('best_buyer') or {}
            ch = a.get('choice')
            if not ch or ch == 'none':
                stats['none'] += 1
                continue
            c = cands[int(ch[1:])]
            tr = bp.tier(c['title'])
            if not tr or tr[0] > 2:
                stats['none'] += 1
                continue
            stats['picked'] += 1
            picks[d] = {'name': c['name'], 'title': c['title'], 'tier': tr[0], 'jev_p': (a.get('probabilities') or {}).get(ch), 'url': c['url']}
            for k, e in enumerate(patterns(c['name'], d), 1):
                out.append({'domain': d, 'email': e, 'name': c['name'], 'title': c['title'], 'tier': tr[0], 'guess': k})
    json.dump(picks, open(os.path.join(OUT, 'picks.json'), 'w'), indent=1)
    json.dump(out, open(os.path.join(OUT, 'candidates.json'), 'w'), indent=1)
    stats['guesses'] = len(out)
    stats['jev_run_ledger_usd'] = round(b.ledger_usd(), 4)
    print(json.dumps(stats))
    if stats['fails']:
        sys.exit(2)


if __name__ == '__main__':
    main()
