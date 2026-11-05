"""고속도로 주변 2km에 일부라도 닿는 구간별 예보 격자. 소속과 분리해 생성한다.

생성 의존성: pip install -r tools/grid_geometry_requirements.txt
--radius-km 0은 이전 1km 샘플링 자료를 재현할 때만 사용한다.
"""
import argparse,json
from pathlib import Path
from build_grid_assign import densify, to_grid

ROOT = Path(__file__).resolve().parent.parent


def sampled(doc):
    return {s['id']: sorted({to_grid(lat, lon) for lon, lat in densify(s['coords'])
                            if 1 <= to_grid(lat, lon)[0] <= 149 and 1 <= to_grid(lat, lon)[1] <= 253})
            for s in doc['sections']}


def build(doc, radius_km=2):
    if radius_km == 0:
        return sampled(doc)
    if radius_km < 0:
        raise ValueError('radius must be nonnegative')
    from pyproj import Transformer
    from shapely.geometry import LineString, Polygon, box
    from shapely.strtree import STRtree
    from build_grid_names import from_grid
    tr=Transformer.from_crs('EPSG:4326','EPSG:5179',always_xy=True)
    keys=[];polygons=[]
    for x in range(1,150):
        for y in range(1,254):
            corners=[from_grid(x+dx,y+dy) for dx,dy in [(-.5,-.5),(.5,-.5),(.5,.5),(-.5,.5)]]
            keys.append((x,y))
            polygons.append(Polygon([tr.transform(lon,lat) for lat,lon in corners]))
    tree=STRtree(polygons);distance=radius_km*1000;result={}
    for s in doc['sections']:
        road=LineString([tr.transform(*p) for p in s['coords']])
        lo,bo,hi,to=road.bounds
        candidates=tree.query(box(lo-distance-1,bo-distance-1,hi+distance+1,to+distance+1))
        result[s['id']]=sorted(keys[i] for i in candidates if road.distance(polygons[i])<=distance)
    return result


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--radius-km',type=float,default=2)
    args=parser.parse_args()
    doc = json.loads((ROOT/'data/sections.json').read_text(encoding='utf-8'))
    cells = build(doc,args.radius_km)
    meta={'version':2,'radiusKm':args.radius_km,'method':'polygon-distance','crs':'EPSG:5179'} if args.radius_km else {'version':1,'stepKm':1}
    (ROOT/'data/section_grid.json').write_text(json.dumps({**meta,'sections': cells}, separators=(',', ':')), encoding='utf-8')
    print(f'{len(cells)} sections / {sum(map(len, cells.values()))} section-cell pairs')
