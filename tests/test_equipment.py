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
    page.on("pageerror", lambda e: None if "새로 불러옵니다" in str(e) else errors.append(f"[{name}] {e}"))   # 예전 틀 감지 후 일부러 멈추는 것은 오류 아님
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
    head = p.locator("#matrix thead").inner_text(); check("제설차" in head and "제설기" in head and "이동정비차" not in head and "차 " not in p.locator("#matrix").inner_text(), "제설차·제설기로 정확히, 이동정비차 없음")
    hq = [x.strip() for x in p.locator("#matrix tbody tr.hqrow").first.locator("td").all_inner_texts()]
    want = ev(p, "(() => { const ids = new Set(S.branches.filter(b => S.hqById[b.hq_id].name === '강원').map(b => b.id)); const m = movesOn(todayISO()).filter(x => x.stops.some(s => ids.has(s))); return ['제설차','제설기'].map(t => String(m.filter(x => x.v.type === t).length)); })()")
    check(hq[-2:] == want, f"강원 합계(제설차·제설기, 이동정비차 제외): {hq[-2:]} vs {want}")
    check(p.locator("#moveTitle").inner_text().endswith("장비 지원 현황") and p.locator("#perm-move").count() == 0 and "어느 기관에서" not in p.locator("body").inner_text(), "제목·안내 정리")
    go_date(p, day(p, 2))            # 모레: V001(제설차)이 대관령 → 양양 두 곳
    t = p.locator("#matrix tbody tr.hqrow").first.locator("td").nth(-2).inner_text().strip()
    b = [x.locator("td").nth(-2).inner_text().strip() for x in p.locator("#matrix tbody tr.brrow").all()]
    check(int(t) == int(b[0]) + int(b[1]) - 1, f"두 곳을 들른 장비는 본부 합계에서 1대로: {t} vs {b}")
    go_date(p, day(p, -7))
    check(rows(p) == ["강원\n본부", "└춘천", "충북\n본부", "└엄정"], rows(p))
    go_date(p, day(p, 30)); check("이동하는 장비가 없습니다" in p.locator("#matrix").inner_text(), "빈 날")
    check(p.locator("#destList .hq-head").count() == 0, "카드 없음")

def t_dest_order_and_day_tag(p):
    heads = p.locator("#destList .hq-head").all_inner_texts(); check(heads == ["강원본부", "충북본부"], heads)
    check(p.locator(".frow .flabel").all_inner_texts() == ["지원기관", "장비"] and p.locator("[data-type='이동정비차']").count() == 0, "필터: 지원기관·장비 두 줄, 이동정비차 없음")
    check("이동정비차" not in p.locator("#destList").inner_text() and "편성 제설차" not in p.locator("#destList").inner_text(), "장비 세부에 이동정비차·편성 대수 없음")
    card = p.locator("#destList .dest").first
    check("도착 예상" in card.locator(".dest-time").inner_text() and "21:30" in card.locator(".dest-time").inner_text() and "도착 요청" in card.locator(".tag.req").inner_text(), "큰 시각 = 도착 예상, 도착 요청은 아래 표지")
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
    check(route(p, "V002", d1) == [] and ev(p, f"S.draft.get('{d1}|V002').stops.length") == 0, "모두 지우면 빈 경로(확정하면 그 날짜 줄 삭제)")
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
    check(p.locator("#day1In").count() == 0 and p.locator("#fleetReset").count() == 0, "지원일 1·초기화 없음")
    dels = set(x.get_attribute("data-vdel") for x in p.locator("[data-vdel]").all())
    check(dels == set(ev(p, "S.vehicles.filter(v => v.org === '충북').map(v => v.id)")), f"삭제는 자기 기관 장비만: {sorted(dels)}")
    check(p.locator("#nvOrg option").all_inner_texts() == ["충북"], "장비 추가는 자기 기관만")
    p.fill("#nvPlate", "950"); p.click("#vehAdd"); p.wait_for_timeout(250); check("추가했습니다" in toast(p), toast(p))
    p.select_option("[data-vs=V013]", "M"); p.wait_for_timeout(150); confirm_fleet(p); check("확정했습니다" in toast(p) and ev(p, "vehById('V013').status") == "M", toast(p))
    check(route(p, "V014", day(p, 0)) == ["양양"], "지원장비가 지원 여부를 바꿔도 경로는 그대로(경로는 관리자)")
    ev(p, f"S.draft.set(rk('{day(p, 3)}', 'V014'), {{ stops: ['{bid(p, '양양')}'], revised: false, times: [null] }}), updateSavebars()"); confirm_fleet(p)   # 화면을 우회해 경로를 보내도 서버가 막음
    check("권한이 없습니다" in toast(p), toast(p))
    as_user(p, "br1"); tab(p, "fleet")
    check(p.locator("#eqTable select, #eqTable input, #vehAdd, #fleetReset").count() == 0 and not p.locator("#save-fleet").is_visible(), "지사는 기관별 장비에서 아무것도 못 고침")

def t_branch_permissions(p):
    tab(p, "branch"); b = bid(p, "대관령"); p.click(f"[data-unconfirm={b}]"); p.wait_for_timeout(300)     # 확정된 줄은 잠기므로(2026-10-05) 먼저 취소
    as_user(p, "br1"); tab(p, "branch")
    ins = set(x.get_attribute("data-rq") for x in p.locator("#branchTable [data-rq]:not([disabled])").all())
    check(ins == {b}, f"대관령 행만 입력: {ins}")
    check(p.locator(f"[data-rq={b}][data-f=assigned_truck]").count() == 0 and p.locator("[data-confirm], [data-unconfirm]").count() == 0, "편성·확정은 못 고침")
    check(p.locator("#roundMake").count() == 0, "기준일자 만들기 없음")
    as_user(p, "hq-gw"); tab(p, "branch"); p.click("#onlyActive"); p.wait_for_timeout(150)
    ins = set(x.get_attribute("data-rq") for x in p.locator("#branchTable [data-rq]:not([disabled])").all())
    check(ins == set(ev(p, "S.branches.filter(b => b.hq_id === S.hqs.find(h => h.name === '강원').id && !(S.reqs[b.id] || {}).confirmed).map(b => b.id)")), f"강원본부 지사들만(확정된 양양은 잠김): {ins}")
    as_user(p, "viewer"); tab(p, "branch")
    check(p.locator("#branchTable [data-rq], #branchTable [data-arr]").count() == 0 and not p.locator("#save-branch").is_visible() and not p.locator("#save-fleet").is_visible(), "보기 전용")

