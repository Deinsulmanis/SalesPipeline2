#!/usr/bin/env python3
"""Guess domains from remaining company names and website-qualify without Apollo credits."""
from __future__ import annotations
import json, re, ssl, time, urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from qualify_lib import ROOT, RAW, SITE_FIT, SITE_MISMATCH, GENERIC_STAFFING, classify_company, domain_of

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
STOP = re.compile(r'\b(llc|inc|incorporated|ltd|corp|corporation|co|group|the|formerly|dba|of|and|&)\b', re.I)
CTX = ssl._create_unverified_context()


def slug_candidates(name: str) -> list[str]:
    n = (name or '').lower()
    n = n.split('(')[0].split('/')[0].split('|')[0]
    n = re.sub(r'[^a-z0-9]+', ' ', n)
    n = STOP.sub(' ', n)
    n = re.sub(r'\s+', ' ', n).strip()
    if not n:
        return []
    compact = n.replace(' ', '')
    dashed = n.replace(' ', '-')
    parts = n.split()
    cands = [compact, dashed]
    if 'staffing' in parts:
        # first token + staffing
        cands.append(parts[0] + 'staffing')
        if len(parts) >= 2:
            cands.append(''.join(parts[:2]))
    # unique preserve order
    out = []
    for c in cands:
        if 4 <= len(c) <= 40 and c not in out:
            out.append(c)
    tlds = ['.com', '.net', '.us', '.org']
    domains = []
    for c in out[:3]:
        for t in tlds:
            domains.append(c + t)
    return domains[:8]


def fetch(url: str, timeout=10) -> dict:
    out = {'url': url, 'final_url': url, 'error': '', 'text': '', 'site_fit': False, 'site_mismatch': False}
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
            raw = r.read(100000)
            out['final_url'] = r.geturl()
            out['text'] = raw.decode('utf-8', 'ignore')
    except Exception as e:
        out['error'] = str(e)
        return out
    text = re.sub(r'<script[\s\S]*?</script>', ' ', out['text'], flags=re.I)
    text = re.sub(r'<style[\s\S]*?</style>', ' ', text, flags=re.I)
    text = re.sub(r'<[^>]+>', ' ', text)
    text = re.sub(r'\s+', ' ', text)
    out['text'] = text[:8000]
    out['site_fit'] = bool(SITE_FIT.search(text))
    out['site_mismatch'] = bool(SITE_MISMATCH.search(text)) and not out['site_fit']
    return out


def try_company(row: dict) -> dict:
    domains = slug_candidates(row['company'])
    best = {**row, 'decision': 'reject', 'reason': 'no_guessed_domain_fit', 'tried': domains}
    for d in domains:
        for scheme in ('https://', 'http://www.', 'https://www.'):
            site = fetch(scheme + d)
            if site['site_mismatch']:
                best = {**row, **{k: site[k] for k in ('final_url','error','site_fit','site_mismatch')},
                        'domain': d, 'website': scheme + d, 'decision': 'reject', 'reason': 'site_mismatch',
                        'snippet': (site.get('text') or '')[:240], 'tried': domains}
                return best
            if site['site_fit']:
                return {**row, **{k: site[k] for k in ('final_url','error','site_fit','site_mismatch')},
                        'domain': domain_of(site['final_url']) or d, 'website': site['final_url'],
                        'decision': 'pass', 'reason': 'guessed_domain_site_fit',
                        'snippet': (site.get('text') or '')[:240], 'tried': domains}
    return best


def main():
    inv = json.loads((RAW / 'remaining-inventory.json').read_text())
    rows = inv.get('generic_no_domain') or []
    # cap this pass for runtime; prioritize owner/founder titles already sorted
    rows = rows[:180]
    results = []
    with ThreadPoolExecutor(max_workers=12) as ex:
        futs = {ex.submit(try_company, r): r for r in rows}
        for i, fut in enumerate(as_completed(futs), 1):
            rec = fut.result()
            results.append(rec)
            if i % 20 == 0:
                print(f'  {i}/{len(rows)} done; pass={sum(1 for x in results if x["decision"]=="pass")}')
    results.sort(key=lambda r: (0 if r['decision']=='pass' else 1, r.get('title_rank', 99), r.get('company','')))
    (ROOT / 'qualify' / 'guessed-domains.json').write_text(json.dumps(results, indent=2))
    passed = [r for r in results if r['decision']=='pass']
    print(json.dumps({
        'attempted': len(results),
        'passed': len(passed),
        'pass_companies': [(p['company'], p.get('domain'), p.get('person_id')) for p in passed],
    }, indent=2))


if __name__ == '__main__':
    main()
