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

def open_grid(browser, mock=None):
    p = browser.new_page(bypass_csp=True, viewport={"width": 1400, "height": 900}, accept_downloads=True)
    T.OPENED.append(p)
    p.on("pageerror", lambda e: errors.append(str(e))); p.on("dialog", lambda d: d.accept()); p.route("**/*", T.route)
    SBM.install(p, mock or SBM.Mock(), "admin-01")
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

def admin(p): p.wait_for_timeout(100)      # 이 탭은 관리자에게만 보이고, 관리자 모드 체크박스는 없음(열려 있으면 바로 편집 가능)
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
    check("수집 분할 10번(약 50분)" in p.locator("#gr-summary").inner_text() and "Worker" not in p.locator("#gr-summary").inner_text() and p.locator(".gr-badge.ok").count() == 1 and p.locator(".gr-badge.over").count() == 0, "934칸은 3시간 안에 충분히 끝남(초록), 무료 Worker 문구 없음")
    check(p.locator("#gr-admin").count() == 0 and "관리자 모드" not in p.locator("#view-grid").inner_text(), "관리자 모드 체크박스가 없어야 함")
    check(p.locator("#gr-tools").is_visible() and p.locator("#gr-savebar").is_visible(), "관리자에게는 편집 도구가 바로 보여야 함")
    box = p.locator("#gmap").bounding_box(); check(box and box["width"] > 500 and box["height"] > 400, f"지도 크기 {box}")
    check(p.locator("#gr-tree .jr-br").count() >= 59, "기관 목록")
    check(p.locator("#gr-tree .jr-hqname:has-text('민자')").count() == 0, "민자는 예보 대상이 아니라 목록에 없어야 함")
    p.click(".tab-btn[data-tab=jurisdiction]"); p.wait_for_timeout(500)      # 다른 탭과 함께 동작
    check(p.locator("#view-jurisdiction").is_visible() and p.locator("#view-grid").is_hidden(), "탭 전환")

def t_popup_info_for_unselected_cell(b):
    p = open_grid(b); k = J(p, f"GRID.baseline.cells.find(c => c[2].length)[0] + ',' + GRID.baseline.cells.find(c => c[2].length)[1]")
    J(p, f"(() => {{ {S}.rects['{k}'].fire('mouseover', {{latlng: {S}.rects['{k}'].getBounds().getCenter()}}); return null }})()"); p.wait_for_timeout(200)
    check("편입" in p.locator(".gr-tip").inner_text(), "칸에 마우스를 올리면 편입 정보가 보임")

def clear_toast(p): p.evaluate("(() => { const t = document.getElementById('jr-toast'); if (t) t.style.display = 'none'; })()")
def gsaved(p, n):        # 저장 성공 안내는 "N건 저장되었습니다." 한 줄뿐이어야 함 (설명 창 없음)
    p.wait_for_function("(() => { const t = document.getElementById('jr-toast'); return !!t && t.style.display !== 'none' && /저장되었습니다/.test(t.textContent); })()", timeout=10000)
    check(p.locator("#jr-toast").inner_text() == f"{n}건 저장되었습니다.", p.locator("#jr-toast").inner_text())
    check(p.locator("#gr-modal").is_hidden(), "저장 성공 시 설명 창이 뜨면 안 됨")

def single_cells(p, n):          # 지금 기관이 정확히 한 곳인 칸 n개 (서로 다른 기관에서)
    return J(p, f"""(() => {{ const s = {S}, out = [], seen = new Set();
      s.res.assign.forEach((set, k) => {{ if (set.size === 1 && out.length < {n}) {{ const b = [...set][0]; if (!seen.has(b)) {{ seen.add(b); out.push(k); }} }} }}); return out }})()""")

