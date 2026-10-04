"""
장비 지원 페이지 자동 테스트 (샘플 모드 ?sample=1 — 서버 없이 같은 권한 규칙을 흉내 내는 샘플 자료로)
- 하는 일: 브라우저를 직접 띄워서 권한별 화면, 날짜별 경로 확정·기록 유지, 기준일자·확정 지사, 이동 현황 계층, 수정 기록 말풍선 등을 확인합니다.
  하나라도 틀리면 FAIL 로 표시하고 종료 코드 1을 돌려줍니다.
- 실행 방법 (저장소 맨 위 폴더에서):
      pip install playwright
      playwright install chromium
      python tests/test_equipment.py
"""
import functools, http.server, socketserver, sys, threading
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a, **k): pass
# 여러 요청을 동시에 처리(한 번에 하나씩이면 큰 JSON 을 보내는 동안 스크립트 요청이 밀려 시험이 시간 초과로 흔들림)
socketserver.ThreadingTCPServer.daemon_threads = True
server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(ROOT)))
PORT = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{PORT}/equipment/index.html?sample=1"

results, errors = [], []
def check(cond, msg):
    if not cond: raise AssertionError(msg)

def run(name, fn, pw_browser):
    page = pw_browser.new_page(viewport={"width": 1440, "height": 1000})
    page.on("pageerror", lambda e: errors.append(f"[{name}] {e}"))
    page.on("dialog", lambda d: d.accept())
    page.goto(URL); page.wait_for_selector("#matrix tbody tr", timeout=15000)
    try:
        fn(page); results.append((name, True, ""))
    except Exception as e:
        results.append((name, False, f"{e.__class__.__name__}: {e}"))
    finally:
        page.close()

def ev(p, js): return p.evaluate(js)
def as_user(p, uid): p.select_option("#userSel", uid); p.wait_for_timeout(200)
def tab(p, t): p.click(f"[data-tab={t}]"); p.wait_for_timeout(150)
def day(p, n): return ev(p, f"addDays(todayISO(), {n})")
def go_date(p, iso): p.fill("#dateInput", iso); p.dispatch_event("#dateInput", "change"); p.wait_for_timeout(200)
def toast(p): return p.locator("#toast").inner_text()
def route(p, vid, d): return ev(p, f"routeOf('{d}', '{vid}').map(bn)")
def rsel(vid, d, j=0): return f"select[data-fk='r:{d}:{vid}:{j}']"
def confirm_fleet(p): p.click("#save-fleet [data-save]"); p.wait_for_timeout(300)
def save_branch(p): p.click("#save-branch [data-save]"); p.wait_for_timeout(300)
def rows(p): return [t.split("\t")[0].strip() for t in p.locator("#matrix tbody tr").all_inner_texts()]
def bid(p, name): return ev(p, f"S.branches.find(b => b.name === '{name}').id")

# ---------------------------------------------------------------- 테스트 목록
def t_load(p):
    names = p.locator(".tab:visible").all_inner_texts()
    check(names == ["이동 현황", "기관별 장비", "지사별 요청·편성", "로그 기록"], names)
    check(p.locator("#dateInput").input_value() == day(p, 0), "오늘 날짜로 시작")
    check(not p.locator("#loading").is_visible(), "불러오는 중 표시가 사라져야 함")

def t_move_hierarchy(p):
    """이동 현황: 본부 → 지사 계층, 그날 지원받는 지사만, 본부 줄은 장비 1대를 한 번만 셈"""
    check(rows(p) == ["강원\n본부", "└대관령", "└양양", "충북\n본부", "└엄정"], rows(p))
    hq = p.locator("#matrix tbody tr.hqrow").first.locator("td").all_inner_texts()
    check(hq[-1].strip() == "22", f"강원 합계 22대(대관령 11 + 양양 11, 겹치는 장비 없음): {hq}")
    go_date(p, day(p, 2))            # 모레: V001 이 대관령 → 양양 두 곳
    t = p.locator("#matrix tbody tr.hqrow").first.locator("td").last.inner_text().strip()
    b = [x.locator("td").last.inner_text().strip() for x in p.locator("#matrix tbody tr.brrow").all()]
    check(int(t) == int(b[0]) + int(b[1]) - 1, f"두 곳을 들른 장비는 본부 합계에서 1대로: {t} vs {b}")
    go_date(p, day(p, -7))
    check(rows(p) == ["강원\n본부", "└춘천", "충북\n본부", "└엄정"], rows(p))
    go_date(p, day(p, 30)); check("이동하는 장비가 없습니다" in p.locator("#matrix").inner_text(), "빈 날")
    check(p.locator("#destList .hq-head").count() == 0, "카드 없음")

