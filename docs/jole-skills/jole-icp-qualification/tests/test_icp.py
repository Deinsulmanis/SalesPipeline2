# -*- coding: utf-8 -*-
"""Tests for jole-icp-qualification. Run: python tests/test_icp.py"""
import json
import os
import sys
import unittest

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import icp_logic as L  # noqa: E402
C = L.C

SKILL = C.skill_text('jole-icp-qualification')
FIXTURES = json.loads(C.read(HERE, 'fixtures.json'))

REQUIRED = [
    'can Jole realistically provide industrial skilled labor to this company?',
    'Load the shared policy first',
    'Do not require:** a recent job advertisement, a verified expansion, a contract award, an identified decision-maker, a current labor shortage, a 30-day requirement, proof the company previously purchased outside labor',
    'Geography inside the US, aluminum work, Navy or defense work and union presence never lower this decision',
    'Keywords alone',
    'are not operational evidence',
    'An unanswered secondary question must not automatically become a rejection',
    'Do not classify QUALIFIED when trade fit cannot be established',
    'do not accept a company merely because its website includes generic industrial keywords',
    'Missing proof of prior subcontract use is not a hard exclusion',
    'Do not exclude it for serving plant owners',
    'Review individually for actual buyer fit and competition',
    'Membership alone is not a verified disqualification',
    'Defense shipyards and contractors are not in this pool',
    'Check every contractor for a workforce-supply line',
    'The company\'s work decides this, not its customers\' sector',
]
SUPERSEDED = ['end employers only', 'Contractors stay out unless', 'Hiring evidence (required)',
              'all gates must pass', 'Union hiring-hall employers are out', 'posted in the last 30 days']


class Fixtures(unittest.TestCase):
    def test_cases(self):
        for c in FIXTURES['cases']:
            with self.subTest(c['id'] + ' ' + c['title']):
                got, reasons, details = L.decide(c['facts'])
                self.assertEqual(got, c['expect'], reasons)
                if 'overlap' in c:
                    self.assertEqual(details['labor_supply_overlap'], c['overlap'])
                if 'credit_hold' in c:
                    self.assertEqual(details['credit_hold'], c['credit_hold'])

    def test_has_boundary_and_negative_cases(self):
        kinds = [c['kind'] for c in FIXTURES['cases']]
        self.assertGreaterEqual(kinds.count('boundary'), 10)
        self.assertGreaterEqual(kinds.count('negative'), 10)


class Independence(unittest.TestCase):
    BASE = {'company': 'Test Yard', 'business': 'end_employer', 'operations': 'VERIFIED', 'craft_fit': 'PROCESS'}

    def test_ignores_everything_outside_fit(self):
        base = L.label(self.BASE)
        self.assertEqual(base, 'QUALIFIED')
        for extra in ({'buyer': 'NOT_FOUND'}, {'signal': 'NONE'}, {'postings': 0}, {'posting_age_days': 400},
                      {'signal_window_days': 900}, {'employees': 3}, {'employees': 90000}, {'state': 'WA'},
                      {'aluminum': True}, {'navy': True}, {'union': 'USW'}, {'access': 'binding_agreement'},
                      {'contact_verified': False}, {'deliverability_hold': True}, {'approved_variant': False},
                      {'outside_labor': 'UNKNOWN'}, {'suppressed': True}):
            self.assertEqual(L.label(dict(self.BASE, **extra)), base, extra)

    def test_keywords_alone_never_qualify(self):
        for craft in ('DIRECT', 'PROCESS', 'UNCLEAR'):
            self.assertNotEqual(L.label(dict(self.BASE, operations='KEYWORDS_ONLY', craft_fit=craft)), 'QUALIFIED')

    def test_strong_demand_cannot_open_a_labor_seller(self):
        f = dict(self.BASE, business='labor_seller', signal='VERIFIED', postings=50, priority='PRIORITY A')
        self.assertEqual(L.label(f), 'EXCLUDED')

    def test_not_everyone_is_accepted(self):
        results = [L.label(c['facts']) for c in FIXTURES['cases']]
        self.assertGreater(results.count('EXCLUDED'), 5)
        self.assertGreater(results.count('CONDITIONAL'), 3)


class Policy(unittest.TestCase):
    def test_required_clauses(self):
        text = C.flat(SKILL)
        for clause in REQUIRED:
            self.assertTrue(clause in text, 'Missing from SKILL.md: ' + clause)

    def test_no_superseded_rules(self):
        body = SKILL.split('## Change log')[0].lower()
        for phrase in SUPERSEDED:
            self.assertNotIn(phrase.lower(), body, phrase)

    def test_labels(self):
        for label in C.LABELS['icp']:
            self.assertIn('**' + label + ':**', SKILL)

    def test_sample_output_is_valid(self):
        sample = {'skill': 'jole-icp-qualification', 'version': '1.0.0',
                  'subject': {'kind': 'company', 'key': 'arcsolutions.example'}, 'decision': 'EXCLUDED',
                  'confidence': 'HIGH',
                  'evidence': [{'kind': 'FACT', 'claim': 'Services welding equipment; no crafts of its own',
                                'source': 'company services page', 'date': '2026-11-02'}],
                  'unknowns': [], 'hard_exclusions': [{'rule': 'equipment-service firm with no Jole crafts', 'evidence': 'services page'}],
                  'next_step': 'Stop', 'more_research': {'justified': False, 'why': 'Settled'},
                  'assessed': {'date': '2026-11-03', 'depth': 'L1', 'lookups': 2, 'apollo_credits': 0}, 'details': {}}
        self.assertEqual(C.validate_output(sample, 'jole-icp-qualification'), [])
        inferred = json.loads(json.dumps(sample))
        inferred['evidence'][0]['kind'] = 'INFERENCE'
        self.assertIn('hard decision rests on inference only', C.validate_output(inferred, 'jole-icp-qualification'))


if __name__ == '__main__':
    unittest.main(verbosity=1)
