# -*- coding: utf-8 -*-
"""Shared definitions for the Jole skill tests (policy 4.0.0).

The shared SKILL.md is the policy. This module restates its lists and labels
so every skill's tests use one copy, and test_policy.py checks that this copy
still matches the SKILL.md text. If they disagree, SKILL.md wins and this file
must be fixed.
"""
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
POLICY_DIR = os.path.dirname(HERE)
SKILLS_ROOT = os.path.dirname(POLICY_DIR)
HOME = os.path.expanduser('~')

SPECIALISTS = (
    'jole-icp-qualification', 'jole-buying-signals', 'jole-buyer-identification',
    'jole-site-labor-feasibility', 'jole-dedupe-suppression', 'jole-contact-deliverability',
    'jole-outreach-readiness',
)
ORCHESTRATOR = 'jole-qualification-orchestrator'
POLICY = 'jolesbtxicpskill'
ALL_SKILLS = (POLICY,) + SPECIALISTS + (ORCHESTRATOR,)

NOT_EVALUATED = 'NOT EVALUATED'
LABELS = {
    'icp': ('QUALIFIED', 'CONDITIONAL', 'EXCLUDED'),
    'signal': ('VERIFIED CURRENT SIGNAL', 'VERIFIED FUTURE SIGNAL', 'POTENTIAL SIGNAL',
               'NO VERIFIED SIGNAL', 'CONTRADICTORY / STALE SIGNAL'),
    'priority': ('PRIORITY A', 'PRIORITY B', 'NURTURE / RESEARCH'),
    'buyer': ('BUYER VERIFIED', 'BUYER PARTIAL', 'BUYER NOT SITE-CONNECTED', 'BUYER NOT IDENTIFIED'),
    'feasibility': ('FEASIBLE', 'FEASIBLE WITH CONDITIONS', 'UNKNOWN', 'BLOCKED BY VERIFIED REQUIREMENT'),
    'dedupe': ('NET NEW', 'EXISTING ACCOUNT — NEW OPPORTUNITY', 'EXISTING CONTACT',
               'FAMILY MATCH — REVIEW', 'SUPPRESSED', 'PROHIBITED'),
    'contact': ('CONTACT ACCEPTED FOR REVIEW', 'ADDITIONAL VERIFICATION REQUIRED', 'HOLD', 'REJECT'),
    'readiness': ('READY FOR APPROVED SEQUENCE', 'COPY / SIGNAL REVIEW REQUIRED',
                  'CONTACT VERIFICATION REQUIRED', 'HOLD', 'EXCLUDED'),
    'next_action': ('STOP', 'HOLD', 'REVIEW', 'RESEARCH FIT', 'RESEARCH FEASIBILITY', 'RESEARCH SIGNAL',
                    'RESEARCH BUYER', 'SOURCE CONTACT', 'VERIFY CONTACT', 'COPY REVIEW', 'HUMAN REVIEW'),
}
# Which skill owns which label set (shared policy section 3).
OWNER = {
    'icp': 'jole-icp-qualification', 'signal': 'jole-buying-signals', 'priority': 'jole-buying-signals',
    'buyer': 'jole-buyer-identification', 'feasibility': 'jole-site-labor-feasibility',
    'dedupe': 'jole-dedupe-suppression', 'contact': 'jole-contact-deliverability',
    'readiness': 'jole-outreach-readiness', 'next_action': 'jole-qualification-orchestrator',
}
HARD_DECISIONS = {'EXCLUDED', 'PROHIBITED', 'SUPPRESSED', 'BLOCKED BY VERIFIED REQUIREMENT', 'REJECT'}
CONFIDENCE = ('HIGH', 'MEDIUM', 'LOW')

# Shared policy section 2. Display names exactly as written there.
CLIENT_FAMILY_NAMES = ['Karpower', 'Karpowership', 'Kiewit Offshore Services', 'KOS', 'TIC', 'Weeks Marine',
                       'SpaceX', 'SpaceXAI']
NAMED_NEGATIVE_NAMES = ['Brock', 'Austin Industrial', 'Zachry', 'Turner Industries', 'TEAM Inc.',
                        'Team Industrial Services', 'Bilfinger', 'Koch Engineered Solutions', 'Bay Ltd.',
                        'Taurus Industrial', 'Upchurch']
NAMED_HOLD_NAMES = ['Martin Engineering', 'Nalco Water']

