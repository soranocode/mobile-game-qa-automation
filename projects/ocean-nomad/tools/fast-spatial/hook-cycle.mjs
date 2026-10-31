const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Dependencies own live input/observation. This module never calls Unity or replays a click.
// aim(id) must return {status:'aimed'}; click(id) must explicitly acknowledge click_sent:true
// or status:'sent'. readState({targetInstanceId, click, waited_ms}) must return a fresh busy
// boolean; pickup IDs/events must belong to this throw, not a cumulative history.
// Optional checkErrors() returns false or {blocked:true} to stop without further input.
export class HookWaitCycle {
  constructor({ aim, click, readState, wait = sleep, trace = () => {}, checkErrors }) {
    for (const [name, fn] of Object.entries({ aim, click, readState, wait, trace })) {
      if (typeof fn !== 'function') throw new TypeError(`${name} must be a function`);
    }
    if (checkErrors != null && typeof checkErrors !== 'function') throw new TypeError('checkErrors must be a function');
    Object.assign(this, { aim, click, readState, wait, trace, checkErrors });
    this.running = false;
  }

  async run(targetInstanceId) {
    if (!Number.isSafeInteger(targetInstanceId) || targetInstanceId === 0) throw new TypeError('A runtime instance ID is required');
    if (this.running) return { status: 'already_running', click_sent: false };
    this.running = true;
    let clickSent = false;
    let waited = 0;
    const timed = async (phase, fn, detail = {}) => {
      const started = performance.now();
      try { return await fn(); }
      finally { this.trace({ phase, target_instance_id: targetInstanceId, ms: performance.now() - started, ...detail }); }
    };
    const blocked = async () => {
      if (!this.checkErrors) return null;
      const result = await timed('check_passive_errors', () => this.checkErrors());
      return result === false || result?.blocked === true
        ? { status: 'blocked_new_error', click_sent: clickSent, waited_ms: waited, error_watch: result }
        : null;
    };
    try {
      const initialBlock = await blocked();
      if (initialBlock) return initialBlock;
      const aim = await timed('aim', () => this.aim(targetInstanceId));
      if (aim?.status !== 'aimed') return { ...aim, status: aim?.status ?? 'aim_unknown', click_sent: false };
      const beforeClickBlock = await blocked();
      if (beforeClickBlock) return beforeClickBlock;
      const click = await timed('hook_click', () => this.click(targetInstanceId));
      clickSent = click?.click_sent === true || click?.status === 'sent';
      if (!clickSent) return { status: 'click_unknown', click_sent: false, click };

      let state;
      const observations = [];
      // No state polling during the first three seconds. A busy hook gets at most
      // two one-second extensions; there is never another click inside this action.
      for (const duration of [3000, 1000, 1000]) {
        await timed('wait_hook_return', () => this.wait(duration), { requested_ms: duration });
        waited += duration;
        const afterWaitBlock = await blocked();
        if (afterWaitBlock) return afterWaitBlock;
        state = await timed('read_hook_result', () => this.readState({ targetInstanceId, click, waited_ms: waited }));
        if (state?.busy !== true && state?.busy !== false) return { status: 'hook_state_unknown', click_sent: true, waited_ms: waited, state };
        observations.push(state);
        if (!state.busy) break;
      }
      if (state.busy) return { status: 'hook_still_busy', click_sent: true, waited_ms: waited, state };

      const ids = [...new Set(observations.flatMap(s => s.collected_instance_ids ?? []).filter(Number.isSafeInteger))];
      const uids = [...new Set(observations.flatMap(s => s.collected_uids ?? []).filter(uid => typeof uid === 'string'))];
      const intendedCollected = ids.includes(targetInstanceId);
      const otherCollected = ids.length > 0 || uids.length > 0 || observations.some(s => s.throw_result === 'collected');
      // A successful click, vanished object, or historical completed UID cannot
      // establish quest completion. The observer must supply a fresh final result.
      const finalResult = observations.find(s => s.completion_fresh === true && s.step_complete === true &&
        ['active_step', 'quest_done_event'].includes(s.completion_source) &&
        s.quest_uid === 'hook_use' && s.step_uid === 'use_wooden_hook' &&
        s.need === 3 && Number.isFinite(s.progress_after) && s.progress_after >= s.need);
      const finalConfirmed = Boolean(finalResult);
      return {
        status: intendedCollected ? 'collected' : otherCollected ? 'other_item_collected'
          : observations.some(s => s.throw_result === 'miss') ? 'miss' : 'miss_without_result_event',
        click_sent: true, intended_instance: targetInstanceId, collected_instance_ids: ids,
        collected_uids: uids, waited_ms: waited, progress_after: finalResult?.progress_after ?? state.progress_after,
        need: finalResult?.need ?? state.need, step_complete: finalConfirmed, completion_fresh: finalConfirmed,
        completion_source: finalResult?.completion_source, state,
      };
    } finally { this.running = false; }
  }
}