def t_branch_save_confirm_and_arrive(p):
    tab(p, "branch"); ch, dg = bid(p, "춘천"), bid(p, "대관령")
    check(p.locator(f"[data-arr={dg}]:not([disabled])").count() == 0, "확정된 대관령은 도착 요청도 비활성"); p.click(f"[data-unconfirm={dg}]"); p.wait_for_timeout(300)
    h = p.locator(f"[data-arr={dg}][data-part=h] option").all_inner_texts(); m = p.locator(f"[data-arr={dg}][data-part=m] option").all_inner_texts()
    check(h == [f"{i:02d}" for i in range(24)] and m == ["00", "10", "20", "30", "40", "50"], f"시 00~23, 분 10분 단위: {h} {m}")
    p.select_option(f"[data-arr={dg}][data-part=h]", "05"); p.wait_for_timeout(150); p.select_option(f"[data-arr={dg}][data-part=m]", "30"); p.wait_for_timeout(150)
    p.fill(f"[data-rq={ch}][data-f=req_blower]", "3"); p.press(f"[data-rq={ch}][data-f=req_blower]", "Tab"); p.wait_for_timeout(150)
    check("2개 지사" in p.locator("#save-branch .save-state").inner_text(), p.locator("#save-branch .save-state").inner_text())
    check(p.locator(f"[data-confirm={ch}]").inner_text() == "확정" and p.locator(f"[data-confirm={dg}]").count() == 1, "확정 버튼")
    p.click(f"[data-confirm={ch}]"); p.wait_for_timeout(300)                  # 확정 = 그 지사 줄을 바로 저장(고친 요청 대수도 함께)
    check("확정했습니다" in toast(p) and ev(p, f"S.reqs['{ch}'].confirmed") is True and ev(p, f"S.reqs['{ch}'].req_blower") == 3 and "1개 지사" in p.locator("#save-branch .save-state").inner_text(), "확정 버튼")
    save_branch(p); check("저장했습니다" in toast(p), toast(p))
    check(ev(p, f"S.reqs['{dg}'].arrive_at") == day(p, 0) + "T05:30" and ev(p, f"S.reqs['{ch}'].confirmed") is True and ev(p, f"S.reqs['{ch}'].req_blower") == 3, "저장값")
    p.click(f"[data-confirm={dg}]"); p.wait_for_timeout(300); check(p.locator(f"[data-unconfirm={dg}]").count() == 1, "대관령 다시 확정됨 + 취소")
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
    p.hover(f"tr[data-b='{y}'] [data-hf=req_blower]"); p.wait_for_timeout(150); t = p.locator("#tip").inner_text()     # 확정된 양양은 잠겨 입력칸 대신 글자
    check(t.count("→") == 3 and "14 → 15" in t and "10 → 12" not in t, f"최근 3건만: {t}")
    check(p.locator(f"tr[data-b='{y}'] [data-hf=req_truck]").count() == 0, "다른 열에는 없음")
    as_user(p, "br1"); tab(p, "fleet"); check(p.locator("[data-hv]").count() == 0, "log.view 권한이 없으면 기록 표시 없음")

def t_log_tab(p):
    tab(p, "log"); check(p.locator("#logTable tbody tr").count() == 9, p.locator("#logTable tbody tr").count())
    p.click("[data-lk='추가']"); p.wait_for_timeout(100); check(p.locator("#logTable tbody tr").count() == 1, "구분 거르기")
    p.click("[data-lk='전체']"); tab(p, "fleet"); p.select_option(rsel("V002", day(p, 3)), bid(p, "엄정")); confirm_fleet(p)
    tab(p, "log"); first = p.locator("#logTable tbody tr").first.inner_text()
    check("경로" in first and "서울경기902" in first and "엄정" in first, first)

def t_plate_edit(p):
    tab(p, "fleet"); i = "[data-vp=V004]"
    check(p.locator("#eqTable thead th").first.inner_text() == "도공번호", "제목은 도공번호")
    check(p.locator(i).input_value() == "904" and p.locator("tr[data-vrow=V004] .pfx").inner_text() == "서울경기", "본부(기관) 이름은 자동, 숫자만 입력")
    p.fill(i, "abc"); p.press(i, "Tab"); p.wait_for_timeout(200); check("숫자만" in toast(p) and p.locator(i).input_value() == "904", "숫자만 받음")
    p.fill(i, "901"); p.press(i, "Tab"); p.wait_for_timeout(200); check("이미 있습니다" in toast(p), "중복 검사(서울경기901)")
    p.fill(i, "999"); p.press(i, "Tab"); p.wait_for_timeout(200); confirm_fleet(p)
    check(ev(p, "vehById('V004').plate") == "서울경기999", "도공번호 확정 = 서울경기999")
    tab(p, "move"); go_date(p, day(p, 0)); check("서울경기901" in p.locator("#destList").inner_text(), "이동 현황에는 서울경기901 처럼 표시")

def t_vehicle_add_delete(p):
    tab(p, "fleet"); p.select_option("#nvOrg", "전북"); check(p.locator("#nvPfx").inner_text() == "전북" and p.locator("#nvPlate").get_attribute("placeholder") == "901", "장비 추가는 번호만(기관 이름은 자동)")
    p.select_option("#nvType", "제설기"); p.fill("#nvPlate", "전북-1"); p.click("#vehAdd"); p.wait_for_timeout(200); check("숫자만" in toast(p), "숫자만")
    p.fill("#nvPlate", "998"); p.click("#vehAdd"); p.wait_for_timeout(250)
    vid = ev(p, "(S.vehicles.find(v => v.plate === '전북998') || {}).id"); check("추가했습니다" in toast(p) and vid == "V044", f"장비 추가: {vid}")
    check(p.locator(f"[data-vp={vid}]").input_value() == "998" and p.locator(f"[data-vs={vid}]").input_value() == "", "새 장비 줄(지원 여부 미정)")
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
    tab(p, "branch"); b = bid(p, "대관령")       # 사유 칸은 표에서 빠졌지만(2026-10-05) 예전에 넣은 사유는 이동 현황 카드에 보임. 확정된 줄은 잠겨 취소 → 저장 → 다시 확정
    ev(p, f"(async () => {{ for (const r of [{{ confirmed: false }}, {{ reason: '<img src=x onerror=window.__x=1>' }}, {{ confirmed: true }}]) await Api.saveRequests(S.round, [{{ branch_id: '{b}', ...r }}]); await loadReqs(); refresh(); return null }})()"); p.wait_for_timeout(200)
    check(ev(p, "window.__x") is None, "스크립트가 실행됨")
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
    p.click(f"[data-rq={b}][data-f=req_blower]"); p.wait_for_timeout(200)
    d = ev(p, f"S.rdraft.get('{b}')")
    check(d.get("req_blower") == 1 and d.get("req_truck") == 2 and (d.get("arrive_at") or "").endswith("T16:00"), d)
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
    check("확정 전" not in p.locator("#fleetRound").inner_text(), "기준일자 옆 설명 글 없음(2026-10-05): " + p.locator("#fleetRound").inner_text())

def t_ui_version_reload_once(p):
    """화면 틀 판번호가 맞아야 함 + 예전 틀(판번호 다름)이 남아 있으면 한 번만 새로 받음(무한 반복 없음)"""
    check(ev(p, "document.querySelector('meta[name=ui-version]').content") == ev(p, "UI_VERSION"), "index.html 과 app.js 판번호가 같아야 함")
    ver = ev(p, "UI_VERSION")                  # 예전 index.html 흉내: 판번호만 다른 틀을 돌려줌(새로 받는 주소 _v= 는 그대로 통과)
    p.route("**/equipment/index.html*", lambda r: r.fulfill(status=200, content_type="text/html; charset=utf-8",
        body=r.fetch().text().replace('content="' + ver + '"', 'content="old"')) if "_v=" not in r.request.url else r.continue_())
    p.goto(URL); p.wait_for_selector("#matrix tbody tr", timeout=15000)
    check("_v=" in p.url and p.locator("#eqTable tbody tr").count() > 0, f"한 번 새로 받아 정상 표시: {p.url}")
    p.unroute_all(behavior="ignoreErrors")

