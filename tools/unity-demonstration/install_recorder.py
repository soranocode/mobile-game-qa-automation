"""Connect the local UPM recorder and migrate verified legacy files. Stop Play first."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import uuid

PACKAGE_NAME = "com.gameqa.demonstrations"
TOOL_ROOT = Path(__file__).resolve().parent
PACKAGE_ROOT = TOOL_ROOT.parents[1] / "packages" / PACKAGE_NAME


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def contained(root, path):
    if not path.resolve().is_relative_to(root.resolve()):
        raise ValueError("Path escapes intended directory: " + path.name)
    if path.is_symlink():
        raise ValueError("Preserving symbolic link: " + path.name)
    return path


def build_plan(project):
    project = Path(project).resolve(strict=True)
    if not all((project / folder).is_dir() for folder in ("Assets", "Packages", "ProjectSettings")):
        raise ValueError("Not a Unity project")
    version_file = project / "ProjectSettings" / "ProjectVersion.txt"
    match = re.search(r"m_EditorVersion:\s*(\d+)\.(\d+)", version_file.read_text(encoding="utf-8-sig"))
    if not match or tuple(map(int, match.groups())) < (6000, 0):
        raise ValueError("Recorder 0.1.0 requires Unity 6000.0 or newer")
    package = json.loads((PACKAGE_ROOT / "package.json").read_text(encoding="utf-8"))
    if package["name"] != PACKAGE_NAME:
        raise ValueError("Unexpected package identity")
    manifest_path = contained(project, project / "Packages" / "manifest.json")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    if not isinstance(manifest.get("dependencies"), dict):
        raise ValueError("Project manifest has no dependency object")
    if (project / "Packages" / PACKAGE_NAME).exists():
        raise ValueError("Embedded recorder package exists; preserve it and resolve its source first")
    try:
        dependency = "file:" + Path(os.path.relpath(PACKAGE_ROOT, project / "Packages")).as_posix()
    except ValueError:
        dependency = "file:" + PACKAGE_ROOT.as_posix()
    hashes = json.loads((TOOL_ROOT / "legacy-recorder-hashes.json").read_text(encoding="utf-8"))["files"]
    legacy_root = contained(project, project / "Assets" / "QaDemonstrations")
    legacy = []
    if legacy_root.exists():
        for source in sorted(legacy_root.rglob("*.cs")):
            contained(legacy_root, source)
            relative = source.relative_to(legacy_root).as_posix()
            if digest(source) not in hashes.get(relative, []):
                raise ValueError("Preserving unknown/local recorder script: " + relative)
            legacy.append(relative)
            if source.with_suffix(".cs.meta").exists():
                contained(legacy_root, source.with_suffix(".cs.meta"))
    return {"project": str(project), "package": PACKAGE_NAME, "version": package["version"],
            "source": str(PACKAGE_ROOT), "dependency": dependency,
            "manifest_change": manifest["dependencies"].get(PACKAGE_NAME) != dependency,
            "manifest_sha256": digest(manifest_path), "legacy_files": legacy,
            "migration_required": bool(legacy), "requires_editor_idle": True}


def apply_plan(plan, migrate_legacy=False):
    project = Path(plan["project"])
    if plan != build_plan(project):
        raise ValueError("Project changed after planning; run installer again")
    if plan["migration_required"] and not migrate_legacy:
        raise ValueError("Verified legacy recorder found; use --migrate-legacy after stopping Play/recording")
    if not plan["manifest_change"] and not plan["legacy_files"]:
        return {"applied": True, "changed": False, "backup": None}
    manifest_path = contained(project, project / "Packages" / "manifest.json")
    original = manifest_path.read_bytes()
    manifest = json.loads(original.decode("utf-8-sig"))
    manifest["dependencies"][PACKAGE_NAME] = plan["dependency"]
    backup_root = contained(project, project / "Library" / "GameQaDemonstrations" / "Migrations")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    backup = contained(project, backup_root / stamp)
    backup.mkdir(parents=True, exist_ok=False)
    # Full manifest backup stays local; it may contain private dependency URLs.
    (backup / "manifest.json.before").write_bytes(original)
    legacy_root = project / "Assets" / "QaDemonstrations"
    pairs = []
    for relative in plan["legacy_files"]:
        for suffix in ("", ".meta"):
            source = contained(legacy_root, legacy_root / (relative + suffix))
            if not source.exists():
                continue
            target = contained(backup, backup / "legacy" / (relative + suffix))
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            pairs.append((source, target))
    receipt = {"schema": "qa-demo-upm-migration/1", "package": PACKAGE_NAME,
               "version": plan["version"], "dependency": plan["dependency"],
               "legacy_files": plan["legacy_files"], "manifest_before_sha256": plan["manifest_sha256"]}
    (backup / "migration.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    temp = manifest_path.with_name("manifest.gameqa-" + uuid.uuid4().hex + ".tmp")
    removed = []
    try:
        for source, saved in pairs:
            if digest(source) != digest(saved):
                raise ValueError("Legacy source changed during backup")
        for source, saved in pairs:
            source.unlink()
            removed.append((source, saved))
        if digest(manifest_path) != plan["manifest_sha256"]:
            raise ValueError("Project manifest changed during migration")
        temp.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        os.replace(temp, manifest_path)
    except Exception:
        for source, saved in removed:
            if not source.exists():
                shutil.copy2(saved, source)
        if temp.exists():
            temp.unlink()
        raise
    return {"applied": True, "changed": True, "backup": str(backup)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True, type=Path)
    parser.add_argument("--apply", action="store_true", help="Connect package; stop Play/recording first")
    parser.add_argument("--migrate-legacy", action="store_true", help="Back up and remove only verified legacy recorder scripts")
    args = parser.parse_args()
    try:
        plan = build_plan(args.project)
        result = apply_plan(plan, args.migrate_legacy) if args.apply else {"applied": False}
        print(json.dumps({**plan, **result}, indent=2))
    except (ValueError, OSError, KeyError) as error:
        raise SystemExit(str(error))


if __name__ == "__main__":
    main()
