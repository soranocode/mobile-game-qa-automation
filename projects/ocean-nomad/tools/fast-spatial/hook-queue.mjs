const clock = () => performance.now();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function questStep(snapshot) {
  return snapshot?.quests?.active_quests?.find(q => q.uid === 'hook_use')?.steps
    ?.find(s => s.uid === 'use_wooden_hook' && s.active && !s.is_complete);
}

function coverageProblem(snapshot) {
  if (snapshot?.quests?.availability !== 'available' || snapshot?.quests?.loaded !== true) return 'quest_source_unknown';
  if (snapshot?.spatial?.query_status !== 'sampled' || !snapshot.spatial.player) return 'world_source_unknown';
  if (snapshot.quests.quests_truncated || snapshot.quests.observed_target_limit_reached ||
      snapshot.spatial.targets_truncated || snapshot.spatial.candidate_scan_truncated) return 'incomplete_target_coverage';
  return null;
}

// A fixed queue of runtime instances, with live positions. Other pickups never change the current goal.
export class HookTargetQueue {
  constructor(snapshot, { maxAttemptsPerTarget = 4 } = {}) {
    if (!Number.isInteger(maxAttemptsPerTarget) || maxAttemptsPerTarget < 4) throw new Error('Allow the first throw and at least three retries');
    const issue = coverageProblem(snapshot);
    if (issue) throw new Error(issue);
    const step = questStep(snapshot);
    if (!step || step.need !== 3) throw new Error('hook_use is not active');
    this.scene = snapshot.spatial.player.scene_handle;
    this.need = step.need;
    this.initialProgress = step.value;
    this.maxAttemptsPerTarget = maxAttemptsPerTarget;
    const uids = new Set(step.target_uids);
    this.items = snapshot.spatial.targets
      .filter(t => uids.has(t.uid) && t.active_in_hierarchy && !t.is_taken && t.scene_handle === this.scene)
      .sort((a, b) => Math.abs(a.yaw_error_degrees_positive_right) - Math.abs(b.yaw_error_degrees_positive_right) || a.distance_from_camera - b.distance_from_camera)
      .map(t => ({ id: t.instance_id, uid: t.uid, initialPosition: t.position_world, position: t.position_world, attempts: 0, state: 'pending' }));
    if (this.items.length < step.need - step.value) throw new Error('targets_not_ready');
  }

  current() { return this.items.find(item => item.state === 'pending') ?? null; }

  apply(snapshot, result) {
    const issue = coverageProblem(snapshot);
    if (issue) return { halt: issue };
    if (snapshot.spatial.player.scene_handle !== this.scene) return { halt: 'scene_changed' };
    const current = this.current();
    if (current && result?.click_sent) current.attempts++;
    const live = new Map(snapshot.spatial.targets.map(t => [t.instance_id, t]));
    const removed = [];
    for (const item of this.items) {
      if (item.state !== 'pending') continue;
      const target = live.get(item.id);
      if (!target || target.is_taken || !target.active_in_hierarchy) {
        item.state = 'gone';
        item.reason = !target ? 'no_longer_observed' : target.is_taken ? 'taken' : 'inactive';
        removed.push(item.id);
      } else item.position = target.position_world;
    }
    // Disappearance updates the queue. The quest counter independently establishes completion.
    if (result?.step_complete && result.progress_after >= this.need) return { complete: true, removed };
    const next = this.current();
    if (!next) return { halt: 'queue_empty_waiting_for_quest_result', removed };
    if (next.attempts >= this.maxAttemptsPerTarget) return { halt: 'target_retry_budget_exhausted', target: next.id, removed };
    return { target: next.id, removed };
  }
}

export async function ensureHookQuest({ readSnapshot, launchQuest, trace = () => {} }) {
  let snapshot = await readSnapshot();
  if (questStep(snapshot)) return snapshot;
  if (!launchQuest) throw new Error('quest_inactive');
  const started = clock();
  await launchQuest();
  trace({ phase: 'quest_launch', ms: clock() - started });
  const deadline = clock() + 4000;
  do {
    snapshot = await readSnapshot();
    if (questStep(snapshot)) return snapshot;
    await sleep(100);
  } while (clock() < deadline);
  throw new Error('quest_did_not_start');
}

export async function runHookQueue({ action, readSnapshot, launchQuest, trace = () => {},
  maxAttemptsPerTarget = 4, timeoutMs = 45000 }) {
  const started = clock();
  let queue;
  const attempts = [];
  const timed = async (phase, fn) => {
    const before = clock();
    try { return await fn(); } finally { trace({ phase, ms: clock() - before }); }
  };
  const read = () => timed('read_live_coordinates', readSnapshot);
  let snapshot = await ensureHookQuest({ readSnapshot: read, launchQuest, trace });
  // A newly started quest may create its objects after the dialog/source refresh.
  const readyDeadline = clock() + 2500;
  while (!queue) {
    try { queue = new HookTargetQueue(snapshot, { maxAttemptsPerTarget }); }
    catch (e) {
      if (e.message !== 'targets_not_ready' || clock() >= readyDeadline) throw e;
      await timed('wait_target_spawn', () => sleep(100));
      snapshot = await read();
    }
  }
  trace({ phase: 'initial_queue', targets: queue.items.map(i => ({ id: i.id, uid: i.uid, position: i.position })) });
  while (queue.current()) {
    if (clock() - started > timeoutMs) return { status: 'run_timeout', queue, attempts, elapsed_seconds: (clock() - started) / 1000 };
    const target = queue.current();
    const result = await timed('aim_click_wait_hook', () => action.run(target.id));
    attempts.push({ intended_id: target.id, intended_uid: target.uid, result });
    snapshot = await read();
    const update = queue.apply(snapshot, result);
    trace({ phase: 'queue_update', intended_id: target.id, action_status: result.status, attempt: target.attempts, ...update });
    if (update.complete) return { status: 'complete', queue, attempts, elapsed_seconds: (clock() - started) / 1000 };
    if (update.halt) return { status: update.halt, queue, attempts, elapsed_seconds: (clock() - started) / 1000 };
    if (!['collected', 'miss', 'miss_without_result_event', 'other_item_collected', 'click_no_action', 'target_changed'].includes(result.status))
      return { status: result.status, queue, attempts, elapsed_seconds: (clock() - started) / 1000 };
    // Same current instance until it disappears; any other collected quest instance was already removed.
  }
  return { status: 'queue_empty_waiting_for_quest_result', queue, attempts, elapsed_seconds: (clock() - started) / 1000 };
}