def t_dest_order_and_day_tag(p):
    heads = p.locator("#destList .hq-head").all_inner_texts(); check(heads == ["강원본부", "충북본부"], heads)
    names = p.locator("#destList .dest-name").evaluate_all("hs => hs.map(h => h.childNodes[0].textContent.trim())"); check(names == ["대관령", "양양", "엄정"], names)
    v1 = p.locator(".vrow[data-vid=V001]").first.inner_text(); check("1일차 / 5일" in v1, v1)
    go_date(p, day(p, 1)); check("2일차 / 5일" in p.locator(".vrow[data-vid=V001]").first.inner_text(), "다음 날 2일차")
    p.click("[data-type='제설기']"); check(all("제설기" in x for x in p.locator("#destList .vrow").all_inner_texts()), "장비 거르기")

def t_route_choices_confirmed_only(p):
    """경로의 피지원 지사는 고른 기준일자에서 편성이 확정된 지사만(춘천은 요청만 하고 미확정)"""
    tab(p, "fleet"); d0 = day(p, 0)
    opts = p.locator(rsel("V004", d0) + " option:not([disabled])").all_inner_texts()
    check([o for o in opts if o not in ("지사 선택", "지우기")] == ["대관령", "양양", "엄정"], opts)
    old = ev(p, "S.rounds.find(r => r.start_date === addDays(todayISO(), -7)).id")
    p.select_option("#roundSelFleet", str(old)); p.wait_for_timeout(300)
    check(p.locator("#day1In").input_value() == day(p, -7), "기준일자를 고르면 지원일 1도 그 날짜로")
    opts = p.locator(rsel("V004", day(p, -7)) + " option").all_inner_texts()
    check([o for o in opts if o not in ("지사 선택", "지우기")] == ["춘천", "엄정"], opts)
    check(p.locator(rsel("V024", day(p, -7))).input_value() == bid(p, "춘천"), "지난 기록이 그대로 보임")

def t_confirm_keeps_history(p):
    """오늘 다른 지사로 확정해도 지난 날짜 경로는 남는다 — (날짜, 장비)마다 따로 저장"""
    tab(p, "fleet"); d0 = day(p, 0)
    p.select_option(rsel("V005", d0), bid(p, "대관령")); p.wait_for_timeout(200)
    check(p.locator(rsel("V005", d0)).evaluate("e => e.closest('.slot').classList.contains('changed')"), "확정 전 칸 표시")
    check("경로 1칸" in p.locator("#save-fleet .save-state").inner_text(), p.locator("#save-fleet .save-state").inner_text())
    confirm_fleet(p); check("확정했습니다" in toast(p), toast(p))
    check(ev(p, "S.draft.size") == 0 and route(p, "V005", d0) == ["대관령"], "확정 후 값")
    tab(p, "move"); p.click(".vrow[data-vid=V005]"); p.wait_for_selector("ol.vhist li")
    hist = p.locator("ol.vhist").inner_text(); check("엄정" in hist and "대관령" in hist and hist.count("\n") >= 2, hist)
    p.click("#sheetClose")
    go_date(p, day(p, -7)); check(p.locator(".vrow[data-vid=V005]").count() == 1, "1주 전 이동 기록 그대로")

def t_day1_header_and_columns(p):
    tab(p, "fleet")
    heads = lambda: [h.split("\n")[0] for h in p.locator("#eqTable thead th.dayh").all_inner_texts()]
    check(heads() == ["지원일 1", "지원일 2", "지원일 3", "지원일 4"], heads())
    check(p.locator("#eqTable select[data-rv='V001']").count() >= 4, "장비마다 날짜 칸")
    p.fill("#day1In", day(p, 2)); p.dispatch_event("#day1In", "change"); p.wait_for_timeout(250)
    check(p.locator(rsel("V001", day(p, 2), 0)).input_value() == bid(p, "대관령") and p.locator(rsel("V001", day(p, 2), 1)).input_value() == bid(p, "양양"), "지원일 1을 옮기면 모든 칸이 그 날짜부터")
    check(p.locator("#eqTable thead th.dayh").nth(1).inner_text().find(ev(p, f"fmtMD('{day(p, 3)}')")) >= 0, "지원일 2 제목 = 다음 날")
    p.select_option("#colsSel", "10"); p.wait_for_timeout(200); check(len(heads()) == 10, "10칸")
    p.select_option("#colsSel", "2"); p.wait_for_timeout(200); check(len(heads()) == 2, "2칸")
    as_user(p, "eq-sg"); tab(p, "fleet")
    check(p.locator("#day1In").count() == 0 and "지원일 1" in p.locator("#eqTable thead").inner_text(), "지원장비 계정은 지원일 1 날짜를 못 바꿈(보기만)")

