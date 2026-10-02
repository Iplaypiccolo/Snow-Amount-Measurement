#!/usr/bin/env python3
"""
관할 구간(sections) 생성 도구 — 표준노드링크의 IC/JC 기준으로 지사 관할 구간을 나눕니다.

하는 일
 1. 지금 `data/hierarchy.json` 의 지사 관할 구간(routeSegments)을 읽습니다. (소속은 그대로 유지)
 2. 구간의 양 끝점이 IC/JC 가 아니면, 도로를 따라 가장 가까운 IC/JC 로 보정합니다.
    - IC/JC 가 구간 안쪽에 있으면 그 지점에서 잘라 줄이고, 바깥쪽이면 도로를 따라 늘립니다.
    - 늘린 부분이 다른 지사 구간과 겹치면 보정하지 않고 그대로 둡니다(보고서에 표시).
 3. 구간을 IC/JC 사이마다 잘라 `data/sections.json` 을 만듭니다. (화면에서 클릭해 지사를 옮기는 단위)
 4. 보정으로 관할이 바뀐 지사만 관측소 배정(반경 5km, 5대 이하면 6→7→8km)과 일별 신적설을 다시 계산해
    `data/hierarchy.json`, `data/snow_data.json` 에 반영합니다. 나머지 지사는 한 글자도 바뀌지 않습니다.

실행 예 (저장소 맨 위 폴더에서)
    python tools/build_jurisdiction.py --links highway_links.gpkg --nodes highway_nodes.gpkg --prj MOCT_NODE.prj

필요한 것: pip install pyproj shapely numpy
"""
import argparse, collections, datetime, heapq, json, re, sqlite3
from pathlib import Path
import numpy as np
from pyproj import CRS, Transformer
from shapely import wkb
from shapely.geometry import LineString, Point
from shapely.ops import substring
from shapely.strtree import STRtree

SNAP_NEAR_M = 40          # 끝점/구간 위에 IC/JC 노드가 이만큼 가까우면 "IC/JC에 닿았다"고 봄
MIN_SECTION_M = 300       # 이보다 짧은 구간은 만들지 않고 이웃과 합침
EXT_OVERLAP_MAX = 0.30    # 늘린 부분의 이 비율 이상이 다른 지사 구간과 겹치면 보정하지 않음
IC_PAT = re.compile(r'(IC|JC|분기점|나들목)')
IC_BAD = re.compile(r'(TG|톨게이트|앞|입구|출구|터널|교$|교\(|하이패스|휴게소)')


def norm(name):
    n = re.sub(r'\((남|북|동|서)측\)', '', name or '')
    return re.sub(r'\s+', '', n)


def parse_geom(b):
    env = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}[(b[3] >> 1) & 7]
    return wkb.loads(bytes(b[8 + env:]))


def load_nodes(path):
    c = sqlite3.connect(path)
    out = []
    for nid, t, name, g in c.execute("select NODE_ID,NODE_TYPE,NODE_NAME,geom from highway_nodes"):
        p = parse_geom(g)
        out.append((nid, t, name or '', p.x, p.y))
    return out


def load_links(path):
    c = sqlite3.connect(path)
    out = []
    for lid, f, t, ty, ln, nm, g in c.execute("select LINK_ID,F_NODE,T_NODE,ROAD_TYPE,LENGTH,ROAD_NAME,geom from moct_link"):
        geom = parse_geom(g)
        lines = list(geom.geoms) if geom.geom_type == 'MultiLineString' else [geom]
        coords = [xy for ln_ in lines for xy in ln_.coords]
        out.append(dict(id=lid, f=f, t=t, type=ty, len=ln, name=nm, coords=coords))
    return out


