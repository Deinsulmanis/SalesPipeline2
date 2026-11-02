# -*- coding: utf-8 -*-
"""Scores a fresh session's answers to cold_session_prompt.md.

Move this tests/ folder out of the skill first, and copy this script and the
prompt somewhere else. The session can read files, and on 2026-11-02 a run that
could see tests/ opened decide.py and fixtures_38.json, which proves nothing
about SKILL.md. Move the folder back afterwards.

How to run a fresh session, from the SalesPipeline2 folder, with no MCP servers
and read-only tools, so it cannot reach Apollo, the CRM or the sending system:

  claude -p --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
    --tools "Read,Glob,Grep,Skill" --allowedTools "Read,Glob,Grep,Skill" \
    --no-session-persistence --output-format stream-json --verbose \
    < ~/.claude/skills/jolesbtxicpskill/tests/cold_session_prompt.md > cold.jsonl

Then: python tests/cold_session_check.py cold.jsonl

The answer key is in this file, so a run that opened tests/ proves nothing. The
check fails if the session's tool calls touched that folder.
"""
import json
import re
import sys

CV = 'CONTACT VERIFICATION REQUIRED'
BR = 'BUYER RESEARCH REQUIRED'
CP = 'COMPLIANCE / PROCUREMENT REVIEW'
EXPECT = {
    1: ('QUALIFIED', CV), 2: ('QUALIFIED', CV), 3: ('QUALIFIED', CV), 4: ('QUALIFIED', CV),
    5: ('QUALIFIED', BR), 6: ('EXCLUDED', 'HOLD'), 7: ('EXCLUDED', 'HOLD'), 8: ('QUALIFIED', BR),
    9: ('QUALIFIED', 'HOLD'), 10: ('QUALIFIED', 'HOLD'), 11: ('EXCLUDED', 'HOLD'),
    12: ('EXCLUDED', 'HOLD'), 13: ('CONDITIONAL', CP), 14: ('CONDITIONAL', CP),
}


def parse(path):
    """Return the final answer text and every tool call from a stream-json run."""
    answer, calls = '', []
    with open(path, encoding='utf-8-sig') as f:
        for line in f:
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if event.get('type') == 'result':
                answer = event.get('result', '')
            for block in (event.get('message') or {}).get('content') or []:
                if isinstance(block, dict) and block.get('type') == 'tool_use':
                    calls.append((block.get('name'), json.dumps(block.get('input', {}))))
    return answer, calls


def main(path):
    raw, calls = parse(path)
    for name, args in calls:
        print('tool   :', name, args[:120])
    peeked = [a for _, a in calls if re.search(r'tests[\\/]|fixtures|cold_session', a)]
    match = re.search(r'\{.*\}', raw, re.S)
    data = json.loads(match.group(0))
    print('source :', data.get('skill_source'))
    print('version:', data.get('skill_version'))
    print('touched tests/:', bool(peeked))
    bad = 1 if peeked else 0
    got = {c['id']: c for c in data['cases']}
    for i, (el, rd) in EXPECT.items():
        c = got.get(i, {})
        ok = c.get('eligibility') == el and c.get('readiness') == rd and c.get('hiring_v5_allowed') is False
        bad += not ok
        print(('ok  ' if ok else 'DIFF'), i, c.get('eligibility'), '|', c.get('readiness'), '|', c.get('hiring_v5_allowed'),
              '' if ok else '  expected %s | %s | False' % (el, rd))
    version_ok = str(data.get('skill_version', '')).startswith('3.')
    print('%d of %d cases match; version %s' % (len(EXPECT) - bad + bool(peeked), len(EXPECT), 'ok' if version_ok else 'WRONG'))
    return 1 if bad or not version_ok else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1]))
