#!/usr/bin/env python3
"""Offline analyzer for demonstration log v1 (ocean-demo/1).

Standard-library only. Reads a session folder (session.json + events.ndjson)
and writes a summary JSON. Importable analysis helpers are exposed for tests.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

SCHEMA_EVENT = "ocean-demo/1"
SCHEMA_ANALYSIS = "ocean-demo-analysis/1"
ANALYSIS_VERSION = 1

# Human-confirmed binding (FORMAT.md): Space triggers jump intent.
JUMP_KEY = "Space"
# Attribution window around takeoff for Space correlation (ms). Not physical precision.
JUMP_ATTRIBUTION_WINDOW_MS = 250

REQUIRED_EVENT_FIELDS = ("schema", "session_id", "seq", "kind", "frame", "t_ms", "utc", "data")


def _is_finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def _issue(
    code: str,
    message: str,
    *,
    severity: str = "warning",
    seq: Optional[int] = None,
    line: Optional[int] = None,
) -> Dict[str, Any]:
    item: Dict[str, Any] = {
        "severity": severity,
        "code": code,
        "message": message,
    }
    if seq is not None:
        item["seq"] = seq
    if line is not None:
        item["line"] = line
    return item


def load_session_metadata(session_dir: Path) -> Tuple[Optional[Dict[str, Any]], List[Dict[str, Any]]]:
    """Load session.json defensively. Returns (metadata or None, issues)."""
    issues: List[Dict[str, Any]] = []
    path = session_dir / "session.json"
    if not path.is_file():
        issues.append(_issue("missing_session_json", "session.json not found", severity="error"))
        return None, issues
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        issues.append(_issue("session_json_read_error", f"Could not read session.json: {exc}", severity="error"))
        return None, issues
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        issues.append(
            _issue(
                "session_json_malformed",
                f"session.json is not valid JSON: {exc.msg}",
                severity="error",
            )
        )
        return None, issues
    if not isinstance(data, dict):
        issues.append(_issue("session_json_malformed", "session.json root must be an object", severity="error"))
        return None, issues
    return data, issues


def load_events_ndjson(session_dir: Path) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], bool]:
    """Load events.ndjson defensively.

    Returns (parsed_events, issues, truncated_final_line).
    Incomplete final line is reported and skipped; prior events are kept.
    """
    issues: List[Dict[str, Any]] = []
    path = session_dir / "events.ndjson"
    if not path.is_file():
        issues.append(_issue("missing_events_ndjson", "events.ndjson not found", severity="error"))
        return [], issues, False

    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        issues.append(_issue("events_read_error", f"Could not read events.ndjson: {exc}", severity="error"))
        return [], issues, False

    if raw == "":
        return [], issues, False

    lines = raw.splitlines(keepends=False)
    # Detect incomplete final line: file does not end with newline and last line is non-empty.
    truncated_final = not raw.endswith(("\n", "\r")) and bool(lines) and bool(lines[-1].strip())

    events: List[Dict[str, Any]] = []
    for index, line in enumerate(lines, start=1):
        stripped = line.strip()
        if not stripped:
            continue
        is_last = index == len(lines)
        try:
            obj = json.loads(stripped)
        except json.JSONDecodeError as exc:
            if is_last and truncated_final:
                issues.append(
                    _issue(
                        "truncated_final_line",
                        f"Final events.ndjson line is incomplete JSON: {exc.msg}",
                        severity="error",
                        line=index,
                    )
                )
            else:
                issues.append(
                    _issue(
                        "malformed_event_line",
                        f"Line {index} is not valid JSON: {exc.msg}",
                        severity="error",
                        line=index,
                    )
                )
            continue
        if not isinstance(obj, dict):
            issues.append(
                _issue(
                    "malformed_event_line",
                    f"Line {index} JSON root must be an object",
                    severity="error",
                    line=index,
                )
            )
            continue
        events.append(obj)

    if truncated_final and events and not any(i["code"] == "truncated_final_line" for i in issues):
        # Last line parsed (rare) but file lacked trailing newline — still note incompleteness risk.
        issues.append(
            _issue(
                "truncated_final_line",
                "events.ndjson does not end with a newline; final record may be incomplete",
                severity="warning",
                line=len(lines),
            )
        )

    return events, issues, truncated_final


def _validate_common_fields(
    event: Dict[str, Any],
    *,
    expected_session_id: Optional[str],
    prev_seq: Optional[int],
    prev_t_ms: Optional[float],
) -> List[Dict[str, Any]]:
    issues: List[Dict[str, Any]] = []
    seq = event.get("seq")
    seq_int: Optional[int] = seq if isinstance(seq, int) and not isinstance(seq, bool) else None

    for field in REQUIRED_EVENT_FIELDS:
        if field not in event:
            issues.append(
                _issue(
                    "missing_required_field",
                    f"Event missing required field '{field}'",
                    severity="error",
                    seq=seq_int,
                )
            )

    schema = event.get("schema")
    if schema is not None and schema != SCHEMA_EVENT:
        issues.append(
            _issue(
                "schema_mismatch",
                f"Unexpected schema {schema!r}; expected {SCHEMA_EVENT!r}",
                severity="warning",
                seq=seq_int,
            )
        )

    session_id = event.get("session_id")
    if expected_session_id is not None and session_id is not None and session_id != expected_session_id:
        issues.append(
            _issue(
                "session_id_mismatch",
                f"Event session_id {session_id!r} does not match session.json {expected_session_id!r}",
                severity="error",
                seq=seq_int,
            )
        )

    if "seq" in event:
        if not isinstance(seq, int) or isinstance(seq, bool):
            issues.append(
                _issue("invalid_sequence", f"seq must be an integer, got {seq!r}", severity="error")
            )
        elif prev_seq is not None and seq < prev_seq:
            issues.append(
                _issue(
                    "invalid_sequence",
                    f"seq went backwards: {prev_seq} -> {seq}",
                    severity="error",
                    seq=seq,
                )
            )
        elif prev_seq is not None and seq == prev_seq:
            issues.append(
                _issue(
                    "invalid_sequence",
                    f"seq not strictly increasing: duplicate {seq}",
                    severity="error",
                    seq=seq,
                )
            )

    t_ms = event.get("t_ms")
    if "t_ms" in event:
        if not _is_finite_number(t_ms):
            issues.append(
                _issue(
                    "invalid_timestamp",
                    f"t_ms must be a finite number, got {t_ms!r}",
                    severity="error",
                    seq=seq_int,
                )
            )
        else:
            t_val = float(t_ms)
            if prev_t_ms is not None and t_val < prev_t_ms:
                issues.append(
                    _issue(
                        "invalid_timestamp",
                        f"t_ms went backwards: {prev_t_ms} -> {t_val}",
                        severity="error",
                        seq=seq_int,
                    )
                )

    frame = event.get("frame")
    if "frame" in event and (not isinstance(frame, int) or isinstance(frame, bool)):
        issues.append(
            _issue(
                "invalid_frame",
                f"frame must be an integer, got {frame!r}",
                severity="warning",
                seq=seq_int,
            )
        )

    if "kind" in event and not isinstance(event.get("kind"), str):
        issues.append(
            _issue("malformed_event", "kind must be a string", severity="error", seq=seq_int)
        )

    if "data" in event and not isinstance(event.get("data"), dict):
        issues.append(
            _issue("malformed_event", "data must be an object", severity="error", seq=seq_int)
        )

    return issues


def _finite_vec(values: Any, length: int) -> bool:
    if not isinstance(values, list) or len(values) != length:
        return False
    return all(_is_finite_number(v) for v in values)


def _validate_state_payload(data: Dict[str, Any], seq: Optional[int]) -> List[Dict[str, Any]]:
    issues: List[Dict[str, Any]] = []
    player = data.get("player")
    if player is None:
        return issues
    if not isinstance(player, dict):
        issues.append(_issue("malformed_state", "player must be object or null", severity="error", seq=seq))
        return issues
    pos = player.get("position")
    if pos is not None and not _finite_vec(pos, 3):
        issues.append(
            _issue("non_finite_value", "player.position must be 3 finite numbers", severity="error", seq=seq)
        )
    rot = player.get("rotation")
    if rot is not None and not _finite_vec(rot, 4):
        issues.append(
            _issue("non_finite_value", "player.rotation must be 4 finite numbers", severity="error", seq=seq)
        )
    local_pos = player.get("local_position")
    if local_pos is not None and not _finite_vec(local_pos, 3):
        issues.append(
            _issue(
                "non_finite_value",
                "player.local_position must be 3 finite numbers",
                severity="error",
                seq=seq,
            )
        )
    grounded = player.get("grounded")
    if grounded is not None and not isinstance(grounded, bool):
        issues.append(
            _issue("malformed_state", "player.grounded must be bool when present", severity="warning", seq=seq)
        )
    return issues


class _OpenHold:
    __slots__ = ("key_or_button", "start_t_ms", "start_seq", "start_frame", "start_observed")

    def __init__(
        self,
        key_or_button: Any,
        start_t_ms: float,
        start_seq: Optional[int],
        start_frame: Optional[int],
        start_observed: bool,
    ) -> None:
        self.key_or_button = key_or_button
        self.start_t_ms = start_t_ms
        self.start_seq = start_seq
        self.start_frame = start_frame
        self.start_observed = start_observed


def _close_hold(
    hold: _OpenHold,
    *,
    end_t_ms: float,
    end_seq: Optional[int],
    end_frame: Optional[int],
    end_observed: bool,
    end_reason: str,
    kind: str,
) -> Dict[str, Any]:
    record: Dict[str, Any] = {
        "start_t_ms": hold.start_t_ms,
        "end_t_ms": end_t_ms,
        "duration_ms": end_t_ms - hold.start_t_ms,
        "start_seq": hold.start_seq,
        "end_seq": end_seq,
        "start_frame": hold.start_frame,
        "end_frame": end_frame,
        "start_observed": hold.start_observed,
        "end_observed": end_observed,
        "end_reason": end_reason,
    }
    if kind == "key":
        record["key"] = hold.key_or_button
    else:
        record["button"] = hold.key_or_button
    return record


def _as_str_list(value: Any) -> List[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value]


def _as_int_list(value: Any) -> List[int]:
    if not isinstance(value, list):
        return []
    out: List[int] = []
    for item in value:
        if isinstance(item, int) and not isinstance(item, bool):
            out.append(item)
    return out


def _chord_intervals(key_holds: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Derive pairwise overlapping key chord intervals from closed holds."""
    chords: List[Dict[str, Any]] = []
    for i, a in enumerate(key_holds):
        for b in key_holds[i + 1 :]:
            start = max(float(a["start_t_ms"]), float(b["start_t_ms"]))
            end = min(float(a["end_t_ms"]), float(b["end_t_ms"]))
            if end <= start:
                continue
            keys = sorted({str(a["key"]), str(b["key"])})
            if len(keys) < 2:
                continue
            chords.append(
                {
                    "keys": keys,
                    "start_t_ms": start,
                    "end_t_ms": end,
                    "duration_ms": end - start,
                }
            )
    # Merge identical key-set overlaps that abut or overlap from multi-pair expansion
    chords.sort(key=lambda c: (tuple(c["keys"]), c["start_t_ms"], c["end_t_ms"]))
    merged: List[Dict[str, Any]] = []
    for chord in chords:
        if (
            merged
            and merged[-1]["keys"] == chord["keys"]
            and chord["start_t_ms"] <= merged[-1]["end_t_ms"]
        ):
            merged[-1]["end_t_ms"] = max(merged[-1]["end_t_ms"], chord["end_t_ms"])
            merged[-1]["duration_ms"] = merged[-1]["end_t_ms"] - merged[-1]["start_t_ms"]
        else:
            merged.append(dict(chord))
    return merged


