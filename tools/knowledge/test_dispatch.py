import copy
import hashlib
import json
from pathlib import Path
import shutil
import tomllib
import unittest
from uuid import uuid4
from unittest.mock import patch

import dispatch


class PacketTests(unittest.TestCase):
    def setUp(self):
        test_root = dispatch.REPO / "work/memory-tests"
        self.repo = test_root / uuid4().hex
        self.repo.mkdir(parents=True)

        def cleanup():
            target = self.repo.resolve()
            if not target.is_relative_to(test_root.resolve()) or target == test_root.resolve():
                raise ValueError("Test cleanup target escaped its workspace")
            shutil.rmtree(target)

        self.addCleanup(cleanup)
        self.knowledge = self.repo / "knowledge"
        self.knowledge.mkdir()
        (self.knowledge / "selected.md").write_text("known scope and stop rules", encoding="utf-8")
        (self.knowledge / "unrelated.md").write_text("irrelevant archive " * 10000, encoding="utf-8")
        (self.repo / "executor.mjs").write_text("export function run() {}", encoding="utf-8")
        self.records = {
            "SELECTED": {"id": "SELECTED", "path": "selected.md", "status": "scoped"},
            "UNRELATED": {"id": "UNRELATED", "path": "unrelated.md", "status": "unknown"},
        }
        self.mission = {"agent": "ocean-quests", "source_ids": ["SELECTED"],
                        "implementation_files": ["executor.mjs"], "entry_point": "executor.mjs#run",
                        "reviewed_sha256": {
                            "SELECTED": hashlib.sha256((self.knowledge / "selected.md").read_bytes()).hexdigest(),
                            "executor.mjs": hashlib.sha256((self.repo / "executor.mjs").read_bytes()).hexdigest()},
                        "brief": {"goal": "hook_use", "stop": ["unknown input outcome"]}}
        self.contract = {"scope": {"runtime": "UnityEditor"}, "global_rules": ["one input owner"],
                         "live_context_required": ["fresh task", "session epoch"],
                         "invalidate_active_plan_on": ["scene changed"],
                         "limits": {"max_packet_chars": 12000, "max_reply_chars": 1600}}

    def build(self, mission=None, contract=None):
        return dispatch.make_packet("hook_use", mission or self.mission, contract or self.contract,
                                    self.records, repo=self.repo, knowledge_root=self.knowledge)

    def test_only_selected_card_body_is_read(self):
        original = Path.read_bytes
        reads = []

        def observe(path):
            reads.append(path.name)
            return original(path)

        with patch.object(Path, "read_bytes", observe):
            result = self.build()
        self.assertEqual(result["status"], "PREPARED_KNOWLEDGE_ONLY")
        self.assertEqual(reads, ["selected.md", "executor.mjs"])
        self.assertNotIn("irrelevant archive", json.dumps(result))
        self.assertEqual(result["metrics"]["selected_cards"], 1)

    def test_changed_card_invalidates_review(self):
        (self.knowledge / "selected.md").write_text("new critical constraint", encoding="utf-8")
        result = self.build()
        self.assertEqual(result["status"], "REVIEW_REQUIRED")
        self.assertEqual(result["changed"], ["SELECTED"])
        self.assertIsNone(result["packet"])

    def test_changed_executor_invalidates_review(self):
        (self.repo / "executor.mjs").write_text("changed", encoding="utf-8")
        self.assertEqual(self.build()["changed"], ["executor.mjs"])

    def test_cache_hit_and_tampering(self):
        result = self.build()
        cached = dispatch.cache_packet(result, self.repo / "cache")
        self.assertFalse(cached["cache_hit"])
        self.assertTrue(dispatch.cache_packet(result, self.repo / "cache")["cache_hit"])
        Path(cached["packet_path"]).write_text("tampered")
        self.assertFalse(dispatch.cache_packet(result, self.repo / "cache")["cache_hit"])

    def test_cache_does_not_bypass_source_review(self):
        cached = dispatch.cache_packet(self.build(), self.repo / "cache")
        (self.repo / "executor.mjs").write_text("new version")
        result = dispatch.cache_packet(self.build(), self.repo / "cache")
        self.assertEqual(result["status"], "REVIEW_REQUIRED")
        self.assertNotIn("packet_path", result)
        self.assertTrue(Path(cached["packet_path"]).is_file())  # Old artifact is retained, never selected.

    def test_budget_never_truncates_constraints(self):
        contract = copy.deepcopy(self.contract)
        contract["limits"]["max_packet_chars"] = 40
        result = self.build(contract=contract)
        self.assertEqual(result["status"], "NEEDS_SPLIT")
        self.assertIsNone(result["packet"])

    def test_static_packet_is_not_authorization_or_live_state(self):
        packet = self.build()["packet"]
        self.assertFalse(packet["execution_authorized"])
        self.assertFalse(packet["live_state_included"])
        self.assertNotIn(str(self.repo), json.dumps(packet))
        self.assertIn("session epoch", packet["live_context_required"])

    def test_guard_change_changes_revision(self):
        before = self.build()["revision"]
        changed = copy.deepcopy(self.contract)
        changed["global_rules"].append("new stop rule")
        self.assertNotEqual(self.build(contract=changed)["revision"], before)

    def test_reply_budget_does_not_forward_an_oversized_transcript(self):
        result = dispatch.validate_reply("x" * 1601, "hook_use", self.mission, 1600)
        self.assertEqual(result["status"], "NEEDS_COMPACT_REPLY")
        self.assertNotIn("reply", result)

    def test_reply_requires_correct_task_and_existing_entry_point(self):
        correct = {"task": "hook_use; offline only", "entry_point": "executor.mjs#run"}
        result = dispatch.validate_reply(json.dumps(correct), "hook_use", self.mission, 1600)
        self.assertEqual(result["status"], "ACCEPTED_MEMORY_REPLY")
        self.assertFalse(result["execution_authorized"])
        correct["entry_point"] = "invented-helper.mjs#teleport"
        self.assertEqual(dispatch.validate_reply(json.dumps(correct), "hook_use", self.mission, 1600)["status"], "INVALID_REPLY")
        self.assertEqual(dispatch.validate_reply("[]", "hook_use", self.mission, 1600)["status"], "INVALID_REPLY")

    def test_paths_cannot_escape_roots(self):
        mission = copy.deepcopy(self.mission)
        mission["implementation_files"] = ["../outside.txt"]
        with self.assertRaises(ValueError):
            self.build(mission=mission)
        self.records["SELECTED"]["path"] = "../outside.txt"
        with self.assertRaises(ValueError):
            self.build()

    def test_symlink_cannot_escape_root(self):
        outside = self.repo / "outside.txt"
        outside.write_text("not a card")
        link = self.knowledge / "linked.md"
        try:
            link.symlink_to(outside)
        except OSError:
            self.skipTest("symlink creation unavailable")
        self.records["SELECTED"]["path"] = "linked.md"
        with self.assertRaises(ValueError):
            self.build()


