# -*- coding: utf-8 -*-
"""Reference logic for jole-qualification-orchestrator 1.0.0. SKILL.md wins any disagreement.

run(subject) takes one subject's facts, runs only the steps the task needs
through each specialist's reference logic, applies the shared stops and skip
rules, reuses fresh prior results, and returns the consolidated record.

subject = {
  "task": company_screen | signal_shortlist | requalify | buyer_research | enrichment_plan
          | contact_qc | readiness | full | single:<dimension>,
  "today": "YYYY-MM-DD",
  "dedupe_account": {"subject": {...}, "records": {...}},
  "icp": {...icp facts...},
  "signals": {"signals": [...], "parts": {...}},
  "feasibility": {"flags": [...], "requirements": [...], "open_conditions": bool},
  "buyer": [candidate, ...],
  "dedupe_contact": {"subject": {...}, "records": {...}},
  "contact": {...contact facts...},
  "readiness": {"approach": n, "evidence": {...}, "list_basis": ..., "approvals": [...]},
  "prior": {dimension: {"decision": ..., "date": "YYYY-MM-DD", "version": "1.0.0", ...}},
  "force_buyer": bool
}
"""
import datetime
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                                'jolesbtxicpskill', 'tests'))
import jole_common as C  # noqa: E402

ICP = C.load_logic('jole-icp-qualification', 'icp_logic')
SIG = C.load_logic('jole-buying-signals', 'signal_logic')
BUY = C.load_logic('jole-buyer-identification', 'buyer_logic')
FEA = C.load_logic('jole-site-labor-feasibility', 'feasibility_logic')
DED = C.load_logic('jole-dedupe-suppression', 'dedupe_logic')
CON = C.load_logic('jole-contact-deliverability', 'contact_logic')
RDY = C.load_logic('jole-outreach-readiness', 'readiness_logic')

NE = C.NOT_EVALUATED
DIMENSIONS = ('dedupe', 'icp', 'signal', 'feasibility', 'buyer', 'dedupe_contact', 'contact', 'readiness')
STEP_DIM = {'dedupe_account': 'dedupe', 'icp': 'icp', 'signals': 'signal', 'feasibility': 'feasibility',
            'buyer': 'buyer', 'dedupe_contact': 'dedupe_contact', 'contact': 'contact', 'readiness': 'readiness'}
REUSE_DAYS = {'dedupe': 30, 'icp': 365, 'signal': 90, 'feasibility': 365, 'buyer': 90,
              'dedupe_contact': 0, 'contact': 30, 'readiness': 0}
PLANS = {
    'company_screen': ['dedupe_account', 'icp'],
    'signal_shortlist': ['dedupe_account', 'icp', 'signals', 'feasibility'],
    'requalify': ['dedupe_account', 'icp', 'signals', 'feasibility'],
    'buyer_research': ['icp', 'feasibility', 'buyer'],
    'enrichment_plan': ['icp', 'buyer', 'dedupe_contact'],
    'contact_qc': ['dedupe_contact', 'contact', 'readiness'],
    'readiness': ['readiness'],
    'full': ['dedupe_account', 'icp', 'signals', 'feasibility', 'buyer', 'dedupe_contact', 'contact', 'readiness'],
}
NEEDS_SIGNAL = ('signal_shortlist', 'requalify', 'full')
VERSION = {'icp': '1.0.0', 'signal': '1.0.0', 'buyer': '1.0.0', 'feasibility': '1.0.0', 'dedupe': '1.0.0',
           'dedupe_contact': '1.0.0', 'contact': '1.0.0', 'readiness': '1.0.0'}


BLOCKING_TRIGGERS = ('project_labor_agreement', 'hiring_hall')


def plan(task, flags=()):
    if task.startswith('single:'):
        step = {'icp': 'icp', 'signal': 'signals', 'buyer': 'buyer', 'feasibility': 'feasibility',
                'dedupe': 'dedupe_account', 'contact': 'contact', 'readiness': 'readiness'}[task.split(':', 1)[1]]
        return [step]
    steps = list(PLANS[task])
    # A recorded trigger that could block the route is checked before paying for signal research.
    if any(f in BLOCKING_TRIGGERS for f in flags) and 'feasibility' in steps and 'signals' in steps:
        steps.remove('feasibility')
        steps.insert(steps.index('signals'), 'feasibility')
    return steps


