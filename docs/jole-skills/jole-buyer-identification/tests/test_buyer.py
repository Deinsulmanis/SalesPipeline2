# -*- coding: utf-8 -*-
"""Tests for jole-buyer-identification. Run: python tests/test_buyer.py"""
import json
import os
import sys
import unittest

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import buyer_logic as L  # noqa: E402
C = L.C

SKILL = C.skill_text('jole-buyer-identification')
FIXTURES = json.loads(C.read(HERE, 'fixtures.json'))

REQUIRED = [
    'who is the most relevant person to approach about additional skilled labor?',
    'A company may remain ICP-qualified without a named buyer',
    'Decide the purchasing role before searching for names',
    'Prioritize authority over seniority',
    'The gate applies to the buyer, never to the company',
    'For a company of 1,001+ employees or unknown size, the buyer must be at the operating site, within about 50 miles, or hold verified centralized authority',
    'An unrelated corporate executive fails',
    'Do not invent a named buyer',
    'An Apollo preview alone is BUYER PARTIAL at best',
    'a verified buyer is not a verified contact',
    'No reveals without an authorized cap',
    'If the facility buyer is obvious, do not research unrelated corporate departments',
    'Shipyard General Manager', 'Plant Manager', 'Operations Director', 'Construction Manager', 'Project Director',
    'Turnaround or Outage Manager', 'Maintenance Manager', 'Fabrication or Production Manager', 'Craft Workforce Manager',
    'Owner, CEO or President', 'Procurement or subcontracts leader', 'Site HR or talent acquisition lead',
    'the head of the company is a strong buyer role on title alone',
    'This does not cover founder-only titles',
]


class Fixtures(unittest.TestCase):
    def test_statuses(self):
        for c in FIXTURES['cases']:
            with self.subTest(c['id'] + ' ' + c['title']):
                self.assertEqual(L.status(c['candidate']), c['expect'])

    def test_roles(self):
        for r in FIXTURES['roles']:
            with self.subTest(r['model']):
                self.assertEqual(L.target_role(r['model'], r.get('employees'), r.get('need', 'contract')), r['expect'])
                self.assertIn(L.BUYER_TYPE[r['expect']], C.read(C.POLICY_DIR, 'reference.md'))


class Rules(unittest.TestCase):
    def test_choose_prefers_site_buyer_over_senior_hq(self):
        cfo = {'name': 'CFO', 'role_strength': 'WEAK', 'source': 'company', 'current': True, 'size': '1001+', 'relation': 'hq_unrelated'}
        pm = {'name': 'PM', 'role_strength': 'STRONG', 'source': 'public_dated', 'current': True, 'size': '1001+', 'relation': 'at_site'}
        self.assertIs(L.choose([cfo, pm]), pm)

    def test_buyer_never_changes_icp(self):
        icp = C.load_logic('jole-icp-qualification', 'icp_logic')
        f = {'company': 'Sabine River Steel', 'business': 'end_employer', 'operations': 'VERIFIED', 'craft_fit': 'PROCESS'}
        for st in C.LABELS['buyer']:
            self.assertEqual(icp.label(dict(f, buyer=st)), 'QUALIFIED')


class Policy(unittest.TestCase):
    def test_required_clauses(self):
        text = C.flat(SKILL)
        for clause in REQUIRED:
            self.assertTrue(clause in text, 'Missing from SKILL.md: ' + clause)

    def test_labels(self):
        for label in C.LABELS['buyer']:
            self.assertIn(label, SKILL)


if __name__ == '__main__':
    unittest.main(verbosity=1)
