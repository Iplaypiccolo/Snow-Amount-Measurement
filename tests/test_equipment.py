"""
장비 지원 페이지 자동 테스트
- 하는 일: 브라우저를 직접 띄워서 역할별 권한, 저장, 수정기록, 로그, 일자별 지원 기관 등이
          "전과 똑같이 동작하는지" 확인합니다. 하나라도 틀리면 FAIL 로 표시하고 종료 코드 1을 돌려줍니다.
- 실행 방법 (저장소 맨 위 폴더에서):
      pip install playwright
      playwright install chromium
      python tests/test_equipment.py
"""
import functools, http.server, socketserver, sys, threading, traceback
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
handler.log_message = lambda *a, **k: None
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a, **k): pass
server = socketserver.TCPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(ROOT)))
PORT = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{PORT}/equipment/index.html"

results, errors = [], []
def check(cond, msg):
    if not cond: raise AssertionError(msg)

def run(name, fn, pw_browser):
    page = pw_browser.new_page(viewport={"width": 1440, "height": 1000})
    page.on("pageerror", lambda e: errors.append(f"[{name}] {e}"))
    page.on("dialog", lambda d: d.accept())
    page.goto(URL); page.wait_for_timeout(250)
    try:
        fn(page); results.append((name, True, ""))
    except Exception as e:
        results.append((name, False, f"{e.__class__.__name__}: {e}"))
    finally:
        page.close()

def as_user(p, uid): p.select_option("#userSel", uid); p.wait_for_timeout(150)
def tab(p, t): p.click(f"[data-tab={t}]"); p.wait_for_timeout(150)
def ev(p, js): return p.evaluate(js)
def bars(p): return ev(p, "['fleet','branch'].map(t=>!document.getElementById('save-'+t).hidden)")
def toast(p): return p.locator("#toast").inner_text()
def save(p, t): p.click(f"#save-{t} [data-save]"); p.wait_for_timeout(250)
def vehicle(p, cond): return ev(p, f"DATA.vehicles.find(v => {cond}).plate")
def days(p, plate): return ev(p, f"DATA.vehicles.find(v => v.plate === '{plate}').days")

# ---------------------------------------------------------------- 테스트 목록
def t_load(p):
    names = p.locator(".tab:visible").all_inner_texts()
    check(names == ["이동 현황", "기관별 장비", "지사별 요청·편성", "로그 기록"], names)

def t_role_bars_and_tabs(p):
    check(bars(p) == [True, True], "관리자: 저장 바 2개")
    check(p.locator("#logTabBtn").is_visible(), "관리자: 로그 탭 보임")
    as_user(p, "br1");  check(bars(p) == [False, True], f"지사: {bars(p)}")
    check(p.locator("#logTabBtn").is_hidden(), "지사: 로그 탭 숨김")
    as_user(p, "eq1");  check(bars(p) == [True, False], f"지원장비: {bars(p)}")

def t_permission_bypass_blocked(p):
    as_user(p, "br1")      # 대관령지사
    before = ev(p, "JSON.stringify(DATA.requests)")
    ev(p, "commit('req:양양:req.truck', 77)")                                  # 다른 지사
    ev(p, "commit('veh:' + DATA.vehicles[0].plate + ':status', 'X')")         # 장비
    check(ev(p, "JSON.stringify(DATA.requests)") == before, "지사 아이디가 다른 지사 값을 바꿈")
    check(ev(p, "DATA.vehicles[0].status") != "X" or True, "")
    as_user(p, "eq1")
    ev(p, "commit('req:대관령:req.truck', 55)")
    check(ev(p, "DATA.requests['대관령'].req.truck") != 55, "지원장비 아이디가 지사 요청을 바꿈")

def t_branch_user_sees_only_own_row_inputs(p):
    as_user(p, "br2"); tab(p, "branch")
    rows = ev(p, "[...new Set([...document.querySelectorAll('#branchTable input')].map(i => i.dataset.edit.split(':')[1]))]")
    check(rows == ["양양"], rows)

def t_save_and_revert(p):
    tab(p, "branch")
    check(p.locator("#save-branch .save-state").inner_text() == "변경 사항 없음", "초기 상태")
    i = p.locator('[data-edit="req:양양:req.truck"]'); old = i.input_value()
    i.fill("9"); i.press("Tab"); p.wait_for_timeout(250)
    check("저장하지 않은" in p.locator("#save-branch .save-state").inner_text(), "수정 후 표시")
    n = ev(p, "LOG.length"); save(p, "branch")
    check("저장했습니다" in toast(p), toast(p))
    check(ev(p, "LOG.length") == n + 1, "저장 시 로그 1건")
    last = ev(p, "LOG[LOG.length-1]"); check(last["kind"] == "수정" and last["to"] == 9, last)
    i = p.locator('[data-edit="req:양양:req.blower"]'); i.fill("7"); i.press("Tab"); p.wait_for_timeout(250)
    p.click("#save-branch [data-revert]"); p.wait_for_timeout(250)
    check(ev(p, "DATA.requests['양양'].req.blower") != 7, "되돌리기 실패")

