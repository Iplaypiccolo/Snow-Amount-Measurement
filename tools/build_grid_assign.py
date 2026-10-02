#!/usr/bin/env python3
"""
예보 격자 기본 편입 데이터 생성 — data/grid_assign.json

하는 일
 - data/sections.json 의 관할 구간(선)을 1km 간격으로 훑어서, 고속도로가 지나는 기상청 5km 격자를 찾습니다.
 - 각 격자에 "그 격자를 지나가는 구간을 관할하는 기관(들)"을 기본 편입으로 적습니다. (한 격자를 여러 기관이 가질 수 있음)
   소속이 없는(미지정) 구간만 지나는 격자는 기관 없이 후보로만 둡니다.
 - 후보(ring): 위 격자의 이웃 8칸 중 아직 없는 격자. 산 위 지점처럼 도로 바로 옆 격자를 직접 골라 편입할 수 있게 하려는 것입니다.
실행:  python tools/build_grid_assign.py
"""
import json, math
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
RE, GRID, SLAT1, SLAT2, OLON, OLAT, XO, YO = 6371.00877, 5.0, 30.0, 60.0, 126.0, 38.0, 43, 136
D = math.pi / 180
_re = RE / GRID
_s1, _s2, _ol, _oa = SLAT1 * D, SLAT2 * D, OLON * D, OLAT * D
_sn = math.log(math.cos(_s1) / math.cos(_s2)) / math.log(math.tan(math.pi * .25 + _s2 * .5) / math.tan(math.pi * .25 + _s1 * .5))
_sf = math.tan(math.pi * .25 + _s1 * .5) ** _sn * math.cos(_s1) / _sn
_ro = _re * _sf / math.tan(math.pi * .25 + _oa * .5) ** _sn


def to_grid(lat, lon):
    ra = _re * _sf / math.tan(math.pi * .25 + lat * D * .5) ** _sn
    th = lon * D - _ol
    th = th - 2 * math.pi if th > math.pi else th + 2 * math.pi if th < -math.pi else th
    th *= _sn
    return math.floor(ra * math.sin(th) + XO + .5), math.floor(_ro - ra * math.cos(th) + YO + .5)


def hav(a, b):
    p1, p2, dl = math.radians(a[1]), math.radians(b[1]), math.radians(b[0] - a[0])
    x = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0088 * math.asin(math.sqrt(x))


def densify(c, step=1.0):
    out = [c[0]]
    for a, b in zip(c[:-1], c[1:]):
        n = max(1, int(hav(a, b) / step))
        out += [(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n) for i in range(1, n + 1)]
    return out


def main():
    doc = json.loads((REPO / 'data/sections.json').read_text(encoding='utf-8'))
    cells = {}
    for s in doc['sections']:
        for lon, lat in densify(s['coords']):
            cells.setdefault(to_grid(lat, lon), set())
            if s['owner']:
                cells[to_grid(lat, lon)].add(s['owner'])
    ring = set()
    for nx, ny in cells:
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                c = (nx + dx, ny + dy)
                if c not in cells and 1 <= c[0] <= 149 and 1 <= c[1] <= 253:
                    ring.add(c)
    out = {
        'version': 1,
        'grid': {'kind': 'KMA-LCC-5km', 're_km': RE, 'cell_km': GRID, 'slat1': SLAT1, 'slat2': SLAT2, 'olon': OLON, 'olat': OLAT, 'xo': XO, 'yo': YO,
                 'note': '기상청 동네예보 격자(nx 1~149, ny 1~253). cells=고속도로가 지나는 격자와 기본 편입 기관, ring=그 이웃(후보)'},
        'cells': [[nx, ny, sorted(b)] for (nx, ny), b in sorted(cells.items())],
        'ring': sorted([nx, ny] for nx, ny in ring),
    }
    (REPO / 'data/grid_assign.json').write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    chg = REPO / 'data/grid_changes.json'
    if not chg.exists():
        chg.write_text(json.dumps({'version': 1, 'events': []}, ensure_ascii=False, indent=1), encoding='utf-8')
    asg = sum(1 for b in cells.values() if b)
    print(f'고속도로가 지나는 격자 {len(cells)}칸 (기관 편입 {asg}칸, 미지정만 지나는 {len(cells) - asg}칸), 후보 이웃 {len(ring)}칸')
    print('여러 기관이 함께 가진 격자:', sum(1 for b in cells.values() if len(b) > 1), '칸')


if __name__ == '__main__':
    main()
