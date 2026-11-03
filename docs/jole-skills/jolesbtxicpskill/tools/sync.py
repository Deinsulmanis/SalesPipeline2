# -*- coding: utf-8 -*-
"""Install, check and export the Jole skills. The repository is the source of truth.

Source: SalesPipeline2, folder docs/jole-skills/, at a git commit (on main once integrated).
Installation, all generated from that source:
  ~/.claude/skills/<skill>/        the nine skill folders Claude Code loads
  ~/.agents/skills/<skill>/SKILL.md  Codex pointers (name, description, path; no rules)
  the "## Jole BTX Prospecting" section of ~/.claude/CLAUDE.md, ~/AGENTS.md and ~/.codex/AGENTS.md
  ~/.claude/skills/jolesbtxicpskill/.jole-install.json  which commit is installed

  python tools/sync.py status [--ref REF]   compare the installation with the installed commit (or REF); exit 1 on drift
  python tools/sync.py install --ref REF    install REF; refuses to overwrite local edits unless --replace-local-edits
  python tools/sync.py export --to DIR      copy the installed skills into DIR (a docs/jole-skills folder), to commit them

Read-only towards git: it runs only rev-parse, ls-tree and cat-file. It never commits, pushes, checks out,
fetches, prunes or touches worktrees. Backups go to ~/.claude/backups/jole-skills/, outside the skills folder.
"""
import argparse
import datetime
import json
import os
import shutil
import subprocess
import sys

SKILLS = ('jolesbtxicpskill', 'jole-icp-qualification', 'jole-buying-signals', 'jole-buyer-identification',
          'jole-site-labor-feasibility', 'jole-dedupe-suppression', 'jole-contact-deliverability',
          'jole-outreach-readiness', 'jole-qualification-orchestrator')
POLICY = 'jolesbtxicpskill'
PREFIX = 'docs/jole-skills/'
DEFAULT_REPO = os.environ.get('JOLE_SKILLS_REPO', r'C:\Users\deins\OneDrive\SalesPipeline2')
STATE = '.jole-install.json'
IGNORE_DIRS = {'__pycache__'}
IGNORE_PATHS = {'tests/cold_session/runs', 'tests/cold_session/work'}
IGNORE_FILES = {STATE, 'no_mcp.json'}
SECTION_HEAD = '## Jole BTX Prospecting'
INSTRUCTION_FILES = (('.claude/CLAUDE.md', 'claude-section.md'), ('AGENTS.md', 'codex-section.md'), ('.codex/AGENTS.md', 'codex-section.md'))
SKILL_DRIFT = ('missing locally', 'not in source', 'differs:')
POINTER = """---
name: {name}
description: {description}
---

# {name} (Codex pointer)

This file is not the skill. The canonical skill is:

`{target}`

1. Read that file in full and follow it.{shared}
2. Files it links to, such as ARCHITECTURE.md, CONTRACT.md and reference.md, are in `{policy_dir}\\`.
3. If you cannot read the canonical file, stop and say so. Do not qualify from memory, older notes or this pointer.
"""
SHARED = (' Every Jole specialist also requires the shared policy, `{policy}`: read it first.')


def lf(data):
    return data.replace(b'\r\n', b'\n')


def ignored(rel):
    parts = rel.split('/')
    return (parts[-1] in IGNORE_FILES or parts[-1].endswith('.pyc') or any(p in IGNORE_DIRS for p in parts)
            or any(rel == p or rel.startswith(p + '/') for p in IGNORE_PATHS))


def git(repo, *args, data=None):
    proc = subprocess.run(['git', '-C', repo, '-c', 'core.quotepath=off'] + list(args), input=data,
                          capture_output=True)
    if proc.returncode:
        raise SystemExit('git %s failed: %s' % (' '.join(args), proc.stderr.decode('utf-8', 'replace').strip()))
    return proc.stdout


def repo_tree(repo, ref):
    """(commit, {skill: {relpath: bytes}}, {instruction name: text}) for the docs/jole-skills folder at ref."""
    commit = git(repo, 'rev-parse', '--verify', ref + '^{commit}').decode().strip()
    listing = git(repo, 'ls-tree', '-r', '-z', commit, '--', PREFIX).split(b'\0')
    entries = []
    for item in filter(None, listing):
        meta, path = item.split(b'\t', 1)
        _, kind, sha = meta.decode().split()
        if kind == 'blob':
            entries.append((sha, path.decode('utf-8')[len(PREFIX):]))
    if not entries:
        raise SystemExit('%s has no %s folder' % (ref, PREFIX))
    batch = git(repo, 'cat-file', '--batch', data=''.join(sha + '\n' for sha, _ in entries).encode())
    files, pos = {s: {} for s in SKILLS}, 0
    for sha, path in entries:
        header_end = batch.index(b'\n', pos)
        size = int(batch[pos:header_end].split()[2])
        content = batch[header_end + 1:header_end + 1 + size]
        pos = header_end + 1 + size + 1
        skill, _, rel = path.partition('/')
        if skill in files and rel and not ignored(rel):
            files[skill][rel] = content
    return commit, files


