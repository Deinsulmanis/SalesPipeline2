# -*- coding: utf-8 -*-
"""Tests for jole-site-labor-feasibility. Run: python tests/test_feasibility.py"""
import json
import os
import sys
import unittest

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import feasibility_logic as L  # noqa: E402
C = L.C

SKILL = C.skill_text('jole-site-labor-feasibility')
FIXTURES = json.loads(C.read(HERE, 'fixtures.json'))

REQUIRED = [
    'is there a practical commercial path for Jole to supply workers for this specific operation?',
    'Do not invoke it for general defense capability alone',
    'Do not assume that a Navy contract is inaccessible',
    'Do not assume that a unionized facility is automatically inaccessible',
    'But do not ignore verified restrictions',
    'Never decide on the word "union" or "defense" alone',
    'This skill never changes the ICP label or the priority',
    'A check that only "may" apply is a note and leaves the decision FEASIBLE',
    'Only a verified barrier gives BLOCKED',
    'security clearance', 'installation access', 'approved-vendor requirements and procurement restrictions',
    'Never claim a certification Jole has not listed',
    'BLOCKED stops all further work on the covered scope only',
    'they never exclude the company',
    'This is a commercial reading, not legal advice',
]


class Fixtures(unittest.TestCase):
    def test_cases(self):
        for c in FIXTURES['cases']:
            with self.subTest(c['id'] + ' ' + c['title']):
                label, problems = L.decide(c['requirements'])
                self.assertEqual(label, c['expect'])
                self.assertEqual(bool(problems), c.get('problems', False))

    def test_triggers(self):
        for t in FIXTURES['triggers']:
            self.assertEqual(L.needs_assessment(t['flags']), t['expect'], t['flags'])


class Rules(unittest.TestCase):
    def test_v3_union_table_is_preserved(self):
        self.assertEqual(L.decide(L.union('binding_agreement'))[0], 'BLOCKED BY VERIFIED REQUIREMENT')
        self.assertEqual(L.decide(L.union('union_unknown'))[0], 'UNKNOWN')
        self.assertEqual(L.decide(L.union('union_contractors_documented'))[0], 'FEASIBLE WITH CONDITIONS')

    def test_blocked_does_not_exclude_at_icp(self):
        icp = C.load_logic('jole-icp-qualification', 'icp_logic')
        f = {'company': 'Valley Power Authority', 'business': 'end_employer', 'operations': 'VERIFIED',
             'craft_fit': 'DIRECT', 'feasibility': 'BLOCKED BY VERIFIED REQUIREMENT'}
        self.assertEqual(icp.label(f), 'QUALIFIED')


class Policy(unittest.TestCase):
    def test_required_clauses(self):
        text = C.flat(SKILL)
        for clause in REQUIRED:
            self.assertTrue(clause in text, 'Missing from SKILL.md: ' + clause)

    def test_labels(self):
        for label in C.LABELS['feasibility']:
            self.assertIn(label, SKILL)


if __name__ == '__main__':
    unittest.main(verbosity=1)
