#!/usr/bin/env python3
"""
미지정 고속도로 구간 추가 도구 — 어느 지사에도 속하지 않은 고속도로를 IC/JC 사이 구간으로 만들어
`data/sections.json` 에 소속 없음(owner = null)으로 덧붙입니다. 화면에서 눌러서 지사에 배정할 수 있게 하기 위한 것입니다.

하는 일
 1. `data/sections.json` 의 지사 구간과 겹치지 않는 고속도로 본선 링크(연결로 제외)를 찾습니다.
 2. 그 링크들을 따라 IC/JC 에서 다음 IC/JC 까지의 도로를 구간으로 만듭니다.
    - 상·하행 두 갈래가 있으면 같은 IC/JC 쌍 사이에서는 더 짧은 한 쪽만 씁니다.
 3. 기존 구간(S0001…)은 번호와 내용을 바꾸지 않고, 새 구간만 뒤에 번호를 이어서 붙입니다.
 4. `data/hierarchy.json`, `data/snow_data.json` 은 건드리지 않습니다. (아무 지사에도 속하지 않은 구간이므로)

실행 예 (저장소 맨 위 폴더에서)
    python tools/add_unassigned_sections.py --links highway_links.gpkg --nodes highway_nodes.gpkg --prj MOCT_NODE.prj
"""
import argparse, collections, heapq, json, sys
from pathlib import Path
import numpy as np
from pyproj import CRS, Transformer
from shapely.geometry import LineString
from shapely.strtree import STRtree

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_jurisdiction import IC_BAD, IC_PAT, Net, load_links, load_nodes, norm   # noqa: E402

