#!/usr/bin/env python3
"""공식 읍면동 대표지점과 중기 구역을 연결한다. 네트워크/DB 쓰기는 하지 않는다.

입력은 getFcstZoneCd 전체 목록, 중기 구역 목록, 날씨누리 CITY/DONG 목록,
기존 격자 지명이다. 이 결과는 행정 경계 폴리곤 판정이 아니다.
기존 시군구 지명을 우선하고 새 격자는 가장 가까운 공식 읍면동을 대표로 쓴다.
"""
import argparse
import json
import math
import re
from pathlib import Path
from build_grid_names import from_grid

# 섬의 날씨 구역이 실제 본문에 없는 경우 아래 province 그룹에서 선택하지 않는다.
PROVINCES = {'11': {'11B00000'}, '28': {'11B00000'}, '41': {'11B00000'},
             '51': {'11D10000', '11D20000'}, '43': {'11C10000'},
             '30': {'11C20000'}, '36': {'11C20000'}, '44': {'11C20000'},
             '52': {'11F10000'}, '12': {'11F20000'}, '50': {'11G00000'},
             '27': {'11H10000'}, '47': {'11H10000'},
             '26': {'11H20000'}, '31': {'11H20000'}, '48': {'11H20000'}}


def canonical(name):
    return re.sub(r'[시군]$', '', re.sub(r'\([^)]*\)', '', name).strip())


def distance2(point, other):
    """소규모 국내 대표지점 비교용 거리 제곱(km²), 경도 보정 포함."""
    lat, lon = point
    return ((lat-other[0])*111)**2 + ((lon-other[1])*111*math.cos(math.radians(lat)))**2


def land_of(code, zones, land_ids):
    original, seen = code, set()
    while code:
        if code in seen:
            raise ValueError('cyclic forecast region parents')
        seen.add(code)
        if code in land_ids:
            return code
        if code not in zones:
            break
        code = zones[code]['regUp']
    # 일반 서울/인천/경기 부모와 중기 통합 구역의 계층은 다르다.
    return '11B00000' if original.startswith('11B') and '11B00000' in land_ids else None


def city_base(name):
    name = name.replace(' ', '').replace('특별자치시', '시')
    match = re.match(r'^(.+?[시군])', name)
    return canonical(match.group(1) if match else name)


def aliases(name):
    result = {name, name.replace(' ', '')}
    match = re.match(r'^(.+?[시군])', name)
    if match:
        result.add(match.group(1))
    match = re.match(r'^.+?시\s*(.+구)$', name)
    if match:
        result.add(match.group(1).strip())
    return result


