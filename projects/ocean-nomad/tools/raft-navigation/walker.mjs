// Bounded route controller, extracted from the live raft walk on26October2026.
// readPose and pulse are supplied by the assistant's single guarded MCP session.
// pulse is ordinary UI joystick input; no actor/camera coordinates are written.
export function createRaftWalker({nav,route,foundations,readPose,pulse}) {
  const state={index:1,events:[],visited:new Set(),status:'running',stuck:0};
  const inside=(x,z)=>nav.arrangement.safe_cells.some(([i,j])=>
    x>=nav.arrangement.x[i]-1e-5&&x<=nav.arrangement.x[i+1]+1e-5&&
    z>=nav.arrangement.z[j]-1e-5&&z<=nav.arrangement.z[j+1]+1e-5);
  async function runChunk(ms=16000) {
    const until=performance.now()+Math.max(1000,Math.min(ms,20000));
    while(state.index<route.points_xz.length&&performance.now()<until) {
      const p=await readPose();
      if(p.scene!==nav.scene_handle){state.status='scene_changed';break;}
      if(!p.grounded){state.status='not_grounded';break;}
      if(!inside(p.pos[0],p.pos[2])){state.status='outside_planned_region';break;}
      for(const f of foundations)if(p.pos[0]>=f.min[0]&&p.pos[0]<=f.max[0]&&p.pos[2]>=f.min[2]&&p.pos[2]<=f.max[2])state.visited.add(f.id);
      const goal=route.points_xz[state.index];
      const dx=goal[0]-p.pos[0],dz=goal[1]-p.pos[2],distance=Math.hypot(dx,dz);
      if(distance<.065){state.index++;continue;}
      const length=Math.hypot(p.forward[0],p.forward[2]);
      if(length<.01){state.status='camera_heading_unknown';break;}
      const fx=p.forward[0]/length,fz=p.forward[2]/length;
      const analog=Math.min(.5,Math.max(.09,distance/.6));
      const seconds=Math.min(.32,Math.max(.06,distance/(2.2*analog)*.55));
      const r=await pulse(seconds,(dx*fz-dz*fx)/distance*analog,(dx*fx+dz*fz)/distance*analog);
      const after=await readPose();
      const moved=Math.hypot(after.pos[0]-p.pos[0],after.pos[2]-p.pos[2]);
      state.events.push({index:state.index,goal,before:p.pos,after:after.pos,moved,result:r.status,grounded:after.grounded});
      if(r.status!=='completed'){state.status=r.status;break;}
      state.stuck=moved<.008?state.stuck+1:0;
      if(state.stuck>=3){state.status='movement_stalled';break;}
    }
    if(state.index>=route.points_xz.length)state.status='complete';
    return {status:state.status,index:state.index,total:route.points_xz.length,visited:state.visited.size};
  }
  return {state,runChunk};
}