COVER_M = 120          # 지사 구간에서 이 거리 안에 있으면 "이미 배정된 도로"
MIN_SECTION_M = 300    # 이보다 짧은 구간은 만들지 않음
MAX_SECTION_KM = 80    # 이보다 긴 구간은 이상값으로 보고 제외
CLUSTER_M = 1500       # 같은 이름의 IC/JC 노드가 이 거리 안이면 같은 IC/JC
RAMP_COST = 3          # 연결로(ROAD_TYPE 003) 링크의 길 찾기 비용 배수
MIN_MAINLINE = 0.5     # 구간 길이 중 본선(연결로 아님)이 이 비율 이상이어야 구간으로 인정
SIMPLIFY_M = 8         # 좌표를 이 오차(m) 안에서 줄여 파일 크기를 줄임
DUP_RATIO = 0.8        # 이미 만든 구간과 이 비율 이상 겹치면 같은 구간(이름만 다른 IC)으로 보고 뺌
TAG_M = 100            # 링크에서 이 거리 안에 IC/JC 노드가 있으면 그 링크는 "그 IC/JC 근처"


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
    if any(s.get('owner') is None for s in doc['sections']):
        print('이미 미지정 구간이 들어 있습니다. 먼저 data/sections.json 에서 owner 가 null 인 구간을 지우고 다시 실행하세요.')
        return

    # ---------- 1) 이미 배정된 도로와 겹치지 않는 본선 링크 ----------
    assigned = [LineString(np.array(from_ll.transform(*zip(*s['coords']))).T) for s in doc['sections']]
    tree = STRtree(assigned)

    def covered(coords):
        g = LineString(coords)
        hit = 0
        for t in (0.15, 0.5, 0.85):
            p = g.interpolate(t, normalized=True)
            if any(assigned[i].distance(p) <= COVER_M for i in tree.query(p.buffer(COVER_M + 5))):
                hit += 1
        return hit >= 2

    un = [k for k, l in enumerate(net.links) if not covered(l['coords'])]   # 연결로(003)도 포함: IC/JC 구간에서는 본선이 003 링크로 이어지는 경우가 많음
    adj = collections.defaultdict(list)
    for k in un:
        l = net.links[k]
        cost = l['len'] * (RAMP_COST if l['type'] == '003' else 1)        # 연결로는 비싸게 쳐서 가능하면 본선을 따라가게 함
        adj[l['f']].append((l['t'], cost, k))
        adj[l['t']].append((l['f'], cost, k))
    un_km = sum(net.links[k]['len'] for k in un if net.links[k]['type'] != '003') / 1000

    # ---------- 2) IC/JC 묶음(같은 이름·가까운 노드는 하나의 IC) ----------
    cluster = {}
    groups = collections.defaultdict(list)
    for i, n in enumerate(net.nodes):
        if net.is_ic[i]:
            groups[norm(n[2])].append(i)
    cname = {}
    for name, idxs in groups.items():
        centers = []
        for i in idxs:
            for ci, (cx, cy, mem) in enumerate(centers):
                if np.hypot(cx - net.xy[i][0], cy - net.xy[i][1]) <= CLUSTER_M:
                    mem.append(i)
                    break
            else:
                centers.append((net.xy[i][0], net.xy[i][1], [i]))
        for ci, (_, _, mem) in enumerate(centers):
            cid = '%s#%d' % (name, ci)
            cname[cid] = name
            for i in mem:
                cluster[net.nodes[i][0]] = cid

    # ---------- 3) 링크마다 "가까이 있는 IC/JC" 표시 → 표시된 링크에서 다음 표시된 링크 직전까지 걷기 ----------
    # IC/JC 노드는 본선이 아니라 연결로 끝에 있는 경우가 많아서, 노드가 아닌 "링크 가까이(TAG_M 이내)"로 판단합니다.
    ic_idx = [i for i in range(len(net.nodes)) if net.is_ic[i] and net.nodes[i][0] in cluster]
    from shapely.geometry import Point
    ic_pts = [Point(net.xy[i]) for i in ic_idx]
    ic_tree = STRtree(ic_pts)
    tags = {}
    for k in un:
        g = LineString(net.links[k]['coords'])
        t = set()
        for j in ic_tree.query(g.buffer(TAG_M)):
            if g.distance(ic_pts[j]) <= TAG_M:
                t.add(cluster[net.nodes[ic_idx[j]][0]])
        tags[k] = frozenset(t)
    starts = collections.defaultdict(list)
    for k, t in tags.items():
        for c in t:
            starts[c].append(k)

    print('[진단] 미지정 링크 %d개 중 IC/JC 근처로 표시된 링크 %d개, IC/JC 묶음 %d개' % (len(un), sum(1 for t in tags.values() if t), len(starts)), file=sys.stderr)
    best = {}      # (A, B) -> (거리, 노드경로)
    for ca, ks in starts.items():
        for k0 in ks:
            l0 = net.links[k0]
            for e, other in ((l0['t'], l0['f']), (l0['f'], l0['t'])):
                dist, prev, pq = {e: l0['len']}, {}, [(l0['len'], e)]
                while pq:
                    d, u = heapq.heappop(pq)
                    if d > dist.get(u, 1e18) or d > MAX_SECTION_KM * 1000:
                        continue
                    for v, w, k in adj.get(u, []):
                        if k == k0:
                            continue
                        newc = tags[k] - tags[k0] - {ca}
                        if newc:                                   # 다음 IC/JC 가 표시된 링크에 닿음 → 그 링크 직전까지가 한 구간
                            path = [u]
                            while path[-1] in prev:
                                path.append(prev[path[-1]])
                            path = [other] + path[::-1]
                            real, main = 0.0, 0.0
                            for x, y in zip(path[:-1], path[1:]):
                                kk = net.edge.get((x, y))
                                if kk is not None:
                                    real += net.links[kk]['len']
                                    main += net.links[kk]['len'] if net.links[kk]['type'] != '003' else 0
                            if real >= MIN_SECTION_M and main / max(real, 1) >= MIN_MAINLINE:
                                for cb in newc:
                                    key = tuple(sorted((ca, cb)))
                                    if key not in best or real < best[key][0]:
                                        best[key] = (real, path, ca, cb)
                            continue
                        nd = d + w
                        if nd < dist.get(v, 1e18):
                            dist[v] = nd
                            prev[v] = u
                            heapq.heappush(pq, (nd, v))

    print('[진단] 찾은 IC/JC 쌍 %d개' % len(best), file=sys.stderr)
    # ---------- 4) 구간으로 만들기 ----------
    raw = []
    for (_, _), (d, path, ca, cb) in best.items():
        coords = net.path_coords(path)
        if len(coords) < 2:
            continue
        names = collections.Counter()
        for u, v in zip(path[:-1], path[1:]):
            k = net.edge.get((u, v))
            if k is not None:
                names[net.links[k].get('name') or ''] += 1
        raw.append(dict(a=ca, b=cb, d=d, coords=coords, path=path, route=names.most_common(1)[0][0] if names else ''))

    # 이름만 다른 같은 IC(예: '청도IC' / '청도IC교차로') 때문에 같은 도로가 두 번 만들어지는 것을 막음
    raw.sort(key=lambda r: r['d'])
    kept_lines, dedup = [], []
    for r in raw:
        g = LineString(r['coords'])
        pts = [g.interpolate(x) for x in np.arange(0, g.length, 100)] + [g.interpolate(g.length)]
        if kept_lines:
            kt = STRtree(kept_lines)
            near = sum(1 for p in pts if any(kept_lines[i].distance(p) <= 40 for i in kt.query(p.buffer(45))))
            if near / len(pts) >= DUP_RATIO:
                continue
        kept_lines.append(g)
        dedup.append(r)
    print('[진단] 겹치는 중복 구간 %d개 제외' % (len(raw) - len(dedup)), file=sys.stderr)
    raw = dedup

    # 연결된 것끼리 같은 chain 으로 묶고, 한쪽 끝에서부터 order 를 매김 (Shift+클릭 범위 선택용)
    par = {}

    def find(x):
        while par.setdefault(x, x) != x:
            par[x] = par[par[x]]
            x = par[x]
        return x
    for r in raw:
        if r['route']:
            par[find(r['a'])] = find(r['b'])
    comps = collections.defaultdict(list)
    for r in raw:
        comps[find(r['a'])].append(r)
    base_chain = max(int(s['chain'][1:]) for s in doc['sections'])
    base_id = max(int(s['id'][1:]) for s in doc['sections'])
    new, chain_no = [], base_chain
    for members in sorted(comps.values(), key=lambda m: -sum(x['d'] for x in m)):
        deg = collections.Counter()
        for r in members:
            deg[r['a']] += 1
            deg[r['b']] += 1
        start = next((c for c, k in deg.items() if k == 1), members[0]['a'])
        by_node = collections.defaultdict(list)
        for r in members:
            by_node[r['a']].append(r)
            by_node[r['b']].append(r)
        seen, order, stack = set(), [], [(start, None)]
        while stack:
            node, via = stack.pop()
            for r in by_node[node]:
                if id(r) in seen:
                    continue
                seen.add(id(r))
                order.append((r, node))
                stack.append((r['b'] if r['a'] == node else r['a'], r))
        for r in members:
            if id(r) not in seen:
                order.append((r, r['a']))
        chain_no += 1
        for o, (r, frm) in enumerate(order, 1):
            pts = r['coords'] if frm == r['a'] else r['coords'][::-1]
            pts = list(LineString(pts).simplify(SIMPLIFY_M).coords)
            ll = np.array(to_ll.transform([p[0] for p in pts], [p[1] for p in pts])).T
            base_id += 1
            new.append(dict(id='S%04d' % base_id, route=r['route'] or '(이름 없음)',
                            **{'from': cname[frm], 'to': cname[r['b'] if frm == r['a'] else r['a']]},
                            km=round(r['d'] / 1000, 2), owner=None, chain='C%03d' % chain_no, order=o,
                            coords=[[round(float(x), 6), round(float(y), 6)] for x, y in ll]))

    km = sum(s['km'] for s in new)
    by_route = collections.Counter()
    for s in new:
        by_route[s['route']] += s['km']
    expect = collections.Counter()           # 예상 길이 = 미지정 본선 링크 길이(상·하행 합) ÷ 2
    for k in un:
        l = net.links[k]
        if l['type'] != '003':
            expect[l.get('name') or '(이름 없음)'] += l['len'] / 2000
    lines = ['# 미지정 고속도로 구간 생성 결과 (tools/add_unassigned_sections.py)', '',
             '- 지사 구간과 겹치지 않는 본선 링크: %d개, %.0f km (상·하행 합)' % (len(un), un_km),
             '- 만들어진 미지정 구간: **%d개, %.0f km** (상·하행 중 한쪽, IC/JC 사이)' % (len(new), km),
             '- 예상 길이(미지정 본선 링크 ÷ 2): %.0f km → **구간으로 만든 비율 %.0f%%**' % (sum(expect.values()), 100 * km / max(sum(expect.values()), 1)),
             '- 구간이 만들어지지 않은 부분(IC/JC 로 이어지지 않는 링크 등)은 지도에 회색 배경선으로만 보이고 선택할 수 없습니다.',
             '- ※ 이미 지사에 배정된 노선(경부·남해·서해안 등)의 "예상 길이"는 상당 부분이 **반대 방향 차로**(중앙분리대가 넓어 지사 구간에서 %dm 넘게 떨어진 곳)일 수 있어 실제 미지정 길이보다 크게 잡혔을 수 있습니다. (추정)' % COVER_M, '',
             '## 노선별', '', '| 노선 | 구간 수 | 만든 길이(km) | 예상 길이(km) |', '|---|---|---|---|']
    cnt = collections.Counter(s['route'] for s in new)
    for r, v in sorted(expect.items(), key=lambda kv: -kv[1]):
        if v >= 3 or by_route[r]:
            lines.append('| %s | %d | %.0f | %.0f |' % (r, cnt[r], by_route[r], v))
    report = '\n'.join(lines) + '\n'
    print(report)
    if a.dry:
        return
    doc['sections'].extend(new)
    (repo / 'data/sections.json').write_text(json.dumps(doc, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    (repo / 'docs').mkdir(exist_ok=True)
    (repo / 'docs/unassigned-sections-report.md').write_text(report, encoding='utf-8')


if __name__ == '__main__':
    main()
