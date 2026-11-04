# -*- coding: utf-8 -*-
"""Reference logic for jole-contact-deliverability 1.0.0. SKILL.md wins any disagreement.

Facts:
  identity       current | uncertain | gone
  domain_match   company | verified_related | unresolved | unrelated | personal
  email_status   VERIFIED | UNVERIFIED | INVALID | none   ('available' without a status counts as none)
  mx_host        the MX host name, or '' if not looked up
  catch_all      True | False | None
  suppressed     bool (contact-level result from jole-dedupe-suppression)
  owned_by_other_client bool
  prior_delivery none | hard_bounce | deferred | domain_failures
Company signals and priority are ignored on purpose.
"""
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                                'jolesbtxicpskill', 'tests'))
import jole_common as C  # noqa: E402

PROOFPOINT = re.compile(r'(^|\.)(pphosted\.com|ppe-hosted\.com)\.?$', re.I)


def gateway(mx_host):
    if not mx_host:
        return 'unknown'
    return 'proofpoint' if PROOFPOINT.search(mx_host.strip()) else 'other'


def segment(mx_host, catch_all):
    gw = gateway(mx_host)
    if catch_all is None:
        return 'unknown'
    if catch_all and gw == 'proofpoint':
        return 'proofpoint_catch_all'
    return 'other_catch_all' if catch_all else 'non_catch_all'


def decide(f):
    """Return (label, reasons, flags)."""
    flags = []
    status = f.get('email_status') or 'none'
    if f.get('suppressed'):
        return 'REJECT', ['address suppressed'], flags
    if status == 'INVALID':
        return 'REJECT', ['email INVALID'], flags
    if f.get('domain_match') in ('personal', 'unrelated'):
        return 'REJECT', ['domain is %s' % f['domain_match']], flags
    if f.get('identity') == 'gone':
        return 'REJECT', ['person has left'], flags
    if f.get('prior_delivery') == 'hard_bounce':
        return 'REJECT', ['prior hard bounce or failure on this address'], flags
    if f.get('owned_by_other_client'):
        return 'REJECT', ['address already belongs to another client'], flags
    gw = gateway(f.get('mx_host', ''))
    if f.get('catch_all') is True and gw == 'proofpoint':
        return 'HOLD', ['Proofpoint catch-all: sending-quality hold'], flags
    if f.get('prior_delivery') in ('deferred', 'domain_failures'):
        return 'HOLD', ['unresolved delivery problems'], flags
    reasons = []
    if status != 'VERIFIED':
        reasons.append('no VERIFIED email status')
    if f.get('identity') != 'current':
        reasons.append('employment or title unconfirmed')
    if f.get('domain_match') == 'unresolved':
        reasons.append('domain link unresolved')
    if gw == 'proofpoint' and f.get('catch_all') is None:
        reasons.append('Proofpoint gateway, catch-all status unknown')
    if reasons:
        return 'ADDITIONAL VERIFICATION REQUIRED', reasons, flags
    if f.get('catch_all') is True:
        flags.append('email_domain_catch_all=Y: send after non-catch-all')
    return 'CONTACT ACCEPTED FOR REVIEW', ['all checks passed'], flags
