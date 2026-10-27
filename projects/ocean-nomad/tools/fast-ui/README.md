# Learned new-game UI route

## Consolidation after human approval

The human instructed on 22 October 2026 to consolidate learned behavior after approval. `approved-skills.json` is the small dispatch index: behavior approval, observed verification scope and speed acceptance are separate fields. Use `approved-ui.mjs` → `runApprovedUiSkill(id, {session, settingsAdapter}, options)` for the listed intents. Do not promote untested external/physical effects or automatically exempt known red errors.

The consolidated settings profile is `settings-skill.mjs` → `runApprovedSettingsChecks(adapter)`. It contains the same **13 UI assertions** as the observed gameplay settings test: switch changes and restores, FPS target, slider values, language, promo open/close, cancel new-game/exit, restore baseline, close and reopen persistence. It does not confirm deletion or exit into the main menu. Login and purchase restoration are excluded in Editor. Unknown windows, wrong confirmation intent, incomplete baseline, other builds, mismatches and new red errors return control rather than continuing.

Create `SettingsAdapter(session, {parameterFile, inputCode, parameterCode, snapshotCode})` using `selected-control.cs.txt`, `tools/unity-ui/parameter-input.cs.txt` and `settings-state.cs.txt`. `parameterFile` is an absolute path to a small local file outside Git, owned by the one Unity controller. Its parent must exist. `prepare()` compiles the three guarded primitives with input disabled. Slider fractions and current target paths are data in that file, read by one fixed cached C# command; they no longer cause a new compilation for every value. No private callbacks or direct writes to game settings are used: actual input still goes through EventSystem and current raycast geometry.

The controller runs as one assistant invocation with bounded internal MCP calls and compact value snapshots. Its timeout defaults to 20 s. A successfully sent action is never replayed; only a blocked/covered result that sent no input can be retried. Failure reports include pending value restorations instead of pretending cleanup restored game settings. `finish()` always cancels pending input and restores the background setting. If a host/kernel timeout interrupts execution, recover the session and read/cancel before any retry.

Validation: seven new Node tests passed, including all 13 checks against an independent fixture, stop on an unknown UI/new error, final-boundary failure, unchanged C# source when parameter data changes and rejection of unapproved intents. All three primitives compiled and a compact snapshot worked in a real no-input Unity session, with background restored. **The consolidated full gameplay run has not yet been timed or executed.** The previous long test used separate decisions and cannot be used as this runner's benchmark.

`prepare()` changes Editor metadata and a local parameter file, not game scripts/scenes. Recreate and prepare the adapter after a lost Node context/domain reload before the next authorized test. The passive watcher remains installed until a Unity domain reload.

## Settings UI and exit to the main menu

The current settings catalog is `../../knowledge/ui/ON-UI-SETTINGS-001.json`. It stores semantic IDs, current UI selectors, expected behavior, observed results and verification limits for 18 control groups. It does not mark an acknowledged input as a successful functional test. External links, account connection, purchase restoration success and the physical effects of audio/vibration/sensitivity remain unverified.

`runKnownMainMenu(session)` from `main-menu.mjs` runs the learned route from gameplay HUD or open Settings: dashboard if needed → Settings → Main Menu → the exact exit confirmation → optional Premium/Discord close buttons. It verifies the final `MainScreenWindow2` with an available Continue control, no other blocking window and 350 ms of stable observation. It stops at unknown windows and never repeats sent input. Confirmation of a new game is explicitly rejected by this route.

Live exploration verified both «НЕТ» (cancel) and «ДА» (exit). First skill attempt stopped on previously unhandled Discord; the failed result is retained. After adding Discord handling, the full second run passed in **2.440 seconds**, including a Premium window and final state check. Discord did not appear on that second run; its close was observed separately and both optional window orders are covered by controller tests. This timing excludes command compilation preparation.

