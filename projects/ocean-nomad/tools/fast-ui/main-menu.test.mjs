import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseMainMenuAction, runKnownMainMenu } from './main-menu.mjs';
const s = (windows, roles, extra={}) => ({windows, scenes:['Game'], controls:roles.map(role=>({role,blocked:false})), ...extra});
const HUD=s(['DamageShower.DamageShowView'],['open_menu']);
const SETTINGS=s(['Survival.Views.UIView.UIPauseView'],['exit_to_main_menu']);
const CONFIRM=s(['Survival.Windows.Popups.UIPopupView'],['confirm_exit'],{confirmation_is_exit:true});
const PREMIUM=s(['MainScreen.Premium.PremiumWindowNew'],['close_premium'],{scenes:['Map']});
const MAIN=s(['MainScreen.MainScreenWindow2'],['main_menu_continue'],{scenes:['Map']});
test('unrelated confirmations and unknown windows never receive input',()=>{
  assert.equal(chooseMainMenuAction({...CONFIRM,confirmation_is_exit:false}).halt,'unexpected_confirmation');
  assert.equal(chooseMainMenuAction(s(['Unknown'],['confirm_exit'])).halt,'unknown_window');
  assert.equal(chooseMainMenuAction(PREMIUM).halt,'premium_outside_exit_transition');
});
test('main menu requires its current usable control and no blocking window',()=>{
  assert.equal(chooseMainMenuAction(MAIN).complete,true);
  assert.equal(chooseMainMenuAction({...MAIN,controls:[]}).wait,'main_menu_not_ready');
  assert.equal(chooseMainMenuAction({...MAIN,windows:[...MAIN.windows,'Survival.Views.UIView.UIPauseView']}).halt,'main_menu_obstructed');
});
test('exit confirmation alone is not a PASS; delayed transition never repeats it',async()=>{
  const clicked=[];let phase=0, cleaned=false;
  const r=await runKnownMainMenu({timings:[],async begin(){return SETTINGS;},
    async step(role){clicked.push(role);phase++;return {input:{status:'sent'},state:CONFIRM};},
    async observe(){return phase===2?MAIN:CONFIRM;},async finish(){cleaned=true;return {stopped:true};}}, {settleMs:0});
  assert.equal(r.result,'PASS_MAIN_MENU');assert.deepEqual(clicked,['exit_to_main_menu','confirm_exit']);assert.equal(cleaned,true);
  assert.equal(r.final_state,MAIN);
});
test('optional Premium closes, then completion is checked in the main menu',async()=>{
  const clicked=[];
  const r=await runKnownMainMenu({timings:[],async begin(){return CONFIRM;},
    async step(role){clicked.push(role);return {input:{status:'sent'},state:role==='confirm_exit'?PREMIUM:MAIN};},
    async finish(){return {stopped:true};}}, {settleMs:0});
  assert.equal(r.result,'PASS_MAIN_MENU');assert.deepEqual(clicked,['confirm_exit','close_premium']);
});
test('unknown initial state stops and always cleans up',async()=>{
  let cleaned=false;
  const r=await runKnownMainMenu({timings:[],async begin(){return s(['Unknown'],[]);},
    async step(){throw Error('must not click');},async finish(){cleaned=true;return {stopped:true};}});
  assert.equal(r.result,'NEEDS_REVIEW');assert.equal(cleaned,true);
});
test('Discord and Premium may appear in either order after exit',async()=>{
  const discord=s(['Survival.Windows.Popups.Discord.UIDiscordPopupView'],['close_discord'],{scenes:['Map']});
  for(const chain of [[discord,PREMIUM,MAIN],[PREMIUM,discord,MAIN]]) {
    const clicked=[];let i=0;
    const r=await runKnownMainMenu({timings:[],async begin(){return CONFIRM;},
      async step(role){clicked.push(role);return {input:{status:'sent'},state:chain[i++]};},
      async finish(){return {stopped:true};}}, {settleMs:0});
    assert.equal(r.result,'PASS_MAIN_MENU');
    assert.equal(clicked.length,3);assert.equal(new Set(clicked).size,3);
  }
});
test('acknowledged exit without the final main menu times out, not PASS',async()=>{
  const clicked=[];let cleaned=false;
  const r=await runKnownMainMenu({timings:[],async begin(){return CONFIRM;},
    async step(role){clicked.push(role);return {input:{status:'sent'},state:CONFIRM};},
    async observe(){return CONFIRM;},async finish(){cleaned=true;return {stopped:true};}},
    {timeoutMs:1000,settleMs:0});
  assert.equal(r.result,'NEEDS_REVIEW');assert.equal(r.reason,'timeout');
  assert.deepEqual(clicked,['confirm_exit']);assert.equal(cleaned,true);
});
test('an error at the final boundary overrides an otherwise successful route',async()=>{
  const r=await runKnownMainMenu({timings:[],async begin(){return MAIN;},
    async finish(){return {stopped:true,error_watch:{available:true,blocked:true,unexpected_new_errors:1}};}},
    {settleMs:0});
  assert.equal(r.result,'NEEDS_REVIEW');assert.equal(r.reason,'new_unity_error');
});
test('learned introduction pages advance once each, then only the Premium cross is selected',async()=>{
  const build=s(['MainScreen.Premium.PremiumWindowNew'],['skip_intro_build'],{scenes:['Map'],premium_page:'intro_build'});
  const survive=s(['MainScreen.Premium.PremiumWindowNew'],['skip_intro_survive'],{scenes:['Map'],premium_page:'intro_survive',hidden_price_text:'$99.99 Free trial'});
  const offer={...PREMIUM,premium_page:'offer'};
  const chain=[build,survive,offer,MAIN],clicked=[];let i=0;
  const r=await runKnownMainMenu({timings:[],async begin(){return CONFIRM;},
    async step(role){clicked.push(role);return {input:{status:'sent'},state:chain[i++]};},
    async finish(){return {stopped:true};}}, {settleMs:0});
  assert.equal(r.result,'PASS_MAIN_MENU');
  assert.deepEqual(clicked,['confirm_exit','skip_intro_build','skip_intro_survive','close_premium']);
});
test('unknown Premium page is not advanced and a temporarily missing known control is awaited',()=>{
  assert.equal(chooseMainMenuAction({...PREMIUM,premium_page:'unknown'},{confirmed:true}).halt,'unknown_premium_page');
  assert.equal(chooseMainMenuAction({...PREMIUM,premium_page:'intro_build',controls:[]},{confirmed:true}).wait,'known_overlay_control_initializing');
  const offer={...PREMIUM,premium_page:'offer',controls:[{role:'skip_intro_build'}]};
  assert.equal(chooseMainMenuAction(offer,{confirmed:true}).wait,'known_overlay_control_initializing');
});
test('a delayed intro page change never sends Continue twice on the same page',async()=>{
  const build=s(['MainScreen.Premium.PremiumWindowNew'],['skip_intro_build'],{scenes:['Map'],premium_page:'intro_build'});
  let stage=0;const clicked=[];
  const r=await runKnownMainMenu({timings:[],async begin(){return CONFIRM;},
    async step(role){clicked.push(role);stage++;return {input:{status:'sent'},state:stage===1?build:stage===2?build:MAIN};},
    async observe(){return {...PREMIUM,premium_page:'offer'};},async finish(){return {stopped:true};}}, {settleMs:0});
  assert.equal(r.result,'PASS_MAIN_MENU');
  assert.deepEqual(clicked,['confirm_exit','skip_intro_build','close_premium']);
});