def t_route_kind_and_eta(p):
    """표 위 [최초 지원]/[수정본] 한 곳(표 전체 적용), 지사 옆 도착 예상 시각은 직접 입력 → 이동 현황 장비 줄·상세에 도착 예상"""
    tab(p, "fleet"); d3 = day(p, 3)
    check(p.locator("#modeInit").is_checked() and not p.locator("#modeRev").is_checked() and p.locator("[data-kind]").count() == 0, "구분은 표 위 한 곳(칸마다 없음)")
    enabled = lambda: [o for o in p.locator(rsel("V002", d3) + " option:not([disabled])").all_inner_texts() if o not in ("지사 선택", "지우기")]
    check(enabled() == ["대관령", "양양", "엄정"], enabled())
    p.check("#modeRev"); p.wait_for_timeout(150)
    check(not p.locator("#modeInit").is_checked() and len(enabled()) == ev(p, "S.branches.length") and len([o for o in p.locator(rsel("V003", d3) + " option:not([disabled])").all_inner_texts() if o not in ("지사 선택", "지우기")]) == ev(p, "S.branches.length"), "수정본이면 모든 칸에서 모든 지사")
    p.select_option(rsel("V002", d3), bid(p, "인천")); p.wait_for_timeout(150)
    ti = f"input[data-fk='t:{d3}:V002:0']"
    p.fill(ti, "735"); p.press(ti, "Tab"); p.wait_for_timeout(150); check(p.locator(ti).input_value() == "07:35", "735 → 07:35 (분은 아무 숫자)")
    p.fill(ti, "2561"); p.press(ti, "Tab"); p.wait_for_timeout(150); check("0730" in toast(p) and p.locator(ti).input_value() == "07:35", "잘못된 시각 거절")
    check(ev(p, f"JSON.stringify(recOf('{d3}', 'V002'))") == '{"stops":["%s"],"revised":true,"times":["07:35"]}' % bid(p, "인천"), ev(p, f"JSON.stringify(recOf('{d3}', 'V002'))"))
    confirm_fleet(p); check("확정했습니다" in toast(p), toast(p))
    p.check("#modeInit"); p.wait_for_timeout(150)
    check("인천 (편성 확정 전)" in p.locator(rsel("V002", d3)).inner_text() and "수정본" in p.locator(f"td[data-cell='{d3}|V002']").inner_text(), "최초 지원 목록에서는 미확정 표시, 칸에 수정본 표지")
    tab(p, "move"); go_date(p, d3)
    row = p.locator(".vrow[data-vid=V002]").first.inner_text(); check("07:35 도착 예상" in row and "수정본" in row, row)
    check("07:35" in p.locator(".dest", has_text="인천").locator(".dest-time").inner_text(), "카드 큰 시각 = 도착 예상")
    p.click(".vrow[data-vid=V002]"); p.wait_for_selector("ol.vhist li")
    sh = p.locator("#sheet").inner_text(); check("도착 예상" in sh and "07:35" in sh and "도착 요청" not in sh and "지원기관" in sh, sh)
    check("인천 07:35" in p.locator("ol.vhist").inner_text(), "날짜별 기록에도 시각")
    p.click("#sheetClose")

def t_equip_can_edit_eta(p):
    """지원장비 계정: 자기 기관 장비의 정해진 경로에서 도착 예상 시각만 입력(지사는 못 바꿈)"""
    as_user(p, "eq-cb"); tab(p, "fleet"); d0 = day(p, 0)
    check(p.locator("select[data-rv]").count() == 0 and p.locator(f"input[data-fk='t:{d0}:V014:0']").count() == 1 and p.locator(f"input[data-fk='t:{d0}:V001:0']").count() == 0, "자기 기관 장비의 시각 칸만")
    ti = f"input[data-fk='t:{d0}:V014:0']"; p.fill(ti, "0845"); p.press(ti, "Tab"); p.wait_for_timeout(150)
    confirm_fleet(p); check("확정했습니다" in toast(p) and route(p, "V014", d0) == ["양양"] and ev(p, f"recOf('{d0}', 'V014').times[0]") == "08:45", toast(p))
    check(p.locator("#modeInit").count() == 0, "최초/수정본은 관리자만")

def t_bulk_confirm_and_no_holdings(p):
    tab(p, "branch")
    heads = p.locator("#branchTable thead").inner_text(); check("보유" not in heads and "최종" not in heads and "일괄 확정" in heads, heads)
    ch = bid(p, "춘천"); check(p.locator(f"[data-confirm={ch}]").count() == 1, "춘천 확정 전")
    p.click("#confirmAll"); p.wait_for_timeout(300)
    n = ev(p, "S.order.filter(b => !(S.hqById[b.hq_id] || {}).is_private).length") - 3       # 샘플에서 이미 확정된 3곳(대관령·양양·엄정)을 뺀 나머지 모두(요청 없는 지사도, 2026-10-05)
    check(f"{n}개 지사를 확정했습니다" in toast(p) and ev(p, f"S.reqs['{ch}'].confirmed") is True, toast(p))
    check(p.locator("#confirmAll").count() == 0 and "모두 확정" in p.locator("#branchTable thead th.cf").inner_text(), "다 확정되면 [일괄 확정] 대신 '모두 확정'")
    as_user(p, "br1"); tab(p, "branch"); check(p.locator("#confirmAll").count() == 0, "지사는 일괄 확정 없음")

def t_filters_fit_any_width(p):
    """이동 현황 필터: 지원기관 줄·장비 줄 항상 두 줄, 이름은 작은 첨자, 좁으면 글자를 줄임(글자는 항상 가로, 넘치지 않음)"""
    for w in (1440, 900, 420, 340):
        p.set_viewport_size({"width": w, "height": 800}); p.wait_for_timeout(250)
        r = p.evaluate("""(() => { const f = document.getElementById('filters'), fr = f.getBoundingClientRect(), rows = [...f.querySelectorAll('.frow')];
          const chips = [...f.querySelectorAll('.chip')]; return { rows: rows.length, tops: rows.map(r => Math.round(r.getBoundingClientRect().top)), s: +getComputedStyle(f).getPropertyValue('--s'),
          oneLine: chips.every(c => c.getBoundingClientRect().height < 40 && c.scrollHeight <= c.clientHeight + 2), inside: rows.every(r => r.getBoundingClientRect().right <= fr.right + 1 && r.scrollWidth <= f.clientWidth + 1),
          small: parseFloat(getComputedStyle(f.querySelector('.flabel')).fontSize) < parseFloat(getComputedStyle(chips[0]).fontSize) }; })()""")
        check(r["rows"] == 2 and r["tops"][0] < r["tops"][1] and r["oneLine"] and r["inside"] and r["small"], f"{w}px: {r}")
        if w >= 900: check(r["s"] == 1, f"{w}px 원래 크기: {r}")
        else: check(r["s"] < 1, f"{w}px 글자 축소: {r}")
    p.click("[data-tab=fleet]"); p.set_viewport_size({"width": 1440, "height": 800}); p.wait_for_timeout(150); p.click("[data-tab=move]"); p.wait_for_timeout(250)
    check(p.evaluate("+getComputedStyle(document.getElementById('filters')).getPropertyValue('--s')") == 1, "다른 탭에서 넓힌 뒤 돌아와도 맞게")

def t_date_in_title(p):
    """맨 위 날짜 칸은 없고, 이동 현황 제목의 큰 날짜를 눌러 바꿈(‹ › 도 제목 옆)"""
    check(p.locator(".topbar .date-nav").count() == 0, "맨 위 날짜 칸 없음")
    check(p.locator("#dateText").inner_text() == ev(p, "fmtMD(todayISO())") and "장비 지원 현황" in p.locator(".move-title").inner_text(), p.locator(".move-title").inner_text())
    p.click("#nextDay"); p.wait_for_timeout(200); check(p.locator("#dateText").inner_text() == ev(p, "fmtMD(addDays(todayISO(), 1))"), "다음날")
    go_date(p, day(p, -7)); check(p.locator("#dateText").inner_text() == ev(p, "fmtMD(addDays(todayISO(), -7))") and "춘천" in p.locator("#matrix").inner_text(), "달력으로 고른 날짜")

