# -*- coding: utf-8 -*-
"""Reference logic for jole-site-labor-feasibility 1.0.0. SKILL.md wins any disagreement.

A requirement is {"trigger": <one of TRIGGERS>, "kind": VERIFIED BLOCK | VERIFIED REQUIREMENT
| POSSIBLE CHECK | TERMS UNKNOWN, "clause": "..."}.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                                'jolesbtxicpskill', 'tests'))
import jole_common as C  # noqa: E402

TRIGGERS = ('union_in_plant', 'hiring_hall', 'project_labor_agreement', 'clearance', 'installation_access',
            'citizenship_export', 'nuclear_qualification', 'approved_vendor', 'new_owner', 'local_hire_pledge',
            'owner_buys_via_epc', 'certification')
# Triggers that alone never justify running this skill (record a note instead).
NOT_A_TRIGGER = ('defense_capability', 'navy_work', 'federal_customer', 'union_word_only')


def needs_assessment(flags):
    """True when a recorded fact is a material trigger for this skill."""
    return any(f in TRIGGERS for f in flags)


def decide(requirements):
    """Return (label, problems). A BLOCK needs a named clause."""
    problems, kinds = [], []
    for r in requirements:
        kind = r.get('kind')
        if kind == 'VERIFIED BLOCK' and r.get('trigger') in NOT_A_TRIGGER:
            problems.append('cannot block on ' + r['trigger'])
            continue
        if kind == 'VERIFIED BLOCK' and not r.get('clause'):
            # Unread terms are unknown terms, never a block.
            problems.append('block without a named clause: ' + r.get('trigger', '?'))
            kind = 'TERMS UNKNOWN'
        kinds.append(kind)
    if 'VERIFIED BLOCK' in kinds:
        return 'BLOCKED BY VERIFIED REQUIREMENT', problems
    if 'TERMS UNKNOWN' in kinds:
        return 'UNKNOWN', problems
    if 'VERIFIED REQUIREMENT' in kinds:
        return 'FEASIBLE WITH CONDITIONS', problems
    return 'FEASIBLE', problems


def union(state):
    """The v3 union table, as requirements."""
    return {
        'binding_agreement': [{'trigger': 'project_labor_agreement', 'kind': 'VERIFIED BLOCK', 'clause': 'named clause required'}],
        'union_unknown': [{'trigger': 'union_in_plant', 'kind': 'TERMS UNKNOWN'}],
        'union_contractors_documented': [{'trigger': 'union_in_plant', 'kind': 'VERIFIED REQUIREMENT'}],
    }.get(state, [])
