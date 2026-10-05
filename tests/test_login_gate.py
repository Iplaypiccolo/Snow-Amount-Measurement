"""
첫 화면 로그인 잠금 자동 테스트 — 브라우저로 직접 눌러 봅니다. (Supabase 는 가짜 서버 tests/_sb_mock.py)
확인하는 것: 로그인 전에는 화면·자료가 안 보이고 불러오지도 않음 / 아이디 저장 / 자동 로그인(기간·다른 컴퓨터에서는 안 됨) / 임시 비밀번호·미등록·비활성 계정 /
             서버가 로그인을 끊으면 다시 로그인 / 연결 문제 / 다른 탭 로그아웃 동기화 / 장비 지원 화면 잠금 / 저장소에 비밀번호가 없음
실행 (저장소 맨 위 폴더에서):  python tests/test_login_gate.py     (지도 라이브러리는 tests/test_jurisdiction_ui.py 와 같은 설정을 씀)
"""
import json, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_jurisdiction_ui as T          # 같은 서버·지도 라이브러리 설정
import _sb_mock as SBM
from playwright.sync_api import sync_playwright

results, errors = [], T.errors
def check(c, m="실패"):
    if not c: raise AssertionError(m)
DAY = 86400000

def open_site(ctx, mock, url=None, reqs=None):
    p = ctx.new_page(); p.set_viewport_size({"width": 1400, "height": 900})
    p.on("pageerror", lambda e: errors.append(str(e))); p.on("dialog", lambda d: d.accept())
    if reqs is not None: p.on("request", lambda r: reqs.append(r.url))
    p.route("**/*", T.route); p.route(SBM.SB + "/**", mock.handle)
    p.goto(url or T.URL); p.wait_for_selector("#ssGate:not([hidden]), body.authed", timeout=20000); p.wait_for_timeout(300)
    return p

def typed_login(p, user, pw, remember=None, auto=None):
    p.fill("#ssU", user); p.fill("#ssP", pw)
    if remember is not None: p.set_checked("#ssRemember", remember)
    if auto is not None: p.set_checked("#ssAuto", auto)
    p.click("#ssGo"); p.wait_for_timeout(500)

def ls(p, k): return p.evaluate("k => localStorage.getItem(k)", k)
def ss(p, k): return p.evaluate("k => sessionStorage.getItem(k)", k)
def in_app(p): return p.evaluate("document.body.classList.contains('authed')")
def data_fetched(reqs): return [u for u in reqs if "/data/" in u and u.endswith(".json")]

def run(name, fn, browser):
    m = SBM.Mock(); ctx = browser.new_context(accept_downloads=True)
    try: fn(browser, ctx, m); results.append((name, True, ""))
    except Exception as e: results.append((name, False, f"{type(e).__name__}: {str(e)[:300]}"))
    finally:
        try: ctx.close()
        except Exception: pass

def t_locked_before_login(b, ctx, m):
    reqs = []; p = open_site(ctx, m, reqs=reqs)
    check(p.locator("#ssGate").is_visible() and p.locator("#ssU").is_visible() and p.locator("#ssP").is_visible(), "로그인 화면이 보여야 함")
    check(not in_app(p) and not p.locator(".pagebar").is_visible() and not p.locator("#page-snow").is_visible(), "앱 화면이 보이면 안 됨")
    check(not data_fetched(reqs), f"로그인 전에 자료를 불러옴: {data_fetched(reqs)}")
    check(p.evaluate("typeof window.HIERARCHY === 'undefined' && typeof window.JURIS === 'undefined'"), "로그인 전에 자료가 메모리에 있음")
    check(ls(p, "ss_session") is None and ss(p, "ss_session") is None, "로그인 정보가 없어야 함")
    check(p.locator("#ssAuto").is_checked() is False and "공용 컴퓨터" not in p.locator("#ssGate").inner_text(), "자동 로그인은 기본 꺼짐(설명 글 없음, 2026-10-05)")

