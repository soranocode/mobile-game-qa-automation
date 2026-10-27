import test from 'node:test';
import assert from 'node:assert/strict';
import { HookTargetQueue, runHookQueue, ensureHookQuest } from './hook-queue.mjs';

const target = (id, uid, yaw = 0) => ({ instance_id: id, uid, position_world: [id, 0, 0], scene_handle: 7,
  active_in_hierarchy: true, is_taken: false, yaw_error_degrees_positive_right: yaw, distance_from_camera: 5 });
const objects = [target(1, 'BoxTutorial'), target(2, 'BarrelTutorial', 10), target(3, 'LogTutotial', 20)];
function snapshot(targets = objects, value = 0) {
  return { quests: { availability: 'available', loaded: true, active_quests: [{ uid: 'hook_use', steps: [
    { uid: 'use_wooden_hook', active: true, is_complete: false, value, need: 3, target_uids: objects.map(t => t.uid) }]}] },
  spatial: { query_status: 'sampled', player: { scene_handle: 7 }, targets } };
}
test('a neighboring pickup removes that neighbor but retains the intended target', () => {
  const q = new HookTargetQueue(snapshot());
  q.apply(snapshot([objects[0], { ...objects[1], active_in_hierarchy: false, is_taken: true }, objects[2]], 1), { click_sent: true });
  assert.equal(q.current().id, 1);
  assert.equal(q.items.find(t => t.id === 2).state, 'gone');
  assert.equal(q.current().attempts, 1);
});
test('nonquest pickup does not advance the queue', () => {
  const q = new HookTargetQueue(snapshot());
  q.apply(snapshot(), { click_sent: true, status: 'other_item_collected' });
  assert.equal(q.current().id, 1);
});
test('allows three additional throws and does not skip a surviving target', async () => {
  const ids = [];
  const report = await runHookQueue({ readSnapshot: async () => snapshot(), action: { run: async id => {
    ids.push(id); return { status: 'miss', click_sent: true }; } } });
  assert.deepEqual(ids, [1, 1, 1, 1]);
  assert.equal(report.status, 'target_retry_budget_exhausted');
  assert.equal(report.queue.current().id, 1);
});
test('fourth throw can remove the target and advance', () => {
  const q = new HookTargetQueue(snapshot());
  for (let i = 0; i < 3; i++) assert.equal(q.apply(snapshot(), { click_sent: true }).target, 1);
  assert.equal(q.apply(snapshot(objects.slice(1), 1), { click_sent: true }).target, 2);
});
test('coordinate changes update the same instance instead of replanning order', () => {
  const q = new HookTargetQueue(snapshot());
  q.apply(snapshot([{ ...objects[0], position_world: [10, 1, 4], yaw_error_degrees_positive_right: 100 }, objects[1], objects[2]]), {});
  assert.equal(q.current().id, 1);
  assert.deepEqual(q.current().position, [10, 1, 4]);
});
test('unknown/truncated coverage never establishes disappearance', () => {
  const q = new HookTargetQueue(snapshot());
  const s = snapshot([]); s.spatial.targets_truncated = true;
  assert.equal(q.apply(s, {}).halt, 'incomplete_target_coverage');
  assert.equal(q.current().id, 1);
});
test('empty queue alone is not a quest pass', () => {
  const q = new HookTargetQueue(snapshot());
  assert.equal(q.apply(snapshot([]), {}).halt, 'queue_empty_waiting_for_quest_result');
});
test('an active requested quest is not restarted', async () => {
  let launches = 0;
  await ensureHookQuest({ readSnapshot: async () => snapshot(), launchQuest: async () => launches++ });
  assert.equal(launches, 0);
});
test('partial progress builds only the remaining live queue', () => {
  const q = new HookTargetQueue(snapshot(objects.slice(1), 1));
  assert.deepEqual(q.items.map(t => t.id), [2, 3]);
});
test('fresh final quest result establishes completion independently of order', async () => {
  let frame = 0;
  const ids = [];
  const snapshots = [snapshot(), snapshot([objects[0], objects[2]], 1), snapshot([objects[2]], 2), snapshot([], 3)];
  const result = await runHookQueue({ readSnapshot: async () => snapshots[frame], action: { run: async id => {
    ids.push(id); frame++; return { status: 'collected', click_sent: true, progress_after: frame, step_complete: frame === 3 }; } } });
  assert.deepEqual(ids, [1, 1, 3]);
  assert.equal(result.status, 'complete');
});
