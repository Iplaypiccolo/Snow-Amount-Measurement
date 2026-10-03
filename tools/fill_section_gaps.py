#!/usr/bin/env python3
"""
구간 사이 끊김 메우기 도구 — 같은 고속도로에서 이웃한 두 구간(chain 순서가 연속) 사이에 지도 선이 비어 있는 곳을 실제 도로망으로 이어 붙입니다.

왜 끊겼나 (원인)
  `tools/add_unassigned_sections.py` 는 IC/JC 근처 링크에 표시를 해 두고, 다음 IC/JC 표시가 달린 링크 "직전"까지를 한 구간으로 만듭니다.
  그래서 IC/JC 를 지나는 구간의 본선(IC/JC 100m 안의 링크, 보통 0.5~2km)이 앞 구간에도 뒷 구간에도 들어가지 않고 비어 버립니다.
  (지사 구간은 IC/JC 지점에서 정확히 자르므로 끊김이 없습니다)

하는 일
  1. `data/sections.json` 에서 이어져야 할 두 구간의 끝점이 30m 넘게 떨어진 곳을 찾습니다.
     - 1단계: chain 순서가 연속인 구간 쌍
     - 2단계: 1단계로 못 찾은 나머지 끊긴 끝점 중, 도로망으로 가장 가까운 상대가 서로를 가리키는 쌍(둘이 서로 "가장 가까운 짝"일 때만)
  2. 두 끝점 사이를 도로망(원본 링크)에서 최단 경로로 찾아 옆 구간에 붙입니다. (연결로는 비용을 3배로 쳐서 가능하면 본선을 따라감)
     - 경로가 다른 구간과 많이 겹치거나(중복), 본선이 아니라 연결로 위주이면 건드리지 않습니다.
     - 양쪽이 모두 미지정이면 경로의 중간에서 반씩 나눠 붙입니다.
     - 한쪽만 지사 구간이면 지사 구간은 건드리지 않고(관측소 배정이 바뀌므로) 미지정 구간 쪽에 전부 붙입니다.
     - 양쪽이 모두 지사 구간이면 건드리지 않고 보고서에만 적습니다.
     - 끝점 간 거리가 4km 를 넘거나, 경로가 직선보다 너무 돌아가면(우회) 건드리지 않고 보고서에 적습니다.
  3. 구간 번호·소속·chain·order 는 그대로 두고, 좌표와 길이(km)만 늘립니다. → 저장된 변경 이력·변경 요청이 가리키는 구간 번호는 그대로 유효합니다.

실행 예 (저장소 맨 위 폴더에서)
    python tools/fill_section_gaps.py --links highway_links.gpkg --nodes highway_nodes.gpkg --prj MOCT_NODE.prj [--dry]
필요한 것: pip install pyproj shapely numpy
"""
import argparse, collections, heapq, json, sys
from pathlib import Path
import numpy as np
from pyproj import CRS, Transformer
from shapely.geometry import LineString
from shapely.ops import substring
from shapely.strtree import STRtree

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_jurisdiction import Net, load_links, load_nodes   # noqa: E402

