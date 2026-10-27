# Warm shark defense through Unity MCP

Ocean Nomad 2.11.0 dev, Unity 6000.0.66f2. Installed as compiled in-memory delegates;
no game source/package changes, no teleport or direct damage/quest-complete calls.

Use an existing project-guarded FastUiSession with install.mjs:

- prepareDefense(session): compile seven jobs, install disarmed supervisor; sends no input.
- setArmed(session,true): enable passive game-signal/log listener.
- readDefense(session): compact state plus bounded event journal.
- defendCurrentAttack(session): same combat entry for an already active shark quest;
  never starts a quest or forces an attack.
- stopDefense(session): cancel owned input and remove callbacks/subscriptions.

Idle does not build a map or fetch target coordinates. It listens to SharkAttacked(true)
and D.OnNewLog Showing alert SharkAttack, confirms the live attack flag, and rebinds its
live shark source at most once per second. No model call or Console polling per frame.
It survives a Node/client reset; Play stop/domain reload requires installation again.

Wake cancels ordinary UI/route/aim/motor input, freezes a semantic task checkpoint,
closes known windows with ordinary Close/Back, obtains live geometry/weapon/enemy data,
and selects the equipped weapon family. Ranged starts with stationary Look and UI use;
it does not plan an approach when the shot is clear. Out-of-range targets are awaited
without movement. Only confirmed solid cover allows a bounded route to a nearby clear
firing position, followed by fresh aim and hit validation. Melee keeps the existing
approach/Look/use controllers. A shark can still be approaching when
the alert fires: stage towards the attacked foundation, then replan to actual melee
range. Supported starts outside an extra reserve get a bounded, physically checked
recovery gesture. Water/unsupported routes and unknown windows do not get blind input.

Success requires fresh retreat + HP damage; death is separate. Flag disappearance,
timeout or an accepted input command alone is not success. New unexplained red errors,
lost sources/focus, stalled motion or 45-second budget stop input with needs_review.
Inspect that reason before rearming; do not silently clear the error baseline.

Normal passive duty uses SessionState QaAgent.SharkDefense.require_melee=false and
the equipped melee or ranged weapon. Set true only for an explicitly selected melee
training task. Hook and the observed Rifle/Pistol-activity defense were approved
separately; spear, other guns and general reload behavior remain unverified. Rifle uses
the game's read-only HitScanShooter probes; melee retains the .33 spherecast. Normal input uses the actual
weapon; no ammo, durability or health values are edited.

The stationary ranged policy and the no-movement out-of-range/unknown cases passed
12 no-input decision checks on 27 October. All jobs and the reactor compiled in Unity.
A new full combat trial of this version, including cover reposition, is still pending.

## Resume an interrupted test/training

priority-task.mjs supplies PriorityTask(session,{kind:'test'|'training',resume}).
runSteps records the semantic step/context before each action and waits while defense
owns input. A resume callback re-observes the world/UI and explicitly returns
retry_after_revalidation or step_already_completed. Never blindly replay confirmation,
purchase, progress reset or coordinates. Ordinary legacy tasks without this wrapper
are not automatically resumed. Four coordinator unit checks passed; a complete live
menu-test interrupt/defend/resume scenario remains unverified.

    node projects/ocean-nomad/tools/shark-defense/priority-task.test.mjs

## Verified on 26 October 2026

Human-approved Hook defense: 6 damage events (27 total), HP100→73, first damage2.743s,
retreat9.323s after wake, no new red errors, player grounded, route/motor released.
The initial route started about25ms after wake. Firearm defense was separately approved:
44damage, retreat2.923s. Do not label that firearm trial as Hook combat.

The outcome delegate passed five no-input cases; native planner was checked without
movement. Previous failures are retained: spawn inside extra obstacle reserve;
duplicate start of already active shark_attack caused2red errors; MCP composited
screenshot caused5recursive PlayerLoop errors. Avoid both repeated quest start and
that screenshot path. Read knowledge owners ON-SAFETY-SHARK-DEFENSE-001,
ON-COMBAT-SHARK-MELEE-001 and ON-COMBAT-FIREARM-SHOT-001 for exact scope/approval.
Raw evidence stays outside Git, under parent-workspace outputs/unity-mcp/shark-defense/.
