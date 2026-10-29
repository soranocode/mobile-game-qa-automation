# Inventory primitives: experimental candidate

These files were exercised live on Ocean Nomad2.11.0 dev. They are not an approved universal prepared inventory handler and are not registered in portable prepareMissions/runPipeline. A future run still needs a current authorized task, custom-tools discovery, expected project, Play/Game, current domain epoch and exclusive idle ownership. Never reuse evidence instance IDs, saved screen coordinates or authorization. Do not warm unrelated settings missions.

## Current files and parameters

- motor.mjs: createInventoryMotor(qa, taskEvidenceDirectory, statusCode). Reads the C# files listed below from the task directory. Uses the existing qa.session, appends actions.jsonl, and saves requested snapshots. No hardcoded machine path. click waits for fresh read-only readiness for a bounded1.6s, dispatches once, then polls its result. A sent command is never replayed. not_sent is not a transition success.
- click.cs.txt: reads SessionState QaInventoryLearning.warmup, targetId, target, hold, fraction; requires QaAgent.FastUi.active and the current QaAgent.ErrorWatch.v1. targetId is a fresh GameObject ID; when0, target is a semantic hierarchy path. Set hold=0 for clicks. fraction is0..1 for Slider track position, default0.5. Fresh geometry and raycast are evaluated on each dispatch. Writes QaInventoryLearning.status/downFrame/upFrame, increments QaAgent.FastUi.sequence, and temporarily stores its own PointerEventData/targetGo in AppDomain QaInventoryLearning.held/targetGo. Down→real frames→up; ordinary UISimpleButton fires its callback on Up. target_changed after Up requires a new UI snapshot proving the expected transition.
- probe.cs.txt: same targetId/target/fraction/hold/warmup inputs and owner/error preconditions as click. It only checks current geometry/raycast and reports ready or not_sent; it sends no pointer events. A BG cover is a reason to inspect/wait for readiness, not permission to click through it. The historical BG fade explanation remains a candidate only.
- drag.cs.txt: reads QaInventoryLearning.warmup/sourceId/destId and the common owner/error/sequence state. Both IDs must come from a fresh snapshot. Sends down, begin-drag, movement frames, up and end-drag. Destination pointerEnter is derived from the actual raycast ancestor UIDragItemCell, not a decorative icon. Writes the same status/frame/own-held fields. It never calls gameplay model movement methods.
- hold.cs.txt: reads QaInventoryLearning.warmup/targetId/evidence plus the common owner/error/sequence state. evidence is an optional caller-configured task directory, not a path embedded in code. targetId is fresh. Uses actual raycast handler hierarchy and a1.05s Editor update callback, capturing before/during/after and removing its callback on release/stop. AppDomain QaInventoryLearning.holdRecord is the result; QaInventoryLearning.held is null after release. It sends no synthetic pointerClick, drag, or direct description Show. Use a new evidence directory to avoid overwriting filenames.
The local episode also retained hold-hook.cs.txt with alternate screenshot filenames. It is not included here because the generic hold primitive implements the same interaction.
- snapshot-inventory.cs.txt: read-only, no SessionState parameters. Returns active UIDragItemCell ID/storage/index/UID/quantity/durability/selected and current UI texts/controls. Only rendered active cells are included; do not assume this alone covers hidden/unrendered capacity in future inventories. Verify completeness before total invariants.
- snapshot-slider.cs.txt: current null-safe read-only slider observer. No external parameters; resolves the semantic SplitItemView slider path and reports missing/missing_slider instead of dereferencing null. min/max/value/whole are read only when ready.
- use-guard.cs.txt: read-only, no external parameters. Resolves the current Use button callback target and reads useInLongUnlock. Require ready and false before Use; selection UID/count must separately match the intended operation. An unresolved guard is not safe admission.

All input files use the installed passive error watcher with no cached Console exceptions. QaAgent.FastUi.sequence invalidates delayed actions on stop. QaInventoryLearning.warmup=true compiles input files without sending input; warm each file in a separate bounded call if the domain changed, then reset tofalse. qa.session.begin({expectedErrors:[]}) installs/arms observation and owns background execution. qa.session.finish() invalidates pending work and releases session/background state; verify own heldfalse as well.

## Example through the existing executor session

