"""
'기관별 관할 고속도로' 탭 화면 자동 테스트
- 브라우저를 직접 띄워 구간 선택·이동·미리보기·저장 파일·신설 기관·본부 이동·임시 적용을 확인합니다.
- 실행 (저장소 맨 위 폴더에서):
      pip install playwright && playwright install chromium
      python tests/test_jurisdiction_ui.py
- 지도 라이브러리(Leaflet)를 인터넷에서 받습니다. 인터넷이 막힌 곳이면 환경변수 LEAFLET_DIR(leaflet/dist 폴더)와
  XLSX_FILE(xlsx.full.min.js 경로)을 지정하면 그 파일을 대신 씁니다.
"""
import functools, http.server, json, os, socketserver, sys, threading
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a, **k): pass
server = socketserver.TCPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(ROOT)))
PORT = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{PORT}/index.html"
LDIR, XFILE = os.environ.get("LEAFLET_DIR"), os.environ.get("XLSX_FILE")

def route(r):
    u = r.request.url
    if LDIR and "leaflet.min.js" in u: return r.fulfill(path=LDIR + "/leaflet.js", content_type="application/javascript")
    if LDIR and "leaflet.min.css" in u: return r.fulfill(path=LDIR + "/leaflet.css", content_type="text/css")
    if XFILE and "xlsx.full.min.js" in u: return r.fulfill(path=XFILE, content_type="application/javascript")
    if u.startswith("http://127.0.0.1"): return r.continue_()
    if LDIR: return r.abort()          # 오프라인 모드: 지도 타일 등은 막음
    return r.continue_()

results, errors = [], []
def check(c, m):
    if not c: raise AssertionError(m)

def open_tab(browser, session=None):
    p = browser.new_page(viewport={"width": 1400, "height": 900}, accept_downloads=True)
    p.on("pageerror", lambda e: errors.append(str(e)))
    p.on("dialog", lambda d: d.accept())
    p.route("**/*", route)
    if session is not None:
        p.add_init_script("sessionStorage.setItem('juris_session', %s)" % json.dumps(json.dumps(session)))
    p.goto(URL)
    p.wait_for_function("window.JurisdictionUI && JurisdictionUI._state().inited", timeout=60000)   # 데이터를 다 불러올 때까지 기다림
    p.click(".tab-btn[data-tab=jurisdiction]"); p.wait_for_timeout(700)
    return p

def run(name, fn, browser):
    try: fn(browser); results.append((name, True, ""))
    except Exception as e: results.append((name, False, f"{e.__class__.__name__}: {str(e)[:300]}"))

J = lambda p, js: p.evaluate(js)
def admin(p): p.check("#jr-admin"); p.wait_for_timeout(150)
def sections_of(p, hq, name):
    return J(p, f"(()=>{{const d=JURIS.doc;const b=d.branches.find(b=>b.hq==='{hq}'&&b.name==='{name}');return d.sections.filter(s=>s.owner===b.id).map(s=>s.id)}})()")
def bid(p, hq, name): return J(p, f"JURIS.doc.branches.find(b=>b.hq==='{hq}'&&b.name==='{name}').id")
def click_sec(p, sid, shift=False):
    J(p, f"(()=>{{const pl=JurisdictionUI._state().polys['{sid}'];pl.fire('click',{{latlng:pl.getCenter(),originalEvent:{{shiftKey:{str(shift).lower()}}}}})}})()"); p.wait_for_timeout(120)

def t_tab_loads(b):
    p = open_tab(b)
    check(J(p, "Object.keys(JurisdictionUI._state().polys).length") == J(p, "JURIS.doc.sections.length") > 600, "구간 선이 그려지지 않음")
    check(p.locator(".jr-br").count() == 59, f"지사 수 {p.locator('.jr-br').count()}")
    check(p.locator(".jr-hqname").count() == 9, "본부 9개")
    check(p.locator("#jr-add").is_hidden(), "보기 모드에서 신설 버튼이 보임")
    check(p.locator("#jr-selbar").is_hidden(), "보기 모드에서 이동 바가 보임")
    # 기존 화면 영향 없음
    p.click(".tab-btn[data-tab=map]"); p.wait_for_timeout(300)
    check(p.locator("#statBranch").inner_text() == "59", "기존 통계")
    p.click(".tab-btn[data-tab=snowtable]"); p.wait_for_timeout(300)
    check(p.locator("#snowTableWrap tr").count() > 30, "연도별 표")

