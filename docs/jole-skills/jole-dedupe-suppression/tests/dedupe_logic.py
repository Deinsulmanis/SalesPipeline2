# -*- coding: utf-8 -*-
"""Reference logic for jole-dedupe-suppression 1.0.0. SKILL.md wins any disagreement.

subject: {"level": account | contact, "name", "domain", "email", "apollo_id", "parent"}
records: {
  "live": bool,                                   # authoritative sources were read
  "suppressions": [{"match_type": email | domain | company, "value": ...}],
  "crm_accounts": [{"company": ..., "domain": ..., "client": ..., "stage": ...}],
  "crm_emails": [...],                            # every client
  "prior_people": [{"email": ..., "apollo_id": ..., "status": approved | hold | removed}],
  "family": {"plausible": bool, "confirmed_prohibited": bool},
  "new_information": none | signal | site | buyer_role
}
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                                'jolesbtxicpskill', 'tests'))
import jole_common as C  # noqa: E402


def _domain_of(email):
    e = C.normalize_email(email)
    return e.rsplit('@', 1)[1] if '@' in e else ''


def suppression_scope(subject, suppressions):
    key = C.company_key(subject.get('name'))
    domains = {C.normalize_domain(subject.get('domain')), _domain_of(subject.get('email'))} - {''}
    email = C.normalize_email(subject.get('email'))
    for s in suppressions:
        t, v = s['match_type'], s['value']
        if t == 'company' and key and C.company_key(v) == key:
            return 'company'
        if t == 'domain' and C.normalize_domain(v) in domains:
            return 'domain'
        if t == 'email' and email and C.normalize_email(v) == email:
            return 'email'
    return ''


def decide(subject, records):
    """Return (label, confidence, details)."""
    details = {'level': subject.get('level', 'account'), 'suppression_scope': '',
               'new_information': records.get('new_information', 'none')}
    live = records.get('live', False)
    for name in (subject.get('name'), subject.get('parent')):
        kind, _ = C.named_match(name or '')
        if kind:
            return 'PROHIBITED', 'HIGH', details
    if (records.get('family') or {}).get('confirmed_prohibited'):
        return 'PROHIBITED', 'HIGH', details
    scope = suppression_scope(subject, records.get('suppressions', []))
    if scope:
        details['suppression_scope'] = scope
        if scope in ('company', 'domain') or subject.get('level') == 'contact':
            return 'SUPPRESSED', 'HIGH' if live else 'MEDIUM', details
    if subject.get('level') == 'contact':
        email = C.normalize_email(subject.get('email'))
        crm_emails = {C.normalize_email(e) for e in records.get('crm_emails', [])}
        prior = records.get('prior_people', [])
        if (email and email in crm_emails) or any(
                (email and C.normalize_email(p.get('email')) == email) or
                (subject.get('apollo_id') and p.get('apollo_id') == subject.get('apollo_id')) for p in prior):
            return 'EXISTING CONTACT', 'HIGH' if live else 'MEDIUM', details
    if (records.get('family') or {}).get('plausible'):
        return 'FAMILY MATCH — REVIEW', 'MEDIUM', details
    key = C.company_key(subject.get('name'))
    domain = C.normalize_domain(subject.get('domain'))
    for a in records.get('crm_accounts', []):
        if (domain and C.normalize_domain(a.get('domain')) == domain) or (key and C.company_key(a.get('company')) == key):
            details['existing_state'] = {k: a.get(k) for k in ('client', 'stage')}
            return 'EXISTING ACCOUNT — NEW OPPORTUNITY', 'HIGH' if live else 'MEDIUM', details
    return 'NET NEW', 'HIGH' if live else 'MEDIUM', details
