# -*- coding: utf-8 -*-
"""Freshness and re-verification tests (shared policy 4.1.0, section 7). Run: python tests/test_freshness.py

  1. The section 7 table, jole_common.FRESHNESS and the skills that use it agree.
  2. The production 30-day hiring-claim rule is preserved everywhere it applies.
  3. Window boundaries per use (fixtures).
  4. Old evidence lowers reliance and confidence, never a label, and is never an ICP exclusion.
  5. Signal status follows the event's dates, not the age of the check.
"""
import json
import os
import re
import sys
import unittest

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import jole_common as C  # noqa: E402

POLICY = C.skill_text(C.POLICY)
SECTION = POLICY.split('## 7.')[1].split('## 8.')[0]
FIXTURES = json.loads(C.read(HERE, 'freshness_fixtures.json'))
ICP = C.load_logic('jole-icp-qualification', 'icp_logic')
SIG = C.load_logic('jole-buying-signals', 'signal_logic')
RDY = C.load_logic('jole-outreach-readiness', 'readiness_logic')

POLICY_CLAUSES = [
    'Old evidence lowers reliance, never the decision',
    'keep its recorded label',
    'lower the confidence of any decision resting on it by one step',
    'Only new contrary evidence, or a date the finding records passing, changes a label',
    'Stale evidence is never an ICP exclusion',
    'Age is not status',
    'Re-verify by risk',
    'claims made to a recipient are tightest, then spend and import, then research ordering',
    'Re-verify only when the next use needs it',
    'Events end windows early',
    'Only the 30-day hiring rule is enforced by production code (`jole-personalization.js`, `FRESHNESS_DAYS = 30`)',
    'This rule governs reuse',
]
SKILL_CLAUSES = {
    'jole-icp-qualification': ['Older fit evidence never changes the label and is never an exclusion'],
    'jole-buying-signals': ['Evidence age is not signal status', 'not that our check is old',
                            'keep the status and set `reverify`'],
    'jole-outreach-readiness': ['Claims in copy have the tightest freshness',
                                'confirmed within 30 days when Touch 1 renders',
                                'Their evidence must have been checked within 30 days when Touch 1 renders (`FRESHNESS_DAYS = 30`)'],
    'jole-qualification-orchestrator': ['A past-window result with no new research keeps its label'],
    'jole-buyer-identification': ['re-confirm the current title and site with the free people search when the record is older than 30 days'],
}
# Earlier wording that conflicts with 4.1.0 and must not return.
RETIRED = ['checked within 90 days', 'a POTENTIAL, stale or absent signal', 'Reuse any output still inside its freshness window',
           'Freshness and reuse (working defaults)', 'The other windows are working defaults',
           'maxEvidenceAgeDays: 45` governs', 'posting date within 45 days']
def days(cell):
    """Days a table cell allows: '30 days ...' -> 30, '12 months ...' -> 365, 'Same day' -> 0, 'Not a claim' -> None."""
    cell = cell.strip()
    if cell.startswith('Not a claim'):
        return None
    if cell.startswith('Same day'):
        return 0
    m = re.match(r'(\d+) (days|months)', cell)
    assert m, cell
    n = int(m.group(1))
    return n if m.group(2) == 'days' else (365 if n == 12 else n * 30)


