# -*- coding: utf-8 -*-
"""Reference logic for jole-buyer-identification 1.1.0. SKILL.md wins any disagreement.

Candidate facts:
  name          str or None (never invented)
  title         str (optional; used for the company-head rule)
  role_strength STRONG | WEAK | UNCLEAR
  source        company | public_dated | public_profile | apollo_preview | undated
  current       True | False | None   employment confirmed current
  size          '1-1000' | '1001+' | 'unknown'
  relation      at_site | within_50mi | hq_company_level | hq_unrelated | elsewhere
  central_authority bool
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                                'jolesbtxicpskill', 'tests'))
import jole_common as C  # noqa: E402
import re  # noqa: E402

HEAD_TITLE = re.compile(r'\b(President|CEO|Chief Executive Officer|Owner|Co-Owner|COO|Chief Operating Officer|General Manager)\b', re.I)
NOT_HEAD = re.compile(r'\b(Vice|VP|Assistant|Deputy|Division|Regional|Region|Segment)\b', re.I)


def company_head(title, size):
    """1.1.0: the head of a company of 1-1,000 staff is a strong buyer role on title alone."""
    title = title or ''
    return size == '1-1000' and bool(HEAD_TITLE.search(title)) and not NOT_HEAD.search(title)


def site_gate(size, relation, central_authority=False):
    """Applies to the buyer, never to the company."""
    if relation in ('at_site', 'within_50mi'):
        return True
    if central_authority:
        return True
    return size not in ('1001+', 'unknown') and relation != 'elsewhere'


def status(candidate):
    if not candidate or not candidate.get('name'):
        return 'BUYER NOT IDENTIFIED'
    if not site_gate(candidate.get('size', 'unknown'), candidate.get('relation', 'elsewhere'),
                     candidate.get('central_authority', False)):
        return 'BUYER NOT SITE-CONNECTED'
    strong = candidate.get('role_strength') == 'STRONG' or company_head(candidate.get('title'), candidate.get('size', 'unknown'))
    if not strong:
        return 'BUYER PARTIAL'
    if candidate.get('source') not in ('company', 'public_dated') or candidate.get('current') is not True:
        return 'BUYER PARTIAL'
    return 'BUYER VERIFIED'


PRIMARY_ROLE = {
    'shipyard': 'Shipyard General Manager',
    'plant': 'Plant Manager',
    'plant_turnaround': 'Turnaround or Outage Manager',
    'contractor_project': 'Project Director or Construction Manager',
    'fabrication_shop': 'Fabrication or Production Manager',
    'small_business': 'Owner, CEO or President',
    'supplier_approval': 'Procurement or subcontracts leader',
    'permanent_hire': 'Site HR or talent acquisition lead',
}
BUYER_TYPE = {
    'Shipyard General Manager': 'Plant / operations / production',
    'Plant Manager': 'Plant / operations / production',
    'Turnaround or Outage Manager': 'Maintenance / reliability',
    'Project Director or Construction Manager': 'Superintendent / site leadership',
    'Fabrication or Production Manager': 'Plant / operations / production',
    'Owner, CEO or President': 'Owner / executive',
    'Procurement or subcontracts leader': 'Procurement / subcontracts',
    'Site HR or talent acquisition lead': 'HR / talent acquisition',
}


def target_role(model, employees=None, need='contract'):
    """The purchasing role to look for, decided before any name search."""
    if need == 'permanent':
        return PRIMARY_ROLE['permanent_hire']
    if employees is not None and employees <= 200 and model in ('fabrication_shop', 'shipyard', 'plant'):
        return PRIMARY_ROLE['small_business']
    return PRIMARY_ROLE[model]


def choose(candidates):
    """Best primary: verified over partial, then strong roles, in the given order."""
    rank = {'BUYER VERIFIED': 0, 'BUYER PARTIAL': 1, 'BUYER NOT SITE-CONNECTED': 2, 'BUYER NOT IDENTIFIED': 3}
    scored = sorted(enumerate(candidates), key=lambda ic: (rank[status(ic[1])], ic[0]))
    return scored[0][1] if scored else None