def t_wrong_and_empty(b, ctx, m):
    p = open_site(ctx, m)
    p.click("#ssGo"); check("입력하세요" in p.locator(".ss-msg").inner_text(), "빈 입력")
    typed_login(p, "admin-01", "wrong-password-xx"); check("올바르지 않습니다" in p.locator(".ss-msg.err").inner_text(), "틀린 비밀번호 문구")
    check(p.input_value("#ssP") == "" and ls(p, "ss_session") is None and ss(p, "ss_session") is None, "실패 후 비밀번호 칸이 비고 저장되는 것이 없어야 함")
    typed_login(p, "admin-01", "wrong-password-yy"); check(not in_app(p), "여전히 잠겨 있어야 함")

def t_login_session_only(b, ctx, m):
    reqs = []; p = open_site(ctx, m, reqs=reqs)
    typed_login(p, "admin-01", SBM.ADMIN_PW); p.wait_for_selector(".pagebar", state="visible")
    check(in_app(p) and p.locator("#ssGate").is_hidden(), "로그인 뒤 화면이 열려야 함")
    check("관리자1" in p.locator("#ssUser").inner_text() and p.locator("#ssUser a").count() == 1 and p.locator("#ssLogout").count() == 1, p.locator("#ssUser").inner_text())
    p.wait_for_function("window.GridUI && GridUI._state().inited", timeout=60000)
    check(len(data_fetched(reqs)) >= 5, "로그인 뒤에는 자료를 불러와야 함")
    check(ss(p, "ss_session") and ls(p, "ss_session") is None and ls(p, "ss_saved_user") is None, "기본은 탭을 닫으면 사라지는 저장소에만 저장")
    p.reload(); p.wait_for_selector("body.authed", timeout=20000); check(p.locator(".pagebar").is_visible(), "새로고침해도 로그인 유지(같은 탭)")
    p2 = open_site(ctx, m); check(p2.locator("#ssGate").is_visible() and not in_app(p2), "새 탭에서는 다시 로그인해야 함(자동 로그인을 안 켰으므로)")

def t_remember_id(b, ctx, m):
    p = open_site(ctx, m); typed_login(p, "admin-01", SBM.ADMIN_PW, remember=True, auto=False); p.wait_for_selector(".pagebar", state="visible")
    check(ls(p, "ss_saved_user") == "admin-01" and SBM.ADMIN_PW not in p.evaluate("JSON.stringify(localStorage)"), "아이디만 저장되어야 함")
    p.click("#ssLogout"); p.wait_for_selector("#ssU")
    check(p.input_value("#ssU") == "admin-01" and p.locator("#ssRemember").is_checked() and p.input_value("#ssP") == "", "로그아웃 뒤에도 아이디가 채워져 있어야 함")
    check(p.evaluate("document.activeElement.id") == "ssP", "아이디가 있으면 비밀번호 칸에 커서")
    check(ls(p, "ss_session") is None and ss(p, "ss_session") is None, "로그아웃하면 로그인 정보는 지워짐")
    typed_login(p, "admin-01", SBM.ADMIN_PW, remember=False); p.wait_for_selector(".pagebar", state="visible")
    check(ls(p, "ss_saved_user") is None, "체크를 풀고 로그인하면 저장된 아이디가 지워져야 함")
    p.click("#ssLogout"); p.wait_for_selector("#ssU"); check(p.input_value("#ssU") == "", "다음엔 빈칸")
    typed_login(p, "admin-01", "wrong-pass-zzz", remember=True); check(p.input_value("#ssU") == "admin-01" and p.locator("#ssRemember").is_checked(), "로그인 실패해도 입력한 아이디·체크는 유지")

