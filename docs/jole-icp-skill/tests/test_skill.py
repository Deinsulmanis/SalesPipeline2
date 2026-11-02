# -*- coding: utf-8 -*-
"""Regression tests for the Jole ICP skill. Run: python tests/test_skill.py

Checks four things:
  1. Mechanical rules reproduce every fixture in fixtures.json.
  2. SKILL.md still contains the required policy and none of the old rules.
  3. The 38 recorded decisions have not drifted (fixtures_38.json).
  4. The pointers that make the skill discoverable are in place.
"""
import json
import os
import sys
import unittest

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
SKILL_DIR = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import decide as D  # noqa: E402

HOME = os.path.expanduser('~')


def read(*parts):
    with open(os.path.join(*parts), encoding='utf-8') as f:
        return f.read()


SKILL = read(SKILL_DIR, 'SKILL.md')
REFERENCE = read(SKILL_DIR, 'reference.md')
FIXTURES = json.loads(read(HERE, 'fixtures.json'))
BY_ID = {c['id']: c for c in FIXTURES['cases']}

REQUIRED_CLAUSES = [
    # Capabilities
    'Do not exclude a contractor simply because it provides industrial construction, fabrication, plant maintenance or mechanical services',
    'Shipyards, marine manufacturers and fabricators needing aluminum welding are eligible',
    'Do not penalize a company for being outside TX, LA or the Gulf',
    'Do not auto-exclude defense shipyards or contractors',
    'General defense capability does not prove eligibility for every individual contract',
    'Project timing should affect outreach priority, not automatically determine ICP eligibility',
    # Dimensions
    'A low score must not turn a qualified employer into an exclusion',
    'A company can be ICP QUALIFIED and NURTURE',
    'Do not classify QUALIFIED when trade fit cannot be established',
    'Missing proof of prior subcontract use is not a hard exclusion',
    # Signals
    'Never present a potential signal as verified',
    'Do not invent job postings, labor shortages or project details',
    'Large dollar announcements must not inflate scores',
    # Guardrails
    'No contact may be queued or sent merely because a company passes ICP qualification',
    'Do not bypass safeguards on risky Proofpoint catch-all addresses',
    'A strong buying signal does not override deliverability, suppression or compliance restrictions',
    'Do not modify or activate V5',
    'must not use a hiring-based V5 variant',
    'Do not purchase the same contact twice',
    'A company can qualify while a site buyer is unidentified',
    'Apollo credits: 0 unless the user gives an explicit cap',
    # Hard exclusions
    'Karpower', 'Kiewit Offshore Services', 'KOS', 'TIC', 'Weeks Marine', 'SpaceX', 'SpaceXAI',
    'Brock', 'Austin Industrial', 'Zachry', 'Turner Industries', 'TEAM Inc.', 'Bilfinger',
    'Koch Engineered Solutions', 'Bay Ltd.', 'Taurus Industrial', 'Upchurch',
    'Martin Engineering', 'Nalco Water',
    # Sections the brief asked for
    '## Change log', '## 15. Examples', '## 11. Apollo credit protection',
    '**Version 3.0.0',
]
SUPERSEDED = [
    'end employers only',
    'industrial end employers',
    'hiring craft workers *right now*',
    'Contractors stay out unless',
    'Hiring evidence (required)',
    'all gates must pass',
    'Every lead needs a verified role',
    'Never corporate HQ, unless the HQ is the plant.',
    'pipeline contractors stay held',
]


class Fixtures(unittest.TestCase):
    def test_required_ids_present(self):
        for i in ['F01', 'F02', 'F03a', 'F03b', 'F04a', 'F04b', 'F05', 'F06', 'F07', 'F08', 'F09', 'F10', 'F11a']:
            self.assertIn(i, BY_ID)

    def test_all_cases(self):
        for c in FIXTURES['cases']:
            with self.subTest(c['id'] + ': ' + c['title']):
                f, want = c['facts'], c['expect']
                if 'eligibility' in want:
                    self.assertEqual(D.eligibility(f)[0], want['eligibility'])
                if 'readiness' in want:
                    self.assertEqual(D.readiness(f)[0], want['readiness'])
                if 'priority' in want:
                    self.assertEqual(D.opportunity(c['parts'])[1], want['priority'])
                if 'site_gate' in want:
                    s = c['site']
                    self.assertEqual(D.site_gate(s['size'], s['relation'], s['central_authority']), want['site_gate'])
                if 'hiring_variants' in want:
                    self.assertEqual(D.allowed_hiring_variants(f), want['hiring_variants'])