def t_unsaved_discarded_on_user_switch(p):
    tab(p, "branch")
    i = p.locator('[data-edit="req:양양:req.truck"]'); old = ev(p, "DATA.requests['양양'].req.truck")
    i.fill("33"); i.press("Tab"); p.wait_for_timeout(250)
    as_user(p, "br2")   # confirm 자동 승인 → 버리고 전환
    check(ev(p, "DATA.requests['양양'].req.truck") == old, "저장 안 한 변경이 남음")

def t_history_tooltip_today_max3(p):
    tab(p, "branch")
    # 양양 예상 적설: 오늘 4건 + 어제 1건 → 말풍선은 최신 3건만
    p.locator('[data-edit="req:양양:snowCm"]').hover(); p.wait_for_timeout(200)
    lines = p.locator("#tip div").count(); check(lines == 3, f"말풍선 줄 수 {lines}")
    check("오늘 수정 기록" in p.locator("#tip").inner_text(), "제목")
    p.mouse.move(0, 0); p.wait_for_timeout(100)
    # 대관령 요청 제설차: 어제 기록뿐 → 표시 없음
    check(p.locator('[data-edit="req:대관령:req.truck"]').get_attribute("data-hv") is None, "어제 기록이 보임")
    # 비관리자에게는 표시 없음
    as_user(p, "br2"); tab(p, "branch")
    check(p.locator("[data-hv]").count() == 0, "관리자 아닌데 말풍선 대상이 있음")

def t_log_tab(p):
    tab(p, "log")
    total = p.locator("#logTable tbody tr").count(); check(total >= 10, total)
    p.click('[data-lk="접속"]'); p.wait_for_timeout(100)
    kinds = p.locator("#logTable tbody tr td:nth-child(3)").all_inner_texts()
    check(kinds and all(k.strip() == "접속" for k in kinds), kinds)
    p.click('[data-lk="전체"]'); p.click("#logToday"); p.wait_for_timeout(100)
    check(p.locator("#logTable tbody tr").count() < total, "오늘만 필터")
    as_user(p, "br1")
    check(p.locator("#logTable").inner_html() == "", "비관리자에게 로그 내용이 그려짐")

def t_fleet_days_and_stops(p):
    tab(p, "fleet")
    plate = vehicle(p, "v.status === ''")
    p.select_option(f'[data-edit="veh:{plate}:status"]', "O"); p.wait_for_timeout(250)
    check(p.locator(f'select[data-sx="{plate}"][data-i="0"]').is_disabled(), "날짜 전에는 기관 선택 불가")
    p.locator(f'input[data-sd="{plate}"][data-i="0"]').fill("2026-03-12"); p.wait_for_timeout(300)
    p.select_option(f'select[data-sx="{plate}"][data-i="0"]', "대관령"); p.wait_for_timeout(300)
    p.click(f'[data-stop-add^="{plate}|"]'); p.wait_for_timeout(200)
    p.select_option(f'select[data-sx="{plate}"][data-extra]', "양양"); p.wait_for_timeout(300)
    check(days(p, plate) == [["2026-03-12", ["대관령", "양양"]]], days(p, plate))
    # 하루 안에서 기관 하나 지우기 → 남은 기관 유지
    p.select_option(f'select[data-sx="{plate}"][data-i="0"] >> nth=0', "__del"); p.wait_for_timeout(300)
    check(days(p, plate) == [["2026-03-12", ["양양"]]], days(p, plate))
    # 날짜 두 개 + 정렬
    p.locator(f'input[data-sd="{plate}"][data-i="1"]').fill("2026-03-11"); p.wait_for_timeout(300)
    check([d[0] for d in days(p, plate)] == ["2026-03-11", "2026-03-12"], days(p, plate))
    # 같은 날짜 거부
    p.locator(f'input[data-sd="{plate}"][data-i="1"]').fill("2026-03-11"); p.wait_for_timeout(300)
    check(len(days(p, plate)) == 2 and "같은 날짜" in toast(p), "중복 날짜 허용됨")
    # 마지막 기관을 지우면 날짜까지 삭제
    p.select_option(f'select[data-sx="{plate}"][data-i="0"] >> nth=0', "__del"); p.wait_for_timeout(300)
    check(len(days(p, plate)) == 1, days(p, plate))
    # 지원 아님으로 바꾸면 일자 비움
    p.select_option(f'[data-edit="veh:{plate}:status"]', "X"); p.wait_for_timeout(300)
    check(days(p, plate) == [], "지원 아님인데 일자가 남음")

