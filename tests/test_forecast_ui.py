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
    names = J(p, f"{S}.names") or {}; first = p.locator(".fc-detail tbody tr").first; key = first.get_attribute("data-cell")
    check(len(names) > 2000 and p.locator(".fc-detail thead th").first.inner_text() == "지명" and first.locator("td").first.inner_text().startswith(names[key]) and key in first.locator("td").first.inner_text(),
          f"격자는 지명(data/grid_names.json) + 작은 번호: {first.locator('td').first.inner_text()}")
    tipname = J(p, f"(() => {{ const l = {S}.cells.getLayers().find(l => l.getLatLngs && l.getTooltip()); return l.getTooltip().getContent() }})()")
    check(any(("<b>" + v + "</b>") in tipname for v in set(names.values())), "마우스 말풍선 제목도 지명")
    poly = J(p, f"(() => {{ const ls = {S}.cells.getLayers().filter(l => l.getTooltip && l.getTooltip() && !l.options.permanent && l.getLatLngs); const t = ls[0].getTooltip().getContent(); return t }})()")
    check("<table" in poly and "fc-t3" in poly and "<svg" not in poly and "최저기온" in poly, "격자에 마우스 = 3시간 단위 표(그림 없음): " + poly[:120])
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

def t_pin_chart(b):
    """격자 그림(2026-10-05): 적설 → 강수 → 기온 세 그림을 따로. 격자를 누르면 고정, 그림에 마우스를 올리면 보조선과 '몇 시 · 값', 지도 아무 데나 누르면 닫힘"""
    p, m = open_page(b); p.click(".tab-btn[data-tab=forecast]"); p.wait_for_timeout(600)
    d = bid(p, "대관령"); p.click("#fc-tree [data-fchq='강원']"); p.wait_for_timeout(500); p.click(f"#fc-tree [data-fcbr='{d}']"); p.wait_for_timeout(900)
    tip = J(p, f"(() => {{ const l = {S}.cells.getLayers().find(l => l.getLatLngs && l.getTooltip()); return l.getTooltip().getContent() }})()")
    check("<svg" not in tip and tip.count("fc-t3") == 1, "마우스 말풍선: 그래프 없이 3시간 표 하나")
    tp = p.locator(".leaflet-tooltip.fc-tip")
    sr = J(p, f"(() => {{ const l = {S}.cells.getLayers().find(l => l.getLatLngs && l.getTooltip()); l.openTooltip(); return 1 }})()"); p.wait_for_timeout(200)
    t3 = tp.locator("table.fc-t3")
    heads = [h.strip() for h in t3.locator("thead th:not(.lb)").all_inner_texts()]
    hrs = [h.split("\n")[0] for h in heads]
    check(len(hrs) == 8 and all(int(hrs[i]) == (int(hrs[0]) + 3 * i) % 24 for i in range(8)), f"3시간 표 머리글 = 3시간 간격 8칸 {hrs}")
    rows = [r.locator("th.lb").inner_text() for r in t3.locator("tbody tr").all()]
    check([x.startswith(y) for x, y in zip(rows, ["신적설", "강수", "최저기온"])] == [True] * 3 and len(rows) == 3, f"행: {rows}")
    vals = [float(x) for x in t3.locator("tbody tr").first.locator("td").all_inner_texts() if x not in ("-", "0")]
    tot = float(tp.locator(".fc-tt-sum b").first.inner_text())
    check(abs(sum(vals) - tot) < 0.35, f"3시간 합들의 합 = 24시간 합 ({sum(vals):.1f} ≈ {tot})")
    box = tp.locator(".fc-trend-box").bounding_box(); check(box and 270 <= box["width"] <= 296, f"말풍선 표 폭 약 20% 확대(283px): {box and box['width']}")
    check(not p.locator("#fc-pin").is_visible(), "처음엔 고정 그림 없음")
    key = J(p, f"(() => {{ const l = {S}.cells.getLayers().find(l => l.getLatLngs && l.getTooltip()); l.fire('click'); return {S}.pin }})()"); p.wait_for_timeout(300)
    pin = p.locator("#fc-pin")
    check(pin.is_visible() and key and key in pin.inner_text(), f"격자를 누르면 그 격자 그림 고정: {key}")
    check(pin.locator("svg").count() == 0 and pin.locator("table.fc-t1").count() == 2, "고정 창: 그래프 없이 1시간 표 두 개(12시간씩)")
    h1 = [x.split("\n")[0] for x in pin.locator("table.fc-t1").first.locator("thead th:not(.lb)").all_inner_texts()]
    check(len(h1) == 12 and all(int(h1[i]) == (int(h1[0]) + i) % 24 for i in range(12)), f"1시간 표 머리글 12칸 {h1}")
    pb = pin.locator(".fc-trend-box").bounding_box(); check(pb and 385 <= pb["width"] <= 407, f"고정 창 표 폭 약 20% 확대(396px): {pb and pb['width']}")
    check(J(p, f"(() => {{ const l = {S}.cells.getLayers().find(l => l.getLatLngs && l.options.weight === 4); return !!l }})()"), "고정한 격자는 굵은 테두리")
    p.wait_for_timeout(350); J(p, f"(() => {{ {S}.map.fire('click', {{ latlng: {S}.map.getCenter() }}); return null }})()"); p.wait_for_timeout(200)
    check(not p.locator("#fc-pin").is_visible() and J(p, f"{S}.pin") is None, "지도 아무 데나 누르면 닫힘")
    p.locator(".fc-detail tbody tr").first.click(); p.wait_for_timeout(300)
    check(p.locator("#fc-pin").is_visible(), "옆 표의 격자 줄을 눌러도 고정"); p.click(".fc-pin-x"); p.wait_for_timeout(150); check(not p.locator("#fc-pin").is_visible(), "× 로 닫기")

