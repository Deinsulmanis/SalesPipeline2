"""Tests for the one franchise / chain rule in franchise_rule.py (owner decision 2026-11-25).

Run: python3 -I -m unittest docs/scalelab-sourcing/tools/test_franchise_rule.py
"""
import os
import re
import sys
import unittest

TOOLS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TOOLS)
import franchise_rule as fr  # noqa: E402


def row(title, headline='', employer='Express Employment Professionals', city='Canton', state='Ohio', email='a.b@expresspros.com'):
    return {'title': title, 'headline': headline, 'employer': employer, 'city': city, 'state': state, 'email': email}


class Companies(unittest.TestCase):
    def test_franchise_brands_are_eligible(self):
        for name in ('Express Employment Professionals - Canton', 'PrideStaff', 'Spherion Staffing Mankato', 'Snelling Staffing',
                     'Labor Finders', 'HireQuest Direct', 'Trojan Labor', 'Link Staffing', 'Remedy Intelligent Staffing'):
            self.assertEqual(fr.classify_company(name)[0], 'FRANCHISE', name)
            self.assertFalse(fr.is_excluded_chain(name), name)

    def test_corporate_chains_stay_excluded(self):
        for name in ('PeopleReady', 'Aerotek', 'Kelly Services', 'Adecco', 'Manpower', 'Staffmark', 'Robert Half', 'Randstad'):
            self.assertEqual(fr.classify_company(name)[0], 'CORPORATE_CHAIN', name)
            self.assertTrue(fr.is_excluded_chain(name), name)

    def test_lookalikes_are_not_brands(self):
        for name in ('WorkLink Staffing', 'Snelling Homes', 'Express Logistics', 'Tradeco Staffing', 'Corbin Manpower Solutions',
                     'Hudson IT and Manpower'):
            self.assertIsNone(fr.classify_company(name)[0], name)

    def test_chain_block_for_domain_tools(self):
        self.assertEqual(fr.chain_block('Express Employment Professionals', 'expresspros.com'), 'franchise_shared_domain')
        self.assertEqual(fr.chain_block('Remedy Intelligent Staffing', 'remedystaffing.com'), 'franchise_shared_domain', 'the brand site is not a location')
        self.assertIsNone(fr.chain_block('Spherion Mid Ohio', 'spherionohio.com', chain_p=0.9), 'own-domain franchise location is not blocked')
        self.assertEqual(fr.chain_block('PeopleReady', 'peopleready.com'), 'corporate_chain')
        self.assertEqual(fr.chain_block('Express Employment Professionals Franchising', 'expressfranchising.com'), 'franchisor_hq')
        self.assertEqual(fr.chain_block('Manpower San Diego', 'manpowersandiego.com'), 'corporate_chain')
        self.assertEqual(fr.chain_block('Some Agency', 'someagency.com', chain_p=0.7), 'chain_signal')
        self.assertIsNone(fr.chain_block('Some Agency', 'someagency.com', chain_p=0.2))


class Contacts(unittest.TestCase):
    def test_owners(self):
        for title, head in (('Owner', ''), ('Franchise Owner', ''), ('Co-Owner', ''), ('Owner/Corporate Secretary/CFO', ''),
                            ('President', 'President at Express Employment Professionals of Marlton, NJ'),
                            ('President - Baltimore, MD', ''), ('Franchisee/Owner', '')):
            self.assertEqual(fr.classify_contact(row(title, head), 'express')[0], 'OWNER', (title, head))

    def test_franchisor_hq_never_contacted(self):
        self.assertEqual(fr.classify_contact(row('President', 'President at Express Employment International', city='Sanford', state='Florida'), 'express')[0], 'DROP_HQ')
        self.assertEqual(fr.classify_contact(row('Business Owner', 'Business Owner at Express Employment Professionals International Headquarters'), 'express')[0], 'DROP_HQ')
        self.assertEqual(fr.classify_contact(row('Owner', '', employer='Express Employment International', city='Oklahoma City', state='Oklahoma'), 'express')[0], 'DROP_HQ')
        self.assertEqual(fr.classify_contact(row('President', '', city='Oklahoma City', state='Oklahoma'), 'express')[0], 'DROP_HQ')
        self.assertEqual(fr.classify_contact(row('Owner', '', city='Oklahoma City', state='Oklahoma'), 'express')[0], 'OWNER', 'a local office in the HQ city is a franchisee')
        self.assertEqual(fr.classify_contact(row('Owner', 'Owner, Labor Finders International, Inc.', employer='Labor Finders',
                                                 city='Palm Beach Gardens', state='Florida', email='x@laborfinders.com'), 'labor_finders')[0], 'DROP_HQ')

    def test_corporate_roles_dropped(self):
        for title in ('Vice-President; Franchise Sales & Market Development', 'Senior Vice-President', 'Interim President', 'Past President'):
            self.assertEqual(fr.classify_contact(row(title), 'express')[0], 'DROP_CORPORATE_ROLE', title)

    def test_unverified_president_and_other_business_held(self):
        self.assertEqual(fr.classify_contact(row('President', ''), 'express')[0], 'HOLD_PRESIDENT_UNVERIFIED')
        self.assertEqual(fr.classify_contact(row('Owner', 'President & CEO at Digital Instruments, Inc.'), 'express')[0], 'HOLD_OTHER_BUSINESS')

    def test_not_brand(self):
        self.assertEqual(fr.classify_contact(row('President', employer='Snelling Homes', email='x@snellinghomes.com'), 'snelling')[0], 'DROP_NOT_BRAND')


class Identity(unittest.TestCase):
    def test_keys(self):
        self.assertEqual(fr.owner_key('express', 'Dana', "O'Neil"), 'express|dana|oneil')
        self.assertEqual(fr.territory_key('express', 'Canton', 'OH'), 'express|canton|oh')
        self.assertEqual(fr.brand_of('', email='someone@expresspros.com'), 'express')


class NoCopies(unittest.TestCase):
    def test_tools_import_the_rule(self):
        """No tool keeps its own franchise / chain list: they call franchise_rule."""
        for name in ('discover_merge.py', 'enrich_lists.py', 'enrich_lists4.py', 'second_buyer_pool.py', 'icp_decide.py',
                     'franchise_owners.py', 'franchise_select.py', 'express_offices.py'):
            with open(os.path.join(TOOLS, name)) as fh:
                src = fh.read()
            self.assertIn('import franchise_rule as fr', src, name)
            self.assertIsNone(re.search(r'^FRANCHISE\s*=|dm\.FRANCHISE|peopleready\|', src, re.M), name)


if __name__ == '__main__':
    unittest.main()
