"""
관리자 콘솔(admin/index.html) 화면 자동 테스트 — 브라우저로 직접 눌러 봅니다.
서버는 컴퓨터 안의 흉내(tests/_local_server.mjs: D1 = 내장 SQLite)를 씁니다. 실제 Cloudflare 가 아닙니다.
실행 (저장소 맨 위 폴더에서):  pip install playwright && playwright install chromium  →  python tests/test_admin_console.py
"""
import re, subprocess, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
srv = subprocess.Popen(["node", "--no-warnings", str(ROOT / "tests/_local_server.mjs")], stdout=subprocess.PIPE, text=True, cwd=ROOT)
port = None
for _ in range(100):
    line = srv.stdout.readline()
    m = re.search(r"LISTENING (\d+)", line)
    if m: port = m.group(1); break
    time.sleep(0.05)
assert port, "서버가 시작되지 않았습니다"
URL = f"http://127.0.0.1:{port}/admin/index.html"
PW = "Correct-Horse-9!"
errs, results = [], []

def check(c, m):
    if not c: raise AssertionError(m)

def run(name, fn, b):
    p = b.new_page(viewport={"width": 1200, "height": 900}); p.on("pageerror", lambda e: errs.append(str(e))); p.on("dialog", lambda d: d.accept())
    try: fn(p); results.append((name, True, ""))
    except Exception as e: results.append((name, False, f"{type(e).__name__}: {str(e)[:260]}"))
    finally: p.close()

def t_flow(p):
    p.goto(URL); p.wait_for_selector("text=첫 관리자 만들기")
    # 잘못된 설정 코드 → 오류, 올바른 코드 → 성공
    p.fill("#t", "wrong"); p.fill("#u", "admin1"); p.fill("#pw", PW); p.click("#go"); p.wait_for_selector(".msg.err")
    p.fill("#t", "setup-code-for-tests"); p.click("#go"); p.wait_for_selector(".msg.ok"); p.click("#gl")
    # 로그인 실패 → 같은 문구, 성공
    p.wait_for_selector("text=로그인"); p.fill("#u", "admin1"); p.fill("#pw", "wrong-password-xx"); p.click("button[type=submit]")
    p.wait_for_selector(".msg.err"); check("올바르지 않습니다" in p.locator(".msg.err").inner_text(), "로그인 실패 문구")
    p.fill("#pw", PW); p.click("button[type=submit]"); p.wait_for_selector("text=계정 만들기")
    check("관리자" in p.locator("#who").inner_text(), p.locator("#who").inner_text())
    # 계정 만들기: 임시 비밀번호는 화면에 한 번 보임
    p.fill("#nu", "daegwallyeong1"); p.fill("#nd", "대관령지사"); p.select_option("#nr", "branch"); p.fill("#nb", "대관령"); p.click("#mk")
    p.wait_for_selector(".temp"); temp = p.locator(".temp").inner_text(); check(len(temp) == 16, f"임시 비밀번호 {temp!r}")
    p.wait_for_selector("td:has-text('daegwallyeong1')")
    check("변경 대기" in p.locator("tr:has-text('daegwallyeong1')").inner_text(), "비밀번호 변경 대기 표시")
    # 접속 로그 탭: 접속·접속실패·계정생성이 보임
    p.click("button[data-t=audit]"); p.wait_for_selector("td .tag")
    txt = p.locator("#rows").inner_text()
    for k in ("접속실패", "접속", "계정생성"): check(k in txt, f"로그에 {k} 없음")
    check("127.0.0.1" in txt, "IP 표시")
    p.select_option("#k", "접속실패"); p.click("#go"); p.wait_for_timeout(400)
    check(all("접속실패" in r for r in p.locator("#rows tbody tr").all_inner_texts()), "구분으로 거르기")
    # 수집 상태 탭: 기록이 없을 때 안내
    p.click("button[data-t=collector]"); p.wait_for_selector("text=아직 수집 기록이 없습니다")
    # 로그아웃 → 임시 비밀번호로 로그인 → 강제 비밀번호 변경 → 관리자 기능 없음
    p.click("#logoutBtn"); p.wait_for_selector("text=로그인")
    p.fill("#u", "daegwallyeong1"); p.fill("#pw", temp); p.click("button[type=submit]"); p.wait_for_selector("text=새 비밀번호를 정해야")
    p.fill("#c", temp); p.fill("#n", "Brand-New-Pass-77"); p.fill("#n2", "different-pass-77"); p.click("#go")
    p.wait_for_selector(".msg.err"); check("일치하지 않습니다" in p.locator(".msg.err").inner_text(), "확인 불일치")
    p.fill("#n2", "Brand-New-Pass-77"); p.click("#go"); p.wait_for_selector("text=비밀번호를 바꿨습니다"); p.click("#ok")
    p.wait_for_selector("text=내 정보")
    check(p.locator("button[data-t=users]").count() == 0 and p.locator("button[data-t=audit]").count() == 0, "지사 아이디에 관리자 탭이 보이면 안 됨")
    check("대관령" in p.locator("#who").inner_text(), p.locator("#who").inner_text())
    # 지사 아이디가 서버의 관리자 기능을 직접 불러도 거절
    r = p.evaluate("fetch('/api/admin/users').then(r => r.status)"); check(r == 403, f"관리자 API 상태 {r}")
    # 새로고침해도 로그인 유지, 로그아웃하면 해제
    p.reload(); p.wait_for_selector("text=내 정보"); p.click("#logoutBtn"); p.wait_for_selector("text=로그인")
    check(p.evaluate("fetch('/api/me').then(r => r.status)") == 401, "로그아웃 후에는 401")

def t_xss(p):
    p.goto(URL); p.wait_for_selector("#u")
    p.fill("#u", "admin1"); p.fill("#pw", PW); p.click("button[type=submit]"); p.wait_for_selector("text=계정 만들기")
    p.fill("#nu", "xss.test"); p.fill("#nd", "<img src=x onerror=window.__x=1>"); p.select_option("#nr", "equip"); p.click("#mk"); p.wait_for_selector(".temp")
    p.wait_for_selector("td:has-text('xss.test')")
    check(p.evaluate("window.__x") is None, "스크립트가 실행됨"); check(p.locator("#list img").count() == 0, "이미지 태그가 만들어짐")
    check("<img" in p.locator("tr:has-text('xss.test')").inner_text(), "글자로 보여야 함")

with sync_playwright() as pw:
    b = pw.chromium.launch()
    run("t_flow", t_flow, b)
    run("t_xss", t_xss, b)           # t_flow 가 만든 관리자 계정을 이어서 사용 (같은 서버)
    b.close()
srv.terminate()
ok = sum(1 for _, o, _ in results if o)
for n, o, m in results: print(("PASS " if o else "FAIL ") + n + ("" if o else "  → " + m))
if errs: print("페이지 오류:", *errs[:5], sep="\n  ")
print(f"\n{ok}/{len(results)} 통과")
sys.exit(0 if ok == len(results) and not errs else 1)