def t_branch_header_stays_on_top(p):
    """지사별 요청·편성 표를 스크롤해도 두 줄 제목이 겹치지 않고(둘째 줄은 첫 줄 아래), 입력칸이 제목 위로 올라오지 않음"""
    tab(p, "branch"); p.click("#onlyActive"); p.wait_for_timeout(200)
    p.evaluate("document.querySelector('#panel-branch .table-wrap').scrollTop = 500"); p.wait_for_timeout(200)
    r = p.evaluate("""(() => { const w = document.querySelector('#panel-branch .table-wrap'), wr = w.getBoundingClientRect(), rows = [...document.querySelectorAll('#branchTable thead tr')];
      const h1 = rows[0].getBoundingClientRect().height;
      return [...document.querySelectorAll('#branchTable thead th')].filter(th => { const b = th.getBoundingClientRect(); return b.left + b.width / 2 < wr.right - 12; }).map(th => { const b = th.getBoundingClientRect(), el = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return [th.textContent.trim(), Math.round(b.top - wr.top - (th.parentElement === rows[1] ? h1 : 0)), !!(el && th.contains(el))]; }); })()""")
    check(all(abs(x[1]) <= 2 for x in r), f"제목 줄 위치: {r}")
    check(all(x[2] for x in r), f"제목이 가려짐: {[x[0] for x in r if not x[2]]}")

def badge(p, name): return p.locator(f"td[data-wcell='{bid(p, name)}'] .wb")
def t_warning_auto_badge(p):
    """대설 특보 칸은 자동 표시(체크칸 없음): 확정 전 = 지금 특보, 확정한 지사 = 확정할 때 값(칸은 빨간 네모, '고정' 글자 없음). 색은 단계별"""
    tab(p, "branch")
    head = p.locator("#branchTable thead").inner_text()
    check(p.locator("[data-f=warning]").count() == 0 and "대설특보 발표" in head and all(x in head for x in ("종류", "발표", "발효")), "대설특보 발표 아래 종류·발표·발효: " + head)
    row = p.locator(f"tr[data-b='{bid(p, '춘천')}']")
    check(row.locator("[data-wfc]").inner_text().endswith("04:00") and "오후(12~18시)" in row.locator("[data-wef]").inner_text(), "예비특보 발표 시각·발효(약속 시각 → 오후): " + row.inner_text())
    check(badge(p, "춘천").inner_text() == "예비특보" and "w1" in badge(p, "춘천").get_attribute("class"), "확정 전 춘천 = 지금 예비특보(노랑)")
    check(badge(p, "대관령").inner_text() == "대설주의보" and "w2" in badge(p, "대관령").get_attribute("class"), "대관령 = 확정 때 주의보(지금은 경보)")
    check(badge(p, "양양").inner_text() == "특보 없음" and "locked" in (p.locator(f"tr[data-b='{bid(p, '양양')}']").get_attribute("class") or "") and not "locked" in (p.locator(f"tr[data-b='{bid(p, '춘천')}']").get_attribute("class") or ""), "확정한 지사 특보 칸 = 빨간 네모")
    check(p.locator("#branchTable .wfix").count() == 0 and "고정" not in p.locator("#branchTable").inner_text(), "'고정' 글자 없음")
    badge(p, "춘천").hover(); p.wait_for_timeout(100)
    check(p.locator("#tip").is_hidden(), "지사 칸에 마우스를 올려도 설명 없음(2026-10-05)")
    wb = p.locator("#wBaseHead"); check(wb.inner_text().endswith("기준") and ev(p, "getComputedStyle(document.getElementById('wBaseHead')).borderBottomStyle") == "dashed", "대설특보 발표 아래 ○ 기준(점선): " + wb.inner_text())
    wb.hover(); p.wait_for_timeout(100); check("10분마다 업데이트" in p.locator("#tip").inner_text(), "기준에 마우스를 올리면 업데이트 주기: " + p.locator("#tip").inner_text())
    p.hover("#fcBaseHead"); p.wait_for_timeout(100); check("3시간마다 업데이트" in p.locator("#tip").inner_text(), p.locator("#tip").inner_text())
    col = ev(p, "getComputedStyle(document.getElementById('fcBaseHead')).color"); check(col == "rgb(29, 79, 160)", f"기준 글자는 잘 보이는 파랑(노랑 아님): {col}")
    tab(p, "move"); card = p.locator(".dest", has_text="대관령")
    check(card.locator(".tag.wb").inner_text() == "대설주의보", "이동 현황 카드도 고정값")
    tab(p, "branch"); p.click(f"[data-confirm='{bid(p, '춘천')}']"); p.wait_for_timeout(300)
    check("대설특보: 예비특보," in toast(p) and "고정" not in toast(p) and badge(p, "춘천").inner_text() == "예비특보" and "locked" in (p.locator(f"tr[data-b='{bid(p, '춘천')}']").get_attribute("class") or ""), toast(p))
    p.click(f"[data-unconfirm='{bid(p, '대관령')}']"); p.wait_for_timeout(300)
    check(badge(p, "대관령").inner_text() == "대설경보" and "w3" in badge(p, "대관령").get_attribute("class"), "확정을 풀면 다시 지금 값(경보, 빨강) — 강풍 등 다른 특보는 지사 칸에 안 나옴")
    check(p.locator(f"tr[data-b='{bid(p, '대관령')}'] [data-wef]").inner_text().endswith("06:00"), "경보 발효 시각")
    bg = [ev(p, f"getComputedStyle(document.querySelector(\"td[data-wcell='{bid(p, n)}'] .wb\")).backgroundColor") for n in ("춘천", "양양", "대관령")]
    check(len(set(bg)) == 3, f"단계마다 다른 색: {bg}")
    as_user(p, "br2"); tab(p, "branch")
    check(p.locator("#zoneMgr").count() == 0 and badge(p, "양양").count() == 1, "지사도 보지만 특보구역 관리는 관리자만")

def t_zone_manager(p):
    """관리자: 특보구역 관리 창에서 지사 구역을 빼고 더하면 그 지사 대설 특보가 바로 바뀜(기록 남음)"""
    tab(p, "branch"); p.click("#zoneMgr"); p.wait_for_selector("#zlist h3")
    p.select_option("#zbr", bid(p, "춘천")); p.wait_for_timeout(100)
    check([x.strip() for x in p.locator("#zlist ul").first.locator("li > span:first-child").all_inner_texts()] == ["강원도 · 춘천", "강원도 · 홍천평지", "강원도 · 홍천산지"], p.locator("#zlist").inner_text())
    p.click("[data-zset=L1022710]"); p.wait_for_timeout(200)
    check(badge(p, "춘천").inner_text() == "특보 없음" and "되살리기" in p.locator("#zlist").inner_text(), "홍천평지를 빼면 특보 없음")
    p.select_option("#zadd", "L1022520"); p.click("#zaddBtn"); p.wait_for_timeout(200)
    check(badge(p, "춘천").inner_text() == "대설주의보" and "더함" in p.locator("#zlist").inner_text(), "강릉산지(주의보)를 더하면 주의보")
    p.click("#zlist [data-zset=L1022710]"); p.wait_for_timeout(200)
    check(badge(p, "춘천").inner_text() == "대설주의보" and "뺀 구역" not in p.locator("#zlist").inner_text(), "되살려도 더 높은 주의보")
    tabs = [t.strip() for t in p.locator("#wnow .wtab").all_inner_texts()]
    check(tabs[0].startswith("대설") and len(tabs) == 5 and p.locator("#wnow .wtrow").count() == 2, f"종류별 탭(대설 먼저, 5종류라 두 줄): {tabs}")
    check(any(t.replace(" ", "") == "건조2" for t in tabs), f"탭 = 이름 + 구역 수: {tabs}")
    p.click("[data-wtab='강풍']"); p.wait_for_timeout(100); wl = p.locator("#wnow .wlist").inner_text()
    check("횡성" in wl and "주의보" in wl and "대관령" in wl and "04:00" in wl and "06:00" in wl, "강풍 탭: 구역·단계·발표·발효·이어진 지사: " + wl)
    p.click("#sheetClose"); tab(p, "log")
    check("특보구역" in p.locator("#panel-log").inner_text(), "수정 기록에 특보구역")
    as_user(p, "hq-gw"); tab(p, "branch"); check(p.locator("#zoneMgr").count() == 0, "본부는 관리 버튼 없음")

