"""Shadow pre-filter (2026-11-23 experiment): predict the ICP gate from what Apollo's FREE lookup
gives before any crawl, then measure it against icp_decide. It never skips anything.

Usage:
  python3 -I shadow_prefilter.py <run> score      # before the crawl; Jev, inside V4_JEV_BUDGET_USD
  python3 -I shadow_prefilter.py <run> evaluate   # after icp_decide.py; free

Inputs (score): <run>/companies.json (company_name, groups = the Apollo query groups that found it)
and, optional, <run>/apollo_officp_tags.json ({domain: true}) = domains Apollo also tags with an
off-ICP staffing tag (healthcare, IT, office, legal, finance, executive search), from a free
domain-list lookup. Apollo's free lookup returns no description or keyword list, so these are the
only Apollo-side signals available without spending credits.

Outputs: <run>/shadow_scores.json {domain: {p_pass, pred}} and, on evaluate, shadow_eval.json
(recall of PASS, precision, the share of crawls a skip rule would have saved, at several cut-offs).
"""
import collections
import concurrent.futures as cf
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jevlib  # noqa: E402

RUN, MODE = sys.argv[1], sys.argv[2]
OUT = os.path.join(RUN, 'shadow_scores.json')
GROUP_DESC = {
    'G1_INDUSTRIAL': 'tagged industrial / light industrial / manufacturing / warehouse / logistics staffing',
    'G2_TRADES': 'tagged skilled trades / construction / welding / trades / craft labor staffing',
    'G3_GENLABOR': 'tagged general labor staffing',
    'NAICS_56132': 'NAICS 56132 temporary help services (no industrial tag required)',
}
Q = {'likely_icp': {'type': 'choice', 'instructions': (
    'From only the company name and the Apollo classification signals in the state (no website), '
    'is this company likely to be a US staffing agency whose core business is placing hands-on '
    'industrial, warehouse, manufacturing, construction or skilled-trades WORKERS with employer clients?'),
    'criteria': {
        'LIKELY_PASS': 'Likely an independent industrial / light-industrial / skilled-trades / construction / '
                       'general-labor staffing agency.',
        'LIKELY_REJECT': 'Likely something else: IT, healthcare, office/admin, legal, finance or executive-search '
                         'staffing; a PEO/payroll firm; an employer rather than an agency; a national chain or '
                         'franchise; a nonprofit or job board.'}}}


def score():
    comps = json.load(open(os.path.join(RUN, 'companies.json')))
    offp = os.path.join(RUN, 'apollo_officp_tags.json')
    off = json.load(open(offp)) if os.path.exists(offp) else None
    done = json.load(open(OUT)) if os.path.exists(OUT) else {}
    b = jevlib.Budget(RUN)
    todo = [c for c in comps if c['domain'] not in done]
    if '--limit' in sys.argv:
        todo = todo[:int(sys.argv[sys.argv.index('--limit') + 1])]

    def one(c):
        st = {'company_name': c['company_name'], 'domain': c['domain'], 'hq_state': c.get('hq_state'),
              'apollo_signals': [GROUP_DESC.get(g, g) for g in c.get('groups') or []]}
        if off is not None:
            st['apollo_also_tags_officp_staffing'] = bool(off.get(c['domain']))
        if not b.reserve(900):
            return c['domain'], 'budget_stop', None
        try:
            res = jevlib.ask(st, Q)
        except Exception as e:  # fail closed: this company is simply not scored
            b.settle(900, None, 'shadow_prefilter', c['domain'], None)
            return c['domain'], f'FAIL {type(e).__name__}', None
        b.settle(900, res.get('usage'), 'shadow_prefilter', c['domain'], res.get('model'))
        try:
            a = res['answers']['likely_icp']
            p = (a.get('probabilities') or {}).get('LIKELY_PASS')
        except (KeyError, TypeError, AttributeError):
            return c['domain'], 'FAIL bad_response', None
        return c['domain'], 'ok', {'p_pass': p, 'pred': a.get('choice')}
    stats = collections.Counter()
    with cf.ThreadPoolExecutor(8) as ex:
        for d, st, r in ex.map(one, todo):
            stats[st.split(' ')[0]] += 1
            if r:
                done[d] = r
    json.dump(done, open(OUT, 'w'), indent=0)
    print(dict(stats), 'scored', len(done), 'of', len(comps), '| jev spent (run ledger) $%.4f' % b.ledger_usd())
    if stats.get('FAIL') or stats.get('budget_stop'):
        sys.exit(2)


def evaluate():
    sc = json.load(open(OUT))
    dec = {x['domain']: x for x in json.load(open(os.path.join(RUN, 'icp_decisions.json')))}
    # Only companies the gate actually judged from a crawl count (pre_gate duplicates/thin are excluded).
    rows = [(d, sc[d]['p_pass'] or 0.0, dec[d]['company_icp']) for d in sc if d in dec]
    n, n_pass = len(rows), sum(1 for r in rows if r[2] == 'PASS')
    cuts = {}
    for t in (0.2, 0.3, 0.4, 0.5, 0.6, 0.7):
        kept = [r for r in rows if r[1] >= t]
        tp = sum(1 for r in kept if r[2] == 'PASS')
        cuts[str(t)] = {'would_crawl': len(kept), 'crawls_saved_share': round(1 - len(kept) / n, 3) if n else None,
                        'pass_recall': round(tp / n_pass, 3) if n_pass else None,
                        'pass_rate_in_kept': round(tp / len(kept), 3) if kept else None,
                        'pass_missed': n_pass - tp}
    out = {'judged': n, 'pass': n_pass, 'cutoffs': cuts,
           'predicted_label': {f'{k[0]}->{k[1]}': v for k, v in collections.Counter((sc[d]['pred'], dec[d]['company_icp']) for d, _, _ in rows).items()},
           'note': 'Recall = share of gate-PASS companies a skip rule at that cut-off would still have crawled.'}
    json.dump(out, open(os.path.join(RUN, 'shadow_eval.json'), 'w'), indent=1)
    print(json.dumps(out, indent=1))


if __name__ == '__main__':
    score() if MODE == 'score' else evaluate()