def t_multi_stop_add_and_delete(p):
    tab(p, "fleet"); d1 = day(p, 1)
    p.click(f"[data-stop-add='{d1}|V002']"); p.wait_for_timeout(150)
    p.select_option(f"select[data-fk='rn:{d1}:V002:1']", bid(p, "양양")); p.wait_for_timeout(200)
    check(route(p, "V002", d1) == ["대관령", "양양"], route(p, "V002", d1))
    p.select_option(rsel("V002", d1, 0), "__del"); p.wait_for_timeout(200)
    check(route(p, "V002", d1) == ["양양"], "지우기")
    p.select_option(rsel("V002", d1, 0), "__del"); p.wait_for_timeout(200)
    check(route(p, "V002", d1) == [] and ev(p, f"S.draft.get('{d1}|V002').length") == 0, "모두 지우면 빈 경로(확정하면 그 날짜 줄 삭제)")
    confirm_fleet(p); check(ev(p, f"S.routes.has('{d1}|V002')") is False, "확정 후 서버에서도 삭제")

def t_status_maintenance(p):
    tab(p, "fleet"); d0 = day(p, 0)
    opts = p.locator("[data-vs=V002] option").all_inner_texts(); check(opts == ["미정", "지원", "지원 불가", "정비중"], opts)
    p.select_option("[data-vs=V002]", "M"); p.wait_for_timeout(250)
    check("경로를 비웠습니다" in toast(p) and route(p, "V002", d0) == [], "정비중이면 오늘 이후 경로를 비움")
    check(p.locator(rsel("V002", d0)).is_disabled(), "정비중이면 경로 입력 잠금")
    check("정비중" in p.locator(".org").first.inner_text(), "기관 요약에 정비중")
    p.click("#save-fleet [data-revert]"); p.wait_for_timeout(200)
    check(route(p, "V002", d0) == ["대관령"] and p.locator("[data-vs=V002]").input_value() == "O", "되돌리기")

def t_reset_button(p):
    tab(p, "fleet"); p.click("[data-fo='서울경기']"); p.wait_for_timeout(150)
    p.click("#fleetReset"); p.wait_for_timeout(250)
    sg = ev(p, "S.vehicles.filter(v => v.org === '서울경기').map(v => v.id)")
    check(all(ev(p, f"windowDates().every(d => routeOf(d, '{v}').length === 0) && vval(vehById('{v}'), 'status') === ''") for v in sg), "서울경기 장비 칸이 모두 비워짐")
    check(route(p, "V014", day(p, 0)) == ["양양"], "보이지 않는(다른 기관) 장비는 그대로")
    check(ev(p, "S.routes.get(rk(todayISO(), 'V001'))") is not None, "확정 전에는 서버 값 그대로")
    p.click("#save-fleet [data-revert]"); p.wait_for_timeout(200); check(route(p, "V001", day(p, 0)) == ["대관령"], "되돌리기로 복구")

def t_permissions_equip_own(p):
    """지원장비(충북): 자기 기관 장비 추가·도공번호·지원 여부만. 경로·삭제·지원일 1·초기화는 관리자. 지사는 아무것도 못 고침"""
    as_user(p, "eq-cb"); tab(p, "fleet")
    check(p.locator("#logTabBtn").is_hidden(), "로그 탭 숨김")
    check(p.locator("[data-vs=V013]").count() == 1 and p.locator("[data-vp=V013]").count() == 1 and p.locator("[data-vs=V001]").count() == 0, "충북 장비의 도공번호·지원 여부만")
    check(p.locator("select[data-rv]").count() == 0, "경로 칸은 보기만")
    check(p.locator("[data-vdel]").count() == 0 and p.locator("#day1In").count() == 0 and p.locator("#fleetReset").count() == 0, "삭제·지원일 1·초기화 없음")
    check(p.locator("#nvOrg option").all_inner_texts() == ["충북"], "장비 추가는 자기 기관만")
    p.fill("#nvPlate", "충북-950"); p.click("#vehAdd"); p.wait_for_timeout(250); check("추가했습니다" in toast(p), toast(p))
    p.select_option("[data-vs=V013]", "M"); p.wait_for_timeout(150); confirm_fleet(p); check("확정했습니다" in toast(p) and ev(p, "vehById('V013').status") == "M", toast(p))
    check(route(p, "V014", day(p, 0)) == ["양양"], "지원장비가 지원 여부를 바꿔도 경로는 그대로(경로는 관리자)")
    ev(p, f"S.draft.set(rk('{day(p, 3)}', 'V014'), ['{bid(p, '양양')}']), updateSavebars()"); confirm_fleet(p)   # 화면을 우회해 경로를 보내도 서버가 막음
    check("권한이 없습니다" in toast(p), toast(p))
    as_user(p, "br1"); tab(p, "fleet")
    check(p.locator("#eqTable select, #eqTable input, #vehAdd, #fleetReset").count() == 0 and not p.locator("#save-fleet").is_visible(), "지사는 기관별 장비에서 아무것도 못 고침")