def t_remove_needs_no_branch_choice(b):
    p = open_grid(b); admin(p); ks = single_cells(p, 3); check(len(ks) == 3, ks)
    owners = [J(p, f"[...{S}.res.assign.get('{k}')][0]") for k in ks]; check(len(set(owners)) == 3, "서로 다른 기관의 칸 3개")
    u0 = union(p); dest0 = p.input_value("#gr-dest") if p.locator("#gr-dest").count() else None
    for k in ks: click_cell(p, k)
    bar = p.locator("#gr-selbar"); check("편입된 칸 3" in bar.inner_text() and "편입 제외 (3칸)" in bar.inner_text(), bar.inner_text())
    p.click("#gr-selbar [data-act=remove]"); p.wait_for_timeout(300)            # 기관을 고르지 않음, 확인 창도 없음
    ev = J(p, f"{S}.pending"); check(len(ev) == 3 and all(e["t"] == "remove" and len(e["cells"]) == 1 for e in ev), ev)
    check(sorted(e["from"] for e in ev) == sorted(owners), "칸이 속한 기관에서 각각 제외되어야 함")
    check(p.locator("#gr-modal").is_hidden() and union(p) == u0 - 3 and J(p, f"Object.keys({S}.selected).length") == 0, "창 없이 바로 반영, 호출 대상 3칸 감소, 선택 해제")
    check(all(J(p, f"{S}.res.assign.get('{k}').size") == 0 for k in ks), "제외된 칸은 어느 기관에도 속하지 않음")
    check(p.locator("#gr-savebar .jr-ev").count() == 3 and "제외" in p.locator("#gr-savebar .jr-ev").first.inner_text(), "변경 대기 목록(오른쪽 위 패널 한 곳)")
    p.click("#gr-savebar [data-act=preview]"); p.wait_for_timeout(250); check(f"{u0} → {u0 - 3}칸" in p.locator("#gr-modal").inner_text(), "미리보기에 합집합 감소")
    p.click("#gr-modal [data-act=close]")
    # 한 기관의 칸을 여러 개 한꺼번에 제외하면 그 기관의 이벤트 하나로 묶임
    p2 = open_grid(b); admin(p2); one = J(p2, f"""(() => {{ const out = []; {S}.res.assign.forEach((set, k) => {{ if (set.size === 1 && [...set][0] === 'B019' && out.length < 4) out.push(k); }}); return out }})()""")
    for k in one: click_cell(p2, k)
    p2.click("#gr-selbar [data-act=remove]"); p2.wait_for_timeout(250); ev2 = J(p2, f"{S}.pending"); check(len(ev2) == 1 and ev2[0]["from"] == "B019" and len(ev2[0]["cells"]) == len(one), ev2)