def t_view_mode_cannot_select(b):
    p = open_tab(b); sid = sections_of(p, "강원", "춘천")[0]
    click_sec(p, sid)
    check(J(p, "Object.keys(JurisdictionUI._state().selected).length") == 0, "보기 모드에서 선택됨")
    check(p.locator("#jr-selbar").is_hidden(), "이동 바")

def t_move_preview_save(b):
    p = open_tab(b); admin(p)
    secs = sections_of(p, "강원", "춘천")[:2]; to = bid(p, "강원", "홍천")
    click_sec(p, secs[0]); click_sec(p, secs[1])
    check(p.locator("#jr-selbar").is_visible(), "이동 바가 안 보임")
    check("2개 구간" in p.locator("#jr-selbar").inner_text(), p.locator("#jr-selbar").inner_text())
    p.select_option("#jr-dest", to); p.click("#jr-move"); p.wait_for_timeout(200)
    check(p.locator(".jr-ev").count() == 1 and "홍천" in p.locator(".jr-ev").first.inner_text(), "변경 대기 표시")
    check(J(p, "Object.keys(JurisdictionUI._state().selected).length") == 0, "선택이 비워지지 않음")
    p.click("#jr-preview"); p.wait_for_timeout(300)
    rows = p.locator(".jr-table tbody tr"); check(rows.count() == 2, f"미리보기 행 {rows.count()}")
    txt = p.locator(".jr-table").inner_text(); check("춘천" in txt and "홍천" in txt, txt)
    check("일부" in p.locator(".jr-dialog").inner_text(), "관측소 목록 부분 경고")
    p.click("#jr-close"); p.wait_for_timeout(100)
    p.fill("#jr-reason", "시험 변경")
    with p.expect_download() as dl: p.click("#jr-save")
    data = json.load(open(dl.value.path(), encoding="utf-8"))
    ev = data["events"][-1]
    check(data["version"] == 1 and ev["t"] == "move" and ev["to"] == to and ev["sections"] == secs and ev.get("note") == "시험 변경" and ev.get("at"), ev)
    # 모두 취소
    p.click("#jr-close"); p.click("#jr-cancel"); p.wait_for_timeout(200)
    check(p.locator(".jr-ev").count() == 0, "모두 취소")

def t_shift_range_select(b):
    p = open_tab(b); admin(p)
    secs = J(p, "(()=>{const d=JURIS.doc;const c=d.sections.filter(s=>s.chain===d.sections[0].chain);return c.map(s=>s.id)})()")
    check(len(secs) >= 4, "연속 구간이 적음")
    click_sec(p, secs[0]); click_sec(p, secs[3], shift=True)
    got = J(p, "Object.keys(JurisdictionUI._state().selected).sort()")
    check(got == sorted(secs[:4]), got)

def t_add_branch_and_move(b):
    p = open_tab(b); admin(p)
    p.click("#jr-add"); p.fill("#jr-newname", "신설시험"); p.select_option("#jr-newhq", "충북"); p.click("#jr-newok"); p.wait_for_timeout(300)
    check(p.locator(".jr-br:has-text('신설시험')").count() == 1, "신설 기관이 목록에 없음")
    check(p.locator(".jr-br:has-text('신설시험') em").count() == 1, "신설 표시")
    sid = sections_of(p, "충북", "엄정")[0]; click_sec(p, sid)
    new_id = J(p, "Object.keys(JurisdictionUI._state().view.state.branches).slice(-1)[0]")
    p.select_option("#jr-dest", new_id); p.click("#jr-move"); p.wait_for_timeout(250)
    check(p.locator(".jr-ev").count() == 2, "이벤트 2건")
    # 중복 이름 거부 (alert 자동 승인)
    p.click("#jr-add"); p.fill("#jr-newname", "춘천"); p.click("#jr-newok"); p.wait_for_timeout(150)
    check(p.locator(".jr-ev").count() == 2, "중복 이름이 추가됨"); p.click("#jr-close")
    # 신설 추가를 취소하면 그 기관으로의 이동도 함께 정리
    p.locator(".jr-x").first.click(); p.wait_for_timeout(250)
    check(p.locator(".jr-ev").count() == 0, f"연쇄 취소 실패 {p.locator('.jr-ev').count()}")

