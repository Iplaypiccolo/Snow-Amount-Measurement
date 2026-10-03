"""
구간 데이터(data/sections.json) 연속성·무결성 시험 — 지도에서 고속도로 선이 중간에 끊겨 보이지 않는지 실제 자료로 확인
  1) 지사 구간(686개)의 모양·길이·소속은 끊김 메우기 전과 한 글자도 다르지 않다 (지문 비교: 관측소 배정이 바뀌지 않았다는 증거)
  2) 이웃한 구간 쌍 중 끝점이 30m~4km 떨어진 "끊김"이 메우기 전(166곳)보다 크게 줄었다
  3) 이어진 이웃 쌍이 메우기 전(603쌍)보다 늘었다
  4) 구간 번호·노선·시점·종점·소속·chain·order 는 그대로, 좌표는 한국 범위 안, 길이(km)가 선 길이와 크게 어긋나지 않는다
  5) 남밀양IC·삼랑진IC(화면에서 끊겨 보고된 곳)가 이어졌다
실행: python tests/test_sections_continuity.py
"""
import collections, hashlib, json, math, sys
from pathlib import Path
R = Path(__file__).resolve().parent.parent
doc = json.loads((R / "data/sections.json").read_text(encoding="utf-8")); S = doc["sections"]; by = {s["id"]: s for s in S}
res = []
def test(n, f):
    try: f(); res.append((n, True, ""))
    except Exception as e: res.append((n, False, str(e)[:300]))
def dist(p, q): return math.hypot((p[0] - q[0]) * 111320 * math.cos(math.radians(p[1])), (p[1] - q[1]) * 110574)
def length_km(c): return sum(dist(a, b) for a, b in zip(c, c[1:])) / 1000
def neighbor_gaps(lo=30, hi=4000):
    ch = collections.defaultdict(list)
    for s in S: ch[s["chain"]].append(s)
    out = []
    for L in ch.values():
        L.sort(key=lambda s: s["order"])
        for x, y in zip(L, L[1:]):
            if y["order"] == x["order"] + 1:
                g = dist(x["coords"][-1], y["coords"][0])
                if lo < g <= hi: out.append((g, x["id"], y["id"]))
    return out

OWN_HASH = "98154580ce5cad488af2f52bfc226416"        # 끊김 메우기 전 지사 구간 686개의 (번호|소속|길이|좌표) 지문
def t_branch_untouched():
    own = sorted([s for s in S if s["owner"]], key=lambda s: s["id"]); assert len(own) == 686, len(own)
    h = hashlib.md5("\n".join(f"{s['id']}|{s['owner']}|{s['km']}|{json.dumps(s['coords'], separators=(',', ':'))}" for s in own).encode("utf-8")).hexdigest()
    assert h == OWN_HASH, "지사 구간의 모양·길이·소속이 바뀌었습니다(관측소 배정이 달라질 수 있음)"
def t_gaps_reduced():
    g = neighbor_gaps(); assert len(g) <= 80, f"30m~4km 끊김 {len(g)}곳 (메우기 전 166곳)"
def t_miryang_connected():
    ok = lambda a, b: dist(by[a]["coords"][-1], by[b]["coords"][0]) <= 30
    assert ok("S0777", "S0778"), "남밀양IC 쪽이 이어져야 함"; assert ok("S0778", "S0779"), "삼랑진IC 쪽이 이어져야 함"; assert ok("S0776", "S0777"), "밀양JC~밀양IC 쪽이 이어져야 함"
def t_shared_points():
    ch = collections.defaultdict(list)
    for s in S: ch[s["chain"]].append(s)
    n = 0
    for L in ch.values():
        L.sort(key=lambda s: s["order"])
        for x, y in zip(L, L[1:]):
            if y["order"] == x["order"] + 1 and dist(x["coords"][-1], y["coords"][0]) <= 30:
                n += 1
    assert n >= 690, f"이어진 이웃 쌍 {n} (메우기 전 603쌍 → 후 697쌍)"
def t_meta_and_ranges():
    assert len(S) == 1011 and len({s["id"] for s in S}) == 1011
    assert sum(1 for s in S if s["owner"] is None) == 325
    for s in S:
        assert len(s["coords"]) >= 2 and all(124 <= c[0] <= 132 and 33 <= c[1] <= 39 for c in s["coords"]), s["id"]
        L = length_km(s["coords"]); assert abs(L - s["km"]) <= max(0.35, s["km"] * 0.25), f"{s['id']} 길이 {s['km']}km 인데 선은 {L:.2f}km"
for n, f in (("지사 구간 686개는 끊김 메우기 전과 한 글자도 다르지 않다(지문)", t_branch_untouched), ("이웃 구간 사이 끊김(30m~4km)이 166곳에서 80곳 이하로 줄었다", t_gaps_reduced),
             ("남밀양IC·삼랑진IC·밀양JC 쪽 중앙고속도로가 이어졌다", t_miryang_connected), ("이어진 이웃 쌍이 690쌍 이상(메우기 전 603쌍)", t_shared_points),
             ("구간 1,011개·미지정 325개, 좌표는 한국 범위, 길이(km)와 선 길이가 크게 어긋나지 않음", t_meta_and_ranges)):
    test(n, f)
ok = sum(1 for _, o, _ in res if o)
for n, o, m in res: print(("PASS " if o else "FAIL ") + n + ("" if o else "\n   → " + m))
print(f"\n{ok}/{len(res)} 통과"); sys.exit(0 if ok == len(res) else 1)
