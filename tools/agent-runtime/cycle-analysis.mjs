// Deterministic observations for a later analyst/curator; never rewrites active skills.
export function analyzeCycle(events,results){
  const metrics={planning_ms:0,queue_wait_ms:0,mission_ms:0,mcp_ms:0,mcp_calls:0,known_no_input_observations:0};
  const byMission=new Map(),candidates=[];
  const row=mission=>{if(!byMission.has(mission))byMission.set(mission,{mission,planning_ms:0,queue_wait_ms:0,mission_ms:0,mcp_calls:0,mcp_ms:0});return byMission.get(mission);};
  for(const event of events){
    const current=event.mission?row(event.mission):null;
    const field={plan_ready:'planning_ms',queue_ready:'queue_wait_ms',mission_end:'mission_ms'}[event.type];
    if(field){metrics[field]+=event.duration_ms??0;if(current)current[field]+=event.duration_ms??0;}
    if(event.type==='mcp_end'&&event.transport_attempted!==false){
      metrics.mcp_calls++;metrics.mcp_ms+=event.ms_tool??0;
      if(current){current.mcp_calls++;current.mcp_ms+=event.ms_tool??0;}
      metrics.known_no_input_observations+=(event.outcomes??[]).filter(o=>['not_sent_covered','not_sent_blocked'].includes(o.status)).length;
    }
    if(event.type==='queue_ready'&&event.duration_ms>100)candidates.push({
      status:'PROPOSED',mission:event.mission,kind:'preparation_delay',evidence_seq:event.seq,
      observed:`Executor waited ${Math.round(event.duration_ms)} ms for the next prepared ticket`,
      next_check:'Compare lookahead and offline preparation duration; do not infer model thinking from an unlabelled gap'
    });
  }
  for(const result of results)if(!['PASS_MISSION','PASS_HOOK_USE'].includes(result.result))candidates.push({
    status:'PROPOSED',mission:result.mission,kind:'unsuccessful_attempt',
    observed:String(result.reason??result.stop_reason??result.result).slice(0,300),
    next_check:'Classify game defect, observation gap or executor error before proposing a skill change'
  });
  return{schema:'ocean-cycle-analysis/1',metrics,missions:[...byMission.values()],candidates,
    active_knowledge_changed:false,causal_limit:'Durations alone do not establish why a delay occurred'};
}
