"""Read-only navigation geometry for the sampled, flat, axis-aligned raft.

Uses an exact rectangular arrangement, not the overall bounding rectangle.
No Unity/game input. Coordinates and IDs are evidence, not permanent memory.
"""
import argparse
import hashlib
import heapq
import json
import math
from collections import defaultdict, deque
from pathlib import Path

EPS = 1e-7


def area(ring):
    return sum(a[0]*b[1]-b[0]*a[1] for a, b in zip(ring, ring[1:]))/2


def contours(cells, xs, zs):
    groups = components(cells)
    if len(groups) > 1:
        result = [r for group in groups for r in contours(set(group), xs, zs)]
        return sorted(result, key=lambda r: -abs(r['signed_area']))
    edges = set()
    for i, j in cells:
        for neighbor, edge in [((i,j-1),((i,j),(i+1,j))),
                               ((i+1,j),((i+1,j),(i+1,j+1))),
                               ((i,j+1),((i+1,j+1),(i,j+1))),
                               ((i-1,j),((i,j+1),(i,j)))]:
            if neighbor not in cells:
                edges.add(edge)
    outgoing = defaultdict(set)
    for a, b in edges:
        outgoing[a].add(b)
    rings = []
    while edges:
        a, b = min(edges)
        start = a
        vertices = [a]
        while True:
            edges.remove((a, b))
            outgoing[a].remove(b)
            vertices.append(b)
            if b == start:
                break
            candidates = list(outgoing[b])
            if not candidates:
                raise ValueError('Open boundary')
            dx, dz = b[0]-a[0], b[1]-a[1]
            c = min(candidates, key=lambda p: math.atan2(
                dx*(p[1]-b[1])-dz*(p[0]-b[0]),
                dx*(p[0]-b[0])+dz*(p[1]-b[1])))
            a, b = b, c
        points = [[xs[i], zs[j]] for i, j in vertices[:-1]]
        simple = []
        for k, p in enumerate(points):
            before, after = points[k-1], points[(k+1) % len(points)]
            cross = (p[0]-before[0])*(after[1]-p[1])-(p[1]-before[1])*(after[0]-p[0])
            if abs(cross) > EPS:
                simple.append(p)
        simple.append(simple[0])
        signed = area(simple)
        rings.append({'kind': 'outer' if signed > 0 else 'hole',
                      'signed_area': signed, 'points_xz': simple})
    return sorted(rings, key=lambda r: -abs(r['signed_area']))


def components(cells):
    remaining, groups = set(cells), []
    while remaining:
        seed = min(remaining)
        remaining.remove(seed)
        q, group = deque([seed]), [seed]
        while q:
            i, j = q.popleft()
            for n in [(i-1,j),(i+1,j),(i,j-1),(i,j+1)]:
                if n in remaining:
                    remaining.remove(n)
                    group.append(n)
                    q.append(n)
        groups.append(group)
    return groups


def overlap(a, b):
    return max(0, min(a[2], b[2])-max(a[0], b[0])) * max(0, min(a[3], b[3])-max(a[1], b[1]))


