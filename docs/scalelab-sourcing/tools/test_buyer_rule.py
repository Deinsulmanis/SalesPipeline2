"""Tests for the one buyer rule in buyer_pick.py (owner decision 2026-11-24).

Run: python3 -I -m unittest docs/scalelab-sourcing/tools/test_buyer_rule.py   (or: python3 -I test_buyer_rule.py)
"""
import os
import re
import sys
import unittest

TOOLS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TOOLS)
import buyer_pick as bp  # noqa: E402


class TopTitleWins(unittest.TestCase):
    def test_batch_titles_2026_11_24(self):
        # the five titles dropped by the old double exclusion check
        for title in ('President and Managing Director', 'President & CEO, Executive Recruiter',
                      'President/CEO | Recruiting Consultant', 'Owner/CFO', 'Owner/Chief Financial Officer'):
            self.assertEqual(bp.tier(title)[0], 1, title)

    def test_top_titles(self):
        for title in ('Owner', 'Co-Owner', 'Founder', 'Co-Founder', 'Proprietor', 'President', 'CEO', 'Chief Executive Officer',
                      'Recruiter and Co-Founder', 'Owner & Payroll Manager', 'CEO / Managing Director'):
            self.assertEqual(bp.tier(title)[0], 1, title)

    def test_not_top(self):
        for title in ('Vice President', 'Vice-President', 'Product Owner', 'Process Owner'):
            self.assertNotEqual((bp.tier(title) or (None,))[0], 1, title)
        for title in ('Former President', 'Retired Owner', 'Past President', 'HOA Board President', 'President Emeritus'):
            self.assertIsNone(bp.tier(title), title)


class TierTwo(unittest.TestCase):
    def test_coo_variants(self):
        for title in ('COO', 'Chief Operating Officer', 'Chief Operations Officer'):
            self.assertEqual(bp.tier(title)[0], 2, title)

    def test_commercial(self):
        for title in ('Chief Revenue Officer', 'VP of Sales', 'Vice President, Business Development', 'Vice President', 'Vice-President', 'Partner'):
            self.assertEqual(bp.tier(title)[0], 2, title)


class TierThree(unittest.TestCase):
    def test_titles(self):
        for title in ('General Manager', 'Director of Operations', 'Operations Director', 'Director of Sales',
                      'Director of Business Development', 'Sales Director', 'Head of Sales', 'Head of Growth',
                      'Head of Business Development', 'Operations Manager', 'Branch Manager'):
            self.assertEqual(bp.tier(title)[0], 3, title)

    def test_pick_condition(self):
        self.assertTrue(bp.can_pick(3, False, 150))
        self.assertTrue(bp.can_pick(3, False, '51-200'))
        self.assertFalse(bp.can_pick(3, True, 50), 'a Tier 1/2 candidate exists')
        self.assertFalse(bp.can_pick(3, False, 201))
        self.assertFalse(bp.can_pick(3, False, '201-500'))
        self.assertFalse(bp.can_pick(3, False, None), 'unknown size fails closed')
        self.assertTrue(bp.can_pick(1, True, None))
        self.assertTrue(bp.can_pick(2, False, 5000))
        self.assertFalse(bp.can_pick(None, False, 10))

    def test_branch_exception_any_size(self):
        self.assertTrue(bp.branch_exception('Regional Manager', 3))
        self.assertTrue(bp.branch_exception('Branch Manager', 17))
        self.assertFalse(bp.branch_exception('Branch Manager', 2))
        self.assertFalse(bp.branch_exception('Assistant Branch Manager', 9))
        self.assertFalse(bp.branch_exception('Branch Recruiter', 9))


class StillExcluded(unittest.TestCase):
    def test_exclusion_list(self):
        for title in ('Managing Director', 'Recruiter', 'Executive Recruiter', 'CFO', 'Controller', 'HR Manager',
                      'Vice President of Human Resources', 'Payroll Manager', 'IT Director', 'Talent Acquisition Manager',
                      'Office Manager', 'Assistant Branch Manager', 'HR Operations Manager', 'Branch Administrator',
                      'Board Member', 'Advisor', 'Compliance Director', 'Account Manager', 'Marketing Manager',
                      'Sourcing Specialist', 'Talent Partner'):
            self.assertIsNone(bp.tier(title), title)


class NoCopies(unittest.TestCase):
    def test_tools_import_the_rule(self):
        """No tool keeps its own exclusion pass or title lists: they call buyer_pick."""
        for name in ('contact_qc.py', 'second_buyer_pick.py', 'enrich_lists.py', 'second_buyer_pool.py', 'second_buyer_filter.py',
                     'enrich_ingest.py', 'owner_gap.py'):
            with open(os.path.join(TOOLS, name)) as fh:
                src = fh.read()
            self.assertNotRegex(src, r'bp\.NEVER|OPS_ONLY|BRANCH_BUYER', name)
            self.assertIsNone(re.search(r'^NEVER\s*=', src, re.M), name)


if __name__ == '__main__':
    unittest.main()