def t_branch_permissions(p):
    as_user(p, "br1"); tab(p, "branch"); b = bid(p, "대관령")
    ins = set(x.get_attribute("data-rq") for x in p.locator("#branchTable [data-rq]").all())
    check(ins == {b}, f"대관령 행만 입력: {ins}")
    check(p.locator(f"[data-rq={b}][data-f=assigned_truck]").count() == 0 and p.locator("[data-confirm], [data-unconfirm]").count() == 0, "편성·확정은 못 고침")
    check(p.locator("#roundMake").count() == 0, "기준일자 만들기 없음")
    as_user(p, "hq-gw"); tab(p, "branch"); p.click("#onlyActive"); p.wait_for_timeout(150)
    ins = set(x.get_attribute("data-rq") for x in p.locator("#branchTable [data-rq]").all())
    check(ins == set(ev(p, "S.branches.filter(b => b.hq_id === S.hqs.find(h => h.name === '강원').id).map(b => b.id)")), f"강원본부 지사들만: {ins}")
    as_user(p, "viewer"); tab(p, "branch")
    check(p.locator("#branchTable [data-rq], #branchTable [data-arr]").count() == 0 and not p.locator("#save-branch").is_visible() and not p.locator("#save-fleet").is_visible(), "보기 전용")

def t_branch_save_confirm_and_arrive(p):
    tab(p, "branch"); ch, dg = bid(p, "춘천"), bid(p, "대관령")
    h = p.locator(f"[data-arr={dg}][data-part=h] option").all_inner_texts(); m = p.locator(f"[data-arr={dg}][data-part=m] option").all_inner_texts()
    check(h == [f"{i:02d}" for i in range(24)] and m == ["00", "10", "20", "30", "40", "50"], f"시 00~23, 분 10분 단위: {h} {m}")
    p.select_option(f"[data-arr={dg}][data-part=h]", "05"); p.wait_for_timeout(150); p.select_option(f"[data-arr={dg}][data-part=m]", "30"); p.wait_for_timeout(150)
    p.fill(f"[data-rq={ch}][data-f=req_blower]", "3"); p.press(f"[data-rq={ch}][data-f=req_blower]", "Tab"); p.wait_for_timeout(150)
    check("2개 지사" in p.locator("#save-branch .save-state").inner_text(), p.locator("#save-branch .save-state").inner_text())
    check(p.locator(f"[data-confirm={ch}]").inner_text() == "확정" and p.locator(f"[data-unconfirm={dg}]").count() == 1, "확정 버튼 / 확정됨 + 취소")
    p.click(f"[data-confirm={ch}]"); p.wait_for_timeout(300)                  # 확정 = 그 지사 줄을 바로 저장(고친 요청 대수도 함께)
    check("확정했습니다" in toast(p) and ev(p, f"S.reqs['{ch}'].confirmed") is True and ev(p, f"S.reqs['{ch}'].req_blower") == 3 and "1개 지사" in p.locator("#save-branch .save-state").inner_text(), "확정 버튼")
    save_branch(p); check("저장했습니다" in toast(p), toast(p))
    check(ev(p, f"S.reqs['{dg}'].arrive_at") == day(p, 0) + "T05:30" and ev(p, f"S.reqs['{ch}'].confirmed") is True and ev(p, f"S.reqs['{ch}'].req_blower") == 3, "저장값")
    tab(p, "fleet"); opts = p.locator(rsel("V004", day(p, 0)) + " option").all_inner_texts()
    check("춘천" in opts, f"확정한 지사가 경로 선택지에 생김: {opts}")
    tab(p, "move"); check("05:30" in p.locator("#destList").inner_text(), "도착 요청 시각 반영")