class Net:
    """도로 그래프: 노드=점, 링크=선. IC/JC 까지 도로를 따라 가장 가까운 경로를 찾는 데 씀."""
    def __init__(self, nodes, links):
        self.nodes = nodes
        self.idx = {n[0]: i for i, n in enumerate(nodes)}
        self.xy = np.array([(n[3], n[4]) for n in nodes])
        self.is_ic = np.array([bool(IC_PAT.search(n[2])) and not IC_BAD.search(n[2]) for n in nodes])
        self.edge = {}
        self.g_main = collections.defaultdict(list)
        self.g_all = collections.defaultdict(list)
        for k, l in enumerate(links):
            for a, b in ((l['f'], l['t']), (l['t'], l['f'])):
                self.g_all[a].append((b, l['len']))
                if l['type'] != '003':
                    self.g_main[a].append((b, l['len']))
                if (a, b) not in self.edge or links[self.edge[(a, b)]]['len'] > l['len']:
                    self.edge[(a, b)] = k
        self.links = links

    def nearest_ic(self, start_id, graph, cut=30000):
        dist, prev, pq = {start_id: 0}, {}, [(0, start_id)]
        while pq:
            d, u = heapq.heappop(pq)
            if d > dist.get(u, 1e18):
                continue
            i = self.idx.get(u)
            if i is not None and self.is_ic[i]:
                path = [u]
                while path[-1] in prev:
                    path.append(prev[path[-1]])
                return d, i, path[::-1]
            if d > cut:
                break
            for v, w in graph.get(u, []):
                nd = d + w
                if nd < dist.get(v, 1e18):
                    dist[v] = nd
                    prev[v] = u
                    heapq.heappush(pq, (nd, v))
        return None, None, None

    def path_coords(self, node_ids):
        """노드 경로를 따라 링크 선형 좌표를 이어 붙임 (시작→끝 방향)."""
        out = []
        for u, v in zip(node_ids[:-1], node_ids[1:]):
            k = self.edge.get((u, v))
            if k is None:
                continue
            pts = list(self.links[k]['coords'])
            iu = self.idx[u]
            if np.hypot(*(np.array(pts[0]) - self.xy[iu])) > np.hypot(*(np.array(pts[-1]) - self.xy[iu])):
                pts = pts[::-1]
            out.extend(pts if not out else pts[1:])
        return out


def near_ic_nodes(net, line, tol=SNAP_NEAR_M):
    """선 위(tol m 이내)에 있는 IC/JC 노드를 선을 따라 순서대로 돌려줌."""
    minx, miny, maxx, maxy = line.bounds
    pad = tol + 20
    m = net.is_ic & (net.xy[:, 0] >= minx - pad) & (net.xy[:, 0] <= maxx + pad) & (net.xy[:, 1] >= miny - pad) & (net.xy[:, 1] <= maxy + pad)
    hits = []
    for j in np.where(m)[0]:
        p = Point(net.xy[j])
        off = line.distance(p)
        if off <= tol:
            hits.append((line.project(p), off, norm(net.nodes[j][2]), int(j)))
    hits.sort()
    return hits


