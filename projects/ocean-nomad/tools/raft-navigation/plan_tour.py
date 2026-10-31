"""Connect outer/hole perimeter samples and every foundation using the safe graph."""
import json
import math
import sys
from pathlib import Path
from build_map import plan_route

nav=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
snap=json.loads(Path(sys.argv[2]).read_text(encoding='utf-8'))
start=json.loads(Path(sys.argv[3]).read_text(encoding='utf-8'))
xs,zs=nav['arrangement']['x'],nav['arrangement']['z']
nodes=[((xs[i]+xs[i+1])/2,(zs[j]+zs[j+1])/2) for i,j in nav['arrangement']['safe_cells']]
goals=[]
for ring in nav['physical_contours']:
    for a,b in zip(ring['points_xz'],ring['points_xz'][1:]):
        steps=max(1,math.ceil(math.dist(a,b)/.85))
        for n in range(steps):
            p=(a[0]+(b[0]-a[0])*n/steps,a[1]+(b[1]-a[1])*n/steps)
            q=min(nodes,key=lambda v:math.dist(p,v))
            if not goals or math.dist(q,goals[-1])>.1:
                goals.append(q)
for f in snap['foundations']:
    available=[]
    for i,j in nav['arrangement']['safe_cells']:
        x0,x1=max(xs[i],f['min'][0]),min(xs[i+1],f['max'][0])
        z0,z1=max(zs[j],f['min'][2]),min(zs[j+1],f['max'][2])
        if x1-x0>1e-5 and z1-z0>1e-5:
            available.append(((x0+x1)/2,(z0+z1)/2))
    if not available:
        raise ValueError('A foundation has no conservative visit point: '+str(f['id']))
    c=f['center']
    q=min(available,key=lambda v:math.dist(v,(c[0],c[2])))
    if not any(math.dist(q,g)<.2 for g in goals):
        goals.append(q)
points=[start]
for goal in goals+[start]:
    result=plan_route(nav,points[-1],goal)
    if result['status']!='PLANNED_NOT_EXECUTED':
        raise ValueError((goal,result))
    for p in result['points_xz'][1:]:
        if math.dist(p,points[-1])<.03:
            continue
        while len(points)>1:
            a,b=points[-2],points[-1]
            cross=(b[0]-a[0])*(p[1]-b[1])-(b[1]-a[1])*(p[0]-b[0])
            dot=(b[0]-a[0])*(p[0]-b[0])+(b[1]-a[1])*(p[1]-b[1])
            if abs(cross)>1e-7 or dot<0:
                break
            points.pop()
        points.append(p)
out={'status':'PLANNED_NOT_WALKED','points_xz':points,'goal_count':len(goals),
     'length':sum(math.dist(a,b) for a,b in zip(points,points[1:])),
     'geometry_sha256':nav['geometry_sha256'],'scope':'outer/hole perimeter and all foundations; return to start'}
Path(sys.argv[4]).write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'waypoints':len(points),'goals':len(goals),'length':out['length']}))
