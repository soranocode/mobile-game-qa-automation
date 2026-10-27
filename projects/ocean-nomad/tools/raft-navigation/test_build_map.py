import unittest
from build_map import build_map, plan_route, shorten_route, segment_clear, merged_rectangles


def snapshot(cells, obstacles=()):
    return {'status':'sampled','frame':1,'scene_handle':1,'deck_y':.015,
            'player':[0,1.345,0], 'controller':{'radius':.15,'skin':.03,'scale':[1,1,1]},
            'foundations':[{'id':i,'min':[x*1.5-.75,-.045,z*1.5-.75],
                            'max':[x*1.5+.75,.015,z*1.5+.75],
                            'rotation':[0,0,0]} for i,(x,z) in enumerate(cells)],
            'obstacles':list(obstacles)}


class GeometryChecks(unittest.TestCase):
    def test_single_tile_has_clearance_on_all_edges(self):
        nav=build_map(snapshot([(0,0)]))
        self.assertAlmostEqual(nav['conservative_area'],.9*.9)
        self.assertEqual(plan_route(nav,(-.6,0),(0,0))['status'],'start_outside_region')

    def test_hole_cannot_be_crossed_directly(self):
        cells=[(x,z) for x in range(3) for z in range(3) if (x,z)!=(1,1)]
        nav=build_map(snapshot(cells))
        self.assertEqual(sum(r['kind']=='hole' for r in nav['physical_contours']),1)
        route=plan_route(nav,(0,1.5),(3,1.5))
        self.assertEqual(route['status'],'PLANNED_NOT_EXECUTED')
        self.assertGreater(route['length'],3)
        self.assertEqual(plan_route(nav,(0,0),(1.5,1.5))['status'],'goal_outside_region')

    def test_diagonal_touch_is_not_a_walkable_connection(self):
        nav=build_map(snapshot([(0,0),(1,1)]))
        self.assertEqual(nav['physical_components'],2)
        self.assertEqual(nav['safe_components'],2)
        self.assertEqual(plan_route(nav,(0,0),(1.5,1.5))['status'],'no_connected_route')

    def test_corner_touching_hole_keeps_its_boundary(self):
        cells=[(x,z) for x in range(3) for z in range(3) if (x,z) not in [(1,1),(2,2)]]
        nav=build_map(snapshot(cells))
        self.assertEqual(sum(r['kind']=='hole' for r in nav['physical_contours']),1)
        self.assertAlmostEqual(sum(r['signed_area'] for r in nav['physical_contours']),7*2.25)

    def test_obstacle_can_disconnect_a_corridor(self):
        obs={'id':9,'min':[.6,.1,-.8],'max':[.9,1,2.3]}
        nav=build_map(snapshot([(x,z) for x in range(3) for z in range(2)],[obs]))
        self.assertEqual(nav['safe_components'],2)
        self.assertEqual(plan_route(nav,(0,0),(3,0))['status'],'no_connected_route')

    def test_unsupported_geometry_and_small_margins_fail_closed(self):
        s=snapshot([(0,0)])
        s['foundations'][0]['rotation']=[0,45,0]
        with self.assertRaises(ValueError):
            build_map(s)
        with self.assertRaises(ValueError):
            build_map(snapshot([(0,0)]),edge_margin=.1)

    def test_debris_in_bounding_rectangle_but_not_on_deck_is_ignored(self):
        cells=[(0,0),(1,0),(0,1)]
        outside={'id':7,'min':[1.4,.1,1.4],'max':[1.6,.2,1.6]}
        plain=build_map(snapshot(cells))
        with_debris=build_map(snapshot(cells,[outside]))
        self.assertEqual(with_debris['obstacle_count'],0)
        self.assertAlmostEqual(plain['conservative_area'],with_debris['conservative_area'])

    def test_shortcut_keeps_hole_and_has_clear_segments(self):
        nav=build_map(snapshot([(x,z) for x in range(3) for z in range(3) if (x,z)!=(1,1)]),diagnostics=False)
        before=plan_route(nav,(0,1.5),(3,1.5))
        after=shorten_route(nav,before)
        self.assertFalse(segment_clear(nav,(0,1.5),(3,1.5)))
        self.assertLessEqual(after['length'],before['length'])
        self.assertTrue(all(segment_clear(nav,a,b) for a,b in zip(after['points_xz'],after['points_xz'][1:])))

    def test_compact_rectangles_preserve_safe_union(self):
        nav=build_map(snapshot([(x,z) for x in range(3) for z in range(3) if (x,z)!=(1,1)]))
        rects=merged_rectangles(nav)
        self.assertAlmostEqual(sum((r[2]-r[0])*(r[3]-r[1]) for r in rects),nav['conservative_area'])
        self.assertLess(len(rects),len(nav['arrangement']['safe_cells']))
        for x in range(-10,71):
            for z in range(-10,71):
                p=(x/20,z/20)
                self.assertEqual(any(r[0]-1e-7<=p[0]<=r[2]+1e-7 and r[1]-1e-7<=p[1]<=r[3]+1e-7 for r in rects),segment_clear(nav,p,p))

    def test_headless_geometry_matches_diagnostic_geometry(self):
        s=snapshot([(0,0),(1,0),(1,1)])
        full,fast=build_map(s),build_map(s,diagnostics=False)
        self.assertEqual(full['arrangement'],fast['arrangement'])
        self.assertEqual(full['geometry_sha256'],fast['geometry_sha256'])
        self.assertEqual(fast['physical_contours'],[])

    def test_obstacle_just_outside_deck_still_reserves_body_clearance(self):
        outside={'id':7,'min':[.76,.1,-.2],'max':[1,.8,.2]}
        nav=build_map(snapshot([(0,0)],[outside]))
        self.assertEqual(nav['obstacle_count'],1)

    def test_cache_tracks_geometry_but_not_player_position(self):
        from plan_fast import geometry_key
        import copy
        original=snapshot([(0,0),(1,0)])
        for f in original['foundations']:
            f['collider_id']=f['id']
        other=copy.deepcopy(original)
        other['player']=[.1,1.345,.2]
        other['frame']=100
        self.assertEqual(geometry_key(original),geometry_key(other))
        other['foundations'].pop()
        self.assertNotEqual(geometry_key(original),geometry_key(other))


if __name__=='__main__':
    unittest.main()