def build_map(snapshot, edge_margin=.30, obstacle_margin=.23, diagnostics=True):
    if snapshot.get('status') != 'sampled' or not snapshot.get('foundations'):
        raise ValueError('A live foundation snapshot is required')
    floors = snapshot['foundations']
    if max(f['max'][1] for f in floors)-min(f['max'][1] for f in floors) > .02:
        raise ValueError('Multiple deck heights need a three-dimensional navigation model')
    for f in floors:
        rx, ry, rz = f['rotation']
        if abs(rx) > .001 or abs(rz) > .001 or abs(ry/90-round(ry/90)) > .001:
            raise ValueError('Unsupported rotated/sloping floor: do not use its AABB as support')
    rects = [(f['min'][0], f['min'][2], f['max'][0], f['max'][2]) for f in floors]
    if any(overlap(a, b) > EPS for i, a in enumerate(rects) for b in rects[i+1:]):
        raise ValueError('Overlapping floor rectangles need a different union method')
    cc = snapshot['controller']
    physical_radius = cc['radius'] * max(abs(cc['scale'][0]), abs(cc['scale'][2]))
    if min(edge_margin, obstacle_margin) < physical_radius + cc['skin']:
        raise ValueError('Clearance is smaller than controller radius plus skin')
    bbox = [min(r[0] for r in rects), min(r[1] for r in rects),
            max(r[2] for r in rects), max(r[3] for r in rects)]
    px = sorted(set(v for r in rects for v in (r[0], r[2])))
    pz = sorted(set(v for r in rects for v in (r[1], r[3])))
    physical = {(i,j) for i in range(len(px)-1) for j in range(len(pz)-1)
                if any(a-EPS <= (px[i]+px[i+1])/2 <= c+EPS and b-EPS <= (pz[j]+pz[j+1])/2 <= d+EPS
                       for a,b,c,d in rects)}
    # A broad world AABB also contains sea beside this nonrectangular raft.
    # Floating debris there must not invalidate or block the deck model.
    obstacles = [o for o in snapshot.get('obstacles', []) if any(
        overlap((o['min'][0]-obstacle_margin,o['min'][2]-obstacle_margin,
                 o['max'][0]+obstacle_margin,o['max'][2]+obstacle_margin), r) > EPS
        for r in rects)]
    blocked = [(o['min'][0]-obstacle_margin, o['min'][2]-obstacle_margin,
                o['max'][0]+obstacle_margin, o['max'][2]+obstacle_margin) for o in obstacles]
    xs = sorted(set(round(v, 8) for r in rects for x in (r[0], r[2]) for v in (x-edge_margin, x+edge_margin)
                    if bbox[0] < v < bbox[2]) | {bbox[0], bbox[2]} |
                {v for r in blocked for v in (r[0], r[2]) if bbox[0] < v < bbox[2]})
    zs = sorted(set(round(v, 8) for r in rects for z in (r[1], r[3]) for v in (z-edge_margin, z+edge_margin)
                    if bbox[1] < v < bbox[3]) | {bbox[1], bbox[3]} |
                {v for r in blocked for v in (r[1], r[3]) if bbox[1] < v < bbox[3]})

    def permitted(x, z):
        foot = (x-edge_margin, z-edge_margin, x+edge_margin, z+edge_margin)
        supported = sum(overlap(foot, r) for r in rects)
        return supported >= (2*edge_margin)**2-EPS and not any(
            a+EPS < x < c-EPS and b+EPS < z < d-EPS for a,b,c,d in blocked)

    safe = {(i,j) for i in range(len(xs)-1) for j in range(len(zs)-1)
            if permitted((xs[i]+xs[i+1])/2, (zs[j]+zs[j+1])/2)}
    if not safe:
        raise ValueError('No conservative traversable region')
    rings = contours(physical, px, pz) if diagnostics else []
    safe_rings = contours(safe, xs, zs) if diagnostics else []
    physical_area = sum((r[2]-r[0])*(r[3]-r[1]) for r in rects)
    safe_area = sum((xs[i+1]-xs[i])*(zs[j+1]-zs[j]) for i,j in safe)
    if diagnostics and abs(sum(r['signed_area'] for r in rings)-physical_area) > 1e-5:
        raise ValueError('Physical contour area mismatch')
    if diagnostics and abs(sum(r['signed_area'] for r in safe_rings)-safe_area) > 1e-5:
        raise ValueError('Safe contour area mismatch')
    player_x, _, player_z = snapshot['player']
    nearest = min(safe, key=lambda n: ((xs[n[0]]+xs[n[0]+1])/2-player_x)**2 +
                                   ((zs[n[1]]+zs[n[1]+1])/2-player_z)**2)
    nearest_point = [(xs[nearest[0]]+xs[nearest[0]+1])/2, (zs[nearest[1]]+zs[nearest[1]+1])/2]
    revision = hashlib.sha256(json.dumps({'floors': floors, 'obstacles': obstacles}, sort_keys=True).encode()).hexdigest()
    return {'schema': 'ocean-raft-nav/1', 'status': 'GEOMETRY_DERIVED_NOT_WALK_VERIFIED',
            'frame': snapshot['frame'], 'scene_handle': snapshot['scene_handle'],
            'geometry_sha256': revision, 'coordinate_space': 'unity_world_xz',
            'basis': snapshot.get('parent'), 'deck_y': snapshot['deck_y'], 'bbox_xz': bbox,
            'floor_count': len(floors), 'obstacle_count': len(obstacles),
            'physical_area': physical_area, 'conservative_area': safe_area,
            'physical_contours': rings, 'conservative_contours': safe_rings,
            'physical_components': len(components(physical)), 'safe_components': len(components(safe)),
            'controller_radius_world': physical_radius, 'controller_skin': cc['skin'],
            'edge_margin': edge_margin, 'obstacle_margin': obstacle_margin,
            'model': 'Axis-aligned box floors; square-footprint erosion; conservative obstacle AABBs',
            'player': snapshot['player'], 'player_in_conservative_region': permitted(player_x, player_z),
            'nearest_region_cell_center_xz': nearest_point,
            'arrangement': {'x': xs, 'z': zs, 'safe_cells': [list(c) for c in sorted(safe)]},
            'obstacles': obstacles,
            'limits': ['Not yet tested by walking; speed, stopping and input must be calibrated',
                       'Only current sampled flat box foundations and static collision candidates',
                       'Invalidate on construction/destruction, moving obstacles or coordinate-frame change',
                       'Safe-cell centers join only through shared sides; no diagonal corner cutting']}


