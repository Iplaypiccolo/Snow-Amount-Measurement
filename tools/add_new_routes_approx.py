#!/usr/bin/env python3
"""
새로 개통했지만 아직 전국표준노드링크에 없는 고속도로를 '대략 위치'로 넣는 도구 (2026-11-02, 사용자 요청)

  - 강진광주선   강진JC ~ 벽진IC            (고속국도 제255호, 나들목 이름은 위키백과 기준·가칭 포함)
  - 함양울산선   북함양JC ~ 창녕JC          (함양~창녕 구간)
  - 당진청주선   인주JC(가칭) ~ 아산IC(염치)  (당진~천안 고속도로의 염치~인주 7.1km, 서부내륙선과 만나는 곳)

정확한 선형이 아님: 나들목·분기점 위치를 지명으로 어림잡아(수 km 오차 가능) 곧은 선으로 이었습니다.
분기점(JC)·아산IC 쪽 끝만 기존 고속도로 선 위의 가장 가까운 점에 붙여, 지도에서 끊겨 보이지 않게 합니다.
노선 이름 끝에 ' (대략)' 을 붙여 화면에서도 임시 자료임을 알 수 있게 합니다.

  - 소속(owner)은 없음(관할 미지정) → 관리자가 관할 탭에서 지사로 옮김(변경 이력으로 남음).
  - 기존 구간(S0001…S1011)은 번호·내용을 바꾸지 않고, 새 구간을 뒤에 S1012… 로 붙입니다.
  - 다시 돌려도 같은 결과(이미 있는 ' (대략)' 구간은 같은 번호 그대로 덮어씀).
  - 나중에 정식 자료(노드링크·KML 등)를 받으면 같은 번호의 coords·km 만 바꾸면 됩니다(번호는 이력이 가리키므로 유지).

실행: python tools/add_new_routes_approx.py            → data/sections.json 고침 + DB 반영용 SQL 을 표준출력으로
"""
import json, math, sys
from pathlib import Path

R = Path(__file__).resolve().parent.parent
F = R / "data/sections.json"
TAG = " (대략)"

# (노선, 체인, [(이름, 경도, 위도) 또는 (이름, ('snap', 기존 구간 번호, 경도, 위도))])
ROUTES = [
    ("강진광주선" + TAG, "C213", [
        ("강진JC",  ("snap", "S0465", 126.785, 34.700)),     # 남해선(영암~순천) 강진IC~장흥IC 사이, 강진군 작천면
        ("동영암IC", 126.765, 34.765),
        ("월출산IC", 126.760, 34.815),
        ("금정IC",  126.775, 34.865),                       # 국도23·지방도55, 영암군 금정면
        ("남나주IC", 126.775, 34.950),                       # 국도1·지방도49·60
        ("동나주IC", 126.800, 35.020),                       # 빛가람로(나주 혁신도시)
        ("대촌IC",  126.835, 35.080),                       # 회재로, 광주 남구 대촌동
        ("벽진IC",  126.848, 35.128),                       # 2순환로, 광주 서구 벽진동(종점)
    ]),
    ("함양울산선(함양~창녕)" + TAG, "C214", [
        ("북함양JC", ("snap", "S0637", 127.771, 35.560)),    # 통영대전선 함양JC~지곡IC 사이
        ("거창JC",  ("snap", "S0532", 127.870, 35.620)),    # 광주대구선 함양JC~거창IC 사이
        ("남거창IC", 127.960, 35.630),                       # 지방도1034, 거창군 남하면
        ("합천호IC", 128.050, 35.590),                       # 지방도1026·1089, 합천군 봉산면
        ("합천IC",  128.160, 35.550),                       # 국도33, 합천읍
        ("의령IC",  128.300, 35.460),                       # 국도20·지방도67
        ("창녕JC",  ("snap", "S0683", 128.510461, 35.463626)),   # 함양울산선(창녕~울산) 시작점
    ]),
    ("당진청주선(아산~천안)" + TAG, "C215", [
        ("인주JC(가칭)", ("snap", "S0797", 126.905, 36.857)),   # 아산시 인주면 냉정리 쪽 — 서부내륙고속도로(예산추사고택IC~영인IC)와 만나는 곳으로 봄
        ("아산IC",  ("snap", "S0267", 126.971425, 36.821942)),  # 1단계(2023 개통) 서쪽 끝(염치읍)
    ]),
]


