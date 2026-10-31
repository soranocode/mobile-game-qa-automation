import json
from pathlib import Path
import tempfile
import unittest

import install


class InstallerTests(unittest.TestCase):
    def setUp(self):
        temp_root = install.ROOT / 'work/adapter-installer-tests'
        temp_root.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=temp_root)
        self.addCleanup(self.temp.cleanup)
        self.project = Path(self.temp.name) / 'game'
        for name in ('Assets', 'Packages', 'ProjectSettings'):
            (self.project / name).mkdir(parents=True)
        self.file = self.project / 'Packages/manifest.json'
        self.original = {'dependencies': {'com.coplaydev.unity-mcp': 'file:local-mcp', 'private.package': 'https://example.invalid/PRIVATE_PLACEHOLDER'}}
        self.file.write_text(json.dumps(self.original), encoding='utf-8')

    def test_plan_does_not_write_or_expose_other_dependencies(self):
        before = self.file.read_bytes()
        planned = install.plan(self.project)
        self.assertEqual(before, self.file.read_bytes())
        self.assertNotIn('PRIVATE_PLACEHOLDER', json.dumps(planned))
        with self.assertRaises(ValueError):
            install.apply(planned)

    def test_apply_preserves_dependencies_and_is_idempotent(self):
        original = self.file.read_bytes()
        self.assertTrue(install.apply(install.plan(self.project), True)['changed'])
        result = json.loads(self.file.read_text(encoding='utf-8'))
        for key, value in self.original['dependencies'].items():
            self.assertEqual(result['dependencies'][key], value)
        self.assertEqual(next((self.project / 'Library/GameQAAgentAdapter/ManifestBackups').glob('*.json')).read_bytes(), original)
        self.assertFalse(install.apply(install.plan(self.project), True)['changed'])

    def test_stale_plan_does_not_replace_changed_manifest(self):
        planned = install.plan(self.project)
        changed = self.file.read_bytes() + b'\n'
        self.file.write_bytes(changed)
        with self.assertRaises(ValueError):
            install.apply(planned, True)
        self.assertEqual(changed, self.file.read_bytes())

    def test_existing_source_is_preserved(self):
        other = self.original.copy()
        other['dependencies'] = dict(other['dependencies'], **{'com.gameqa.agent': 'file:somewhere-else'})
        self.file.write_text(json.dumps(other), encoding='utf-8')
        with self.assertRaises(ValueError):
            install.plan(self.project)

    def test_changed_package_source_invalidates_plan(self):
        package = Path(self.temp.name) / 'adapter'
        package.mkdir()
        (package / 'package.json').write_text(json.dumps({'name': install.PACKAGE_NAME}), encoding='utf-8')
        source = package / 'Command.cs'
        source.write_text('original source', encoding='utf-8')
        planned = install.plan(self.project, package)
        source.write_text('different source', encoding='utf-8')
        with self.assertRaises(ValueError):
            install.apply(planned, True)
        self.assertNotIn(install.PACKAGE_NAME, json.loads(self.file.read_text(encoding='utf-8'))['dependencies'])


if __name__ == '__main__':
    unittest.main()