def plan_route(nav, start, goal):
    """A* between safe arrangement cells. Never snap an unsafe start silently."""
    xs, zs = nav['arrangement']['x'], nav['arrangement']['z']
    cells = {tuple(c) for c in nav['arrangement']['safe_cells']}

    def locate(p):
        return next((c for c in sorted(cells) if xs[c[0]]-EPS <= p[0] <= xs[c[0]+1]+EPS
                     and zs[c[1]]-EPS <= p[1] <= zs[c[1]+1]+EPS), None)

    def center(c):
        return ((xs[c[0]]+xs[c[0]+1])/2, (zs[c[1]]+zs[c[1]+1])/2)

    a, b = locate(start), locate(goal)
    if a is None or b is None:
        return {'status': 'start_outside_region' if a is None else 'goal_outside_region'}
    todo, cost, previous = [(0, a)], {a: 0}, {}
    while todo:
        _, c = heapq.heappop(todo)
        if c == b:
            chain = [b]
            while chain[-1] != a:
                chain.append(previous[chain[-1]])
            points = [list(start)] + [list(center(n)) for n in reversed(chain)] + [list(goal)]
            simple = []
            for p in points:
                if simple and math.dist(p, simple[-1]) < EPS:
                    continue
                while len(simple) > 1:
                    q, r = simple[-2], simple[-1]
                    cross = (r[0]-q[0])*(p[1]-r[1])-(r[1]-q[1])*(p[0]-r[0])
                    dot = (r[0]-q[0])*(p[0]-r[0])+(r[1]-q[1])*(p[1]-r[1])
                    if abs(cross) > EPS or dot < 0:
                        break
                    simple.pop()
                simple.append(p)
            return {'status': 'PLANNED_NOT_EXECUTED', 'points_xz': simple,
                    'length': sum(math.dist(x,y) for x,y in zip(simple,simple[1:])),
                    'method': '4-neighbor A*; links stay inside side-adjacent safe rectangles'}
        i, j = c
        for n in [(i-1,j),(i+1,j),(i,j-1),(i,j+1)]:
            if n not in cells:
                continue
            value = cost[c]+math.dist(center(c),center(n))
            if value < cost.get(n, math.inf):
                cost[n], previous[n] = value, c
                heapq.heappush(todo, (value+math.dist(center(n),center(b)),n))
    return {'status': 'no_connected_route'}


