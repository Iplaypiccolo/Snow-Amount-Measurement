#!/usr/bin/env python3
"""
예보 격자 지명 만들기 — 기관별 24시간 예보에서 격자 번호 대신 지명("평창군 대관령면")을 보이려고 씁니다.

하는 일: data/grid_assign.json 의 격자(지사 격자 + 둘레 후보 격자)마다 가운데 위경도를 구해(grid/core.js 와 같은 계산)
    OpenStreetMap Nominatim 역지오코딩으로 행정구역 이름을 받아 data/grid_names.json 에 { "nx,ny": "시군구 읍면동" } 으로 저장합니다.
    · 보내는 것은 좌표뿐. Nominatim 이용 규칙대로 1초에 1번, 이름표(User-Agent)를 붙임. 받은 것은 tools/.grid_names_cache.json 에 모아
      다시 돌려도 받은 칸은 건너뜀(처음 한 번 약 40분).
    · 바다·이름 없는 칸은 가장 가까운 이름 있는 칸의 이름을 씀(화면은 격자 번호도 작게 함께 보임).
    · 이름 = 시군구(광역시는 구) + 읍·면·동. 예: 평창군 대관령면, 달서구 월성동, 강릉시 성산면

사용(저장소 맨 위에서): python tools/build_grid_names.py
"""
import http.client, json, math, sys, time, urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / 'tools' / '.grid_names_cache.json'
OUT = ROOT / 'data' / 'grid_names.json'
UA = 'snow-support-gridnames/1.0 (one-time naming of KMA forecast grid cells; github.com/Iplaypiccolo/Snow-Amount-Measurement)'

# 기상청 단기예보 격자(LCC) → 위경도 — grid/core.js fromGrid 와 같은 식
RE, GRID, SLAT1, SLAT2, OLON, OLAT, XO, YO = 6371.00877, 5.0, 30.0, 60.0, 126.0, 38.0, 43, 136
def from_grid(nx, ny):
    DEG = math.pi / 180.0; re = RE / GRID
    s1, s2, olon, olat = SLAT1 * DEG, SLAT2 * DEG, OLON * DEG, OLAT * DEG
    sn = math.log(math.cos(s1) / math.cos(s2)) / math.log(math.tan(math.pi * 0.25 + s2 * 0.5) / math.tan(math.pi * 0.25 + s1 * 0.5))
    sf = math.tan(math.pi * 0.25 + s1 * 0.5) ** sn * math.cos(s1) / sn
    ro = re * sf / math.tan(math.pi * 0.25 + olat * 0.5) ** sn
    xn, yn = nx - XO, ro - (ny - YO)
    ra = math.copysign(math.sqrt(xn * xn + yn * yn), sn)
    alat = 2.0 * math.atan((re * sf / ra) ** (1.0 / sn)) - math.pi * 0.5
    if abs(xn) <= 0: theta = 0.0
    elif abs(yn) <= 0: theta = math.pi * 0.5 * (1 if xn >= 0 else -1)
    else: theta = math.atan2(xn, yn)
    return alat / DEG, (theta / sn + olon) / DEG

def name_of(addr):
    if not addr: return None
    area = addr.get('borough') or addr.get('city') or addr.get('county') or addr.get('city_district')
    sub = addr.get('town') or addr.get('quarter') or addr.get('suburb') or addr.get('neighbourhood') or addr.get('village')
    parts = [p for p in (area, sub) if p]
    return ' '.join(parts) if parts else (addr.get('province') or None)

_conn = None
def reverse(lat, lon):                    # 연결 하나를 계속 씀(요청마다 새로 연결하면 느림)
    global _conn
    q = urllib.parse.urlencode({'format': 'jsonv2', 'lat': f'{lat:.5f}', 'lon': f'{lon:.5f}', 'zoom': 14, 'accept-language': 'ko'})
    for _ in range(2):
        try:
            if _conn is None: _conn = http.client.HTTPSConnection('nominatim.openstreetmap.org', timeout=30)
            _conn.request('GET', '/reverse?' + q, headers={'User-Agent': UA})
            r = _conn.getresponse(); body = r.read()
            if r.status != 200: raise RuntimeError(f'HTTP {r.status}')
            return json.loads(body.decode('utf-8'))
        except (http.client.HTTPException, OSError):
            try: _conn.close()
            except Exception: pass
            _conn = None
    raise RuntimeError('연결 실패')

def main():
    ga = json.loads((ROOT / 'data' / 'grid_assign.json').read_text(encoding='utf-8'))
    cells = sorted({(c[0], c[1]) for c in ga['cells']} | {(c[0], c[1]) for c in ga.get('ring', [])})
    cache = json.loads(CACHE.read_text(encoding='utf-8')) if CACHE.exists() else {}
    main_cells = {(c[0], c[1]) for c in ga['cells']}
    todo = sorted([c for c in cells if f'{c[0]},{c[1]}' not in cache], key=lambda c: (c not in main_cells, c))   # 지사 격자 먼저, 둘레 후보는 나중
    print(f'격자 {len(cells)}칸, 받을 것 {len(todo)}칸 (약 {len(todo) * 1.1 / 60:.0f}분)', flush=True)
    for i, (nx, ny) in enumerate(todo, 1):
        t0 = time.time(); lat, lon = from_grid(nx, ny)
        for t in range(3):
            try: d = reverse(lat, lon); break
            except Exception as e: d = None; time.sleep(5 * (t + 1))
        cache[f'{nx},{ny}'] = name_of((d or {}).get('address')) if d is not None else None
        if i % 50 == 0 or i == len(todo):
            CACHE.write_text(json.dumps(cache, ensure_ascii=False), encoding='utf-8'); print(f'  {i}/{len(todo)}', flush=True)
        time.sleep(max(0.0, 1.05 - (time.time() - t0)))   # Nominatim 이용 규칙: 1초에 1번
    # 이름 없는 칸(바다 등)은 가장 가까운 이름 있는 칸의 이름
    named = {k: v for k, v in cache.items() if v}
    pts = [(tuple(map(int, k.split(','))), v) for k, v in named.items()]
    out = {}
    for nx, ny in cells:
        k = f'{nx},{ny}'
        if named.get(k): out[k] = named[k]; continue
        best = min(pts, key=lambda p: (p[0][0] - nx) ** 2 + (p[0][1] - ny) ** 2, default=None)
        if best: out[k] = best[1]
    OUT.write_text(json.dumps(out, ensure_ascii=False, sort_keys=True, separators=(',', ':')), encoding='utf-8')
    print(f'저장: {OUT.relative_to(ROOT)} — {len(out)}칸 (이름 직접 {len(named)}칸)')

if __name__ == '__main__':
    main()
