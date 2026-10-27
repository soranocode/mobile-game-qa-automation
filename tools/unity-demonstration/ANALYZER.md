# Demonstration offline analyzer

Python stdlib CLI and library for demonstration log v1 (`ocean-demo/1`). Shared contract: [FORMAT.md](FORMAT.md).

This tool only reads a finished session folder and writes a summary JSON. It does not talk to Unity, devices, or the network. Synthetic unit fixtures are not real gameplay evidence.

## Ownership

| Path | Role |
|------|------|
| `analyze_demo.py` | CLI + importable analysis |
| `test_analyze_demo.py` | Synthetic unit tests |
| `ANALYZER.md` | This note |
| `FORMAT.md` | Shared recorder/analyzer contract (do not fork here) |

## Usage

From the repository root (or this directory):

```text
python tools/unity-demonstration/analyze_demo.py SESSION_FOLDER --output OUTPUT_PATH
```

- `SESSION_FOLDER` must contain `session.json` and `events.ndjson`.
- `--output` is a directory or a `.json` file path. Prefer a path outside Git (for example under the game Temp folder or a local analysis directory).
- The CLI prints a short status line only; it does not dump the raw NDJSON.

Importable entry points:

- `load_session_metadata`, `load_events_ndjson`
- `analyze_events`, `analyze_session`
- `write_summary`

## What the summary reports

- Completeness: `session_start` / `session_end`, truncated final line, finalized metadata and successful writer flush. The recorder reports the actual flush in final `session.json`; `pending_flush` in an end event is not proof of completion. A false `complete`, writer error or accepted/written mismatch prevents a complete result.
- Issues: malformed lines, invalid `seq` / `t_ms`, session identity mismatches, non-finite state values, missing end event.
- Gaps: focus/pause (and related) intervals; open holds are interrupted without fabricating observed releases.
- Key and mouse hold intervals with `start_observed` / `end_observed` and `end_reason` (`key_up` / `mouse_up`, `gap_interrupt`, `truncated`, `session_end_unobserved`, …).
- Simultaneous key chords derived from overlapping holds; markers preserved.
- Motion segments in Unity units, split on scene, player `instance_id`, unavailable state or observation gaps. World motion includes raft motion and is not walking distance.
- Jump-related grounded→airborne→grounded transitions as **candidates** only. Human-confirmed binding: Space = jump intent. Space alone never marks a successful jump. Sparse or missing state → `unknown`, not zero success.
- Units: time in `ms`, distance in `unity_units`.
- Optional video status and synchronization metadata; requested failed video or absent/empty video.mp4 produces an error even if the journal is complete. This presence check does not decode or validate video pixels.

## Tests

```text
python tools/unity-demonstration/test_analyze_demo.py
```

## Limitations

- Frame/time correlation only; no claim of OS hardware timestamps or exact input-consumption order inside the engine.
- Chord detection is pairwise from closed holds; multi-key chords appear as overlapping pairs.
- Jump attribution uses a fixed temporal window around takeoff; it does not prove causality.
- Missing finalization/flush evidence yields `session_end_present_metadata_unknown`, never a complete result; the CLI exits nonzero. A known writer failure always yields incomplete.
- Directory output uses the fixed name `session-analysis.json`; session IDs never choose filesystem paths. Use a separate summary folder per session or an explicit `.json` destination to avoid replacing a previous summary.
- Analyzer does not validate against a live Unity build or private game sources.