def t_private_hq_hidden_in_branch_tab(p):
    """민자는 지사별 요청·편성에 나오지 않음('요청 있는 지사만'을 꺼도)"""
    tab(p, "branch"); p.click("#onlyActive"); p.wait_for_timeout(200)
    hqs = [x.strip() for x in p.locator("#branchTable tr.hq td.l").all_inner_texts()]
    check("민자" not in hqs and len(hqs) == ev(p, "S.hqs.filter(h => !h.is_private).length"), f"본부 줄에 민자 없음: {hqs}")
    check(p.locator(f"#branchTable tr[data-b='{bid(p, '민자')}']").count() == 0, "민자 지사 줄 없음")

def t_snow_forecast(p):
    """24시 강설 [적설 | 강수] = 기상청 단기예보 24시간 합의 지사 최댓값, 제목 옆 발표 기준, 확정하면 그 값(빨간 네모), 누르면 기관별 24시간 예보로"""
    tab(p, "branch"); head = p.locator("#branchTable thead").inner_text()
    check(p.locator("[data-f=snow_cm]").count() == 0 and "24시 강설" in head and "적설" in head and "강수" in head and "발표 기준" in head, "24시 강설 아래 적설·강수, 발표 기준: " + head)
    check(p.locator(f"td[data-pcell='{bid(p, '춘천')}']").inner_text() == "6.2", "춘천 강수 6.2mm")
    fc = lambda n: p.locator(f"td[data-fcell='{bid(p, n)}']").inner_text().replace(chr(10), "")
    check(fc("춘천") == "3.5" and fc("대관령") == "12.1" and fc("양양") == "8.0", f"확정 전 = 지금 예보, 확정 = 확정 때 값: {fc('춘천')} {fc('대관령')} {fc('양양')}")
    th = [x.strip().replace("\n", "") for x in p.locator("#branchTable thead tr").first.locator("th").all_inner_texts()]
    check(th[1].startswith("24시 강설") and th[2] == "최저기온" and th[3].startswith("대설특보 발표") and "사유" not in th, f"24시 강설 → 최저기온 → 대설특보, 사유 열 없음: {th}")
    tm = lambda n: p.locator(f"td[data-tcell='{bid(p, n)}']").inner_text(); ta = lambda n: p.locator(f"td[data-tacell='{bid(p, n)}']").inner_text()
    check(tm("춘천") == "-7" and tm("대관령") == "-10" and ta("춘천").endswith("시"), f"최저기온(확정 전 = 지금, 확정 = 확정 때): {tm('춘천')} {tm('대관령')} {ta('춘천')}")
    check("cold" in p.locator(f"td[data-tcell='{bid(p, '춘천')}'] .fcv").get_attribute("class") and "locked" in p.locator(f"tr[data-b='{bid(p, '대관령')}']").get_attribute("class"), "영하는 파랑, 확정은 빨간 네모")
    check("locked" in (p.locator(f"tr[data-b='{bid(p, '대관령')}']").get_attribute("class") or "") and "locked" in (p.locator(f"tr[data-b='{bid(p, '대관령')}']").get_attribute("class") or "") and not "locked" in (p.locator(f"tr[data-b='{bid(p, '춘천')}']").get_attribute("class") or ""), "확정한 지사 적설·강수 칸 = 빨간 네모")
    p.hover(f"td[data-fcell='{bid(p, '춘천')}'] [data-fb]"); p.wait_for_timeout(100)
    check(p.locator("#tip").is_hidden(), "적설·강수 칸에 마우스를 올려도 설명 없음(누르면 이동은 그대로)")
    p.click(f"[data-confirm='{bid(p, '춘천')}']"); p.wait_for_timeout(300)
    check("적설 3.5cm·강수 6.2mm·최저 -7℃)" in toast(p) and fc("춘천") == "3.5" and "locked" in (p.locator(f"tr[data-b='{bid(p, '춘천')}']").get_attribute("class") or ""), toast(p))
    p.click(f"[data-unconfirm='{bid(p, '대관령')}']"); p.wait_for_timeout(300)
    check(fc("대관령") == "14.2", "확정을 풀면 지금 예보: " + fc("대관령"))
    tab(p, "move"); check("예상 적설 14.2cm · 강수 18.5mm · 최저 -12℃" in p.locator(".dest", has_text="대관령").inner_text(), "이동 현황 카드")
    tab(p, "branch"); ev(p, "(() => { window.open = (u, t) => { window.__opened = [u, t]; }; return null })()")
    p.click(f"td[data-pcell='{bid(p, '양양')}'] [data-fb]"); p.wait_for_timeout(100)
    check(ev(p, "window.__opened") == [f"../#fc={bid(p, '양양')}", "_top"], f"누르면 기관별 24시간 예보의 그 지사로: {ev(p, 'window.__opened')}")
    ev(p, "(() => { window.__opened = null; return null })()"); p.click(f"td[data-tcell='{bid(p, '춘천')}'] [data-fb]"); p.wait_for_timeout(100)
    check(ev(p, "window.__opened") == [f"../#fc={bid(p, '춘천')}", "_top"], "최저기온을 눌러도 그 지사 예보로")

