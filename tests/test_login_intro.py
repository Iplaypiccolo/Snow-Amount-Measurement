"""
로그인 인트로·새 로그인 화면(기본 화면, 비상용 ?intro=off) 자동 테스트 — 브라우저로 직접 열어 봅니다. (Supabase 는 가짜 서버 tests/_sb_mock.py)
확인하는 것: 정렬 단계에서 크기·위치가 한 번에 바뀜(PC·휴대폰) / ?intro=off 면 예전 화면(인트로 파일도 안 받음) / 기본은 인트로 → 새 로그인 화면(친구들 줄은 왼쪽·상자는 오른쪽, 휴대폰은 상자 아래 줄) / 인트로 중 칸 잠금 /
             건너뛰기(Esc·버튼) / 자동 로그인 사람은 인트로 없음 / 인트로 파일을 못 받으면 바로 로그인 화면 / 비밀번호 입력에 화면이 반응하지 않음 /
             움직임 줄이기 / 새 화면에서도 로그인이 그대로 됨 / 보안 정책(CSP) 아래에서 오류 없음
실행 (저장소 맨 위 폴더에서):  python tests/test_login_intro.py
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_jurisdiction_ui as T
import test_login_gate as G
import _sb_mock as SBM
from playwright.sync_api import sync_playwright

results, errors = [], T.errors
check = G.check
PREVIEW = T.URL                    # 2026-10-19부터 새 로그인 화면·인트로가 기본
OFF = T.URL + "?intro=off"          # 비상용: 예전 로그인 화면

def intro_reqs(reqs): return [u for u in reqs if "/login/intro/" in u]

def open_preview(ctx, m, reqs=None):
    """G.open_site 는 로그인 칸이 '보일' 때까지 기다리므로(인트로가 끝날 때까지) 여기서는 칸이 생기기만 하면 바로 돌려줌"""
    p = ctx.new_page(); p.set_viewport_size({"width": 1400, "height": 900})
    p.on("pageerror", lambda e: errors.append(str(e)))
    if reqs is not None: p.on("request", lambda r: reqs.append(r.url))
    p.route("**/*", T.route); p.route(SBM.SB + "/**", m.handle)
    p.goto(PREVIEW); p.wait_for_selector("#ssGate", state="attached", timeout=20000); p.wait_for_timeout(300)
    return p

def wait_js(p, expr, timeout=8000):
    """보안 정책(CSP) 때문에 wait_for_function(문자열)을 못 써서 직접 반복 확인"""
    for _ in range(timeout // 100):
        if p.evaluate(expr): return
        p.wait_for_timeout(100)
    raise AssertionError("시간 안에 안 됨: " + expr)

def t_off_switch(b, ctx, m):
    reqs = []; p = G.open_site(ctx, m, url=OFF, reqs=reqs)
    check(p.evaluate("document.documentElement.classList.contains('ss-v2')") is False, "?intro=off 면 예전 화면이어야 함")
    check(p.locator("#ssScene, #ssIntro").count() == 0, "배경 장면·인트로가 없어야 함")
    check(not intro_reqs(reqs), f"인트로 파일을 받지 않아야 함: {intro_reqs(reqs)[:3]}")
    G.typed_login(p, "admin-01", SBM.ADMIN_PW); p.wait_for_selector(".topnav", state="visible")

def t_preview_intro_then_login(b, ctx, m):
    reqs = []; p = open_preview(ctx, m, reqs=reqs)
    check(p.locator("#ssIntro").count() == 1, "인트로가 떠야 함")
    check(p.evaluate("document.getElementById('ssGate').inert") is True, "인트로 중에는 로그인 칸이 잠겨야 함")
    p.keyboard.type("abc"); check(p.input_value("#ssU") == "", "인트로 중 입력이 아이디 칸에 들어가면 안 됨")
    wait_js(p, "!!(window.__ssIntro && __ssIntro.info().state === 'play')")
    check(len([u for u in intro_reqs(reqs) if "/chars/" in u]) == 6, "캐릭터 파일 6개를 받아야 함")
    p.wait_for_selector("#ssIntro.rest", state="attached", timeout=12000)
    T = p.evaluate("__ssIntro.info().T"); check(5.1 <= T < 5.9, f"로그인 상자는 친구들이 정렬 이동을 시작할 때(5.15초) 나타나야 함: {T:.2f}초")
    wait_js(p, "__ssIntro.info().state === 'wait'", 3000)
    lu = p.evaluate("(()=>{const L=__ssIntro.info().last;return Object.keys(L).filter(k=>k!=='__order').map(k=>L[k].view[5]/L[k].view[0])})()")
    check(len(lu) == 6, "친구 6명이 남아 있어야 함")
    LB = "(()=>{const a=__ssLayout,k=document.querySelector('.ss-card').getBoundingClientRect();return [a.cx-a.lw/2,a.cy-a.lh/2,a.cx+a.lw/2,a.cy+a.lh/2,k.left,k.top,k.right,k.bottom]})()"
    p.wait_for_timeout(900); b = p.evaluate(LB)       # 상자 등장 움직임이 끝난 뒤
    check(b[2] <= b[4] and b[0] >= 0, f"PC: 친구들 줄은 왼쪽, 로그인 상자는 오른쪽(줄 오른쪽 끝 {b[2]:.0f} ≤ 상자 왼쪽 {b[4]:.0f})")
    p.set_viewport_size({"width": 390, "height": 844}); p.wait_for_timeout(600); b = p.evaluate(LB)
    check(b[1] >= b[7] + 47 and b[3] <= 844 and b[0] >= 0 and b[2] <= 390, f"휴대폰: 상자 아래 48px 이상 떨어져 친구들 줄(줄 위 {b[1]:.0f}, 상자 아래 {b[7]:.0f}, 화면 안)")
    p.set_viewport_size({"width": 1400, "height": 900}); p.wait_for_timeout(300)
    check(p.evaluate("getComputedStyle(document.getElementById('ssIntro')).pointerEvents") == "none", "남은 친구들이 클릭을 막으면 안 됨")
    check(p.evaluate("document.getElementById('ssGate').inert") is False, "인트로가 끝나면 칸 잠금이 풀려야 함")
    check(p.evaluate("document.activeElement && document.activeElement.id") == "ssU", "끝나면 아이디 칸에 커서")
    check(p.evaluate("document.documentElement.classList.contains('ss-reveal')"), "새 로그인 화면 등장")
    G.typed_login(p, "admin-01", SBM.ADMIN_PW); p.wait_for_selector(".topnav", state="visible")
    check(p.locator("#ssScene").is_hidden(), "로그인하면 배경 장면은 숨겨져야 함")
    p.wait_for_selector("#ssIntro", state="detached", timeout=3000)

def t_single_move(b, ctx, m):
    """정렬 단계에서 크기가 한 번만(계속 줄어들기만) 바뀌고, 끝난 뒤에는 그대로인지 — PC·휴대폰"""
    for vp in ({"width": 1440, "height": 900}, {"width": 390, "height": 844}):
        p = open_preview(ctx, m); p.set_viewport_size(vp); wait_js(p, "!!(window.__ssIntro && __ssIntro.info().state === 'play')")
        p.wait_for_timeout(300)
        seq = []
        for i in range(0, 15):
            t = 5.10 + i * 0.06
            seq.append(p.evaluate("(t)=>{__ssIntro.seek(t);return new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>{const L=__ssIntro.info().last;r(['chumdani','tira','tarotaro','giltong','charocharo','doroduck'].map(k=>L[k].view[0]))})))}", t))
        for j in range(6):
            col = [r[j] for r in seq]
            check(all(b2 <= a2 + 1e-6 for a2, b2 in zip(col, col[1:])), f"{vp['width']}: {j}번째 친구 크기가 줄었다 커졌다 함: {[round(x, 3) for x in col]}")
        p.close()

def t_skip(b, ctx, m):
    p = open_preview(ctx, m); p.wait_for_timeout(700); p.keyboard.press("Escape")
    p.wait_for_selector("#ssIntro.rest", state="attached", timeout=2000)
    check(p.evaluate("document.activeElement.id") == "ssU", "Esc 로 건너뛰면 바로 아이디 칸")
    p.wait_for_timeout(1500); check(p.evaluate("__ssIntro.info().state") == "wait", "건너뛰면 친구들은 정렬 단계부터 이어 재생해 최종 자리로")
    q = open_preview(ctx, m); q.wait_for_timeout(900); q.click(".ss-skip")
    q.wait_for_selector("#ssIntro.rest", state="attached", timeout=2000)
    check(q.evaluate("document.getElementById('ssGate').inert") is False, "버튼으로 건너뛰어도 칸 잠금이 풀려야 함")

def t_auto_login_no_intro(b, ctx, m):
    p = open_preview(ctx, m); p.keyboard.press("Escape"); p.wait_for_timeout(800)
    G.typed_login(p, "admin-01", SBM.ADMIN_PW, auto=True); p.wait_for_selector(".topnav", state="visible"); p.close()
    reqs = []; q = G.open_site(ctx, m, url=PREVIEW, reqs=reqs); q.wait_for_selector(".topnav", state="visible")
    check(q.locator("#ssIntro").count() == 0 and not intro_reqs(reqs), "자동 로그인이면 인트로가 없어야 함")

def t_intro_files_missing(b, ctx, m):
    p = ctx.new_page(); p.set_viewport_size({"width": 1400, "height": 900}); p.on("pageerror", lambda e: errors.append(str(e)))
    p.route("**/*", T.route); p.route(SBM.SB + "/**", m.handle); p.route("**/login/intro/chars/**", lambda r: r.abort())
    p.goto(PREVIEW); p.wait_for_selector("#ssIntro", state="detached", timeout=7000)
    check(p.evaluate("document.getElementById('ssGate').inert") is False and p.locator("#ssU").is_visible(), "파일을 못 받으면 바로 로그인 화면")

def t_loader_missing(b, ctx, m):
    """intro-loader.js 를 못 받아도 3초 뒤에는 로그인 상자가 보여야 함(잠깐 가리기가 로그인을 막지 않음)"""
    p = ctx.new_page(); p.set_viewport_size({"width": 1400, "height": 900}); p.on("pageerror", lambda e: errors.append(str(e)))
    p.route("**/*", T.route); p.route(SBM.SB + "/**", m.handle); p.route("**/login/intro-loader.js*", lambda r: r.abort())
    p.goto(T.URL); p.wait_for_selector("#ssU", state="visible", timeout=6000)
    G.typed_login(p, "admin-01", SBM.ADMIN_PW); p.wait_for_selector(".topnav", state="visible")

def t_password_no_reaction(b, ctx, m):
    p = open_preview(ctx, m); p.keyboard.press("Escape"); p.wait_for_timeout(1200)
    snap = "JSON.stringify([document.documentElement.className, document.documentElement.getAttribute('style'), document.getElementById('ssScene').outerHTML.replace(/<canvas[^>]*>/,''), document.getElementById('ssGo').getAttribute('style')])"
    p.click("#ssP"); p.wait_for_timeout(200); before = p.evaluate(snap)
    p.keyboard.type("aB3$ 긴비밀번호", delay=30); p.wait_for_timeout(300)
    check(p.evaluate(snap) == before, "비밀번호를 입력해도 화면(장면·버튼·문서 상태)이 바뀌면 안 됨")

def t_reduced_motion(b, ctx, m):
    rc = b.new_context(reduced_motion="reduce"); p = open_preview(rc, m)
    wait_js(p, "!!(window.__ssIntro && __ssIntro.info().state === 'play')")
    check(p.evaluate("__ssIntro.info().reduce") is True, "움직임 줄이기면 간소화한 인트로")
    p.keyboard.press("Escape"); p.wait_for_selector("#ssIntro.rest", state="attached", timeout=2000); rc.close()

MOUSE = T.URL + "?mouse=preview"
GBOX = """(id)=>{const CP=CharoPet,I=__ssIntro,c=I.cast.find(x=>x.id===id),L=I.info().last[id],cv=document.querySelector('#ssIntro canvas'),k=cv.width/cv.clientWidth,r=cv.getBoundingClientRect();
  const W=CP.worldMatrices(c.P,L.fp);let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;c.P.parts.forEach(pt=>{const f=L.fp[pt.id];if(!f||f.op<=.01)return;const v=pt.images[f.img]||pt.images[0];if(!v)return;const m=CP.mul(L.view,W[pt.id]);
  [[v.x,v.y],[v.x+v.w,v.y+v.h],[v.x,v.y+v.h],[v.x+v.w,v.y]].forEach(q=>{const a=CP.apply(m,q[0],q[1]);x0=Math.min(x0,a[0]);x1=Math.max(x1,a[0]);y0=Math.min(y0,a[1]);y1=Math.max(y1,a[1])})});return [r.left+x0/k,r.top+y0/k,r.left+x1/k,r.top+y1/k]}"""

def open_mouse(ctx, m):
    p = ctx.new_page(); p.set_viewport_size({"width": 1440, "height": 900}); p.on("pageerror", lambda e: errors.append(str(e)))
    p.route("**/*", T.route); p.route(SBM.SB + "/**", m.handle)
    p.goto(MOUSE); p.wait_for_selector("#ssGate", state="attached", timeout=20000)
    wait_js(p, "!!(window.__ssIntro && __ssIntro.info().state === 'play')"); p.keyboard.press("Escape")
    wait_js(p, "__ssIntro.info().state === 'wait'", 4000); p.wait_for_timeout(300)
    return p

def ms(p, id): return p.evaluate("(id)=>__ssMouse.state()[id] || {}", id)

def t_mouse_giltong(b, ctx, m):
    """길통이 마우스 반응: 시선 / 0.7초 머무르면 한 번 / 계속 있어도 반복 안 함 / 나갔다 들어오면 다시 / 중간에 나가면 바로 복귀 / 반응 중 맨 앞 / 폼 클릭 됨"""
    p = open_mouse(ctx, m); g = p.evaluate(GBOX, "giltong"); cx, cy = (g[0] + g[2]) / 2, g[1] + (g[3] - g[1]) * 0.35
    p.mouse.move(10, 450); p.wait_for_timeout(500); gl = ms(p, "giltong")["gx"]
    p.mouse.move(cx + 300, cy); p.wait_for_timeout(500); gr = ms(p, "giltong")["gx"]
    check(gl < -0.3 and gr > 0.3, f"커서 쪽으로 시선: 왼쪽 {gl}, 오른쪽 {gr}")
    p.mouse.move(cx + 20, cy, steps=4); p.wait_for_timeout(500); check(not ms(p, "giltong").get("act"), "0.7초 전에는 시작 안 함")
    p.wait_for_timeout(500); check(ms(p, "giltong").get("act"), "0.7초 머무르면 시작")
    check(p.evaluate("__ssIntro.info().last.__order.slice(-1)[0]") == "giltong", "반응 중인 친구는 맨 앞")
    p.click("#ssU"); check(p.evaluate("document.activeElement.id") == "ssU", "반응 중에도 로그인 칸을 누를 수 있어야 함")
    p.mouse.move(cx + 21, cy); p.wait_for_timeout(2600)
    st = ms(p, "giltong"); check(not st.get("act") and st.get("played"), f"한 번 재생 후 끝: {st}")
    p.wait_for_timeout(3000); check(not ms(p, "giltong").get("act"), "커서가 그대로면 반복 안 함")
    p.mouse.move(cx + 600, cy); p.wait_for_timeout(300); p.mouse.move(cx + 20, cy); p.wait_for_timeout(1000)
    check(ms(p, "giltong").get("act"), "영역을 나갔다 들어오면(간격 3초 지남) 다시 시작")
    p.wait_for_timeout(300); p.mouse.move(cx + 600, cy); p.wait_for_timeout(120)
    check(not ms(p, "giltong").get("act"), "중간에 나가면 동작을 멈추고 복귀 시작")
    p.wait_for_timeout(500); st = ms(p, "giltong"); check(not st.get("ret"), f"0.42초 안에 기본으로 복귀: {st}")
    hid = p.evaluate("(()=>{const f=__ssIntro.info().last.giltong.fp;return [f.m_armChin.op,f.m_question.op,f.armL.op]})()")
    check(hid[0] < 0.01 and hid[1] < 0.01 and hid[2] > 0.99, f"복귀 뒤 추가 그림은 숨고 원래 팔: {hid}")

def t_mouse_blocked(b, ctx, m):
    """비밀번호 칸에 있으면 시선·반응 없음 / 아이디 입력 중이면 반응 안 함 / ?mouse=preview 없으면 반응 기능 자체가 없음"""
    p = open_mouse(ctx, m); g = p.evaluate(GBOX, "giltong"); cx, cy = (g[0] + g[2]) / 2, g[1] + (g[3] - g[1]) * 0.35
    p.click("#ssP"); p.mouse.move(cx + 20, cy, steps=3); p.wait_for_timeout(1300)
    st = ms(p, "giltong"); check(not st.get("act") and abs(st.get("gx", 0)) < 0.05, f"비밀번호 칸에서는 반응·시선 없음: {st}")
    p.click("#ssU"); p.mouse.move(cx + 22, cy)
    for _ in range(8): p.keyboard.type("a"); p.wait_for_timeout(150)
    check(not ms(p, "giltong").get("act"), "아이디 입력 중에는 반응 안 함")
    q = open_preview(ctx, m); wait_js(q, "!!(window.__ssIntro && __ssIntro.info().state === 'play')")
    check(q.evaluate("!window.__ssMouse && !window.CharoLoginMouse"), "?mouse=preview 가 없으면 마우스 반응 파일도 안 받음")

TESTS = [t_off_switch, t_preview_intro_then_login, t_single_move, t_skip, t_auto_login_no_intro, t_intro_files_missing, t_loader_missing, t_password_no_reaction, t_reduced_motion, t_mouse_giltong, t_mouse_blocked]
if __name__ == "__main__":
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        for fn in TESTS: G.run(fn.__name__, fn, b)
        b.close()
    T.server.shutdown()
    results = G.results
    ok = sum(1 for _, o, _ in results if o)
    for n, o, msg in results: print(("PASS " if o else "FAIL ") + n + ("" if o else "  → " + msg))
    real = [e for e in errors if "Leaflet" not in e]
    if real: print("\n페이지 오류:", *real[:6], sep="\n  ")
    print(f"\n{ok}/{len(results)} 통과"); sys.exit(0 if ok == len(results) and not real else 1)
