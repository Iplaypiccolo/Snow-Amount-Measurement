"""
'예보 격자 편입' 탭 화면 자동 테스트 — 브라우저로 직접 눌러 봅니다.
실행 (저장소 맨 위 폴더에서):  pip install playwright && playwright install chromium  →  python tests/test_grid_ui.py
지도 라이브러리(Leaflet)를 인터넷에서 받습니다. 막힌 곳이면 환경변수 LEAFLET_DIR, XLSX_FILE 을 지정하세요(tests/test_jurisdiction_ui.py 와 같음).
"""
import json, sys
sys.path.insert(0, __file__.rsplit("/", 1)[0])
import test_jurisdiction_ui as T       # 같은 서버·지도 라이브러리 설정을 재사용
import _sb_mock as SBM
from playwright.sync_api import sync_playwright

check, J = T.check, T.J
results, errors = [], T.errors

def open_grid(browser):
    p = browser.new_page(viewport={"width": 1400, "height": 900}, accept_downloads=True)
    T.OPENED.append(p)
    p.on("pageerror", lambda e: errors.append(str(e))); p.on("dialog", lambda d: d.accept()); p.route("**/*", T.route)
    SBM.install(p, SBM.Mock(), "admin-01")
    p.goto(T.URL); p.wait_for_function("window.GridUI && GridUI._state().inited", timeout=60000)
    p.click(".tab-btn[data-tab=grid]"); p.wait_for_timeout(900)
    return p

def run(name, fn, b):
    try: fn(b); results.append((name, True, ""))
    except Exception as e: results.append((name, False, f"{type(e).__name__}: {str(e)[:300]}"))
    finally:
        while T.OPENED:
            try: T.OPENED.pop().close()
            except Exception: pass

def admin(p): p.check("#gr-admin"); p.wait_for_timeout(150)
S = "GridUI._state()"
def ring_cells(p, n=3): return J(p, f"GRID.baseline.ring.slice(0, {n}).map(c => c[0] + ',' + c[1])")
def click_cell(p, k): J(p, f"(() => {{ {S}.rects['{k}'].fire('click'); return null }})()"); p.wait_for_timeout(80)
def first_branch(p, hq=None):
    return J(p, "(() => { const s = GridUI._state(); return s.state.order.find(id => s.ids.has(id)) })()")
def union(p): return J(p, f"{S}.sum.union")
def shared(p): return J(p, f"{S}.sum.shared")

def t_tab_loads(b):
    p = open_grid(b)
    n = J(p, f"Object.keys({S}.rects).length"); check(n == 1072 + 1389, f"격자 칸 {n}")
    check("934칸" in p.locator("#gr-summary").inner_text(), p.locator("#gr-summary").inner_text())
    check("분할 24번" in p.locator("#gr-summary").inner_text() and p.locator(".gr-badge.over").count() == 1, "934칸은 3시간 안에 못 끝남 안내")
    check(p.locator("#gr-tools").is_hidden() and p.locator("#gr-savebar").is_hidden() and p.locator("#gr-selbar").is_hidden(), "보기 모드에서는 편집 도구가 숨겨져야 함")
    box = p.locator("#gmap").bounding_box(); check(box and box["width"] > 500 and box["height"] > 400, f"지도 크기 {box}")
    check(p.locator("#gr-tree .jr-br").count() >= 59, "기관 목록")
    check(p.locator("#gr-tree .jr-hqname:has-text('민자')").count() == 0, "민자는 예보 대상이 아니라 목록에 없어야 함")
    p.click(".tab-btn[data-tab=jurisdiction]"); p.wait_for_timeout(500)      # 다른 탭과 함께 동작
    check(p.locator("#view-jurisdiction").is_visible() and p.locator("#view-grid").is_hidden(), "탭 전환")

def t_view_mode_popup_only(b):
    p = open_grid(b); k = J(p, f"GRID.baseline.cells.find(c => c[2].length)[0] + ',' + GRID.baseline.cells.find(c => c[2].length)[1]")
    click_cell(p, k); p.wait_for_timeout(250)
    check("편입" in p.locator(".leaflet-popup-content").inner_text(), "팝업")
    check(J(p, f"Object.keys({S}.selected).length") == 0, "보기 모드에서는 선택되지 않음")

