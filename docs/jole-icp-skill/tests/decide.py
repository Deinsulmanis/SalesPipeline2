# -*- coding: utf-8 -*-
"""Reference decision logic for the Jole BTX ICP skill (v3).

SKILL.md is the policy. This file restates its mechanical parts so they can be
tested. If the two ever disagree, SKILL.md wins and this file must be fixed.
It makes no judgment calls: a person or agent still has to read the evidence
and set the facts below.

Facts (all optional except where noted):
  company          str   legal or trading name, used for family matching
  business         end_employer | contractor | mixed_contractor | labor_seller
                   | service_no_crafts
  trade            established | inferred | none
  access           open | union_contractors_documented | union_unknown
                   | binding_agreement
  us_site          bool  default True
  suppressed       bool  DNC, suppression list or client-family match
  early_stage      bool  pre-revenue or early-stage developer
  restriction      str   a verified barrier to clear first; empty if none
  signal           VERIFIED | POTENTIAL | INDUSTRY_FIT
  signal_current   bool  default True
  buyer            VERIFIED | PARTIAL | NOT_SITE_CONNECTED | NOT_FOUND
  contact_verified bool  a work email has passed the email rules
  deliverability_hold bool  a sending-quality hold applies to the contact
  approved_variant bool  an approved variant fits this lead's evidence
  verified_role, verified_location, posting_age_days   hiring evidence
"""
import re

ELIGIBILITY = ('QUALIFIED', 'CONDITIONAL', 'EXCLUDED')
READINESS = (
    'HOLD',
    'COMPLIANCE / PROCUREMENT REVIEW',
    'SIGNAL VERIFICATION REQUIRED',
    'BUYER RESEARCH REQUIRED',
    'CONTACT VERIFICATION REQUIRED',
    'READY FOR CONTACT REVIEW',
)
MAX_POINTS = {'signal': 30, 'external': 25, 'timing': 20, 'buyer': 15, 'procurement': 10}
MAX_EVIDENCE_AGE_DAYS = 45

# Normalized names. Families include the subsidiaries the skill lists.
DNC_FAMILIES = {
    'spacex': 'SpaceX client family', 'spacexai': 'SpaceX client family',
    'kiewit': 'Kiewit family', 'kiewit offshore services': 'Kiewit family',
    'kos': 'Kiewit family', 'tic': 'Kiewit family', 'weeks marine': 'Kiewit family',
    'karpower': 'Karpower', 'karpowership': 'Karpower',
}
NAMED_NEGATIVES = {
    'zachry', 'turner industries', 'brock', 'austin industrial', 'team inc',
    'team', 'team industrial services', 'bilfinger', 'koch engineered solutions', 'bay ltd', 'bay',
    'taurus industrial', 'upchurch',
}
NAMED_HOLDS = {'martin engineering', 'nalco water'}
_SUFFIX = re.compile(r'\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|group|lp|plc)\b\.?')


def normalize(name):
    s = re.sub(r"[^a-z0-9 ]", ' ', (name or '').lower())
    s = _SUFFIX.sub(' ', s)
    return re.sub(r'\s+', ' ', s).strip()


def named_match(name):
    """Return the reason a name is on a hard list, or ''."""
    raw = re.sub(r'\s+', ' ', re.sub(r"[^a-z0-9 ]", ' ', (name or '').lower())).strip()
    n = normalize(name)
    for key in (n, raw):
        if key in DNC_FAMILIES:
            return 'DNC: ' + DNC_FAMILIES[key]
        if key in NAMED_NEGATIVES:
            return 'Named negative: sells crews or labor'
    for fam, why in DNC_FAMILIES.items():
        if len(fam) > 3 and ' %s ' % fam in ' %s ' % n:
            return 'DNC: ' + why
    for neg in NAMED_NEGATIVES:
        if len(neg) > 4 and (n == neg or n.startswith(neg + ' ')):
            return 'Named negative: sells crews or labor'
    return ''


