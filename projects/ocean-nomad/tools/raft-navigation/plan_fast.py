"""Headless, geometry-keyed route cache. No image, no input, no machine-specific paths."""
import argparse
import hashlib
import json
import time
from pathlib import Path
from build_map import build_map, merged_rectangles, plan_route, shorten_route


def geometry_key(snapshot):
    floors = sorted(snapshot['foundations'],key=lambda f:f['collider_id'])
    relevant = {'algorithm_version':2,'edge_margin':.30,'obstacle_margin':.23,
                'scene':snapshot['scene_handle'],'parent':snapshot.get('parent'),
                'controller':snapshot['controller'],
                'floors':[{k:f[k] for k in ['collider_id','min','max','rotation']} for f in floors]}
    # Keep nearby potential blockers even just outside the support footprint.
    relevant['obstacles'] = sorted([o for o in snapshot.get('obstacles',[]) if any(
        o['max'][0] > f['min'][0]-.23 and o['min'][0] < f['max'][0]+.23 and
        o['max'][2] > f['min'][2]-.23 and o['min'][2] < f['max'][2]+.23 for f in floors)],key=lambda o:o['id'])
    return hashlib.sha256(json.dumps(relevant,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def plan(snapshot, goals, cache_path=None):
    began=time.perf_counter()
    key=geometry_key(snapshot)
    nav=None
    if cache_path and cache_path.exists():
        cached=json.loads(cache_path.read_text(encoding='utf-8'))
        if cached.get('cache_key')==key:
            nav=cached
    cache_hit=nav is not None
    if nav is None:
        nav=build_map(snapshot,diagnostics=False)
        nav['safe_rectangles']=merged_rectangles(nav)
        nav['cache_key']=key
        if cache_path:
            cache_path.parent.mkdir(parents=True,exist_ok=True)
            cache_path.write_text(json.dumps(nav,separators=(',',':')),encoding='utf-8')
    map_ms=(time.perf_counter()-began)*1000
    start=[snapshot['player'][0],snapshot['player'][2]]
    points=[start]
    for goal in goals:
        route=shorten_route(nav,plan_route(nav,points[-1],goal))
        if 'points_xz' not in route:
            return {'status':route['status'],'cache_hit':cache_hit,'goal':goal},nav
        points.extend(route['points_xz'][1:])
    import math
    return {'status':'PLANNED_NOT_EXECUTED','scene_handle':snapshot['scene_handle'],
            'geometry_sha256':nav['geometry_sha256'],'cache_key':key,
            'points_xz':points,'length':sum(math.dist(a,b) for a,b in zip(points,points[1:])),
            'cache_hit':cache_hit,'map_ms':map_ms,'total_ms':(time.perf_counter()-began)*1000,
            'safe_rectangles':nav['safe_rectangles'],'deck_y':snapshot['deck_y'],
            'floor_ids':[f['collider_id'] for f in snapshot['foundations']],
            'floor_bounds':[[f['collider_id'],*f['min'],*f['max']] for f in snapshot['foundations']]},nav


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('snapshot',type=Path)
    p.add_argument('--goals',required=True,help='JSON list of XZ semantic subgoal positions')
    p.add_argument('--cache',type=Path)
    p.add_argument('--out',required=True,type=Path)
    a=p.parse_args()
    result,_=plan(json.loads(a.snapshot.read_text(encoding='utf-8')),json.loads(a.goals),a.cache)
    a.out.parent.mkdir(parents=True,exist_ok=True)
    a.out.write_text(json.dumps(result,separators=(',',':')),encoding='utf-8')
    print(json.dumps({k:v for k,v in result.items() if k not in ['safe_rectangles','floor_ids','floor_bounds','points_xz']}))
