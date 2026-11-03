# -*- coding: utf-8 -*-
"""Integrated tests for jole-qualification-orchestrator. Run: python tests/test_orchestrator.py

Every case runs through the specialists' own reference logic, so a change in
any specialist that alters an end-to-end result shows up here.
"""
import json
import os
import sys
import unittest

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import orchestrator_logic as O  # noqa: E402
C = O.C

SKILL = C.skill_text('jole-qualification-orchestrator')
FIXTURES = json.loads(C.read(HERE, 'fixtures.json'))

REQUIRED = [
    'Do not run all seven skills on every lead',
    'This skill does not redo specialist research and owns no qualification rule of its own',
    'Reuse any output still inside its freshness window',
    'If the company fails industrial ICP, stop expensive buyer research',
    'If it is a known suppressed account, stop contact sourcing',
    'If the user wants only company discovery, do not run email qualification',
    'If a known industrial employer has no recent buying signal, do not automatically reject it',
    'If a company has a verified operational trigger and an obvious facility buyer, avoid researching unrelated corporate departments',
    'If contract labor is already documented, do not spend excessive time proving that the employer might use outside labor',
    'If the user wants a signal-based shortlist, prioritize that signal without redefining the entire ICP',
    'Stop when additional research would not materially change the decision',
    'Never rewrite one to agree with another',
    'A NURTURE / RESEARCH priority does not stop buyer research with free tools',
    'nothing is imported or sent by this skill',
]


class Integrated(unittest.TestCase):
    def test_cases(self):
        for c in FIXTURES['cases']:
            with self.subTest(c['id'] + ' ' + c['title']):
                s = dict(c['subject'], today=FIXTURES['today'])
                out = O.run(s)
                e = c['expect']
                for dim, want in e.get('dims', {}).items():
                    self.assertEqual(out['dimensions'][dim]['decision'], want, dim)
                if 'priority' in e:
                    self.assertEqual(out['dimensions']['signal']['priority'], e['priority'])
                if 'ran' in e:
                    self.assertEqual(out['ran'], e['ran'])
                if 'reused' in e:
                    self.assertEqual(out['reused'], e['reused'])
                if 'next_action' in e:
                    self.assertEqual(out['next_action'], e['next_action'])
                if 'conflicts' in e:
                    self.assertEqual(len(out['conflicts']), e['conflicts'])
                if 'overlap' in e:
                    self.assertEqual(out['dimensions']['icp']['details']['labor_supply_overlap'], e['overlap'])
                self.assertIn(out['next_action'], C.LABELS['next_action'])
                for dim, val in out['dimensions'].items():
                    if val['decision'] == C.NOT_EVALUATED:
                        self.assertTrue(val.get('reason'), dim + ' NOT EVALUATED without a reason')

    def test_examples_a_to_f_present(self):
        ids = {c['id'] for c in FIXTURES['cases']}
        self.assertTrue({'A', 'B', 'C', 'D', 'E', 'F'} <= ids)


class Principles(unittest.TestCase):
    def test_never_runs_everything_for_a_screen(self):
        out = O.run(dict(FIXTURES['cases'][0]['subject'], task='company_screen', today=FIXTURES['today']))
        self.assertLessEqual(len(out['ran']), 2)

    def test_dimensions_are_not_merged(self):
        """Strong demand with no buyer keeps both statuses; ICP stays QUALIFIED."""
        s = {'task': 'full', 'today': FIXTURES['today'],
             'dedupe_account': {'subject': {'name': 'Gulf Yards'}, 'records': {'live': True}},
             'icp': {'company': 'Gulf Yards', 'business': 'end_employer', 'operations': 'VERIFIED', 'craft_fit': 'DIRECT'},
             'signals': {'signals': [{'level': 'VERIFIED', 'window': 'active'}], 'parts': {'signal': 28, 'external': 22, 'timing': 19}},
             'buyer': [{'name': None}]}
        out = O.run(s)
        d = out['dimensions']
        self.assertEqual((d['icp']['decision'], d['signal']['priority'], d['buyer']['decision']),
                         ('QUALIFIED', 'PRIORITY A', 'BUYER NOT IDENTIFIED'))
        self.assertEqual(out['next_action'], 'RESEARCH BUYER')

    def test_specialist_results_are_not_overwritten(self):
        c = [x for x in FIXTURES['cases'] if x['id'] == 'O02'][0]
        out = O.run(dict(c['subject'], today=FIXTURES['today']))
        self.assertEqual(out['dimensions']['icp']['decision'], 'QUALIFIED')
        self.assertEqual(out['dimensions']['dedupe']['decision'], 'PROHIBITED')

    def test_precedence_order_matches_policy(self):
        policy = C.flat(C.skill_text('jolesbtxicpskill'))
        order = 'STOP, then HOLD, REVIEW, RESEARCH FIT, RESEARCH FEASIBILITY, RESEARCH SIGNAL, RESEARCH BUYER, SOURCE CONTACT, VERIFY CONTACT, COPY REVIEW, HUMAN REVIEW'
        self.assertIn(order, policy)
        self.assertEqual(', '.join(C.LABELS['next_action']).replace('STOP, HOLD', 'STOP, then HOLD'), order)


class Policy(unittest.TestCase):
    def test_required_clauses(self):
        text = C.flat(SKILL)
        for clause in REQUIRED:
            self.assertTrue(clause in text, 'Missing from SKILL.md: ' + clause)

    def test_names_every_specialist(self):
        for name in C.SPECIALISTS:
            self.assertIn(name, SKILL)

    def test_next_actions(self):
        for label in C.LABELS['next_action']:
            self.assertIn(label, SKILL)


if __name__ == '__main__':
    unittest.main(verbosity=1)
