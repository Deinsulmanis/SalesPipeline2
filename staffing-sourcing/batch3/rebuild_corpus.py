#!/usr/bin/env python3
"""Rebuild corpus indexes from the live staffing export (327+) plus Batch 3 state."""
from __future__ import annotations
import json
from pathlib import Path
from qualify_lib import ROOT, RAW, domain_of, load_json
from pipeline import load_state

LIVE = Path('/tmp/staffing-live-corpus.json')


def main():
    live = load_json(LIVE)
    leads = live.get('leads') or []
    emails, website_domains, email_domains, companies = [], [], [], []
    for lead in leads:
        email = (lead.get('email') or '').strip().lower()
        if email:
            emails.append(email)
            if '@' in email:
                email_domains.append(email.split('@')[-1].replace('www.', ''))
        company = (lead.get('company') or '').strip().lower()
        if company:
            companies.append(company)
        d = domain_of(lead.get('website') or '')
        if d:
            website_domains.append(d)
    all_domains = sorted(set(website_domains) | set(email_domains))
    idx = {
        'emails': sorted(set(emails)),
        'website_domains': sorted(set(website_domains)),
        'email_domains': sorted(set(email_domains)),
        'all_domains': all_domains,
        'companies': sorted(set(companies)),
        'live_total': live.get('total'),
        'live_queued': live.get('queued'),
        'live_sent': live.get('sent'),
        'dental_total': live.get('dentalTotal'),
        'fetched_at': live.get('fetchedAt'),
    }
    state = load_state()
    for d in state.get('approved_domains') or []:
        if d and d not in idx['all_domains']:
            idx['all_domains'].append(d)
    idx['all_domains'] = sorted(set(idx['all_domains']))
    (RAW / 'live-staffing-corpus.json').write_text(json.dumps({
        'fetchedAt': live.get('fetchedAt'),
        'total': live.get('total'),
        'queued': live.get('queued'),
        'sent': live.get('sent'),
        'dentalTotal': live.get('dentalTotal'),
        'totalUnfiltered': live.get('totalUnfiltered'),
        'counts': live.get('counts'),
        'leadCount': len(leads),
    }, indent=2))
    (RAW / 'corpus-indexes.json').write_text(json.dumps(idx, indent=2))
    print(json.dumps({
        'emails': len(idx['emails']),
        'companies': len(idx['companies']),
        'website_domains': len(idx['website_domains']),
        'email_domains': len(idx['email_domains']),
        'all_domains': len(idx['all_domains']),
        'live_total': idx['live_total'],
        'live_queued': idx['live_queued'],
        'live_sent': idx['live_sent'],
        'dental_total': idx['dental_total'],
    }, indent=2))


if __name__ == '__main__':
    main()
