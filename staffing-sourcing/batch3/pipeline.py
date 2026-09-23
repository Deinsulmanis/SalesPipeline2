#!/usr/bin/env python3
"""Batch 3 sourcing pipeline: parse reveals, website-qualify, export CSVs."""
from __future__ import annotations
import csv, json, re, ssl, time, urllib.request
from collections import Counter
from pathlib import Path
from qualify_lib import (
    ROOT, RAW, NATIONAL, REJECT_NAME, KEEP_NAME, GENERIC_STAFFING,
    SITE_FIT, SITE_MISMATCH, norm_name, domain_of, load_json,
    classify_company, title_rank, pick_buyer, already_sourced_domains,
    already_sourced_names, corpus_indexes,
)

OUT = ROOT / 'out'
REVEALS = ROOT / 'reveals'
LOOKUPS = ROOT / 'lookups'
QUAL = ROOT / 'qualify'
for p in (OUT, REVEALS, LOOKUPS, QUAL, ROOT / 'people'):
    p.mkdir(parents=True, exist_ok=True)

CREDIT_CAP = 400
BASELINE_CONSUMED = 540  # lead credits before this task
TASK_LIST_PAGES = 3      # mixed company search for already-sourced list

APPROVED_FIELDS = [
    'firstName','lastName','fullName','jobTitle','company','companyWebsite',
    'companyDomain','companyCity','companyState','companySizeCategory',
    'staffingLane','staffingSpecialization','emailStatus','sourceEvidence',
    'apolloVerifiedEmail','buyerTier','emailCatchAll','emailVerificationStatus',
    'apolloPersonId','apolloAccountId','linkedinUrl','source','notes',
    'personCity','personState','estimatedEmployees','sicCodes','naicsCodes',
]

REJECT_FIELDS = [
    'company','firstName','lastName','jobTitle','email','domain','reason',
    'stage','apolloPersonId','notes','lane',
]


def registrable(d: str) -> str:
    d = (d or '').lower().replace('www.', '')
    parts = d.split('.')
    if len(parts) >= 2:
        return parts[-2]
    return d


def related_domains(a: str, b: str) -> bool:
    a = (a or '').lower().replace('www.', '')
    b = (b or '').lower().replace('www.', '')
    if not a or not b:
        return False
    if a == b:
        return True
    ra, rb = registrable(a), registrable(b)
    if ra and rb and (ra == rb or ra in rb or rb in ra):
        return True
    na, nb = ra.replace('-', '').replace('_', ''), rb.replace('-', '').replace('_', '')
    if na and nb and (na == nb or na in nb or nb in na) and min(len(na), len(nb)) >= 6:
        return True
    return False


def email_status_label(verified: bool, catchall: bool) -> tuple[str, str]:
    if not verified:
        return 'unverified', ''
    if catchall:
        return 'verified (catch-all) — admitted per Batch 3 email policy', 'Tier 2'
    return 'verified (NOT catch-all) — Tier 1 send-ready', 'Tier 1'


def size_category(n) -> str:
    try:
        n = int(n or 0)
    except Exception:
        return ''
    if n <= 10:
        return '1-10'
    if n <= 50:
        return '11-50'
    if n <= 200:
        return '51-200'
    return '201+'


def lane_from(name: str, keywords: list[str], existing: str = '') -> str:
    blob = ' '.join([name or ''] + list(keywords or [])).lower()
    if re.search(r'construction|skilled trades|welding|machin|fabricat|mechanical', blob):
        if re.search(r'warehouse|manufactur|light industrial|logistics|distribution', blob):
            return existing or 'A'
        return 'B'
    return existing or 'A'


def specialization_from(keywords: list[str], name: str) -> str:
    blob = ' '.join(list(keywords or []) + [name or '']).lower()
    tags = []
    for k, lab in [
        ('manufactur', 'manufacturing'),
        ('warehouse', 'warehouse'),
        ('logistic', 'logistics'),
        ('distribution', 'distribution'),
        ('construction', 'construction'),
        ('skilled trades', 'skilled trades'),
        ('weld', 'welding'),
        ('light industrial', 'light industrial'),
        ('industrial', 'industrial'),
    ]:
        if k in blob and lab not in tags:
            tags.append(lab)
    return '; '.join(tags[:4])


