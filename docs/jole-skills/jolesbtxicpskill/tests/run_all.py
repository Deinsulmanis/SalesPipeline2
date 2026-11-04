# -*- coding: utf-8 -*-
"""Run every Jole skill's tests, then check the installation against its source.

Run: python tests/run_all.py [--allow-drift]   (from jolesbtxicpskill)

The installation check (tools/sync.py status) runs only when these are the installed skills under
~/.claude/skills. Drift fails the run; --allow-drift reports it without failing, for use mid-edit,
before the change is exported and committed.
"""
import os
import subprocess
import sys

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import jole_common as C  # noqa: E402

failed = []
for skill in C.ALL_SKILLS:
    tdir = os.path.join(C.SKILLS_ROOT, skill, 'tests')
    for name in sorted(os.listdir(tdir)):
        if name.startswith('test_') and name.endswith('.py'):
            proc = subprocess.run([sys.executable, '-B', os.path.join(tdir, name)], capture_output=True, text=True,
                                  cwd=os.path.dirname(tdir))
            summary = [l for l in proc.stderr.splitlines() if l.startswith(('Ran ', 'OK', 'FAILED'))]
            print('%-34s %-24s %s' % (skill, name, ' | '.join(summary)))
            if proc.returncode:
                failed.append(skill + '/' + name)
                print(proc.stderr[-3000:])

installed = os.path.normcase(os.path.join(C.HOME, '.claude', 'skills'))
if os.path.normcase(C.SKILLS_ROOT) == installed:
    proc = subprocess.run([sys.executable, '-B', os.path.join(C.POLICY_DIR, 'tools', 'sync.py'), 'status'],
                          capture_output=True, text=True)
    lines = proc.stdout.strip().splitlines()
    print('%-34s %-24s %s' % (C.POLICY, 'installation', lines[-1] if lines else proc.stderr.strip()[-200:]))
    if proc.returncode:
        print('\n'.join(lines[:-1][:40]))
        if '--allow-drift' not in sys.argv:
            failed.append('installation drift (tools/sync.py status)')
else:
    print('%-34s %-24s %s' % (C.POLICY, 'installation', 'skipped: not the installed copy'))
print('ALL PASSED' if not failed else 'FAILED: ' + ', '.join(failed))
sys.exit(1 if failed else 0)