def t_auto_login(b, ctx, m):
    p = open_site(ctx, m); typed_login(p, "admin-01", SBM.ADMIN_PW, auto=True); p.wait_for_selector(".pagebar", state="visible")
    s = json.loads(ls(p, "ss_session")); left = (s["auto_until"] - time.time() * 1000) / DAY
    check(s["persist"] is True and 6.9 < left <= 7.01, f"관리자는 7일: {left:.2f}일"); check(ss(p, "ss_session") is None, "자동 로그인은 탭을 닫아도 남는 저장소에")
    check("password" not in json.dumps(s).lower() and SBM.ADMIN_PW not in json.dumps(s), "비밀번호가 저장되면 안 됨")
    reqs = []; p2 = open_site(ctx, m, reqs=reqs); p2.wait_for_selector("body.authed", timeout=20000)
    check(p2.locator("#ssGate").is_hidden() and "관리자1" in p2.locator("#ssUser").inner_text(), "새 탭에서 비밀번호 없이 바로 들어가야 함"); p2.wait_for_function("window.GridUI && GridUI._state().inited", timeout=60000)
    ctx2 = b.new_context()
    try: p3 = open_site(ctx2, m); check(p3.locator("#ssGate").is_visible() and not in_app(p3), "다른 브라우저(다른 컴퓨터)에서는 로그인해야 함")
    finally: ctx2.close()
    # 일반 계정은 30일
    m.users["equip-01"]["profile"]["must_change"] = False
    p4 = open_site(ctx, m); p4.evaluate("localStorage.clear()"); p4.reload(); p4.wait_for_selector("#ssU")
    typed_login(p4, "equip-01", "Equip#Pass-8821xY", auto=True); p4.wait_for_selector(".pagebar", state="visible")
    left = (json.loads(ls(p4, "ss_session"))["auto_until"] - time.time() * 1000) / DAY; check(29.9 < left <= 30.01, f"일반 계정은 30일: {left:.2f}")
    check(p4.locator("#ssUser a").count() == 0, "관리자가 아니면 '관리' 링크가 없어야 함")

def t_auto_login_expired(b, ctx, m):
    s = SBM.session_for(m, "admin-01", auto_days=-1)           # 자동 로그인 기간이 이미 지남
    ctx.add_init_script("localStorage.setItem('ss_session', %s)" % json.dumps(json.dumps(s)))
    p = open_site(ctx, m); check(p.locator("#ssGate").is_visible() and not in_app(p), "기간이 지나면 로그인해야 함"); check(ls(p, "ss_session") is None, "만료된 로그인 정보는 지워져야 함")

def t_server_revoked(b, ctx, m):
    s = SBM.session_for(m, "admin-01"); s["expires_at"] = int(time.time() * 1000) + 1000; s["refresh_token"] = "revoked-by-server"     # 서버가 로그인을 끊은 뒤(비밀번호 변경·비활성화)
    ctx.add_init_script("localStorage.setItem('ss_session', %s)" % json.dumps(json.dumps(s)))
    p = open_site(ctx, m); check(p.locator("#ssGate").is_visible() and "만료" in p.locator(".ss-msg").inner_text(), p.locator("#ssGate").inner_text()); check(not in_app(p) and ls(p, "ss_session") is None, "잠겨 있고 정보가 지워져야 함")

def t_special_accounts(b, ctx, m):
    reqs = []; p = open_site(ctx, m, reqs=reqs)
    typed_login(p, "exchungju", SBM.TEMP_PW, auto=True)
    check("새 비밀번호 정하기" in p.locator("#ssGate").inner_text() and not in_app(p), "임시 비밀번호 계정은 화면을 못 씀")
    check(p.locator("#ssGate a.ss-btn").get_attribute("href") == "admin/" and not data_fetched(reqs), "비밀번호 변경 화면으로 안내하고 자료는 불러오지 않음")
    p.click("#ssOther"); p.wait_for_selector("#ssU"); check(ls(p, "ss_session") is None, "다른 계정으로 로그인 누르면 정보 삭제")
    typed_login(p, "stranger", "Stranger#Pass-123"); check("등록되어 있지 않습니다" in p.locator(".ss-msg.warn").inner_text() and ls(p, "ss_session") is None, "프로필 없는 가입자")
    typed_login(p, "exdisabled", "Disabled#Pass-123q"); check("비활성화된 계정" in p.locator(".ss-msg.warn").inner_text() and ls(p, "ss_session") is None and not in_app(p), "비활성 계정")
    check(not data_fetched(reqs), "끝까지 자료를 불러오지 않아야 함")