def cluster_hits(hits):
    """같은 IC/JC 의 여러 연결로 노드를 하나로 묶음 (300m 이내이거나, 같은 이름이 3km 이내)."""
    clusters = []
    for h in hits:
        if clusters:
            last = clusters[-1][-1]
            if h[0] - last[0] < MIN_SECTION_M or (h[2] == last[2] and h[0] - last[0] < 3000):
                clusters[-1].append(h)
                continue
        clusters.append([h])
    return [min(c, key=lambda x: x[1]) for c in clusters]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--links', required=True)
    ap.add_argument('--nodes', required=True)
    ap.add_argument('--prj', required=True)
    ap.add_argument('--repo', default='.')
    ap.add_argument('--dry', action='store_true', help='파일을 쓰지 않고 보고서만 출력')
    a = ap.parse_args()
    repo = Path(a.repo)

    crs = CRS.from_wkt(Path(a.prj).read_text())
    to_ll = Transformer.from_crs(crs, 'EPSG:4326', always_xy=True)
    from_ll = Transformer.from_crs('EPSG:4326', crs, always_xy=True)
    net = Net(load_nodes(a.nodes), load_links(a.links))

    hier = json.loads((repo / 'data/hierarchy.json').read_text(encoding='utf-8'))
    snow = json.loads((repo / 'data/snow_data.json').read_text(encoding='utf-8'))
    orig_hier = json.loads(json.dumps(hier))

    # ---------- 1) 지사별 구간 선 읽기 ----------
    segs = []   # dict(branch_idx, hq, name, route, P(np.array 투영좌표))
    branches = []
    for hq in hier['hq']:
        for b in hq['branches']:
            bi = len(branches)
            branches.append(dict(id='B%03d' % (bi + 1), hq=hq['name'], name=b['name']))
            for s in b['routeSegments']:
                c = np.array(s['coords'])
                P = np.array(from_ll.transform(c[:, 0], c[:, 1])).T
                segs.append(dict(bi=bi, route=s['route'], P=P, notes=[]))

    def line_of(s):
        return LineString(s['P'])

    def at_ic(pt):
        d = np.hypot(net.xy[:, 0] - pt[0], net.xy[:, 1] - pt[1])
        return bool(np.any(net.is_ic & (d <= SNAP_NEAR_M)))

    # ---------- 2) 끝점 보정: (가) 줄이기 먼저, (나) 늘리기 ----------
    pending_ext = []
    for si, s in enumerate(segs):
        for end in ('start', 'end'):
            P = s['P']
            pt = P[0] if end == 'start' else P[-1]
            if at_ic(pt):
                continue
            d = np.hypot(net.xy[:, 0] - pt[0], net.xy[:, 1] - pt[1])
            i = int(d.argmin())
            if d[i] > 800:
                s['notes'].append((end, '근처에 노드가 없어 그대로 둠', 0))
                continue
            best = None
            for g in (net.g_main, net.g_all):
                dd, j, path = net.nearest_ic(net.nodes[i][0], g)
                if dd is not None and (best is None or dd < best[0]):
                    best = (dd, j, path)
            if best is None:
                s['notes'].append((end, 'IC/JC를 찾지 못해 그대로 둠', 0))
                continue
            dd, j, path = best
            line = line_of(s)
            ip = Point(net.xy[j])
            s_on, off = line.project(ip), line.distance(ip)
            dist_m = float(d[i]) + dd
            if off < 80 and 0 < s_on < line.length:     # IC 가 구간 안쪽 → 줄이기
                if end == 'start' and line.length - s_on >= MIN_SECTION_M:
                    s['P'] = np.array(substring(line, s_on, line.length).coords)
                    s['notes'].append((end, '줄임 → %s' % net.nodes[j][2], -dist_m))
                elif end == 'end' and s_on >= MIN_SECTION_M:
                    s['P'] = np.array(substring(line, 0, s_on).coords)
                    s['notes'].append((end, '줄임 → %s' % net.nodes[j][2], -dist_m))
                else:
                    s['notes'].append((end, '줄이면 너무 짧아져 그대로 둠', 0))
            else:
                pending_ext.append((si, end, pt, i, j, path, dist_m))

    others_cache = None

    def other_branch_lines(bi):
        return [(LineString(t['P']), t['bi']) for t in segs if t['bi'] != bi]

    for si, end, pt, i, j, path in [(p[0], p[1], p[2], p[3], p[4], p[5]) for p in pending_ext]:
        s = segs[si]
        dist_m = next(p[6] for p in pending_ext if p[0] == si and p[1] == end)
        coords = net.path_coords(path)
        ext = LineString([tuple(pt)] + [tuple(c) for c in coords] + [tuple(net.xy[j])])   # 도로 선형이 없으면 직선으로 이음
        # 다른 지사 구간과 겹치는지
        pts = [ext.interpolate(x) for x in np.arange(0, ext.length, 100)] + [Point(ext.coords[-1])]
        olines = other_branch_lines(s['bi'])
        tree = STRtree([l for l, _ in olines])
        ov = sum(1 for p in pts if any(olines[k][0].distance(p) <= 40 for k in tree.query(p.buffer(45))))
        if ov / len(pts) >= EXT_OVERLAP_MAX:
            s['notes'].append((end, '다른 지사 구간과 겹쳐 그대로 둠 (→ %s)' % net.nodes[j][2], 0))
            continue
        ext_pts = np.array(ext.coords)
        s['P'] = np.vstack([ext_pts[::-1][:-1], s['P']]) if end == 'start' else np.vstack([s['P'], ext_pts[1:]])
        s['notes'].append((end, '늘림 → %s' % net.nodes[j][2], dist_m))

    # ---------- 3) IC/JC 기준으로 구간 자르기 ----------
    sections, chain_no = [], 0
    for si, s in enumerate(segs):
        chain_no += 1
        line = line_of(s)
        L = line.length
        hits = cluster_hits(near_ic_nodes(net, line))
        bounds = []
        for k, h in enumerate(hits):
            s_pos = h[0]
            if k == 0 and s_pos <= 100:
                s_pos = 0.0
            if k == len(hits) - 1 and s_pos >= L - 100:
                s_pos = L
            bounds.append((s_pos, h[2]))
        if not bounds or bounds[0][0] > 0:
            bounds.insert(0, (0.0, '(IC 아님)'))
        if bounds[-1][0] < L:
            bounds.append((L, '(IC 아님)'))
        # 너무 짧은 구간은 이웃과 합침
        merged = [bounds[0]]
        for b in bounds[1:]:
            if b[0] - merged[-1][0] < MIN_SECTION_M and b is not bounds[-1]:
                continue
            merged.append(b)
        for order, ((sa, na), (sb, nb)) in enumerate(zip(merged[:-1], merged[1:])):
            sub = substring(line, sa, sb)
            xy = np.array(sub.coords)
            ll = np.array(to_ll.transform(xy[:, 0], xy[:, 1])).T
            sections.append(dict(
                id='S%04d' % (len(sections) + 1), route=s['route'], **{'from': na, 'to': nb},
                km=round((sb - sa) / 1000, 2), owner=branches[s['bi']]['id'],
                chain='C%03d' % chain_no, order=order + 1,
                coords=[[round(float(x), 6), round(float(y), 6)] for x, y in ll]))

    # ---------- 4) hierarchy.json 의 routeSegments 를 구간에서 다시 만들기 ----------
    by_branch = collections.defaultdict(list)
    for sec in sections:
        by_branch[sec['owner']].append(sec)
    new_segments = {}
    for bid, secs in by_branch.items():
        groups = collections.OrderedDict()
        for sec in secs:
            groups.setdefault(sec['chain'], []).append(sec)
        out = []
        for chain, ss in groups.items():
            ss.sort(key=lambda x: x['order'])
            coords = list(ss[0]['coords'])
            for t in ss[1:]:
                coords.extend(t['coords'][1:])
            out.append({'route': ss[0]['route'], 'coords': coords})
        new_segments[bid] = out

    # ---------- 5) 관할이 바뀐 지사만 관측소·적설 다시 계산 ----------
    ST = {}
    for hq in orig_hier['hq']:
        for b in hq['branches']:
            for st in b['stations']:
                ST[st['id']] = st
    changed = []
    bidx = 0
    report_rows = []
    for hq in hier['hq']:
        for b in hq['branches']:
            br = branches[bidx]
            bidx += 1
            notes = [(sg['route'], n) for sg in segs if branches[sg['bi']]['id'] == br['id'] for n in sg['notes']]
            geom_changed = any(n[2] != 0 for _, n in notes)
            if geom_changed:      # 관할이 바뀐 지사만 선을 새로 씀 (나머지는 한 글자도 바꾸지 않음)
                b['routeSegments'] = new_segments[br['id']]
                changed.append((hq, b, br))
            for route, n in notes:
                report_rows.append((hq['name'], b['name'], route, n[0], n[1], n[2]))

    def station_dists(segments):
        ids = list(ST)
        LA = np.array([ST[i]['lat'] for i in ids])
        LO = np.array([ST[i]['lon'] for i in ids])
        best = np.full(len(ids), 1e9)
        road = [None] * len(ids)
        kx = 111.320 * np.cos(np.radians(LA))
        ky = 110.574
        for sg in segments:
            c = np.array(sg['coords'])
            for k in range(len(c) - 1):
                ax, ay = (c[k, 0] - LO) * kx, (c[k, 1] - LA) * ky
                bx, by = (c[k + 1, 0] - LO) * kx, (c[k + 1, 1] - LA) * ky
                dx, dy = bx - ax, by - ay
                L2 = dx * dx + dy * dy
                t = np.where(L2 == 0, 0, np.clip(-(ax * dx + ay * dy) / np.where(L2 == 0, 1, L2), 0, 1))
                d = np.hypot(ax + t * dx, ay + t * dy)
                upd = d < best
                for q in np.where(upd)[0]:
                    road[q] = sg['route']
                best = np.minimum(best, d)
        return ids, best, road

    def rule(segments):
        ids, d, road = station_dists(segments)
        for r in (5, 6, 7, 8):
            sel = np.where(d <= r)[0]
            if len(sel) > 5 or r == 8:
                out = []
                for q in sel:
                    st = ST[ids[q]]
                    out.append({'id': st['id'], 'name': st['name'], 'addr': st.get('addr'), 'lat': st['lat'], 'lon': st['lon'],
                                'dist_km': round(float(d[q]), 3), 'road': road[q]})
                out.sort(key=lambda x: x['dist_km'])
                return float(r), out

    key_changes = []
    for hq, b, br in changed:
        old_ids = {x['id'] for x in b['stations']}
        r, new = rule(b['routeSegments'])
        added = [x['name'] for x in new if x['id'] not in old_ids]
        removed = [x['name'] for x in b['stations'] if x['id'] not in {y['id'] for y in new}]
        hq['count'] = hq['count'] - len(b['stations']) + len(new)
        b['stations'], b['count'], b['radiusKm'] = new, len(new), r
        key_changes.append((hq['name'], b['name'], added, removed))

    # 일별 신적설 다시 계산 (지사 하루 값 = 배정 관측소들의 그날 최댓값)
    sd = snow['stationData']
    for hqn, bn, _, _ in key_changes:
        b = next(x for h_ in hier['hq'] if h_['name'] == hqn for x in h_['branches'] if x['name'] == bn)
        for season in snow['seasons'].values():
            series = []
            for date in season['dates']:
                vals = [sd[str(st['id'])][date] for st in b['stations'] if str(st['id']) in sd and sd[str(st['id'])].get(date) is not None]
                series.append(max(vals) if vals else None)
            season['branches']['%s|||%s' % (hqn, bn)] = series

    # ---------- 6) 보고서 ----------
    lines = ['# 관할 구간 생성 결과 (tools/build_jurisdiction.py)', '',
             '생성일: %s' % datetime.date.today().isoformat(), '',
             '- 지사 %d개, 구간(IC/JC 사이) %d개, 총 %.0f km' % (len(branches), len(sections), sum(s['km'] for s in sections)), '']
    adj = [r for r in report_rows if r[5] != 0]
    keep = [r for r in report_rows if r[5] == 0]
    lines += ['## 끝점 보정 (%d곳)' % len(adj), '', '| 본부/지사 | 노선 | 끝 | 내용 | 변화(km) |', '|---|---|---|---|---|']
    for hqn, bn, route, end, msg, m in sorted(adj, key=lambda r: -abs(r[5])):
        lines.append('| %s/%s | %s | %s | %s | %+.2f |' % (hqn, bn, route, '시작' if end == 'start' else '끝', msg, m / 1000))
    lines += ['', '## 보정하지 않고 그대로 둔 끝점 (%d곳)' % len(keep), '']
    for hqn, bn, route, end, msg, m in keep:
        lines.append('- %s/%s · %s %s: %s' % (hqn, bn, route, '시작' if end == 'start' else '끝', msg))
    lines += ['', '## 구간이 바뀐 지사 %d곳의 관측소 배정' % len(key_changes), '']
    for hqn, bn, added, removed in key_changes:
        lines.append('- %s/%s: %s' % (hqn, bn, ('추가 %s / 제외 %s' % (', '.join(added) or '-', ', '.join(removed) or '-')) if (added or removed) else '관측소 변화 없음'))
    kms = sorted(s['km'] for s in sections)
    nonic = sum(1 for s_ in sections if '(IC 아님)' in (s_['from'], s_['to']))
    lines += ['', '## 구간 통계', '', '- 구간 길이: 최소 %.1f / 중앙값 %.1f / 최대 %.1f km' % (kms[0], kms[len(kms) // 2], kms[-1]),
              '- 시점·종점 중 IC/JC 가 아닌 곳이 있는 구간: %d개' % nonic]
    report = '\n'.join(lines) + '\n'
    print(report)
    if a.dry:
        return

    # ---------- 7) 파일 쓰기 ----------
    sec_doc = {'version': 1, 'source': '전국표준노드링크 고속도로(ROAD_RANK=101) + IC/JC 노드',
               'hqs': [h['name'] for h in hier['hq']],
               'branches': branches, 'sections': sections}
    (repo / 'data/sections.json').write_text(json.dumps(sec_doc, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    (repo / 'data/hierarchy.json').write_text(json.dumps(hier, ensure_ascii=False), encoding='utf-8')
    (repo / 'data/snow_data.json').write_text(json.dumps(snow, ensure_ascii=False), encoding='utf-8')
    stations = [{'id': st['id'], 'name': st['name'], 'lat': st['lat'], 'lon': st['lon']} for st in sorted(ST.values(), key=lambda x: x['id'])]
    (repo / 'data/stations.json').write_text(json.dumps({'complete': False, 'note': '지사에 배정된 적이 있는 관측소만 들어 있습니다. 기상청 적설관측지점 전체 목록(좌표 포함)을 받으면 이 파일을 교체하세요.', 'stations': stations}, ensure_ascii=False), encoding='utf-8')
    chg = repo / 'data/jurisdiction_changes.json'
    if not chg.exists():
        chg.write_text(json.dumps({'version': 1, 'events': []}, ensure_ascii=False, indent=1), encoding='utf-8')
    (repo / 'docs').mkdir(exist_ok=True)
    (repo / 'docs/jurisdiction-build-report.md').write_text(report, encoding='utf-8')


if __name__ == '__main__':
    main()
