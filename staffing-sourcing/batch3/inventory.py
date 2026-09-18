#!/usr/bin/env python3
"""Rebuild remaining Batch 3 candidate pool from people dumps + qualify rounds."""
from __future__ import annotations
import json, re
from collections import Counter, defaultdict
from pathlib import Path
from qualify_lib import (
    ROOT, RAW, KEEP_NAME, GENERIC_STAFFING, classify_company, title_rank,
    pick_buyer, already_sourced_domains, already_sourced_names, corpus_indexes,
    norm_name, domain_of,
)
from pipeline import load_state, read_jsonl, related_domains

PEOPLE = ROOT / 'people'
QUAL = ROOT / 'qualify'
OUT = ROOT / 'out'
STAFFING_WORD = re.compile(r'staffing|personnel|workforce|employment|temp(?:s|orary)?|\blabor\b|tradesmen|recruit', re.I)
CONTRACTORISH = re.compile(r'\b(construction|contractor|builders?|roofing|electrical|plumbing|hvac)\b', re.I)


def load_people():
    by_co = defaultdict(list)
    files = 0
    people_n = 0
    for p in sorted(PEOPLE.glob('*.json')):
        files += 1
        data = json.loads(p.read_text())
        for person in data.get('people') or []:
            people_n += 1
            org = person.get('organization') or {}
            name = org.get('name') or ''
            if not name:
                continue
            person['_src'] = p.name
            by_co[name].append(person)
    return by_co, files, people_n


def collect_qualify():
    by_co = {}
    for p in QUAL.glob('*.json'):
        try:
            rows = json.loads(p.read_text())
        except Exception:
            continue
        if not isinstance(rows, list):
            continue
        for r in rows:
            if not isinstance(r, dict):
                continue
            co = r.get('company')
            if not co:
                continue
            prev = by_co.get(co)
            # prefer later files / pass decisions
            if prev is None or r.get('decision') == 'pass' or (r.get('site_fit') and not prev.get('site_fit')):
                by_co[co] = {**r, '_qual_file': p.name}
    return by_co


def likely_contractor(name: str, klass: str) -> bool:
    if klass != 'keep_name':
        return False
    if STAFFING_WORD.search(name or ''):
        return False
    return bool(CONTRACTORISH.search(name or ''))


def main():
    state = load_state()
    idx = corpus_indexes()
    sourced_names = already_sourced_names() | {norm_name(c) for c in idx.get('companies') or []}
    sourced_doms = already_sourced_domains() | set(x.lower() for x in idx.get('all_domains') or []) | set(state.get('approved_domains') or [])
    revealed = set(state.get('revealed_ids') or [])
    approved = read_jsonl(OUT / 'approved.jsonl')
    held = read_jsonl(OUT / 'held.jsonl')
    rejected = read_jsonl(OUT / 'rejected.jsonl')
    approved_names = {norm_name(r.get('company')) for r in approved}
    held_ids = {r.get('apolloPersonId') for r in held}
    rejected_ids = {r.get('apolloPersonId') for r in rejected}

    by_co, nfiles, npeople = load_people()
    qual = collect_qualify()

    remaining_keep = []
    remaining_generic_pass = []
    remaining_generic_need_site = []
    remaining_generic_no_domain = []
    remaining_unclear = []
    skip_counts = Counter()

    for company, people in by_co.items():
        klass = classify_company(company)
        buyer = pick_buyer([p for p in people if p.get('has_email')] or people)
        pid = buyer.get('id')
        q = qual.get(company) or {}
        domain = (q.get('domain') or domain_of(q.get('website') or '') or '').lower().replace('www.', '')
        nn = norm_name(company)

        if pid in revealed or pid in held_ids or pid in rejected_ids:
            skip_counts['already_revealed_or_dispositioned'] += 1
            continue
        if nn in sourced_names or nn in approved_names:
            skip_counts['dup_company_name'] += 1
            continue
        if domain and domain in sourced_doms:
            skip_counts['dup_company_domain'] += 1
            continue
        if klass == 'national':
            skip_counts['national'] += 1
            continue
        if klass == 'icp_reject_name':
            skip_counts['icp_reject_name'] += 1
            continue
        if likely_contractor(company, klass):
            skip_counts['contractor_not_staffing'] += 1
            continue
        if title_rank(buyer.get('title') or '') > 9:
            skip_counts['weak_title'] += 1
            continue

        row = {
            'company': company,
            'class': klass,
            'person_id': pid,
            'first_name': buyer.get('first_name') or '',
            'title': buyer.get('title') or '',
            'title_rank': title_rank(buyer.get('title') or ''),
            'n_people': len(people),
            'domain': domain,
            'website': q.get('website') or (f'http://www.{domain}' if domain else ''),
            'qual_decision': q.get('decision') or '',
            'qual_reason': q.get('reason') or '',
            'site_fit': bool(q.get('site_fit')),
            'src': buyer.get('_src') or '',
        }
        if klass == 'keep_name':
            remaining_keep.append(row)
        elif klass == 'generic_staffing':
            if q.get('decision') == 'pass' or q.get('site_fit'):
                remaining_generic_pass.append(row)
            elif q.get('decision') in ('reject',):
                skip_counts['generic_already_rejected'] += 1
            elif domain:
                remaining_generic_need_site.append(row)
            else:
                remaining_generic_no_domain.append(row)
        else:
            remaining_unclear.append(row)

    remaining_keep.sort(key=lambda r: (r['title_rank'], r['company']))
    remaining_generic_pass.sort(key=lambda r: (r['title_rank'], r['company']))
    remaining_generic_need_site.sort(key=lambda r: (r['title_rank'], r['company']))

    summary = {
        'people_files': nfiles,
        'people_rows': npeople,
        'unique_companies': len(by_co),
        'qualify_companies': len(qual),
        'skip_counts': dict(skip_counts),
        'remaining_keep_name': len(remaining_keep),
        'remaining_generic_already_pass': len(remaining_generic_pass),
        'remaining_generic_need_site': len(remaining_generic_need_site),
        'remaining_generic_no_domain': len(remaining_generic_no_domain),
        'remaining_unclear': len(remaining_unclear),
        'approved': len(approved),
        'held': len(held),
        'rejected': len(rejected),
        'credits_spent': state.get('credits_spent'),
    }
    out = {
        'summary': summary,
        'keep_name': remaining_keep,
        'generic_pass': remaining_generic_pass,
        'generic_need_site': remaining_generic_need_site,
        'generic_no_domain': remaining_generic_no_domain[:400],
        'unclear': remaining_unclear[:80],
    }
    (RAW / 'remaining-inventory.json').write_text(json.dumps(out, indent=2))
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