def t_branch_set_by_admin_enters_main_directly(b, ctx, m):
    """관리자가 정한 비밀번호(변경 요구 없음)로 지사 담당자가 첫 화면에 바로 들어감"""
    x = m.users["exchungju"]; x["password"] = "Snow#Ride-2030k"; x["profile"]["must_change"] = False
    reqs = []; p = open_site(ctx, m, reqs=reqs); typed_login(p, "exchungju", "Snow#Ride-2030k"); p.wait_for_selector(".pagebar", state="visible")
    check(in_app(p) and "충주지사" in p.locator("#ssUser").inner_text() and "새 비밀번호를 먼저" not in p.locator("body").inner_text(), "변경 요구 없이 바로 들어가야 함")
    p.wait_for_function("window.JurisdictionUI && JurisdictionUI._state().inited", timeout=60000)      # 지사 계정에는 예보 격자 편입 화면이 없으므로 관할 화면으로 확인
    check(p.locator("#tabGridBtn").count() == 0, "지사 계정에는 예보 격자 편입 탭이 없어야 함")

def t_cross_tab_logout(b, ctx, m):
    p1 = open_site(ctx, m); typed_login(p1, "admin-01", SBM.ADMIN_PW, auto=True); p1.wait_for_selector(".pagebar", state="visible")
    p2 = open_site(ctx, m); p2.wait_for_selector("body.authed", timeout=20000)
    p1.click("#ssLogout"); p1.wait_for_selector("#ssU"); p2.wait_for_selector("#ssGate:not([hidden]) #ssU", timeout=15000)
    check(not in_app(p2), "다른 탭에서 로그아웃하면 이 탭도 잠겨야 함")

def t_network_problems(b, ctx, m):
    s = SBM.session_for(m, "admin-01"); ctx.add_init_script("if (!localStorage.getItem('ss_session')) localStorage.setItem('ss_session', %s)" % json.dumps(json.dumps(s)))
    m.down = True; p = open_site(ctx, m)
    check("서버에 연결하지 못했습니다" in p.locator("#ssGate").inner_text() and not in_app(p), "연결이 안 되면 안내"); check(ls(p, "ss_session") is not None, "연결 문제로 로그인 정보를 지우면 안 됨")
    m.down = False; p.click("#ssRetry"); p.wait_for_selector("body.authed", timeout=20000); check(p.locator(".pagebar").is_visible(), "다시 시도하면 들어가져야 함")
    ctx2 = b.new_context()
    try:
        m.down = True; p2 = open_site(ctx2, m); typed_login(p2, "admin-01", SBM.ADMIN_PW); check("연결할 수 없습니다" in p2.locator(".ss-msg.warn").inner_text() and not in_app(p2), "로그인 중 연결 문제")
    finally: ctx2.close()

def t_equipment_gate(b, ctx, m):
    ctx_new = b.new_context()
    try:
        p = ctx_new.new_page(); p.route("**/*", T.route); p.goto(T.URL.replace("index.html", "equipment/index.html"), wait_until="commit"); p.wait_for_timeout(800)   # 안내만 보이고 나머지 불러오기를 멈추므로 load 이벤트를 기다리지 않음
        check("로그인이 필요합니다" in p.locator("body").inner_text() and p.locator(".tab").count() == 0, "로그인 없이 직접 열면 안내만")
        check(p.locator("a[target=_top]").get_attribute("href") == "../", "첫 화면으로 가는 링크")
    finally: ctx_new.close()
    p = open_site(ctx, m); typed_login(p, "admin-01", SBM.ADMIN_PW); p.wait_for_selector(".pagebar", state="visible"); p.click(".page-btn[data-page=equip]"); p.wait_for_timeout(1200)
    check(p.frame_locator("#equipFrame").locator(".tab").count() >= 3, "로그인한 뒤 첫 화면에서 들어가면 장비 지원 화면이 열려야 함")

