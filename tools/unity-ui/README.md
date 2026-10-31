# Compact UI input through MCP

## Passive error signal

The human enabled this policy on 22 October 2026: a new unexpected red Unity error interrupts UI execution and is investigated; explicitly warned development errors can be allowed for that particular check. This supersedes the earlier no-Console-check rule for this signal and its triggered investigation.

`error-monitor.mjs` subscribes once per domain to `Application.logMessageReceivedThreaded`. It records Error/Exception/Assert events in a bounded in-memory buffer (64 entries); ordinary logs and warnings are ignored. Normal UI observations carry only counters/armed/blocked status. Full messages and stacks are fetched separately with `session.errors.details()` after interruption. Console is neither cleared nor repeatedly scanned. No logs are uploaded.

`begin({expectedErrors: []})` installs/reuses the watcher and starts a baseline for this test; existing errors do not retrigger it. Every new unknown error is blocking by default, including a known bug unless the human explicitly exempts it. Exemptions require literal message text, a human reason and optionally a UI phase; they expire at `finish()`. They do not make a broken UI outcome pass its final assertion.

`step()` checks the signal in its regular snapshot; the actual Unity callback also checks before sending pending input and after pointer-up. A new error stops the next input; it cannot undo the action that caused the error. Both known-route controllers return `NEEDS_REVIEW/new_unity_error` and preserve cleanup, even if the error appears at the final boundary. Use the captured alert to investigate before any retry. Finish invalidates pending input, restores background frames and disarms the test-specific stop policy; the passive listener remains installed.

The listener operates inside the running Unity domain, including when the model is not generating a reply. It does not independently wake an idle Codex conversation. The model receives the signal through its next tool observation. An Editor/domain restart removes the in-memory listener; the next `begin()` reinstalls it. Missing/unarmed monitoring blocks input rather than silently continuing. This is runtime error observation, not a guarantee that every Editor/compiler diagnostic arrives through this event.

Exploratory `selected-control.cs.txt` now requires `session.instrument(code)` to expand its watcher guard. Do not execute the unexpanded template or reuse an older unguarded compiled helper. The main learned template is instrumented automatically by `session.body(role)`.

Verification: isolated callback self-test inside Unity passed (expected scoped error, unexpected exception, Assert, warning/log exclusion, bounded buffer), without real Console errors or game input. A no-input begin/observe/finish session returned a healthy zero-error signal and restored background=false. The next actual gameplay error has not yet exercised the complete live interruption path. Node tests cover the stop latch, cleanup and final-boundary failure; the old speed measurements predate this monitoring and should not be presented as new measured performance.

`session.mjs` accepts an initialized, project-guarded MCP caller and a game-specific C# template. The caller returns the parsed tool result (`success`, `data`) and must select the intended Unity instance before creating this session. Ocean Nomad's template is in `projects/ocean-nomad/tools/fast-ui/step.cs.txt`.

`prepare()` compiles the nine stable role/observation snippets with input disabled. `begin()` temporarily allows background frames and returns compact current UI data. The assistant or an approved learned controller chooses each next action. `step(role)` batches exactly one chosen click with the resulting snapshot. Short polling only acknowledges that same click; it never repeats input or chooses the next role. `confirm_new_game` means the destructive in-game confirmation and requires the human's authorization.

`finish()` cancels any still-pending click and restores the previous background setting. Call it when the human stops or the session ends. UI input also expires after two seconds rather than firing much later when Unity regains focus. No fixed coordinates, private game callbacks, repeated full Console reads, screenshots per step or quest inspection are used.

The single action is sent on a game frame, where Screen geometry is current. The exposed upper button edge is tried before its center to avoid the dev-only `None` overlay. Target matching is game-specific and provisional; an ambiguous or covered target returns without clicking a different element. Unknown UI requires separate observation by the assistant.

Preparation changes only Editor SessionState metadata. No package installation, scene modification, Play restart, or recompilation of the game's scripts is needed. Compiled snippets live in Unity MCP's cache; a domain reload evicts that cache and requires preparation again.

The adapter reduces assistant round trips and repeated compilation; its end-to-end route speed still needs a new authorized run. A batch is one MCP request containing two Unity operations; an unsettled frame may require extra read-only acknowledgment polls. Do not claim that fewer outer requests equal fewer Unity operations or that cached compilation timings measure whole-route performance.

After per-click decisions still took about 25 s, the human approved the familiar new-game route as one learned skill. Its separate controller is `projects/ocean-nomad/tools/fast-ui/skill.mjs`; the generic transport remains one selected action per `step`. See that controller's README for measured results and boundaries. `mcp-client.mjs` restores a local MCP connection after a lost JavaScript session, verifies the expected project root and never automatically replays mutating requests.

## Preparation verified on 22 October 2026

Five snippets compiled in 15,074 ms with the input guard enabled. Repeating preparation after the setup command was also cached took 36 ms for the six-operation batch. Every result reported `input_sent=false`. This is a cache/preparation measurement, not the duration of clicking through the game. Local evidence: `outputs/unity-mcp/fast-ui/preparation.json` outside the automation repository.

The two transport tests verify that stopped sessions cannot send input and that pending acknowledgment never repeats a click or selects another action. Run `node tools/unity-ui/session.test.mjs` from the repository root; direct execution avoids child-process isolation when the Windows sandbox forbids spawning the Node test worker. Both passed. No new-game run was started during preparation.