def t_remove_shared_cells_asks_which_branch(b):
    p = open_grid(b); admin(p)
    sh = J(p, f"""(() => {{ let r = null; {S}.res.assign.forEach((set, k) => {{ if (!r && set.size === 2) r = [k, [...set]]; }}); return r }})()"""); k, brs = sh; check(len(brs) == 2, sh)
    u0 = union(p); sh0 = shared(p); click_cell(p, k); p.click("#gr-selbar [data-act=remove]"); p.wait_for_timeout(250)
    dlg = p.locator("#gr-modal"); check(dlg.is_visible() and "어느 기관에서 제외할까요" in dlg.inner_text() and p.locator("#gr-modal .gr-rmchk").count() == 2, dlg.inner_text()[:150])
    check(all(c.is_checked() for c in p.locator("#gr-modal .gr-rmchk").all()), "기본은 모두 체크")
    check(len(J(p, f"{S}.pending")) == 0, "확인 전에는 변경 대기가 생기지 않음")
    # 한 기관만 제외 → 칸은 남고 공유만 풀림
    p.locator(f"#gr-modal .gr-rmchk[value='{brs[0]}']").uncheck(); p.click("#gr-modal [data-act=removeok]"); p.wait_for_timeout(250)
    left = J(p, f"[...{S}.res.assign.get('{k}')]"); check(left == [brs[0]] and p.locator("#gr-modal").is_hidden(), f"{brs[0]} 만 남아야 함: {left}")
    check(union(p) == u0 and shared(p) == sh0 - 1, "합집합은 그대로, 공유 1칸 감소")
    ev = J(p, f"{S}.pending"); check(len(ev) == 1 and ev[0]["from"] == brs[1] and ev[0]["cells"] == [list(map(int, k.split(",")))], ev)
    # 남은 기관마저 제외(모두 체크) → 칸이 비게 됨
    click_cell(p, k); p.click("#gr-selbar [data-act=remove]"); p.wait_for_timeout(250)
    check(p.locator("#gr-modal").is_hidden() and J(p, f"{S}.res.assign.get('{k}').size") == 0 and union(p) == u0 - 1, "한 기관만 남은 칸은 확인 없이 바로 제외")
    # 확인 창에서 취소 / 아무것도 체크하지 않음
    p2 = open_grid(b); admin(p2); sh2 = J(p2, f"""(() => {{ let r = null; {S}.res.assign.forEach((set, k) => {{ if (!r && set.size === 2) r = k; }}); return r }})()""")
    click_cell(p2, sh2); p2.click("#gr-selbar [data-act=remove]"); p2.wait_for_timeout(200); p2.click("#gr-modal [data-act=close]"); p2.wait_for_timeout(150)
    check(len(J(p2, f"{S}.pending")) == 0 and J(p2, f"Object.keys({S}.selected).length") == 1, "취소하면 변경도 없고 선택도 그대로")
    p2.click("#gr-selbar [data-act=remove]"); p2.wait_for_timeout(200)
    for c in p2.locator("#gr-modal .gr-rmchk").all(): c.uncheck()
    p2.click("#gr-modal [data-act=removeok]"); p2.wait_for_timeout(200); check(len(J(p2, f"{S}.pending")) == 0 and p2.locator("#gr-modal").is_visible(), "아무것도 체크하지 않으면 진행하지 않음")
    # 공유 칸과 한 기관 칸을 섞어 선택: 공유된 기관만 확인, 체크한 기관들에서 각각 제외
    p3 = open_grid(b); admin(p3); a, bb = J(p3, f"""(() => {{ let s2 = null, s1 = null; {S}.res.assign.forEach((set, k) => {{ if (!s2 && set.size === 2) s2 = k; }});
      const two = [...{S}.res.assign.get(s2)]; {S}.res.assign.forEach((set, k) => {{ if (!s1 && set.size === 1 && !two.includes([...set][0])) s1 = k; }}); return [s2, s1] }})()""")      # 공유 칸의 두 기관과 다른 기관의 칸을 고름 → 기관 3곳
    click_cell(p3, a); click_cell(p3, bb); check("편입 제외 (2칸)" in p3.locator("#gr-selbar").inner_text(), p3.locator("#gr-selbar").inner_text()); p3.click("#gr-selbar [data-act=remove]"); p3.wait_for_timeout(200)
    n = p3.locator("#gr-modal .gr-rmchk").count(); check(n == 3, f"기관 3곳이 나열되어야 함 {n}"); p3.click("#gr-modal [data-act=removeok]"); p3.wait_for_timeout(250)
    check(J(p3, f"{S}.res.assign.get('{a}').size") == 0 and J(p3, f"{S}.res.assign.get('{bb}').size") == 0 and len(J(p3, f"{S}.pending")) == 3, "모두 제외")

def t_remove_button_state(b):
    p = open_grid(b); admin(p); ring = ring_cells(p, 1)[0]
    click_cell(p, ring); rb = p.locator("#gr-selbar [data-act=remove]")
    check(rb.is_disabled() and "편입된 칸이 없습니다" in (rb.get_attribute("title") or "") and "편입 제외" == rb.inner_text().strip(), "편입된 칸이 없으면 [편입 제외]는 꺼져 있어야 함")
    check(p.locator("#gr-selbar [data-act=add]").is_enabled(), "편입 추가는 가능")
    asg = single_cells(p, 1)[0]; click_cell(p, asg)
    check(rb.is_enabled() and "편입 제외 (1칸)" in rb.inner_text(), "편입된 칸을 함께 선택하면 켜지고 개수가 보임")
    check("편입할 기관" in p.locator("#gr-selbar").inner_text(), "기관 선택은 '편입할 기관'(추가용)으로만 표시")

