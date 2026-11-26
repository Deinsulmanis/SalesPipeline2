"""Firecrawl search results from a helper transcript -> rows tagged by segment and query type.
Usage: python3 -I fc_parse.py <transcript.jsonl> <out.json>"""
import json, sys, re
SEGS = [('industrial', 'light industrial'), ('engineering', 'engineering staffing'), ('cdl', 'driver staffing'),
        ('construction', 'construction staffing'), ('it', '"IT staffing"'), ('healthcare', 'healthcare staffing'), ('office', 'office staffing')]
calls, res = {}, {}
for line in open(sys.argv[1]):
    try: ev = json.loads(line)
    except ValueError: continue
    c = (ev.get('message') or {}).get('content')
    if not isinstance(c, list): continue
    for b in c:
        if b.get('type') == 'tool_use' and b.get('name', '').endswith('firecrawl_search'):
            calls[b['id']] = b['input']
        elif b.get('type') == 'tool_result':
            t = b.get('content'); t = t if isinstance(t, str) else '\n'.join(x.get('text', '') for x in t or [] if isinstance(x, dict))
            res[b['tool_use_id']] = t
rows, credits = [], 0
for cid, inp in calls.items():
    q = inp.get('query', '')
    seg = next((k for k, m in SEGS if m in q), '?')
    typ = 'upwork' if 'upwork.com' in q else 'linkedin' if 'linkedin.com' in q else 'reddit-tried' if 'cold calling' in q else 'reddit-pain'
    try: d = json.loads(res.get(cid, ''))
    except ValueError: continue
    credits += d.get('creditsUsed') or 0
    for r in (d.get('data') or {}).get('web') or []:
        rows.append({'seg': seg, 'type': typ, 'url': r.get('url'), 'title': r.get('title'), 'desc': r.get('description')})
json.dump({'credits': credits, 'calls': len(calls), 'rows': rows}, open(sys.argv[2], 'w'), indent=1)
print('calls', len(calls), 'credits', credits, 'rows', len(rows))
