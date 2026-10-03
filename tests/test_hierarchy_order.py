"""
본부·지사 순서 일치 시험 — 관리 콘솔(비밀번호 일괄 설정 표)이 강설량 측정 화면(data/hierarchy.json)과 같은 순서를 쓰는지 실제 자료로 확인
  1) data/sections.json 의 본부·지사 목록과 순서가 data/hierarchy.json 과 같다 (지사 번호 B001… 이 곧 그 순서)
  2) supabase/seed/01_hqs_branches.sql (DB 에 넣은 본부·지사)이 같은 순서다
  3) 관리 콘솔의 정렬 규칙(본부 순서 → 지사 번호)을 DB 자료에 적용하면 hierarchy.json 의 순서가 그대로 나온다
  4) docs/accounts.md 의 지사 표도 같은 순서다
실행: python tests/test_hierarchy_order.py
"""
import json, re, sys
from pathlib import Path
R = Path(__file__).resolve().parent.parent
J = lambda p: json.loads((R / p).read_text(encoding="utf-8"))
res = []
def test(n, f):
    try: f(); res.append((n, True, ""))
    except Exception as e: res.append((n, False, str(e)[:300]))
def eq(a, b, m=""):
    if a != b: raise AssertionError(f"{m} 다름\n  {a[:12]}...\n  {b[:12]}...")

hier = J("data/hierarchy.json"); doc = J("data/sections.json")
H_ORDER = [h["name"] for h in hier["hq"]]
B_ORDER = [(h["name"], b["name"]) for h in hier["hq"] for b in h["branches"]]

def seed():
    sql = (R / "supabase/seed/01_hqs_branches.sql").read_text(encoding="utf-8")
    hqs = re.findall(r"\('(H\d+)','([^']+)',(?:true|false),(\d+)\)", sql)
    brs = re.findall(r"\('(B\d+)','(H\d+)','([^']+)',", sql)
    return {h[0]: (h[1], int(h[2])) for h in hqs}, brs

test("sections.json 의 본부 순서 = hierarchy.json 의 본부 순서(민자 제외)", lambda: eq([h for h in doc["hqs"] if h != "민자"], H_ORDER, "본부 순서"))
test("sections.json 의 지사 순서(지사 번호 순) = hierarchy.json 의 지사 순서", lambda: eq([(b["hq"], b["name"]) for b in sorted(doc["branches"], key=lambda x: x["id"])], B_ORDER, "지사 순서"))
def seed_vs_hier():
    hq, brs = seed(); eq([name for name, _ in sorted(hq.values(), key=lambda x: x[1]) if name != "민자"], H_ORDER, "DB 본부 순서")
    eq([(hq[h][0], n) for _, h, n in sorted(brs)], B_ORDER, "DB 지사 순서(지사 번호 순)")
test("DB 시드(본부·지사)의 순서 = hierarchy.json", seed_vs_hier)
def sort_rule():                      # admin.js 의 cmpHier 와 같은 규칙: 본부 sort → 지사 번호
    hq, brs = seed(); rows = sorted(brs, key=lambda r: (hq[r[1]][1], r[0]))
    eq([(hq[h][0], n) for _, h, n in rows], B_ORDER, "정렬 규칙 적용 결과")
test("관리 콘솔의 정렬 규칙(본부 순서 → 지사 번호)을 적용하면 hierarchy.json 의 순서가 그대로 나온다", sort_rule)
def accounts_md():
    rows = re.findall(r"^\| (B\d+) \| ([^|]+) \| ([^|]+) \| `(ex[a-z]+)` \|", (R / "docs/accounts.md").read_text(encoding="utf-8"), re.M)
    eq([(h.strip(), n.strip()) for _, h, n, _ in rows], B_ORDER, "계정 목록 문서 순서"); assert len(rows) == 59
test("docs/accounts.md 의 지사 표 순서 = hierarchy.json (59개)", accounts_md)
test("지사 59개, 본부 9개(민자 제외)", lambda: eq((len(B_ORDER), len(H_ORDER)), (59, 9), "개수"))

ok = sum(1 for _, o, _ in res if o)
for n, o, m in res: print(("PASS " if o else "FAIL ") + n + ("" if o else "\n   → " + m))
print(f"\n{ok}/{len(res)} 통과"); sys.exit(0 if ok == len(res) else 1)