`settings-observe.cs.txt` and `selected-control.cs.txt` retain the exploratory observation and single-target EventSystem input primitives. These are not a universal autonomous UI tester. The assistant must select the semantic control, set the current target path, inspect the returned input acknowledgment and assess the observed result against its catalog entry. Duplicate social-button paths are ambiguous and require an additional current identifier/icon. Do not blindly retry sent input or infer a PASS from it. No private game callbacks are invoked.

Run `node projects/ocean-nomad/tools/fast-ui/main-menu.test.mjs` for the final-state and unexpected-window controller checks. `FastUiSession.prepare()` now prepares nine guarded role/observation commands, without game input.

On 22 October 2026 the human explicitly approved running this familiar route as one skill, with control returned to the assistant for unexpected UI. This supersedes the earlier per-click decision requirement for this route only. Deletion of the QA project's progress was also explicitly authorized. `skill.mjs` does not authorize use on other projects or accounts.

`runKnownNewGame(session)` chooses only among the already learned menu/settings/new-game/confirmation states. It supports entering Settings directly from the map UI or through the raft/island dashboard. Unknown windows, scenes, unrelated confirmations, missing targets and backwards transitions stop the skill. Successful pointer input is never repeated while waiting for the next window. A transient blocked/covered result means no input was sent; the same known target is awaited for up to 12 attempts within the overall deadline.

The assistant launches one skill invocation; the skill makes multiple MCP requests internally. It stops when the authorized «ДА» click is acknowledged. Quest state and production reset behavior are outside this UI skill. `finally` calls `finish()` to cancel delayed input and restore the background setting. If the host kills the JavaScript session, perform the same cleanup through a recovered MCP connection before further work.

## Evidence

- Compilation-only preparation passed; no input during preparation.
- Four non-UI tests passed: unknown/unrelated windows, delayed transition without duplicate click, cleanup on unknown state, transient overlap without repeating successful input.
- First live skill invocation opened the dashboard but stopped on a covered Settings target in 0.329 s. This failed attempt is retained as local episode `2026-10-22-newgame-05`.
- After bounded readiness handling was added, live episode `2026-10-22-newgame-06` completed **Settings → NewGame → «ДА» from an already open dashboard in 0.400 s** (0.470 s outer tool-call wall time). This is three actions, not a measurement of all four actions from gameplay HUD. Cleanup restored `runInBackground=false`.
- Previous per-click execution took about 25 s for four actions after the menu became usable, with 115 s total including initial loading/block investigation and decision pauses (episode 04). These different starting conditions must not be presented as a controlled benchmark.

Run `node projects/ocean-nomad/tools/fast-ui/skill.test.mjs` from the automation repository root. Local live reports remain outside Git under `outputs/unity-mcp/newgame/runs/` in the host workspace. Game scripts/scenes were not modified; commands use the existing execute_code/batch_execute cache.

## First consolidated live run

The later explicitly requested live run on 22 October 2026 passed all 13 learned UI checks in **4.055 s**, including begin, navigation, assertions, baseline restoration, reopening and cleanup; prior compilation preparation is excluded. New red errors: 0. No pending restorations. Earlier NOT_RUN notes above describe preparation before this run. Human speed acceptance has not yet been received.

## Learned introductory pages before Premium

The human approved skipping the observed «ПОСТРОЙ ПЛОТ МЕЧТЫ!» and «ВЫЖИВАЙ НА ПЛОТУ!» pages with Continue. The final «НАСЛАЖДАЙСЯ ИГРОЙ И ПОЛУЧАЙ БОНУСЫ» offer is closed with its cross. `overlays.mjs` chooses by the normalized exact heading and current matching control, with the intro heading/label rechecked on the input frame. Hidden active subscription labels were observed during intro, so they are not used as the page identity. There is no blind fixed-count Continue loop. Unknown headings return control; missing controls on known pages are awaited within the existing deadline. Three new main-menu tests cover the chain, hidden price text, and delayed-page no-replay; all 11 tests pass. This integrated flow has not yet been replayed live. `FastUiSession.prepare()` now covers 11 guarded commands (10 actions and observation).