def t_round_create(p):
    tab(p, "branch"); d = day(p, 3)
    p.fill("#newRoundDate", d); p.click("#roundMake"); p.wait_for_timeout(300)
    check("기준일자를 만들었습니다" in toast(p), toast(p))
    check(p.locator("#roundSelBranch").input_value() == str(ev(p, "S.round")) and ev(p, "curRound().start_date") == d, "새 기준일자 선택됨")
    check(p.locator("#branchTable tbody tr").count() == 0, "새 기준일자는 요청 없음")
    tab(p, "fleet"); check(p.locator("#day1In").input_value() == d, "지원일 1 = 새 기준일자")
    tab(p, "branch"); p.fill("#newRoundDate", d); p.click("#roundMake"); p.wait_for_timeout(200); check("이미 있습니다" in toast(p), "같은 날짜 거절")

def t_history_tooltip_per_cell(p):
    """말풍선은 그 칸(그 날짜·그 장비 / 그 지사·그 열)의 오늘 수정 기록만"""
    tab(p, "fleet"); d0 = day(p, 0)
    cell = p.locator(rsel("V001", d0)).locator("xpath=ancestor::div[contains(concat(' ',@class,' '),' slot ')]")
    check(cell.get_attribute("data-hv") == f"vehicle_routes:{d0},V001", "오늘 고친 칸에 기록 표시")
    check(p.locator(rsel("V001", day(p, 1))).locator("xpath=ancestor::div[contains(concat(' ',@class,' '),' slot ')]").get_attribute("data-hv") is None, "고치지 않은 칸에는 없음")
    cell.hover(); p.wait_for_timeout(150); t = p.locator("#tip").inner_text()
    check("이 칸의 오늘 수정 기록" in t and t.count("→") == 2 and "양양 → 대관령" in t, t)
    tab(p, "branch"); y = bid(p, "양양")
    p.hover(f"[data-rq={y}][data-f=snow_cm]"); p.wait_for_timeout(150); t = p.locator("#tip").inner_text()
    check(t.count("→") == 3 and "14cm → 15cm" in t and "10cm" not in t, f"최근 3건만: {t}")
    check(p.locator(f"[data-rq={y}][data-f=req_truck]").get_attribute("data-hv") is None, "다른 열에는 없음")
    as_user(p, "br1"); tab(p, "fleet"); check(p.locator("[data-hv]").count() == 0, "log.view 권한이 없으면 기록 표시 없음")

def t_log_tab(p):
    tab(p, "log"); check(p.locator("#logTable tbody tr").count() == 9, p.locator("#logTable tbody tr").count())
    p.click("[data-lk='추가']"); p.wait_for_timeout(100); check(p.locator("#logTable tbody tr").count() == 1, "구분 거르기")
    p.click("[data-lk='전체']"); tab(p, "fleet"); p.select_option(rsel("V002", day(p, 3)), bid(p, "엄정")); confirm_fleet(p)
    tab(p, "log"); first = p.locator("#logTable tbody tr").first.inner_text()
    check("경로" in first and "서울경기-902" in first and "엄정" in first, first)

def t_plate_edit(p):
    tab(p, "fleet"); i = "[data-vp=V004]"
    check(p.locator("#eqTable thead th").first.inner_text() == "도공번호", "제목은 도공번호")
    p.fill(i, "12가3456"); p.press(i, "Tab"); p.wait_for_timeout(200); check("형식" in toast(p) and "서울경기-901" in toast(p) and p.locator(i).input_value() == "서울경기-904", "형식 검사(예시 = 서울경기-901)")
    p.fill(i, "서울경기-901"); p.press(i, "Tab"); p.wait_for_timeout(200); check("이미 있습니다" in toast(p), "중복 검사")
    p.fill(i, "서울경기-999"); p.press(i, "Tab"); p.wait_for_timeout(200); confirm_fleet(p)
    check(ev(p, "vehById('V004').plate") == "서울경기-999", "도공번호 확정")

def t_vehicle_add_delete(p):
    tab(p, "fleet"); p.select_option("#nvOrg", "전북"); check(p.locator("#nvPlate").get_attribute("placeholder") == "전북-901", "예시가 기관에 맞게")
    p.select_option("#nvType", "제설기"); p.fill("#nvPlate", "전북-998"); p.click("#vehAdd"); p.wait_for_timeout(250)
    vid = ev(p, "(S.vehicles.find(v => v.plate === '전북-998') || {}).id"); check("추가했습니다" in toast(p) and vid == "V044", f"장비 추가: {vid}")
    check(p.locator(f"[data-vp={vid}]").input_value() == "전북-998" and p.locator(f"[data-vs={vid}]").input_value() == "", "새 장비 줄(지원 여부 미정)")
    p.click(f"[data-vdel={vid}]"); p.wait_for_timeout(250); check(p.locator(f"[data-vp={vid}]").count() == 0, "장비 삭제")

