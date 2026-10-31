import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseKnownAction, runKnownNewGame } from './skill.mjs';

const state = (windows, roles, extra = {}) => ({ scenes: ['Game'], windows,
  controls: roles.map(role => ({ role, blocked: false })), ...extra });
const HUD = state(['DamageShower.DamageShowView'], ['open_menu']);
const DASH = state(['Acme.Gui.Dashboard.UIDashboardView'], ['open_menu', 'open_settings']);
const SETTINGS = state(['Survival.Views.UIView.UIPauseView'], ['start_new_game']);
const CONFIRM = state(['Survival.Windows.Popups.UIPopupView', 'Survival.Views.UIView.UIPauseView'],
  ['start_new_game', 'confirm_new_game'], { confirmation_is_new_game: true });

test('unknown windows and unrelated confirmation receive no click', () => {
  assert.equal(chooseKnownAction(state(['UnexpectedPurchaseWindow'], ['confirm_new_game'])).halt, 'unknown_window');
  assert.equal(chooseKnownAction({ ...CONFIRM, confirmation_is_new_game: false }).halt, 'unexpected_confirmation');
});

test('a delayed transition does not toggle the same menu twice', async () => {
  const clicked = [];
  let stage = 0;
  const session = {
    timings: [],
    async begin() { return HUD; },
    async observe() { return stage === 1 ? DASH : HUD; },
    async step(role) {
      clicked.push(role);
      stage++;
      return { input: { status: 'sent' }, state: [HUD, SETTINGS, CONFIRM, CONFIRM][stage - 1] };
    },
    async finish() { return { stopped: true }; },
  };
  const r = await runKnownNewGame(session);
  assert.equal(r.result, 'PASS_UI_ROUTE');
  assert.deepEqual(clicked, ['open_menu', 'open_settings', 'start_new_game', 'confirm_new_game']);
});

test('unknown initial state stops with cleanup and no input', async () => {
  let clicks = 0;
  let cleaned = false;
  const r = await runKnownNewGame({ timings: [], async begin() { return state(['UnexpectedWindow'], ['open_menu']); },
    async step() { clicks++; }, async finish() { cleaned = true; return { stopped: true }; } });
  assert.equal(r.reason, 'unknown_window');
  assert.equal(clicks, 0);
  assert.equal(cleaned, true);
});

test('a briefly covered known button is awaited; sent input is not repeated', async () => {
  let attempts = 0;
  const clicked = [];
  const r = await runKnownNewGame({ timings: [], async begin() { return DASH; }, async observe() { return DASH; },
    async step(role) {
      if (++attempts === 1) return { input: { status: 'not_sent_covered' }, state: DASH };
      clicked.push(role);
      return { input: { status: 'sent' }, state: role === 'open_settings' ? SETTINGS : CONFIRM };
    }, async finish() { return { stopped: true }; } });
  assert.equal(r.result, 'PASS_UI_ROUTE');
  assert.deepEqual(clicked, ['open_settings', 'start_new_game', 'confirm_new_game']);
});