class Table(unittest.TestCase):
    def rows(self):
        lines = [l for l in SECTION.splitlines() if l.startswith('| ') and not l.startswith('| Finding') and '---' not in l]
        return [[c.strip() for c in l.strip('|').split('|')] for l in lines]

    def test_table_matches_common(self):
        rows = self.rows()
        self.assertEqual(len(rows), len(C.FRESHNESS))
        for row, (key, want) in zip(rows, C.FRESHNESS.items()):
            with self.subTest(key):
                self.assertEqual(row[1], want['changes'])
                got = {'research': days(row[2]), 'action': days(row[3]), 'copy': days(row[4])}
                self.assertEqual(got, {u: want[u] for u in C.USES})

    def test_production_hiring_rule(self):
        self.assertEqual(C.PRODUCTION_HIRING_DAYS, 30)
        self.assertEqual(C.FRESHNESS['hiring_posting']['copy'], C.PRODUCTION_HIRING_DAYS)
        self.assertEqual(RDY.HIRING_FRESHNESS_DAYS, C.PRODUCTION_HIRING_DAYS)
        self.assertIn('30 days when Touch 1 renders (production V5 rule)', SECTION)

    def test_copy_is_the_tightest_use(self):
        for key, w in C.FRESHNESS.items():
            if w['copy'] is not None:
                self.assertLessEqual(w['copy'], w['action'], key)
            self.assertLessEqual(w['action'], w['research'], key)

    def test_readiness_uses_the_table(self):
        self.assertEqual(RDY.SIGNAL_CLAIM_DAYS, C.FRESHNESS['project_status']['copy'])

    def test_clauses(self):
        flat = C.flat(POLICY)
        for clause in POLICY_CLAUSES:
            self.assertIn(clause, flat, 'shared policy: ' + clause)
        for skill, clauses in SKILL_CLAUSES.items():
            text = C.flat(C.skill_text(skill))
            for clause in clauses:
                self.assertIn(clause, text, '%s: %s' % (skill, clause))

    def test_retired_wording_is_gone(self):
        for skill in C.ALL_SKILLS:
            body = C.flat(C.skill_text(skill).split('## Change log')[0])
            for phrase in RETIRED:
                self.assertNotIn(phrase, body, '%s still says: %s' % (skill, phrase))


class Boundaries(unittest.TestCase):
    def test_cases(self):
        for c in FIXTURES['cases']:
            with self.subTest(c['id'] + ' ' + c['title']):
                ok, why = C.reliance(c['finding'], c['checked'], FIXTURES['today'], c['use'], c.get('date_passed', False))
                self.assertEqual(ok, c['ok'], why)
                if not ok:
                    self.assertTrue(why)

    def test_covers_every_finding_and_use(self):
        seen = {(c['finding'], c['use']) for c in FIXTURES['cases']}
        for key in C.FRESHNESS:
            self.assertTrue(any(f == key for f, _ in seen), key)
        self.assertGreaterEqual(sum(c['kind'] == 'negative' for c in FIXTURES['cases']), 3)


class AgeNeverDecides(unittest.TestCase):
    def test_age_adjusted_keeps_every_label(self):
        for dim, labels in C.LABELS.items():
            for label in labels:
                for checked in ('2026-11-03', '2025-01-01', '2019-06-30'):
                    for finding in C.FRESHNESS:
                        got, conf, rv = C.age_adjusted(label, 'HIGH', finding, checked, '2026-11-03', 'research')
                        self.assertEqual(got, label)
                        self.assertIn(conf, C.CONFIDENCE)
                        if rv:
                            self.assertEqual(conf, 'MEDIUM')
                            self.assertEqual(rv['before'], 'research')

    def test_stale_fit_is_never_an_icp_exclusion(self):
        fixtures = json.loads(C.read(C.SKILLS_ROOT, 'jole-icp-qualification', 'tests', 'fixtures.json'))['cases']
        for c in fixtures:
            fresh = ICP.label(c['facts'])
            for age in (400, 900, 3000):
                with self.subTest(c['id'], age=age):
                    old = dict(c['facts'], evidence_age_days=age, checked='2018-01-01')
                    self.assertEqual(ICP.label(old), fresh)
                    if fresh != 'EXCLUDED':
                        self.assertNotEqual(ICP.label(old), 'EXCLUDED')

    def test_signal_status_ignores_the_age_of_the_check(self):
        fixtures = json.loads(C.read(C.SKILLS_ROOT, 'jole-buying-signals', 'tests', 'fixtures.json'))['cases']
        for c in fixtures:
            aged = [dict(s, checked='2025-01-01') for s in c['signals']]
            self.assertEqual(SIG.status(aged), SIG.status(c['signals']), c['id'])

    def test_passed_window_is_stale_even_if_read_today(self):
        self.assertEqual(SIG.status([{'level': 'VERIFIED', 'window': 'passed', 'checked': '2026-11-03'}]),
                         'CONTRADICTORY / STALE SIGNAL')

    def test_old_check_on_a_live_program_stays_current(self):
        program = {'level': 'VERIFIED', 'window': 'active', 'checked': '2026-06-06'}
        self.assertEqual(SIG.status([program]), 'VERIFIED CURRENT SIGNAL')
        ok, _ = C.reliance('project_status', program['checked'], '2026-11-03', 'research')
        self.assertFalse(ok, 'a 150-day-old check must be flagged for re-verification')


if __name__ == '__main__':
    unittest.main(verbosity=1)
