# -*- coding: utf-8 -*-
"""Reference logic for jole-icp-qualification 1.0.0.

SKILL.md is the policy; this restates its mechanical parts so they can be
tested. A person or agent still reads the evidence and sets the facts.

Facts (all optional):
  company        name, for the named-list check
  business       end_employer | contractor | mixed_contractor | labor_seller
                 | service_no_crafts | not_reopened
  operations     VERIFIED | KEYWORDS_ONLY | NONE_FOUND   (default NONE_FOUND)
  craft_fit      DIRECT | PROCESS | UNCLEAR | NONE      (default UNCLEAR)
  off_list_only  bool  the only crafts are off Jole's published list
  us_site        True | False | None (unknown)          (default True)
  hold           '' | early_stage | borderline_aerospace | fuel_distributor_single_tech
Anything else (signals, buyers, timing, union, size, postings) is ignored on purpose.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                                'jolesbtxicpskill', 'tests'))
import jole_common as C  # noqa: E402

OVERLAP = {'labor_seller': 'PRIMARY', 'mixed_contractor': 'MIXED'}


def decide(f):
    """Return (label, reasons, details)."""
    business = f.get('business', 'end_employer')
    details = {'labor_supply_overlap': OVERLAP.get(business, 'NONE FOUND'), 'credit_hold': ''}
    kind, why = C.named_match(f.get('company', ''))
    if kind:
        if kind == 'named_negative':
            details['labor_supply_overlap'] = 'PRIMARY'
        return 'EXCLUDED', [why], details
    if business == 'labor_seller':
        return 'EXCLUDED', ['Primarily sells labor: a competitor, not a buyer'], details
    if business == 'service_no_crafts':
        return 'EXCLUDED', ['Equipment or commercial service firm with no Jole crafts of its own'], details
    operations = f.get('operations', 'NONE_FOUND')
    craft = f.get('craft_fit', 'UNCLEAR')
    if craft == 'NONE' and operations == 'VERIFIED':
        return 'EXCLUDED', ['Verified operations use no relevant industrial trades'], details
    if f.get('us_site', True) is False:
        return 'EXCLUDED', ['No US operating location'], details

    gaps = []
    if operations != 'VERIFIED':
        gaps.append('actual operations')
    if craft not in ('DIRECT', 'PROCESS'):
        gaps.append('crafts at this site')
    elif f.get('off_list_only'):
        gaps.append('Jole to confirm the craft')
    if f.get('us_site', True) is None:
        gaps.append('US operating site')
    if business == 'mixed_contractor':
        gaps.append('competition and buyer fit of the mixed contractor')
    if business == 'not_reopened':
        gaps.append('category not reopened')
        details['credit_hold'] = 'not reopened'
    hold = f.get('hold', '')
    if hold:
        gaps.append({'early_stage': 'funded path to construction'}.get(hold, hold.replace('_', ' ')))
        details['credit_hold'] = hold
    if gaps:
        return 'CONDITIONAL', ['Missing: ' + '; '.join(gaps)], details
    return 'QUALIFIED', ['Eligible'], details


def label(f):
    return decide(f)[0]
