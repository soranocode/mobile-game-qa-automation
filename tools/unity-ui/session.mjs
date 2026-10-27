// One assistant-selected UI action per step, guarded by passive Unity error events.
import { UnityErrorMonitor, NewUnityError, ERROR_WATCH_SNAPSHOT,
  armErrorMonitorCode, DISARM_ERROR_MONITOR, validateExpectedErrors } from './error-monitor.mjs';
const PREFIX = 'QaAgent.FastUi.';
const EXEC = code => ({ tool: 'execute_code', params: { action: 'execute', code, safety_checks: true, compiler: 'auto' } });
const ROLES = new Set(['open_menu', 'open_settings', 'start_new_game', 'confirm_new_game',
  'exit_to_main_menu', 'confirm_exit', 'close_premium', 'close_discord', 'skip_intro_build', 'skip_intro_survive']);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export class FastUiSession {
  constructor(invokeTool, code) {
    this.invoke = invokeTool;
    this.code = code;
    this.active = false;
    this.timings = [];
    this.errors = new UnityErrorMonitor(invokeTool);
  }

  body(role) {
    if (role !== 'observe' && !ROLES.has(role)) throw new Error('Unknown single UI action');
    return this.instrument(this.code.replace('__ROLE__', role));
  }

  instrument(code) {
    if (!code.includes('__ERROR_WATCH_SETUP__')) throw new Error('UI template is missing the error watcher guard');
    return code.replace('__ERROR_WATCH_SETUP__', ERROR_WATCH_SNAPSHOT);
  }

  async batch(commands, { checkErrors = true } = {}) {
    const started = performance.now();
    const result = await this.invoke('batch_execute', { commands, parallel: false, fail_fast: true });
    this.timings.push({ kind: 'batch', calls: commands.length, ms: performance.now() - started });
    if (!result?.success || !Array.isArray(result.data?.results)) throw new Error('MCP batch failed; do not retry input blindly');
    const values = result.data.results.map(item => {
      if (!item.callSucceeded || !item.result?.success) throw new Error('Unity operation failed; observe before retrying input');
      return item.result.data?.result;
    });
    const alert = values.find(value => value?.status === 'blocked_new_error' ||
      value?.error_watch?.blocked || value?.error_watch?.available === false);
    if (checkErrors && alert) {
      this.errorAlert = { ...alert.error_watch, input_status: alert.status,
        selected_role: alert.selected_role ?? alert.role };
      throw new NewUnityError(this.errorAlert);
    }
    return values;
  }

  async prepare() {
    if (this.active) throw new Error('Finish the current UI session before preparing commands');
    const setWarmup = EXEC(`UnityEditor.SessionState.SetBool("${PREFIX}warmup", true); return new { input_sent = false };`);
    const results = await this.batch([setWarmup, ...[...ROLES, 'observe'].map(role => EXEC(this.body(role)))]);
    if (!results.slice(1).every(r => r?.status === 'compiled_only' && r.input_sent === false))
      throw new Error('Compilation-only preparation did not return the expected guard');
    return { compiled: ROLES.size + 1, input_sent: false };
  }

  async begin({ expectedErrors = [] } = {}) {
    if (this.active) throw new Error('UI session already active');
    this.errorAlert = undefined;
    validateExpectedErrors(expectedErrors);
    await this.errors.install();
    const setup = `const string p = "${PREFIX}";
if (UnityEditor.SessionState.GetBool(p + "active", false)) return new { status = "already_active" };
UnityEditor.SessionState.SetBool(p + "previous_background", UnityEngine.Application.runInBackground);
UnityEditor.SessionState.SetBool(p + "active", true);
UnityEditor.SessionState.SetBool(p + "warmup", false);
UnityEngine.Application.runInBackground = true;
UnityEditor.EditorApplication.QueuePlayerLoopUpdate();
${armErrorMonitorCode(expectedErrors).replace('return new { armed = true, expected_rules = '+expectedErrors.length+' };', '')}
return new { status = "begun" };`;
    const [ack, state] = await this.batch([EXEC(setup), EXEC(this.body('observe'))]);
    if (ack?.status !== 'begun') throw new Error('Another UI session is active; no input sent');
    this.active = true;
    return state;
  }

  async observe() {
    return (await this.batch([EXEC(this.body('observe'))]))[0];
  }

  async step(role, waitMs = 450) {
    if (!this.active) throw new Error('Begin the UI session before input');
    if (this.errorAlert) throw new NewUnityError(this.errorAlert);
    if (!ROLES.has(role)) throw new Error('Unsupported single UI action');
    const [ack, firstState] = await this.batch([EXEC(this.body(role)), EXEC(this.body('observe'))]);
    if (ack?.status !== 'pending') return { input: ack, state: firstState };
    let state = firstState;
    const deadline = performance.now() + Math.max(0, Math.min(waitMs, 800));
    // Wait for the already-chosen action only. Never select or repeat a click.
    while (state?.status === 'pending' && performance.now() < deadline) {
      await delay(20);
      state = await this.observe();
    }
    return { input: { role, status: state?.status ?? 'unknown' }, state };
  }

  async finish() {
    // Invalidate a delayed coroutine before it can act after stop/timeout.
    const code = `${ERROR_WATCH_SNAPSHOT}
const string p = "${PREFIX}";
UnityEditor.SessionState.SetInt(p + "sequence", UnityEditor.SessionState.GetInt(p + "sequence", 0) + 1);
UnityEditor.SessionState.SetString(p + "status", "stopped");
if (UnityEditor.SessionState.GetBool(p + "active", false))
    UnityEngine.Application.runInBackground = UnityEditor.SessionState.GetBool(p + "previous_background", false);
UnityEditor.SessionState.SetBool(p + "active", false);
UnityEditor.SessionState.SetBool(p + "warmup", true);
return new { stopped = true, run_in_background = UnityEngine.Application.runInBackground,
    error_watch = errorWatchSnapshot() };`;
    try {
      return (await this.batch([EXEC(code), EXEC(DISARM_ERROR_MONITOR)], { checkErrors: false }))[0];
    } finally { this.active = false; }
  }
}
