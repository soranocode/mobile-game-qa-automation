"""Plan or attach the local Editor adapter package. Never prints the private game manifest."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[2]
PACKAGE_NAME = 'com.gameqa.agent'
PACKAGE = ROOT / 'packages' / PACKAGE_NAME


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def package_digest(package):
    result = hashlib.sha256()
    for path in sorted(p for p in package.rglob('*') if p.is_file()):
        if path.is_symlink() or not path.resolve().is_relative_to(package):
            raise ValueError('Preserve redirected package source')
        result.update(path.relative_to(package).as_posix().encode('utf-8') + b'\0')
        result.update(path.read_bytes() + b'\0')
    return result.hexdigest()


def plan(project, package=PACKAGE):
    project, package = Path(project).resolve(strict=True), Path(package).resolve(strict=True)
    if not all((project / p).is_dir() for p in ('Assets', 'Packages', 'ProjectSettings')):
        raise ValueError('Unity project required')
    manifest_file = project / 'Packages/manifest.json'
    if not manifest_file.resolve().is_relative_to(project) or manifest_file.is_symlink():
        raise ValueError('Preserve redirected manifest')
    raw = manifest_file.read_bytes()
    manifest = json.loads(raw.decode('utf-8-sig'))
    dependencies = manifest.get('dependencies')
    if not isinstance(dependencies, dict) or 'com.coplaydev.unity-mcp' not in dependencies:
        raise ValueError('Install Coplay Unity MCP first')
    if json.loads((package / 'package.json').read_text(encoding='utf-8'))['name'] != PACKAGE_NAME:
        raise ValueError('Unexpected package identity')
    if (project / 'Packages' / PACKAGE_NAME).exists():
        raise ValueError('Preserve existing embedded adapter')
    try:
        dependency = 'file:' + Path(os.path.relpath(package, project / 'Packages')).as_posix()
    except ValueError:
        dependency = 'file:' + package.as_posix()
    previous = dependencies.get(PACKAGE_NAME)
    if previous is not None and previous != dependency:
        raise ValueError('Preserve adapter from a different source; resolve manually')
    return {'project': str(project), 'source': str(package), 'dependency': dependency,
            'manifest_sha256': digest(raw), 'package_sha256': package_digest(package),
            'change': previous != dependency, 'requires_editor_idle': True}


def apply(expected, editor_idle=False):
    if not editor_idle:
        raise ValueError('Verify Play/recording/test runner are stopped before --apply --editor-idle-confirmed')
    current = plan(expected['project'], expected['source'])
    if current != expected:
        raise ValueError('Manifest/source changed since plan; preserve it and plan again')
    if not current['change']:
        return {'applied': True, 'changed': False}
    project = Path(current['project'])
    manifest_file = project / 'Packages/manifest.json'
    raw = manifest_file.read_bytes()
    if digest(raw) != current['manifest_sha256']:
        raise ValueError('Manifest changed before write')
    document = json.loads(raw.decode('utf-8-sig'))
    document['dependencies'][PACKAGE_NAME] = current['dependency']
    backup = project / 'Library/GameQAAgentAdapter/ManifestBackups'
    if not backup.resolve().is_relative_to(project):
        raise ValueError('Preserve redirected backup directory')
    backup.mkdir(parents=True, exist_ok=True)
    # Contains private dependency URLs. Keep this backup inside local Library, never in automation Git.
    (backup / (uuid.uuid4().hex + '.json')).write_bytes(raw)
    encoded = (json.dumps(document, indent=2, ensure_ascii=False) + '\n').encode('utf-8')
    fd, temp = tempfile.mkstemp(prefix='gameqa-', suffix='.tmp', dir=manifest_file.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(encoded)
        if digest(manifest_file.read_bytes()) != current['manifest_sha256']:
            raise ValueError('Manifest changed during write; no replacement')
        os.replace(temp, manifest_file)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
    return {'applied': True, 'changed': True, 'backup_local_only': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--editor-idle-confirmed', action='store_true')
    args = parser.parse_args()
    planned = plan(args.project)
    result = apply(planned, args.editor_idle_confirmed) if args.apply else {'applied': False}
    print(json.dumps({**planned, **result}))


if __name__ == '__main__':
    main()
