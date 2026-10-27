// Page identities were observed on screen and explicitly approved by the human.
export function chooseLearnedPremiumAction(state) {
  const page=state.premium_page;
  const role=page==='intro_build'?'skip_intro_build':page==='intro_survive'?'skip_intro_survive':
    page==='offer'||page===undefined?'close_premium':null;
  if(page==='loading'||page===null)return {wait:'premium_page_initializing'};
  if(!role)return {halt:'unknown_premium_page'};
  const targets=state.controls.filter(c=>c.role===role);
  if(targets.length===0)return {wait:'known_overlay_control_initializing'};
  if(targets.length!==1)return {halt:'ambiguous_overlay_target'};
  return targets[0].blocked?{wait:'ui_blocked'}:{role};
}
