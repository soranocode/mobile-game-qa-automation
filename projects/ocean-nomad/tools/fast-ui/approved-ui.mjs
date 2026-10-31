// One bounded entry point; dispatch never broadens the approved behavior of a skill.
import { runKnownNewGame } from './skill.mjs';
import { runKnownMainMenu } from './main-menu.mjs';
import { ensureKnownSettings,runApprovedSettingsChecks } from './settings-skill.mjs';
export async function runApprovedUiSkill(id,{session,settingsAdapter},options={}) {
  if(id==='new_game')return runKnownNewGame(session,options);
  if(id==='main_menu')return runKnownMainMenu(session,options);
  if(id==='settings_ui') {
    if(!settingsAdapter||settingsAdapter.session!==session)throw Error('Use the prepared adapter for this session');
    return runApprovedSettingsChecks(settingsAdapter,options);
  }
  if(id==='open_game_settings') {
    const started=performance.now();let state,result='NEEDS_REVIEW',reason,cleanup;
    try {
      await session.begin({expectedErrors:options.expectedErrors??[]});
      state=await ensureKnownSettings(session);
      const allowed=new Set(['Survival.Views.UIView.UIPauseView','DamageShower.DamageShowView',
        'Acme.Gui.Dashboard.UIDashboardView','Survival.GlobalMap.MapView.MapComplex.MapComplexView']);
      if(state.windows.some(w=>!allowed.has(w)))throw Error('Settings obstructed by an unknown window');
      result='PASS_SETTINGS_OPEN';
    } catch(e) {reason=e.code==='UNITY_NEW_ERROR'?'new_unity_error':String(e);}
    finally {
      try {cleanup=await session.finish();if(cleanup?.error_watch?.blocked){result='NEEDS_REVIEW';reason='new_unity_error';}}
      catch(e){result='NEEDS_REVIEW';reason=String(e);}
    }
    return {result,reason,final_state:state,cleanup,elapsed_seconds:Number(((performance.now()-started)/1000).toFixed(3))};
  }
  throw Error('Unapproved UI skill: '+id);
}