def load_state():
    p = ROOT / 'state.json'
    if p.exists():
        return json.loads(p.read_text())
    return {
        'credits_spent': TASK_LIST_PAGES,
        'credit_cap': CREDIT_CAP,
        'baseline_consumed': BASELINE_CONSUMED,
        'ledger': [
            {'action': 'mixed_companies_search', 'pages': 3, 'credits': 3,
             'note': 'already-sourced Apollo account list ScaleLab — Staffing — Already Sourced'}
        ],
        'funnel': {
            'profiles_reviewed': 0,
            'companies_pre_reveal_pass': 0,
            'contacts_considered': 0,
            'reveals_attempted': 0,
            'verified_non_catchall': 0,
            'verified_catchall': 0,
            'invalid_email': 0,
            'dup_contacts': 0,
            'dup_companies': 0,
            'national_exclusions': 0,
            'icp_rejects': 0,
            'approved': 0,
            'held': 0,
        },
        'revealed_ids': [],
        'approved_domains': [],
        'approved_emails': [],
    }


def save_state(state):
    (ROOT / 'state.json').write_text(json.dumps(state, indent=2))


def append_jsonl(path: Path, row: dict):
    with path.open('a') as f:
        f.write(json.dumps(row) + '\n')


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()]


def parse_bulk_match(path: Path, state: dict, default_lane='A'):
    data = json.loads(Path(path).read_text())
    credits = int(data.get('credits_consumed') or 0)
    state['credits_spent'] = state.get('credits_spent', 0) + credits
    state['ledger'].append({
        'action': 'people_bulk_match',
        'credits': credits,
        'requested': data.get('total_requested_enrichments'),
        'unique': data.get('unique_enriched_records'),
        'missing': data.get('missing_records'),
        'file': str(path),
        'request_id': data.get('request_id'),
    })
    state['funnel']['reveals_attempted'] += int(data.get('total_requested_enrichments') or 0)
    idx = corpus_indexes()
    corpus_emails = set(x.lower() for x in idx.get('emails', []))
    corpus_domains = set(x.lower() for x in idx.get('all_domains', []))
    sourced_doms = already_sourced_domains() | set(state.get('approved_domains', []))
    sourced_names = already_sourced_names() | {norm_name(x) for x in []}
    approved_emails = set(state.get('approved_emails', [])) | corpus_emails

    for m in data.get('matches') or []:
        pid = m.get('id')
        if pid:
            state.setdefault('revealed_ids', []).append(pid)
        org = m.get('organization') or {}
        email = (m.get('email') or '').strip().lower()
        status = (m.get('email_status') or '').lower()
        catchall = bool(m.get('email_domain_catchall'))
        company = org.get('name') or ''
        website = org.get('website_url') or ''
        cdom = (org.get('primary_domain') or domain_of(website) or '').lower()
        edom = email.split('@')[-1] if '@' in email else ''
        keywords = org.get('keywords') or []
        lane = lane_from(company, keywords)
        notes = []
        reason = None
        stage = 'post_reveal'

        if not email:
            reason = 'no_email_returned'
        elif status not in ('verified',):
            reason = f'email_status_{status or "unknown"}'
        elif email in approved_emails:
            reason = 'duplicate_email'
            state['funnel']['dup_contacts'] += 1
        elif cdom and cdom in sourced_doms and cdom not in state.get('approved_domains', []):
            # already in live corpus / already-sourced, not this batch
            reason = 'duplicate_company_domain'
            state['funnel']['dup_companies'] += 1
        elif edom and not related_domains(edom, cdom):
            reason = 'email_domain_mismatch'
            notes.append(f'email_domain={edom} company_domain={cdom}')
        if NATIONAL.search(company):
            reason = reason or 'national_exclusion'
            state['funnel']['national_exclusions'] += 1

        row_base = {
            'company': company,
            'firstName': m.get('first_name') or '',
            'lastName': m.get('last_name') or '',
            'jobTitle': m.get('title') or '',
            'email': email,
            'domain': cdom,
            'apolloPersonId': pid or '',
            'lane': lane,
            'notes': '; '.join(notes),
        }

        if reason:
            if reason.startswith('email_status') or reason == 'no_email_returned':
                state['funnel']['invalid_email'] += 1
            if reason == 'email_domain_mismatch':
                state['funnel']['held'] += 1
                row_base['reason'] = reason
                row_base['stage'] = 'held_domain_mismatch'
                append_jsonl(OUT / 'held.jsonl', row_base)
            else:
                row_base['reason'] = reason
                row_base['stage'] = stage
                append_jsonl(OUT / 'rejected.jsonl', row_base)
            continue

        verified = status == 'verified'
        elabel, tier = email_status_label(verified, catchall)
        if catchall:
            state['funnel']['verified_catchall'] += 1
        else:
            state['funnel']['verified_non_catchall'] += 1
        if edom != cdom:
            notes.append(f'related_email_domain={edom}')

        approved = {
            'firstName': m.get('first_name') or '',
            'lastName': m.get('last_name') or '',
            'fullName': m.get('name') or '',
            'jobTitle': m.get('title') or '',
            'company': company,
            'companyWebsite': website,
            'companyDomain': cdom,
            'companyCity': org.get('city') or '',
            'companyState': org.get('state') or '',
            'companySizeCategory': size_category(org.get('estimated_num_employees')),
            'staffingLane': lane,
            'staffingSpecialization': specialization_from(keywords, company),
            'emailStatus': elabel,
            'sourceEvidence': f"Apollo people search + website ICP; keywords={','.join(keywords[:8])}",
            'apolloVerifiedEmail': email,
            'buyerTier': tier,
            'emailCatchAll': 'true' if catchall else 'false',
            'emailVerificationStatus': status,
            'apolloPersonId': pid or '',
            'apolloAccountId': org.get('id') or '',
            'linkedinUrl': m.get('linkedin_url') or '',
            'source': 'apollo_batch3',
            'notes': '; '.join(notes),
            'personCity': m.get('city') or '',
            'personState': m.get('state') or '',
            'estimatedEmployees': org.get('estimated_num_employees') or '',
            'sicCodes': ','.join(org.get('sic_codes') or []),
            'naicsCodes': ','.join(org.get('naics_codes') or []),
        }
        append_jsonl(OUT / 'approved.jsonl', approved)
        state['funnel']['approved'] += 1
        state.setdefault('approved_domains', []).append(cdom)
        state.setdefault('approved_emails', []).append(email)
        if edom:
            state['approved_domains'].append(edom)
    save_state(state)
    Path(REVEALS / Path(path).name).write_text(Path(path).read_text())
    return credits


