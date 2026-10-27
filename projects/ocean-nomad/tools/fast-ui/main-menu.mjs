// Learned from runtime UI exploration, 2026-10-22. No game callbacks or scene loading.
import { chooseLearnedPremiumAction } from './overlays.mjs';
const W = {
  hud: 'DamageShower.DamageShowView', dashboard: 'Acme.Gui.Dashboard.UIDashboardView',
  settings: 'Survival.Views.UIView.UIPauseView', popup: 'Survival.Windows.Popups.UIPopupView',
  map: 'Survival.GlobalMap.MapView.MapComplex.MapComplexView',
  premium: 'MainScreen.Premium.PremiumWindowNew', main: 'MainScreen.MainScreenWindow2',
  discord: 'Survival.Windows.Popups.Discord.UIDiscordPopupView',
};
const KNOWN = new Set(Object.values(W));
const ORDER = ['open_menu', 'open_settings', 'exit_to_main_menu', 'confirm_exit',
  'skip_intro_build', 'skip_intro_survive', 'close_premium', 'close_discord'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function chooseMainMenuAction(state, { confirmed = false } = {}) {
  if (!Array.isArray(state?.windows) || !Array.isArray(state?.controls) || !Array.isArray(state?.scenes))
    return { halt: 'incomplete_ui_observation' };
  if (state.windows.some(w => !KNOWN.has(w))) return { halt: 'unknown_window' };
  const hasWindow = w => state.windows.includes(w);
  let role;
  if (hasWindow(W.popup)) {
    if (!state.confirmation_is_exit) return { halt: 'unexpected_confirmation' };
    role = 'confirm_exit';
  } else if (hasWindow(W.discord)) {
    if (!confirmed) return { halt: 'discord_outside_exit_transition' };
    role = 'close_discord';
  } else if (hasWindow(W.premium)) {
    if (!confirmed) return { halt: 'premium_outside_exit_transition' };
    return chooseLearnedPremiumAction(state);
  } else if (hasWindow(W.main)) {
    if (state.windows.some(w => w !== W.main)) return { halt: 'main_menu_obstructed' };
    const target = state.controls.filter(c => c.role === 'main_menu_continue' && !c.blocked);
    return target.length === 1 ? { complete: true } : { wait: 'main_menu_not_ready' };
  } else if (confirmed) {
    // Acknowledged confirmation may leave the old settings visible for a few frames.
    return state.scenes.every(s => ['Game', 'Map', 'Splash'].includes(s))
      ? { wait: 'exit_transition' } : { halt: 'unexpected_scene' };
  } else {
    if (!state.scenes.includes('Game')) return { halt: 'unexpected_scene' };
    role = hasWindow(W.settings) ? 'exit_to_main_menu'
      : hasWindow(W.dashboard) || hasWindow(W.map) ? 'open_settings' : 'open_menu';
  }
  const targets = state.controls.filter(c => c.role === role);
  if (targets.length !== 1) return { halt: 'missing_or_ambiguous_target' };
  return targets[0].blocked ? { wait: 'ui_blocked' } : { role };
}

export async function runKnownMainMenu(session, { timeoutMs = 15000, settleMs = 350, expectedErrors = [] } = {}) {
  const started = performance.now();
  const deadline = started + Math.max(1000, Math.min(timeoutMs, 20000));
  const events = [];
  let state, reason, failure, cleanup;
  let confirmed = false, lastIndex = -1, transientAttempts = 0, stableSince;
  const closedModals = new Set();
  let result = 'NEEDS_REVIEW';
  const timingStart = session.timings.length;
  try {
    state = await session.begin({ expectedErrors });
    while (performance.now() < deadline) {
      const decision = chooseMainMenuAction(state, { confirmed });
      if (decision.halt) { reason = decision.halt; break; }
      if (decision.complete) {
        stableSince ??= performance.now();
        if (performance.now() - stableSince >= Math.max(0, settleMs)) {
          result = 'PASS_MAIN_MENU'; break;
        }
      } else stableSince = undefined;
      if (decision.complete || decision.wait || ORDER.indexOf(decision.role) === lastIndex) {
        await sleep(25); state = await session.observe(); continue;
      }
      const index = ORDER.indexOf(decision.role);
      if (index < lastIndex && index < 4) { reason = 'unexpected_ui_regression'; break; }
      if (index >= 4 && closedModals.has(decision.role)) { reason = 'repeated_optional_window'; break; }
      const step = await session.step(decision.role);
      events.push({ role: decision.role, status: step.input.status,
        elapsed_ms: Math.round(performance.now() - started) });
      state = step.state;
      if (['not_sent_covered', 'not_sent_blocked'].includes(step.input.status)) {
        if (++transientAttempts > 12) { reason = step.input.status; break; }
        await sleep(25); state = await session.observe(); continue;
      }
      if (step.input.status !== 'sent') { reason = step.input.status ?? 'input_outcome_unknown'; break; }
      transientAttempts = 0; lastIndex = index;
      if (index >= 4) closedModals.add(decision.role);
      if (decision.role === 'confirm_exit') confirmed = true;
    }
    if (!reason && result !== 'PASS_MAIN_MENU') reason = 'timeout';
  } catch (error) { reason = error?.code === 'UNITY_NEW_ERROR' ? 'new_unity_error' : 'transport_or_session_error'; failure = String(error); }
  finally {
    try { cleanup = await session.finish(); }
    catch (error) { cleanup = { error: String(error), needs_cleanup: true }; }
    if (cleanup?.error_watch?.blocked) { result = 'NEEDS_REVIEW'; reason = 'new_unity_error'; }
  }
  return { result, reason, failure, events,
    elapsed_seconds: Number(((performance.now() - started) / 1000).toFixed(3)),
    tool_ms: Math.round(session.timings.slice(timingStart).reduce((sum, t) => sum + t.ms, 0)),
    final_state: state, cleanup, error_alert: session.errorAlert ?? (cleanup?.error_watch?.blocked ? cleanup.error_watch : undefined) };
}
