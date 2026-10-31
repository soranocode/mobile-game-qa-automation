"""Migration tests on synthetic Unity projects; never launch Unity or a game."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import install_recorder as installer


class PackageInstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.project = self.root / "Game With Spaces"
        for name in ("Assets", "Packages", "ProjectSettings"):
            (self.project / name).mkdir(parents=True)
        (self.project / "ProjectSettings/ProjectVersion.txt").write_text("m_EditorVersion: 6000.0.66f2\n")
        self.manifest = self.project / "Packages/manifest.json"
        self.original = {"dependencies": {"other.package": "1.2.3"}, "scopedRegistries": []}
        self.manifest.write_text(json.dumps(self.original))
        self.tool = self.root / "tools"
        self.tool.mkdir()
        self.legacy_bytes = b"// synthetic owned recorder\n"
        self.hashes = {"files": {"Runtime/Recorder.cs": [hashlib.sha256(self.legacy_bytes).hexdigest()]}}
        (self.tool / "legacy-recorder-hashes.json").write_text(json.dumps(self.hashes))
        self.patch = patch.object(installer, "TOOL_ROOT", self.tool)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def legacy(self):
        source = self.project / "Assets/QaDemonstrations/Runtime/Recorder.cs"
        source.parent.mkdir(parents=True)
        source.write_bytes(self.legacy_bytes)
        source.with_suffix(".cs.meta").write_text("guid: synthetic\n")
        return source

    def test_dry_plan_changes_nothing_and_resolves_from_packages(self):
        source = self.legacy()
        before = self.manifest.read_bytes()
        plan = installer.build_plan(self.project)
        target = (self.project / "Packages" / plan["dependency"][5:]).resolve()
        self.assertEqual(target, installer.PACKAGE_ROOT.resolve())
        self.assertTrue(plan["migration_required"])
        self.assertEqual(self.manifest.read_bytes(), before)
        self.assertEqual(source.read_bytes(), self.legacy_bytes)

    def test_migration_requires_explicit_flag(self):
        source = self.legacy()
        with self.assertRaisesRegex(ValueError, "migrate-legacy"):
            installer.apply_plan(installer.build_plan(self.project))
        self.assertTrue(source.exists())
        self.assertFalse((self.project / "Library").exists())

    def test_migrates_owned_files_backs_up_meta_and_preserves_unrelated_assets(self):
        source = self.legacy()
        scene = source.parent.parent / "DoNotTouch.unity"
        scene.write_text("synthetic scene")
        original = self.manifest.read_bytes()
        result = installer.apply_plan(installer.build_plan(self.project), True)
        backup = Path(result["backup"])
        self.assertEqual((backup / "manifest.json.before").read_bytes(), original)
        self.assertEqual((backup / "legacy/Runtime/Recorder.cs").read_bytes(), self.legacy_bytes)
        self.assertTrue((backup / "legacy/Runtime/Recorder.cs.meta").exists())
        self.assertFalse(source.exists())
        self.assertFalse(source.with_suffix(".cs.meta").exists())
        self.assertEqual(scene.read_text(), "synthetic scene")
        installed = json.loads(self.manifest.read_text())
        self.assertEqual(installed["dependencies"]["other.package"], "1.2.3")
        self.assertEqual(installed["scopedRegistries"], [])
        self.assertIn(installer.PACKAGE_NAME, installed["dependencies"])

    def test_unknown_modified_script_is_preserved(self):
        source = self.legacy()
        source.write_text("// local user change")
        before = self.manifest.read_bytes()
        with self.assertRaisesRegex(ValueError, "unknown/local"):
            installer.build_plan(self.project)
        self.assertEqual(source.read_text(), "// local user change")
        self.assertEqual(self.manifest.read_bytes(), before)

    def test_rollback_if_manifest_replace_fails(self):
        source = self.legacy()
        before = self.manifest.read_bytes()
        with patch.object(installer.os, "replace", side_effect=OSError("synthetic failure")):
            with self.assertRaises(OSError):
                installer.apply_plan(installer.build_plan(self.project), True)
        self.assertEqual(source.read_bytes(), self.legacy_bytes)
        self.assertTrue(source.with_suffix(".cs.meta").exists())
        self.assertEqual(self.manifest.read_bytes(), before)
        self.assertEqual(list(self.manifest.parent.glob("manifest.gameqa-*.tmp")), [])

    def test_idempotent_install_does_not_create_another_backup(self):
        first = installer.apply_plan(installer.build_plan(self.project))
        before = self.manifest.stat().st_mtime_ns
        second = installer.apply_plan(installer.build_plan(self.project))
        self.assertTrue(first["changed"])
        self.assertFalse(second["changed"])
        self.assertIsNone(second["backup"])
        self.assertEqual(self.manifest.stat().st_mtime_ns, before)

    def test_stale_plan_is_rejected(self):
        plan = installer.build_plan(self.project)
        self.manifest.write_text(json.dumps({"dependencies": {"new.change": "2.0.0"}}))
        with self.assertRaisesRegex(ValueError, "changed after planning"):
            installer.apply_plan(plan)

    def test_does_not_override_embedded_package(self):
        (self.project / "Packages" / installer.PACKAGE_NAME).mkdir()
        with self.assertRaisesRegex(ValueError, "Embedded"):
            installer.build_plan(self.project)

    def test_rejects_unsupported_unity_version(self):
        (self.project / "ProjectSettings/ProjectVersion.txt").write_text("m_EditorVersion: 2022.3.1f1\n")
        with self.assertRaisesRegex(ValueError, "6000.0"):
            installer.build_plan(self.project)

    def test_manifest_symlink_cannot_escape_project(self):
        outside = self.root / "outside.json"
        outside.write_text(json.dumps(self.original))
        self.manifest.unlink()
        try:
            self.manifest.symlink_to(outside)
        except OSError:
            self.skipTest("Symlinks unavailable on this Windows account")
        with self.assertRaisesRegex(ValueError, "escapes|symbolic"):
            installer.build_plan(self.project)


if __name__ == "__main__":
    unittest.main()