def _fresh(prior, dim, today):
    p = (prior or {}).get(dim)
    if not p or not p.get('date'):
        return None
    if str(p.get('version', '1')).split('.')[0] != VERSION[dim].split('.')[0]:
        return None
    age = (datetime.date.fromisoformat(today) - datetime.date.fromisoformat(p['date'])).days
    return p if age <= REUSE_DAYS[dim] else None


def account_stop(d):
    if d['dedupe']['decision'] == 'PROHIBITED':
        return 'prohibited'
    if d['icp']['decision'] == 'EXCLUDED':
        return 'ICP excluded'
    if d['dedupe']['decision'] == 'SUPPRESSED' and d['dedupe'].get('scope') in ('company', 'domain'):
        return 'suppressed'
    if d['feasibility']['decision'] == 'BLOCKED BY VERIFIED REQUIREMENT':
        return 'blocked for covered work'
    return ''


def run(s):
    today = s.get('today', '2026-11-03')
    task = s.get('task', 'full')
    d = {dim: {'decision': NE, 'reason': 'not needed for this task'} for dim in DIMENSIONS}
    ran, reused, conflicts = [], [], []
    icp_details = {}
    # Reuse every fresh prior result first, whether or not this task's plan includes it.
    for dim in DIMENSIONS:
        prior = _fresh(s.get('prior'), dim, today)
        if prior:
            d[dim] = dict(prior, reused=True)
            reused.append(dim)
            if dim == 'icp':
                icp_details = prior.get('details', {})
    for step in plan(task, (s.get('feasibility') or {}).get('flags', [])):
        dim = STEP_DIM[step]
        if d[dim].get('reused'):
            continue
        stop = account_stop(d)
        if stop:
            d[dim] = {'decision': NE, 'reason': 'stopped: ' + stop}
            continue
        if step == 'dedupe_account':
            if not s.get('dedupe_account'):
                continue
            label, conf, det = DED.decide(dict(s['dedupe_account']['subject'], level='account'), s['dedupe_account']['records'])
            d[dim] = {'decision': label, 'confidence': conf, 'scope': det.get('suppression_scope', '')}
        elif step == 'icp':
            if s.get('icp') is None:
                continue
            label, reasons, icp_details = ICP.decide(s['icp'])
            d[dim] = {'decision': label, 'reasons': reasons, 'details': icp_details}
        elif step == 'signals':
            if s.get('signals') is None:
                d[dim] = {'decision': NE, 'reason': 'no signal research done'}
                continue
            status = SIG.status(s['signals'].get('signals', []))
            total, prio = SIG.demand(s['signals']['parts'], d['icp']['decision']) if s['signals'].get('parts') else (None, NE)
            d[dim] = {'decision': status, 'priority': prio, 'demand_score': total}
        elif step == 'feasibility':
            fe = s.get('feasibility') or {}
            if not FEA.needs_assessment(fe.get('flags', [])):
                d[dim] = {'decision': NE, 'reason': 'no trigger'}
                continue
            label, _ = FEA.decide(fe.get('requirements', []))
            d[dim] = {'decision': label, 'open_conditions': fe.get('open_conditions', True)}
        elif step == 'buyer':
            if d['icp']['decision'] == 'CONDITIONAL' and not s.get('force_buyer'):
                d[dim] = {'decision': NE, 'reason': 'resolve the ICP gap first'}
                continue
            if (icp_details or {}).get('credit_hold'):
                d[dim] = {'decision': NE, 'reason': 'credit hold'}
                continue
            if s.get('buyer') is None:
                d[dim] = {'decision': NE, 'reason': 'buyer research not done yet'}
                continue
            best = BUY.choose(s['buyer'])
            d[dim] = {'decision': BUY.status(best) if best else 'BUYER NOT IDENTIFIED'}
        elif step == 'dedupe_contact':
            if not s.get('dedupe_contact'):
                d[dim] = {'decision': NE, 'reason': 'no contact yet'}
                continue
            label, conf, det = DED.decide(dict(s['dedupe_contact']['subject'], level='contact'), s['dedupe_contact']['records'])
            d[dim] = {'decision': label, 'confidence': conf}
        elif step == 'contact':
            if s.get('contact') is None:
                d[dim] = {'decision': NE, 'reason': 'no contact data'}
                continue
            if d['dedupe_contact']['decision'] in ('SUPPRESSED', 'EXISTING CONTACT'):
                d[dim] = {'decision': NE, 'reason': 'contact stopped by dedupe'}
                continue
            d[dim] = {'decision': CON.decide(s['contact'])[0]}
        elif step == 'readiness':
            if d['contact']['decision'] == NE:
                d[dim] = {'decision': NE, 'reason': 'no contact data'}
                continue
            r = s.get('readiness') or {}
            dedupe_for_readiness = d['dedupe_contact']['decision'] if d['dedupe_contact']['decision'] != NE else d['dedupe']['decision']
            facts = {'icp': d['icp']['decision'], 'dedupe': dedupe_for_readiness, 'feasibility': d['feasibility']['decision'],
                     'buyer': d['buyer']['decision'], 'contact': d['contact']['decision'],
                     'credit_hold': bool((icp_details or {}).get('credit_hold')),
                     'open_conditions': d['feasibility'].get('open_conditions', True)}
            facts.update(r)
            d[dim] = {'decision': RDY.decide(facts)[0]}
        ran.append(dim)
        d[dim]['skill'] = '%s@%s' % ({'dedupe_contact': 'jole-dedupe-suppression', 'signal': 'jole-buying-signals'}.get(dim, C.OWNER.get(dim, '')), VERSION[dim])
        d[dim]['date'] = today

    if d['dedupe']['decision'] == 'PROHIBITED' and d['icp']['decision'] in ('QUALIFIED', 'CONDITIONAL'):
        conflicts.append({'between': ['icp', 'dedupe'], 'what': 'dedupe found a prohibited family the ICP name check did not',
                          'resolution': 'STOP by precedence; ICP left as recorded'})
    action = next_action(d, icp_details, task)
    return {'dimensions': d, 'ran': ran, 'reused': reused, 'conflicts': conflicts, 'next_action': action,
            'stop_reason': account_stop(d)}


