#!/usr/bin/env python3
"""Batch 3 staffing ICP / duplicate / national filters reconstructed from
Batch 1-2 QA scripts, live CRM corpus, and the Apollo 'Already Sourced' list.
"""
from __future__ import annotations
import json, re, urllib.parse
from pathlib import Path

ROOT = Path('/tmp/staffing-batch3/staffing-sourcing/batch3')
RAW = ROOT / 'raw'
RAW.mkdir(parents=True, exist_ok=True)

NATIONAL = re.compile(
    r'\b('
    r'randstad|manpower(?:group)?|adecco|employbridge|trueblue|aerotek|actalent|'
    r'kelly services|kellyservices|insight global|insightglobal|\bkforce\b|'
    r'robert half|roberthalf|labor ready|peopleready|people ready|'
    r'staffmark|teksystems|tek systems|allegis|apex systems|'
    r'express employment professionals|express personnel|'
    r'on assignment|\basgn\b|yoh\b|volt workforce|snelling|'
    r'pds tech|spheric|proman(?: group)?|prostar staffing|'
    r'integrity staffing services|\batr\b|atr international|'
    r'appleone|laborfinders|labor finders|elwood staffing|'
    r'pridestaff|pride staff|spherion|robert half'
    r')\b',
    re.I,
)
REJECT_NAME = re.compile(
    r'('
    r'\bmedical\b|\bhealthcare\b|\bhealth care\b|\bnurs(?:e|ing)\b|\bdental\b|'
    r'\bclinic\b|\ballied health\b|\btherapy\b|\bpediatric\b|\bnanny\b|'
    r'\bhousehold\b|early childhood|\bit staffing\b|\bsoftware\b|\bcyber\b|'
    r'\bdevops\b|\btech staffing\b|\blegal\b|\battorney\b|\baccounting\b|'
    r'\bcpa\b|\bfintech\b|executive search|\brpo\b|\bpeo\b|\bpayroll\b|'
    r'event staffing|\bhospitality\b|\brestaurant\b|\bnannies\b|'
    r'\bdental staffing\b|\bhealthcare staffing\b|\bmedical staffing\b|'
    r'substitooth|\btherapy staffing\b'
    r')',
    re.I,
)
KEEP_NAME = re.compile(
    r'('
    r'industrial|warehouse|manufactur|logistic|distribution|production|'
    r'\btrades?\b|weld|machin|fabricat|construction|\blabor\b|'
    r'light industrial|skilled trades|maintenance|mechanical|'
    r'forklift|\bcnc\b|light-industrial'
    r')',
    re.I,
)
GENERIC_STAFFING = re.compile(r'staffing|personnel|workforce|employment|temp(?:s|orary)?', re.I)
SITE_FIT = re.compile(
    r'('
    r'light industrial|industrial staffing|warehouse|manufactur|logistic|'
    r'distribution|production|skilled trades|weld(?:er|ing)|machinist|'
    r'fabrication|construction labor|construction staffing|forklift|'
    r'general labor|assembly|assembler|cnc|maintenance technician|'
    r'mechanical trades|industrial labor'
    r')',
    re.I,
)
SITE_MISMATCH = re.compile(
    r'('
    r'executive search only|it staffing only|software engineering|'
    r'healthcare staffing|nursing staffing|dental staffing|'
    r'legal recruiting|accounting and finance recruiting|'
    r'we are a peo|professional employer organization'
    r')',
    re.I,
)

def norm_name(s: str) -> str:
    s = (s or '').lower()
    s = re.sub(r'[^a-z0-9]+', ' ', s)
    s = re.sub(r'\b(llc|inc|incorporated|ltd|corp|corporation|co|group|the|formerly)\b', ' ', s)
    return re.sub(r'\s+', ' ', s).strip()

def domain_of(url: str) -> str:
    s = (url or '').strip().lower()
    if not s:
        return ''
    if '://' not in s:
        s = 'http://' + s
    try:
        host = urllib.parse.urlparse(s).hostname or ''
    except Exception:
        return ''
    return host.replace('www.', '')

def load_json(path):
    return json.loads(Path(path).read_text())

def corpus_indexes():
    return load_json(RAW / 'corpus-indexes.json') if (RAW / 'corpus-indexes.json').exists() else {
        'emails': [], 'website_domains': [], 'email_domains': [], 'all_domains': [], 'companies': []
    }

def already_sourced_domains():
    p = Path('/tmp/staffing-batch3/batch3-sourcing/raw/already-sourced-accounts.json')
    if not p.exists():
        p = RAW / 'already-sourced-accounts.json'
    if not p.exists():
        return set()
    acc = load_json(p)['accounts']
    out = set()
    for a in acc:
        for k in ('domain', 'primary_domain'):
            d = (a.get(k) or '').lower().replace('www.', '')
            if d:
                out.add(d)
        if a.get('website_url'):
            d = domain_of(a['website_url'])
            if d:
                out.add(d)
    return out

def already_sourced_names():
    p = Path('/tmp/staffing-batch3/batch3-sourcing/raw/already-sourced-accounts.json')
    if not p.exists():
        p = RAW / 'already-sourced-accounts.json'
    if not p.exists():
        return set()
    return {norm_name(a.get('name') or '') for a in load_json(p)['accounts']}

def classify_company(name: str) -> str:
    n = name or ''
    if NATIONAL.search(n):
        return 'national'
    if REJECT_NAME.search(n):
        return 'icp_reject_name'
    if KEEP_NAME.search(n):
        return 'keep_name'
    if GENERIC_STAFFING.search(n):
        return 'generic_staffing'
    return 'unclear'

def title_rank(title: str) -> int:
    t = (title or '').lower()
    rules = [
        (0, r'\b(owner|founder|co-founder|principal)\b'),
        (1, r'\bceo|chief executive\b'),
        (2, r'\bpresident\b'),
        (3, r'managing (partner|director)'),
        (4, r'\bvp\b.*\b(sales|business development|revenue)\b|vice president.*\b(sales|business development)'),
        (5, r'\bvp\b.*operations|vice president.*operations'),
        (6, r'director of (sales|business development)|sales director|business development director'),
        (7, r'branch manager|regional manager'),
        (8, r'\bvp\b|vice president'),
        (9, r'\bdirector\b'),
    ]
    for rank, pat in rules:
        if re.search(pat, t):
            return rank
    return 50

def pick_buyer(people):
    return sorted(people, key=lambda p: (title_rank(p.get('title') or ''), p.get('first_name') or ''))[0]