def t_fleet_header_stays_on_top(p):
    """기관별 장비 표를 스크롤해도 제목 줄이 맨 위에 불투명하게 고정(입력칸·첫 열이 제목 위로 올라오지 않음)"""
    tab(p, "fleet"); p.select_option("#colsSel", "6"); p.wait_for_timeout(200)
    p.evaluate("document.querySelector('#panel-fleet .table-wrap').scrollTop = 400"); p.wait_for_timeout(200)
    r = p.evaluate("""(() => { const w = document.querySelector('#panel-fleet .table-wrap'), top = w.getBoundingClientRect().top;
      const wr = w.getBoundingClientRect();
      return [...document.querySelectorAll('#eqTable thead th')].filter(th => { const b = th.getBoundingClientRect(), cx = b.left + b.width / 2; return cx > wr.left && cx < wr.right - 12; }).map(th => { const b = th.getBoundingClientRect(), el = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return [th.textContent.trim(), Math.round(b.top - top), !!(el && th.contains(el)), getComputedStyle(th).backgroundColor]; }); })()""")
    check(all(abs(x[1]) <= 2 for x in r), f"제목이 맨 위에 붙어 있어야 함: {r}")
    check(all(x[2] for x in r), f"제목 위에 다른 칸이 올라오면 안 됨: {[x[0] for x in r if not x[2]]}")
    check(all(not x[3].endswith(", 0)") and x[3] != "transparent" for x in r), f"제목 배경이 불투명해야 함: {r}")

def t_theme_toggle(p):
    btns = p.locator("[data-theme-set]").all_inner_texts(); check(btns == ["라이트 모드", "다크 모드"], btns)
    p.click("[data-theme-set=dark]"); p.wait_for_timeout(100)
    check(ev(p, "document.documentElement.dataset.theme") == "dark" and p.locator("[data-theme-set=dark]").get_attribute("aria-pressed") == "true", "다크 모드")
    p.reload(); p.wait_for_selector("#matrix tbody tr")
    check(ev(p, "document.documentElement.dataset.theme") == "dark", "다시 열어도 기억")
    p.click("[data-theme-set=light]"); p.wait_for_timeout(100); check(p.locator("[data-theme-set=light]").get_attribute("aria-pressed") == "true", "라이트 모드")

def t_unsaved_guard_on_user_switch(p):
    tab(p, "fleet"); p.select_option(rsel("V002", day(p, 3)), bid(p, "양양")); p.wait_for_timeout(150)
    as_user(p, "eq-sg"); check(ev(p, "S.draft.size") == 0 and route(p, "V002", day(p, 3)) == [], "아이디를 바꾸면 확정 안 한 변경은 버림")
    as_user(p, "admin1"); tab(p, "fleet"); check(p.locator(rsel("V004", day(p, 0))).is_disabled(), "지원 여부가 '지원'이 아니면 경로 칸 잠금")

def t_xss_text_is_escaped(p):
    as_user(p, "br1"); tab(p, "branch"); b = bid(p, "대관령")
    i = p.locator(f"[data-rq={b}][data-f=reason]"); i.fill("<img src=x onerror=window.__x=1>"); i.press("Tab"); p.wait_for_timeout(200)
    save_branch(p); check(ev(p, "window.__x") is None, "스크립트가 실행됨")
    as_user(p, "admin1"); tab(p, "move"); tab(p, "log")
    check(p.locator("#branchTable img, #eqTable img, #destList img, #logTable img").count() == 0, "이미지 태그가 만들어짐")
    check("<img" in p.locator("#destList").inner_text(), "글자로 보여야 함")
    check(ev(p, "window.__x") is None, "스크립트가 실행됨")

def t_no_driver_info_anywhere(p):
    for word in ("운전원", "전화번호", "연락처"):
        check(word not in p.locator("body").inner_text(), f"화면에 '{word}'가 남아 있음")
    check(ev(p, "S.vehicles.every(v => !('driverIds' in v))"), "장비에 운전원 정보가 남아 있음")