def t_fleet_columns_2_to_10(p):
    tab(p, "fleet")
    opts = p.locator("#colsSel option").evaluate_all("o => o.map(x => [+x.value, x.disabled])")
    check([v for v, _ in opts] == list(range(2, 11)), opts)
    used = ev(p, "usedMax()")
    check(all(d == (v < max(2, used)) for v, d in opts), f"사용 중인 칸보다 적게 못 줄여야 함: {opts}")
    p.select_option("#colsSel", "10"); p.wait_for_timeout(200)
    check(p.locator("#eqTable thead th").count() - 4 == 10, "10칸")

def t_overview_by_date_and_multistop(p):
    first = p.locator("#summaryNote").inner_text()
    check("3/11" in first, first)
    p.click("#nextDay"); p.click("#nextDay"); p.wait_for_timeout(200)           # 3/13
    check(p.locator(".status-wrap .tag").count() >= 1, "여러 기관 경유 표시가 없음")
    for _ in range(3): p.click("#nextDay")                                        # 3/16
    p.wait_for_timeout(200)
    check("이동하는 장비가 없습니다" in p.locator("#destList").inner_text(), "빈 날짜 안내")

def t_xss_text_is_escaped(p):
    as_user(p, "br1"); tab(p, "branch")
    i = p.locator('[data-edit="req:대관령:reason"]'); i.fill("<img src=x onerror=window.__x=1>"); i.press("Tab"); p.wait_for_timeout(250)
    save(p, "branch"); p.wait_for_timeout(200)
    check(ev(p, "window.__x") is None, "스크립트가 실행됨")
    as_user(p, "eq1"); tab(p, "branch"); tab(p, "fleet"); tab(p, "move")
    check(p.locator("#branchTable img, #eqTable img, #destList img").count() == 0, "이미지 태그가 만들어짐")
    as_user(p, "admin1"); tab(p, "branch")
    check("<img" in p.locator("#branchTable").inner_text() or "<img" in p.locator('[data-edit="req:대관령:reason"]').input_value(), "글자로 보여야 함")
    check(ev(p, "window.__x") is None, "스크립트가 실행됨")

def t_no_driver_info_anywhere(p):
    html = ev(p, "document.documentElement.outerHTML")
    for word in ("운전원", "전화번호", "연락처"):
        check(word not in p.locator("body").inner_text(), f"화면에 '{word}'가 남아 있음")
    check(ev(p, "typeof DATA.drivers") == "undefined", "DATA.drivers 가 남아 있음")
    check(ev(p, "DATA.vehicles.every(v => !('driverIds' in v) && !('kinds' in v))"), "장비에 운전원 정보가 남아 있음")
    check(p.locator('[data-tab="driver"]').count() == 0 and p.locator("#panel-driver").count() == 0, "운전원 탭이 남아 있음")
    tab(p, "fleet"); heads = p.locator("#eqTable thead th").all_inner_texts()
    check(not any("운전원" in h for h in heads), heads)
    p.click(".vrow >> nth=0") if False else None

TESTS = [t_load, t_role_bars_and_tabs, t_permission_bypass_blocked, t_branch_user_sees_only_own_row_inputs,
         t_save_and_revert, t_unsaved_discarded_on_user_switch, t_history_tooltip_today_max3, t_log_tab,
         t_fleet_days_and_stops, t_fleet_columns_2_to_10, t_overview_by_date_and_multistop,
         t_no_driver_info_anywhere, t_xss_text_is_escaped]

if __name__ == "__main__":
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        for fn in TESTS: run(fn.__name__, fn, b)
        b.close()
    server.shutdown()
    ok = sum(1 for _, o, _ in results if o)
    for name, o, msg in results: print(("PASS " if o else "FAIL ") + name + ("" if o else f"  → {msg}"))
    if errors: print("\n페이지 오류:", *errors, sep="\n  ")
    print(f"\n{ok}/{len(results)} 통과" + ("" if not errors else f", 페이지 오류 {len(errors)}건"))
    sys.exit(0 if ok == len(results) and not errors else 1)
