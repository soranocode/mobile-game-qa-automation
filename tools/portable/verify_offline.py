"""Run portable-memory and controller checks with fake transport; never starts Unity."""
import json
import os
from pathlib import Path
import subprocess
import sys

REPO = Path(__file__).resolve().parents[2]


def main():
    temporary = REPO / 'work/portable-checks'
    temporary.mkdir(parents=True, exist_ok=True)
    environment = {**os.environ, 'TMP': str(temporary), 'TEMP': str(temporary), 'PYTHONUTF8': '1'}
    commands = [[sys.executable, 'tools/portable/bootstrap.py', 'check']]
    for folder in ['tools/knowledge', 'tools/unity-demonstration', 'tools/portable',
                   'projects/ocean-nomad/tools/raft-navigation']:
        if list((REPO / folder).glob('test_*.py')):
            commands.append([sys.executable, '-m', 'unittest', 'discover', '-s', folder, '-p', 'test_*.py'])
    tests = sorted(str(p.relative_to(REPO)) for base in ['tools', 'projects/ocean-nomad/tools']
                   for p in (REPO / base).rglob('*.test.mjs'))
    commands.append(['node', '--experimental-test-isolation=none', '--test', *tests])
    results = []
    for command in commands:
        result = subprocess.run(command, cwd=REPO, env=environment, capture_output=True, text=True, encoding='utf-8', errors='replace')
        results.append({'command': command[:6], 'exit_code': result.returncode,
                        'output': (result.stdout + result.stderr)[-5000:]})
        if result.returncode:
            break
    folder = REPO / 'brain-store/portable-runtime'; folder.mkdir(parents=True, exist_ok=True)
    (folder / 'offline-verification.json').write_text(json.dumps(results, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({'status': 'OFFLINE_PASS' if all(r['exit_code']==0 for r in results) else 'OFFLINE_FAIL',
                      'commands': len(results), 'node_test_files': len(tests), 'gameplay_started': False,
                      'evidence': 'brain-store/portable-runtime/offline-verification.json'}, ensure_ascii=False))
    if any(r['exit_code'] for r in results):
        print(results[-1]['output']); return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