def local_tree(skills_dir):
    files = {}
    for skill in SKILLS:
        root = os.path.join(skills_dir, skill)
        files[skill] = {}
        for here, dirs, names in os.walk(root):
            dirs[:] = [d for d in dirs if d not in IGNORE_DIRS]
            for name in names:
                rel = os.path.relpath(os.path.join(here, name), root).replace(os.sep, '/')
                if not ignored(rel):
                    with open(os.path.join(here, name), 'rb') as fh:
                        files[skill][rel] = fh.read()
    return files


def frontmatter(text):
    head = text.split('---', 2)[1] if text.startswith('---') else ''
    out = {}
    for line in head.strip().splitlines():
        if ':' in line:
            k, v = line.split(':', 1)
            out[k.strip()] = v.strip()
    return out


def pointer_text(skill, skill_md, home):
    fm = frontmatter(skill_md.decode('utf-8'))
    skills_dir = os.path.join(home, '.claude', 'skills')
    policy = os.path.join(skills_dir, POLICY, 'SKILL.md')
    return POINTER.format(name=skill, description=fm['description'], target=os.path.join(skills_dir, skill, 'SKILL.md'),
                          shared='' if skill == POLICY else SHARED.format(policy=policy),
                          policy_dir=os.path.join(skills_dir, POLICY))


def section_of(text):
    text = text.replace('\r\n', '\n')
    start = text.find(SECTION_HEAD)
    if start == -1:
        return None
    end = text.find('\n## ', start + 1)
    return text[start:] if end == -1 else text[start:end + 1]


def compare(home, files):
    """List of drift lines; empty when the installation matches files."""
    drift = []
    skills_dir = os.path.join(home, '.claude', 'skills')
    local = local_tree(skills_dir)
    for skill in SKILLS:
        want, have = files[skill], local[skill]
        for rel in sorted(set(want) | set(have)):
            if rel not in have:
                drift.append('missing locally: %s/%s' % (skill, rel))
            elif rel not in want:
                drift.append('not in source:   %s/%s' % (skill, rel))
            elif lf(want[rel]) != lf(have[rel]):
                drift.append('differs:         %s/%s' % (skill, rel))
    for skill in SKILLS:
        folder = os.path.join(home, '.agents', 'skills', skill)
        path = os.path.join(folder, 'SKILL.md')
        if 'SKILL.md' not in files[skill]:
            continue
        expected = pointer_text(skill, files[skill]['SKILL.md'], home)
        if not os.path.exists(path):
            drift.append('Codex pointer missing: ' + skill)
        else:
            with open(path, 'rb') as fh:
                if lf(fh.read()).decode('utf-8') != expected:
                    drift.append('Codex pointer differs: ' + skill)
            extra = sorted(set(os.listdir(folder)) - {'SKILL.md'})
            if extra:
                drift.append('Codex pointer folder has extra files: %s %s' % (skill, extra))
    instructions = files[POLICY]
    for rel, name in INSTRUCTION_FILES:
        want = instructions.get('tools/instructions/' + name)
        path = os.path.join(home, *rel.split('/'))
        if want is None:
            drift.append('instruction section missing from source: ' + name)
        elif not os.path.exists(path):
            drift.append('instruction file missing: ' + rel)
        else:
            with open(path, encoding='utf-8') as fh:
                if section_of(fh.read()) != lf(want).decode('utf-8'):
                    drift.append('instruction section differs: ' + rel)
    return drift


def read_state(home):
    path = os.path.join(home, '.claude', 'skills', POLICY, STATE)
    if not os.path.exists(path):
        return {}
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)


def cmd_status(args):
    state = read_state(args.home)
    ref = args.ref or state.get('commit')
    if not ref:
        print('NOT INSTALLED FROM A COMMIT: no %s. Run install --ref <ref>.' % STATE)
        return 1
    commit, files = repo_tree(args.repo, ref)
    drift = compare(args.home, files)
    label = 'installed commit' if not args.ref else 'ref ' + args.ref
    print('source: %s %s (%s)' % (label, commit[:12], args.repo))
    if state:
        print('installed: %s from %s at %s' % (state.get('commit', '?')[:12], state.get('ref', '?'), state.get('installed_at', '?')))
        if state.get('ref') and not args.ref:
            try:
                moved = git(args.repo, 'rev-parse', '--verify', state['ref'] + '^{commit}').decode().strip()
            except SystemExit:
                moved = ''
            if moved and moved != state.get('commit'):
                print('note: %s has moved to %s; run status --ref %s to compare' % (state['ref'], moved[:12], state['ref']))
    for line in drift:
        print('  ' + line)
    print('IN SYNC' if not drift else 'DRIFT: %d item(s)' % len(drift))
    return 0 if not drift else 1