def t_add_remove_and_save(b):
    p = open_grid(b); admin(p)
    check(p.locator("#gr-savebar").is_visible() and p.locator("#gr-savebar [data-act=save]").is_disabled(), "저장 바(변경 없음=비활성)")
    ks = ring_cells(p, 3); br = first_branch(p); u0 = union(p)
    for k in ks: click_cell(p, k)
    check("3칸 선택" in p.locator("#gr-selbar").inner_text(), p.locator("#gr-selbar").inner_text())
    p.select_option("#gr-dest", br); p.click("#gr-selbar [data-act=add]"); p.wait_for_timeout(250)
    ev = J(p, f"{S}.pending"); check(len(ev) == 1 and ev[0]["t"] == "add" and ev[0]["to"] == br and len(ev[0]["cells"]) == 3, ev)
    check(union(p) == u0 + 3, f"호출 대상 {u0} → {union(p)}")
    check(J(p, f"{S}.rects['{ks[0]}'].options.dashArray") == "6,4", "변경 대기는 주황 점선")
    check("변경 대기 1건" in p.locator("#gr-pending").inner_text() and p.locator("#gr-savebar [data-act=save]").is_enabled(), "대기 목록·저장 활성")
    p.click("#gr-savebar [data-act=preview]"); p.wait_for_timeout(250)
    txt = p.locator("#gr-modal").inner_text(); check(f"{u0} → {u0 + 3}칸" in txt, txt); p.click("#gr-modal [data-act=close]")
    p.fill("#gr-reason", "시험 편입")
    with p.expect_download() as dl: p.click("#gr-savebar [data-act=save]")
    data = json.load(open(dl.value.path(), encoding="utf-8")); e = data["events"][-1]
    check(data["version"] == 1 and e["t"] == "add" and e["to"] == br and len(e["cells"]) == 3 and e.get("note") == "시험 편입" and e.get("at"), e)
    check("아직 사이트에 반영된 것이 아닙니다" in p.locator("#gr-modal").inner_text(), "저장 안내")
    check(T.J(p, "GridUI._uploadUrl('iplaypiccolo.github.io', '/Snow-Amount-Measurement/')") == "https://github.com/iplaypiccolo/Snow-Amount-Measurement/upload/main/data", "업로드 주소")
    p.click("#gr-modal [data-act=close]")
    # 제외: 방금 넣은 칸 일부를 빼면 합집합이 줄어듦
    click_cell(p, ks[0]); click_cell(p, ks[1]); p.select_option("#gr-dest", br); p.click("#gr-selbar [data-act=remove]"); p.wait_for_timeout(250)
    check(union(p) == u0 + 1 and len(J(p, f"{S}.pending")) == 2, f"제외 후 {union(p)}")
    p.locator("#gr-pending .jr-x").first.click(); p.wait_for_timeout(200)       # 첫 변경(편입) 취소 → 제외만 남지만 효과 없음
    check(len(J(p, f"{S}.pending")) == 1, "개별 취소")
    p.click("#gr-savebar [data-act=cancel]"); p.wait_for_timeout(200)
    check(len(J(p, f"{S}.pending")) == 0 and union(p) == u0, "모두 취소")

def t_share_between_branches(b):
    p = open_grid(b); admin(p)
    ids = J(p, "[...GridUI._state().ids].slice(0, 2)"); k = ring_cells(p, 1)[0]; sh0 = shared(p); u0 = union(p)
    for br in ids:
        click_cell(p, k); p.select_option("#gr-dest", br); p.click("#gr-selbar [data-act=add]"); p.wait_for_timeout(200)
    bs = J(p, f"[...{S}.res.assign.get('{k}')]"); check(sorted(bs) == sorted(ids), bs)
    check(union(p) == u0 + 1 and shared(p) == sh0 + 1, "합집합은 1칸만 늘고 공유는 1칸 늘어야 함")
    J(p, f"(() => {{ {S}.rects['{k}'].fire('mouseover', {{latlng: {S}.rects['{k}'].getBounds().getCenter()}}); return null }})()"); p.wait_for_timeout(150)
    tip = p.locator(".gr-tip").inner_text(); check("공유" in tip, tip)
    check(J(p, f"{S}.rects['{k}'].options.weight") == 4 or J(p, f"{S}.rects['{k}'].options.color") in ("#d98a00", "#5b1a8f"), "공유/변경 표시")

def t_box_select(b):
    p = open_grid(b); admin(p)
    k = J(p, "GRID.baseline.cells[200][0] + ',' + GRID.baseline.cells[200][1]")
    box = J(p, f"""(() => {{ const m = {S}.map, c = {S}.rects['{k}'].getBounds().getCenter(); m.setView(c, 10, {{animate: false}});
      const p = m.latLngToContainerPoint(c), r = m.getContainer().getBoundingClientRect(); return [r.left + p.x, r.top + p.y] }})()""")
    p.wait_for_timeout(300); p.click("#gr-box"); p.wait_for_timeout(100)
    check(J(p, f"{S}.box") is True, "영역 선택 모드")
    x, y = box; p.mouse.move(x - 90, y - 70); p.mouse.down(); p.mouse.move(x + 20, y + 10, steps=6); p.mouse.move(x + 90, y + 70, steps=6); p.mouse.up(); p.wait_for_timeout(300)
    n = len(J(p, f"Object.keys({S}.selected)")); check(n >= 4, f"영역 선택 칸 수 {n}")
    check(f"{n}칸 선택" in p.locator("#gr-selbar").inner_text(), p.locator("#gr-selbar").inner_text())
    check(J(p, f"{S}.selected['{k}']") is True, "가운데 칸이 포함되어야 함")
    p.keyboard.press("Escape"); p.wait_for_timeout(100); check(J(p, f"{S}.box") is False, "Esc 로 영역 선택 종료")
    # Shift+드래그도 영역 선택
    p.click("#gr-selbar [data-act=clear]")
    p.keyboard.down("Shift"); p.mouse.move(x - 60, y - 50); p.mouse.down(); p.mouse.move(x + 60, y + 50, steps=8); p.mouse.up(); p.keyboard.up("Shift"); p.wait_for_timeout(300)
    check(len(J(p, f"Object.keys({S}.selected)")) >= 2, "Shift+드래그 선택")