OK_GAP_M = 30          # 이 안이면 이어져 있다고 봄
MAX_GAP_M = 4000       # 끝점 사이가 이보다 멀면 같은 도로의 끊김이 아니라 chain 순서의 우연으로 보고 건드리지 않음
NODE_TOL_M = 25        # 구간 끝점이 도로망 노드에서 이만큼 안에 있어야 함
RAMP_COST = 3          # 연결로(ROAD_TYPE 003) 길 찾기 비용 배수 (가능하면 본선을 따라가게)
DETOUR_RATIO = 1.8     # 경로 길이가 끝점 직선거리의 이 배수(+400m)를 넘으면 우회로 보고 건드리지 않음
SIMPLIFY_M = 8         # 덧붙이는 부분의 좌표를 이 오차(m) 안에서 줄임
OVERLAP_MAX = 0.5      # 붙일 경로의 이 비율 이상이 이미 있는 다른 구간과 겹치면 건드리지 않음 (IC 근처는 연결로 구간이 나란히 있어 어느 정도 겹치는 것이 정상)
MAINLINE_MIN = 0.6     # 2단계: 경로 길이 중 본선(연결로 아님)이 이 비율 이상이어야 함


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--links', required=True)
    ap.add_argument('--nodes', required=True)
    ap.add_argument('--prj', required=True)
    ap.add_argument('--repo', default='.')
    ap.add_argument('--dry', action='store_true')
    a = ap.parse_args()
    repo = Path(a.repo)
    crs = CRS.from_wkt(Path(a.prj).read_text())
    to_ll = Transformer.from_crs(crs, 'EPSG:4326', always_xy=True)
    from_ll = Transformer.from_crs('EPSG:4326', crs, always_xy=True)
    net = Net(load_nodes(a.nodes), load_links(a.links))
    doc = json.loads((repo / 'data/sections.json').read_text(encoding='utf-8'))
    secs = doc['sections']
    by_id = {s['id']: s for s in secs}
    proj = lambda c: np.array(from_ll.transform([p[0] for p in c], [p[1] for p in c])).T
    P = {s['id']: proj(s['coords']) for s in secs}                          # 구간 좌표(투영, m)

    adj = collections.defaultdict(list)
    for k, l in enumerate(net.links):
        w = l['len'] * (RAMP_COST if l['type'] == '003' else 1)
        adj[l['f']].append((l['t'], w))
        adj[l['t']].append((l['f'], w))
    node_ids = [n[0] for n in net.nodes]

    def node_near(p):
        d = np.hypot(net.xy[:, 0] - p[0], net.xy[:, 1] - p[1])
        i = int(d.argmin())
        return (node_ids[i], float(d[i])) if d[i] <= NODE_TOL_M else (None, float(d[i]))

    def dijkstra(src, limit):
        dist, prev, pq = {src: 0.0}, {}, [(0.0, src)]
        while pq:
            d, u = heapq.heappop(pq)
            if d > dist.get(u, 1e18) or d > limit:
                continue
            for v, w in adj.get(u, []):
                nd = d + w
                if nd < dist.get(v, 1e18):
                    dist[v] = nd
                    prev[v] = u
                    heapq.heappush(pq, (nd, v))
        return dist, prev

    def trace(prev, dst):
        path = [dst]
        while path[-1] in prev:
            path.append(prev[path[-1]])
        return path[::-1]

    def path_info(path):
        real = main_len = 0.0
        for u, v in zip(path[:-1], path[1:]):
            k = net.edge.get((u, v))
            if k is not None:
                real += net.links[k]['len']
                main_len += net.links[k]['len'] if net.links[k]['type'] != '003' else 0
        return real, main_len

    chains = collections.defaultdict(list)
    for s in secs:
        chains[s['chain']].append(s)
    for L in chains.values():
        L.sort(key=lambda s: s['order'])

    lines_tree = None
    def build_tree():
        nonlocal lines_tree
        ids = [s['id'] for s in secs]
        geoms = [LineString(P[i]) for i in ids]
        lines_tree = (STRtree(geoms), ids, geoms)

    def overlap_ratio(line, own):
        """붙일 경로가 이미 있는 다른 구간(own 두 개 제외)과 얼마나 겹치는가 (100m 간격 표본, 40m 이내)"""
        tree, ids, geoms = lines_tree
        pts = [line.interpolate(x) for x in np.arange(0, line.length, 100)] + [line.interpolate(line.length)]
        hit = 0
        for p in pts:
            for i in tree.query(p.buffer(45)):
                if ids[i] not in own and geoms[i].distance(p) <= 40:
                    hit += 1
                    break
        return hit / len(pts)

    adds = {}          # (구간 id, 'start'|'end') -> 끝점에서 바깥쪽으로 뻗는 좌표(투영, 첫 점이 그 끝점)
    report, skipped = [], []

    def endpoint(sid, which):
        c = P[sid]
        return c[0] if which == 'start' else c[-1]

    def apply_bridge(e, f, path_nodes, tag, gap, phase):
        (sa, wa), (sb, wb) = e, f
        pts = [tuple(p) for p in net.path_coords(path_nodes)]
        if len(pts) < 2:
            skipped.append((tag, gap, '경로 좌표가 없음')); return False
        pts[0], pts[-1] = tuple(endpoint(sa, wa)), tuple(endpoint(sb, wb))      # 양 끝은 구간 끝점과 정확히 같게
        line = LineString(pts)
        A, B = by_id[sa], by_id[sb]
        if A['owner'] is not None and B['owner'] is not None:
            skipped.append((tag, gap, '양쪽 모두 지사 구간(관측소 배정이 바뀔 수 있어 건드리지 않음)')); return False
        if A['owner'] is not None:
            t = 0.0                      # 전부 B 쪽으로
        elif B['owner'] is not None:
            t = 1.0                      # 전부 A 쪽으로
        else:
            t = 0.5
        L = line.length
        if (sa, wa) in adds or (sb, wb) in adds:
            skipped.append((tag, gap, '이미 다른 끊김을 메운 끝점')); return False
        if t > 0:
            adds[(sa, wa)] = np.array(substring(line, 0, L * t).simplify(SIMPLIFY_M).coords)
        if t < 1:
            adds[(sb, wb)] = np.array(substring(line, L, L * t).simplify(SIMPLIFY_M).coords) if False else np.array(LineString(list(substring(line, L * t, L).coords)[::-1]).simplify(SIMPLIFY_M).coords)
        how = '미지정 %s 쪽에 전부' % (sb if t == 0 else sa) if t in (0.0, 1.0) else '반씩'
        report.append((tag, gap, L, '%s (%d단계)' % (how, phase)))
        return True

    # ---------- 1단계: chain 순서가 연속인 구간 쌍 ----------
    build_tree()
    for c, L in chains.items():
        for x, y in zip(L, L[1:]):
            if y['order'] != x['order'] + 1:
                continue
            ex, sy = endpoint(x['id'], 'end'), endpoint(y['id'], 'start')
            gap = float(np.hypot(*(ex - sy)))
            if gap <= OK_GAP_M:
                continue
            tag = '%s→%s %s (%s / %s)' % (x['id'], y['id'], x['route'], x['to'], y['from'])
            if gap > MAX_GAP_M:
                skipped.append((tag, gap, '끝점 사이가 4km 를 넘음(같은 도로의 끊김이 아님)')); continue
            na, _ = node_near(ex)
            nb, _ = node_near(sy)
            if na is None or nb is None:
                skipped.append((tag, gap, '구간 끝점 가까이에 도로망 노드가 없음')); continue
            dist, prev = dijkstra(na, gap * 3 + 1500)
            if nb not in dist:
                skipped.append((tag, gap, '도로망에서 이어지는 경로를 못 찾음')); continue
            path = trace(prev, nb)
            real, main_len = path_info(path)
            if real > gap * DETOUR_RATIO + 400:
                skipped.append((tag, gap, '경로(%.0fm)가 직선(%.0fm)보다 너무 돌아감' % (real, gap))); continue
            ln = LineString([tuple(p) for p in net.path_coords(path)]) if len(path) > 1 else None
            if ln is None or ln.length == 0:
                skipped.append((tag, gap, '경로 좌표가 없음')); continue
            if overlap_ratio(ln, {x['id'], y['id']}) > OVERLAP_MAX:
                skipped.append((tag, gap, '경로가 이미 있는 다른 구간과 많이 겹침')); continue
            apply_bridge((x['id'], 'end'), (y['id'], 'start'), path, tag, gap, 1)

    # ---------- 2단계: 아직 끊긴 끝점들끼리 "서로 가장 가까운 짝" ----------
    def apply_adds_preview():
        out = {}
        for sid in P:
            c = P[sid]
            for which in ('start', 'end'):
                out[(sid, which)] = c[0] if which == 'start' else c[-1]
        for (sid, which), piece in adds.items():
            out[(sid, which)] = piece[-1]
        return out
    cur = apply_adds_preview()
    keys = list(cur.keys())
    xy = np.array([cur[k] for k in keys])
    dang = []
    for i, k in enumerate(keys):
        d = np.hypot(xy[:, 0] - xy[i, 0], xy[:, 1] - xy[i, 1])
        for j, k2 in enumerate(keys):
            if k2[0] == k[0]:
                d[j] = 1e9
        if d.min() > OK_GAP_M * 2 and (k not in adds):
            dang.append(i)
    best = {}
    cand = {}
    for i in dang:
        k = keys[i]
        n0, _ = node_near(xy[i])
        if n0 is None:
            continue
        dist, prev = dijkstra(n0, MAX_GAP_M * 1.6)
        opts = []
        for j in dang:
            k2 = keys[j]
            if k2[0] == k[0]:
                continue
            straight = float(np.hypot(*(xy[i] - xy[j])))
            if straight > MAX_GAP_M:
                continue
            n1, _ = node_near(xy[j])
            if n1 is None or n1 not in dist:
                continue
            path = trace(prev, n1)
            real, main_len = path_info(path)
            if real > straight * DETOUR_RATIO + 400 or real <= 0 or main_len / real < MAINLINE_MIN:
                continue
            opts.append((real, j, path, straight))
        if opts:
            opts.sort(key=lambda o: o[0])
            cand[i] = opts[0]
    for i, (real, j, path, straight) in cand.items():
        if j in cand and cand[j][1] == i:                                      # 서로가 서로의 가장 가까운 짝일 때만
            if i < j:
                A, B = by_id[keys[i][0]], by_id[keys[j][0]]
                tag = '%s(%s)↔%s(%s) %s' % (A['id'], A['to'] if keys[i][1] == 'end' else A['from'], B['id'], B['from'] if keys[j][1] == 'start' else B['to'], A['route'])
                ln = LineString([tuple(p) for p in net.path_coords(path)])
                if ln.length == 0 or overlap_ratio(ln, {A['id'], B['id']}) > OVERLAP_MAX:
                    skipped.append((tag, straight, '경로가 이미 있는 다른 구간과 많이 겹침')); continue
                apply_bridge(keys[i], keys[j], path, tag, straight, 2)

    # ---------- 구간에 적용 ----------
    changed, added_km = 0, 0.0
    for s in secs:
        pre, post = adds.get((s['id'], 'start')), adds.get((s['id'], 'end'))
        if pre is None and post is None:
            continue
        coords = [list(c) for c in s['coords']]
        add_m = 0.0
        def to_ll_list(arr):
            ll = np.array(to_ll.transform(arr[:, 0], arr[:, 1])).T
            return [[round(float(x), 6), round(float(y), 6)] for x, y in ll]
        if pre is not None:
            piece = to_ll_list(pre)[::-1]                                      # 바깥→끝점 순서로 뒤집어 앞에 붙임
            piece[-1] = coords[0]
            coords = piece[:-1] + coords
            add_m += LineString(pre).length
        if post is not None:
            piece = to_ll_list(post)
            piece[0] = coords[-1]
            coords = coords + piece[1:]
            add_m += LineString(post).length
        s['coords'] = coords
        s['km'] = round(s['km'] + add_m / 1000, 2)
        added_km += add_m / 1000
        changed += 1

    lines = ['# 구간 사이 끊김 메우기 결과 (tools/fill_section_gaps.py)', '',
             '- **메운 곳: %d곳** (1단계 chain 순서 기준 %d곳 + 2단계 서로 가장 가까운 짝 %d곳), 늘어난 구간 %d개, 늘어난 길이 합계 %.1fkm (구간 번호·소속·chain·order 는 그대로)' % (
                 len(report), sum(1 for r in report if '(1단계)' in r[3]), sum(1 for r in report if '(2단계)' in r[3]), changed, added_km),
             '- 건드리지 않은 곳(이웃 쌍 중): %d곳 — 아래 표. 대부분 "chain 순서만 이어질 뿐 실제로는 이웃이 아닌 쌍"이거나 원본 도로망에 이어지는 길이 없는 경우입니다.' % len(skipped), '',
             '## 건드리지 않은 곳', '', '| 구간 쌍 | 끝점 간격(m) | 이유 |', '|---|---|---|']
    for tag, gap, why in sorted(skipped, key=lambda x: x[1]):
        lines.append('| %s | %.0f | %s |' % (tag, gap, why))
    lines += ['', '## 메운 곳', '', '| 구간 쌍 | 끝점 간격(m) | 붙인 길이(m) | 방식 |', '|---|---|---|---|']
    for tag, gap, ln, how in sorted(report, key=lambda x: -x[1]):
        lines.append('| %s | %.0f | %.0f | %s |' % (tag, gap, ln, how))
    text = '\n'.join(lines) + '\n'
    print(text if a.dry else '\n'.join(lines[:5]))
    if a.dry:
        return
    (repo / 'data/sections.json').write_text(json.dumps(doc, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    (repo / 'docs/section-gaps-report.md').write_text(text, encoding='utf-8')


if __name__ == '__main__':
    main()