def t_top_menu(b):
    """위쪽 메뉴(2026-10-10): 1줄 페이지 전환(강설량 측정/장비 지원), 2줄은 그 페이지의 메뉴만. 장비 메뉴는 안쪽 화면의 탭을 대신 누름(안쪽 머리글은 숨김)"""
    p, m = open_page(b); p.wait_for_timeout(500)
    check(p.locator(".topnav").is_visible() and p.locator(".shell").get_attribute("data-page") == "snow", "위쪽 메뉴, 처음은 강설량 측정")
    check(p.locator(".tab-btn[data-tab=map]").is_visible() and not p.locator(".eq-btn[data-eqtab=move]").is_visible(), "강설량 페이지에서는 강설량 메뉴만")
    check(p.evaluate("getComputedStyle(document.body).fontFamily").lstrip('"').startswith('Pretendard') and p.evaluate("document.fonts.check('700 14px Pretendard')"), "글꼴 Pretendard(사이트 안 파일)")
    p.click(".page-btn[data-page=equip]"); p.wait_for_timeout(2500)
    check(p.locator(".eq-btn[data-eqtab=move]").is_visible() and not p.locator(".tab-btn[data-tab=map]").is_visible() and p.locator("#eqLogBtn").is_visible(), "장비 지원 페이지에서는 장비 메뉴만(관리자는 로그 기록도)")
    p.click(".eq-btn[data-eqtab=branch]"); p.wait_for_timeout(800)
    fr = p.frame_locator("#equipFrame")
    check(fr.locator(".tab[data-tab=branch]").get_attribute("aria-selected") == "true" and fr.locator("#panel-branch").is_visible(), "지사별 요청·편성이 열림")
    check(not fr.locator(".topbar").is_visible() and "active" in p.locator(".eq-btn[data-eqtab=branch]").get_attribute("class"), "안쪽 머리글은 숨기고 메뉴에 표시")
    p.click(".eq-btn[data-eqtab=move]"); p.wait_for_timeout(500)
    check(fr.locator("#panel-move").is_visible() and not fr.locator("#panel-branch").is_visible(), "이동 현황으로 바뀜")
    p.click(".page-btn[data-page=snow]"); p.wait_for_timeout(300); p.click(".tab-btn[data-tab=snowtable]"); p.wait_for_timeout(400)
    check(p.locator("#page-snow").is_visible() and not p.locator("#page-equip").is_visible() and p.locator("#view-snowtable").is_visible(), "강설량 측정으로 돌아와 메뉴 고르기")
    p.set_viewport_size({"width": 390, "height": 844}); p.wait_for_timeout(300)
    box = p.locator(".tn-tabs").bounding_box()
    check(p.locator(".tab-btn[data-tab=forecast]").is_visible() and box and box["width"] <= 390 and p.evaluate("document.documentElement.scrollWidth <= 392"), "휴대폰 폭: 메뉴 줄은 옆으로 밀어 보기, 화면은 가로로 넘치지 않음")

TESTS = [t_pin_chart, t_first_tab_and_order, t_levels, t_open_from_equipment, t_branch_user_can_view, t_top_menu]

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