class Independence(unittest.TestCase):
    BASE = {'company': 'Test Yard', 'business': 'end_employer', 'trade': 'established',
            'access': 'open', 'signal': 'VERIFIED', 'buyer': 'VERIFIED'}

    def test_eligibility_ignores_buyer_timing_postings_and_size(self):
        base = D.eligibility(self.BASE)
        for extra in ({'buyer': 'NOT_FOUND'}, {'signal': 'POTENTIAL'}, {'signal_current': False},
                      {'posting_age_days': 400}, {'employees': 3}, {'contact_verified': False}):
            self.assertEqual(D.eligibility(dict(self.BASE, **extra)), base, extra)

    def test_low_score_never_excludes(self):
        score, prio = D.opportunity(dict(signal=1, external=1, timing=1, buyer=0, procurement=0))
        self.assertEqual(prio, 'NURTURE / RESEARCH')
        self.assertEqual(D.eligibility(self.BASE)[0], 'QUALIFIED')

    def test_dollars_cannot_change_a_score(self):
        parts = dict(signal=20, external=10, timing=10, buyer=10, procurement=5)
        self.assertEqual(D.opportunity(parts), D.opportunity(dict(parts, dollars=600000000)))

    def test_points_cap(self):
        with self.assertRaises(ValueError):
            D.opportunity(dict(signal=31, external=0, timing=0, buyer=0, procurement=0))
        self.assertEqual(sum(D.MAX_POINTS.values()), 100)

    def test_priority_boundaries(self):
        self.assertEqual(D.priority(85), 'PRIORITY A')
        self.assertEqual(D.priority(84), 'PRIORITY B')
        self.assertEqual(D.priority(70), 'PRIORITY B')
        self.assertEqual(D.priority(69), 'NURTURE / RESEARCH')

    def test_strong_signal_cannot_open_a_hard_exclusion(self):
        strong = dict(self.BASE, company='Turner Industries', contact_verified=True, approved_variant=True)
        self.assertEqual(D.eligibility(strong)[0], 'EXCLUDED')
        self.assertEqual(D.readiness(strong)[0], 'HOLD')


class Policy(unittest.TestCase):
    def test_required_clauses(self):
        flat = ' '.join(SKILL.split())
        for clause in REQUIRED_CLAUSES:
            self.assertIn(clause, flat, 'Missing from SKILL.md: ' + clause)

    def test_no_superseded_rules_outside_change_log(self):
        body = SKILL.split('## Change log')[0].split('---', 2)[2]
        for phrase in SUPERSEDED:
            self.assertNotIn(phrase.lower(), body.lower(), 'Superseded rule found: ' + phrase)

    def test_description_is_not_hiring_only(self):
        head = SKILL.split('---')[1].lower()
        self.assertIn('eligible contractors', head)
        self.assertNotIn('verified skilled-trade hiring', head)
        self.assertLess(len(head), 1100)

    def test_every_clause_keeps_decide_in_sync(self):
        for label in D.ELIGIBILITY + D.READINESS:
            self.assertIn(label, SKILL, label)

    def test_reference_is_not_stale(self):
        self.assertNotIn('production branch `cursor/staffing-agent-shadow-production-7402`', REFERENCE)
        self.assertIn('not a ban on contractors', REFERENCE)


class Recorded38(unittest.TestCase):
    def test_decisions_have_not_drifted(self):
        rows = json.loads(read(HERE, 'fixtures_38.json'))
        self.assertEqual(len(rows), 38)
        for r in rows:
            with self.subTest(r['name']):
                label = D.eligibility(r['facts'])[0]
                self.assertEqual(label, r['eligibility'])
                self.assertEqual(D.readiness(r['facts'], label)[0], r['readiness'])
                if r['parts']:
                    parts = dict(zip(D.MAX_POINTS, r['parts']))
                    self.assertEqual(D.opportunity(parts), (r['score'], r['priority']))
                else:
                    self.assertEqual(label, 'EXCLUDED')


class Discovery(unittest.TestCase):
    def test_codex_copy_is_a_pointer(self):
        path = os.path.join(HOME, '.agents', 'skills', 'jolesbtxicpskill', 'SKILL.md')
        if not os.path.exists(path):
            self.skipTest('No Codex copy on this machine')
        text = read(path)
        self.assertTrue(r'.claude\skills\jolesbtxicpskill' in text, 'Codex copy does not point to canonical')
        self.assertFalse('## 3. Dimension A' in text or 'end employers only' in text, 'Codex copy holds rules')
        self.assertLess(len(text), 2000)
        self.assertFalse(os.path.exists(os.path.join(os.path.dirname(path), 'reference.md')), 'Stale reference.md')

    def test_instruction_files_name_the_skill(self):
        for rel in ('.claude/CLAUDE.md', 'AGENTS.md', '.codex/AGENTS.md'):
            path = os.path.join(HOME, *rel.split('/'))
            if os.path.exists(path):
                self.assertTrue('jolesbtxicpskill' in read(path), 'No pointer in ' + rel)


if __name__ == '__main__':
    unittest.main(verbosity=1)