def eligibility(f):
    """Dimension A. Never looks at timing, postings, buyers or size."""
    named = named_match(f.get('company', ''))
    if named:
        return 'EXCLUDED', named
    if f.get('suppressed'):
        return 'EXCLUDED', 'Suppressed, DNC or client-family match'
    if not f.get('us_site', True):
        return 'EXCLUDED', 'No US operating location'
    business = f.get('business', 'end_employer')
    if business == 'labor_seller':
        return 'EXCLUDED', 'Primarily sells labor: competitor, not buyer'
    if business == 'service_no_crafts':
        return 'EXCLUDED', 'Commercial or equipment service firm with no Jole crafts'
    if f.get('trade', 'inferred') == 'none':
        return 'EXCLUDED', 'No relevant industrial trades'
    if f.get('access', 'open') == 'binding_agreement':
        return 'EXCLUDED', 'Binding labor agreement closes the route for an outside supplier'
    missing = []
    if business == 'mixed_contractor':
        missing.append('competition and buyer fit of the mixed contractor')
    if f.get('trade') == 'inferred':
        missing.append('crafts at this site')
    if f.get('access') == 'union_unknown':
        missing.append('subcontracting terms of the labor agreement')
    if f.get('early_stage'):
        missing.append('funded path to construction')
    if missing:
        return 'CONDITIONAL', 'Missing: ' + '; '.join(missing)
    return 'QUALIFIED', 'Eligible'


def readiness(f, label=None):
    """Dimension C. Returns the first gate that is not cleared."""
    label = label or eligibility(f)[0]
    if label == 'EXCLUDED':
        return 'HOLD', 'Excluded'
    if f.get('suppressed'):
        return 'HOLD', 'Suppressed'
    if f.get('early_stage'):
        return 'HOLD', 'Early-stage developer hold'
    if f.get('deliverability_hold'):
        return 'HOLD', 'Sending-quality hold on the contact'
    if f.get('restriction'):
        return 'COMPLIANCE / PROCUREMENT REVIEW', f['restriction']
    if f.get('signal', 'POTENTIAL') != 'VERIFIED' or not f.get('signal_current', True):
        return 'SIGNAL VERIFICATION REQUIRED', 'Signal is not verified and current'
    if label == 'CONDITIONAL':
        return 'SIGNAL VERIFICATION REQUIRED', 'Fit evidence is still missing'
    if f.get('buyer', 'NOT_FOUND') != 'VERIFIED':
        return 'BUYER RESEARCH REQUIRED', 'No verified, site-connected buyer'
    if not f.get('contact_verified'):
        return 'CONTACT VERIFICATION REQUIRED', 'No verified work email yet'
    if not f.get('approved_variant'):
        return 'HOLD', 'No approved email variant fits this evidence'
    return 'READY FOR CONTACT REVIEW', 'All gates cleared; a person still reviews before anything is queued'


def site_gate(size, relation, central_authority=False):
    """Buyer site-connection gate. Applies to the buyer, never to the company.

    size: '1-1000', '1001+' or 'unknown'
    relation: at_site | within_50mi | hq_unrelated | elsewhere
    """
    if relation in ('at_site', 'within_50mi'):
        return True
    if central_authority:
        return True
    return size not in ('1001+', 'unknown') and relation != 'elsewhere'


def priority(score):
    if score >= 85:
        return 'PRIORITY A'
    if score >= 70:
        return 'PRIORITY B'
    return 'NURTURE / RESEARCH'


def opportunity(parts):
    """Dimension B. Takes the five components only: no dollar figure is accepted."""
    for key, top in MAX_POINTS.items():
        if not 0 <= parts[key] <= top:
            raise ValueError('%s out of range: %s' % (key, parts[key]))
    score = sum(parts[k] for k in MAX_POINTS)
    return score, priority(score)


def allowed_hiring_variants(f):
    """V5 modes that may be claimed. An empty list means no hiring claim."""
    age = f.get('posting_age_days')
    if not f.get('verified_role') or age is None or age > MAX_EVIDENCE_AGE_DAYS:
        return []
    return ['exact', 'role_only'] if f.get('verified_location') else ['role_only']