def _distance_3(a: Sequence[float], b: Sequence[float]) -> float:
    return math.sqrt(sum((float(b[i]) - float(a[i])) ** 2 for i in range(3)))


def analyze_events(
    events: Sequence[Dict[str, Any]],
    session_meta: Optional[Dict[str, Any]] = None,
    *,
    truncated_final_line: bool = False,
) -> Dict[str, Any]:
    """Analyze parsed demonstration events into a summary dict.

    Does not claim physical input precision. Jump-related grounded transitions
    are candidates only; Space alone never implies a successful jump.
    """
    issues: List[Dict[str, Any]] = []
    expected_session_id: Optional[str] = None
    if isinstance(session_meta, dict):
        sid = session_meta.get("session_id")
        if isinstance(sid, str):
            expected_session_id = sid

    prev_seq: Optional[int] = None
    prev_t_ms: Optional[float] = None
    valid_events: List[Dict[str, Any]] = []

    for event in events:
        if not isinstance(event, dict):
            issues.append(_issue("malformed_event", "Event is not an object", severity="error"))
            continue
        event_issues = _validate_common_fields(
            event,
            expected_session_id=expected_session_id,
            prev_seq=prev_seq,
            prev_t_ms=prev_t_ms,
        )
        issues.extend(event_issues)
        seq = event.get("seq")
        t_ms = event.get("t_ms")
        if isinstance(seq, int) and not isinstance(seq, bool):
            if prev_seq is None or seq > prev_seq:
                prev_seq = seq
        if _is_finite_number(t_ms):
            t_val = float(t_ms)
            if prev_t_ms is None or t_val >= prev_t_ms:
                prev_t_ms = t_val
        # Keep events with validation warnings so analysis can still proceed.
        if not isinstance(event.get("kind"), str) or not isinstance(event.get("data"), dict):
            continue
        if not _is_finite_number(event.get("t_ms")):
            continue
        valid_events.append(event)

        if event.get("kind") == "state":
            seq_int = seq if isinstance(seq, int) and not isinstance(seq, bool) else None
            issues.extend(_validate_state_payload(event["data"], seq_int))

    if expected_session_id is None and valid_events:
        first_sid = valid_events[0].get("session_id")
        if isinstance(first_sid, str):
            expected_session_id = first_sid

    # --- Pass: derive holds, gaps, markers, state ---
    open_keys: Dict[str, _OpenHold] = {}
    open_mouse: Dict[int, _OpenHold] = {}
    key_holds: List[Dict[str, Any]] = []
    mouse_holds: List[Dict[str, Any]] = []
    gaps: List[Dict[str, Any]] = []
    open_gap: Optional[Dict[str, Any]] = None
    markers: List[Dict[str, Any]] = []
    scenes: List[Dict[str, Any]] = []
    state_samples: List[Dict[str, Any]] = []
    saw_session_start = False
    saw_session_end = False
    session_end_data: Optional[Dict[str, Any]] = None
    first_input_seen = False
    in_gap = False
    observation_segment = 0

    def interrupt_all_holds(
        t_ms: float,
        seq: Optional[int],
        frame: Optional[int],
        reason: str,
    ) -> None:
        nonlocal open_keys, open_mouse
        for key, hold in list(open_keys.items()):
            key_holds.append(
                _close_hold(
                    hold,
                    end_t_ms=t_ms,
                    end_seq=seq,
                    end_frame=frame,
                    end_observed=False,
                    end_reason=reason,
                    kind="key",
                )
            )
        open_keys.clear()
        for button, hold in list(open_mouse.items()):
            mouse_holds.append(
                _close_hold(
                    hold,
                    end_t_ms=t_ms,
                    end_seq=seq,
                    end_frame=frame,
                    end_observed=False,
                    end_reason=reason,
                    kind="mouse",
                )
            )
        open_mouse.clear()

    for event in valid_events:
        kind = event["kind"]
        data = event["data"]
        t_ms = float(event["t_ms"])
        seq = event.get("seq") if isinstance(event.get("seq"), int) and not isinstance(event.get("seq"), bool) else None
        frame = event.get("frame") if isinstance(event.get("frame"), int) and not isinstance(event.get("frame"), bool) else None

        if kind == "session_start":
            saw_session_start = True
        elif kind == "session_end":
            saw_session_end = True
            session_end_data = data if isinstance(data, dict) else {}
        elif kind == "module_error":
            issues.append(_issue("module_error", "Recorder extension callback failed; review module coverage", severity="error", seq=seq))
        elif kind == "gap_start":
            observation_segment += 1
            reason = data.get("reason") if isinstance(data, dict) else None
            if open_gap is not None:
                issues.append(
                    _issue(
                        "nested_gap",
                        "gap_start while a gap is already open",
                        severity="warning",
                        seq=seq,
                    )
                )
            open_gap = {
                "reason": reason,
                "start_t_ms": t_ms,
                "start_seq": seq,
                "start_frame": frame,
            }
            in_gap = True
            # Gap interrupts held intervals; do not fabricate key-up as observed.
            interrupt_all_holds(t_ms, seq, frame, "gap_interrupt")
        elif kind == "gap_end":
            observation_segment += 1
            reason = data.get("reason") if isinstance(data, dict) else None
            if open_gap is None:
                issues.append(
                    _issue("orphan_gap_end", "gap_end without open gap", severity="warning", seq=seq)
                )
                gaps.append(
                    {
                        "reason": reason,
                        "start_t_ms": None,
                        "end_t_ms": t_ms,
                        "start_seq": None,
                        "end_seq": seq,
                        "start_frame": None,
                        "end_frame": frame,
                        "complete": False,
                    }
                )
            else:
                gaps.append(
                    {
                        "reason": open_gap.get("reason") or reason,
                        "start_t_ms": open_gap["start_t_ms"],
                        "end_t_ms": t_ms,
                        "start_seq": open_gap["start_seq"],
                        "end_seq": seq,
                        "start_frame": open_gap["start_frame"],
                        "end_frame": frame,
                        "duration_ms": t_ms - float(open_gap["start_t_ms"]),
                        "complete": True,
                    }
                )
                open_gap = None
            in_gap = False
        elif kind == "marker":
            markers.append(
                {
                    "label": data.get("label"),
                    "marker_id": data.get("marker_id"),
                    "t_ms": t_ms,
                    "seq": seq,
                    "frame": frame,
                }
            )
        elif kind == "scene":
            scenes.append(
                {
                    "t_ms": t_ms,
                    "seq": seq,
                    "frame": frame,
                    "data": {
                        k: data.get(k)
                        for k in ("name", "path", "loaded", "unloaded", "action")
                        if k in data
                    },
                }
            )
        elif kind == "input":
            if in_gap:
                # Capture should be suppressed during gaps; still note if present.
                issues.append(
                    _issue(
                        "input_during_gap",
                        "input event observed while a gap is open",
                        severity="warning",
                        seq=seq,
                    )
                )
            keys_held = set(_as_str_list(data.get("keys_held")))
            keys_down = _as_str_list(data.get("keys_down"))
            keys_up = _as_str_list(data.get("keys_up"))
            mouse_held = set(_as_int_list(data.get("mouse_held")))
            mouse_down = _as_int_list(data.get("mouse_down"))
            mouse_up = _as_int_list(data.get("mouse_up"))

            if not first_input_seen:
                first_input_seen = True
                # Keys already held at capture start: start_observed=False
                for key in keys_held:
                    if key not in open_keys and key not in keys_down:
                        open_keys[key] = _OpenHold(key, t_ms, seq, frame, start_observed=False)
                for button in mouse_held:
                    if button not in open_mouse and button not in mouse_down:
                        open_mouse[button] = _OpenHold(button, t_ms, seq, frame, start_observed=False)

            for key in keys_down:
                if key in open_keys:
                    # Re-down without up: close previous as truncated observation, reopen.
                    key_holds.append(
                        _close_hold(
                            open_keys[key],
                            end_t_ms=t_ms,
                            end_seq=seq,
                            end_frame=frame,
                            end_observed=False,
                            end_reason="restarted_without_up",
                            kind="key",
                        )
                    )
                open_keys[key] = _OpenHold(key, t_ms, seq, frame, start_observed=True)

            for key in keys_up:
                if key in open_keys:
                    key_holds.append(
                        _close_hold(
                            open_keys.pop(key),
                            end_t_ms=t_ms,
                            end_seq=seq,
                            end_frame=frame,
                            end_observed=True,
                            end_reason="key_up",
                            kind="key",
                        )
                    )
                else:
                    issues.append(
                        _issue(
                            "orphan_key_up",
                            f"keys_up for {key!r} without open hold",
                            severity="warning",
                            seq=seq,
                        )
                    )

            # Sync: keys that appear in held state without open hold (heartbeat) — start unobserved
            for key in keys_held:
                if key not in open_keys and key not in keys_down:
                    open_keys[key] = _OpenHold(key, t_ms, seq, frame, start_observed=False)

            for button in mouse_down:
                if button in open_mouse:
                    mouse_holds.append(
                        _close_hold(
                            open_mouse[button],
                            end_t_ms=t_ms,
                            end_seq=seq,
                            end_frame=frame,
                            end_observed=False,
                            end_reason="restarted_without_up",
                            kind="mouse",
                        )
                    )
                open_mouse[button] = _OpenHold(button, t_ms, seq, frame, start_observed=True)

            for button in mouse_up:
                if button in open_mouse:
                    mouse_holds.append(
                        _close_hold(
                            open_mouse.pop(button),
                            end_t_ms=t_ms,
                            end_seq=seq,
                            end_frame=frame,
                            end_observed=True,
                            end_reason="mouse_up",
                            kind="mouse",
                        )
                    )
                else:
                    issues.append(
                        _issue(
                            "orphan_mouse_up",
                            f"mouse_up for button {button} without open hold",
                            severity="warning",
                            seq=seq,
                        )
                    )

            for button in mouse_held:
                if button not in open_mouse and button not in mouse_down:
                    open_mouse[button] = _OpenHold(button, t_ms, seq, frame, start_observed=False)

        elif kind == "state":
            player = data.get("player") if isinstance(data, dict) else None
            sample: Dict[str, Any] = {
                "t_ms": t_ms,
                "seq": seq,
                "frame": frame,
                "player_available": player is not None,
                "observation_segment": observation_segment,
                "in_gap": in_gap,
            }
            if isinstance(player, dict):
                sample["instance_id"] = player.get("instance_id")
                sample["scene"] = player.get("scene")
                sample["grounded"] = player.get("grounded")
                pos = player.get("position")
                if _finite_vec(pos, 3):
                    sample["position"] = [float(pos[0]), float(pos[1]), float(pos[2])]
                else:
                    sample["position"] = None
            else:
                sample["instance_id"] = None
                sample["scene"] = None
                sample["grounded"] = None
                sample["position"] = None
            state_samples.append(sample)

    # Open gap at end
    if open_gap is not None:
        gaps.append(
            {
                "reason": open_gap.get("reason"),
                "start_t_ms": open_gap["start_t_ms"],
                "end_t_ms": None,
                "start_seq": open_gap["start_seq"],
                "end_seq": None,
                "start_frame": open_gap["start_frame"],
                "end_frame": None,
                "complete": False,
            }
        )
        issues.append(
            _issue(
                "incomplete_gap",
                "gap_start without matching gap_end",
                severity="warning",
                seq=open_gap.get("start_seq"),
            )
        )

    # Do not fabricate releases at session end — close as truncated / unobserved.
    last_t = float(valid_events[-1]["t_ms"]) if valid_events else 0.0
    last_seq = (
        valid_events[-1]["seq"]
        if valid_events and isinstance(valid_events[-1].get("seq"), int)
        else None
    )
    last_frame = (
        valid_events[-1]["frame"]
        if valid_events and isinstance(valid_events[-1].get("frame"), int)
        else None
    )
    # Never fabricate an observed release. Truncation is distinct from a clean end
    # where the key was still held (or the session_end event is missing).
    if truncated_final_line:
        end_reason = "truncated"
    else:
        end_reason = "session_end_unobserved"
    for hold in list(open_keys.values()):
        key_holds.append(
            _close_hold(
                hold,
                end_t_ms=last_t,
                end_seq=last_seq,
                end_frame=last_frame,
                end_observed=False,
                end_reason=end_reason,
                kind="key",
            )
        )
    open_keys.clear()
    for hold in list(open_mouse.values()):
        mouse_holds.append(
            _close_hold(
                hold,
                end_t_ms=last_t,
                end_seq=last_seq,
                end_frame=last_frame,
                end_observed=False,
                end_reason=end_reason,
                kind="mouse",
            )
        )
    open_mouse.clear()

    key_holds.sort(key=lambda h: (h["start_t_ms"], h.get("start_seq") or 0))
    mouse_holds.sort(key=lambda h: (h["start_t_ms"], h.get("start_seq") or 0))
    chords = _chord_intervals(key_holds)

    motion = _analyze_motion(state_samples)
    jump_candidates = _analyze_jump_candidates(state_samples, key_holds)

    state_availability = _state_availability(state_samples)

    completeness = _completeness(
        session_meta=session_meta,
        saw_session_start=saw_session_start,
        saw_session_end=saw_session_end,
        session_end_data=session_end_data,
        truncated_final_line=truncated_final_line,
        issues=issues,
    )

    input_coverage = {
        "input_event_count": sum(1 for e in valid_events if e["kind"] == "input"),
        "state_event_count": sum(1 for e in valid_events if e["kind"] == "state"),
        "gap_count": len(gaps),
        "marker_count": len(markers),
        "key_hold_count": len(key_holds),
        "mouse_hold_count": len(mouse_holds),
        "chord_count": len(chords),
        "keys_seen": sorted({h["key"] for h in key_holds}),
        "focus_or_pause_gaps": [
            g for g in gaps if str(g.get("reason") or "") in {
                "focus_lost",
                "game_view_not_focused",
                "editor_paused",
                "text_input_selected",
            }
        ],
    }

    return {
        "schema": SCHEMA_ANALYSIS,
        "analysis_version": ANALYSIS_VERSION,
        "session_id": expected_session_id,
        "units": {"time": "ms", "distance": "unity_units"},
        "bindings": {
            "Space": "jump",
            "binding_source": "human_confirmed_2026-10-21",
            "note": "Space records jump intent; grounded transitions are candidates only.",
        },
        "completeness": completeness,
        "issues": issues,
        "gaps": gaps,
        "key_holds": key_holds,
        "mouse_holds": mouse_holds,
        "chords": chords,
        "markers": markers,
        "scenes": scenes,
        "motion_segments": motion,
        "jump_candidates": jump_candidates,
        "state_availability": state_availability,
        "input_coverage": input_coverage,
        "event_counts": {
            "parsed": len(events),
            "analyzed": len(valid_events),
            "by_kind": _count_kinds(valid_events),
        },
        "caveats": [
            "Timings are frame-observed recorder values, not OS hardware timestamps.",
            "State is correlated by frame/time; no claim of exact input consumption order.",
            "Do not treat jump_candidates as successful jumps.",
            "Motion is not summed across scene or player-instance changes.",
            "Sparse or missing state yields unknown, not zero success.",
        ],
    }


