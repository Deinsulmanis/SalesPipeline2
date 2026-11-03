# -*- coding: utf-8 -*-
"""Run the fresh-session discovery check. Run: python run_cold.py [prompt ids...]

1. Copies this folder outside the skills tree and re-runs itself from there.
2. Moves every Jole skill's tests/ folder aside, so no session can read logic, fixtures or answer keys.
3. Runs one fresh `claude -p` session per prompt, with no MCP servers and read-only tools (Read, Glob,
   Grep, Skill), from an empty working folder (no project memory), without naming any skill.
4. Restores the tests/ folders (always, in a finally block), then scores the runs with check_cold.py.
Each run costs real model usage; the result line of each run reports its cost.
"""
import concurrent.futures
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SKILLS = os.path.join(os.path.expanduser('~'), '.claude', 'skills')

if os.path.normcase(HERE).startswith(os.path.normcase(SKILLS)):
    copy = os.path.join(tempfile.mkdtemp(prefix='jole-cold-'), 'cold_session')
    shutil.copytree(HERE, copy, ignore=shutil.ignore_patterns('runs'))
    sys.exit(subprocess.call([sys.executable, '-I', '-B', os.path.join(copy, 'run_cold.py')] + sys.argv[1:]))

OUT = os.path.join(HERE, 'runs')
WORK = os.path.join(HERE, 'work')
os.makedirs(OUT, exist_ok=True)
os.makedirs(WORK, exist_ok=True)
MCP = os.path.join(HERE, 'no_mcp.json')
with open(MCP, 'w', encoding='utf-8') as fh:
    json.dump({'mcpServers': {}}, fh)
CLAUDE = shutil.which('claude')
PROMPTS = sorted(glob.glob(os.path.join(HERE, 'prompts', '*.md')))
if sys.argv[1:]:
    PROMPTS = [p for p in PROMPTS if os.path.splitext(os.path.basename(p))[0] in sys.argv[1:]]


def run(prompt):
    run_id = os.path.splitext(os.path.basename(prompt))[0]
    cmd = [CLAUDE, '-p', '--strict-mcp-config', '--mcp-config', MCP, '--tools', 'Read,Glob,Grep,Skill',
           '--allowedTools', 'Read,Glob,Grep,Skill', '--no-session-persistence', '--output-format', 'stream-json', '--verbose']
    with open(prompt, 'rb') as stdin, open(os.path.join(OUT, run_id + '.jsonl'), 'wb') as stdout:
        code = subprocess.run(cmd, stdin=stdin, stdout=stdout, stderr=subprocess.DEVNULL, cwd=WORK, timeout=1200).returncode
    return run_id, code


aside = tempfile.mkdtemp(prefix='jole-tests-aside-')
moved = []
try:
    for folder in sorted(glob.glob(os.path.join(SKILLS, 'jole*', 'tests'))):
        target = os.path.join(aside, os.path.basename(os.path.dirname(folder)))
        shutil.move(folder, target)
        moved.append((folder, target))
    print('moved aside:', len(moved), 'tests folders')
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for run_id, code in pool.map(run, PROMPTS):
            print('finished', run_id, 'exit', code)
finally:
    for folder, target in moved:
        shutil.move(target, folder)
    missing = [f for f, _ in moved if not os.path.isdir(f)]
    print('restored:', len(moved) - len(missing), 'of', len(moved), '' if not missing else 'MISSING: %s' % missing)

sys.exit(subprocess.call([sys.executable, '-I', '-B', os.path.join(HERE, 'check_cold.py'), OUT]))