def t_typing_then_clicking_next_input_keeps_both(p):
    """(사용자 신고 2026-10-04) 한 칸에 입력하고 바로 다른 칸을 눌러 입력해도 두 값이 모두 남아야 함(예전에는 표 전체를 다시 그려 두 번째 칸이 사라짐)"""
    tab(p, "branch"); p.click("#onlyActive"); p.wait_for_timeout(150); b = bid(p, "인천")
    p.click(f"[data-rq={b}][data-f=req_blower]"); p.keyboard.press("Control+A"); p.keyboard.type("1")
    p.click(f"[data-arr={b}][data-part=d]"); p.keyboard.type("10042026"); p.wait_for_timeout(200)
    p.select_option(f"[data-arr={b}][data-part=h]", "16"); p.wait_for_timeout(150)
    p.click(f"[data-rq={b}][data-f=req_truck]"); p.keyboard.press("Control+A"); p.keyboard.type("2")
    p.click(f"[data-rq={b}][data-f=reason]"); p.keyboard.type("시험"); p.click(f"[data-rq={b}][data-f=snow_cm]"); p.wait_for_timeout(200)
    d = ev(p, f"S.rdraft.get('{b}')")
    check(d.get("req_blower") == 1 and d.get("req_truck") == 2 and d.get("reason") == "시험" and (d.get("arrive_at") or "").endswith("T16:00"), d)
    hq = p.locator("#branchTable tr.hq").first.locator("[data-s=req_blower]").inner_text(); check(hq == "1", f"본부 합계 즉시 반영: {hq}")
    # 기관별 장비: 경로 칸을 고르고 바로 옆 칸을 골라도 둘 다 남음
    tab(p, "fleet"); d0, d3 = day(p, 0), day(p, 3)
    p.select_option(rsel("V002", d3), bid(p, "양양")); p.select_option(rsel("V003", d3), bid(p, "엄정")); p.wait_for_timeout(150)
    check(route(p, "V002", d3) == ["양양"] and route(p, "V003", d3) == ["엄정"], "두 칸 모두")

def t_round_delete(p):
    tab(p, "branch"); r = ev(p, "S.round")
    check(p.locator("#roundDel").count() == 1, "관리자에게 기준일자 삭제 버튼")
    p.click("#roundDel"); p.wait_for_timeout(300)
    check("지웠습니다" in toast(p) and ev(p, f"S.rounds.some(x => x.id === {r})") is False, "삭제")
    check(ev(p, "curRound().start_date") == day(p, -7), "남은 기준일자로 바뀜")
    check(ev(p, "S.routes.size") > 0, "장비 경로 기록은 남음")
    tab(p, "log"); check("기준일자" in p.locator("#logTable tbody tr").first.inner_text(), "삭제 기록")
    as_user(p, "br1"); tab(p, "branch"); check(p.locator("#roundDel").count() == 0, "권한 없으면 버튼 없음")

def t_pending_branches_shown_grey(p):
    """확정 전(요청만) 지사는 경로 목록에 회색(고를 수 없음)으로 보이고, 위 안내에 이름이 나옴"""
    tab(p, "fleet"); opts = p.locator(rsel("V002", day(p, 3)) + " option[disabled]").all_inner_texts()
    check(opts == ["춘천"], opts)
    check("확정 전(요청만): 춘천" in p.locator("#fleetRound").inner_text(), p.locator("#fleetRound").inner_text())

TESTS = [t_load, t_move_hierarchy, t_dest_order_and_day_tag, t_route_choices_confirmed_only, t_confirm_keeps_history, t_day1_header_and_columns,
         t_multi_stop_add_and_delete, t_status_maintenance, t_reset_button, t_permissions_equip_own, t_branch_permissions, t_branch_save_confirm_and_arrive,
         t_round_create, t_history_tooltip_per_cell, t_log_tab, t_plate_edit, t_vehicle_add_delete, t_fleet_header_stays_on_top, t_theme_toggle,
         t_unsaved_guard_on_user_switch, t_xss_text_is_escaped, t_no_driver_info_anywhere,
         t_typing_then_clicking_next_input_keeps_both, t_round_delete, t_pending_branches_shown_grey]

# ---------------------------------------------------------------- 서버 모드(가짜 Supabase, tests/_sb_mock.py) — 실제 로그인 권한·저장 함수 호출
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _sb_mock import Mock, install
SERVER_URL = f"http://127.0.0.1:{PORT}/equipment/index.html"