def dist(p, q):
    return math.hypot((p[0] - q[0]) * 111320 * math.cos(math.radians(p[1])), (p[1] - q[1]) * 110574)


def length_km(c):
    return sum(dist(a, b) for a, b in zip(c, c[1:])) / 1000


def snap(line, x, y):
    """선(line) 위에서 (x, y)에 가장 가까운 점"""
    best, bp = 1e18, None
    for a, b in zip(line, line[1:]):
        ax, ay, bx, by = a[0], a[1], b[0], b[1]
        kx = math.cos(math.radians(ay))
        dx, dy = (bx - ax) * kx, by - ay
        t = 0 if dx == dy == 0 else max(0, min(1, (((x - ax) * kx) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
        p = [ax + (bx - ax) * t, ay + (by - ay) * t]
        d = dist(p, [x, y])
        if d < best: best, bp = d, p
    return [round(bp[0], 6), round(bp[1], 6)], best


def densify(a, b, step_m=800):
    n = max(1, int(dist(a, b) // step_m))
    return [[round(a[0] + (b[0] - a[0]) * i / n, 6), round(a[1] + (b[1] - a[1]) * i / n, 6)] for i in range(n + 1)]


def build(doc):
    by = {s["id"]: s for s in doc["sections"]}
    out = []
    for route, chain, pts in ROUTES:
        P = []
        for name, *v in pts:
            if isinstance(v[0], tuple):
                _, sid, x, y = v[0]
                p, d = snap(by[sid]["coords"], x, y)
                if d > 3000: sys.exit(f"{name}: {sid} 선에서 {d:.0f}m 떨어짐 — 어림 위치를 확인하세요")
                P.append((name, p))
            else:
                P.append((name, [v[0], v[1]]))
        for i, ((n1, a), (n2, b)) in enumerate(zip(P, P[1:])):
            c = densify(a, b)
            out.append({"route": route, "from": n1, "to": n2, "km": round(length_km(c), 2), "owner": None, "chain": chain, "order": i + 1, "coords": c})
    return out


def main():
    doc = json.loads(F.read_text(encoding="utf-8"))
    S = doc["sections"]
    old = [s for s in S if s["route"].endswith(TAG)]
    new = build(doc)
    if old and len(old) != len(new): sys.exit("이미 있는 '(대략)' 구간 수가 달라 번호를 그대로 쓸 수 없습니다 — 손으로 확인하세요")
    nxt = max(int(s["id"][1:]) for s in S if not s["route"].endswith(TAG)) + 1
    ids = [s["id"] for s in old] or [f"S{nxt + i:04d}" for i in range(len(new))]
    for sid, s in zip(ids, new):
        s_full = {"id": sid, **s}
        k = next((i for i, x in enumerate(S) if x["id"] == sid), None)
        if k is None: S.append(s_full)
        else: S[k] = s_full
    F.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")      # 다른 도구와 같은 모양(한 줄)
    # DB 반영 SQL(기준 자료 sections 사본)
    def q(v): return "null" if v is None else "'" + str(v).replace("'", "''") + "'"
    rows = [f"({q(s['id'])},{q(s['route'])},{q(s['from'])},{q(s['to'])},{s['km']},null,{q(s['chain'])},{s['order']},'{json.dumps(s['coords'], separators=(',', ':'))}'::jsonb)"
            for s in S if s["route"].endswith(TAG)]
    print("insert into public.sections (id, route, from_name, to_name, km, owner_id, chain, ord, coords) values\n  " + ",\n  ".join(rows) +
          "\non conflict (id) do update set route = excluded.route, from_name = excluded.from_name, to_name = excluded.to_name, km = excluded.km,"
          " chain = excluded.chain, ord = excluded.ord, coords = excluded.coords;")
    for s in S:
        if s["route"].endswith(TAG): print(f"-- {s['id']} {s['route']} {s['from']} → {s['to']} {s['km']}km", file=sys.stderr)


if __name__ == "__main__":
    main()
