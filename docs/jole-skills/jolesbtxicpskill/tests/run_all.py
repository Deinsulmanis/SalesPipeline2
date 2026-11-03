# -*- coding: utf-8 -*-
"""Run every Jole skill's tests. Run: python tests/run_all.py (from jolesbtxicpskill)."""
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
print('ALL PASSED' if not failed else 'FAILED: ' + ', '.join(failed))
sys.exit(1 if failed else 0)