def segment_clear(nav, start, goal):
    """Exact interval coverage of a segment by safe rectangles; never sample over holes."""
    xs, zs = nav['arrangement']['x'], nav['arrangement']['z']
    dx, dz = goal[0]-start[0], goal[1]-start[1]
    intervals = []
    for i, j in nav['arrangement']['safe_cells']:
        lo, hi = 0., 1.
        for value, delta, lower, upper in [(start[0],dx,xs[i],xs[i+1]),
                                            (start[1],dz,zs[j],zs[j+1])]:
            if abs(delta) < EPS:
                if value < lower-EPS or value > upper+EPS:
                    hi = -1.
                    break
            else:
                a, b = sorted(((lower-value)/delta,(upper-value)/delta))
                lo, hi = max(lo,a), min(hi,b)
        if hi >= lo-EPS:
            intervals.append((lo,hi))
    end = 0.
    for lo, hi in sorted(intervals):
        if lo > end+EPS:
            return False
        end = max(end,hi)
        if end >= 1.-EPS:
            return True
    return False


def shorten_route(nav, route):
    """Farthest visible waypoint, preserving the same conservative support union."""
    if 'points_xz' not in route:
        return route
    original = route['points_xz']
    points, current = [original[0]], 0
    while current < len(original)-1:
        following = next(i for i in range(len(original)-1,current,-1)
                         if segment_clear(nav, original[current], original[i]))
        points.append(original[following])
        current = following
    return {**route, 'points_xz':points,
            'length':sum(math.dist(a,b) for a,b in zip(points,points[1:])),
            'method':'A* + exact safe-union line-of-sight shortening'}


def merged_rectangles(nav):
    """Merge safe cells into horizontal strips, then identical vertical strips."""
    xs, zs = nav['arrangement']['x'], nav['arrangement']['z']
    rows = defaultdict(list)
    for i,j in nav['arrangement']['safe_cells']:
        rows[j].append(i)
    open_rects, result = {}, []
    for j in range(len(zs)-1):
        runs = []
        for i in sorted(rows[j]):
            if runs and i == runs[-1][1]:
                runs[-1][1] = i+1
            else:
                runs.append([i,i+1])
        next_open = {}
        for a,b in runs:
            key = a,b
            r = open_rects.pop(key, [xs[a],zs[j],xs[b],zs[j+1]])
            r[3] = zs[j+1]
            next_open[key] = r
        result.extend(open_rects.values())
        open_rects = next_open
    return result+list(open_rects.values())