def t_add_remove_and_save(b):
    m = SBM.Mock(); p = open_grid(b, mock=m); admin(p)
    check(p.locator("#gr-savebar").is_visible() and p.locator("#gr-savebar [data-act=save]").is_disabled(), "저장 바(변경 없음=비활성)")
    ks = ring_cells(p, 3); br = first_branch(p); u0 = union(p)
    for k in ks: click_cell(p, k)
    check("3칸 선택" in p.locator("#gr-selbar").inner_text(), p.locator("#gr-selbar").inner_text())
    p.select_option("#gr-dest", br); p.click("#gr-selbar [data-act=add]"); p.wait_for_timeout(250)
    ev = J(p, f"{S}.pending"); check(len(ev) == 1 and ev[0]["t"] == "add" and ev[0]["to"] == br and len(ev[0]["cells"]) == 3, ev)
    check(union(p) == u0 + 3, f"호출 대상 {u0} → {union(p)}")
    check(J(p, f"{S}.rects['{ks[0]}'].options.dashArray") == "6,4", "변경 대기는 주황 점선")
    check("변경 대기 1건" in p.locator("#gr-savebar").inner_text() and p.locator("#gr-savebar [data-act=save]").is_enabled(), "대기 목록·저장 활성")
    check(p.locator("#gr-pending [data-act=save], #gr-pending [data-act=cancel], #gr-pending [data-act=preview]").count() == 0, "왼쪽 패널에는 저장·되돌리기 버튼이 없어야 함(버튼은 한 곳)")
    p.click("#gr-savebar [data-act=preview]"); p.wait_for_timeout(250)
    txt = p.locator("#gr-modal").inner_text(); check(f"{u0} → {u0 + 3}칸" in txt, txt); p.click("#gr-modal [data-act=close]")
    p.fill("#gr-reason", "시험 편입")
    clear_toast(p); p.click("#gr-savebar [data-act=save]"); gsaved(p, 1)
    tbl, rows = m.event_calls[-1]; r = rows[-1]
    check(tbl == "grid_events" and r["kind"] == "cellAdd" and r["payload"]["to"] == br and len(r["payload"]["cells"]) == 3 and r["note"] == "시험 편입" and "at" not in r, m.event_calls[-1])
    check(J(p, "GRID.committed.length") == 1 and J(p, "GRID.committed[0].t") == "add" and J(p, "GRID.committed[0].seq") == 1, "저장된 이력이 화면에 반영(예전 형식 add 로 되돌려 읽음)")
    check(len(J(p, f"{S}.pending")) == 0 and union(p) == u0 + 3 and p.locator("#gr-savebar [data-act=save]").is_disabled(), "저장 후 변경 대기가 비고 결과는 그대로 유지")
    # 제외: 방금 넣은 칸 일부를 빼면 합집합이 줄어듦
    click_cell(p, ks[0]); click_cell(p, ks[1]); p.click("#gr-selbar [data-act=remove]"); p.wait_for_timeout(250)      # 기관을 고르지 않고 [편입 제외]만 누름
    check(union(p) == u0 + 1 and len(J(p, f"{S}.pending")) == 1, f"이미 저장한 편입 3칸 중 2칸을 제외하면 대기 1건, 합집합 {union(p)}")
    p.locator("#gr-savebar .jr-x").first.click(); p.wait_for_timeout(200)       # 제외 대기를 취소 → 저장된 편입 3칸이 그대로
    check(len(J(p, f"{S}.pending")) == 0 and union(p) == u0 + 3, "개별 취소하면 저장된 상태로 돌아감")
    click_cell(p, ks[0]); p.click("#gr-selbar [data-act=remove]"); p.wait_for_timeout(200)
    p.click("#gr-savebar [data-act=cancel]"); p.wait_for_timeout(200)
    check(len(J(p, f"{S}.pending")) == 0 and union(p) == u0 + 3, "모두 취소해도 이미 저장된 것은 그대로")