def _count_kinds(events: Iterable[Dict[str, Any]]) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    for event in events:
        kind = str(event.get("kind"))
        counts[kind] = counts.get(kind, 0) + 1
    return counts


def _completeness(
    *,
    session_meta: Optional[Dict[str, Any]],
    saw_session_start: bool,
    saw_session_end: bool,
    session_end_data: Optional[Dict[str, Any]],
    truncated_final_line: bool,
    issues: List[Dict[str, Any]],
) -> Dict[str, Any]:
    meta_finalized: Optional[bool] = None
    writer_ok: Optional[bool] = None
    meta_complete: Optional[bool] = None
    if isinstance(session_meta, dict):
        for key in ("finalized",):
            if key in session_meta and isinstance(session_meta[key], bool):
                meta_finalized = session_meta[key]
                break
        if isinstance(session_meta.get("complete"), bool):
            meta_complete = session_meta["complete"]
        status = session_meta.get("status") or session_meta.get("io_status") or session_meta.get("writer_status")
        if isinstance(status, str):
            lowered = status.lower()
            if lowered in {"ok", "flushed", "complete", "completed", "success"}:
                writer_ok = True
            elif lowered in {"error", "failed", "incomplete", "aborted"}:
                writer_ok = False
        completion = session_meta.get("completion")
        if isinstance(completion, dict):
            if isinstance(completion.get("finalized"), bool):
                meta_finalized = completion["finalized"]
            if isinstance(completion.get("writer_flush_ok"), bool):
                writer_ok = completion["writer_flush_ok"]

    if isinstance(session_end_data, dict):
        for key in ("writer_flush_ok", "flush_ok", "writer_ok"):
            if isinstance(session_end_data.get(key), bool):
                writer_ok = session_end_data[key]
                break

    # The recorder's end event is queued before the flush. Final metadata is
    # authoritative; an end event cannot override a failed or unfinished writer.
    if isinstance(session_meta, dict):
        if meta_finalized is True and meta_complete is True:
            writer_ok = True
        if meta_complete is False or session_meta.get("writer_error"):
            writer_ok = False
        accepted = session_meta.get("events_accepted")
        written = session_meta.get("events_written")
        if accepted is not None and written is not None and accepted != written:
            writer_ok = False
            issues.append(_issue("writer_count_mismatch", "Accepted/written event counts differ", severity="error"))

    if not saw_session_end:
        issues.append(
            _issue(
                "missing_session_end",
                "No session_end event; recording is incomplete",
                severity="error",
            )
        )
    if truncated_final_line:
        issues.append(
            _issue(
                "incomplete_recording",
                "Final events line truncated; do not claim a complete recording",
                severity="error",
            )
        )
    if meta_finalized is False:
        issues.append(
            _issue(
                "incomplete_metadata",
                "session.json reports metadata not finalized",
                severity="error",
            )
        )
    if writer_ok is False:
        issues.append(
            _issue(
                "writer_flush_failed",
                "Writer flush was not successful",
                severity="error",
            )
        )

    complete = (
        saw_session_start
        and saw_session_end
        and not truncated_final_line
        and meta_finalized is True
        and writer_ok is True
    )
    if (meta_finalized is None or writer_ok is None) and writer_ok is not False and saw_session_end and not truncated_final_line:
        status_label = "session_end_present_metadata_unknown"
    elif complete:
        status_label = "complete"
    else:
        status_label = "incomplete"

    return {
        "has_session_start": saw_session_start,
        "has_session_end": saw_session_end,
        "truncated_final_line": truncated_final_line,
        "session_json_finalized": meta_finalized,
        "session_json_complete": meta_complete,
        "writer_flush_ok": writer_ok,
        "status": status_label,
    }


