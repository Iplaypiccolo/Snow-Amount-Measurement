#!/usr/bin/env python3
"""
끊긴 구간 vs 원본 도로망 대조 — "원본(전국표준노드링크)에 도로가 있는데 구간에서 빠진 곳"만 찾아냅니다.

원칙(사용자 결정 2026-10-04): 원본 데이터에 없는 선은 절대 만들지 않는다(직선으로 잇지 않음). 원본에 있는데 빠진 것만 넣는다.

하는 일 (읽기만, 파일을 바꾸지 않음)
  1. data/sections.json 에서 "다른 구간과 닿지 않는 끝점"(30m 안에 다른 구간 선이 없음)을 찾고,
     그 끝점에서 가장 가까운 다른 구간까지의 빈틈(직선 거리 MAX_GAP_M 이하)을 모읍니다.
  2. 빈틈마다 원본 링크 선이 그 빈틈을 실제로 덮는지 잽니다:
     빈틈 양 끝 사이를 따라 원본 링크들을 이어 붙인 선(같은 방향 차로)에서 두 끝점까지의 거리가 모두 TOL_M 이하이고,
     그 사이 선 길이가 직선의 DETOUR 배 이하이면 → "원본에 있음(빠진 것)", 아니면 → "원본에 없음".
  3. 결과를 표로 출력합니다(--out 파일 지정 가능). 실제로 메우는 것은 --apply 일 때만(아래).

  --apply: "원본에 있음"이고 한쪽이 미지정 구간인 곳만, 원본 선의 해당 부분을 미지정 구간 끝에 이어 붙입니다.
           지사 구간 686개는 건드리지 않습니다(관측소 배정 불변). 구간 번호·소속·chain·order 는 그대로, 좌표·km 만 바뀝니다.

실행 (저장소 맨 위 폴더에서)
    python tools/check_gaps_against_source.py --links highway_links.gpkg --nodes highway_nodes.gpkg --prj MOCT_NODE.prj [--out 보고서.md] [--apply]
필요한 것: pip install pyproj shapely numpy
"""
import argparse, collections, heapq, json, sys
from pathlib import Path
import numpy as np
from pyproj import CRS, Transformer
from shapely.geometry import LineString, Point
from shapely.ops import linemerge, substring, unary_union
from shapely.strtree import STRtree

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_jurisdiction import load_links   # noqa: E402