def t_logout_from_equip_then_login_starts_first_screen(b, ctx, m):
    """(사용자 신고 2026-10-05) 장비 지원에서 로그아웃한 뒤 다시 로그인하면 '첫 화면으로 가서 로그인하세요'만 계속 나옴
       → 로그아웃하면 주소의 #equip 을 지우고, 다시 로그인하면 항상 첫 화면(강설량 측정)부터. 장비 지원은 로그인한 뒤에만 불러옴"""
    p = open_site(ctx, m); typed_login(p, "admin-01", SBM.ADMIN_PW); p.wait_for_selector(".pagebar", state="visible")
    p.click(".page-btn[data-page=equip]"); p.wait_for_timeout(1200); check(p.url.endswith("#equip"), "장비 지원을 열면 주소에 #equip")
    p.click("#ssLogout"); p.wait_for_selector("#ssU", timeout=20000); p.wait_for_timeout(300)
    check("#equip" not in p.url and not p.locator("#equipFrame").get_attribute("src"), "로그아웃하면 #equip 없이, 장비 지원은 아직 안 불러옴")
    typed_login(p, "admin-01", SBM.ADMIN_PW); p.wait_for_selector(".pagebar", state="visible"); p.wait_for_timeout(500)
    check(p.locator("#page-snow").is_visible() and p.locator(".page-btn[data-page=snow]").get_attribute("class").find("active") >= 0, "다시 로그인하면 첫 화면(강설량 측정)")
    p.click(".page-btn[data-page=equip]"); p.wait_for_timeout(1500)
    fr = p.frame_locator("#equipFrame")
    check(fr.locator(".tab").count() >= 3 and "로그인이 필요합니다" not in fr.locator("body").inner_text(), "장비 지원이 정상으로 열림")
    # 예전 주소(#equip)로 바로 열어도 로그인 전에는 장비 지원을 불러오지 않고, 로그인하면 첫 화면부터
    p.click("#ssLogout"); p.wait_for_selector("#ssU", timeout=20000)
    p.goto(T.URL + "?again=1#equip"); p.wait_for_selector("#ssU", timeout=20000)      # 새로 불러오기(같은 주소에 #만 바꾸면 다시 불러오지 않음)
    check(not p.locator("#equipFrame").get_attribute("src"), "로그인 전에는 장비 지원을 불러오지 않음")
    typed_login(p, "admin-01", SBM.ADMIN_PW); p.wait_for_selector(".pagebar", state="visible"); p.wait_for_timeout(500)
    check(p.locator("#page-snow").is_visible() and "#equip" not in p.url, "예전 주소로 열어도 첫 화면부터")

def t_no_secrets_and_safe_text(b, ctx, m):
    m.add("exxss", "<img src=x onerror=window.__x=1>", "branch", "B001", "Xss#Pass-998877aZ"); m.users["exxss"]["profile"]["must_change"] = False
    p = open_site(ctx, m); typed_login(p, "exxss", "Xss#Pass-998877aZ", remember=True, auto=True); p.wait_for_selector(".pagebar", state="visible")
    check(p.evaluate("window.__x") is None and p.locator("#ssUser img").count() == 0 and "<img" in p.locator("#ssUser").inner_text(), "이름에 태그가 있어도 글자로만 보여야 함")
    dump = p.evaluate("JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), document.documentElement.outerHTML.length, location.href])")
    check("Xss#Pass" not in dump, "저장소·주소에 비밀번호가 없어야 함")
    check(sorted(p.evaluate("Object.keys(localStorage)")) == ["ss_saved_user", "ss_session"], "저장소에 있는 것은 로그인 정보와 아이디뿐이어야 함")
    check("Xss#Pass" not in p.evaluate("document.body.innerHTML"), "화면 어디에도 비밀번호가 없어야 함")

TESTS = [t_locked_before_login, t_wrong_and_empty, t_login_session_only, t_remember_id, t_auto_login, t_auto_login_expired, t_server_revoked, t_special_accounts,
         t_branch_set_by_admin_enters_main_directly, t_cross_tab_logout, t_network_problems, t_equipment_gate, t_logout_from_equip_then_login_starts_first_screen, t_no_secrets_and_safe_text]
if __name__ == "__main__":
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        for fn in TESTS: run(fn.__name__, fn, b)
        b.close()
    T.server.shutdown()
    ok = sum(1 for _, o, _ in results if o)
    for n, o, msg in results: print(("PASS " if o else "FAIL ") + n + ("" if o else "  → " + msg))
    real = [e for e in errors if "Leaflet" not in e]
    if real: print("\n페이지 오류:", *real[:6], sep="\n  ")
    print(f"\n{ok}/{len(results)} 통과"); sys.exit(0 if ok == len(results) and not real else 1)
