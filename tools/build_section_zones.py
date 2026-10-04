"""고속도로 구간(data/sections.json) → 기상청 특보구역(끝 단계) 미리 계산 → data/section_zones.json

쓰는 자료(저장소에는 결과만 넣음)
  * 시·군·구 경계: 통계청 2013 경계(공개 GeoJSON) https://github.com/southkorea/southkorea-maps
      kostat/2013/json/skorea_municipalities_geo.json  (경위도, 시·군·구 251개)
  * 특보구역 목록: 기상청 API허브 wrn_reg.php?tmfc=0 결과(글 파일) — 키가 필요하므로 직접 받아 둔 파일을 넘김

규칙
  1. 구간 좌표를 약 200 m 간격으로 나눠 각 조각이 어느 시·군·구 안인지 봄(바다 위 다리 등 밖이면 2 km 안의 가장 가까운 시·군·구)
  2. 시·군·구 → 특보구역
     - 일반 시·군: 이름(예: 고양시덕양구 → 고양)이 같은 구역. 시·군이 평지/산지·동부/서부 등으로 나뉘어 있으면 나뉜 구역 모두
       (어느 쪽을 지나는지는 경계 자료가 없어 알 수 없음 → 관리자가 화면에서 뺄 수 있음)
     - 서울: 구 → 동남·동북·서남·서북권
     - 대구: 달성·군위는 그 구역, 나머지 구는 대구중부
     - 부산·울산·인천(강화·옹진 제외)·광주·세종·대전: 그 시의 끝 단계 구역 모두
     - 2013 이후 바뀐 이름: 청원군 → 청주
     - 섬 구역(보령도서·부안위도면·군산어청도·영광낙월면·완도여서도 등)은 고속도로가 닿지 않으므로 뺌
  3. 한 구간에서 0.3 km 미만으로 스치는 구역은 버림(그 구간의 유일한 구역이면 남김)

실행: python tools/build_section_zones.py <시군구 GeoJSON> <wrn_reg 글 파일>
"""
import json, math, re, sys
from collections import defaultdict
from pathlib import Path
from shapely.geometry import shape, Point
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parent.parent
SIDO = {'11': 'L1100000', '21': 'L1150000', '22': 'L1140000', '23': 'L1110000', '24': 'L1130000', '25': 'L1120000', '26': 'L1160000',
        '29': 'L1170000', '31': 'L1010000', '32': 'L1020000', '33': 'L1040000', '34': 'L1030000', '35': 'L1060000', '36': 'L1050000',
        '37': 'L1070000', '38': 'L1080000', '39': 'L1090000'}
METRO = {'21', '22', '23', '24', '25', '26', '29'}
SEOUL = {'서울동남권': '강남구 서초구 송파구 강동구', '서울동북권': '성동구 광진구 동대문구 중랑구 성북구 강북구 도봉구 노원구',
         '서울서남권': '양천구 강서구 구로구 금천구 영등포구 동작구 관악구', '서울서북권': '은평구 서대문구 마포구 종로구 중구 용산구'}
RENAMED = {'청원': '청주'}
ISLAND = re.compile(r'도서$|면(\(.*\))?$|어청도$|여서도$')
STEP_KM, MIN_KM, NEAR_DEG = 0.2, 0.3, 0.02


def load_zones(path):
    z = {}
    for line in Path(path).read_text(encoding='utf-8').splitlines():
        m = re.match(r'^(L\d{7})\s+(\d{12})\s+(\d{12})\s+(\d{8})\s+(\S+)\s+(.+?)\s*$', line)
        if m:
            z[m.group(1)] = {'up': m.group(5), 'ko': re.split(r'\s{2,}', m.group(6))[0].strip(), 'sp': m.group(4)}
    kids = defaultdict(list)
    for c, v in z.items():
        kids[v['up']].append(c)
    return z, kids