def fetch_site(url: str, timeout=12) -> dict:
    out = {'url': url, 'final_url': url, 'error': '', 'text': '', 'site_fit': False, 'site_mismatch': False}
    if not url:
        out['error'] = 'no_url'
        return out
    if not url.startswith('http'):
        url = 'http://' + url
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 ScaleLabBatch3/1.0'})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
            raw = r.read(120000)
            out['final_url'] = r.geturl()
            out['text'] = raw.decode('utf-8', 'ignore')
    except Exception as e:
        try:
            ctx2 = ssl._create_unverified_context()
            https = url.replace('http://', 'https://')
            req2 = urllib.request.Request(https, headers={'User-Agent': 'Mozilla/5.0 ScaleLabBatch3/1.0'})
            with urllib.request.urlopen(req2, timeout=timeout, context=ctx2) as r:
                raw = r.read(120000)
                out['final_url'] = r.geturl()
                out['text'] = raw.decode('utf-8', 'ignore')
                out['error'] = f'ssl_unverified:{e}'
        except Exception as e2:
            out['error'] = str(e2)
            return out
    text = re.sub(r'<script[\s\S]*?</script>', ' ', out['text'], flags=re.I)
    text = re.sub(r'<style[\s\S]*?</style>', ' ', text, flags=re.I)
    text = re.sub(r'<[^>]+>', ' ', text)
    text = re.sub(r'\s+', ' ', text)
    out['text'] = text[:12000]
    out['site_fit'] = bool(SITE_FIT.search(text))
    out['site_mismatch'] = bool(SITE_MISMATCH.search(text)) and not out['site_fit']
    return out