# Normalized keys used for matching. Families include the subsidiaries the policy lists.
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
_SUFFIX = re.compile(r'\b(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|group|lp|plc)\b\.?')


def name_key(name):
    """Key for named-list matching (whole words, legal suffixes and 'group' dropped)."""
    s = re.sub(r"[^a-z0-9 ]", ' ', (name or '').lower())
    s = _SUFFIX.sub(' ', s)
    return re.sub(r'\s+', ' ', s).strip()


def named_match(name):
    """('PROHIBITED', reason) for a client family or named competitor, else ('', '')."""
    raw = re.sub(r'\s+', ' ', re.sub(r"[^a-z0-9 ]", ' ', (name or '').lower())).strip()
    n = name_key(name)
    for key in (n, raw):
        if key in DNC_FAMILIES:
            return 'client_family', 'Client family: ' + DNC_FAMILIES[key]
        if key in NAMED_NEGATIVES:
            return 'named_negative', 'Named negative: sells crews or labor'
    for fam, why in DNC_FAMILIES.items():
        if len(fam) > 3 and ' %s ' % fam in ' %s ' % n:
            return 'client_family', 'Client family: ' + why
    for neg in NAMED_NEGATIVES:
        if len(neg) > 4 and (n == neg or n.startswith(neg + ' ')):
            return 'named_negative', 'Named negative: sells crews or labor'
    return '', ''


def company_key(value):
    """Same normalization as production integrations/clients/suppression.js companyKey."""
    s = str(value or '').lower().replace('&', ' and ')
    s = re.sub(r'[^a-z0-9 ]+', ' ', s)
    s = re.sub(r'\b(inc|incorporated|llc|l l c|ltd|limited|corp|corporation|co|company|lp|llp|plc|the)\b', ' ', s)
    return re.sub(r'\s+', ' ', s).strip()


def normalize_domain(value):
    s = str(value or '').strip().lower()
    s = re.sub(r'^https?://', '', s)
    s = re.sub(r'^www\.', '', s)
    return re.sub(r'/.*$', '', s)


def normalize_email(value):
    return str(value or '').strip().lower()


def read(*parts):
    with open(os.path.join(*parts), encoding='utf-8') as f:
        return f.read()


def skill_text(skill):
    return read(SKILLS_ROOT, skill, 'SKILL.md')


def frontmatter(text):
    """Parse the simple key: value frontmatter of a SKILL.md."""
    if not text.startswith('---'):
        return {}
    head = text.split('---', 2)[1]
    out = {}
    for line in head.strip().splitlines():
        if ':' in line:
            k, v = line.split(':', 1)
            out[k.strip()] = v.strip()
    return out


def flat(text):
    return ' '.join(text.split())


def validate_output(obj, skill):
    """Problems with an envelope (CONTRACT.md), as a list of strings."""
    problems = []
    for key in ('skill', 'version', 'subject', 'decision', 'confidence', 'evidence', 'unknowns',
                'next_step', 'more_research', 'assessed'):
        if key not in obj:
            problems.append('missing ' + key)
    if problems:
        return problems
    if obj['skill'] != skill:
        problems.append('wrong skill')
    if not (obj.get('subject') or {}).get('key'):
        problems.append('missing subject.key')
    allowed = set()
    for dim, owner in OWNER.items():
        if owner == skill:
            allowed.update(LABELS[dim])
    if obj['decision'] not in allowed:
        problems.append('decision %r is not a %s label' % (obj['decision'], skill))
    if obj['confidence'] not in CONFIDENCE:
        problems.append('bad confidence')
    if not obj['evidence']:
        problems.append('evidence is empty')
    if 'justified' not in (obj.get('more_research') or {}):
        problems.append('missing more_research.justified')
    if not (obj.get('assessed') or {}).get('date'):
        problems.append('missing assessed.date')
    hard = obj.get('hard_exclusions') or []
    if obj['decision'] in HARD_DECISIONS:
        if not hard:
            problems.append('hard decision without cited hard_exclusions')
        facts = [e for e in obj['evidence'] if e.get('kind') == 'FACT']
        if not facts:
            problems.append('hard decision rests on inference only')
    elif hard:
        problems.append('hard_exclusions on a non-hard decision')
    return problems


def load_logic(skill, module):
    """Import a specialist's reference logic by path, without name clashes."""
    import importlib.util
    path = os.path.join(SKILLS_ROOT, skill, 'tests', module + '.py')
    spec = importlib.util.spec_from_file_location(module, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod
