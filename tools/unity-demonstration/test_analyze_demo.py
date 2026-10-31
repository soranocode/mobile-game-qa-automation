#!/usr/bin/env python3
"""Unit tests for analyze_demo.py using synthetic fixtures only.

Fixtures are synthetic test data in code, not evidence of real user gameplay.
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict, List, Optional

from analyze_demo import (
    analyze_events,
    analyze_session,
    load_events_ndjson,
    summarize_quest_world,
    write_summary,
)


def _event(
    seq: int,
    kind: str,
    t_ms: float,
    data: Dict[str, Any],
    *,
    session_id: str = "test-session",
    frame: Optional[int] = None,
) -> Dict[str, Any]:
    return {
        "schema": "ocean-demo/1",
        "session_id": session_id,
        "seq": seq,
        "kind": kind,
        "frame": frame if frame is not None else seq * 2,
        "t_ms": t_ms,
        "utc": "2026-10-21T00:00:00Z",
        "data": data,
    }


def _input(
    seq: int,
    t_ms: float,
    *,
    keys_held: Optional[List[str]] = None,
    keys_down: Optional[List[str]] = None,
    keys_up: Optional[List[str]] = None,
    mouse_held: Optional[List[int]] = None,
    mouse_down: Optional[List[int]] = None,
    mouse_up: Optional[List[int]] = None,
) -> Dict[str, Any]:
    return _event(
        seq,
        "input",
        t_ms,
        {
            "keys_held": keys_held or [],
            "keys_down": keys_down or [],
            "keys_up": keys_up or [],
            "mouse_held": mouse_held or [],
            "mouse_down": mouse_down or [],
            "mouse_up": mouse_up or [],
            "mouse_position": [0.0, 0.0],
            "mouse_delta": [0.0, 0.0],
            "mouse_scroll": [0.0, 0.0],
            "axes": {},
            "focused": True,
            "capture_allowed": True,
            "suppressed_reason": None,
            "ui_hit": None,
        },
    )


def _state(
    seq: int,
    t_ms: float,
    *,
    player: Any = None,
) -> Dict[str, Any]:
    return _event(
        seq,
        "state",
        t_ms,
        {
            "player": player,
            "camera": None,
            "game_signals": None,
        },
    )


def _player(
    instance_id: int,
    scene: str,
    position: List[float],
    grounded: bool,
) -> Dict[str, Any]:
    return {
        "instance_id": instance_id,
        "scene": scene,
        "position": position,
        "rotation": [0.0, 0.0, 0.0, 1.0],
        "grounded": grounded,
        "parent_id": None,
        "local_position": position,
    }


class AnalyzeDemoTests(unittest.TestCase):
    def test_requested_video_failure_is_reported_despite_complete_journal(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            meta = {"schema": "ocean-demo/1", "session_id": "test-session", "finalized": True,
                    "complete": True, "video_recorded": False,
                    "video": {"requested": True, "status": "failed"}}
            (root / "session.json").write_text(json.dumps(meta), encoding="utf-8")
            events = [_event(0, "session_start", 0, {}), _event(1, "session_end", 100, {})]
            (root / "events.ndjson").write_text("".join(json.dumps(e) + "\n" for e in events), encoding="utf-8")
            summary = analyze_session(root)
            self.assertEqual(summary["completeness"]["status"], "complete")
            self.assertIn("video_incomplete", [i["code"] for i in summary["issues"]])
            meta["video_recorded"] = True
            meta["video"]["status"] = "file_written"
            (root / "session.json").write_text(json.dumps(meta), encoding="utf-8")
            self.assertIn("video_file_missing", [i["code"] for i in analyze_session(root)["issues"]])

    def test_finalized_metadata_does_not_hide_writer_failure(self) -> None:
        events = [_event(0, "session_start", 0, {}),
                  _event(1, "session_end", 10, {"writer_flush_ok": True})]
        for extra in ({"complete": False}, {"writer_error": "disk full"},
                      {"events_accepted": 5, "events_written": 4}):
            with self.subTest(extra=extra):
                meta = {"session_id": "test-session", "finalized": True, "complete": True, **extra}
                summary = analyze_events(events, meta)
                self.assertEqual(summary["completeness"]["status"], "incomplete")
                self.assertFalse(summary["completeness"]["writer_flush_ok"])

    def test_pending_end_needs_final_metadata(self) -> None:
        events = [_event(0, "session_start", 0, {}),
                  _event(1, "session_end", 10, {"writer_status": "pending_flush"})]
        good = {"session_id": "test-session", "finalized": True, "complete": True,
                "events_accepted": 2, "events_written": 2, "writer_error": None}
        self.assertEqual(analyze_events(events, good)["completeness"]["status"], "complete")
        self.assertNotEqual(analyze_events(events, {"session_id": "test-session"})["completeness"]["status"], "complete")

    def test_jump_landing_not_linked_across_gap_or_missing_state(self) -> None:
        for middle in ([
            _event(3, "gap_start", 25, {"reason": "focus_lost"}),
            _event(4, "gap_end", 35, {"reason": "focus_lost"}),
        ], [_state(3, 30, player=None)]):
            with self.subTest(middle=middle):
                events = [_event(0, "session_start", 0, {}),
                          _state(1, 10, player=_player(1, "Map", [0, 0, 0], True)),
                          _state(2, 20, player=_player(1, "Map", [0, 1, 0], False)),
                          *middle,
                          _state(5, 40, player=_player(1, "Map", [0, 0, 0], True)),
                          _event(6, "session_end", 50, {})]
                candidates = analyze_events(events)["jump_candidates"]["candidates"]
                self.assertEqual(len(candidates), 1)
                self.assertIsNone(candidates[0]["landing_t_ms"])

    def test_untrusted_session_id_cannot_choose_output_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "summaries"
            result = write_summary({"session_id": "../../escape"}, output)
            self.assertEqual(result.resolve().parent, output.resolve())
            self.assertTrue(result.is_file())

    def test_overlapping_w_and_space_holds_form_chord(self) -> None:
        events = [
            _event(0, "session_start", 0.0, {"profile_id": "ocean-nomad-editor-v1"}),
            _input(1, 10.0, keys_down=["W"], keys_held=["W"]),
            _input(2, 20.0, keys_down=["Space"], keys_held=["W", "Space"]),
            _input(3, 50.0, keys_up=["Space"], keys_held=["W"]),
            _input(4, 80.0, keys_up=["W"], keys_held=[]),
            _event(5, "marker", 90.0, {"label": "sync", "marker_id": "m1"}),
            _event(6, "session_end", 100.0, {"reason": "user_stop", "writer_flush_ok": True}),
        ]
        summary = analyze_events(events, {"session_id": "test-session", "completion": {"finalized": True}})
        keys = {h["key"]: h for h in summary["key_holds"]}
        self.assertIn("W", keys)
        self.assertIn("Space", keys)
        self.assertTrue(keys["W"]["start_observed"])
        self.assertTrue(keys["W"]["end_observed"])
        self.assertTrue(keys["Space"]["start_observed"])
        self.assertTrue(keys["Space"]["end_observed"])
        chord_keys = [tuple(c["keys"]) for c in summary["chords"]]
        self.assertIn(("Space", "W"), chord_keys)
        overlap = next(c for c in summary["chords"] if c["keys"] == ["Space", "W"])
        self.assertEqual(overlap["start_t_ms"], 20.0)
        self.assertEqual(overlap["end_t_ms"], 50.0)
        self.assertEqual(len(summary["markers"]), 1)
        self.assertEqual(summary["markers"][0]["label"], "sync")
        # Space alone must not produce a successful jump claim
        self.assertEqual(summary["jump_candidates"]["successful_jumps"], "unknown")

    def test_held_key_at_capture_start_not_start_observed(self) -> None:
        events = [
            _event(0, "session_start", 0.0, {}),
            # W already held; no keys_down edge
            _input(1, 5.0, keys_held=["W"]),
            _input(2, 40.0, keys_up=["W"], keys_held=[]),
            _event(3, "session_end", 50.0, {"writer_flush_ok": True}),
        ]
        summary = analyze_events(events, {"session_id": "test-session"})
        self.assertEqual(len(summary["key_holds"]), 1)
        hold = summary["key_holds"][0]
        self.assertEqual(hold["key"], "W")
        self.assertFalse(hold["start_observed"])
        self.assertTrue(hold["end_observed"])
        self.assertEqual(hold["end_reason"], "key_up")

    def test_focus_loss_interrupts_hold_without_fabricated_release(self) -> None:
        events = [
            _event(0, "session_start", 0.0, {}),
            _input(1, 10.0, keys_down=["A"], keys_held=["A"]),
            _event(2, "gap_start", 30.0, {"reason": "focus_lost"}),
            _event(3, "gap_end", 80.0, {"reason": "focus_lost"}),
            # After gap, A is no longer held; no keys_up was observed
            _input(4, 90.0, keys_held=[]),
            _event(5, "session_end", 100.0, {"writer_flush_ok": True}),
        ]
        summary = analyze_events(events, {"session_id": "test-session"})
        self.assertEqual(len(summary["key_holds"]), 1)
        hold = summary["key_holds"][0]
        self.assertEqual(hold["key"], "A")
        self.assertTrue(hold["start_observed"])
        self.assertFalse(hold["end_observed"])
        self.assertEqual(hold["end_reason"], "gap_interrupt")
        self.assertEqual(hold["end_t_ms"], 30.0)
        self.assertEqual(len(summary["gaps"]), 1)
        self.assertEqual(summary["gaps"][0]["reason"], "focus_lost")
        self.assertTrue(summary["gaps"][0]["complete"])
        focus_gaps = summary["input_coverage"]["focus_or_pause_gaps"]
        self.assertEqual(len(focus_gaps), 1)

    def test_truncated_final_line_reported(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "session.json").write_text(
                json.dumps({"schema": "ocean-demo/1", "session_id": "test-session"}),
                encoding="utf-8",
            )
            # Complete lines + incomplete final JSON (no trailing newline)
            ndjson = (
                json.dumps(_event(0, "session_start", 0.0, {}))
                + "\n"
                + json.dumps(_input(1, 10.0, keys_down=["W"], keys_held=["W"]))
                + "\n"
                + '{"schema":"ocean-demo/1","session_id":"test-session","seq":2'
            )
            (root / "events.ndjson").write_text(ndjson, encoding="utf-8")
            events, issues, truncated = load_events_ndjson(root)
            self.assertTrue(truncated)
            self.assertTrue(any(i["code"] == "truncated_final_line" for i in issues))
            self.assertEqual(len(events), 2)
            summary = analyze_session(root)
            codes = {i["code"] for i in summary["issues"]}
            self.assertIn("truncated_final_line", codes)
            # Open hold closed without fabricating an observed release
            self.assertEqual(len(summary["key_holds"]), 1)
            self.assertFalse(summary["key_holds"][0]["end_observed"])
            self.assertEqual(summary["key_holds"][0]["end_reason"], "truncated")

    def test_missing_session_end_incomplete(self) -> None:
        events = [
            _event(0, "session_start", 0.0, {}),
            _input(1, 10.0, keys_down=["D"], keys_held=["D"]),
            _input(2, 20.0, keys_up=["D"], keys_held=[]),
        ]
        summary = analyze_events(events, {"session_id": "test-session"})
        self.assertFalse(summary["completeness"]["has_session_end"])
        self.assertEqual(summary["completeness"]["status"], "incomplete")
        self.assertTrue(any(i["code"] == "missing_session_end" for i in summary["issues"]))

    def test_invalid_sequence_and_timestamp(self) -> None:
        events = [
            _event(0, "session_start", 0.0, {}),
            _input(1, 10.0, keys_down=["W"], keys_held=["W"]),
            _input(3, 5.0, keys_held=["W"]),  # t_ms backwards
            _input(2, 20.0, keys_up=["W"], keys_held=[]),  # seq backwards vs prev accepted
            _event(4, "session_end", 30.0, {}),
        ]
        # After seq=1, next is seq=3 (ok), t_ms 5 < 10 → invalid_timestamp
        # Then seq=2 < 3 → invalid_sequence
        summary = analyze_events(events, {"session_id": "test-session"})
        codes = {i["code"] for i in summary["issues"]}
        self.assertIn("invalid_timestamp", codes)
        self.assertIn("invalid_sequence", codes)

    def test_scene_or_player_identity_change_does_not_sum_motion(self) -> None:
        events = [
            _event(0, "session_start", 0.0, {}),
            _state(1, 10.0, player=_player(1, "Island", [0.0, 0.0, 0.0], True)),
            _state(2, 20.0, player=_player(1, "Island", [3.0, 0.0, 4.0], True)),  # path 5
            _event(3, "scene", 25.0, {"name": "Harbor", "path": "Assets/Harbor.unity", "loaded": True}),
            _state(4, 30.0, player=_player(1, "Harbor", [10.0, 0.0, 10.0], True)),
            _state(5, 40.0, player=_player(1, "Harbor", [10.0, 0.0, 13.0], True)),  # path 3
            # New player instance in same scene
            _state(6, 50.0, player=_player(99, "Harbor", [0.0, 0.0, 0.0], True)),
            _state(7, 60.0, player=_player(99, "Harbor", [0.0, 0.0, 2.0], True)),  # path 2
            _event(8, "session_end", 70.0, {}),
        ]
        summary = analyze_events(events, {"session_id": "test-session"})
        segments = summary["motion_segments"]
        self.assertEqual(len(segments), 3)
        self.assertAlmostEqual(segments[0]["path_length_unity_units"], 5.0)
        self.assertEqual(segments[0]["scene"], "Island")
        self.assertAlmostEqual(segments[1]["path_length_unity_units"], 3.0)
        self.assertEqual(segments[1]["scene"], "Harbor")
        self.assertEqual(segments[1]["instance_id"], 1)
        self.assertAlmostEqual(segments[2]["path_length_unity_units"], 2.0)
        self.assertEqual(segments[2]["instance_id"], 99)
        # No single summed total across identity changes
        self.assertNotIn("total_path_length_unity_units", summary)

    def test_unavailable_state_reports_unknown_not_zero_success(self) -> None:
        events = [
            _event(0, "session_start", 0.0, {}),
            _input(1, 10.0, keys_down=["Space"], keys_held=["Space"]),
            _input(2, 20.0, keys_up=["Space"], keys_held=[]),
            _state(3, 15.0, player=None),
            _state(4, 25.0, player=None),
            _event(5, "session_end", 40.0, {}),
        ]
        summary = analyze_events(events, {"session_id": "test-session"})
        self.assertEqual(summary["state_availability"]["status"], "unavailable")
        self.assertEqual(summary["jump_candidates"]["status"], "unknown")
        self.assertEqual(summary["jump_candidates"]["candidates"], [])
        self.assertEqual(summary["jump_candidates"]["successful_jumps"], "unknown")
        # Must not invent zero successes
        self.assertNotEqual(summary["jump_candidates"]["successful_jumps"], 0)
        self.assertEqual(summary["motion_segments"], [])

    def test_grounded_transition_is_candidate_not_success(self) -> None:
        events = [
            _event(0, "session_start", 0.0, {}),
            _input(1, 100.0, keys_down=["Space"], keys_held=["Space"]),
            _state(2, 110.0, player=_player(1, "Island", [0.0, 0.0, 0.0], True)),
            _state(3, 130.0, player=_player(1, "Island", [0.0, 1.0, 0.0], False)),
            _input(4, 140.0, keys_up=["Space"], keys_held=[]),
            _state(5, 200.0, player=_player(1, "Island", [0.0, 0.0, 0.0], True)),
            _event(6, "session_end", 250.0, {}),
        ]
        summary = analyze_events(events, {"session_id": "test-session"})
        jc = summary["jump_candidates"]
        self.assertEqual(jc["successful_jumps"], "unknown")
        self.assertGreaterEqual(len(jc["candidates"]), 1)
        cand = jc["candidates"][0]
        self.assertEqual(cand["status"], "candidate")
        self.assertEqual(cand["space_in_attribution_window"], True)

    def test_module_failure_is_reported_even_with_session_end(self) -> None:
        events = [
            _event(0, "session_start", 0, {}),
            _event(1, "module_error", 10, {"phase": "state_sampled", "error_type": "InvalidOperationException"}),
            _event(2, "session_end", 20, {"writer_flush_ok": True}),
        ]
        summary = analyze_events(events)
        self.assertTrue(any(item["code"] == "module_error" and item["severity"] == "error" for item in summary["issues"]))

    def test_quest_world_telemetry_preserves_refs_and_does_not_infer_completion(self) -> None:
        events = [
            _event(0, "module", 0, {"module_id": "ocean.quest-world", "event_name": "quest_snapshot", "payload": {
                "availability": "available", "active_quests": [{"uid": "hands_collect"}],
                "history_completed_observed_quest_uids": ["hands_collect"]}}),
            _event(1, "module", 10, {"module_id": "ocean.quest-world", "event_name": "spatial_snapshot", "payload": {
                "targets": [{"uid": "LogTutotial", "instance_id": 123, "position_world": [1, 2, 3], "is_taken": False}]}}),
        ]
        result = summarize_quest_world(events)
        self.assertEqual(result["completion"], "not_inferred")
        self.assertEqual(result["events"]["spatial_snapshot"]["last_seq"], 1)
        self.assertEqual(result["last_active_quest_uids"], ["hands_collect"])
        self.assertEqual(result["last_targets"][0]["position_world"], [1, 2, 3])
        self.assertFalse(result["last_targets"][0]["is_taken"])

    def test_missing_or_invalid_quest_module_remains_unknown(self) -> None:
        result = summarize_quest_world([_event(0, "input", 0, {}),
            _event(1, "module", 1, {"module_id": "other", "event_name": "quest_snapshot", "payload": {}}),
            _event(2, "module", 2, {"module_id": "ocean.quest-world", "event_name": "quest_snapshot", "payload": "invalid"})])
        self.assertEqual(result["status"], "not_recorded")
        self.assertIsNone(result["last_active_quest_uids"])
        self.assertIsNone(result["last_targets"])

    def test_cli_write_summary_outside_session(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            session = root / "session"
            out = root / "out"
            session.mkdir()
            out.mkdir()
            (session / "session.json").write_text(
                json.dumps(
                    {
                        "schema": "ocean-demo/1",
                        "session_id": "test-session",
                        "completion": {"finalized": True, "writer_flush_ok": True},
                    }
                ),
                encoding="utf-8",
            )
            lines = [
                _event(0, "session_start", 0.0, {}),
                _input(1, 10.0, keys_down=["W"], keys_held=["W"]),
                _input(2, 20.0, keys_up=["W"], keys_held=[]),
                _event(3, "session_end", 30.0, {"writer_flush_ok": True}),
            ]
            (session / "events.ndjson").write_text(
                "\n".join(json.dumps(e) for e in lines) + "\n",
                encoding="utf-8",
            )
            summary = analyze_session(session)
            path = write_summary(summary, out)
            self.assertTrue(path.is_file())
            self.assertTrue(path.name.endswith("-analysis.json"))
            loaded = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(loaded["schema"], "ocean-demo-analysis/1")
            self.assertEqual(loaded["units"]["time"], "ms")
            self.assertEqual(loaded["units"]["distance"], "unity_units")


if __name__ == "__main__":
    unittest.main()
