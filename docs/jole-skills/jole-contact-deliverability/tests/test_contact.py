# -*- coding: utf-8 -*-
"""Tests for jole-contact-deliverability. Run: python tests/test_contact.py"""
import json
import os
import sys
import unittest

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import contact_logic as L  # noqa: E402
C = L.C

SKILL = C.skill_text('jole-contact-deliverability')
FIXTURES = json.loads(C.read(HERE, 'fixtures.json'))

REQUIRED = [
    'is the proposed recipient\'s email suitable for outbound sending?',
    'A strong opportunity does not override contact-level sending restrictions',
    'Do not bypass safeguards on risky Proofpoint catch-all addresses',
    'A Proofpoint catch-all contact stays on the sending-quality hold',
    'jole-deliverability-holds.json',
    'Do not equate an Apollo email-availability indicator with verified inbox deliverability',
    'do not send test emails without authorization',
    'Only Apollo work emails marked **VERIFIED** pass',
    'Never guess or pattern-build an email',
    'Approve corporate mail domains such as cat.com, uss.com, p66.com and bepc.com',
    'alloy.com is a fintech',
    'send after non-catch-all contacts',
    'Accepted means a person reviews the contact. It is not permission to import or send',
    'pphosted.com', 'ppe-hosted.com',
]


class Fixtures(unittest.TestCase):
    def test_cases(self):
        for c in FIXTURES['cases']:
            with self.subTest(c['id'] + ' ' + c['title']):
                label, reasons, flags = L.decide(c['facts'])
                self.assertEqual(label, c['expect'], reasons)
                if c.get('flagged'):
                    self.assertTrue(flags)


class Rules(unittest.TestCase):
    def test_gateway(self):
        self.assertEqual(L.gateway('mxa-00345a01.gslb.pphosted.com'), 'proofpoint')
        self.assertEqual(L.gateway('mx1-us1.ppe-hosted.com.'), 'proofpoint')
        self.assertEqual(L.gateway('notpphosted.com.evil.example'), 'other')
        self.assertEqual(L.gateway(''), 'unknown')

    def test_company_strength_cannot_release_a_hold(self):
        f = FIXTURES['cases'][0]['facts']
        for extra in ({'company_priority': 'PRIORITY A'}, {'signal': 'VERIFIED CURRENT SIGNAL'}, {'icp': 'QUALIFIED'}):
            self.assertEqual(L.decide(dict(f, **extra))[0], 'HOLD')

    def test_hold_leaves_icp_untouched(self):
        icp = C.load_logic('jole-icp-qualification', 'icp_logic')
        f = {'company': 'Beaumont Shipbuilding', 'business': 'end_employer', 'operations': 'VERIFIED', 'craft_fit': 'DIRECT',
             'deliverability_hold': True, 'contact': 'HOLD'}
        self.assertEqual(icp.label(f), 'QUALIFIED')


class Policy(unittest.TestCase):
    def test_required_clauses(self):
        text = C.flat(SKILL)
        for clause in REQUIRED:
            self.assertTrue(clause in text, 'Missing from SKILL.md: ' + clause)

    def test_labels(self):
        for label in C.LABELS['contact']:
            self.assertIn(label, SKILL)


if __name__ == '__main__':
    unittest.main(verbosity=1)
