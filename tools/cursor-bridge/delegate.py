"""Bounded Codex-to-Cursor proposal handoff; no Unity access or automatic patch application."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import time
from uuid import uuid4

REPO = Path(__file__).resolve().parents[2]
PROFILE = '.cursor/agents/ocean-code-worker.md'
SCHEMA = 'ocean-cursor-handoff/1'
LIMIT = 96_000
DENY = ['Shell(*)', 'Write(**)', 'Mcp(*:*)', 'WebFetch(*)']


def digest(data):
    return hashlib.sha256(data).hexdigest()


def save(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
    temporary.replace(path)


def selected_file(repo, relative):
    name = PurePosixPath(relative.replace('\\', '/'))
    if name.is_absolute() or '..' in name.parts or ':' in relative or not name.parts:
        raise ValueError('Repository-relative file required')
    forbidden = {'.git', 'brain-store', 'work', 'conversations', 'secrets', 'node_modules', '.venv'}
    if forbidden.intersection(name.parts) or any(p.startswith('.env') for p in name.parts):
        raise ValueError('Do not delegate archives, local state or credentials')
    if name.name in {'qa.local.json', 'mcp.json', 'cli-config.json', 'cli.json', 'TASK.json', 'AGENTS.md'} or any(x in name.name.lower() for x in ['credential', 'secret', 'token']):
        raise ValueError('Reserved or sensitive file')
    path = repo.joinpath(*name.parts)
    if path.is_symlink() or not path.resolve().is_relative_to(repo.resolve()) or not path.is_file():
        raise ValueError('Selected file must stay inside the automation repository')
    data = path.read_bytes()
    if b'\0' in data or len(data) > LIMIT:
        raise ValueError('Only bounded text files are supported')
    data.decode('utf-8')
    return name.as_posix(), data


def prepare(goal, files, criteria, *, repo=REPO):
    if not goal.strip() or len(goal) > 5000 or not files or len(files) > 12 or not criteria:
        raise ValueError('One goal, 1..12 explicit files and acceptance criteria required')
    selected = [selected_file(repo, name) for name in files]
    if len({name for name, _ in selected}) != len(selected) or sum(len(data) for _, data in selected) > LIMIT:
        raise ValueError('Duplicate files or context budget exceeded')
    task_id = uuid4().hex
    job = repo / 'brain-store/cursor-tasks' / task_id
    workspace = job / 'workspace'
    workspace.mkdir(parents=True)
    manifest = {'schema': SCHEMA, 'id': task_id, 'goal': goal, 'criteria': criteria,
                'files': [], 'state': 'prepared', 'gameplay_authorized': False,
                'automatic_application': False}
    for name, data in selected:
        target = workspace / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        manifest['files'].append({'path': name, 'sha256': digest(data), 'bytes': len(data)})
    profile = (repo / PROFILE).read_text(encoding='utf-8')
    (workspace / 'AGENTS.md').write_text(profile, encoding='utf-8', newline='\n')
    config = workspace / '.cursor'
    config.mkdir(exist_ok=True)
    readable = ['AGENTS.md', 'TASK.json'] + [f['path'] for f in manifest['files']]
    save(config / 'cli.json', {'permissions': {'allow': ['Read(' + f + ')' for f in readable], 'deny': DENY}})
    save(config / 'mcp.json', {'mcpServers': {}})
    save(workspace / 'TASK.json', {k: v for k, v in manifest.items() if k != 'state'})
    save(job / 'task.json', manifest)
    return manifest


def load_task(task_id, *, repo=REPO):
    if not re.fullmatch(r'[a-f0-9]{32}', task_id):
        raise ValueError('Unknown task ID')
    job = repo / 'brain-store/cursor-tasks' / task_id
    value = json.loads((job / 'task.json').read_text(encoding='utf-8'))
    if value.get('schema') != SCHEMA or value.get('id') != task_id:
        raise ValueError('Task identity mismatch')
    return job, value


def check_sources(task, *, repo=REPO):
    changed = []
    for file in task['files']:
        try:
            matches = digest(selected_file(repo, file['path'])[1]) == file['sha256']
        except (OSError, ValueError):
            matches = False
        if not matches:
            changed.append(file['path'])
    return changed


def discover_agent():
    # Use the same native entry point as the installed Windows launcher, without shell quoting.
    if os.name == 'nt':
        base = Path(os.environ.get('LOCALAPPDATA', '')) / 'cursor-agent'
        versions = sorted((base / 'versions').glob('*'), reverse=True)
        for version in versions:
            if re.fullmatch(r'\d{4}\.\d{1,2}\.\d{1,2}(?:-\d{2}-\d{2}-\d{2})?-[a-f0-9]+', version.name) and (version / 'node.exe').is_file() and (version / 'index.js').is_file():
                return [str(version / 'node.exe'), str(version / 'index.js')]
    command = shutil.which('agent') or shutil.which('cursor-agent')
    if command and Path(command).suffix.lower() not in {'.cmd', '.bat', '.ps1'}:
        return [command]
    raise ValueError('Install/sign in to Cursor CLI; no usable local agent entry point found')


def parse_proposal(text):
    try:
        return json.loads(text.strip())
    except ValueError:
        # Cursor's terminal result aggregates progress messages and its final text.
        blocks = re.findall(r'```json[ \t]*\r?\n(.*?)\r?\n```', text, re.S)
        if len(blocks) != 1:
            raise ValueError('Expected one unambiguous final JSON proposal')
        return json.loads(blocks[0])


def decode_response(stdout, task):
    envelope = json.loads(stdout)
    if envelope.get('type') != 'result' or envelope.get('is_error') is not False or envelope.get('subtype') != 'success':
        raise ValueError('Cursor terminal result is not successful')
    proposal = parse_proposal(envelope['result'])
    if proposal.get('status') not in {'proposal', 'needs_context'} or not isinstance(proposal.get('summary'), str) or not isinstance(proposal.get('files_read'), list):
        raise ValueError('Cursor proposal format invalid')
    if set(proposal['files_read']) - {f['path'] for f in task['files']}:
        raise ValueError('Cursor reported reading files outside the packet')
    return envelope, proposal


def reconcile(task_id, *, repo=REPO):
    """Read a confirmed terminal response again after a parser fix; never call Cursor."""
    job, task = load_task(task_id, repo=repo)
    result = json.loads((job / 'result.json').read_text(encoding='utf-8'))
    if task['state'] == 'running' or result.get('exit_code') != 0:
        raise ValueError('Only a confirmed successful terminal process can be reconciled')
    envelope, proposal = decode_response((job / 'stdout.json').read_text(encoding='utf-8'), task)
    result.update(state='needs_review', accepted=False, summary=proposal['summary'][:1600],
                  proposal_status=proposal['status'], session_id=envelope.get('session_id'), reconciled=True)
    result.pop('reason', None)
    result['source_changed'] = check_sources(task, repo=repo)
    if result['source_changed']:
        result.update(state='stale', reason='Original source changed; create a fresh packet')
    if any(not (job / 'workspace' / f['path']).is_file() or digest((job / 'workspace' / f['path']).read_bytes()) != f['sha256'] for f in task['files']):
        result.update(state='failed', reason='Source snapshot changed')
    save(job / 'proposal.json', proposal)
    save(job / 'result.json', result)
    task['state'] = result['state']
    save(job / 'task.json', task)
    return result


def run(task_id, *, repo=REPO, timeout=180, launcher=None, invoke=subprocess.run):
    if not 1 <= timeout <= 600:
        raise ValueError('Timeout must be 1..600 seconds')
    job, task = load_task(task_id, repo=repo)
    if task['state'] != 'prepared':
        raise ValueError('This task was already dispatched; inspect it, do not blindly replay')
    if check_sources(task, repo=repo):
        raise ValueError('Source changed before dispatch; create a fresh task')
    workspace = job / 'workspace'
    for file in task['files']:
        if digest((workspace / file['path']).read_bytes()) != file['sha256']:
            raise ValueError('Task snapshot changed before dispatch')
    args = (launcher or discover_agent()) + ['--print', '--mode', 'ask', '--output-format', 'json',
                                           '--trust', '--workspace', str(workspace)]
    # This CLI version has no Windows OS sandbox. Keep its ordinary permission
    # policy and this task's hard denies; never alter the user's global settings.
    if os.name != 'nt':
        args.extend(['--sandbox', 'enabled'])
    # A persisted exclusive claim prevents two processes dispatching the same task.
    claim = os.open(job / 'dispatch.lock', os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    os.close(claim)
    task['state'] = 'running'
    save(job / 'task.json', task)
    prompt = ('Read AGENTS.md and TASK.json. Carry out only this offline task using the supplied files. '
              'No shell, MCP, Unity, edits or delegation. Return the required JSON proposal.\n')
    args.append(prompt)  # Native argv, no shell; use the documented positional prompt.
    started = time.monotonic()
    result = {'task_id': task_id, 'state': 'needs_review', 'accepted': False}
    try:
        process = invoke(args, cwd=workspace, stdin=subprocess.DEVNULL, capture_output=True, text=True,
                         encoding='utf-8', errors='replace', timeout=timeout, shell=False)
        (job / 'stdout.json').write_text(process.stdout, encoding='utf-8')
        (job / 'stderr.txt').write_text(process.stderr, encoding='utf-8')
        result['exit_code'] = process.returncode
        if process.returncode:
            result['state'] = 'failed'
            result['reason'] = 'Cursor CLI failed; inspect local stderr; no automatic retry'
        else:
            envelope, proposal = decode_response(process.stdout, task)
            save(job / 'proposal.json', proposal)
            result.update(summary=proposal['summary'][:1600], proposal_status=proposal['status'], session_id=envelope.get('session_id'))
    except subprocess.TimeoutExpired as error:
        for name, partial in [('stdout.json', error.stdout), ('stderr.txt', error.stderr)]:
            if isinstance(partial, bytes):
                partial = partial.decode('utf-8', errors='replace')
            (job / name).write_text(partial or '', encoding='utf-8')
        result.update(state='failed', reason='Cursor CLI timed out; inspect local partial output; do not replay automatically')
    except (OSError, ValueError, KeyError, TypeError) as error:
        result.update(state='failed', reason=type(error).__name__ + ': ' + str(error)[:250])
    result['source_changed'] = check_sources(task, repo=repo)
    if result['source_changed']:
        result.update(state='stale', reason='Original source changed; review against a fresh packet')
    if any(not (workspace / f['path']).is_file() or digest((workspace / f['path']).read_bytes()) != f['sha256'] for f in task['files']):
        result.update(state='failed', reason='The proposal worker modified its source snapshot; do not accept')
    result['seconds'] = round(time.monotonic() - started, 3)
    task['state'] = result['state']
    save(job / 'result.json', result)
    save(job / 'task.json', task)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    p = commands.add_parser('prepare')
    p.add_argument('--goal', required=True)
    p.add_argument('--file', action='append', required=True)
    p.add_argument('--criterion', action='append', required=True)
    p = commands.add_parser('run')
    p.add_argument('task_id')
    p.add_argument('--timeout', type=int, default=180)
    p = commands.add_parser('show')
    p.add_argument('task_id')
    p = commands.add_parser('reconcile')
    p.add_argument('task_id')
    args = parser.parse_args()
    if args.command == 'prepare':
        task = prepare(args.goal, args.file, args.criterion)
        return {'task_id': task['id'], 'state': task['state'], 'files': len(task['files']), 'dispatched': False}
    if args.command == 'run':
        return run(args.task_id, timeout=args.timeout)
    if args.command == 'reconcile':
        return reconcile(args.task_id)
    job, task = load_task(args.task_id)
    return {'task': task, 'result': json.loads((job / 'result.json').read_text(encoding='utf-8')) if (job / 'result.json').exists() else None}


if __name__ == '__main__':
    try:
        value = main()
        print(json.dumps(value, ensure_ascii=False, indent=2))
        if value.get('state') in {'failed', 'stale'}:
            sys.exit(1)
    except (ValueError, OSError) as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False))
        sys.exit(1)
