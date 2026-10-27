import test from 'node:test';
import assert from 'node:assert/strict';
import { runApprovedUiSkill } from './approved-ui.mjs';
test('unknown intents and mismatched adapters are rejected without input',async()=>{
  const session={};
  await assert.rejects(runApprovedUiSkill('buy_premium',{session}),/Unapproved/);
  await assert.rejects(runApprovedUiSkill('settings_ui',{session,settingsAdapter:{session:{}}}),/prepared adapter/);
});
test('opening settings never confirms an existing popup and always cleans up',async()=>{
  let input=0,cleanup=0;
  const session={async begin(){},async observe(){return {scenes:['Game'],windows:['Survival.Windows.Popups.UIPopupView'],
    controls:[{role:'confirm_new_game'}],confirmation_is_new_game:true};},
    async step(){input++;},async finish(){cleanup++;return {stopped:true};}};
  const r=await runApprovedUiSkill('open_game_settings',{session});
  assert.equal(r.result,'NEEDS_REVIEW');assert.equal(input,0);assert.equal(cleanup,1);
});
