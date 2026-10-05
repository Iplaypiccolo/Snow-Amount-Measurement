"""
'기관별 24시간 예보' 탭 화면 자동 테스트 — 브라우저로 직접 눌러 봅니다(가짜 서버 tests/_sb_mock.py).
실행 (저장소 맨 위 폴더에서):  pip install playwright && playwright install chromium  →  python tests/test_forecast_ui.py
지도 라이브러리(Leaflet)를 인터넷에서 받습니다. 막힌 곳이면 환경변수 LEAFLET_DIR 를 지정하세요(tests/test_jurisdiction_ui.py 와 같음).
"""
import sys
sys.path.insert(0, __file__.rsplit("/", 1)[0])
import test_jurisdiction_ui as T       # 같은 서버·지도 라이브러리 설정을 재사용
import _sb_mock as SBM
from playwright.sync_api import sync_playwright

check, J = T.check, T.J
results, errors = [], T.errors
S = "ForecastUI._state()"

def open_page(browser, mock=None, user="admin-01", hash=""):
    p = browser.new_page(bypass_csp=True, viewport={"width": 1400, "height": 900})
    T.OPENED.append(p)
    p.on("pageerror", lambda e: errors.append(str(e))); p.on("dialog", lambda d: d.accept()); p.route("**/*", T.route)
    m = mock or SBM.Mock()
    if user != "admin-01": m.users[user]["profile"]["must_change"] = False
    SBM.install(p, m, user)
    p.goto(T.URL + hash); p.wait_for_function("window.ForecastUI && ForecastUI._state().inited", timeout=60000)
    return p, m

def run(name, fn, b):
    try: fn(b); results.append((name, True, ""))
    except Exception as e: results.append((name, False, f"{type(e).__name__}: {str(e)[:300]}"))
    finally:
        while T.OPENED:
            try: T.OPENED.pop().close()
            except Exception: pass

def layers(p): return J(p, f"{S}.cells.getLayers().length")
def labels(p): return p.locator("#fmap .fc-label").count()
def bid(p, name): return J(p, f"(() => {{ const s = {S}.state; return s.order.find(id => s.branches[id].name === '{name}') }})()")

def t_levels(b):
    """전체 = 노선만 / 본부 = 지사 격자(값 없음) / 지사 = 격자마다 적설·강수 값"""
    p, m = open_page(b)
    p.click(".tab-btn[data-tab=forecast]"); p.wait_for_timeout(900)
    check(p.locator("#view-forecast").is_visible(), "탭이 보여야 함")
    check(J(p, f"{S}.lines.getLayers().length") > 900 and layers(p) == 0, "전체: 고속도로 노선만(격자 없음)")
    check("발표 기준" in p.locator("#fc-meta").inner_text() and "24시간 합" in p.locator("#fc-meta").inner_text(), p.locator("#fc-meta").inner_text())
    check(p.locator("#fc-tree [data-fchq]").count() == 9 and p.locator("#fc-tree [data-fcbr]").count() == 0, "처음엔 본부 줄만(민자 없음)")
    check("최저" in p.locator(".fc-cols").inner_text() and "℃" in p.locator("#fc-tree [data-fchq='강원']").inner_text(), "본부 줄에 최저기온")
    check("cm" in p.locator("#fc-tree [data-fchq='강원']").inner_text() and "mm" in p.locator("#fc-tree [data-fchq='강원']").inner_text(), "본부 줄에 적설·강수 최댓값")
    p.click("#fc-tree [data-fchq='강원']"); p.wait_for_timeout(700)
    check(layers(p) > 0 and labels(p) == 0, f"본부: 격자는 보이고 값 글자는 없음({layers(p)}칸)")
    check(m.fc_calls and set(m.fc_calls[-1]) == set(J(p, f"{S}.state.order.filter(id => {S}.state.branches[id].hq === '강원')")), "본부의 지사들 격자만 서버에서 받음")
    d = bid(p, "대관령"); p.click(f"#fc-tree [data-fcbr='{d}']"); p.wait_for_timeout(700)
    n = len([c for c in m.fc_cells if d in c[2]])
    check(labels(p) == n and n > 0, f"지사: 격자마다 값 글자 {labels(p)} / {n}")
    lab = p.locator("#fmap .fc-label").first; check(lab.locator("b").count() == 1 and lab.locator("span").count() == 1 and lab.locator("em").inner_text().endswith("°"), "격자 글자 = 적설·강수·최저기온")
    check(m.fc_series_calls and m.fc_series_calls[-1] == [d], "지사를 열 때만 그 지사 추이를 받음")
    cold = min((c for c in m.fc_cells if d in c[2]), key=lambda c: c[5])
    bf0 = [x for x in m.branch_forecast if x["branch_id"] == d][0]
    check(bf0["min_tmp"] == cold[5] and f"{cold[5]:g}" in p.locator(f"#fc-tree [data-fcbr='{d}']").inner_text(), "지사 줄 최저기온 = 가장 추운 격자")
    check("최저(℃)" in p.locator(".fc-detail thead").inner_text() and "시각" in p.locator(".fc-detail thead").inner_text(), "옆 표에 최저기온·시각")
    poly = J(p, f"(() => {{ const ls = {S}.cells.getLayers().filter(l => l.getTooltip && l.getTooltip() && !l.options.permanent && l.getLatLngs); const t = ls[0].getTooltip().getContent(); return t }})()")
    check("<svg" in poly and "최저기온" in poly and "fc-trend" in poly, "격자에 마우스 = 24시간 추이 그림: " + poly[:120])
    rows = p.locator(".fc-detail tbody tr"); check(rows.count() == n, "옆 표에 격자 목록")
    top = max((c for c in m.fc_cells if d in c[2]), key=lambda c: c[3])
    check(rows.first.locator("td").nth(1).inner_text() == f"{top[3]:.1f}", "적설 많은 격자부터")
    bf = [x for x in m.branch_forecast if x["branch_id"] == d][0]
    check(f"{bf['max_snow_24h']:.1f}" in p.locator(f"#fc-tree [data-fcbr='{d}']").inner_text(), "지사 줄 = 지사 격자 최댓값")
    p.click(f"#fc-tree [data-fcbr='{d}']"); p.wait_for_timeout(500); check(labels(p) == 0 and layers(p) > n, "지사를 다시 누르면 본부 보기로")
    p.click("#fc-tree [data-fchq='강원']"); p.wait_for_timeout(500); check(layers(p) == 0, "본부를 다시 누르면 전체(노선만)")

