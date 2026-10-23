#!/usr/bin/env python3
"""Move post-reveal audit holds from approved.jsonl to held.jsonl and sync state."""
from __future__ import annotations
import json, sys
from pathlib import Path
from pipeline import load_state, save_state, read_jsonl

ROOT = Path('/tmp/staffing-batch3/staffing-sourcing/batch3')
OUT = ROOT / 'out'


def apply_moves(moves: dict[str, tuple[str, str]]):
    approved = read_jsonl(OUT / 'approved.jsonl')
    keep, moved = [], []
    for r in approved:
        email = (r.get('apolloVerifiedEmail') or '').lower()
        if email in moves:
            reason, notes = moves[email]
            moved.append({
                'company': r.get('company'),
                'firstName': r.get('firstName'),
                'lastName': r.get('lastName'),
                'jobTitle': r.get('jobTitle'),
                'email': email,
                'domain': r.get('companyDomain'),
                'apolloPersonId': r.get('apolloPersonId'),
                'lane': r.get('staffingLane'),
                'notes': notes,
                'reason': reason,
                'stage': 'held_post_reveal_review',
            })
        else:
            keep.append(r)
    (OUT / 'approved.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in keep))
    with (OUT / 'held.jsonl').open('a') as f:
        for r in moved:
            f.write(json.dumps(r) + '\n')
    state = load_state()
    moved_emails = {m['email'] for m in moved}
    state['funnel']['approved'] = len(keep)
    state['funnel']['held'] = state['funnel'].get('held', 0) + len(moved)
    state['approved_emails'] = [e for e in state.get('approved_emails', []) if e.lower() not in moved_emails]
    still = set()
    for r in keep:
        if r.get('companyDomain'):
            still.add(r['companyDomain'].lower())
        em = r.get('apolloVerifiedEmail') or ''
        if '@' in em:
            still.add(em.split('@')[-1].lower())
    state['approved_domains'] = [d for d in state.get('approved_domains', []) if d.lower() in still]
    save_state(state)
    print(json.dumps({
        'moved': [m['email'] for m in moved],
        'approved': state['funnel']['approved'],
        'held': state['funnel']['held'],
        'credits_spent': state['credits_spent'],
        'remaining_cap': 400 - state['credits_spent'],
    }, indent=2))


if __name__ == '__main__':
    moves = json.loads(Path(sys.argv[1]).read_text()) if len(sys.argv) > 1 else {}
    apply_moves({k: (v['reason'], v['notes']) for k, v in moves.items()})