def next_action(d, icp_details, task):
    if account_stop(d):
        return 'STOP'
    icp, dedupe, feas = d['icp']['decision'], d['dedupe']['decision'], d['feasibility']['decision']
    contact, dcontact = d['contact']['decision'], d['dedupe_contact']['decision']
    if (icp_details or {}).get('credit_hold') or contact == 'HOLD' or dcontact in ('EXISTING CONTACT', 'SUPPRESSED'):
        return 'HOLD'
    if dedupe in ('FAMILY MATCH — REVIEW', 'EXISTING ACCOUNT — NEW OPPORTUNITY') \
            or (icp == 'CONDITIONAL' and (icp_details or {}).get('labor_supply_overlap') == 'MIXED') \
            or (feas == 'FEASIBLE WITH CONDITIONS' and d['feasibility'].get('open_conditions', True)):
        return 'REVIEW'
    if icp == 'CONDITIONAL':
        return 'RESEARCH FIT'
    if feas == 'UNKNOWN':
        return 'RESEARCH FEASIBILITY'
    if task in NEEDS_SIGNAL and d['signal']['decision'] == NE:
        return 'RESEARCH SIGNAL'
    if d['buyer']['decision'] != 'BUYER VERIFIED':
        return 'RESEARCH BUYER'
    if contact in (NE, 'REJECT'):
        return 'SOURCE CONTACT'
    if contact == 'ADDITIONAL VERIFICATION REQUIRED':
        return 'VERIFY CONTACT'
    if d['readiness']['decision'] == 'READY FOR APPROVED SEQUENCE':
        return 'HUMAN REVIEW'
    return 'COPY REVIEW'