def t_weather_manual(p):
    """기상현황 직접입력(2026-10-05): 체크하면 적설·강수 숫자, 특보 종류 선택, 발표·발효 월일시분 8자리. 밑줄·예보 이동 없음. 확정하면 빨간 네모"""
    tab(p, "branch")
    th = [x.strip().replace("\n", "") for x in p.locator("#branchTable thead tr").first.locator("th").all_inner_texts()]
    i = [k for k, x in enumerate(th) if x.startswith("대설특보 발표")][0]
    check(th[i + 1] == "기상현황직접입력" and th[i + 2] == "지사 요청", f"대설특보 발표와 지사 요청 사이: {th}")
    cj = bid(p, "춘천"); row = p.locator(f"tr[data-b='{cj}']")
    check(row.locator("[data-fb]").count() == 4 and row.locator("input[data-f=wx_snow]").count() == 0, "처음엔 자동 값 4개(적설·강수·최저기온·시각, 누르면 예보로)")
    row.locator("input[data-f=wx_manual]").check(); p.wait_for_timeout(200); row = p.locator(f"tr[data-b='{cj}']")
    check(row.locator("[data-fb]").count() == 0 and row.locator(".fcv").count() == 0, "체크하면 밑줄·예보 이동 없음")
    check(row.locator("select[data-f=wx_level] option").all_inner_texts() == ["특보 없음", "예비특보", "대설주의보", "대설경보"], "특보 종류는 선택")
    row.locator("input[data-f=wx_snow]").fill("7.5"); row.locator("input[data-f=wx_snow]").dispatch_event("change")
    row.locator("input[data-f=wx_pcp]").fill("10"); row.locator("input[data-f=wx_pcp]").dispatch_event("change")
    row.locator("input[data-f=wx_tmin]").fill("-8.5"); row.locator("input[data-f=wx_tmin]").dispatch_event("change")
    row.locator("input[data-f=wx_tmin_at]").fill("12250600"); row.locator("input[data-f=wx_tmin_at]").dispatch_event("change")
    row.locator("select[data-f=wx_level]").select_option("주의")
    hs = row.locator("select[data-wxt][data-f=wx_fc][data-part=h] option").all_inner_texts(); ms = row.locator("select[data-wxt][data-f=wx_fc][data-part=m] option").all_inner_texts()
    check(hs == ["--"] + [f"{i:02d}" for i in range(24)] and ms == ["00", "10", "20", "30", "40", "50"], f"발표 = 시(00~23)·분(10분 단위) 선택: {hs[:3]}… {ms}")
    check(row.locator("select[data-wxt][data-f=wx_fc][data-part=m]").is_disabled(), "시를 고르기 전에는 분 잠김")
    row.locator("select[data-wxt][data-f=wx_fc][data-part=h]").select_option("15"); p.wait_for_timeout(100)
    row.locator("select[data-wxt][data-f=wx_fc][data-part=m]").select_option("30"); p.wait_for_timeout(100)
    row.locator("select[data-wxt][data-f=wx_ef][data-part=h]").select_option("18"); p.wait_for_timeout(100)
    save_branch(p)
    r = ev(p, f"S.reqs['{cj}']")
    check(r["wx_tmin"] == -8.5 and ev(p, f"mdhm(S.reqs['{cj}'].wx_tmin_at)") == "12250600", f"최저기온 직접입력 저장: {r}")
    check(r["wx_manual"] is True and r["wx_snow"] == 7.5 and r["wx_pcp"] == 10 and r["wx_level"] == "주의" and ev(p, f"fmtHM(S.reqs['{cj}'].wx_fc)") == "15:30" and ev(p, f"fmtHM(S.reqs['{cj}'].wx_ef)") == "18:00"
          and ev(p, f"localInput(S.reqs['{cj}'].wx_fc).slice(0, 10)") == ev(p, "curRound().start_date"), f"저장(날짜 = 기준일자): {r}")
    p.click(f"[data-confirm='{cj}']"); p.wait_for_timeout(300); row = p.locator(f"tr[data-b='{cj}']")
    check("locked" in (row.get_attribute("class") or "") and p.locator("#branchTable td.fixd").count() == 0, "확정하면 줄 바탕 노랑(빨간 네모 없음)")
    check("적설 7.5cm·강수 10.0mm" in toast(p) and "대설주의보" in toast(p), "확정 안내는 직접 넣은 값: " + toast(p))
    tab(p, "move"); card = p.locator(".dest", has_text="춘천")
    if card.count(): check("(직접입력)" in card.inner_text() and card.locator("[data-fb]").count() == 0, "이동 현황 카드: 직접입력 표시, 누를 수 없음")
    as_user(p, "br2"); tab(p, "branch"); row = p.locator(f"tr[data-b='{cj}']")
    check(row.locator(f"td[data-fcell='{cj}']").inner_text() == "7.5" and row.locator("input").count() == 0 and row.locator("[data-fb]").count() == 0, "다른 지사 계정: 숫자만(입력·이동 없음)")
    check(row.locator(f"td[data-tcell='{cj}']").inner_text() == "-8.5" and row.locator(f"td[data-tacell='{cj}']").inner_text() == "12/25 06시", "직접 넣은 최저기온·시각")
    check(row.locator("td[data-wcell] .wb").inner_text() == "대설주의보" and row.locator("td[data-wfc]").inner_text() == "15:30" and row.locator("td[data-wef]").inner_text() == "18:00", row.inner_text())
    check(p.locator(f"tr[data-b='{bid(p, '양양')}']").locator("input:not([disabled]), select:not([disabled])").count() == 0, "확정된 자기 지사(양양)는 비활성")

def t_confirmed_row_locked(p):
    """확정한 지사 줄은 [취소]하기 전까지 요청·편성·도착 요청·기상현황 직접입력을 못 고침(관리자도, 서버도 막음)"""
    tab(p, "branch"); dg, cj = bid(p, "대관령"), bid(p, "춘천")
    row = lambda b: p.locator(f"tr[data-b='{b}']")
    check(row(dg).locator("input:not([disabled]), select:not([disabled])").count() == 0 and row(dg).locator("input[disabled]").count() >= 5 and row(dg).locator("[data-unconfirm]").count() == 1, "확정된 대관령: 입력칸은 비활성(회색), [취소]만")
    check(row(cj).locator("input[data-f=req_truck]").count() == 1 and row(cj).locator("input[data-f=wx_manual]").count() == 1, "확정 전 춘천: 입력 가능")
    p.click(f"[data-confirm='{cj}']"); p.wait_for_timeout(300)
    check(row(cj).locator("input:not([disabled]), select:not([disabled])").count() == 0 and "locked" in row(cj).get_attribute("class"), "확정하면 춘천도 바로 비활성")
    r = ev(p, f"Api.saveRequests(S.round, [{{ branch_id: '{dg}', req_truck: 9 }}])")
    check(r["ok"] is False and "확정을 취소한 뒤" in r["message"], f"확정 줄 저장은 서버에서도 거절: {r}")
    r = ev(p, f"Api.saveRequests(S.round, [{{ branch_id: '{dg}', confirmed: false, req_truck: 9 }}])")
    check(r["ok"] is False, "취소하면서 값 바꾸기도 거절")
    p.click(f"[data-unconfirm='{cj}']"); p.wait_for_timeout(300)
    check(row(cj).locator("input[data-f=req_truck]").count() == 1 and row(cj).locator("input[data-f=assigned_truck]").count() == 1, "취소하면 다시 고칠 수 있음")
    bg = lambda b: ev(p, f"getComputedStyle(document.querySelector(\"tr[data-b='{b}'] td\")).backgroundColor")
    check("locked" not in (row(cj).get_attribute("class") or "") and bg(cj) != bg(dg) and bg(cj) in ("rgba(0, 0, 0, 0)", "transparent"), f"취소하면 줄 바탕도 흰색으로(확정 줄만 노랑): {bg(cj)} / {bg(dg)}")
    as_user(p, "br2"); tab(p, "branch"); yy = bid(p, "양양")
    check(row(yy).locator("input:not([disabled]), select:not([disabled])").count() == 0 and row(yy).locator("input[data-f=wx_manual][disabled]").count() == 1, "지사 계정: 확정된 자기 지사 줄도 비활성(체크칸 포함)")
    # 다른 화면(관리자)에서 그사이 확정 → 이 화면은 아직 모름 → 저장하면 '이미 확정' 안내 + 최신으로 다시 읽음
    as_user(p, "admin1"); tab(p, "branch"); wj = bid(p, "춘천")         # 위에서 확정을 취소해 지금은 확정 전
    p.fill(f"[data-rq={wj}][data-f=req_truck]", "3"); p.press(f"[data-rq={wj}][data-f=req_truck]", "Tab"); p.wait_for_timeout(150)
    ev(p, f"Api.saveRequests(S.round, [{{ branch_id: '{wj}', confirmed: true }}])")
    save_branch(p)
    check("이미 확정되어 고칠 수 없습니다" in toast(p) and "춘천" in toast(p) and "저장하지 못했습니다" not in toast(p), "확정되어 고칠 수 없다는 안내: " + toast(p))
    check(row(wj).locator("input:not([disabled]), select:not([disabled])").count() == 0 and ev(p, f"S.rdraft.has('{wj}')") is False, "다시 읽어 그 줄은 비활성, 고친 값은 버림")

