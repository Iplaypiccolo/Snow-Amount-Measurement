"""일별 예보 대표지점 검증. 실제 서버/API에는 접속하지 않는다."""
import copy
import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT/'tools'))
from build_daily_regions import build, land_of, resolve
from render_daily_regions_sql import render

DATA = json.loads((ROOT/'data/forecast_daily_regions.json').read_text(encoding='utf-8'))


class Regions(unittest.TestCase):
    def test_official_samples(self):
        for cell, expected in [((89,130),'11D20201'), ((87,129),'11D10503'),
                               ((69,129),'11B20404'), ((87,138),'11D20403'),
                               ((56,67),'21F20802'), ((80,83),'11H20503'),
                               ((65,72),'11F20405'), ((59,122),'11B20610')]:
            with self.subTest(cell=cell):
                self.assertEqual(resolve(DATA,*cell)['temp_id'], expected)

    def test_unclear_labels_use_town_not_nearest_climate_city(self):
        for cell, expected in [((85,86),'11H10604'), ((98,83),'11H20102'), ((103,99),'11H10201')]:
            r = resolve(DATA,*cell)
            self.assertEqual((r['temp_id'],r['method']), (expected,'nearest_town'))

    def test_new_grid_without_old_hint(self):
        self.assertEqual(resolve(DATA,89,130,use_hints=False)['temp_id'], '11D20201')

    def test_distant_sea_not_assigned_arbitrary_city(self):
        self.assertIsNone(resolve(DATA,1,1))

    def test_invalid_grid(self):
        for x,y in [(None,127),(0,127),(150,127),(60,254),(60,1.5),(True,2)]:
            with self.assertRaises(ValueError): resolve(DATA,x,y)

    def test_unknown_preferred_place_does_not_silently_fallback(self):
        data = dict(DATA,hints=[dict(nx=89,ny=130,city_code='0000000000',dong_code=None)])
        self.assertIsNone(resolve(data,89,130))

    def test_places_are_unique_and_well_formed(self):
        codes = [p['code'] for p in DATA['places']]
        self.assertEqual(len(codes),len(set(codes)))
        self.assertGreater(len(codes),3000)
        for p in DATA['places']:
            self.assertRegex(p['code'],r'^\d{10}$')
            self.assertTrue(30<=p['lat']<=44 and 122<=p['lon']<=133)
            self.assertRegex(p['land_id'],r'^[0-9A-Z]{8}$')
            self.assertRegex(p['temp_id'],r'^[0-9A-Z]{8}$')

    def test_every_hint_has_valid_city_and_preferred_town(self):
        cities = {p['city_code'] for p in DATA['places']}
        towns = {(p['code'],p['city_code']) for p in DATA['places']}
        self.assertEqual(len(DATA['hints']),len({(h['nx'],h['ny']) for h in DATA['hints']}))
        for h in DATA['hints']:
            self.assertIn(h['city_code'],cities)
            if h['dong_code']: self.assertIn((h['dong_code'],h['city_code']),towns)

    def test_conflicting_official_code_excluded(self):
        self.assertIn('2815555000',DATA['excluded_duplicate_codes'])
        self.assertFalse(any(p['code']=='2815555000' for p in DATA['places']))

    def test_capital_general_parent_not_midterm_parent(self):
        zones={'11B10101':dict(regUp='11B10100'),'11B10100':dict(regUp='11000000')}
        self.assertEqual(land_of('11B10101',zones,{'11B00000'}),'11B00000')

    def test_parent_cycle_rejected(self):
        with self.assertRaises(ValueError):
            land_of('11D10101',{'11D10101':dict(regUp='11D10101')},{'11D10000'})

    def test_no_wrong_land_fallback_for_island(self):
        self.assertIsNone(land_of('11E00101',{'11E00101':dict(regUp='11000000')},{'11H10000'}))

    def test_exact_city_name_preferred_over_suffix_alias(self):
        zones=[dict(regId='11F20405',regUp='11F20000',lat=35.1,lon=127.2),
               dict(regId='11F20603',regUp='11F20000',lat=35.0,lon=127.0)]
        regions=[dict(type='C',reg_id='11F20405',name='순천시'),dict(type='C',reg_id='11F20603',name='순천')]
        groups=[dict(wide=dict(code='1200000000',name='전남광주통합특별시'),
                     city=dict(code='1215000000',name='순천시',lat='35.0',lon='127.0'),
                     towns=[dict(code='1215035000',name='주암면',lat='35.0',lon='127.0')])]
        result=build(zones,regions,groups,{},[],{'11F20000'})
        self.assertEqual(result['places'][0]['temp_id'],'11F20405')

    def test_review_sql_matches_data_and_template(self):
        self.assertEqual(render(DATA),(ROOT/'docs/sql/forecast_daily_regions_76.review.sql').read_text(encoding='utf-8'))

    def test_sql_delimiter_cannot_be_injected_from_label(self):
        data=copy.deepcopy(DATA);data['places'][0]['label']='$daily_places$;select 1;'
        with self.assertRaises(ValueError): render(data)


if __name__ == '__main__':
    if hasattr(sys.stdout,'reconfigure'): sys.stdout.reconfigure(encoding='utf-8')
    result=unittest.TextTestRunner(verbosity=1).run(unittest.defaultTestLoader.loadTestsFromTestCase(Regions))
    print(f'{result.testsRun-len(result.failures)-len(result.errors)}/{result.testsRun} 통과')
    sys.exit(not result.wasSuccessful())
