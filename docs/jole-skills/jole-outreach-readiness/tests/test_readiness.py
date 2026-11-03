# -*- coding: utf-8 -*-
"""Tests for jole-outreach-readiness. Run: python tests/test_readiness.py"""
import json
import os
import sys
import unittest

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import readiness_logic as L  # noqa: E402
C = L.C

SKILL = C.skill_text('jole-outreach-readiness')
FIXTURES = json.loads(C.read(HERE, 'fixtures.json'))

REQUIRED = [
    'can this contact be approached using accurate, evidence-supported messaging?',
    'Do not modify or activate V5',
    'This skill cannot authorize sending or importing contacts on its own',
    'Do not require a job posting for project-based or general-workforce prospecting',
    'Existing V5 hiring copy is used only where its hiring claim is actually supported',
    'A signal-based company without a verified hiring role must not use a hiring-based V5 variant',
    'Do not invent a role, project, hiring requirement or labor shortage',
    '`general_craft` is not an approved signal-aware variant',
    'Their evidence must have been checked within 30 days when Touch 1 renders (`FRESHNESS_DAYS = 30`)',
    'A lead with no classification entry resolves to `hold`',
    'Hiring trigger', 'Project or contract award', 'Expansion or production growth', 'Turnaround or maintenance',
    'General industrial workforce',
    '{title} at {company}, based at the hiring site [({site note})]; {company} posted {role} at {site}; {n} craft postings in the last 30 days ({m} core-trade).',
    'V5 Tier A before Tier B',
]


class Fixtures(unittest.TestCase):
    def test_cases(self):
        base = FIXTURES['base']
        for c in FIXTURES['cases']:
            with self.subTest(c['id'] + ' ' + c['title']):
                label, reason, sequence = L.decide(dict(base, **c['facts']))
                self.assertEqual(label, c['expect'], reason)
                if 'sequence' in c:
                    self.assertEqual(sequence, c['sequence'])


class Rules(unittest.TestCase):
    def test_hiring_window_is_30_days(self):
        self.assertEqual(L.hiring_modes('Welder', 'Mobile, AL', 30), ['exact', 'role_only'])
        self.assertEqual(L.hiring_modes('Welder', '', 30), ['role_only'])
        self.assertEqual(L.hiring_modes('Welder', 'Mobile, AL', 31), [])
        self.assertEqual(L.hiring_modes('', 'Mobile, AL', 1), [])

    def test_production_still_uses_30_days(self):
        """If production code is reachable, its FRESHNESS_DAYS must still be 30."""
        import re
        repo = os.path.join(os.path.expanduser('~'), 'OneDrive', 'SalesPipeline2', 'integrations', 'clients', 'jole-personalization.js')
        if not os.path.exists(repo):
            self.skipTest('SalesPipeline2 checkout not available')
        text = C.read(repo)
        m = re.search(r'const FRESHNESS_DAYS = (\d+);', text)
        if not m:
            self.skipTest('this checkout has no jole-personalization freshness constant')
        self.assertEqual(int(m.group(1)), L.HIRING_FRESHNESS_DAYS)

    def test_ready_never_comes_from_one_strong_dimension(self):
        base = dict(FIXTURES['base'], approach=5)
        for weak in ({'contact': 'HOLD'}, {'buyer': 'BUYER PARTIAL'}, {'dedupe': 'SUPPRESSED'}, {'icp': 'CONDITIONAL'}):
            self.assertNotEqual(L.decide(dict(base, **weak))[0], 'READY FOR APPROVED SEQUENCE', weak)


class Policy(unittest.TestCase):
    def test_required_clauses(self):
        text = C.flat(SKILL)
        for clause in REQUIRED:
            self.assertTrue(clause in text, 'Missing from SKILL.md: ' + clause)

    def test_labels(self):
        for label in C.LABELS['readiness']:
            self.assertIn(label, SKILL)

    def test_no_45_day_hiring_rule(self):
        body = C.flat(SKILL.split('## Change log')[0])
        self.assertNotIn('posting date within 45 days', body)
        self.assertNotIn('within 45 days', body)


if __name__ == '__main__':
    unittest.main(verbosity=1)
