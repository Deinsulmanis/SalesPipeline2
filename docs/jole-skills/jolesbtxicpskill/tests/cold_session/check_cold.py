# -*- coding: utf-8 -*-
"""Score fresh-session runs of the prompts in prompts/. Run: python check_cold.py <runs folder>

A run passes when the session
  1. loaded the skills its task needs and no others: for a single question, exactly the shared policy and
     the owning specialist ("only"), never the orchestrator; for a multi-question task, at least "require"
     and none of "forbid";
  2. never touched any tests/ folder, fixture or answer key;
  3. gave the expected decisions.
The answer key is in this file, so this folder must be out of reach during a run (run_cold.py moves it aside).
"""
import json
import os
import re
import sys

P, O = 'jolesbtxicpskill', 'jole-qualification-orchestrator'
EXPECT = {
    'p1_icp': {'only': (P, 'jole-icp-qualification'), 'want': {'cases': {
        1: {'decision': 'QUALIFIED'}, 2: {'decision': 'EXCLUDED'}, 3: {'decision': 'CONDITIONAL'}, 4: {'decision': 'QUALIFIED'},
        5: {'decision': 'QUALIFIED', 'confidence': ('MEDIUM', 'LOW')}}}},
    'p2_signals': {'only': (P, 'jole-buying-signals'), 'want': {'cases': {
        1: {'signal_status': 'VERIFIED FUTURE SIGNAL', 'priority': 'NURTURE / RESEARCH', 'hiring_claim_allowed': False, 'changes_icp_eligibility': False},
        2: {'signal_status': 'VERIFIED CURRENT SIGNAL', 'outside_labor': 'DOCUMENTED', 'priority': ('PRIORITY A', 'PRIORITY B'), 'changes_icp_eligibility': False},
        3: {'signal_status': 'VERIFIED CURRENT SIGNAL', 'needs_reverification': True, 'hiring_claim_allowed': False, 'changes_icp_eligibility': False},
        4: {'signal_status': 'CONTRADICTORY / STALE SIGNAL', 'hiring_claim_allowed': False, 'changes_icp_eligibility': False}}}},
    'p3_buyer': {'only': (P, 'jole-buyer-identification'), 'want': {'primary': 'b', 'primary_status': 'BUYER VERIFIED'}},
    'p4_feasibility': {'only': (P, 'jole-site-labor-feasibility'), 'want': {'cases': {
        1: {'decision': 'BLOCKED BY VERIFIED REQUIREMENT'}, 2: {'decision': 'UNKNOWN'}, 3: {'decision': 'FEASIBLE'}}}},
    'p5_dedupe': {'only': (P, 'jole-dedupe-suppression'), 'want': {'cases': {
        1: {'decision': 'EXISTING ACCOUNT — NEW OPPORTUNITY'}, 2: {'decision': 'NET NEW', 'confidence': ('MEDIUM', 'LOW')},
        3: {'decision': 'EXISTING CONTACT'}, 4: {'decision': 'SUPPRESSED'}}}},
    'p6_contact': {'only': (P, 'jole-contact-deliverability'), 'want': {'cases': {
        1: {'decision': 'HOLD'}, 2: {'decision': 'ADDITIONAL VERIFICATION REQUIRED'},
        3: {'decision': 'CONTACT ACCEPTED FOR REVIEW'}, 4: {'decision': 'REJECT'}}}},
    'p7_readiness': {'only': (P, 'jole-outreach-readiness'), 'want': {'cases': {
        1: {'decision': 'COPY / SIGNAL REVIEW REQUIRED'}, 2: {'decision': 'READY FOR APPROVED SEQUENCE'},
        3: {'decision': 'COPY / SIGNAL REVIEW REQUIRED'}, 4: {'decision': 'COPY / SIGNAL REVIEW REQUIRED'}}}},
    'p8_orchestrator': {'require': (P, O), 'want': {'cases': {
        'A': {'icp': 'QUALIFIED', 'signal_status': 'NO VERIFIED SIGNAL', 'next_action': 'RESEARCH BUYER'},
        'B': {'icp': 'QUALIFIED', 'signal_status': 'VERIFIED CURRENT SIGNAL', 'buyer': 'BUYER VERIFIED', 'contact': 'NOT EVALUATED', 'next_action': 'SOURCE CONTACT'},
        'C': {'icp': 'EXCLUDED', 'next_action': 'STOP'},
        'D': {'icp': 'QUALIFIED', 'contact': 'HOLD', 'next_action': 'HOLD'},
        'E': {'icp': 'QUALIFIED', 'signal_status': 'VERIFIED FUTURE SIGNAL', 'next_action': 'RESEARCH BUYER'},
        'F': {'icp': 'QUALIFIED', 'next_action': 'RESEARCH BUYER'},
        'G': {'icp': 'QUALIFIED', 'feasibility': 'BLOCKED BY VERIFIED REQUIREMENT', 'next_action': 'STOP'}}}},
    'p9_multi': {'require': (P, O, 'jole-icp-qualification', 'jole-buying-signals'),
                 'forbid': ('jole-contact-deliverability', 'jole-outreach-readiness'), 'want': {'cases': {
        1: {'icp': 'QUALIFIED', 'signal_status': 'VERIFIED CURRENT SIGNAL', 'needs_reverification': False, 'next_action': 'RESEARCH BUYER'},
        2: {'icp': 'EXCLUDED', 'next_action': 'STOP'},
        3: {'icp': 'QUALIFIED', 'signal_status': 'VERIFIED CURRENT SIGNAL', 'needs_reverification': True,
            'next_action': ('RESEARCH BUYER', 'RESEARCH SIGNAL')}}}},
}
PEEK = re.compile(r'[\\/]tests([\\/]|$)|fixtures|regression_38|history_38|cold_session|jole-tests-aside|_logic\.py', re.I)