def render(snapshot, nav, target):
    from PIL import Image, ImageDraw, ImageFont
    image = Image.new('RGB', (1050, 1040), '#eef3f6')
    d = ImageDraw.Draw(image)
    font_path = 'C:/Windows/Fonts/segoeui.ttf'
    font = ImageFont.truetype(font_path, 17)
    small = ImageFont.truetype(font_path, 14)
    title = ImageFont.truetype(font_path, 25)
    xmin, zmin, xmax, zmax = nav['bbox_xz']
    scale = min(800/(xmax-xmin), 720/(zmax-zmin))

    def point(x,z):
        return (100+(x-xmin)*scale, 120+(zmax-z)*scale)

    def rect(a,b,c,e,fill,outline=None):
        left,top = point(a,e)
        right,bottom = point(c,b)
        d.rectangle((round(left),round(top),round(right),round(bottom)),fill=fill,outline=outline)

    d.text((45,22), 'Плот: настил, дыры и препятствия', font=title, fill='#182a35')
    d.text((45,58), f"Снимок Unity: кадр {nav['frame']} · мировые X/Z · единицы Unity",font=font,fill='#405360')
    for f in snapshot['foundations']:
        rect(f['min'][0],f['min'][2],f['max'][0],f['max'][2],'#d1d8dc','#85939b')
    xs,zs = nav['arrangement']['x'],nav['arrangement']['z']
    for i,j in nav['arrangement']['safe_cells']:
        rect(xs[i],zs[j],xs[i+1],zs[j+1],'#99c8ac')
    for r in nav['physical_contours']:
        d.line([point(x,z) for x,z in r['points_xz']],fill='#263e4a',width=3)
    for o in snapshot['obstacles']:
        rect(o['min'][0],o['min'][2],o['max'][0],o['max'][2],'#af5d50','#784236')
        cx,cz=(o['min'][0]+o['max'][0])/2,(o['min'][2]+o['max'][2])/2
        x,y=point(cx,cz)
        label=o['name'].replace('(Clone)','')
        d.text((x-40,y+12),label,font=small,fill='#522d26')
    for r in nav['physical_contours']:
        if r['kind']=='hole':
            points=r['points_xz'][:-1]
            x,y=point(sum(p[0] for p in points)/len(points),sum(p[1] for p in points)/len(points))
            d.text((x-23,y-9),'ДЫРА',font=small,fill='#405360')
    route = nav.get('example_route', {})
    if route.get('status') == 'PLANNED_NOT_EXECUTED':
        points = [point(x,z) for x,z in route['points_xz']]
        d.line(points,fill='white',width=6)
        d.line(points,fill='#164d65',width=3)
        for (x,y), label in [(points[0],'А'),(points[-1],'Б')]:
            d.ellipse((x-5,y-5,x+5,y+5),fill='#164d65',outline='white',width=2)
            d.text((x+9,y-18),label,font=font,fill='#164d65')
    x,y=point(snapshot['player'][0],snapshot['player'][2])
    d.ellipse((x-6,y-6,x+6,y+6),fill='#172a35',outline='white',width=2)
    d.text((x+9,y-19),'Игрок',font=small,fill='#172a35')
    for value in sorted(set([xmin,xmax]+[f['center'][0] for f in snapshot['foundations']])):
        x,_=point(value,zmin)
        d.text((x-16,120+(zmax-zmin)*scale+12),f'{value:g}',font=small,fill='#405360')
    for value in sorted(set([zmin,zmax]+[f['center'][2] for f in snapshot['foundations']])):
        _,y=point(xmin,value)
        d.text((45,y-9),f'{value:g}',font=small,fill='#405360')
    d.text((470,120+(zmax-zmin)*scale+42),'X, единицы Unity →',font=font,fill='#405360')
    d.text((40,93),'Z ↑',font=font,fill='#405360')
    legend_y=925
    for x,color,text in [(45,'#d1d8dc','Настил'),(205,'#99c8ac','Расчётная область центра игрока'),(615,'#af5d50','Твёрдые препятствия')]:
        d.rectangle((x,legend_y,x+17,legend_y+17),fill=color)
        d.text((x+25,legend_y-4),text,font=font,fill='#263e4a')
    d.text((45,960),f"Отступ от воды {nav['edge_margin']:.2f}; от препятствий {nav['obstacle_margin']:.2f}. Прохождение ещё не проверено.",font=font,fill='#405360')
    d.text((45,990),'Линия А–Б — пример обхода радара и отверстий. Точка «Игрок» — фактическая позиция.',font=small,fill='#405360')
    d.text((45,1013),'Карта перестраивается после изменения плота. Зелёная область учитывает размер персонажа.',font=small,fill='#405360')
    image.save(target)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('snapshot',type=Path)
    parser.add_argument('--out',required=True,type=Path)
    parser.add_argument('--render',action='store_true',help='Optional diagnostic PNG; never needed by the controller')
    parser.add_argument('--start',nargs=2,type=float)
    parser.add_argument('--goal',nargs=2,type=float)
    args=parser.parse_args()
    snapshot=json.loads(args.snapshot.read_text(encoding='utf-8'))
    nav=build_map(snapshot,diagnostics=args.render)
    if args.goal:
        start=args.start or [snapshot['player'][0],snapshot['player'][2]]
        nav['route']=shorten_route(nav,plan_route(nav,start,args.goal))
    nav['safe_rectangles']=merged_rectangles(nav)
    args.out.mkdir(parents=True,exist_ok=True)
    (args.out/'navigation.json').write_text(json.dumps(nav,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
    if args.render:
        render(snapshot,nav,args.out/'raft-map.png')
    print(json.dumps({k:nav[k] for k in ['status','floor_count','obstacle_count','bbox_xz','physical_area','conservative_area','physical_components','safe_components','player_in_conservative_region','nearest_region_cell_center_xz']},ensure_ascii=False))
    print(json.dumps({'holes':[r['points_xz'] for r in nav['physical_contours'] if r['kind']=='hole']},ensure_ascii=False))


if __name__=='__main__':
    main()