def backup(home, stamp):
    target = os.path.join(home, '.claude', 'backups', 'jole-skills', stamp)
    for skill in SKILLS:
        for base, sub in ((os.path.join(home, '.claude', 'skills'), 'claude-skills'), (os.path.join(home, '.agents', 'skills'), 'agents-skills')):
            src = os.path.join(base, skill)
            if os.path.isdir(src):
                shutil.copytree(src, os.path.join(target, sub, skill), ignore=shutil.ignore_patterns('__pycache__'))
    for rel, _ in INSTRUCTION_FILES:
        src = os.path.join(home, *rel.split('/'))
        if os.path.exists(src):
            dst = os.path.join(target, 'instructions', rel.replace('/', '__'))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)
    return target


def cmd_install(args):
    commit, files = repo_tree(args.repo, args.ref)
    state = read_state(args.home)
    if not args.replace_local_edits:
        # Local edits: skill files that differ from the commit last installed (on a first install, from the
        # target). They block the install unless the installation already matches the target.
        base = repo_tree(args.repo, state['commit'])[1] if state.get('commit') else files
        edits = [d for d in compare(args.home, base) if d.startswith(SKILL_DRIFT)]
        if edits and [d for d in compare(args.home, files) if d.startswith(SKILL_DRIFT)]:
            print('Refusing: the installation has changes that are not in %s:' % (state.get('commit') or args.ref)[:12])
            for line in edits:
                print('  ' + line)
            print('Export and commit them first, or pass --replace-local-edits (a backup is kept).')
            return 1
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    saved = backup(args.home, stamp) if not args.no_backup else '(none)'
    skills_dir = os.path.join(args.home, '.claude', 'skills')
    local = local_tree(skills_dir)
    for skill in SKILLS:
        root = os.path.join(skills_dir, skill)
        for rel in local[skill]:
            if rel not in files[skill]:
                os.remove(os.path.join(root, *rel.split('/')))
        for rel, content in files[skill].items():
            path = os.path.join(root, *rel.split('/'))
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, 'wb') as fh:
                fh.write(content)
        for here, dirs, names in os.walk(root, topdown=False):
            if here != root and not os.listdir(here):
                os.rmdir(here)
        folder = os.path.join(args.home, '.agents', 'skills', skill)
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, 'SKILL.md'), 'w', encoding='utf-8', newline='\n') as fh:
            fh.write(pointer_text(skill, files[skill]['SKILL.md'], args.home))
    for rel, name in INSTRUCTION_FILES:
        path = os.path.join(args.home, *rel.split('/'))
        section = lf(files[POLICY]['tools/instructions/' + name]).decode('utf-8')
        raw = open(path, 'rb').read().decode('utf-8') if os.path.exists(path) else ''
        crlf = '\r\n' in raw
        text = raw.replace('\r\n', '\n')
        old = section_of(text)
        if old is None:
            text = text.rstrip('\n') + ('\n\n' if text.strip() else '') + section
        else:
            start = text.index(SECTION_HEAD)
            text = text[:start] + section + text[start + len(old):]
        os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
        with open(path, 'wb') as fh:
            fh.write((text.replace('\n', '\r\n') if crlf else text).encode('utf-8'))
    with open(os.path.join(skills_dir, POLICY, STATE), 'w', encoding='utf-8', newline='\n') as fh:
        json.dump({'repo': args.repo, 'ref': args.ref, 'commit': commit,
                   'installed_at': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')}, fh, indent=1)
        fh.write('\n')
    print('installed %s (%s); backup: %s' % (args.ref, commit[:12], saved))
    drift = compare(args.home, files)
    for line in drift:
        print('  ' + line)
    print('IN SYNC' if not drift else 'DRIFT AFTER INSTALL: %d item(s)' % len(drift))
    return 0 if not drift else 1


def cmd_export(args):
    local = local_tree(os.path.join(args.home, '.claude', 'skills'))
    for skill in SKILLS:
        root = os.path.join(args.to, skill)
        if os.path.isdir(root):
            for here, dirs, names in os.walk(root):
                for name in names:
                    rel = os.path.relpath(os.path.join(here, name), root).replace(os.sep, '/')
                    if rel not in local[skill] and not ignored(rel):
                        os.remove(os.path.join(here, name))
        for rel, content in local[skill].items():
            path = os.path.join(root, *rel.split('/'))
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, 'wb') as fh:
                fh.write(lf(content))
        print('exported %-34s %d files' % (skill, len(local[skill])))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('command', choices=('status', 'install', 'export'))
    ap.add_argument('--repo', default=DEFAULT_REPO)
    ap.add_argument('--ref')
    ap.add_argument('--home', default=os.path.expanduser('~'))
    ap.add_argument('--to')
    ap.add_argument('--replace-local-edits', action='store_true')
    ap.add_argument('--no-backup', action='store_true', help='for a scratch home only')
    args = ap.parse_args(argv)
    if args.command == 'install' and not args.ref:
        ap.error('install needs --ref')
    if args.command == 'export' and not args.to:
        ap.error('export needs --to')
    return {'status': cmd_status, 'install': cmd_install, 'export': cmd_export}[args.command](args)


if __name__ == '__main__':
    sys.exit(main())
