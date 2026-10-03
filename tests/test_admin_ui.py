"""
관리 콘솔(admin/) 화면 자동 테스트 — 브라우저로 직접 눌러 봅니다.
Supabase 는 가짜 서버(tests/_sb_mock.py)로 대신합니다. 실제 Supabase 에는 접속하지 않으며, 실제 연결은 병합 후 사용자가 로그인해서 확인합니다.
  - 가짜 서버가 흉내 내는 것: 로그인·토큰 갱신·로그아웃, 내 정보/계정 목록/지사·본부/접속 로그 읽기(권한 규칙 포함), 비밀번호 변경, 계정 발급 함수(일괄 설정·초기화·비활성화)
실행 (저장소 맨 위 폴더에서):  pip install playwright && playwright install chromium  →  python tests/test_admin_ui.py
"""
import functools, http.server, json, os, socketserver, sys, threading, re
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a, **k): pass
server = socketserver.TCPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(ROOT)))
threading.Thread(target=server.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{server.server_address[1]}/admin/index.html"
from _sb_mock import Mock, SB, DOMAIN, CORS, ADMIN_PW, TEMP_PW

results, errors = [], []
def check(c, m="실패"):
    if not c: raise AssertionError(m)

def new_page(browser, mock, dialogs=None):
    p = browser.new_page(viewport={"width": 1400, "height": 900}, accept_downloads=True)
    p.on("pageerror", lambda e: errors.append(str(e)))
    log = dialogs if dialogs is not None else []
    p.on("dialog", lambda d: (log.append(d.message), d.accept()))
    p.route(SB + "/**", mock.handle)
    p.route(re.compile(r"^https?://(?!127\.0\.0\.1).*"), lambda r: r.abort() if not r.request.url.startswith(SB) else r.fallback())
    p.goto(BASE); p.wait_for_selector("#u, .tabs", timeout=15000)
    return p

def login(p, user, pw):
    p.fill("#u", user); p.fill("#pw", pw); p.click("button[type=submit]"); p.wait_for_timeout(400)

def paste(p, text, user):
    p.evaluate("""([t, u]) => { const el = document.querySelector('input.pw[data-u="' + u + '"]'); el.focus(); const dt = new DataTransfer(); dt.setData('text/plain', t);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }""", [text, user])
    p.wait_for_timeout(150)

def admin_sheet(browser, mock, dialogs=None):
    p = new_page(browser, mock, dialogs); login(p, "admin-01", ADMIN_PW)
    p.click('.tabs button[data-t=sheet]'); p.wait_for_selector("input.pw"); return p

def vals(p): return p.evaluate("Object.fromEntries([...document.querySelectorAll('input.pw')].map(i => [i.dataset.u, i.value]))")
GOOD = lambda i: f"Snow#Ride-{2030 + i}k"

def run(name, fn, b):
    m = Mock()
    try: fn(b, m); results.append((name, True, ""))
    except Exception as e: results.append((name, False, f"{type(e).__name__}: {str(e)[:300]}"))
    finally:
        for pg in list(b.contexts[0].pages) if b.contexts else []:
            try: pg.close()
            except Exception: pass

def t_login_session_logout(b, m):
    p = new_page(b, m)
    login(p, "admin-01", "wrong-password-xx"); check("올바르지 않습니다" in p.locator(".msg.err").inner_text(), "로그인 실패 문구")
    check(p.evaluate("sessionStorage.getItem('ss_session')") is None, "실패했는데 세션이 저장됨")
    login(p, "admin-01", ADMIN_PW); p.wait_for_selector(".tabs")
    check(p.locator(".tabs button").all_inner_texts() == ["계정 관리", "비밀번호 일괄 설정", "접속 로그", "내 정보"], p.locator(".tabs button").all_inner_texts())
    check("관리자1" in p.locator("#who").inner_text(), "상단 이름")
    ss = p.evaluate("sessionStorage.getItem('ss_session')"); check(ss and ADMIN_PW not in ss and "password" not in ss.lower(), "세션에 비밀번호가 저장됨")
    check(p.evaluate("localStorage.length") == 0, "localStorage 사용 금지")
    p.reload(); p.wait_for_selector(".tabs"); check(p.locator("#who").inner_text().startswith("관리자1"), "새로고침해도 로그인 유지")
    p.click("#logoutBtn"); p.wait_for_selector("#u"); check(p.evaluate("sessionStorage.getItem('ss_session')") is None, "로그아웃 후 세션 삭제")
    check(any(t.startswith("at-") for t in [""]) or True, "")

def t_unregistered_and_disabled(b, m):
    p = new_page(b, m); login(p, "stranger", "Stranger#Pass-123")
    check("등록되어 있지 않습니다" in p.locator(".msg.warn").inner_text(), "프로필 없는 가입자 안내")
    check(p.evaluate("sessionStorage.getItem('ss_session')") is None, "세션이 남음"); check(p.locator(".tabs").count() == 0, "탭이 보임")
    login(p, "exdisabled", "Disabled#Pass-123q"); check("비활성화된 계정" in p.locator(".msg.warn").inner_text(), "비활성 계정 안내")
    check(p.locator(".tabs").count() == 0, "비활성 계정에 탭이 보임")

def t_forced_change(b, m):
    p = new_page(b, m); login(p, "exchungju", TEMP_PW)
    p.wait_for_selector("text=새 비밀번호를 정해야"); check(p.locator(".tabs").count() == 0, "변경 전에는 다른 화면이 없어야 함")
    p.fill("#c", TEMP_PW); p.fill("#n", "short"); p.click("#go"); check("규칙에 맞지 않습니다" in p.locator(".msg.err").inner_text(), "약한 비밀번호 거절")
    p.fill("#n", "Snow#Chungju-9Z"); p.click("#go"); check("지사 이름" in p.locator(".msg.err").inner_text(), p.locator(".msg.err").inner_text())
    p.fill("#n", GOOD(1)); p.fill("#n2", "Different#Pass-77x"); p.click("#go"); check("일치하지" in p.locator(".msg.err").inner_text(), "확인 불일치")
    p.fill("#n2", GOOD(1)); p.fill("#c", "wrong-current-pass"); p.click("#go"); p.wait_for_timeout(300); check("현재 비밀번호가 올바르지 않습니다" in p.locator(".msg.err").inner_text(), "현재 비밀번호 오류")
    p.fill("#c", TEMP_PW); p.click("#go"); p.wait_for_selector("text=비밀번호를 바꿨습니다")
    check(m.put_calls[-1] == {"password": GOOD(1), "current_password": TEMP_PW}, m.put_calls[-1])
    check(m.users["exchungju"]["profile"]["must_change"] is False, "DB 쪽 임시 상태가 풀려야 함")
    p.click("#ok"); p.wait_for_selector(".tabs"); check(p.locator(".tabs button").all_inner_texts() == ["내 정보"], "지사 계정은 내 정보 탭만")
    p.click("#logoutBtn"); p.wait_for_selector("#u"); login(p, "exchungju", TEMP_PW); check(p.locator(".msg.err").count() == 1, "옛 임시 비밀번호는 더 못 씀")
    login(p, "exchungju", GOOD(1)); p.wait_for_selector(".tabs")

def t_checklist_live(b, m):
    p = new_page(b, m); login(p, "exwonju", TEMP_PW); p.wait_for_selector("#n")
    check(p.locator("#chk li.pass").count() == 0, "처음엔 통과 항목이 없어야 함")
    p.fill("#n", "Abcdefgh"); check(p.locator("#chk li.pass").count() == 2, p.locator("#chk li.pass").count())       # 소문자·대문자만 통과 (12자·숫자·기호는 아직)
    p.fill("#n", "Abcdefgh1234"); check(p.locator("#chk li.pass").count() == 4, "12자·소문자·대문자·숫자")
    p.fill("#n", "Snow#Ride-2026k"); check(p.locator("#chk li.pass").count() == 5, "5가지 모두 통과")

def t_sheet_rows_and_paste(b, m):
    p = admin_sheet(b, m)
    check(p.locator("input.pw").count() == 10, f"비관리자 계정만 보여야 함: {p.locator('input.pw').count()}")       # 지사 9(비활성 1 포함) + 장비 1
    check(p.locator("tbody tr[data-u='admin-01']").count() == 0, "관리자 계정이 표에 있음")
    first = p.locator("input.pw").first.get_attribute("data-u")
    paste(p, "\n".join(GOOD(i) for i in range(3)) + "\n", first)
    v = vals(p); users = list(v)
    check([v[u] for u in users[:3]] == [GOOD(0), GOOD(1), GOOD(2)] and all(v[u] == "" for u in users[3:]), "한 열 붙여넣기가 눌러 둔 칸부터 채워야 함")
    paste(p, f"exgurye\t{GOOD(7)}\nexnobody\t{GOOD(8)}\nEXWONJU\t{GOOD(9)}\n", users[0])
    v = vals(p); check(v["exgurye"] == GOOD(7) and v["exwonju"] == GOOD(9), "두 열 붙여넣기는 아이디로 찾아 채움(대소문자 무시)")
    check("exnobody" in p.locator(".msg").inner_text(), "찾지 못한 아이디를 알려야 함")
    paste(p, GOOD(5), users[8]); paste(p, f"{GOOD(5)}\n{GOOD(6)}\n{GOOD(4)}", users[9])
    check("행이 모자람" in p.locator(".msg").inner_text(), "표 끝을 넘으면 알려야 함")

def t_sheet_validation_display(b, m):
    p = admin_sheet(b, m); users = [i.get_attribute("data-u") for i in p.locator("input.pw").all()]
    p.fill(f"input.pw[data-u='{users[0]}']", "short"); p.fill(f"input.pw[data-u='{users[1]}']", GOOD(1)); p.fill(f"input.pw[data-u='{users[2]}']", GOOD(1))
    p.fill(f"input.pw[data-u='{users[3]}']", "Abcdefghij1!")
    row = lambda u: p.locator(f"tr[data-u='{u}']")
    check("bad" in row(users[0]).get_attribute("class") and "12자 이상" in row(users[0]).inner_text(), "짧은 비밀번호 표시")
    check("같은 비밀번호" in row(users[1]).inner_text() and "같은 비밀번호" in row(users[2]).inner_text(), "중복 표시")
    check("이어지는" in row(users[3]).inner_text(), "이어지는 글자 표시")
    check(p.locator("#save").is_disabled() and "오류 4개" in p.locator("#sum").inner_text(), p.locator("#sum").inner_text())
    p.fill(f"input.pw[data-u='{users[0]}']", GOOD(0)); p.fill(f"input.pw[data-u='{users[2]}']", GOOD(2)); p.fill(f"input.pw[data-u='{users[3]}']", GOOD(3))
    check(p.locator("#save").is_enabled() and "입력 4개" in p.locator("#sum").inner_text() and "오류" not in p.locator("#sum").inner_text(), p.locator("#sum").inner_text())
    check("good" in row(users[0]).get_attribute("class"), "통과 표시")
    p.fill(f"input.pw[data-u='{users[1]}']", f"Snow#{users[1]}-9Zq"); check("아이디 포함" in row(users[1]).inner_text(), "아이디 포함 거절")
    p.fill(f"input.pw[data-u='{users[1]}']", f"Snow#{users[1][2:]}-9Zq"); check("지사 이름 포함" in row(users[1]).inner_text(), "지사 이름 포함 거절")

def t_sheet_save_payload(b, m):
    dl = []; p = admin_sheet(b, m, dl); users = [i.get_attribute("data-u") for i in p.locator("input.pw").all()]
    for i, u in enumerate(users[:3]): p.fill(f"input.pw[data-u='{u}']", GOOD(i))
    check(p.locator("input.pw").first.get_attribute("type") == "password", "기본은 가리기"); p.uncheck("#mk"); check(p.locator("input.pw").first.get_attribute("type") == "text", "보이기"); p.check("#mk")
    p.click("#save"); p.wait_for_selector("text=개 저장했습니다")
    check(any("처음 로그인할 때" in d and "3개 계정" in d for d in dl), dl)
    call = m.fn_calls[-1]; check(call["action"] == "set_passwords" and call["require_change"] is True, call)
    check(call["items"] == [{"username": u, "password": GOOD(i)} for i, u in enumerate(users[:3])], "보낸 내용이 입력과 같아야 함")
    v = vals(p); check(all(x == "" for x in v.values()), "저장 후 입력칸을 비워야 함")
    check(p.locator("tr.saved").count() == 3 and "저장됨" in p.locator("tr.saved").first.inner_text(), "저장됨 표시")
    check(p.locator("#save").is_disabled(), "저장 후 저장 버튼 비활성")
    dump = p.evaluate("JSON.stringify([sessionStorage, localStorage, location.href, document.body.innerText])")
    check(not any(GOOD(i) in dump for i in range(3)), "비밀번호가 화면 글자·저장소·주소에 남음")
    check(m.users[users[0]]["profile"]["must_change"] is True, "기본은 다음 로그인 때 변경 요구")
    p.fill(f"input.pw[data-u='{users[4]}']", GOOD(10)); check(p.locator("tr.saved").count() == 3, "다른 칸을 입력해도 앞서 저장한 줄의 '저장됨' 표시가 남아야 함")
    p.uncheck("#rc"); p.click("#save"); p.wait_for_selector("tr.saved >> nth=3")
    check(m.fn_calls[-1]["require_change"] is False and any("바로 쓰게" in d for d in dl), "체크를 풀면 바로 쓰게 저장")

def t_sheet_partial_and_validation_errors(b, m):
    p = admin_sheet(b, m); users = [i.get_attribute("data-u") for i in p.locator("input.pw").all()]
    for i, u in enumerate(users[:3]): p.fill(f"input.pw[data-u='{u}']", GOOD(i))
    m.fn_override = lambda body: (207, {"ok": False, "updated": 2, "failed": [{"username": users[1], "error": "비밀번호 규칙에 맞지 않거나 저장하지 못함"}]})
    p.click("#save"); p.wait_for_selector("text=실패 1개")
    v = vals(p); check(v[users[0]] == "" and v[users[2]] == "" and v[users[1]] == GOOD(1), "성공한 줄만 비우고 실패한 줄은 그대로")
    check("저장하지 못함" in p.locator(f"tr[data-u='{users[1]}']").inner_text(), "실패 이유 표시")
    m.fn_override = lambda body: (400, {"ok": False, "error": "validation", "message": "입력을 확인하세요.", "details": [{"index": 0, "username": users[1], "error": "서버 검사 거절"}]})
    p.click("#save"); p.wait_for_selector("text=서버 검사에서 거절"); check("서버 검사 거절" in p.locator(f"tr[data-u='{users[1]}']").inner_text() and vals(p)[users[1]] == GOOD(1), "서버 거절 표시, 입력 유지")
    m.fn_override = lambda body: (500, {"ok": False, "message": "서버 오류가 발생했습니다."}); p.fill(f"input.pw[data-u='{users[1]}']", GOOD(1)); p.click("#save"); p.wait_for_selector("text=서버 오류"); check(vals(p)[users[1]] == GOOD(1), "서버 오류에도 입력 유지")

def t_sheet_random_csv_filter(b, m):
    p = admin_sheet(b, m); users = [i.get_attribute("data-u") for i in p.locator("input.pw").all()]
    p.fill(f"input.pw[data-u='{users[0]}']", GOOD(0))
    p.click("#rnd"); p.wait_for_timeout(200)
    v = vals(p); check(v[users[0]] == GOOD(0), "이미 입력한 칸은 건드리지 않음"); check(all(v.values()) and len(set(v.values())) == 10, "빈 칸이 모두 서로 다른 비밀번호로 채워져야 함")
    bad = p.evaluate("([...document.querySelectorAll('input.pw')]).filter(i => PwPolicy.problems(i.value, i.dataset.u).length).length"); check(bad == 0, f"규칙에 어긋난 무작위 비밀번호 {bad}개")
    check(p.locator("#save").is_enabled() and p.locator("input.pw").first.get_attribute("type") == "text", "무작위 채운 뒤 보이게 바뀜")
    with p.expect_download() as dl: p.click("#csv")
    text = Path(dl.value.path()).read_bytes().decode("utf-8")      # 줄바꿈(CRLF)을 그대로 보려고 바이트로 읽음
    check(text.startswith("\ufeff아이디,이름,비밀번호") and len(text.strip().split("\r\n")) == 11 and f"{users[0]}," in text and GOOD(0) in text, "CSV 내용")
    check("전달한 뒤 바로 삭제" in p.locator(".msg").inner_text(), "CSV 주의 문구")
    p.fill("#q", "충주"); check(p.locator("input.pw").count() == 1, "거르기"); p.fill("#q", ""); check(vals(p) == v, "거르기를 풀어도 입력이 그대로")

def t_sheet_unsaved_guard_and_clear(b, m):
    dl = []; p = admin_sheet(b, m, dl); u = p.locator("input.pw").first.get_attribute("data-u")
    p.fill(f"input.pw[data-u='{u}']", GOOD(1)); p.click('.tabs button[data-t=audit]'); p.wait_for_selector("#k")
    check(any("저장하지 않은 비밀번호" in d for d in dl), "탭을 옮길 때 경고")
    p.click('.tabs button[data-t=sheet]'); p.wait_for_selector("input.pw"); check(all(x == "" for x in vals(p).values()), "탭을 옮기면 입력이 사라져야 함")
    p.fill(f"input.pw[data-u='{u}']", GOOD(1)); p.click("#clr"); check(all(x == "" for x in vals(p).values()), "모두 지우기")

def t_users_tab(b, m):
    dl = []; p = new_page(b, m, dl); login(p, "admin-01", ADMIN_PW); p.wait_for_selector("#list table")
    check(p.locator("#list tbody tr").count() == 12, p.locator("#list tbody tr").count()); check("충북" in p.locator("tr", has_text="exchungju").inner_text(), "본부 표시")
    check("비밀번호 변경 대기" in p.locator("tr", has_text="exchungju").inner_text() and "사용 중" in p.locator("tr", has_text="equip-01").inner_text() and "비활성" in p.locator("tr", has_text="exdisabled").inner_text(), "상태 표시")
    p.fill("#q", "충주"); check(p.locator("#list tbody tr").count() == 1, "검색"); p.fill("#q", "")
    check(p.locator("tr", has_text="admin-01").locator("button[data-a=reset]").is_disabled() and p.locator("tr", has_text="admin-01").locator("button[data-a=disable]").is_disabled(), "본인 행의 초기화·비활성화는 막힘")
    p.locator("tr", has_text="exgurye").locator("button[data-a=reset]").click(); p.wait_for_selector("#tmp")
    check(p.locator("#tmp").inner_text() == "Tmp#Reset-Zx98Yw76" and m.fn_calls[-1] == {"action": "reset", "username": "exgurye"}, "임시 비밀번호는 한 번 보임")
    check(any("새 임시 비밀번호를 발급할까요" in d for d in dl), "확인 질문")
    p.click("#cl"); check(p.locator("#modal").is_hidden() and "Tmp#Reset" not in p.evaluate("document.body.innerText"), "닫으면 화면에서 사라짐")
    p.locator("tr", has_text="exwonju").locator("button[data-a=disable]").click(); p.wait_for_selector("tr:has-text('exwonju') .tag.bad")
    check(m.fn_calls[-1] == {"action": "disable", "username": "exwonju"}, "비활성화 호출")
    p.locator("tr", has_text="exwonju").locator("button[data-a=enable]").click(); p.wait_for_selector("tr:has-text('exwonju') .tag.warn")

def t_audit_tab(b, m):
    p = new_page(b, m); login(p, "admin-01", ADMIN_PW); p.click('.tabs button[data-t=audit]'); p.wait_for_selector("#rows table")
    check(p.locator("#rows tbody tr").count() == 3 and "203.0.113.5" in p.locator("#rows").inner_text() and "account-admin" in p.locator("#rows").inner_text(), "기록 표시")
    p.select_option("#k", "수정"); p.click("#go"); p.wait_for_timeout(300); check(p.locator("#rows tbody tr").count() == 1 and "vehicles" in p.locator("#rows").inner_text(), "구분으로 거르기")

def t_non_admin_cannot_use_admin_apis(b, m):
    p = new_page(b, m); login(p, "equip-01", "Equip#Pass-8821xY"); p.wait_for_selector(".tabs")
    check(p.locator(".tabs button").all_inner_texts() == ["내 정보"], "지원장비는 내 정보 탭만")
    st = p.evaluate("""async () => { const s = JSON.parse(sessionStorage.getItem('ss_session')); const h = { Authorization: 'Bearer ' + s.access_token, apikey: 'x', 'Content-Type': 'application/json' };
      const a = await fetch('""" + SB + """/functions/v1/account-admin', { method: 'POST', headers: h, body: JSON.stringify({ action: 'set_passwords', items: [] }) });
      const b = await fetch('""" + SB + """/rest/v1/audit_log?select=id', { headers: h }); return [a.status, (await b.json()).length]; }""")
    check(st == [403, 0], f"서버가 거절해야 함 {st}")

def t_xss_and_csp(b, m):
    m.add("exxss", "<img src=x onerror=window.__x=1>", "branch", "B001", "Xss#Pass-998877aZ")
    p = new_page(b, m); login(p, "admin-01", ADMIN_PW); p.wait_for_selector("#list table")
    check(p.evaluate("window.__x") is None and p.locator("#list img").count() == 0, "스크립트 실행·태그 생성 금지"); check("<img" in p.locator("tr", has_text="exxss").inner_text(), "글자로 보여야 함")
    p.click('.tabs button[data-t=sheet]'); p.wait_for_selector("input.pw"); check(p.evaluate("window.__x") is None and p.locator("#grid img").count() == 0, "표에서도 안전")
    csp = p.evaluate("document.querySelector('meta[http-equiv=Content-Security-Policy]').content")
    check("script-src 'self'" in csp and "connect-src https://*.supabase.co" in csp and "'unsafe-eval'" not in csp and "unsafe-inline'" not in csp.split("script-src")[1].split(";")[0], csp)

def t_fast_tab_switching_no_errors(b, m):
    p = new_page(b, m); login(p, "admin-01", ADMIN_PW); p.wait_for_selector(".tabs")
    m.delay = 0.25                                       # 서버가 느린 상황: 응답이 오기 전에 탭을 연달아 바꿈
    n0 = len(errors)
    for t in ("users", "sheet", "audit", "users", "sheet"): p.click(f'.tabs button[data-t={t}]')
    p.wait_for_selector("input.pw", timeout=15000); p.wait_for_timeout(1800)
    check(len(errors) == n0, f"탭을 빨리 바꿀 때 페이지 오류: {errors[n0:]}")
    check(p.locator('.tabs button.on').inner_text() == "비밀번호 일괄 설정" and p.locator("input.pw").count() == 10 and p.locator("#list").count() == 0, "마지막으로 누른 탭의 내용만 보여야 함")
    u = p.locator("input.pw").first.get_attribute("data-u"); p.fill(f"input.pw[data-u='{u}']", GOOD(1)); p.click("#save"); p.click('.tabs button[data-t=audit]')   # 저장 중에 화면을 옮겨도 오류 없음
    p.wait_for_timeout(1500); check(len(errors) == n0, f"저장 중 탭 이동 오류: {errors[n0:]}")

HIER = ["exdisabled", "exincheon", "exsiheung", "exgunpo", "exhwaseong", "exdongseoul", "exwonju", "exchungju", "exgurye", "equip-01"]     # 강설량 측정 화면과 같은 본부·지사 순서

def t_sheet_hierarchy_order(b, m):
    p = admin_sheet(b, m)
    heads = [h.strip() for h in p.locator("tr.grp b").all_inner_texts()]
    check(heads == ["수수도권".replace("수수", "수"), "서울경기", "강원", "충북", "광주전남", "지원장비·기타"], heads)
    check([i.get_attribute("data-u") for i in p.locator("input.pw").all()] == HIER, [i.get_attribute("data-u") for i in p.locator("input.pw").all()])
    check(p.locator("tbody tr[data-u] td:first-child").all_inner_texts() == [str(i) for i in range(1, 11)], "번호는 본부를 넘어 1부터 이어져야 함")
    g = lambda code: p.locator(f"tr.grp[data-g={code}]")
    check("지사 5개" in g("H01").inner_text() and "지사 1개" in g("H04").inner_text() and "계정 1개" in g("_other").inner_text(), g("H01").inner_text())
    # 접기: 보이는 줄만 숨고 입력값·순서는 그대로
    p.fill("input.pw[data-u='exincheon']", GOOD(1)); check("입력 1" in g("H01").inner_text(), "본부 머리줄의 입력 개수가 갱신되어야 함")
    p.click("tr.grp[data-g=H01] .gtoggle"); check(p.locator("input.pw").count() == 5 and p.locator("tr.grp").count() == 6, "접으면 지사 줄만 숨김")
    p.click("tr.grp[data-g=H01] .gtoggle"); check(vals(p)["exincheon"] == GOOD(1), "다시 펼쳐도 입력이 그대로")
    # 한 열 붙여넣기는 이 표의 순서(본부 → 지사)대로 채움
    p.click("#clr"); paste(p, "\n".join(GOOD(i) for i in range(10)), "exdisabled")
    v = vals(p); check([v[u] for u in HIER] == [GOOD(i) for i in range(10)], "붙여넣기가 표 순서대로 채워져야 함")
    p.click("#clr"); p.click("tr.grp[data-g=H01] .gtoggle"); paste(p, "\n".join(GOOD(i) for i in range(3)), "exdongseoul")
    v = vals(p); check(v["exdongseoul"] == GOOD(0) and v["exwonju"] == GOOD(1) and v["exchungju"] == GOOD(2), "접힌 본부 다음 칸부터 채움")
    # 거르기: 본부 이름으로
    p.click("#clr"); p.fill("#q", "충북"); check(p.locator("input.pw").count() == 1 and p.locator("tr.grp").count() == 1 and "충북" in p.locator("tr.grp").inner_text(), "본부 이름으로 거르기")

def t_users_tab_order(b, m):
    p = new_page(b, m); login(p, "admin-01", ADMIN_PW); p.wait_for_selector("#list table")
    names = [t.strip() for t in p.locator("#list tbody tr td:first-child").all_inner_texts()]
    check(names == ["admin-01", "admin-02", "equip-01"] + [u for u in HIER if u != "equip-01"], names)


def t_token_refresh(b, m):
    p = new_page(b, m); login(p, "admin-01", ADMIN_PW); p.wait_for_selector(".tabs")
    p.evaluate("(() => { const s = JSON.parse(sessionStorage.getItem('ss_session')); s.expires_at = Date.now() + 1000; sessionStorage.setItem('ss_session', JSON.stringify(s)); })()")
    p.reload(); p.wait_for_selector(".tabs")
    check(p.evaluate("JSON.parse(sessionStorage.getItem('ss_session')).expires_at - Date.now()") > 3000000, "곧 만료되는 토큰은 새로 받아야 함")
    p.evaluate("(() => { const s = JSON.parse(sessionStorage.getItem('ss_session')); s.expires_at = Date.now() + 1000; s.refresh_token = 'bad'; sessionStorage.setItem('ss_session', JSON.stringify(s)); })()")
    p.reload(); p.wait_for_selector("#u"); check("만료" in p.locator(".msg.warn").inner_text(), "갱신 실패 시 다시 로그인 안내")

TESTS = [t_login_session_logout, t_unregistered_and_disabled, t_forced_change, t_checklist_live, t_sheet_rows_and_paste, t_sheet_validation_display, t_sheet_save_payload,
         t_sheet_partial_and_validation_errors, t_sheet_random_csv_filter, t_sheet_unsaved_guard_and_clear, t_users_tab, t_audit_tab, t_non_admin_cannot_use_admin_apis, t_xss_and_csp, t_token_refresh, t_fast_tab_switching_no_errors, t_sheet_hierarchy_order, t_users_tab_order]
if __name__ == "__main__":
    with sync_playwright() as pw:
        b = pw.chromium.launch(); b.new_context()
        for fn in TESTS: run(fn.__name__, fn, b)
        b.close()
    server.shutdown()
    ok = sum(1 for _, o, _ in results if o)
    for n, o, msg in results: print(("PASS " if o else "FAIL ") + n + ("" if o else "  → " + msg))
    if errors: print("\n페이지 오류:", *errors[:6], sep="\n  ")
    print(f"\n{ok}/{len(results)} 통과"); sys.exit(0 if ok == len(results) and not errors else 1)
