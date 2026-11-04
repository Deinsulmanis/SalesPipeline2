# -*- coding: utf-8 -*-
"""Tests for jole-buying-signals. Run: python tests/test_signals.py"""
import json
import os
import sys
import unittest

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import signal_logic as L  # noqa: E402
C = L.C

SKILL = C.skill_text('jole-buying-signals')
FIXTURES = json.loads(C.read(HERE, 'fixtures.json'))

REQUIRED = [
    'what evidence suggests the employer may need additional skilled workers, and when?',
    'No buying signal is not equivalent to failed ICP qualification',
    'Do not investigate every signal category for every company',
    'Separate a public announcement from a demonstrated need to purchase outside labor',
    'If contract labor is already documented, do not spend more time proving the employer might use outside labor',
    'Buyer accessibility and procurement are separate dimensions owned by other skills and never enter this score',
    'Geography is not a scoring factor. Dollar size is not an input',
    'Large dollar announcements must not inflate scores',
    'A low score never changes the ICP label',
    'A signal whose window has passed is expired, whatever its source',
    'An aggregator page is POTENTIAL until confirmed on the employer\'s own board',
    'Never use Indeed, ZipRecruiter, Glassdoor or SimplyHired',
    '**PRIORITY A** 64 to 75. **PRIORITY B** 53 to 63. **NURTURE / RESEARCH** 52 or less',
]


class Fixtures(unittest.TestCase):
    def test_cases(self):
        for c in FIXTURES['cases']:
            with self.subTest(c['id'] + ' ' + c['title']):
                st = L.status(c['signals'])
                self.assertEqual(st, c['expect']['status'])
                self.assertEqual(L.demand(c['parts'])[1], c['expect']['priority'])
                self.assertEqual(L.anchor_violations(st, c['outside_labor'], c['window'], c['parts']), [])


class Rules(unittest.TestCase):
    def test_bands(self):
        self.assertEqual(L.priority(64), 'PRIORITY A')
        self.assertEqual(L.priority(63), 'PRIORITY B')
        self.assertEqual(L.priority(53), 'PRIORITY B')
        self.assertEqual(L.priority(52), 'NURTURE / RESEARCH')
        self.assertEqual(sum(L.DEMAND_MAX.values()), 75)

    def test_only_demand_counts(self):
        parts = {'signal': 20, 'external': 12, 'timing': 12}
        noisy = dict(parts, buyer=15, procurement=10, dollars=600000000, state='WA', employees=9000)
        self.assertEqual(L.demand(parts), L.demand(noisy))

    def test_out_of_range(self):
        with self.assertRaises(ValueError):
            L.demand({'signal': 31, 'external': 0, 'timing': 0})

    def test_excluded_is_not_scored(self):
        self.assertEqual(L.demand({'signal': 30, 'external': 25, 'timing': 20}, icp='EXCLUDED'), (None, 'NOT SCORED'))

    def test_potential_never_scores_like_verified(self):
        bad = L.anchor_violations('POTENTIAL SIGNAL', 'UNKNOWN', 'active', {'signal': 22, 'external': 10, 'timing': 17})
        self.assertTrue(bad)

    def test_external_needs_documented_use(self):
        bad = L.anchor_violations('VERIFIED CURRENT SIGNAL', 'PLAUSIBLE', 'active', {'signal': 24, 'external': 22, 'timing': 17})
        self.assertTrue(bad)

    def test_distant_project_cannot_take_current_timing(self):
        bad = L.anchor_violations('VERIFIED FUTURE SIGNAL', 'PLAUSIBLE', 'later', {'signal': 18, 'external': 12, 'timing': 18})
        self.assertTrue(bad)

    def test_no_signal_status_has_no_effect_on_icp(self):
        icp = C.load_logic('jole-icp-qualification', 'icp_logic')
        f = {'company': 'Test Yard', 'business': 'end_employer', 'operations': 'VERIFIED', 'craft_fit': 'PROCESS'}
        for st in C.LABELS['signal']:
            self.assertEqual(icp.label(dict(f, signal=st)), 'QUALIFIED')


class Policy(unittest.TestCase):
    def test_required_clauses(self):
        text = C.flat(SKILL)
        for clause in REQUIRED:
            self.assertTrue(clause in text, 'Missing from SKILL.md: ' + clause)

    def test_labels(self):
        for label in C.LABELS['signal'] + C.LABELS['priority']:
            self.assertIn(label, SKILL)

    def test_no_buyer_or_procurement_points(self):
        body = SKILL.split('## Change log')[0]
        self.assertNotIn('| Buyer accessibility and relevance | 15 |', body)
        self.assertNotIn('Procurement and operational accessibility', body)


if __name__ == '__main__':
    unittest.main(verbosity=1)
