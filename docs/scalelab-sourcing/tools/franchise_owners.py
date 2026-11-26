"""Franchise owner sourcing, step 1 (owner decision 2026-11-25): classify GetLeads search_contacts exports by
franchise_rule.py, drop franchisor HQ / corporate / other-business rows, and dedupe on the franchise identity key.

Usage: python3 -I franchise_owners.py <run> [--prod <run>/prod_matches.json]

Inputs:  <run>/raw/<brand>.csv  (GetLeads export columns). Personal emails and phone columns are never read into outputs.
         <run>/prod_matches.json (optional) {"emails": [...], "suppressed": [...], "owner_keys": [...]} from production.
Writes:  <run>/owners.json         every row with status, reason, brand, owner_key, territory
         <run>/owner_counts.json   per-brand counts by status
"""
import collections
import csv
import glob
import json
import os
import sys

TOOLS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TOOLS)
import franchise_rule as fr  # noqa: E402

KEEP = ('first_name', 'last_name', 'work_email', 'email_status', 'current_title', 'company_name', 'current_employer',
        'company_domain', 'contact_city', 'contact_state', 'contact_country', 'linkedin_url', 'linkedin_headline')


def main():
    run = sys.argv[1]
    prod_path = sys.argv[sys.argv.index('--prod') + 1] if '--prod' in sys.argv else os.path.join(run, 'prod_matches.json')
    prod = json.load(open(prod_path)) if os.path.exists(prod_path) else {}
    prod_emails = set(prod.get('emails', []))
    suppressed = set(prod.get('suppressed', []))
    prod_owner_keys = set(prod.get('owner_keys', []))
    rows, seen_email = [], set()
    for path in sorted(glob.glob(os.path.join(run, 'raw', '*.csv'))):
        for x in csv.DictReader(open(path)):
            r = {k: (x.get(k) or '').strip() for k in KEEP}
            r['work_email'] = r['work_email'].lower()
            r['source_file'] = os.path.basename(path)
            if r['work_email'] in seen_email:
                continue  # the same person exported twice (overlapping brand queries)
            seen_email.add(r['work_email'])
            brand = fr.brand_of(r['company_name'], r['current_employer'], r['linkedin_headline'], email=r['work_email'])
            status, reason = fr.classify_contact({'title': r['current_title'], 'headline': r['linkedin_headline'],
                                                  'employer': r['company_name'] or r['current_employer'],
                                                  'city': r['contact_city'], 'state': r['contact_state'],
                                                  'email': r['work_email']}, brand)
            if status == 'OWNER' and r['contact_country'] and r['contact_country'] != 'United States':
                status, reason = 'DROP_NON_US', 'contact is outside the US'
            if status == 'OWNER' and r['email_status'] != 'VALID':
                status, reason = 'DROP_EMAIL_NOT_VALID', 'export email is not VALID'
            r.update(brand=brand, status=status, reason=reason,
                     owner_key=fr.owner_key(brand or 'none', r['first_name'], r['last_name']),
                     territory=fr.territory_key(brand or 'none', r['contact_city'], r['contact_state']),
                     rank=fr.title_rank(r['current_title']))
            rows.append(r)
    # production dedupe (exact email, suppression, an owner already in production under the same brand)
    for r in rows:
        if r['status'] != 'OWNER':
            continue
        if r['work_email'] in suppressed:
            r.update(status='DROP_SUPPRESSED', reason='address is on the suppression list')
        elif r['work_email'] in prod_emails:
            r.update(status='DROP_IN_PRODUCTION', reason='address already in the lead database')
        elif r['owner_key'] in prod_owner_keys:
            r.update(status='DROP_IN_PRODUCTION', reason='this owner is already a lead under the same brand')
    # one contact per owner, then one owner per brand + territory (best title first)
    owners = sorted([r for r in rows if r['status'] == 'OWNER'], key=lambda r: (r['rank'], r['source_file'], r['work_email']))
    by_owner, by_territory = set(), set()
    for r in owners:
        if r['owner_key'] in by_owner:
            r.update(status='DROP_SAME_OWNER', reason='one contact per owner (owner already kept for another office)')
            continue
        by_owner.add(r['owner_key'])
        # Express owners are deduped per office after office mapping (express_offices.py), not by home city.
        if r['brand'] != 'express' and r['contact_city'] and r['territory'] in by_territory:
            r.update(status='HOLD_SAME_OFFICE', reason='another owner of this brand + territory is already kept')
            continue
        by_territory.add(r['territory'])
    counts = collections.defaultdict(collections.Counter)
    for r in rows:
        counts[r['brand'] or 'not_brand'][r['status']] += 1
    json.dump(rows, open(os.path.join(run, 'owners.json'), 'w'), indent=1)
    json.dump({b: dict(c) for b, c in counts.items()}, open(os.path.join(run, 'owner_counts.json'), 'w'), indent=1)
    for b, c in sorted(counts.items()):
        print(b, sum(c.values()), dict(c))


if __name__ == '__main__':
    main()