def leaves(code, z, kids):
    """그 구역 아래 끝 단계(REG_SP 끝 13·14) 구역들. 자기가 끝 단계면 자기"""
    if z[code]['sp'][-2:] in ('13', '14'):
        return [] if ISLAND.search(z[code]['ko']) else [code]
    out = []
    for k in sorted(kids.get(code, [])):
        out += leaves(k, z, kids)
    return out


def under(code, root, z):
    while code in z:
        if code == root:
            return True
        code = z[code]['up']
    return False


def sgg_zones(code, name, z, kids):
    sd = code[:2]
    if sd == '11':
        return [c for c, v in z.items() if v['ko'] in SEOUL and name in SEOUL[v['ko']].split()]
    base = re.match(r'(.+?)(시|군)', name)
    base = RENAMED.get(base.group(1), base.group(1)) if base and sd not in METRO else (base.group(1) if base else name)
    hits = [c for c, v in z.items() if v['ko'] == base and z[c]['sp'][-2:] in ('03', '13', '14', '02')]
    own = [c for c in hits if under(c, SIDO[sd], z)] or hits          # 군위처럼 시·도가 바뀐 곳은 전국에서
    own = [c for c in own if z[c]['sp'][-2:] != '02']
    if own:
        return sorted({x for c in own for x in leaves(c, z, kids)})
    if sd == '22':
        return [c for c, v in z.items() if v['ko'] == '대구중부']
    if sd in METRO:                                                     # 그 시의 끝 단계 구역 모두(따로 이름이 있는 군 제외)
        skip = {'강화', '옹진', '달성', '군위'}
        out = []
        for k in kids.get(SIDO[sd], []):
            if z[k]['ko'] not in skip:
                out += leaves(k, z, kids)
        return sorted(set(out))
    return []


def km(a, b):
    dx = (b[0] - a[0]) * 111.32 * math.cos(math.radians((a[1] + b[1]) / 2)); dy = (b[1] - a[1]) * 110.57
    return math.hypot(dx, dy)


def main(geo_path, reg_path):
    z, kids = load_zones(reg_path)
    feats = json.load(open(geo_path, encoding='utf-8'))['features']
    polys = [shape(f['geometry']) for f in feats]
    tree = STRtree(polys)
    sgg = [(f['properties']['code'], f['properties']['name']) for f in feats]
    zmap = {i: sgg_zones(c, n, z, kids) for i, (c, n) in enumerate(sgg)}
    missing = [sgg[i] for i, v in zmap.items() if not v and sgg[i][0][:2] != '39']
    if missing:
        print('특보구역을 못 찾은 시·군·구:', missing)

    def where(pt):
        p = Point(pt)
        for i in tree.query(p):
            if polys[i].covers(p):
                return int(i)
        near = tree.query(p.buffer(NEAR_DEG))
        return int(min(near, key=lambda i: polys[i].distance(p))) if len(near) else None

    sections = json.load(open(ROOT / 'data' / 'sections.json', encoding='utf-8'))['sections']
    out, nowhere = {}, []
    for s in sections:
        acc = defaultdict(float)
        cs = s['coords']
        for a, b in zip(cs, cs[1:]):
            d = km(a, b); n = max(1, math.ceil(d / STEP_KM))
            for k in range(n):
                t = (k + 0.5) / n
                i = where((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
                if i is None:
                    continue
                for zc in zmap[i]:
                    acc[zc] += d / n
        if not acc:
            nowhere.append(s['id']); continue
        keep = {zc: v for zc, v in acc.items() if v >= MIN_KM} or {max(acc, key=acc.get): max(acc.values())}
        out[s['id']] = [[zc, round(v, 2)] for zc, v in sorted(keep.items())]
    if nowhere:
        print('어느 시·군·구에도 안 걸친 구간:', nowhere)
    dst = ROOT / 'data' / 'section_zones.json'
    dst.write_text(json.dumps({'version': 1, 'source': '통계청 2013 시군구 경계 × 기상청 특보구역(wrn_reg) — tools/build_section_zones.py',
                               'sections': out}, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'{len(out)}개 구간 → {dst.relative_to(ROOT)} (구역 {len({zc for v in out.values() for zc, _ in v})}개)')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
