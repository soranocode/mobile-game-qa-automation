"""Restore machine-local paths and verify portable QA memory without Unity input."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlparse

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / 'tools/knowledge'))
import dispatch


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def endpoint_ok(value):
    url = urlparse(value)
    return url.scheme == 'http' and url.hostname in {'127.0.0.1', 'localhost', '::1'} and not url.username and not url.password and url.path == '/mcp' and not url.query and not url.fragment


def local_config(game, endpoint):
    game = Path(game).expanduser().resolve()
    if not endpoint_ok(endpoint):
        raise ValueError('Use a loopback HTTP MCP endpoint ending in /mcp')
    if not (game / 'ProjectSettings/ProjectVersion.txt').is_file() or not (game / 'Assets').is_dir():
        raise ValueError('A local Unity project with Assets and ProjectSettings is required')
    return {'schema': 'ocean-qa-local/1', 'gameProject': str(game), 'endpoint': endpoint,
            'artifactDirectory': 'brain-store/portable-runtime'}


def prepare_memory():
    registry, contract, records = dispatch.load_registry()
    packets = {name: dispatch.make_packet(name, mission, contract, records)
               for name, mission in registry['missions'].items()}
    bad = {name: {k: packet[k] for k in ['status', 'reason', 'changed'] if k in packet}
           for name, packet in packets.items() if packet['status'] != 'PREPARED_KNOWLEDGE_ONLY'}
    if bad:
        raise ValueError('Memory review required: ' + json.dumps(bad, ensure_ascii=False))
    folder = REPO / 'brain-store/portable-runtime'
    folder.mkdir(parents=True, exist_ok=True)
    payload = {'schema': 'ocean-portable-packets/1', 'execution_authorized': False,
               'registry_sha256': digest(dispatch.REGISTRY_PATH),
               'index_sha256': digest(dispatch.KNOWLEDGE_ROOT / 'index.json'), 'packets': packets}
    (folder / 'packets.json').write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return packets


def check(local=False):
    manifest = json.loads((REPO / 'config/portable-release.json').read_text(encoding='utf-8'))
    for relative in manifest['required_files']:
        if not (REPO / relative).is_file():
            raise ValueError('Missing portable component: ' + relative)
    packets = prepare_memory()
    result = {'status': 'OFFLINE_READY', 'scope': 'Unity Editor', 'gameplay_started': False,
              'packets': {name: {'status': p['status'], 'revision': p['revision']} for name, p in packets.items()}}
    if local:
        settings = json.loads((REPO / 'qa.local.json').read_text(encoding='utf-8'))
        if settings.get('schema') != 'ocean-qa-local/1':
            raise ValueError('Unknown local configuration schema')
        cfg = local_config(settings['gameProject'], settings['endpoint'])
        version = (Path(cfg['gameProject']) / 'ProjectSettings/ProjectVersion.txt').read_text(encoding='utf-8')
        if 'm_EditorVersion: ' + manifest['tested_environment']['unity'] not in version.splitlines():
            raise ValueError('Unity version differs from the reviewed profile; review compatibility first')
        node = subprocess.run(['node', '--version'], capture_output=True, text=True, check=True).stdout.strip()
        if int(node.lstrip('v').split('.')[0]) < 24:
            raise ValueError('Node 24 or later required for this portable runtime/check profile')
        # Read just the recorder dependency; never print or copy the game's complete manifest.
        dependencies = json.loads((Path(cfg['gameProject']) / 'Packages/manifest.json').read_text(encoding='utf-8')).get('dependencies', {})
        result.update(status='LOCAL_PATHS_READY', node=node, unity=manifest['tested_environment']['unity'],
                      recorder_dependency_present='com.gameqa.demonstrations' in dependencies,
                      mcp_connection='NOT_CHECKED', live_skill_verification='NOT_RUN')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    init = commands.add_parser('init')
    init.add_argument('--game-project', required=True)
    init.add_argument('--endpoint', default='http://127.0.0.1:8080/mcp')
    init.add_argument('--replace', action='store_true')
    verify = commands.add_parser('check')
    verify.add_argument('--local', action='store_true')
    args = parser.parse_args()
    if args.command == 'init':
        path = REPO / 'qa.local.json'
        if path.exists() and not args.replace:
            raise ValueError('qa.local.json already exists; use --replace for an intentional local change')
        cfg = local_config(args.game_project, args.endpoint)
        path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        return {'status': 'LOCAL_CONFIG_CREATED', 'path': 'qa.local.json', 'gameplay_started': False}
    return check(local=args.local)


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    try:
        print(json.dumps(main(), ensure_ascii=False, indent=2))
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print(json.dumps({'status': 'SETUP_REQUIRED', 'error': str(error)}, ensure_ascii=False))
        raise SystemExit(1)