TOUCH_M = 30        # 끝점이 다른 구간 선에서 이만큼 안이면 이어져 있다고 봄
MAX_GAP_M = 4000    # 이보다 먼 빈틈은 끊김이 아니라 도로의 끝으로 봄
TOL_M = 20          # 원본 선이 끝점에서 이만큼 안을 지나야 "그 끝점에 닿는다"고 봄
CORRIDOR_M = 60     # 빈틈 양 끝을 잇는 띠(이 폭 안의 원본 링크만 씀)
DETOUR = 1.6        # 원본 선을 따라간 길이가 직선 빈틈의 이 배수(+150m)를 넘으면 같은 길이 아닌 것으로 봄
SIMPLIFY_M = 8
RAMP_COST = 3       # 연결로(ROAD_TYPE 003)는 비용을 3배로 쳐서 가능하면 본선을 따라가게


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--links', required=True); ap.add_argument('--nodes', required=False); ap.add_argument('--prj', required=True)
    ap.add_argument('--repo', default='.'); ap.add_argument('--out'); ap.add_argument('--apply', action='store_true')
    a = ap.parse_args()
    repo = Path(a.repo)
    crs = CRS.from_wkt(Path(a.prj).read_text())
    to_ll = Transformer.from_crs(crs, 'EPSG:4326', always_xy=True)
    from_ll = Transformer.from_crs('EPSG:4326', crs, always_xy=True)
    links = load_links(a.links)
    links = [l for l in links if len(l['coords']) >= 2]
    L = [LineString(l['coords']) for l in links]; T = [l['type'] for l in links]
    tree = STRtree(L)

    path = repo / 'data/sections.json'
    doc = json.loads(path.read_text(encoding='utf-8')); secs = doc['sections']
    proj = lambda c: list(zip(*from_ll.transform([p[0] for p in c], [p[1] for p in c])))
    G = {s['id']: LineString(proj(s['coords'])) for s in secs}
    ids = list(G); stree = STRtree([G[i] for i in ids])

    # 1) 닿지 않는 끝점과 가장 가까운 다른 구간까지의 빈틈
    gaps, seen = [], set()
    for s in secs:
        g = G[s['id']]
        for end, p in (('시점', Point(g.coords[0])), ('종점', Point(g.coords[-1]))):
            near = [ids[k] for k in stree.query(p.buffer(MAX_GAP_M))]
            others = [(G[o].distance(p), o) for o in near if o != s['id']]
            if not others: continue
            d, o = min(others)
            if d <= TOUCH_M or d > MAX_GAP_M: continue
            q = G[o].interpolate(G[o].project(p))
            key = tuple(sorted([s['id'], o]))
            if key in seen: continue
            seen.add(key)
            gaps.append(dict(a=s['id'], b=o, end=end, p=p, q=q, d=d))

    # 2) 원본이 빈틈을 덮는지: 빈틈 주변 원본 링크로 작은 도로망을 만들고, 두 끝점(링크 위로 투영) 사이 최단 경로를 찾음
    others_tree = stree
    def overlap_ratio(piece, skip):
        near = [ids[k] for k in others_tree.query(piece.buffer(15))]
        segs = [G[o] for o in near if o not in skip]
        if not segs: return 0.0
        return piece.intersection(unary_union([x.buffer(15) for x in segs])).length / max(piece.length, 1e-9)

    def source_path(p, q, skip):
        d = p.distance(q)
        box = LineString([p, q]).buffer(max(CORRIDOR_M, d * 0.6) + 200)
        idx = [int(k) for k in tree.query(box)]
        if not idx: return None, '빈틈 근처에 원본 링크가 없음'
        kp = min(idx, key=lambda k: L[k].distance(p)); kq = min(idx, key=lambda k: L[k].distance(q))
        if L[kp].distance(p) > TOL_M or L[kq].distance(q) > TOL_M: return None, f'끝점 {TOL_M}m 안에 원본 선이 없음'
        key = lambda xy: (round(xy[0]), round(xy[1]))
        adj = collections.defaultdict(list)          # 노드 → (이웃, 비용, 길이, 조각 만드는 법)
        def edge(a, b, w, ln, mk): adj[a].append((b, w, ln, mk))
        for k in idx:
            c = L[k].coords; a, b = key(c[0]), key(c[-1]); w = L[k].length * (RAMP_COST if T[k] == '003' else 1)
            edge(a, b, w, L[k].length, ('f', k)); edge(b, a, w, L[k].length, ('r', k))
        tp, tq = L[kp].project(p), L[kq].project(q)
        if kp == kq:
            s0, s1 = sorted((tp, tq)); piece = substring(L[kp], s0, s1)
            if tp > tq: piece = LineString(list(piece.coords)[::-1])
        else:
            for nm, k, t in (('P', kp, tp), ('Q', kq, tq)):
                c = L[k].coords; a, b = key(c[0]), key(c[-1]); f = 3 if T[k] == '003' else 1
                if nm == 'P': edge('P', a, t * f, t, ('sub', k, t, 0.0)); edge('P', b, (L[k].length - t) * f, L[k].length - t, ('sub', k, t, L[k].length))
                else: edge(a, 'Q', t * f, t, ('sub', k, 0.0, t)); edge(b, 'Q', (L[k].length - t) * f, L[k].length - t, ('sub', k, L[k].length, t))
            dist, prev, pq = {'P': 0.0}, {}, [(0.0, 0, 'P')]; n = 0
            while pq:
                du, _, u = heapq.heappop(pq)
                if u == 'Q' or du > dist.get(u, 1e18): 
                    if u == 'Q': break
                    continue
                for v, w, ln, mk in adj[u]:
                    nd = du + w
                    if nd < dist.get(v, 1e18): dist[v] = nd; prev[v] = (u, mk); n += 1; heapq.heappush(pq, (nd, n, v))
            if 'Q' not in prev: return None, '원본 도로망에서 두 끝점이 이어지지 않음'
            pts, v = [], 'Q'
            chain = []
            while v != 'P': u, mk = prev[v]; chain.append(mk); v = u
            for mk in reversed(chain):
                if mk[0] == 'f': seg = list(L[mk[1]].coords)
                elif mk[0] == 'r': seg = list(L[mk[1]].coords)[::-1]
                else:
                    _, k, t0, t1 = mk; seg = list(substring(L[k], min(t0, t1), max(t0, t1)).coords)
                    if t0 > t1: seg = seg[::-1]
                pts += seg if not pts else seg[1:]
            piece = LineString(pts) if len(pts) >= 2 else None
            if piece is None: return None, '원본 도로망에서 두 끝점이 이어지지 않음'
        if piece.length > d * DETOUR + 150: return None, f'원본 경로({piece.length:.0f}m)가 빈틈보다 너무 돌아감(반대 차로·연결로 경유)'
        own = piece.intersection(unary_union([G[x].buffer(15) for x in skip])).length / max(piece.length, 1e-9)
        if own > 0.3: return None, f'원본 경로의 {own:.0%}가 이 구간 자기 선을 되짚음(실제로는 도로 끝·연결로 끝)'
        ov = overlap_ratio(piece, skip)
        if ov > 0.5: return None, f'원본 경로의 {ov:.0%}가 이미 다른 구간과 겹침'
        return piece, '원본에 있음(빠진 것)'

    owner = {s['id']: s['owner'] for s in secs}
    rows = []
    for g in sorted(gaps, key=lambda x: x['d']):
        piece, why = source_path(g['p'], g['q'], {g['a'], g['b']})
        g.update(piece=piece, why=why); rows.append(g)

    found = [g for g in rows if g['piece'] is not None]
    lines = ['# 끊긴 구간 vs 원본 도로망 대조 (tools/check_gaps_against_source.py)', '',
             f'- 다른 구간과 닿지 않는 끝점의 빈틈(30m 초과 {MAX_GAP_M}m 이하): **{len(rows)}곳**',
             f'- 그중 **원본에 도로가 있는데 빠진 곳: {len(found)}곳** / 원본에 없음: {len(rows) - len(found)}곳',
             '- 원칙: 원본에 없는 곳은 잇지 않는다(직선 금지). 원본에 있는 곳만, 미지정 구간 쪽에 원본 선을 붙인다(지사 구간은 건드리지 않음).', '',
             '| 구간(끝) → 가장 가까운 구간 | 노선 | 빈틈(m) | 원본 대조 | 원본 선 길이(m) | 메울 수 있나 |', '|---|---|---|---|---|---|']
    by = {s['id']: s for s in secs}
    for g in rows:
        sa, sb = by[g['a']], by[g['b']]
        can = '-' if g['piece'] is None else ('예(미지정 쪽에 붙임)' if (owner[g['a']] is None or owner[g['b']] is None) else '아니오(양쪽 다 지사 구간)')
        lines.append(f"| {g['a']}({g['end']}) → {g['b']} | {sa['route']} ({sa['from']}~{sa['to']}) | {g['d']:.0f} | {g['why']} | {'' if g['piece'] is None else round(g['piece'].length)} | {can} |")
    text = '\n'.join(lines) + '\n'
    if a.out: Path(a.out).write_text(text, encoding='utf-8')
    print(text)

    if a.apply:
        changed, skipped = 0, []
        for g in found:
            pc = list(g['piece'].simplify(SIMPLIFY_M).coords)          # p(끊긴 끝) → q(상대 구간 위) 방향
            if Point(pc[0]).distance(g['p']) > Point(pc[-1]).distance(g['p']): pc = pc[::-1]
            if owner[g['a']] is None:                                   # 끊긴 끝(a 의 시점/종점)에 원본 선을 붙임
                tgt, line = g['a'], list(G[g['a']].coords)
                new = (pc[::-1] + line[1:]) if g['end'] == '시점' else (line + pc[1:])
            elif owner[g['b']] is None:                                 # 상대(b)가 미지정이면 b 의 끝점에 닿을 때만 b 쪽에 붙임
                tgt, line = g['b'], list(G[g['b']].coords)
                if Point(line[0]).distance(g['q']) <= TOUCH_M: new = pc[:-1] + line
                elif Point(line[-1]).distance(g['q']) <= TOUCH_M: new = line + pc[::-1][1:]
                else: skipped.append(g['a'] + '→' + g['b'] + ' (상대 구간 중간에 닿음)'); continue
            else:
                continue
            s = by[tgt]
            ll = list(zip(*to_ll.transform([x for x, _ in new], [y for _, y in new])))
            s['coords'] = [[round(x, 6), round(y, 6)] for x, y in ll]
            s['km'] = round(LineString(new).length / 1000, 3)
            G[tgt] = LineString(new); changed += 1
        path.write_text(json.dumps(doc, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        print(chr(10) + f'메운 곳: {changed}곳 (data/sections.json 을 고침)' + (f' / 건너뜀: {", ".join(skipped)}' if skipped else ''))


if __name__ == '__main__':
    main()
