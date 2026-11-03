# -*- coding: utf-8 -*-
"""Tests for jole-dedupe-suppression. Run: python tests/test_dedupe.py"""
import json
import os
import sys
import unittest

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import dedupe_logic as L  # noqa: E402
C = L.C

SKILL = C.skill_text('jole-dedupe-suppression')
FIXTURES = json.loads(C.read(HERE, 'fixtures.json'))

REQUIRED = [
    'is this account genuinely net-new and eligible for further sourcing?',
    'Everything here is read-only',
    'Email uniqueness is global, so an address belonging to ScaleLab or anyone else is refused, not reassigned',
    'a NET NEW from mirrors alone is provisional',
    'Do not confuse an existing customer record with proof that a newly identified project is worthless',
    'preserve the new buying-signal information without re-purchasing or re-queuing the same contact',
    'Do not purchase the same contact twice',
    'Supabase is canonical',
    'Investigate this only when a name, domain or ownership hint makes a family link plausible',
    'Never treat that as "not suppressed"',
    'client_suppressions', 'outreach_leads',
]


class Fixtures(unittest.TestCase):
    def test_cases(self):
        for c in FIXTURES['cases']:
            with self.subTest(c['id'] + ' ' + c['title']):
                label, conf, details = L.decide(c['subject'], c['records'])
                self.assertEqual(label, c['expect'])
                self.assertEqual(conf, c['confidence'])
                if 'scope' in c:
                    self.assertEqual(details['suppression_scope'], c['scope'])


class Rules(unittest.TestCase):
    def test_company_key_matches_production(self):
        self.assertEqual(C.company_key('The Conair Group, Inc.'), 'conair group')
        self.assertEqual(C.company_key('Walashek Industrial & Marine'), 'walashek industrial and marine')
        self.assertEqual(C.normalize_domain('HTTPS://www.Example.com/about'), 'example.com')

    def test_existing_account_is_not_a_rejection(self):
        label = L.decide({'level': 'account', 'name': 'Sabine Fab Works', 'domain': 'sabinefab.com'},
                         {'live': True, 'crm_accounts': [{'company': 'Sabine Fab Works', 'domain': 'sabinefab.com'}]})[0]
        self.assertNotIn(label, ('PROHIBITED', 'SUPPRESSED'))


class Policy(unittest.TestCase):
    def test_required_clauses(self):
        text = C.flat(SKILL)
        for clause in REQUIRED:
            self.assertTrue(clause in text, 'Missing from SKILL.md: ' + clause)

    def test_labels(self):
        for label in C.LABELS['dedupe']:
            self.assertIn(label, SKILL)


if __name__ == '__main__':
    unittest.main(verbosity=1)