class RealRegistryTests(unittest.TestCase):
    def test_real_registry_and_every_complete_packet(self):
        registry, contract, records = dispatch.load_registry()
        for name, mission in registry["missions"].items():
            with self.subTest(task=name):
                result = dispatch.make_packet(name, mission, contract, records)
                self.assertEqual(result["status"], "PREPARED_KNOWLEDGE_ONLY", result)
                self.assertLessEqual(result["metrics"]["selected_cards"], 6)
                self.assertLessEqual(result["metrics"]["packet_chars"], contract["limits"]["max_packet_chars"])

    def test_literal_routing_unknown_and_ambiguous(self):
        registry, _, _ = dispatch.load_registry()
        missions = registry["missions"]
        self.assertEqual(dispatch.select_task("Пройди Hook_use", missions), ["hook_use"])
        self.assertEqual(dispatch.select_task("проверка настроек", missions), ["settings"])
        self.assertEqual(dispatch.select_task("отбить акулу", missions), ["shark_defense"])
        for mission in ['intro', 'control', 'wooden_hook', 'shark_attack']:
            self.assertEqual(dispatch.select_task(mission, missions), [mission])
        self.assertEqual(dispatch.select_task("hook_use_fake", missions), [])
        self.assertEqual(dispatch.select_task("неизвестная миссия", missions), [])
        self.assertEqual(len(dispatch.select_task("hook_use и настройки", missions)), 2)

    def test_agent_configs_have_no_model_or_permission_override(self):
        paths = list((dispatch.REPO / ".codex/agents").glob("ocean-*.toml"))
        self.assertEqual(len(paths), 6)
        for path in paths:
            agent = tomllib.loads(path.read_text(encoding="utf-8"))
            self.assertTrue(all(agent.get(key) for key in ["name", "description", "developer_instructions"]))
            self.assertTrue(set(agent).isdisjoint({"model", "model_reasoning_effort", "approval_policy", "sandbox_mode", "mcp_servers"}))


if __name__ == "__main__":
    unittest.main()