def build(zones, regions, groups, names, cells, land_ids):
    zone_map = {z['regId']: z for z in zones}
    if len(zone_map) != len(zones):
        raise ValueError('duplicate forecast region')
    temps = []
    for r in regions:
        if r['type'] != 'C' or r['reg_id'] not in zone_map:
            continue
        z = zone_map[r['reg_id']]
        land = land_of(r['reg_id'], zone_map, land_ids)
        if land and z['lat'] is not None and z['lon'] is not None:
            temps.append(dict(id=r['reg_id'], name=canonical(r['name']), raw_name=r['name'], land=land,
                              point=(float(z['lat']), float(z['lon']))))
    codes = {}
    for group in groups:
        for town in group['towns']:
            codes.setdefault(town['code'], []).append(town)
    conflicts = {code for code, rows in codes.items() if len(rows) > 1}
    places, cities, seen = [], [], set()
    for group in groups:
        wide, city, towns = group['wide'], group['city'], group['towns']
        allowed = PROVINCES[wide['code'][:2]] & set(land_ids)
        candidates = [t for t in temps if t['land'] in allowed and t['name'] == city_base(city['name'])]
        exact = [t for t in candidates if t['raw_name'] == city['name'].strip()]
        if exact:
            candidates = exact
        if not candidates:
            base = re.sub(r'(특별자치시|특별자치도|특별시|광역시|도)$', '', wide['name'])
            if wide['code'].startswith('12') and city['name'].endswith('구'):
                base = '광주'
            candidates = [t for t in temps if t['land'] in allowed and t['name'] == base]
        if not candidates:
            # 현재 고속도로가 없는 섬(울릉군 등)은 임의로 내륙 도시를 배정하지 않는다.
            continue
        point = float(city['lat']), float(city['lon'])
        target = min(candidates, key=lambda t: distance2(point, t['point']))
        city_places = []
        for town in towns:
            code = town['code']
            if code in conflicts:
                continue  # 공식 목록의 중복 코드는 어느 한 행을 임의 채택하지 않는다.
            if code in seen or not re.fullmatch(r'\d{10}', code):
                raise ValueError('duplicate/invalid town code')
            seen.add(code)
            lat, lon = float(town['lat']), float(town['lon'])
            if not 30 <= lat <= 44 or not 122 <= lon <= 133:
                raise ValueError('invalid town coordinate')
            special = [t for t in temps if t['land'] in allowed and town['name'] in
                       (t['name']+'읍', t['name']+'면')]
            selected = min(special, key=lambda t: distance2((lat, lon), t['point'])) if special else target
            row = dict(code=code, city_code=city['code'],
                       label=wide['name']+' '+city['name']+' '+town['name'],
                       lat=lat, lon=lon, land_id=selected['land'], temp_id=selected['id'])
            places.append(row)
            city_places.append((town['name'], code))
        cities.append(dict(code=city['code'], aliases=aliases(city['name']), point=point,
                           towns=city_places))
    hints = []
    for nx, ny in sorted(set(map(tuple, cells))):
        label = names.get(f'{nx},{ny}', '')
        hits = [(len(a), c) for c in cities for a in c['aliases'] if a in label]
        if not hits:
            continue
        longest = max(n for n, _ in hits)
        choices = [c for n, c in hits if n == longest]
        city = min(choices, key=lambda c: distance2(from_grid(nx, ny), c['point']))
        towns = [(len(name), code) for name, code in city['towns'] if name in label]
        preferred = max(towns)[1] if towns else None
        hints.append(dict(nx=nx, ny=ny, city_code=city['code'], dong_code=preferred))
    return dict(version=1,
                sources=['https://apihub.kma.go.kr/apiList.do?seqApi=10&seqApiSub=321',
                         'https://apihub.kma.go.kr/api/typ01/url/fct_medm_reg.php',
                         'https://www.weather.go.kr/w/rest/zone/dong.do',
                         'data/grid_names.json (OSM-derived labels, supplemented for missing cells)'],
                representative='named_city_then_nearest_official_town',
                excluded_duplicate_codes=sorted(conflicts),
                places=sorted(places, key=lambda p: p['code']), hints=hints)


def resolve(data, nx, ny, use_hints=True):
    if type(nx) is not int or type(ny) is not int or not (1 <= nx <= 149 and 1 <= ny <= 253):
        raise ValueError('bad cell')
    point = from_grid(nx, ny)
    hint = next((h for h in data['hints'] if (h['nx'], h['ny']) == (nx, ny)), None) if use_hints else None
    choices = [p for p in data['places'] if not hint or
               (p['city_code'] == hint['city_code'] and
                (not hint['dong_code'] or p['code'] == hint['dong_code']))]
    if not choices:
        return None
    place = min(choices, key=lambda p: (distance2(point, (p['lat'], p['lon'])), p['code']))
    km = math.sqrt(distance2(point, (place['lat'], place['lon'])))
    if km > 40:
        return None
    return dict(place, distance_km=round(km, 2), method='named_place' if hint else 'nearest_town')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('zones', 'regions', 'towns', 'names', 'cells', 'output'):
        parser.add_argument('--'+name, type=Path, required=True)
    args = parser.parse_args()
    read = lambda p: json.loads(p.read_text(encoding='utf-8'))
    raw, groups = read(args.regions), read(args.towns)
    data = build(read(args.zones)['items'], raw['regions'], list(groups.values()),
                 read(args.names), read(args.cells), raw['land_ids'])
    missing = [c for c in read(args.cells) if resolve(data, *c) is None]
    if missing:
        raise ValueError(f'unresolved active cells: {missing}')
    args.output.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':'))+'\n', encoding='utf-8')
    print(f"places={len(data['places'])} hints={len(data['hints'])} unresolved=0")


if __name__ == '__main__':
    main()