def t_confirm_all_by_hq(p):
    """본부 줄의 [일괄 확정] = 그 본부 지사 모두(요청을 저장하지 않은 지사도). 맨 위 [일괄 확정]도 저장 여부와 관계없이 모두"""
    tab(p, "branch"); p.click("#onlyActive"); p.wait_for_timeout(150)            # 요청 없는 지사도 보이게
    gw = ev(p, "S.hqs.find(h => h.name === '강원').id"); cb = ev(p, "S.hqs.find(h => h.name === '충북').id")
    hq = p.locator(f"#branchTable tr.hq[data-hq='{gw}']")
    check(hq.locator("[data-confirm-hq]").inner_text() == "일괄 확정" and hq.locator("[data-s=confirmed]").count() == 0, "본부 줄: 확정 개수 대신 [일괄 확정]")
    ids = ev(p, f"S.order.filter(b => b.hq_id === '{gw}').map(b => b.id)")
    hq.locator("[data-confirm-hq]").click(); p.wait_for_timeout(400)
    check(all(ev(p, f"!!(S.reqs['{i}'] || {{}}).confirmed") for i in ids), "강원 지사 모두 확정(요청 없던 지사도)")
    check("강원 본부" in toast(p) and "확정했습니다" in toast(p), toast(p))
    check(p.locator(f"#branchTable tr.hq[data-hq='{gw}']").inner_text().count("모두 확정") == 1, "다 확정되면 '모두 확정'")
    check(hq.locator("[data-unconfirm-hq]").inner_text() == "일괄 취소", "모두 확정 옆에 [일괄 취소]")
    p.locator(f"#branchTable tr.hq[data-hq='{gw}'] [data-unconfirm-hq]").click(); p.wait_for_timeout(400)
    check(not any(ev(p, f"!!(S.reqs['{i}'] || {{}}).confirmed") for i in ids) and "강원 본부" in toast(p) and "취소했습니다" in toast(p), "본부 [일괄 취소] = 그 본부 지사 확정 모두 취소: " + toast(p))
    check(p.locator(f"#branchTable tr.hq[data-hq='{gw}'] [data-confirm-hq]").count() == 1 and p.locator(f"#branchTable tr.hq[data-hq='{gw}'] [data-unconfirm-hq]").count() == 0, "취소하면 다시 [일괄 확정]만")
    p.locator(f"#branchTable tr.hq[data-hq='{gw}'] [data-confirm-hq]").click(); p.wait_for_timeout(400)
    check(ev(p, f"S.order.some(b => b.hq_id === '{cb}' && !(S.reqs[b.id] || {{}}).confirmed)"), "다른 본부(충북)는 그대로")
    p.click("#confirmAll"); p.wait_for_timeout(500)
    check(ev(p, "S.order.filter(b => !(S.hqById[b.hq_id] || {}).is_private).every(b => (S.reqs[b.id] || {}).confirmed)"), "맨 위 [일괄 확정] = 저장 안 한 지사까지 모두")
    head = p.locator("#branchTable thead th.cf")
    check(p.locator("#confirmAll").count() == 0 and "모두 확정" in head.inner_text() and p.locator("#unconfirmAll").count() == 1, "제목도 모두 확정되면 '모두 확정' + [일괄 취소]")
    p.click("#unconfirmAll"); p.wait_for_timeout(500)
    check(ev(p, "S.order.every(b => !(S.reqs[b.id] || {}).confirmed)") and "취소했습니다" in toast(p), "제목 [일괄 취소] = 모든 지사 확정 취소: " + toast(p))
    check(p.locator("#confirmAll").count() == 1 and p.locator("#unconfirmAll").count() == 0 and p.locator("#branchTable tr.locked").count() == 0, "취소하면 다시 [일괄 확정]만, 노란 줄 없음")

def t_views_and_choices_after_confirm_all(p):
    """(2026-10-06) 일괄 확정 뒤에도: '요청 있는 지사만' = 요청 1대 이상, '편성 확정된 지사만' = 확정 + 편성 1대 이상.
    기관별 장비 [최초 지원] 선택지 = 편성 확정된 지사만(일괄 확정으로 편성 0대인 지사는 안 나옴), 모든 지사는 [수정본]에서만"""
    tab(p, "branch"); p.click("#onlyActive"); p.wait_for_timeout(150)          # 모든 지사 보기 → 일괄 확정
    p.click("#confirmAll"); p.wait_for_timeout(500)
    shown = lambda: [x.get_attribute("data-b") for x in p.locator("#branchTable tr[data-b]").all()]
    total = ev(p, "S.order.filter(b => !(S.hqById[b.hq_id] || {}).is_private).length")
    check(len(shown()) == total, f"모든 지사: {len(shown())}/{total}")
    p.click("#onlyActive"); p.wait_for_timeout(150)
    want = ev(p, "S.order.filter(b => !(S.hqById[b.hq_id] || {}).is_private && hasReq(b.id)).map(b => b.id)")
    check(set(shown()) == set(want) and 0 < len(want) < total, f"일괄 확정 뒤에도 '요청 있는 지사만'이 걸러짐: {len(shown())}/{total}")
    p.click("#onlyFixed"); p.wait_for_timeout(150)
    fixed = ev(p, "S.order.filter(b => !(S.hqById[b.hq_id] || {}).is_private && isFixed(b.id)).map(b => b.id)")
    check(set(shown()) == set(fixed) and 0 < len(fixed) < total and p.locator("#onlyFixed").get_attribute("aria-pressed") == "true" and p.locator("#onlyActive").get_attribute("aria-pressed") == "false",
          f"'편성 확정된 지사만' = 확정 + 편성 1대 이상: {[bn for bn in fixed]}")
    check(all(ev(p, f"isConf('{x}') && (S.reqs['{x}'].assigned_truck + S.reqs['{x}'].assigned_blower) > 0") for x in shown()), "보이는 줄은 모두 편성 확정")
    p.click("#onlyFixed"); p.wait_for_timeout(150); check(len(shown()) == total, "다시 누르면 모든 지사")
    tab(p, "fleet"); d0 = day(p, 0)
    opts = [o for o in p.locator(rsel("V004", d0) + " option:not([disabled])").all_inner_texts() if o not in ("지사 선택", "지우기")]
    names = ev(p, "routeChoices().map(b => b.name)")
    check(sorted(opts) == sorted(names) and len(names) == len(fixed) and len(names) < total, f"최초 지원 = 편성 확정된 지사만: {opts}")
    p.click("#modeRev"); p.wait_for_timeout(200)
    opts2 = [o for o in p.locator(rsel("V004", d0) + " option:not([disabled])").all_inner_texts() if o not in ("지사 선택", "지우기")]
    check(len(opts2) >= total - 1, f"수정본 = 모든 지사: {len(opts2)}")

TESTS = [t_views_and_choices_after_confirm_all, t_confirm_all_by_hq, t_confirmed_row_locked, t_weather_manual, t_load, t_move_hierarchy, t_dest_order_and_day_tag, t_route_choices_confirmed_only, t_confirm_keeps_history, t_day1_header_and_columns,
         t_multi_stop_add_and_delete, t_status_maintenance, t_reset_button, t_permissions_equip_own, t_branch_permissions, t_branch_save_confirm_and_arrive,
         t_round_create, t_history_tooltip_per_cell, t_log_tab, t_plate_edit, t_vehicle_add_delete, t_fleet_header_stays_on_top, t_theme_toggle,
         t_unsaved_guard_on_user_switch, t_xss_text_is_escaped, t_no_driver_info_anywhere,
         t_typing_then_clicking_next_input_keeps_both, t_round_delete, t_pending_branches_shown_grey, t_ui_version_reload_once,
         t_route_kind_and_eta, t_equip_can_edit_eta, t_bulk_confirm_and_no_holdings, t_filters_fit_any_width, t_date_in_title, t_branch_header_stays_on_top,
         t_warning_auto_badge, t_zone_manager, t_snow_forecast, t_private_hq_hidden_in_branch_tab]

