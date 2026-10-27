// Approved learned route. Unknown windows return control to the assistant.
const KNOWN_WINDOWS = new Set([
  'DamageShower.DamageShowView',
  'Acme.Gui.Dashboard.UIDashboardView',
  'Survival.Views.UIView.UIPauseView',
  'Survival.Windows.Popups.UIPopupView',
  'Survival.GlobalMap.MapView.MapComplex.MapComplexView',
]);
const ORDER = ['open_menu', 'open_settings', 'start_new_game', 'confirm_new_game'];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function chooseKnownAction(state) {
  if (!Array.isArray(state?.scenes) || !state.scenes.includes('Game'))
    return { halt: 'unexpected_scene' };
  if (!Array.isArray(state.windows) || !Array.isArray(state.controls))
    return { halt: 'incomplete_ui_observation' };
  if (state.windows.some(w => !KNOWN_WINDOWS.has(w))) return { halt: 'unknown_window' };
  const has = role => state.controls.some(c => c.role === role);
  let role;
  if (state.windows.includes('Survival.Windows.Popups.UIPopupView')) {
    if (!state.confirmation_is_new_game || !has('confirm_new_game'))
      return { halt: 'unexpected_confirmation' };
    role = 'confirm_new_game';
  } else if (state.windows.includes('Survival.Views.UIView.UIPauseView')) role = 'start_new_game';
  else if (state.windows.includes('Acme.Gui.Dashboard.UIDashboardView')) role = 'open_settings';
  else if (state.windows.includes('Survival.GlobalMap.MapView.MapComplex.MapComplexView')) role = 'open_settings';
  else role = 'open_menu';
  const candidates = state.controls.filter(c => c.role === role);
  if (candidates.length !== 1) return { halt: 'missing_or_ambiguous_target' };
  return candidates[0].blocked ? { wait: 'ui_blocked', role } : { role };
}

export async function runKnownNewGame(session, { timeoutMs = 10000, expectedErrors = [] } = {}) {
  const started = performance.now();
  const deadline = started + Math.max(1000, Math.min(timeoutMs, 20000));
  const events = [];
  let state;
  let lastIndex = -1;
  let transientRole;
  let transientAttempts = 0;
  let result = 'NEEDS_REVIEW';
  let reason;
  let failure;
  let cleanup;
  const timingStart = session.timings.length;
  try {
    state = await session.begin({ expectedErrors });
    while (performance.now() < deadline) {
      const decision = chooseKnownAction(state);
      if (decision.halt) { reason = decision.halt; break; }
      const index = ORDER.indexOf(decision.role);
      if (index < lastIndex) { reason = 'unexpected_ui_regression'; break; }
      // Waiting for a known transition never repeats a successful click.
      if (decision.wait || index === lastIndex) {
        await pause(25);
        state = await session.observe();
        continue;
      }
      const step = await session.step(decision.role);
      events.push({ role: decision.role, elapsed_ms: Math.round(performance.now() - started), status: step.input.status });
      state = step.state;
      if (step.input.status === 'not_sent_covered' || step.input.status === 'not_sent_blocked') {
        if (transientRole !== decision.role) { transientRole = decision.role; transientAttempts = 0; }
        if (++transientAttempts > 12) { reason = step.input.status; break; }
        // No pointer event was sent. Wait for this same known UI transition.
        await pause(25);
        state = await session.observe();
        continue;
      }
      if (step.input.status !== 'sent') { reason = step.input.status ?? 'input_outcome_unknown'; break; }
      lastIndex = index;
      if (decision.role === 'confirm_new_game') { result = 'PASS_UI_ROUTE'; break; }
    }
    if (!reason && result !== 'PASS_UI_ROUTE') reason = 'timeout';
  } catch (error) {
    failure = String(error);
    reason = error?.code === 'UNITY_NEW_ERROR' ? 'new_unity_error' : 'transport_or_session_error';
  } finally {
    try { cleanup = await session.finish(); }
    catch (error) { cleanup = { error: String(error), needs_cleanup: true }; }
    if (cleanup?.error_watch?.blocked) { result = 'NEEDS_REVIEW'; reason = 'new_unity_error'; }
  }
  return {
    result, reason, failure, events,
    elapsed_seconds: Number(((performance.now() - started) / 1000).toFixed(3)),
    tool_ms: Math.round(session.timings.slice(timingStart).reduce((sum, t) => sum + t.ms, 0)),
    final_state: state, cleanup, error_alert: session.errorAlert ?? (cleanup?.error_watch?.blocked ? cleanup.error_watch : undefined),
  };
}
