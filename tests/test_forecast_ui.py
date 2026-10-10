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
    check([x.startswith(y) for x, y in zip(rows, ["신적설", "강수", "확률", "최저기온"])] == [True] * 4 and len(rows) == 4, f"행(강수확률 포함): {rows}")
    vals = [float(x) for x in t3.locator("tbody tr").first.locator("td").all_inner_texts() if x not in ("-", "0")]
    import re as _re
    tiptext = tp.inner_text(); tot = float(_re.search(r"24시간 적설 ([\d.]+)cm", tiptext).group(1))
    check("24시간 합" not in tiptext and "누르면" not in tiptext and tp.locator(".fc-tt-sum").count() == 0 and "확률 최고" in tiptext, "말풍선: 표 아래 '24시간 합'부터는 없음(위 요약에 강수확률): " + tiptext[:80].replace("\n", " "))
    check(abs(sum(vals) - tot) < 0.35, f"3시간 합들의 합 = 24시간 합 ({sum(vals):.1f} ≈ {tot})")
    box = tp.locator(".fc-trend-box").bounding_box(); check(box and 270 <= box["width"] <= 296, f"말풍선 표 폭 약 20% 확대(283px): {box and box['width']}")
    # 지사를 고르면 눈여겨볼 격자(적설이 가장 많은 칸)가 고른 채로 열림(2026-10-10)
    top = max((c for c in m.fc_cells if d in c[2]), key=lambda c: (c[3], c[4], -c[5])); tk = f"{top[0]},{top[1]}"      # 같은 적설이면 강수 많은 칸 → 더 추운 칸(옆 표 순서와 같음)
    pin0 = p.locator("#fc-pin")
    check(pin0.is_visible() and J(p, f"{S}.pin") == tk and "적설이 가장 많은 칸" in pin0.inner_text(), f"지사를 열면 적설 최대 칸이 고정됨: {J(p, f'{S}.pin')} / {tk}")
    check(p.locator(".fc-detail tr.sel").count() == 1 and p.locator(".fc-detail tbody tr").first.get_attribute("class") == "sel" and p.locator(".fc-detail tr.sel").get_attribute("data-cell") == tk, "옆 표 맨 윗줄이 그 칸이고 표시됨")
    # 표 머리글 날짜: 맨 처음 칸과 날짜가 바뀌는(00시) 칸에만 — 둘째 줄 첫 칸에는 붙이지 않음
    def heads(i): return [(x.split("\n")[0], "/" in x) for x in pin0.locator("table.fc-t1").nth(i).locator("thead th:not(.lb)").all_inner_texts()]
    h1, h2 = heads(0), heads(1)
    check(h1[0][1] and all(dt == (hr == "00") for hr, dt in h1[1:]), f"첫 줄: 첫 칸과 00시에만 날짜 {h1}")
    check(all(dt == (hr == "00") for hr, dt in h2), f"둘째 줄: 00시에만 날짜(첫 칸이라고 붙이지 않음) {h2}")
    leg = p.locator("#fc-legend")
    check(leg.locator(".fc-key").inner_text().split() == ["적설", "강수", "확률", "기온"] and leg.locator(".fc-ramp li").count() == 6 and "cm" not in leg.inner_text() and "mm" not in leg.inner_text() and "마우스" not in leg.inner_text(),
          "범례: 숫자 순서(적설·강수 확률·기온) + 적설량 색띠만: " + leg.inner_text().replace("\n", " "))
    prow = [r.locator("th.lb").inner_text() for r in pin0.locator("table.fc-t1").first.locator("tbody tr").all()]
    check(len(prow) == 4 and prow[2].startswith("확률") and "확률 최고" in pin0.locator(".fc-tt-sum").inner_text(), f"고정 창 표에 강수확률 줄·합계 줄에 확률 최고: {prow}")
    mine = [c for c in m.fc_cells if d in c[2]]; hot = [c for c in mine if c[3] > 0 or c[4] > 0]
    check(p.locator("#fmap .fc-label.hot").count() == len(hot) and p.locator("#fmap .fc-label.calm").count() == len(mine) - len(hot) and len(hot) > 0, f"지도 칸: 적설·강수가 있는 칸만 크게({len(hot)}칸), 나머지는 흐리게")
    lab = p.locator("#fmap .fc-label").first
    check(lab.locator("span i").inner_text().endswith("%") and p.locator("#fmap .fc-label .z").count() > 0, "칸 글자에 강수확률(%), 0 인 숫자는 흐리게")
    top_pop = max(c[8] for c in mine)
    check("확률" in p.locator(".fc-cols").inner_text() and f"{top_pop}%" in p.locator(f"#fc-tree [data-fcbr='{d}']").inner_text() and "확률(%)" in p.locator(".fc-detail thead").inner_text(), "옆 목록: 지사 줄에 최고 강수확률, 격자 표에 확률 칸")
    p.click(".fc-pin-x"); p.wait_for_timeout(150)
    check(not p.locator("#fc-pin").is_visible() and p.locator(".fc-detail tr.sel").count() == 0, "× 로 닫으면 고정 없음")
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