def website_qualify(rows: list[dict]) -> list[dict]:
    results = []
    for row in rows:
        site = fetch_site(row.get('website') or row.get('domain') or '')
        klass = row.get('class') or classify_company(row.get('company') or '')
        decision = 'reject'
        reason = ''
        if site['site_mismatch'] and not site['site_fit']:
            decision, reason = 'reject', 'site_mismatch'
        elif site['site_fit']:
            decision, reason = 'pass', 'site_fit'
        elif klass == 'keep_name':
            decision, reason = 'pass', 'keep_name_plus_search_origin' if site['error'] or not site['text'] else 'keep_name'
        elif klass == 'generic_staffing' and site['text'] and SITE_FIT.search(site['text'] + ' ' + (row.get('company') or '')):
            decision, reason = 'pass', 'generic_name_site_fit'
        elif not site['text']:
            if klass == 'keep_name':
                decision, reason = 'pass', 'keep_name_fetch_failed'
            else:
                decision, reason = 'hold', 'website_unreadable'
        else:
            decision, reason = 'reject', 'no_industrial_evidence'
        rec = {**row, **{k: site[k] for k in ('final_url','error','site_fit','site_mismatch')},
               'snippet': (site.get('text') or '')[:280], 'decision': decision, 'reason': reason}
        results.append(rec)
        time.sleep(0.15)
    (QUAL / f'round-{int(time.time())}.json').write_text(json.dumps(results, indent=2))
    return results


def export_csvs(state: dict):
    approved = read_jsonl(OUT / 'approved.jsonl')
    rejected = read_jsonl(OUT / 'rejected.jsonl')
    held = read_jsonl(OUT / 'held.jsonl')
    def write(path, rows, fields):
        with path.open('w', newline='') as f:
            w = csv.DictWriter(f, fieldnames=fields, extrasaction='ignore')
            w.writeheader()
            for r in rows:
                w.writerow({k: r.get(k, '') for k in fields})
    write(OUT / 'batch3-approved-candidates.csv', approved, APPROVED_FIELDS)
    write(OUT / 'batch3-rejected-held.csv',
          [{**r, 'stage': r.get('stage') or 'rejected'} for r in rejected] +
          [{**r, 'stage': r.get('stage') or 'held'} for r in held],
          REJECT_FIELDS)
    ledger = state.get('ledger') or []
    with (OUT / 'batch3-credit-ledger.csv').open('w', newline='') as f:
        fields = ['action','credits','requested','unique','missing','pages','note','file','request_id']
        w = csv.DictWriter(f, fieldnames=fields, extrasaction='ignore')
        w.writeheader()
        for row in ledger:
            w.writerow({k: row.get(k, '') for k in fields})
    return len(approved), len(rejected), len(held)


if __name__ == '__main__':
    import sys
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'status'
    state = load_state()
    if cmd == 'parse-reveal':
        parse_bulk_match(Path(sys.argv[2]), state)
        print(json.dumps({'credits_spent': state['credits_spent'], 'funnel': state['funnel']}, indent=2))
    elif cmd == 'export':
        n = export_csvs(state)
        print(n)
    else:
        print(json.dumps({'credits_spent': state['credits_spent'], 'funnel': state['funnel']}, indent=2))
