# Changelog

## 0.2.0 — 2026-10-23

- Added passive Ocean Nomad quest/world module: tracked/active quests, steps, target UIDs, progress and limited completion-history membership.
- Captures matching loaded pickables with runtime/saved IDs, state, world/local positions, distances and geometric camera yaw/elevation errors.
- Uses existing TestGUI panel references for QuestManager; never resolves/creates a game service or calls game actions. Missing/ambiguous sources remain unknown.
- Added bounded read-only ReadSnapshot/ReadNearby methods for MCP execute_code use; these are not separate native MCP tools.
- Module emits initial/final snapshots, changed snapshots up to5Hz and a2s heartbeat. Scene transitions invalidate source caches.
- Coordinates/bearings are observations. Visibility, reachability, a safe route and automatic camera/movement control are not implemented. Inventory changes are not recorded yet.

## 0.1.0 — 2026-10-23

- Existing Editor recorder packaged as a local UPM dependency; Unity 6000.0 is the minimum version.
- Preserved recording menu, action/video controls, LogicLight and ocean-demo/1 journal compatibility.
- Added an observation-provider contract; Ocean Nomad reflection adapter is isolated from the core recorder.
- Added session/sample hooks and namespaced module events for future inventory, quest and interaction telemetry.
- Package identity/version and selected observation profile are included in session metadata.
- Editor-only assembly; no recorder code in player builds.

Inventory, quest-result recording and automatic gameplay remain outside this release.