def t_auto_pick(b):
    """지사를 고르면 격자 하나를 고른 채로 엶(2026-10-10). 순서: ① 적설 ② 강수 + 24시간 안에 한 번이라도 4℃ 이하 ③ 강수 ④ 최저 4℃ 이하. 아무것도 없으면 고르지 않음"""
    def case(setup, name):
        m = SBM.Mock(); d = next(x["branch_id"] for x in m.branch_forecast if sum(1 for c in m.fc_cells if x["branch_id"] in c[2]) >= 5); cs = [c for c in m.fc_cells if d in c[2]]
        for c in cs: c[3] = 0; c[4] = 0; c[5] = 10.0; c[7] = {"s": [0] * 24, "p": [0] * 24, "t": [10.0] * 24, "r": [0] * 24}; c[8] = 0      # 모두 맑고 따뜻하게 만든 뒤 경우마다 바꿈
        want = setup(cs)
        p, _ = open_page(b, mock=m); J(p, f"(() => {{ SSOpenForecast('{d}'); return null }})()"); p.wait_for_timeout(1300)
        got = J(p, f"{S}.pin"); key = want and f"{want[0][0]},{want[0][1]}"
        check(J(p, f"{S}.focus") == d and got == key, f"{name}: {got} / {key}")
        if want: check(want[1] in p.locator("#fc-pin").inner_text() and p.locator(".fc-detail tr.sel").get_attribute("data-cell") == key, f"{name}: 고정 창에 까닭·옆 표 표시")
        else: check(not p.locator("#fc-pin").is_visible(), f"{name}: 고정 창 없음")
        p.close()
    def rain(c, mm, t):                                    # 2~4시에 비 mm, 그 칸 기온 t
        c[4] = mm; c[5] = t; c[7] = {"s": [0] * 24, "p": [round(mm / 3, 1) if 2 <= i < 5 else 0 for i in range(24)], "t": [t] * 24, "r": [60] * 24}
    def s1(cs): rain(cs[0], 9.0, 1.0); cs[1][3] = 0.5; cs[1][7]["s"][5] = 0.5; cs[2][3] = 2.0; cs[2][7]["s"][5] = 2.0; return (cs[2], "적설이 가장 많은 칸")
    def s2(cs):                                            # 비 올 땐 10℃ 지만 밤(20시)에 2℃ 로 내려가는 칸도 ② — 24시간 안에 한 번이라도 4℃ 이하
        rain(cs[0], 9.0, 10.0); cs[0][5] = 2.0; cs[0][7]["t"][20] = 2.0; rain(cs[1], 3.0, 4.0); rain(cs[2], 12.0, 10.0); cs[3][5] = -8.0; cs[3][7]["t"] = [-8.0] * 24
        return (cs[0], "4℃ 이하 + 강수가 가장 많은 칸")
    def s3(cs): rain(cs[0], 2.0, 10.0); rain(cs[1], 9.0, 4.5); cs[2][5] = -8.0; cs[2][7]["t"] = [-8.0] * 24; return (cs[1], "강수가 가장 많은 칸")
    def s4(cs): cs[0][5] = 4.0; cs[0][7]["t"] = [4.0] * 24; cs[1][5] = -3.0; cs[1][7]["t"] = [-3.0] * 24; return (cs[1], "기온이 가장 낮은 칸")
    def s5(cs): cs[0][5] = 4.5; return None
    case(s1, "① 적설(강수·기온보다 먼저)"); case(s2, "② 강수 + 4℃ 이하(비가 더 많은 따뜻한 칸·더 추운 맑은 칸보다 먼저, 같은 시각이 아니어도)"); case(s3, "③ 강수(4.5℃ 는 해당 없음)")
    case(s4, "④ 최저 4℃ 이하"); case(s5, "해당 없음")

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
    an = "getComputedStyle(document.getElementById('view-snowtable')).animationName"
    check(p.evaluate(an) == "ssFade", "움직임 4: 화면 바꿀 때 0.15초 나타나기")
    p.emulate_media(reduced_motion="reduce"); p.wait_for_timeout(100)
    check(p.evaluate(an) == "none", "컴퓨터의 '동작 줄이기'를 켜면 움직임 없음"); p.emulate_media(reduced_motion="no-preference")
    p.set_viewport_size({"width": 390, "height": 844}); p.wait_for_timeout(300)
    box = p.locator(".tn-tabs").bounding_box()
    check(p.locator(".tab-btn[data-tab=forecast]").is_visible() and box and box["width"] <= 390 and p.evaluate("document.documentElement.scrollWidth <= 392"), "휴대폰 폭: 메뉴 줄은 옆으로 밀어 보기, 화면은 가로로 넘치지 않음")

TESTS = [t_pin_chart, t_first_tab_and_order, t_levels, t_open_from_equipment, t_branch_user_can_view, t_auto_pick, t_top_menu]

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