def t_grid_save_failure_and_reload(b):
    m = SBM.Mock(); p = open_grid(b, mock=m); admin(p); ks = ring_cells(p, 2); br = first_branch(p)
    for k in ks: click_cell(p, k)
    p.select_option("#gr-dest", br); p.click("#gr-selbar [data-act=add]"); p.wait_for_timeout(250)
    m.events_fail = ("post", (500, {"message": "boom"}))
    p.click("#gr-savebar [data-act=save]"); p.wait_for_selector("#gr-modal [data-act=retry]", timeout=10000)
    d = p.locator("#gr-modal").inner_text(); check("저장하지 못했습니다" in d and "변경 대기는 그대로" in d, d)
    check(len(J(p, f"{S}.pending")) == 1 and J(p, "GRID.committed.length") == 0, "실패하면 변경 대기가 남아 있어야 함")
    with p.expect_download() as dl: p.click("#gr-modal [data-act=tofile]")
    data = json.load(open(dl.value.path(), encoding="utf-8")); check(data["events"][-1]["t"] == "add" and len(data["events"][-1]["cells"]) == 2, "비상용 파일")
    m.events_fail = None; clear_toast(p); p.click("#gr-modal [data-act=retry]"); gsaved(p, 1)
    # 새로고침해도 서버에 저장된 편입이 그대로: 호출 대상이 늘어난 채로 유지
    u1 = union(p); p.reload(); p.wait_for_function("window.GridUI && GridUI._state().inited", timeout=60000); p.click("#tabGridBtn"); p.wait_for_timeout(700)
    check(union(p) == u1 and J(p, "window.EVENTS_SOURCE.grid") == "server", f"새로고침 뒤에도 저장된 편입 유지 {u1} / {union(p)}")
    # 제외도 이력으로 저장되고 되돌려 읽힘
    click_cell(p, ks[0]); p.click("#gr-selbar [data-act=remove]"); p.wait_for_timeout(250); clear_toast(p); p.click("#gr-savebar [data-act=save]"); gsaved(p, 1)
    check(m.event_calls[-1][1][-1]["kind"] == "cellRemove" and m.event_calls[-1][1][-1]["payload"]["from"] == br and union(p) == u1 - 1, m.event_calls[-1])
    # 다른 관리자 화면에서도 같은 결과
    p2 = open_grid(b, mock=m); check(union(p2) == u1 - 1, "다른 화면에서 열어도 같은 결과")

def t_grid_history_failure_blocks_save(b):
    m = SBM.Mock(); m.events_fail = ("get", (500, {"message": "down"})); p = open_grid(b, mock=m); admin(p)
    check(J(p, "window.EVENTS_SOURCE.grid") == "file-error", "서버 이력을 못 읽으면 파일로 대신")
    k = ring_cells(p, 1)[0]; click_cell(p, k); p.select_option("#gr-dest", first_branch(p)); p.click("#gr-selbar [data-act=add]"); p.wait_for_timeout(250)
    check("서버에서 변경 이력을 불러오지 못해" in p.locator("#gr-pending").inner_text() and p.locator("#gr-savebar [data-act=save]").is_disabled(), "경고 + 저장 차단")

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
    check(p.locator(".gr-badge.over").count() == 1 and "하루 호출 한도" in p.locator("#gr-summary").inner_text(), "한도 초과 안내")
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
    p = b.new_page(bypass_csp=True, viewport={"width": 1400, "height": 900}); T.OPENED.append(p)
    m = SBM.Mock()           # 관할 탭에서 신설 기관을 만들어 서버에 저장해 둔 상태(변경 이력 표에 이미 쌓여 있음)
    m.events["jurisdiction_events"].append({"id": 1, "at": "2026-10-03T01:00:00Z", "by_user": None, "kind": "addBranch", "payload": {"id": "B900", "hq": "강원", "name": "신설시험"}, "note": None})
    p.on("pageerror", lambda e: errors.append(str(e))); p.route("**/*", T.route); SBM.install(p, m, "admin-01"); p.goto(T.URL)
    p.wait_for_function("window.GridUI && GridUI._state().inited", timeout=60000); p.click(".tab-btn[data-tab=grid]"); p.wait_for_timeout(700)
    check(p.locator("#gr-tree .jr-br:has-text('신설시험')").count() == 1, "관할 탭에서 만든 신설 기관이 격자 탭에도 보여야 함")
    check(p.locator("#gr-tree .jr-br:has-text('신설시험') em").count() == 1, "신설 표시")

TESTS = [t_tab_loads, t_popup_info_for_unselected_cell, t_remove_needs_no_branch_choice, t_remove_shared_cells_asks_which_branch, t_remove_button_state, t_add_remove_and_save, t_grid_save_failure_and_reload, t_grid_history_failure_blocks_save, t_share_between_branches, t_box_select, t_budget_levels, t_focus_branch,
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
