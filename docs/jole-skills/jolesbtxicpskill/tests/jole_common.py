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

# Shared policy section 7, in table order. Days a finding may be relied on for each use:
# research = research and ranking; action = before spend, import or queue; copy = before a claim in copy.
# 0 means the same day (live). None means the finding is never a claim in copy.
FRESHNESS = {
    'hiring_posting': {'changes': 'Fast', 'research': 30, 'action': 30, 'copy': 30},
    'project_status': {'changes': 'Medium', 'research': 90, 'action': 90, 'copy': 30},
    'fit_facts': {'changes': 'Slow', 'research': 365, 'action': 365, 'copy': None},
    'labor_terms': {'changes': 'Slow', 'research': 365, 'action': 365, 'copy': None},
    'buyer_employment': {'changes': 'Fast', 'research': 90, 'action': 30, 'copy': None},
    'crm_suppression': {'changes': 'Fast', 'research': 30, 'action': 0, 'copy': None},
    'email_status': {'changes': 'Medium', 'research': 30, 'action': 30, 'copy': None},
}
USES = ('research', 'action', 'copy')
# The finding each dimension's reuse rests on. A signal resting only on postings uses hiring_posting.
DIMENSION_FINDING = {'icp': 'fit_facts', 'signal': 'project_status', 'feasibility': 'labor_terms',
                     'buyer': 'buyer_employment', 'dedupe': 'crm_suppression', 'dedupe_contact': 'crm_suppression',
                     'contact': 'email_status'}
PRODUCTION_HIRING_DAYS = 30  # integrations/clients/jole-personalization.js FRESHNESS_DAYS


def age_days(checked, today):
    import datetime
    return (datetime.date.fromisoformat(today) - datetime.date.fromisoformat(checked)).days


def reliance(finding, checked, today, use, date_passed=False):
    """(ok, reason). ok False means re-verify before this use. It never changes a decision label."""
    limit = FRESHNESS[finding][use]
    if limit is None:
        return False, 'not a claim in copy'
    if date_passed:
        return False, 'a date it records has passed since it was checked'
    age = age_days(checked, today)
    if age > limit:
        return False, '%d days old; %s allows %d for %s' % (age, finding, limit, use)
    return True, ''


def lower(confidence):
    return {'HIGH': 'MEDIUM', 'MEDIUM': 'LOW'}.get(confidence, 'LOW')


def age_adjusted(decision, confidence, finding, checked, today, use='research', date_passed=False):
    """(decision, confidence, reverify or None). Old evidence lowers reliance, never the decision."""
    ok, why = reliance(finding, checked, today, use, date_passed)
    if ok:
        return decision, confidence, None
    return decision, lower(confidence), {'finding': finding, 'checked': checked, 'before': use, 'why': why}


# Shared policy "How to use", step 2: route by question, not by the number of subjects.
QUESTION_OWNER = {'fit': 'jole-icp-qualification', 'demand': 'jole-buying-signals', 'priority': 'jole-buying-signals',
                  'buyer': 'jole-buyer-identification', 'feasibility': 'jole-site-labor-feasibility',
                  'dedupe': 'jole-dedupe-suppression', 'contact': 'jole-contact-deliverability',
                  'readiness': 'jole-outreach-readiness'}


def route(questions, next_action=False, plan=False):
    """Skills a session should load for a task that asks these questions (any number of subjects)."""
    owners = sorted({QUESTION_OWNER[q] for q in questions})
    if len(owners) == 1 and not next_action and not plan:
        return [POLICY] + owners
    return [POLICY, ORCHESTRATOR] + owners

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


def load_module(path, name):
    """Import a file by path, without name clashes."""
    import importlib.util
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def load_logic(skill, module):
    """Import a specialist's reference logic by path."""
    return load_module(os.path.join(SKILLS_ROOT, skill, 'tests', module + '.py'), module)