# ---------------------------------------------------------------- 서버 모드(가짜 Supabase, tests/_sb_mock.py) — 실제 로그인 권한·저장 함수 호출
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _sb_mock import Mock, install
SERVER_URL = f"http://127.0.0.1:{PORT}/equipment/index.html"

def server_page(b, mock, user):
    p = b.new_page(viewport={"width": 1440, "height": 1000}); p.on("dialog", lambda d: d.accept())
    p.on("pageerror", lambda e: errors.append(f"[server] {e}"))
    install(p, mock, user); p.goto(SERVER_URL); p.wait_for_selector("#matrix tbody tr", timeout=15000); return p

def t_server_equip_confirm(b):
    """지원장비 계정(서울경기)으로 로그인: 자기 기관 장비만, [확정]은 save_fleet 에 바뀐 칸만 보냄. 접속 아이디(데모·미리보기) 선택은 없음"""
    m = Mock(); p = server_page(b, m, "equip-01")
    check(p.locator(".user-box").is_hidden(), "로그인한 화면에는 접속 아이디(데모) 선택이 없음(2026-10-05)")
    tab(p, "fleet"); check(p.locator("[data-vs=V001]").count() == 1 and p.locator("[data-vs=V002]").count() == 0 and p.locator("select[data-rv]").count() == 0, "자기 기관 도공번호·지원 여부만(경로는 관리자)")
    d0 = m.today
    p.select_option("[data-vs=V001]", "M"); p.fill("[data-vp=V001]", "911"); p.press("[data-vp=V001]", "Tab"); p.wait_for_timeout(150); confirm_fleet(p)
    check(m.eq_calls[-1] == ("save_fleet", {"p_vehicles": [{"id": "V001", "status": "M", "plate": "서울경기911"}], "p_routes": []}), m.eq_calls)
    check("확정했습니다" in toast(p), toast(p))
    p.close()
    p = server_page(b, m, "admin-01"); tab(p, "fleet")
    opts = p.locator(rsel("V002", d0) + " option:not([disabled])").all_inner_texts()
    check([o for o in opts if o not in ("지사 선택", "지우기")] == ["충주"], f"관리자: 확정된 지사만: {opts}")
    p.close()

def t_server_branch_save(b):
    """지사 계정: 자기 지사 행만, [저장]은 save_requests 에 바뀐 열만(도착 시각은 ISO)"""
    m = Mock(); m.users["exchungju"]["profile"]["must_change"] = False
    m.round_reqs[0]["confirmed"] = False                                   # 확정된 줄은 잠기므로(2026-10-05) 확정 전 줄로
    p = server_page(b, m, "exchungju"); tab(p, "branch")
    check(set(x.get_attribute("data-rq") for x in p.locator("#branchTable [data-rq]").all()) == {"B019"}, "자기 지사만")
    p.fill("[data-rq=B019][data-f=req_truck]", "5"); p.press("[data-rq=B019][data-f=req_truck]", "Tab"); p.wait_for_timeout(150)
    p.select_option("[data-arr=B019][data-part=m]", "40"); p.wait_for_timeout(150)
    save_branch(p)
    name, body = m.eq_calls[-1]; row = body["p_rows"][0]
    check(name == "save_requests" and body["p_round"] == 1 and set(row) == {"branch_id", "req_truck", "arrive_at"} and row["req_truck"] == 5, m.eq_calls)
    check(row["arrive_at"].endswith("Z") and ev(p, f"localInput('{row['arrive_at']}')").endswith(":40"), row)
    check("저장했습니다" in toast(p), toast(p)); p.close()

def t_server_warning(b):
    """서버 모드: warning_status 를 불러 특보 표시, 확정한 지사는 서버가 고정한 값(warn_*)을 보여 줌"""
    m = Mock(); m.users["exchungju"]["profile"]["must_change"] = False
    p = server_page(b, m, "exchungju"); tab(p, "branch")
    check(any(c[0] == "warning_status" for c in m.eq_calls), "특보 요약을 서버에서 읽음")
    w = p.locator("td[data-wcell='B019'] .wb"); check(w.inner_text() == "대설경보" and "locked" in p.locator("tr[data-b='B019']").get_attribute("class"), w.inner_text())
    check("기준" in p.locator("#wBaseHead").inner_text(), "서버 모드: 대설특보 기준 시각 " + p.locator("#wBaseHead").inner_text())
    p.close()

def t_server_lock_and_confirm_all(b):
    """서버 모드(로그인 화면): 확정하면 그 줄 비활성, 본부 [일괄 확정]은 요청 없는 지사까지, 지사 화면이 모른 채 저장하면 '이미 확정' 안내"""
    m = Mock(); m.users["exchungju"]["profile"]["must_change"] = False
    m.round_reqs[0]["confirmed"] = False
    p = server_page(b, m, "admin-01"); tab(p, "branch"); p.click("#onlyActive"); p.wait_for_timeout(200)
    row = p.locator("tr[data-b='B019']"); en = "input:not([disabled]), select:not([disabled])"
    check(row.locator(en).count() > 3, "확정 전: 입력 가능")
    p.click("[data-confirm='B019']"); p.wait_for_timeout(500)
    check(row.locator(en).count() == 0 and row.locator("[data-unconfirm]").count() == 1, "확정하면 그 줄 비활성")
    check(p.locator(f"#branchTable tr.hq[data-hq='{ev(p, "S.branches.find(x => x.id === 'B019').hq_id")}']").inner_text().count("모두 확정") == 1, "충북(충주 하나)은 모두 확정")
    hq = ev(p, "S.hqs.find(h => h.name === '강원').id"); ids = ev(p, f"S.order.filter(x => x.hq_id === '{hq}').map(x => x.id)")
    p.click(f"[data-confirm-hq='{hq}']"); p.wait_for_timeout(500)
    saved = {r["branch_id"] for r in m.round_reqs if r.get("confirmed")}
    check(set(ids) <= saved and "확정했습니다" in toast(p), f"본부 일괄 확정 = 요청 없던 지사까지 서버에 저장: {sorted(set(ids) - saved)}")
    p.close()
    # 지사 화면: 관리자가 확정하기 전에 열어 둔 화면(아직 확정 전으로 보임)에서 고치고 저장
    m2 = Mock(); m2.users["exchungju"]["profile"]["must_change"] = False; m2.round_reqs[0]["confirmed"] = False
    p = server_page(b, m2, "exchungju"); tab(p, "branch")
    p.fill("[data-rq=B019][data-f=req_truck]", "7"); p.press("[data-rq=B019][data-f=req_truck]", "Tab"); p.wait_for_timeout(150)
    m2.round_reqs[0]["confirmed"] = True                                       # 그사이 관리자가 확정
    save_branch(p)
    check("이미 확정되어 고칠 수 없습니다" in toast(p) and "저장하지 못했습니다" not in toast(p), "안내: " + toast(p))
    check(p.locator("tr[data-b='B019']").locator("input:not([disabled]), select:not([disabled])").count() == 0, "다시 읽어 그 줄 비활성")
    p.close()

SERVER_TESTS = [t_server_equip_confirm, t_server_branch_save, t_server_warning, t_server_lock_and_confirm_all]

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
