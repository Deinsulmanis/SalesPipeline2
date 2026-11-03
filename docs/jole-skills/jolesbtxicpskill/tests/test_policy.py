# -*- coding: utf-8 -*-
"""Shared-policy, architecture and drift tests. Run: python tests/test_policy.py

  1. The shared policy keeps its required clauses and none of the retired rules.
  2. Lists and labels here match jole_common.py, and no specialist copies them.
  3. Every skill's frontmatter, version and dependency line are consistent with ARCHITECTURE.md.
  4. Codex pointers and instruction files make the skills discoverable.
  5. The 38-company regression has not drifted, and every change from v3 has a reason.
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
POLICY_BODY = POLICY.split('## Change log')[0]
ARCH = C.read(C.POLICY_DIR, 'ARCHITECTURE.md')
CONTRACT = C.read(C.POLICY_DIR, 'CONTRACT.md')
REFERENCE = C.read(C.POLICY_DIR, 'reference.md')
TEXTS = {s: C.skill_text(s) for s in C.ALL_SKILLS}

REQUIRED = [
    # Capabilities (user brief of 2026-11-02)
    'Do not exclude a contractor simply because it provides industrial construction, fabrication, plant maintenance or mechanical services',
    'Staffing companies and labor brokers are excluded; mixed contractors are reviewed individually',
    'Shipyards, marine manufacturers and fabricators needing aluminum welding are eligible',
    'Do not penalize a company for being outside TX, LA or the Gulf',
    'Do not auto-exclude defense shipyards or contractors',
    'General defense capability does not prove eligibility for every individual contract',
    'Project timing should affect outreach priority, not automatically determine ICP eligibility',
    'Jole\'s onboarding form lists no certifications, so never claim any',
    # Independence
    'Never merge the dimensions into one score',
    'those statuses are not contradictory',
    'A low score must not turn a qualified employer into an exclusion',
    'A company can be ICP QUALIFIED and NURTURE',
    'Never downgrade ICP fit because of missing contact data, a missing buyer, missing copy',
    'A strong buying signal does not override deliverability, suppression or compliance restrictions',
    'A specialist never changes another specialist\'s decision',
    # Evidence
    'Never present a potential claim as verified',
    'A missing field is not a failed criterion',
    'Generic industrial keywords on a website are not operational evidence',
    'Do not force a binary answer',
    'What do we know? What does that imply? What remains uncertain? Would further research be worth the effort? What should happen next?',
    'Do not require deep project research to establish that a legitimate industrial employer belongs in the ICP',
    'Every hard exclusion needs cited evidence',
    # Safety
    'Apollo credits: 0 unless the user gives an explicit cap',
    'No contact may be queued or sent merely because a company passes ICP qualification',
    'Do not modify or activate V5',
    'Client id is always `jole`, never `jole-btx`',
    'Never send, queue, assign senders, or enable Jole sending',
    'Don\'t touch ScaleLab leads, campaigns or senders',
    'Do not run all seven specialists on every lead',
    'Only the 30-day hiring rule is enforced by production code',
    'Never use the legacy ColdEmail import',
    'Never create anonymous upload rules or weaken RLS',
    '**Version 4.0.0', '## Change log',
]
# v3 content that moved to reference.md and must not be lost again.
REFERENCE_REQUIRED = ['weak_buyer_role', 'location_too_remote', 'no_longer_employed', '`dnc`',
                      'General Dynamics Electric Boat', 'Expansion-pool names count as already sourced',
                      'Jole_Final_Review_Hold.csv', 'not a ban on contractors', 'Procurement / subcontracts']
SUPERSEDED = [
    'end employers only', 'industrial end employers', 'hiring craft workers *right now*', 'Contractors stay out unless',
    'Hiring evidence (required)', 'all gates must pass', 'Every lead needs a verified role',
    'Never corporate HQ, unless the HQ is the plant.', 'pipeline contractors stay held',
    'posting date within 45 days', 'Do not create a second Jole ICP skill',
]
# v3 labels that 4.0.0 replaced; they may appear only in change logs and MIGRATION-v4.md.
OLD_LABELS = ['READY FOR CONTACT REVIEW', 'BUYER RESEARCH REQUIRED', 'SIGNAL VERIFICATION REQUIRED',
              'COMPLIANCE / PROCUREMENT REVIEW', 'INDUSTRY FIT ONLY SIGNAL']
# Distinctive hard-list names that must live only in the shared policy.
LIST_ONLY_IN_POLICY = ['Koch Engineered Solutions', 'Taurus Industrial', 'Upchurch', 'Bilfinger', 'Turner Industries',
                       'Austin Industrial', 'Zachry', 'Karpower', 'Weeks Marine', 'SpaceX', 'Kiewit Offshore Services',
                       'Martin Engineering', 'Nalco Water']
# Specialist procedure that must not be duplicated into the shared policy.
NOT_IN_POLICY = ['Site tie labels', '| Verified demand signal strength | 30 |', 'Hiring-hall employer, or a project labor agreement',
                 '## Business model', 'Selection hierarchy', 'why_contact_is_relevant']
V3_NEXT = {'HOLD': {'STOP', 'HOLD'}, 'COMPLIANCE / PROCUREMENT REVIEW': {'REVIEW', 'RESEARCH FEASIBILITY'},
           'SIGNAL VERIFICATION REQUIRED': {'RESEARCH FIT', 'RESEARCH SIGNAL'},
           'BUYER RESEARCH REQUIRED': {'RESEARCH BUYER'}, 'CONTACT VERIFICATION REQUIRED': {'SOURCE CONTACT'}}


def body(text):
    return text.split('## Change log')[0]


class SharedPolicy(unittest.TestCase):
    def test_required_clauses(self):
        flat = C.flat(POLICY)
        for clause in REQUIRED:
            self.assertTrue(clause in flat, 'Missing from shared SKILL.md: ' + clause)

    def test_no_superseded_rules_anywhere(self):
        for skill, text in TEXTS.items():
            b = C.flat(body(text)).lower()
            for phrase in SUPERSEDED:
                self.assertNotIn(phrase.lower(), b, '%s still says: %s' % (skill, phrase))

    def test_old_labels_retired(self):
        for skill, text in TEXTS.items():
            for label in OLD_LABELS:
                self.assertNotIn(label, body(text), '%s still uses %s' % (skill, label))

    def test_policy_stays_lean(self):
        for marker in NOT_IN_POLICY:
            self.assertNotIn(marker, POLICY_BODY, 'Specialist procedure copied into the shared policy: ' + marker)


class OneDefinition(unittest.TestCase):
    def test_lists_match_common(self):
        section = POLICY_BODY.split('## 2.')[1].split('## 3.')[0]
        for name in C.CLIENT_FAMILY_NAMES + C.NAMED_NEGATIVE_NAMES + C.NAMED_HOLD_NAMES:
            self.assertIn(name, section, name)

    def test_lists_are_not_copied(self):
        for skill in C.SPECIALISTS + (C.ORCHESTRATOR,):
            for name in LIST_ONLY_IN_POLICY:
                self.assertNotIn(name, TEXTS[skill], '%s copies the hard list (%s)' % (skill, name))

    def test_label_table(self):
        section = POLICY_BODY.split('## 3.')[1].split('## 4.')[0]
        for dim, labels in C.LABELS.items():
            row = [l for l in section.splitlines() if '`%s`' % C.OWNER[dim] in l]
            self.assertTrue(row, dim)
            for label in labels:
                self.assertTrue(any(label in r for r in row), '%s label %s not in the policy table' % (dim, label))

    def test_each_owner_names_its_labels(self):
        for dim, labels in C.LABELS.items():
            for label in labels:
                self.assertIn(label, TEXTS[C.OWNER[dim]], '%s does not define %s' % (C.OWNER[dim], label))


class Architecture(unittest.TestCase):
    def test_frontmatter_and_versions(self):
        for skill in C.ALL_SKILLS:
            fm = C.frontmatter(TEXTS[skill])
            self.assertEqual(fm.get('name'), skill)
            self.assertTrue(re.match(r'^\d+\.\d+\.\d+$', fm.get('version', '')), skill)
            self.assertLessEqual(len(fm.get('description', '')), 1024, skill)
            self.assertIn('| `%s` | %s |' % (skill, fm['version']), ARCH, 'ARCHITECTURE.md version table: ' + skill)
            self.assertIn('(v%s)' % fm['version'], fm['description'], 'version in description: ' + skill)

    def test_specialists_depend_on_policy(self):
        for skill in C.SPECIALISTS + (C.ORCHESTRATOR,):
            fm = C.frontmatter(TEXTS[skill])
            self.assertIn('jolesbtxicpskill', fm['description'], skill)
            self.assertIn('Load the shared policy first', TEXTS[skill], skill)
            self.assertIn('## Change log', TEXTS[skill], skill)

    def test_each_skill_has_tests(self):
        for skill in C.SPECIALISTS + (C.ORCHESTRATOR,):
            tdir = os.path.join(C.SKILLS_ROOT, skill, 'tests')
            names = os.listdir(tdir)
            self.assertTrue(any(n.startswith('test_') and n.endswith('.py') for n in names), skill)
            self.assertIn('fixtures.json', names, skill)

    def test_descriptions_are_distinct(self):
        descs = [C.frontmatter(TEXTS[s])['description'] for s in C.ALL_SKILLS]
        self.assertEqual(len(set(descs)), len(descs))

    def test_contract_example_is_valid(self):
        block = CONTRACT.split('## The envelope')[1].split('```json')[1].split('```')[0]
        sample = json.loads(re.sub(r'"(HIGH \| MEDIUM \| LOW|company \| contact \| scope)"', lambda m: '"' + m.group(1).split(' | ')[0] + '"', block))
        self.assertEqual(C.validate_output(sample, 'jole-icp-qualification'), [])

    def test_reference_is_current(self):
        for item in REFERENCE_REQUIRED:
            self.assertIn(item, REFERENCE, item)
        self.assertNotIn('production branch `cursor/staffing-agent-shadow-production-7402`', REFERENCE)

    def test_every_v3_section_has_a_home(self):
        migration = C.read(C.POLICY_DIR, 'MIGRATION-v4.md')
        for n in range(1, 18):
            self.assertIn('| %d ' % n, migration, 'v3 section %d missing from MIGRATION-v4.md' % n)


class Discovery(unittest.TestCase):
    def test_codex_pointers(self):
        root = os.path.join(C.HOME, '.agents', 'skills')
        if not os.path.isdir(root):
            self.skipTest('No Codex skills folder on this machine')
        for skill in C.ALL_SKILLS:
            path = os.path.join(root, skill, 'SKILL.md')
            self.assertTrue(os.path.exists(path), 'No Codex pointer for ' + skill)
            text = C.read(path)
            fm = C.frontmatter(text)
            self.assertEqual(fm.get('name'), skill)
            self.assertEqual(fm.get('description'), C.frontmatter(TEXTS[skill])['description'], 'pointer description drifted: ' + skill)
            self.assertIn('.claude\\skills\\%s\\SKILL.md' % skill, text, 'pointer target: ' + skill)
            self.assertLess(len(text), 2500, 'pointer holds rules: ' + skill)
            self.assertNotIn('## Decisions', text)
            self.assertEqual(sorted(os.listdir(os.path.dirname(path))), ['SKILL.md'], 'stale copies beside pointer: ' + skill)

    def test_instruction_files(self):
        for rel in ('.claude/CLAUDE.md', 'AGENTS.md', '.codex/AGENTS.md'):
            path = os.path.join(C.HOME, *rel.split('/'))
            if not os.path.exists(path):
                continue
            text = C.read(path)
            self.assertIn('jolesbtxicpskill', text, rel)
            self.assertIn('jole-qualification-orchestrator', text, rel)
            self.assertNotIn('Do not create a second Jole ICP skill', text, rel)


class Regression38(unittest.TestCase):
    def test_no_drift_and_changes_explained(self):
        O = C.load_logic(C.ORCHESTRATOR, 'orchestrator_logic')
        doc = json.loads(C.read(HERE, 'regression_38.json'))
        rows = doc['companies']
        self.assertEqual(len(rows), 38)
        for r in rows:
            with self.subTest(r['name']):
                out = O.run(dict(r['facts'], task='requalify', today=doc['built']))
                d, e = out['dimensions'], r['expect']
                got = {'icp': d['icp']['decision'], 'signal': d['signal']['decision'],
                       'priority': d['signal'].get('priority', C.NOT_EVALUATED) if d['signal']['decision'] != C.NOT_EVALUATED else C.NOT_EVALUATED,
                       'demand_score': d['signal'].get('demand_score'), 'feasibility': d['feasibility']['decision'],
                       'buyer': d['buyer']['decision'], 'dedupe': d['dedupe']['decision'], 'next_action': out['next_action']}
                self.assertEqual(got, e)
                v3 = r['v3']
                v3prio = C.NOT_EVALUATED if v3['priority'].startswith('NOT SCORED') else v3['priority']
                checks = {'icp': e['icp'] != v3['eligibility'], 'priority': e['priority'] != v3prio,
                          'next_action': e['next_action'] not in V3_NEXT[v3['readiness']]}
                for dim, changed in checks.items():
                    if changed:
                        self.assertTrue(r['change_reason'].get(dim, '').strip(), 'Changed %s without a documented reason' % dim)
                    else:
                        self.assertNotIn(dim, r['change_reason'], 'Reason recorded for an unchanged %s' % dim)

    def test_history_kept(self):
        self.assertEqual(len(json.loads(C.read(HERE, 'history_38_v3.json'))), 38)


if __name__ == '__main__':
    unittest.main(verbosity=1)