def t_open_from_equipment(b):
    """장비 지원 화면에서 그 지사로 바로 오기: SSOpenForecast(바깥 화면 함수)와 #fc=지사번호 주소"""
    p, m = open_page(b)
    d = bid(p, "춘천")
    J(p, f"(() => {{ SSOpenForecast('{d}'); return null }})()"); p.wait_for_timeout(1200)
    check(p.locator(".tab-btn[data-tab=forecast]").get_attribute("class").find("active") >= 0 and J(p, f"{S}.focus") == d, "강설량 측정 → 기관별 24시간 예보 → 춘천")
    check(labels(p) == len([c for c in m.fc_cells if d in c[2]]), "그 지사 격자 값이 보임")
    p2, _ = open_page(b, hash=f"#fc={d}"); p2.wait_for_timeout(1500)
    check(J(p2, f"{S}.focus") == d and p2.locator("#view-forecast").is_visible(), "#fc=지사번호 로 열어도 그 지사")

def t_branch_user_can_view(b):
    """지사 계정도 볼 수 있음(읽기만)"""
    p, m = open_page(b, user="exchungju")
    p.click(".tab-btn[data-tab=forecast]"); p.wait_for_timeout(800)
    check(p.locator("#fc-tree [data-fchq]").count() == 9, "지사 계정도 목록이 보임")

def t_first_tab_and_order(b):
    """강설량 측정 탭 순서(2026-10-05): 기관별 24시간 예보(처음 열림) → 연도별 신적설 → 관측소 지도 → 관할 → 데이터 출처 → 예보 격자 편입(권한)"""
    p, m = open_page(b); p.wait_for_timeout(800)
    tabs = [t for t in p.locator(".tab-btn").all_inner_texts()]
    check(tabs == ["기관별 24시간 예보", "연도별 신적설", "관측소 지도", "기관별 관할 고속도로", "데이터 출처", "예보 격자 편입"], tabs)
    check("active" in p.locator(".tab-btn[data-tab=forecast]").get_attribute("class") and p.locator("#view-forecast").is_visible() and not p.locator("#view-snowtable").is_visible(), "처음 열면 기관별 24시간 예보")
    check(J(p, f"{S}.lines.getLayers().length") > 900, "예보 지도가 그려짐")
    p.click(".tab-btn[data-tab=snowtable]"); p.wait_for_timeout(300)
    check(p.locator("#snowTableWrap table").is_visible() and not p.locator("#view-forecast").is_visible(), "연도별 신적설로 바꾸면 표")
    p2, _ = open_page(b, user="exchungju"); p2.wait_for_timeout(500)
    check(not p2.locator(".tab-btn[data-tab=grid]").is_visible() and p2.locator("#view-forecast").is_visible(), "권한 없으면 격자 편입 탭 없음, 첫 탭은 같음")

TESTS = [t_first_tab_and_order, t_levels, t_open_from_equipment, t_branch_user_can_view]

if __name__ == "__main__":
    only = sys.argv[1:]
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        for fn in TESTS:
            if not only or fn.__name__ in only: run(fn.__name__, fn, b)
        b.close()
    ok = sum(1 for _, o, _ in results if o)
    for name, o, msg in results: print(("PASS " if o else "FAIL ") + name + ("" if o else f"  → {msg}"))
    errs = [e for e in errors if "favicon" not in e]
    if errs: print("\n페이지 오류:", *errs[:10], sep="\n  ")
    print(f"\n{ok}/{len(results)} 통과" + ("" if not errs else f", 페이지 오류 {len(errs)}건"))
    sys.exit(0 if ok == len(results) and not errs else 1)
