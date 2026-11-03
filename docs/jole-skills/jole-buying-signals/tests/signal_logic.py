# -*- coding: utf-8 -*-
"""Reference logic for jole-buying-signals 1.0.0. SKILL.md wins any disagreement.

A signal is {"level": VERIFIED | POTENTIAL | INDUSTRY FIT ONLY,
             "window": active | within_90 | later | unknown | passed,
             "contradicted": bool}.
Demand parts: {"signal": 0-30, "external": 0-25, "timing": 0-20}. Other keys
(buyer, procurement, dollars, geography) are ignored on purpose.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                                'jolesbtxicpskill', 'tests'))
import jole_common as C  # noqa: E402

DEMAND_MAX = {'signal': 30, 'external': 25, 'timing': 20}
PRIORITY_A = 64
PRIORITY_B = 53
CURRENT = ('active', 'within_90')
FUTURE = ('later', 'unknown')


def status(signals):
    live_verified = [s for s in signals if s.get('level') == 'VERIFIED' and not s.get('contradicted')]
    if any(s.get('window') in CURRENT for s in live_verified):
        return 'VERIFIED CURRENT SIGNAL'
    if any(s.get('window') in FUTURE for s in live_verified):
        return 'VERIFIED FUTURE SIGNAL'
    if any(s.get('level') == 'POTENTIAL' and s.get('window') != 'passed' and not s.get('contradicted') for s in signals):
        return 'POTENTIAL SIGNAL'
    if any(s.get('level') == 'VERIFIED' for s in signals):
        return 'CONTRADICTORY / STALE SIGNAL'
    return 'NO VERIFIED SIGNAL'


def priority(total):
    if total >= PRIORITY_A:
        return 'PRIORITY A'
    if total >= PRIORITY_B:
        return 'PRIORITY B'
    return 'NURTURE / RESEARCH'


def demand(parts, icp='QUALIFIED'):
    """(total, priority). EXCLUDED companies are not scored."""
    if icp == 'EXCLUDED':
        return None, 'NOT SCORED'
    for key, top in DEMAND_MAX.items():
        if not 0 <= parts[key] <= top:
            raise ValueError('%s out of range: %s' % (key, parts[key]))
    total = sum(parts[k] for k in DEMAND_MAX)
    return total, priority(total)


def anchor_violations(sig_status, outside_labor, window, parts):
    """Scores that the SKILL.md anchors forbid."""
    bad = []
    if sig_status in ('POTENTIAL SIGNAL', 'CONTRADICTORY / STALE SIGNAL', 'NO VERIFIED SIGNAL') and parts['signal'] > 11:
        bad.append('signal above 11 without a verified live signal')
    if parts['external'] > 20 and outside_labor != 'DOCUMENTED':
        bad.append('external above 20 without documented current outside labor')
    if parts['timing'] > 16 and window not in CURRENT:
        bad.append('timing above 16 without an active or 90-day window')
    if window == 'passed' and parts['timing'] > 6:
        bad.append('timing above 6 for a passed window')
    return bad
