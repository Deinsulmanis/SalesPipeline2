"""Parse GetLeads search_jobs results from a helper transcript; classify agency BD postings by segment.
Usage: python3 -I bd_parse.py <transcript.jsonl> <out.json>"""
import json, re, sys, os, collections

out = sys.argv[1]
args = sys.argv[2:]
TOTAL_OVERRIDE = {a.split('=')[0]: int(a.split('=')[1]) for a in args if a.startswith('total:')}
TOTAL_OVERRIDE = {k.replace('total:', ''): v for k, v in TOTAL_OVERRIDE.items()}
inputs = [a for a in args if not a.startswith('total:')]
calls, results = {}, {}
direct = []  # (word, parsed json)
def texts(content):
    if isinstance(content, str): return [content]
    o = []
    for c in content or []:
        if isinstance(c, dict) and c.get('type') == 'text': o.append(c['text'])
    return o
for tr in inputs:
  if '=' in tr and not tr.endswith('.jsonl') and not tr.endswith('.output'):
    w, pth = tr.split('=', 1); direct.append((w, json.load(open(pth)))); continue
  for line in open(tr):
    try: ev = json.loads(line)
    except ValueError: continue
    msg = ev.get('message') or {}
    for b in msg.get('content') or [] if isinstance(msg.get('content'), list) else []:
        if b.get('type') == 'tool_use' and b.get('name', '').endswith('search_jobs'):
            calls[b['id']] = b['input']
        elif b.get('type') == 'tool_result':
            results[b['tool_use_id']] = texts(b.get('content'))
def load(tlist):
    s = '\n'.join(tlist)
    try: return json.loads(s)
    except ValueError: pass
    m = re.search(r'(/\S+?\.(?:txt|json))', s)
    if m and os.path.exists(m.group(1)):
        raw = open(m.group(1)).read()
        try:
            d = json.loads(raw)
        except ValueError:
            return None
        # saved MCP results may be a list of content blocks
        if isinstance(d, list):
            for c in d:
                if isinstance(c, dict) and c.get('type') == 'text':
                    try: return json.loads(c['text'])
                    except ValueError: pass
            return None
        return d
    return None

SEG = {
 'industrial': r"light[- ]industrial|industrial staffing|warehous|manufactur|forklift|production (worker|associate)|general labor|assembly",
 'engineering': r"engineering (staffing|recruit|talent|professionals)|technical staffing|engineers\b|engineering (and|&) technical|technical recruit|\baec\b|architecture,? engineering|contract engineer",
 'cdl': r"\bcdl\b|truck drivers?|driver staffing|class a drivers?|driver leasing|transportation staffing|drivers? placement",
 'construction': r"construction (staffing|labor|trades|industry|workers|craft)|skilled trades|carpent|electricians|construction laborers?",
 'it': r"\bIT (?i:staffing|consulting|recruit|services|talent|professionals|solutions)|(?i:information technology|software (developers?|engineers?)|tech(nology)? staffing|\bc2c\b)",
 'healthcare': r"health ?care staffing|\bnurs(e|es|ing)\b|allied health|travel nurs|medical staffing|clinical|\bcna\b|\blpn\b|\brn\b",
 'office': r"clerical|administrative staffing|office staffing|admin(istrative)? (and|&) clerical|office (professionals|support|staffing)|accounting (and|&) finance staffing",
}
SEGRX = {k: re.compile(v) if k == 'it' else re.compile(v, re.I) for k, v in SEG.items()}
FLAGS = re.IGNORECASE
OWN = re.compile(r"staffing (services|solutions|sales|industry|firm|agency|company|business|partner)|workforce solutions|job orders|temporary (staffing|labor|associates|workers|employees|placements)|temp(orary)?[- ]to[- ]hire|contract staffing|staffing (and|&) recruiting|direct hire (placements|services)|placements? fees?", re.I)
seen, posts, per_word = set(), [], collections.Counter()
totals = {}
batches = [(inp.get('company_name'), load(results.get(cid, []))) for cid, inp in calls.items()] + direct
for w, d in batches:
    if not d or 'data' not in d: continue
    totals.setdefault(w, d.get('total_results'))
    for p in d['data']:
        key = (p.get('linkedin_job_url') or json.dumps(p.get('job_urls'), sort_keys=True)) or (p.get('company_name'), p.get('title'), p.get('location'))
        if key in seen: continue
        seen.add(key); per_word[w] += 1
        txt = f"{p.get('title','')}\n{p.get('description') or ''}"
        segs = [k for k, rx in SEGRX.items() if rx.search(txt)]
        # 'IT' regex is case-sensitive for the bare acronym; others case-insensitive
        posts.append({'company': (p.get('company_name') or '').strip(), 'title': p.get('title'), 'state': p.get('geo_admin_district') or '',
                      'posted_at': (p.get('posted_at') or '')[:10], 'segs': segs, 'word': w,
                      'own_bd': bool(re.search(r"business development|account (executive|manager)|sales|branch manager|growth|client development", p.get('title') or '', re.I)) and bool(OWN.search(txt)),
                      'bd_title': bool(re.search(r"business development|account (executive|manager)|sales|branch manager|growth|client development", p.get('title') or '', re.I))})
for k, v in TOTAL_OVERRIDE.items(): totals[k] = v
def est(pred):
    e = 0.0
    for w, T in totals.items():
        S = [p for p in posts if p['word'] == w]
        if S and T: e += T * sum(1 for p in S if pred(p)) / len(S)
    return round(e)
res = {'totals_by_word': totals, 'unique_postings': len(posts), 'per_word_unique': per_word, 'est_total_all': est(lambda p: True), 'est_own_bd_all': est(lambda p: p['own_bd']), 'own_bd_in_sample': sum(1 for p in posts if p['own_bd']), 'segments': {}}
for k in list(SEG) + ['unclassified']:
    sel = [p for p in posts if (k in p['segs']) or (k == 'unclassified' and not p['segs'])]
    bd = [p for p in sel if p['own_bd']]
    st = collections.Counter(p['state'] for p in bd if p['state'])
    res['segments'][k] = {'est_postings_all_agency_words': est(lambda p, k=k: (k in p['segs']) if k != 'unclassified' else not p['segs']),
                          'est_own_bd': est(lambda p, k=k: p['own_bd'] and ((k in p['segs']) if k != 'unclassified' else not p['segs'])),
                          'postings': len(sel), 'own_bd_postings_in_sample': len(bd), 'companies': len({p['company'].lower() for p in bd}),
                          'top_states': st.most_common(5), 'only_this_segment': sum(1 for p in bd if p['segs'] == [k])}
json.dump(res, open(out, 'w'), indent=1, default=list)
print(json.dumps({k: v for k, v in res.items() if k != 'segments'}, default=list))
for k, v in res['segments'].items(): print(k, v)
