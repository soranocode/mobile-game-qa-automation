# Raft navigation through Unity MCP

Ocean Nomad 2.11.0 dev, Unity Editor. The assistant selects semantic goals; a bounded
controller follows the route with ordinary joystick events. No teleport, transform
writes or private game movement methods. Flat axis-aligned foundation BoxColliders
are supported; slopes, overlapping floors, ladders, jumps and swimming need other skills.

## Fast path

1. Execute raft-snapshot-fast.cs.txt through the project-guarded MCP session. It reads
   only support rectangles, nearby collision candidates, player/controller and scene
   basis. No screenshot, hierarchy paths or render data.
2. Save the fresh snapshot outside Git. From the automation repository root run:

       python projects/ocean-nomad/tools/raft-navigation/plan_fast.py SNAPSHOT.json --goals "[[X,Z],[X,Z]]" --cache LOCAL_CACHE.json --out LOCAL_ROUTE.json

3. Import RaftRouteAction from route-action.mjs. Supply an existing FastUiSession,
   current route-driver.cs.txt source and an absolute local parameterFile. Call
   prepare() before timing, begin the session, then run(route,{analog:1,seconds:25}).
   The defaults are analog .85 and 25 seconds; hard limits are 1 and 45 seconds.
   Always finish the session after the subtask. Inspect fresh state after interruption;
   an input call is never automatically replayed.

The cache key includes scene/basis, floor IDs/bounds/rotation, nearby obstacles,
controller size and algorithm/clearance version. Player position and frame do not
rebuild static geometry. Each task still starts with a fresh snapshot. A* uses shared
cell sides; exact interval clipping removes extra waypoints without sampling across
holes. Safe cells merge into compact rectangles. Water reserve .30 and obstacle
reserve .23 include body radius .15, skin .03 and control margin. Image generation
and diagnostic contours are off by default; build_map.py --render is optional.

## Continuous controller

One BeginDrag starts movement. Direction updates each game frame using fresh camera
heading. Visible lookahead rounds corners within the safe support union, with slower
turns and goal approach. EndDrag releases input; four settling frames and at most two
small endpoint corrections verify the final stop. No model/MCP round trip per step.

Every game frame checks grounded state, safe region, predicted support ray and body
capsule. Cached floor bounds are checked every .2 seconds. New unexpected red errors,
lost focus, blocked controls, scene/geometry change, missing support, collision, stalled
movement or time budget release input. Unique request IDs reject stale completions.
Another executor must not send input concurrently. Runtime instances are ephemeral.

Collision queries follow the actual CharacterController layer matrix and per-collider
ignore pairs in both map collection and live movement. Nearby water resources on
non-colliding Item layers cannot block a route or overflow its collision buffer.
Support rays use the sampled foundation layers, so floating items cannot replace
the expected support hit. The shark approach planner uses the same policy.
HUD labels, action-button activities and hints are not route invalidation signals.
A disabled/blocked movement control, lost support, a real solid obstacle or a new
red error still releases input. A real obstacle stop includes collider ID/name/layer.
`collision-policy-self-test.mjs#runCollisionPolicySelfTest` checks the shared source
policy against existing floating, trigger and solid colliders without game input.
27 October regression: 18 floating colliders and 18 triggers ignored, 30 solids
retained. The updated route completed 41.94 units in 19.762 s with 1013/1013 grounded
checks and zero new red errors. This is a route check, not full-raft coverage.

## Verified on 26 October 2026

The earlier pulse controller visited all 31 sections of the previous raft. The layout
changed to 30 then 29 sections during optimization; stale geometry was rejected
without input and replanned. This new session verifies routes, not full-raft coverage.

Final route: 35.41 planned / 33.49 actual units, 12 waypoints, completed in 11.606 seconds
of controller time, 14.181 seconds including host launch/poll. One gesture, 697/697
grounded checks, zero new red errors. An earlier .85 run covered 36.41 units in 15.414
seconds with 889/889 grounded checks. Another run stopped safely on focus loss after
30.56 units; that attempt was not complete. Human approval and other layouts pending.

Fresh map computation about 17–19 ms; cached geometry about .7–1.2 ms; cached multi-goal
route 4–8 ms. These are CPU timings, excluding MCP/snapshot transport and process
startup. A short exploratory comparison gave 8 pulses in 3.214 seconds versus one
gesture in 1.909 seconds; reverse direction and rounded path differ, so this is not
a rigorous speed ratio. Do not compare earlier whole-session wall time to route time.

Checks (12 Python + 5 Node):

       python projects/ocean-nomad/tools/raft-navigation/test_build_map.py
       node projects/ocean-nomad/tools/raft-navigation/route-action.test.mjs

walker.mjs is the earlier pulse fallback; plan_tour.py remains the offline coverage
planner. Local evidence in the parent workspace: outputs/unity-mcp/raft-speed/
2026-10-26T07-37-06-629Z/. Knowledge owner ON-NAV-RAFT-001. No Unity reload or game-source
changes were required. No commit/push is implied by these local files.