def t_budget_levels(b):
    p = open_grid(b); admin(p)
    br = first_branch(p); ring = J(p, "GRID.baseline.ring.map(c => c[0] + ',' + c[1])")
    J(p, f"(() => {{ const s = {S}; {json.dumps(ring)}.forEach(k => s.selected[k] = true); }})()")
    p.evaluate("GridUI.show()"); p.wait_for_timeout(200); p.select_option("#gr-dest", br); p.click("#gr-selbar [data-act=add]"); p.wait_for_timeout(500)
    check(union(p) == 934 + 1389, f"합집합 {union(p)}")
    check(p.locator(".gr-badge.over").count() == 1 and "3시간 안에" in p.locator("#gr-summary").inner_text(), "한도 초과 안내")
    # 대부분 되돌리면 안전 구간(300칸 이하)으로
    p.click("#gr-savebar [data-act=cancel]"); p.wait_for_timeout(300)
    check(union(p) == 934, "모두 취소 후 934칸")

def t_focus_branch(b):
    p = open_grid(b); br = first_branch(p)
    p.click(f'#gr-tree .jr-br[data-id="{br}"]'); p.wait_for_timeout(500)
    check(J(p, f"{S}.focus") == br, "기관 선택")
    mine = J(p, f"[...{S}.res.assign].filter(([k, s]) => s.has('{br}')).map(([k]) => k)[0]")
    other = J(p, f"[...{S}.res.assign].filter(([k, s]) => s.size && !s.has('{br}')).map(([k]) => k)[0]")
    check(J(p, f"{S}.rects['{mine}'].options.fillOpacity") > J(p, f"{S}.rects['{other}'].options.fillOpacity"), "선택한 기관의 칸이 더 진하게")
    admin(p); p.click("#gr-tree [data-act=selbranch]"); p.wait_for_timeout(200)
    n = J(p, f"{S}.sum.perBranch['{br}']"); check(len(J(p, f"Object.keys({S}.selected)")) == n, "기관 격자 전체 선택")

def t_colors_match_other_tab(b):
    p = open_grid(b)
    r = J(p, """(() => { const s = GridUI._state(), br = [...s.ids][5], sec = JURIS.doc.sections.find(x => x.owner === br);
      return [JurisCore.colorOf(s.state, br), sec ? sec.id : null, br] })()""")
    p.click(".tab-btn[data-tab=jurisdiction]"); p.wait_for_timeout(900)
    col = J(p, f"JurisdictionUI._state().polys['{r[1]}'].options.color")
    check(col == r[0], f"관할 고속도로 탭 색 {col} / 격자 탭 색 {r[0]}")

def t_new_branch_from_jurisdiction_appears(b):
    p = b.new_page(viewport={"width": 1400, "height": 900}); T.OPENED.append(p)
    sess = {"events": [{"t": "addBranch", "id": "B900", "hq": "강원", "name": "신설시험"}]}
    p.add_init_script("sessionStorage.setItem('juris_session', %s)" % json.dumps(json.dumps(sess)))
    p.on("pageerror", lambda e: errors.append(str(e))); p.route("**/*", T.route); SBM.install(p, SBM.Mock(), "admin-01"); p.goto(T.URL)
    p.wait_for_function("window.GridUI && GridUI._state().inited", timeout=60000); p.click(".tab-btn[data-tab=grid]"); p.wait_for_timeout(700)
    check(p.locator("#gr-tree .jr-br:has-text('신설시험')").count() == 1, "관할 탭에서 만든 신설 기관이 격자 탭에도 보여야 함")
    check(p.locator("#gr-tree .jr-br:has-text('신설시험') em").count() == 1, "신설 표시")

TESTS = [t_tab_loads, t_view_mode_popup_only, t_add_remove_and_save, t_share_between_branches, t_box_select, t_budget_levels, t_focus_branch,
         t_colors_match_other_tab, t_new_branch_from_jurisdiction_appears]
if __name__ == "__main__":
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        for fn in TESTS: run(fn.__name__, fn, b)
        b.close()
    T.server.shutdown()
    ok = sum(1 for _, o, _ in results if o)
    for n, o, m in results: print(("PASS " if o else "FAIL ") + n + ("" if o else "  → " + m))
    real = [e for e in errors if "Leaflet" not in e]
    if real: print("\n페이지 오류:", *real[:6], sep="\n  ")
    print(f"\n{ok}/{len(results)} 통과")
    sys.exit(0 if ok == len(results) and not real else 1)