def t_move_branch_hq(b):
    p = open_tab(b); admin(p)
    p.click(".jr-br:has-text('엄정')"); p.wait_for_timeout(200)
    p.select_option("#jr-hq", "강원"); p.wait_for_timeout(250)
    check("엄정" in p.locator(".jr-ev").first.inner_text() and "강원" in p.locator(".jr-ev").first.inner_text(), "본부 이동 표시")
    check(p.locator(".jr-hqname:has-text('강원') ~ .jr-br:has-text('엄정')").count() == 1, "강원 아래로 옮겨지지 않음")

def t_apply_in_browser(b):
    p = open_tab(b); admin(p)
    secs = sections_of(p, "강원", "춘천"); to = bid(p, "강원", "홍천")
    for s in secs: click_sec(p, s)
    p.select_option("#jr-dest", to); p.click("#jr-move"); p.wait_for_timeout(200)
    p.click("#jr-apply"); p.wait_for_load_state("load")
    p.wait_for_function("window.JurisdictionUI && JurisdictionUI._state().inited", timeout=60000)
    n = J(p, "(HIERARCHY.hq.find(h=>h.name==='강원').branches.find(x=>x.name==='춘천')||{}).routeSegments.length")
    check(n == 0, f"춘천 관할이 비워지지 않음 ({n})")
    p.click(".tab-btn[data-tab=jurisdiction]"); p.wait_for_timeout(500)
    check("임시 적용" in p.locator("#jr-pending").inner_text(), "임시 적용 안내")
    check(p.locator("#statBranch").inner_text() == "59", "지사 수는 그대로")


def t_border_on_click_view_mode(b):
    p = open_tab(b); sid = sections_of(p, "강원", "춘천")[0]
    click_sec(p, sid)                                     # 보기 모드(관리자 모드 끔)
    check(J(p, "JurisdictionUI._state().clicked") == sid, "클릭한 구간이 기억되지 않음")
    check(J(p, "JurisdictionUI._state().casing.getLayers().length") == 2, "이중 테두리(바깥 띠+테두리) 2겹")
    check(J(p, "JurisdictionUI._state().ends.getLayers().length") == 2, "시점·종점 표시 2개")
    tips = p.locator(".jr-endtip").all_inner_texts()
    check(len(tips) == 2 and tips[0].startswith("시점") and tips[1].startswith("종점"), tips)
    # 팝업을 닫으면 테두리도 사라짐
    J(p, "JurisdictionUI._state().map.closePopup()"); p.wait_for_timeout(150)
    check(J(p, "JurisdictionUI._state().casing.getLayers().length") == 0, "팝업을 닫아도 테두리가 남음")

def t_border_contrast_all_colors(b):
    p = open_tab(b)
    res = J(p, """(() => { const U = JurisdictionUI, colors = [...new Set(Object.values(U._state().polys).map(pl => pl.options.color))];
      return colors.map(c => { const cc = U._casing(c); return [U._contrast(c, cc.casing), U._contrast(cc.casing, cc.outer)]; }); })()""")
    check(len(res) >= 30, f"색 {len(res)}개")
    worst = min(r[0] for r in res)
    check(worst >= 3.0, f"선과 테두리의 대비가 너무 낮은 색이 있음 (최저 {worst:.2f}, 그래픽 기준 3:1)")
    check(min(r[1] for r in res) >= 15, "테두리와 바깥 띠의 대비")
    kinds = {J(p, f"JurisdictionUI._casing('hsl({h},72%,{l}%)').casing") for h in (10, 60, 120, 200, 280) for l in (26, 36, 50, 58)}
    check(kinds == {"#0b130e", "#ffffff"}, f"밝은 색엔 어두운 테두리, 어두운 색엔 흰 테두리가 모두 쓰여야 함: {kinds}")

