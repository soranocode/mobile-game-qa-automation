import test from 'node:test';
import assert from 'node:assert/strict';
import { HookWaitCycle } from './hook-cycle.mjs';

function harness(states, overrides = {}) {
  const events = [];
  let index = 0;
  const cycle = new HookWaitCycle({
    aim: async id => { events.push(['aim', id]); return { status: 'aimed' }; },
    click: async id => { events.push(['click', id]); return { status: 'sent', token: 'current-throw' }; },
    readState: async context => { events.push(['read', context.waited_ms, context.click.token]); return states[index++]; },
    wait: async ms => { events.push(['wait', ms]); },
    ...overrides,
  });
  return { cycle, events };
}

test('aim, one click, then three seconds without a state poll', async () => {
  const { cycle, events } = harness([{ busy: false, collected_instance_ids: [11] }]);
  const result = await cycle.run(11);
  assert.deepEqual(events, [['aim', 11], ['click', 11], ['wait', 3000], ['read', 3000, 'current-throw']]);
  assert.equal(result.status, 'collected');
  assert.equal(result.step_complete, false);
});

test('busy at three seconds waits to four, without another click', async () => {
  const { cycle, events } = harness([{ busy: true }, { busy: false, throw_result: 'miss' }]);
  assert.equal((await cycle.run(11)).status, 'miss');
  assert.deepEqual(events.filter(e => e[0] === 'wait'), [['wait', 3000], ['wait', 1000]]);
  assert.equal(events.filter(e => e[0] === 'click').length, 1);
});

test('busy at four seconds waits to five and accepts the returned hook', async () => {
  const { cycle, events } = harness([{ busy: true }, { busy: true }, { busy: false, collected_instance_ids: [11] }]);
  const result = await cycle.run(11);
  assert.equal(result.status, 'collected');
  assert.equal(result.waited_ms, 5000);
  assert.equal(events.filter(e => e[0] === 'read').length, 3);
});

test('a hook still busy at five seconds stops, never reclicks', async () => {
  const { cycle, events } = harness([{ busy: true }, { busy: true }, { busy: true }]);
  assert.equal((await cycle.run(11)).status, 'hook_still_busy');
  assert.equal(events.filter(e => e[0] === 'click').length, 1);
  assert.deepEqual(events.filter(e => e[0] === 'wait').map(e => e[1]), [3000, 1000, 1000]);
});

test('a transient pickup observed while returning is retained until the hook is ready', async () => {
  const { cycle } = harness([{ busy: true, collected_instance_ids: [11] }, { busy: false }]);
  const result = await cycle.run(11);
  assert.equal(result.status, 'collected');
  assert.deepEqual(result.collected_instance_ids, [11]);
  assert.equal(result.waited_ms, 4000);
});

test('a neighboring quest object is not the intended pickup', async () => {
  const { cycle } = harness([{ busy: false, collected_instance_ids: [12], collected_uids: ['BarrelTutorial'] }]);
  const result = await cycle.run(11);
  assert.equal(result.status, 'other_item_collected');
  assert.deepEqual(result.collected_instance_ids, [12]);
});

test('UID-only pickup cannot prove the intended runtime instance was collected', async () => {
  const { cycle } = harness([{ busy: false, collected_uids: ['BoxTutorial'] }]);
  assert.equal((await cycle.run(11)).status, 'other_item_collected');
});

test('sent click without a result is not a confirmed pickup', async () => {
  const { cycle } = harness([{ busy: false }]);
  const result = await cycle.run(11);
  assert.equal(result.status, 'miss_without_result_event');
  assert.equal(result.click_sent, true);
  assert.equal(result.step_complete, false);
});

test('history, disappearance, or stale final counter never establishes completion', async () => {
  for (const fields of [
    { history_completed_observed_quest_uids: ['hook_use'], target_gone: true },
    { step_complete: true, progress_after: 3, need: 3 },
    { step_complete: true, progress_after: 3, need: 3, completion_fresh: true, completion_source: 'history' },
  ]) {
    const { cycle } = harness([{ busy: false, quest_uid: 'hook_use', step_uid: 'use_wooden_hook', ...fields }]);
    assert.equal((await cycle.run(11)).step_complete, false);
  }
});

test('only an explicitly fresh final result for the requested quest establishes completion', async () => {
  const final = { busy: false, quest_uid: 'hook_use', step_uid: 'use_wooden_hook',
    step_complete: true, progress_after: 3, need: 3, completion_fresh: true, completion_source: 'quest_done_event' };
  assert.equal((await harness([final]).cycle.run(11)).step_complete, true);
  assert.equal((await harness([{ ...final, quest_uid: 'other_quest' }]).cycle.run(11)).step_complete, false);
});

test('an unexpected passive error after the wait stops before reading or another input', async () => {
  let checks = 0;
  const { cycle, events } = harness([{ busy: false }], { checkErrors: async () => ++checks < 3 || { blocked: true } });
  const result = await cycle.run(11);
  assert.equal(result.status, 'blocked_new_error');
  assert.equal(result.click_sent, true);
  assert.deepEqual(events.map(e => e[0]), ['aim', 'click', 'wait']);
});

test('a failed aim or uncertain click never triggers a blind retry', async () => {
  const first = harness([], { aim: async () => ({ status: 'hook_busy' }) });
  assert.equal((await first.cycle.run(11)).status, 'hook_busy');
  assert.deepEqual(first.events, []);
  const second = harness([], { click: async () => ({ status: 'pending' }) });
  assert.equal((await second.cycle.run(11)).status, 'click_unknown');
  assert.deepEqual(second.events, [['aim', 11]]);
});

test('unknown hook state stops instead of permitting another throw', async () => {
  const { cycle } = harness([{}]);
  assert.equal((await cycle.run(11)).status, 'hook_state_unknown');
});

test('overlapping runs never send a second input', async () => {
  let release;
  const { cycle, events } = harness([{ busy: false }], { wait: () => new Promise(resolve => { release = resolve; }) });
  const running = cycle.run(11);
  while (!release) await Promise.resolve();
  assert.equal((await cycle.run(12)).status, 'already_running');
  release();
  await running;
  assert.equal(events.filter(e => e[0] === 'click').length, 1);
});