def server_page(b, mock, user):
    p = b.new_page(viewport={"width": 1440, "height": 1000}); p.on("dialog", lambda d: d.accept())
    p.on("pageerror", lambda e: errors.append(f"[server] {e}"))
    install(p, mock, user); p.goto(SERVER_URL); p.wait_for_selector("#matrix tbody tr", timeout=15000); return p

def t_server_equip_confirm(b):
    """지원장비 계정(서울경기)으로 로그인: 자기 기관 장비만, [확정]은 save_fleet 에 바뀐 칸만 보냄. 다른 아이디는 미리보기(확정 불가)"""
    m = Mock(); p = server_page(b, m, "equip-01")
    check(p.locator("#userSel").input_value() == "__me" and "내 아이디" in p.locator("#userSel option").first.inner_text(), "내 아이디로 시작")
    tab(p, "fleet"); check(p.locator("[data-vs=V001]").count() == 1 and p.locator("[data-vs=V002]").count() == 0 and p.locator("select[data-rv]").count() == 0, "자기 기관 도공번호·지원 여부만(경로는 관리자)")
    d0 = m.today
    p.select_option("[data-vs=V001]", "M"); p.fill("[data-vp=V001]", "서울경기-911"); p.press("[data-vp=V001]", "Tab"); p.wait_for_timeout(150); confirm_fleet(p)
    check(m.eq_calls[-1] == ("save_fleet", {"p_vehicles": [{"id": "V001", "status": "M", "plate": "서울경기-911"}], "p_routes": []}), m.eq_calls)
    check("확정했습니다" in toast(p), toast(p))
    as_user(p, "admin1"); tab(p, "fleet")
    check("미리보기" in p.locator("#perm-fleet").inner_text(), "미리보기 안내")
    opts = p.locator(rsel("V002", d0) + " option:not([disabled])").all_inner_texts()
    check([o for o in opts if o not in ("지사 선택", "지우기")] == ["충주"], f"확정된 지사만: {opts}")
    p.select_option(rsel("V002", d0), "__del"); p.wait_for_timeout(150)
    check(p.locator("#save-fleet [data-save]").is_disabled() and "확정 불가" in p.locator("#save-fleet .save-state").inner_text(), "미리보기는 확정 불가")
    n = len(m.eq_calls); ev(p, "confirmFleet()"); p.wait_for_timeout(200); check(len(m.eq_calls) == n, "미리보기에서 서버로 보내면 안 됨")
    p.close()

def t_server_branch_save(b):
    """지사 계정: 자기 지사 행만, [저장]은 save_requests 에 바뀐 열만(도착 시각은 ISO)"""
    m = Mock(); m.users["exchungju"]["profile"]["must_change"] = False
    p = server_page(b, m, "exchungju"); tab(p, "branch")
    check(set(x.get_attribute("data-rq") for x in p.locator("#branchTable [data-rq]").all()) == {"B019"}, "자기 지사만")
    p.fill("[data-rq=B019][data-f=req_truck]", "5"); p.press("[data-rq=B019][data-f=req_truck]", "Tab"); p.wait_for_timeout(150)
    p.select_option("[data-arr=B019][data-part=m]", "40"); p.wait_for_timeout(150)
    save_branch(p)
    name, body = m.eq_calls[-1]; row = body["p_rows"][0]
    check(name == "save_requests" and body["p_round"] == 1 and set(row) == {"branch_id", "req_truck", "arrive_at"} and row["req_truck"] == 5, m.eq_calls)
    check(row["arrive_at"].endswith("Z") and ev(p, f"localInput('{row['arrive_at']}')").endswith(":40"), row)
    check("저장했습니다" in toast(p), toast(p)); p.close()

SERVER_TESTS = [t_server_equip_confirm, t_server_branch_save]

if __name__ == "__main__":
    only = sys.argv[1:]
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        for fn in TESTS:
            if not only or fn.__name__ in only: run(fn.__name__, fn, b)
        for fn in SERVER_TESTS:
            if only and fn.__name__ not in only: continue
            try: fn(b); results.append((fn.__name__, True, ""))
            except Exception as e: results.append((fn.__name__, False, f"{e.__class__.__name__}: {e}"))
        b.close()
    server.shutdown()
    ok = sum(1 for _, o, _ in results if o)
    for name, o, msg in results: print(("PASS " if o else "FAIL ") + name + ("" if o else f"  → {msg}"))
    if errors: print("\n페이지 오류:", *errors, sep="\n  ")
    print(f"\n{ok}/{len(results)} 통과" + ("" if not errors else f", 페이지 오류 {len(errors)}건"))
    sys.exit(0 if ok == len(results) and not errors else 1)
