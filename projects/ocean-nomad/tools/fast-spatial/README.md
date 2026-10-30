# Approved hook_use skill and spatial primitives

Human approval23October2026: two full Ocean Nomad2.11.0dev hook_use trials in Unity6000.0.66f2 Editor. Contract: knowledge/skills/ON-SPATIAL-HOOK-COLLECT-001.json. Registry: approved-skills.json. This approval covers the current Editor quest and targets; general navigation, jumping and other quests remain unverified.

## Observed result

Full launch plus collection:23.597s with3clicks, then21.636s with4clicks. From closed cheat panel to first click:1.564/1.818s. From first hook click to final read:10.081/13.422s. Both fresh QuestSignals.Done events recorded use_wooden_hook3/3 IsComplete=true;0new red errors. First trial includes7.329s in its initial open command. Preparation of a fresh environment is separate. Raw evidence stays local outside Git: unity-mcp/hook-approved/2026-10-23-hook-frame-approved/report.json; failed/intermediate attempts are retained.

## Reusable execution

- aim-hook.mjs and aim-and-hook.cs.txt: use run(currentRuntimeId,{aimOnly:true}), then normal UI click immediately. Do not use the older combined collect mode: click_no_action/timeout/hook_busy.
- quest-click-frame.cs.txt: semantic TestGUI targets; Focus+MouseMove, later real frame Down, later frame Up. The wrapper waits terminal status up to2.5s, then1s before another action. Never call it through the old120ms release helper. Confirm actual panel transitions/Started.
- selected-control.cs.txt: the proven normal EventSystem click used by these trials.
- hook-observer.cs.txt: passive prepare/read/stop. A single read returns current world, activity and a fresh Done for the watched quest instance. No game commands/Resolve.
- hook-cycle.mjs: one aim/click,3s without reads, then up to two1s extensions if still busy. Unknown or busy at5s stops. The4/5s branches have simulated coverage only.
- hook-queue.mjs: fixed runtime-ID queue with live coordinates; remove another collected quest item, keep current intended item; first attempt plus at least3retries. Empty queue/history alone never proves completion.
- hook-trial.mjs#runHookTrial: the bounded assistant-selected MCP route and fresh final assertion. A short HUD readiness wait avoids failing while bindings are settling.
- runtime-bindings.mjs#createHookBindings: exact tested Node input wrappers rebound to a supplied project-guarded session. Creation only builds local callbacks. Commands compile on first actual use; observer installation happens inside the real run. Input callbacks require a session already begun and a local parameter file outside Git.

The assistant selects the quest/skill; these are bounded MCP actions, not an independent background test or a native MCP service. Only one session/executor owns Unity. Use ordinary session.batch defaults so a new passive error blocks the next action/result. Release input, stop the observer and finish the session on exit. runHookTrial owns cleanup once entered; preparation failures must also be cleaned up by the caller.

## Restoration in another session

Read the skill contract and selected dependencies, establish the correct local Unity MCP connection using tools/unity-ui, and create the FastUiSession. Load these source files, create AimHookAction and createHookBindings, use the local prepareHookMission factory and invoke its run handler for the current task; the handler begins observation and executes commands as needed. New runtime IDs/coordinates come from the current quest. Keep credentials, machine paths and parameter files out of Git. Fresh bootstrap on another PC has not yet been verified; copying the automation does not install the game or Unity.

## Offline checks

    node projects/ocean-nomad/tools/fast-spatial/hook-cycle.test.mjs
    node projects/ocean-nomad/tools/fast-spatial/hook-queue.test.mjs

14cycle,10queue and6binding checks passed. New binding checks validate the reconstruction layer separately; they do not replace the two runtime trials. The learning method and why earlier attempts were slow are preserved in brain/KNOWLEDGE_WORKFLOW.md.