First copy this candidate directory's source files to a new ignored taskEvidenceDirectory. The motor reads code and writes evidence in that directory; never pass this tracked source directory as its evidence directory. The caller supplies qa, taskEvidenceDirectory, path and pathToFileURL from its current context; no absolute path, ID or coordinates are saved in this example.

```js
const {createInventoryMotor} = await import(pathToFileURL(
  path.join(taskEvidenceDirectory, 'motor.mjs')));
const statusCode = errorWatchSnapshotCode + `return new{
  status=UnityEditor.SessionState.GetString("QaInventoryLearning.status",""),
  down=UnityEditor.SessionState.GetInt("QaInventoryLearning.downFrame",0),
  up=UnityEditor.SessionState.GetInt("QaInventoryLearning.upFrame",0),
  held=System.AppDomain.CurrentDomain.GetData("QaInventoryLearning.held")!=null,
  error_watch=errorWatchSnapshot()};`;
const motor = await createInventoryMotor(qa, taskEvidenceDirectory, statusCode);
await qa.session.begin({expectedErrors: []});
try {
  const before = await motor.snapshot();
  // Choose currentTarget from current semantic component/control or UID+storage+index.
  // Validate allowed action, quantity and invariant before dispatch.
  await motor.click(currentTarget.id);
  const after = await motor.snapshot('current-action-after');
  // Confirm the expected transition before any dependent command.
} finally {
  await qa.session.finish();
  // Confirm current own held=false and background ownership released.
}
```

For drag, derive both current IDs from the same fresh compatible UI snapshot and call motor.drag(source.id,destination.id). For hold, configure current targetId/evidence with a small execute_code call, dispatch hold.cs.txt once through the existing session, then read AppDomain holdRecord after it releases; require before absence, during matching UID/tooltip, and after heldfalse.

Persist cross-call REPL state explicitly in a module object or globalThis. Variables declared inside try blocks were not a valid cross-call contract in the historical run. Stop on unexpected errors or unknown input outcomes; cleanup precedes any classified recovery.

## Operation admission

Before consuming, match one selected expected UID and its current count; confirm useInLongUnlock=false. Send one Use and inspect isolated before/after quantity plus effect. Never repeat a sent Use merely because UI animation is still running.

Remove deletes the entire selected stack. In the proved Trash test, Split first isolated quantity1; current snapshot then proved exactly one selected Trash1 before Remove→ДА. Do not confirm larger stacks. Purchase/advertising/unique/progress-changing actions remain outside these primitives' automatic admission.

A final popup close can leave a short visual overlay fade. Finish evidence only after read-only target raycast readiness, capture a stable frame, then finish the session. No extra click or consume is needed.

## Superseded material

Do not copy historical executable snippets out of tool history or JSON evidence. The original sliderStateCode used unguarded GameObject.Find(...).GetComponent and caused a read-only NullReferenceException when its popup was absent. It is superseded by snapshot-slider.cs.txt.

Early click/hold/slider variants existed in memory before final click.cs.txt/hold.cs.txt and were superseded. In particular, the early requested0.5s hold did not prove an actual tooltip; its cause is not asserted. The complete before/during/after1.05s hold is the proved primitive.

The local snapshot-general.cs.txt and snapshot-detail.cs.txt (not included here) are retained exploratory observations, not current recommended inventory state readers. They have larger/duplicated output and the detail reader's early text coverage differed. Use snapshot-inventory.cs.txt plus completeness checks. Historical JSON/PNG are evidence, never target caches.

The general project's selected-control.cs.txt was not changed by this executor and is not the motor validated here; its same-call down/up implementation does not establish the required frame-separated gestures.

## Scope of this saved candidate

The C# source is preserved from the live learning session; the JavaScript motor is an experimental low-level adapter, not an autonomous test driver. It does not select missions, grant authorization or register a prepared inventory task. Use only through the one designated executor. Stop/cancellation races and arbitrary item/storage types are not fully covered by this learning episode; review those boundaries before promoting this candidate to the approved registry. The statement about the old selected-control implementation above applies to the source inspected during this episode, not every later revision.

Knowledge owner: projects/ocean-nomad/knowledge/ui/ON-UI-INVENTORY-001.md. Compact source provenance: candidate.json. Raw runtime evidence, screenshots, private game code and current save data are excluded from this directory.