def norm(value):
    s = str(value).upper().replace('—', '-').replace('–', '-')
    s = re.sub(r'\s*-\s*', ' - ', s)
    return re.sub(r'\s+', ' ', s).strip()


def same(got, want):
    if isinstance(want, bool):
        return got is want
    if isinstance(want, tuple):
        return any(same(got, w) for w in want)
    g, w = norm(got), norm(want)
    # Accept the exact label, or the label followed by an explanation ("HOLD. The GM's email...").
    return g == w or any(g.startswith(w + sep) for sep in (' (', ':', ';', '.', ',', ' - ', ' FOR '))


def parse(path):
    answer, calls, cost = '', [], None
    with open(path, encoding='utf-8-sig', errors='replace') as f:
        for line in f:
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if event.get('type') == 'result':
                answer = event.get('result', '') or ''
                cost = event.get('total_cost_usd')
            for block in (event.get('message') or {}).get('content') or []:
                if isinstance(block, dict) and block.get('type') == 'tool_use':
                    calls.append((block.get('name'), json.dumps(block.get('input', {}))))
    return answer, calls, cost


def loaded_skills(calls):
    names = set()
    for name, args in calls:
        if name == 'Skill':
            names.add(json.loads(args).get('skill', ''))
        for m in re.finditer(r'skills[\\/]+([a-z0-9-]+)[\\/]+SKILL\.md', args, re.I):
            names.add(m.group(1))
    return names


def routing_problems(spec, skills):
    problems = []
    if spec.get('only'):
        if skills != set(spec['only']):
            problems.append('routing: loaded %s, expected exactly %s' % (sorted(skills), sorted(spec['only'])))
    for name in spec.get('require', ()):
        if name not in skills:
            problems.append('routing: %s not loaded' % name)
    for name in spec.get('forbid', ()):
        if name in skills:
            problems.append('routing: %s loaded but not needed' % name)
    return problems


def check(run_id, path):
    spec = EXPECT[run_id]
    want = spec['want']
    answer, calls, cost = parse(path)
    skills = loaded_skills(calls)
    peeked = [a for n, a in calls if PEEK.search(a)]
    problems = routing_problems(spec, skills)
    if peeked:
        problems.append('touched test material: %s' % peeked[:2])
    m = re.search(r'\{.*\}', answer, re.S)
    data = json.loads(m.group(0)) if m else {}
    if 'cases' in want:
        got = {str(c.get('id')).strip().upper(): c for c in data.get('cases', [])}
        for cid, fields in want['cases'].items():
            case = got.get(str(cid).upper(), {})
            for field, value in fields.items():
                if not same(case.get(field), value):
                    problems.append('case %s %s: got %r, want %r' % (cid, field, case.get(field), value))
    else:
        for field, value in want.items():
            if not same(data.get(field, ''), value):
                problems.append('%s: got %r, want %r' % (field, data.get(field), value))
        if run_id == 'p3_buyer':
            bad = {x.strip().lower() for x in data.get('not_acceptable', [])}
            if not {'a', 'c'} <= bad:
                problems.append('a and c must be not acceptable, got %s' % sorted(bad))
            if str(data.get('secondary', '')).strip().lower() in ('a', 'c', 'd'):
                problems.append('secondary %r is not a valid buyer' % data.get('secondary'))
    print('%-16s %s  skills=%s  cost=%s' % (run_id, 'PASS' if not problems else 'FAIL', sorted(skills), cost))
    for p in problems:
        print('    -', p)
    return not problems


def main(folder):
    results = []
    for run_id in EXPECT:
        path = os.path.join(folder, run_id + '.jsonl')
        if not os.path.exists(path):
            print('%-16s MISSING' % run_id)
            results.append(False)
            continue
        results.append(check(run_id, path))
    print('%d of %d runs passed' % (sum(results), len(results)))
    return 0 if all(results) else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1]))