def t_admin_click_has_border(b):
    p = open_tab(b); admin(p)
    secs = sections_of(p, "강원", "춘천")[:3]
    for s in secs: click_sec(p, s)
    check(J(p, "JurisdictionUI._state().casing.getLayers().length") == 6, "선택 3개 × 2겹")
    check(J(p, "JurisdictionUI._state().clicked") == secs[2], "마지막으로 누른 구간")
    click_sec(p, secs[2])                                   # 다시 누르면 해제
    check(J(p, "JurisdictionUI._state().casing.getLayers().length") == 4, "해제하면 테두리도 사라짐")

def t_pick_destination_on_map(b):
    p = open_tab(b); admin(p)
    src = sections_of(p, "강원", "춘천")[:2]; dst = sections_of(p, "강원", "홍천")[0]; to = bid(p, "강원", "홍천")
    for s in src: click_sec(p, s)
    p.click("#jr-pick"); p.wait_for_timeout(150)
    check(p.locator("#jr-pickbar").is_visible(), "안내 바가 안 보임")
    check(J(p, "JurisdictionUI._state().map.getContainer().style.cursor") == "crosshair", "커서")
    click_sec(p, dst); p.wait_for_timeout(250)                # 홍천 구간을 지도에서 클릭
    ev = J(p, "JurisdictionUI._state().pending")
    check(len(ev) == 1 and ev[0]["t"] == "move" and ev[0]["to"] == to and ev[0]["sections"] == src, ev)
    check(p.locator("#jr-pickbar").is_hidden(), "안내 바가 닫히지 않음")
    check(J(p, "Object.keys(JurisdictionUI._state().selected).length") == 0, "선택이 비워지지 않음")
    # 같은 지사 구간을 찍으면 거부, Esc 로 취소
    for s in sections_of(p, "강원", "원주")[:1]: click_sec(p, s)
    p.click("#jr-pick"); click_sec(p, sections_of(p, "강원", "원주")[1]); p.wait_for_timeout(150)
    check(len(J(p, "JurisdictionUI._state().pending")) == 1, "같은 지사로 이동이 추가됨")
    p.keyboard.press("Escape"); p.wait_for_timeout(100)
    check(J(p, "JurisdictionUI._state().pick") is False and p.locator("#jr-pickbar").is_hidden(), "Esc 취소")

def t_popup_button_starts_edit(b):
    p = open_tab(b); sid = sections_of(p, "강원", "춘천")[0]
    J(p, f"(()=>{{const pl=JurisdictionUI._state().polys['{sid}'];pl.fire('click',{{latlng:pl.getCenter(),originalEvent:{{}}}});pl.openPopup(pl.getCenter())}})()"); p.wait_for_timeout(250)
    check(p.locator(".jr-popbtn").count() == 1, "보기 모드 팝업에 [이 구간 옮기기]가 없음")
    p.click(".jr-popbtn"); p.wait_for_timeout(250)
    check(p.locator("#jr-admin").is_checked(), "관리자 모드로 바뀌지 않음")
    check(J(p, "Object.keys(JurisdictionUI._state().selected)") == [sid], "구간이 선택되지 않음")
    check(p.locator("#jr-selbar").is_visible(), "이동 바가 안 보임")

TESTS = [t_tab_loads, t_view_mode_cannot_select, t_move_preview_save, t_shift_range_select, t_add_branch_and_move, t_move_branch_hq, t_apply_in_browser,
         t_border_on_click_view_mode, t_border_contrast_all_colors, t_admin_click_has_border, t_pick_destination_on_map, t_popup_button_starts_edit]
if __name__ == "__main__":
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        for fn in TESTS: run(fn.__name__, fn, b)
        b.close()
    server.shutdown()
    ok = sum(1 for _, o, _ in results if o)
    for n, o, m in results: print(("PASS " if o else "FAIL ") + n + ("" if o else "  → " + m))
    real = [e for e in errors if "Leaflet" not in e]
    if real: print("\n페이지 오류:", *real[:6], sep="\n  ")
    print(f"\n{ok}/{len(results)} 통과")
    sys.exit(0 if ok == len(results) and not real else 1)