def _state_availability(samples: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    if not samples:
        return {
            "status": "unavailable",
            "sample_count": 0,
            "player_available_count": 0,
            "grounded_known_count": 0,
            "note": "No state samples; outcomes that need state are unknown, not zero success.",
        }
    available = sum(1 for s in samples if s.get("player_available"))
    grounded_known = sum(1 for s in samples if isinstance(s.get("grounded"), bool))
    if available == 0:
        status = "unavailable"
    elif available < len(samples) or grounded_known < max(1, len(samples) // 2):
        status = "sparse"
    else:
        status = "available"
    return {
        "status": status,
        "sample_count": len(samples),
        "player_available_count": available,
        "grounded_known_count": grounded_known,
        "note": (
            "Sparse or missing state yields unknown, not zero success."
            if status != "available"
            else "Player state samples present for correlation by frame/time."
        ),
    }


def _analyze_motion(samples: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Path length per continuous identity segment. Never sum across scene/instance changes."""
    segments: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None

    def close_current() -> None:
        nonlocal current
        if current is None:
            return
        if current["sample_count"] < 1:
            current["path_length_unity_units"] = "unknown"
            current["displacement_unity_units"] = "unknown"
        elif current["positions"] < 2:
            current["path_length_unity_units"] = "unknown"
            current["displacement_unity_units"] = "unknown"
            current["note"] = "Insufficient positions in segment; distance unknown."
        segments.append(
            {
                "instance_id": current["instance_id"],
                "scene": current["scene"],
                "start_t_ms": current["start_t_ms"],
                "end_t_ms": current["end_t_ms"],
                "sample_count": current["sample_count"],
                "path_length_unity_units": current["path_length_unity_units"],
                "displacement_unity_units": current["displacement_unity_units"],
                **(
                    {"note": current["note"]}
                    if "note" in current
                    else {}
                ),
            }
        )
        current = None

    for sample in samples:
        if not sample.get("player_available") or sample.get("in_gap"):
            close_current()
            continue
        instance_id = sample.get("instance_id")
        scene = sample.get("scene")
        pos = sample.get("position")
        t_ms = sample["t_ms"]

        if current is None:
            current = {
                "instance_id": instance_id,
                "scene": scene,
                "observation_segment": sample.get("observation_segment"),
                "start_t_ms": t_ms,
                "end_t_ms": t_ms,
                "sample_count": 1,
                "path_length_unity_units": 0.0 if pos is not None else "unknown",
                "displacement_unity_units": 0.0 if pos is not None else "unknown",
                "first_pos": pos,
                "last_pos": pos,
                "positions": 1 if pos is not None else 0,
            }
            continue

        identity_changed = (instance_id != current["instance_id"] or scene != current["scene"]
                            or sample.get("observation_segment") != current["observation_segment"])
        if identity_changed:
            close_current()
            current = {
                "instance_id": instance_id,
                "scene": scene,
                "observation_segment": sample.get("observation_segment"),
                "start_t_ms": t_ms,
                "end_t_ms": t_ms,
                "sample_count": 1,
                "path_length_unity_units": 0.0 if pos is not None else "unknown",
                "displacement_unity_units": 0.0 if pos is not None else "unknown",
                "first_pos": pos,
                "last_pos": pos,
                "positions": 1 if pos is not None else 0,
            }
            continue

        current["end_t_ms"] = t_ms
        current["sample_count"] += 1
        if pos is None or current["last_pos"] is None:
            if pos is not None and current["first_pos"] is None:
                current["first_pos"] = pos
            if pos is not None:
                current["last_pos"] = pos
                current["positions"] += 1
            # Missing position breaks continuous path metering → unknown rather than inventing.
            if not isinstance(current["path_length_unity_units"], str):
                current["path_length_unity_units"] = "unknown"
                current["displacement_unity_units"] = "unknown"
                current["note"] = "Missing position sample; segment distance unknown."
        else:
            if isinstance(current["path_length_unity_units"], (int, float)):
                current["path_length_unity_units"] = float(current["path_length_unity_units"]) + _distance_3(
                    current["last_pos"], pos
                )
            current["last_pos"] = pos
            current["positions"] += 1
            if current["first_pos"] is not None and isinstance(current.get("displacement_unity_units"), (int, float)):
                current["displacement_unity_units"] = _distance_3(current["first_pos"], pos)

    close_current()
    return segments


def _space_active_at(key_holds: Sequence[Dict[str, Any]], t_ms: float, window_ms: float) -> Optional[bool]:
    """Return True if Space hold overlaps [t_ms - window, t_ms + window], False if holds known but no overlap, None if no Space data."""
    space_holds = [h for h in key_holds if h.get("key") == JUMP_KEY]
    if not space_holds:
        return None
    lo = t_ms - window_ms
    hi = t_ms + window_ms
    for hold in space_holds:
        if float(hold["start_t_ms"]) <= hi and float(hold["end_t_ms"]) >= lo:
            return True
    return False


def _analyze_jump_candidates(
    samples: Sequence[Dict[str, Any]],
    key_holds: Sequence[Dict[str, Any]],
) -> Dict[str, Any]:
    """Detect grounded→airborne→grounded as candidates only.

    Never marks a jump successful from Space alone.
    """
    grounded_series: List[Tuple[float, Optional[int], Optional[int], bool, Any, Any]] = []
    continuity = 0
    previous_identity = None
    for sample in samples:
        g = sample.get("grounded")
        identity = (sample.get("instance_id"), sample.get("scene"), sample.get("observation_segment"))
        if identity != previous_identity or not isinstance(g, bool) or sample.get("in_gap"):
            continuity += 1
        previous_identity = identity
        if isinstance(g, bool) and not sample.get("in_gap"):
            grounded_series.append(
                (
                    float(sample["t_ms"]),
                    sample.get("seq"),
                    sample.get("frame"),
                    g,
                    sample.get("instance_id"),
                    (sample.get("scene"), continuity),
                )
            )

    if not grounded_series:
        return {
            "status": "unknown",
            "candidates": [],
            "successful_jumps": "unknown",
            "note": "No grounded samples; jump success unknown (not zero).",
        }

    candidates: List[Dict[str, Any]] = []
    i = 0
    while i < len(grounded_series) - 1:
        t0, seq0, frame0, g0, inst0, scene0 = grounded_series[i]
        t1, seq1, frame1, g1, inst1, scene1 = grounded_series[i + 1]
        # Identity break: do not form transitions across instance/scene changes
        if inst0 != inst1 or scene0 != scene1:
            i += 1
            continue
        if g0 is True and g1 is False:
            takeoff_t = t1
            takeoff_seq = seq1
            takeoff_frame = frame1
            # Find next grounded True within same identity
            landing = None
            for j in range(i + 2, len(grounded_series)):
                tj, seqj, framej, gj, instj, scenej = grounded_series[j]
                if instj != inst0 or scenej != scene0:
                    break
                if gj is True:
                    landing = (tj, seqj, framej)
                    break
            space_corr = _space_active_at(key_holds, takeoff_t, JUMP_ATTRIBUTION_WINDOW_MS)
            candidate: Dict[str, Any] = {
                "status": "candidate",
                "transition": "grounded_airborne"
                + ("_grounded" if landing else ""),
                "takeoff_t_ms": takeoff_t,
                "takeoff_seq": takeoff_seq,
                "takeoff_frame": takeoff_frame,
                "instance_id": inst0,
                "scene": scene0[0],
                "space_in_attribution_window": (
                    "unknown" if space_corr is None else space_corr
                ),
                "attribution_window_ms": JUMP_ATTRIBUTION_WINDOW_MS,
                "note": (
                    "Candidate only. Space indicates jump intent when correlated; "
                    "state change alone does not prove which input caused takeoff."
                ),
            }
            if landing:
                candidate["landing_t_ms"] = landing[0]
                candidate["landing_seq"] = landing[1]
                candidate["landing_frame"] = landing[2]
                candidate["air_time_ms"] = landing[0] - takeoff_t
            else:
                candidate["landing_t_ms"] = None
                candidate["note"] += " Landing not observed in this identity segment."
            candidates.append(candidate)
        i += 1

    return {
        "status": "candidates_only" if candidates else "none_observed",
        "candidates": candidates,
        "successful_jumps": "unknown",
        "note": (
            "Never treat Space alone as a successful jump. "
            "successful_jumps is unknown unless separately verified."
        ),
    }


def summarize_quest_world(events: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Bounded index into module evidence; do not infer a gameplay PASS from history."""
    result: Dict[str, Any] = {"status": "not_recorded", "events": {}, "last_active_quest_uids": None,
                              "last_targets": None, "last_quest_availability": None,
                              "completion": "not_inferred"}
    for event in events:
        if not isinstance(event, dict) or event.get("kind") != "module":
            continue
        data = event.get("data")
        if not isinstance(data, dict) or data.get("module_id") != "ocean.quest-world":
            continue
        name, payload = data.get("event_name"), data.get("payload")
        if name not in ("quest_snapshot", "spatial_snapshot") or not isinstance(payload, dict):
            continue
        result["status"] = "recorded_samples"
        stats = result["events"].setdefault(name, {"count": 0, "first_seq": event.get("seq")})
        stats["count"] += 1
        stats["last_seq"] = event.get("seq")
        stats["last_t_ms"] = event.get("t_ms")
        if name == "quest_snapshot":
            result["last_quest_availability"] = payload.get("availability")
            quests = payload.get("active_quests")
            result["last_active_quest_uids"] = [q.get("uid") for q in quests[:16] if isinstance(q, dict)] if isinstance(quests, list) else None
        else:
            targets = payload.get("targets")
            fields = ("uid", "instance_id", "quest_object_id", "position_world", "active_in_hierarchy", "is_taken")
            result["last_targets"] = [{key: target.get(key) for key in fields} for target in targets[:32] if isinstance(target, dict)] if isinstance(targets, list) else None
    return result


def analyze_session(session_dir: Path, *, issues_extra: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    """Load a session folder and return analysis summary."""
    session_dir = Path(session_dir)
    meta, meta_issues = load_session_metadata(session_dir)
    events, event_issues, truncated = load_events_ndjson(session_dir)
    summary = analyze_events(events, meta, truncated_final_line=truncated)
    # Prepend load issues
    combined = list(meta_issues) + list(event_issues) + list(summary.get("issues") or [])
    if issues_extra:
        combined = list(issues_extra) + combined
    summary["issues"] = combined
    summary["session_dir"] = str(session_dir)
    summary["quest_world_telemetry"] = summarize_quest_world(events)
    if meta is not None:
        summary["session_meta_keys"] = sorted(meta.keys())
        if meta.get("extension_errors") and not any(item.get("code") == "module_error" for item in combined):
            combined.append(_issue("module_error", "Recorder metadata reports extension errors", severity="error"))
        if isinstance(meta.get("update_timing"), dict):
            summary["update_timing"] = meta["update_timing"]
        video = meta.get("video")
        if isinstance(video, dict):
            summary["video"] = video
            if video.get("requested"):
                # Never follow a file path supplied by log metadata.
                video_file = session_dir / "video.mp4"
                if video.get("status") != "file_written" or meta.get("video_recorded") is not True:
                    combined.append(_issue("video_incomplete", "Requested video was not saved successfully", severity="error"))
                elif not video_file.is_file() or video_file.stat().st_size <= 1024:
                    combined.append(_issue("video_file_missing", "video.mp4 is missing or empty", severity="error"))
        if meta.get("video_finalize_error"):
            combined.append(_issue("video_finalize_failed", "Video finalization callback failed", severity="error"))
    return summary


def write_summary(summary: Dict[str, Any], output: Path) -> Path:
    """Write summary JSON. `output` may be a directory or a .json file path."""
    output = Path(output)
    if output.exists() and output.is_dir():
        path = output / "session-analysis.json"
    elif output.suffix.lower() == ".json":
        path = output
        path.parent.mkdir(parents=True, exist_ok=True)
    else:
        output.mkdir(parents=True, exist_ok=True)
        path = output / "session-analysis.json"

    path.write_text(json.dumps(summary, indent=2, sort_keys=False) + "\n", encoding="utf-8")
    return path


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Analyze an Ocean Nomad demonstration session folder "
            "(session.json + events.ndjson). Writes a summary JSON; "
            "does not dump the raw log."
        )
    )
    parser.add_argument(
        "session_folder",
        type=Path,
        help="Path to session directory containing session.json and events.ndjson",
    )
    parser.add_argument(
        "--output",
        type=Path,
        required=True,
        help="Output directory or .json file path (keep outside Git)",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    session_folder = Path(args.session_folder)
    if not session_folder.is_dir():
        print(f"error: session folder not found: {session_folder}", file=sys.stderr)
        return 2

    summary = analyze_session(session_folder)
    out_path = write_summary(summary, Path(args.output))

    completeness = summary.get("completeness") or {}
    issues = summary.get("issues") or []
    errors = [i for i in issues if i.get("severity") == "error"]
    warnings = [i for i in issues if i.get("severity") == "warning"]

    print(f"Wrote summary: {out_path}")
    print(f"session_id: {summary.get('session_id')}")
    print(f"completeness: {completeness.get('status')}")
    print(f"issues: {len(errors)} error(s), {len(warnings)} warning(s)")
    print(
        "coverage: "
        f"{(summary.get('input_coverage') or {}).get('key_hold_count', 0)} key holds, "
        f"{(summary.get('input_coverage') or {}).get('chord_count', 0)} chords, "
        f"{(summary.get('input_coverage') or {}).get('gap_count', 0)} gaps, "
        f"{len((summary.get('jump_candidates') or {}).get('candidates') or [])} jump candidates"
    )
    if errors:
        for err in errors[:10]:
            print(f"  error [{err.get('code')}]: {err.get('message')}", file=sys.stderr)
    return 0 if completeness.get("status") == "complete" and not errors else 1


if __name__ == "__main__":
    sys.exit(main())
