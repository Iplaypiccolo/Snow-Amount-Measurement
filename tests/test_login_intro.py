"""
로그인 인트로·새 로그인 화면(기본 화면, 비상용 ?intro=off) 자동 테스트 — 브라우저로 직접 열어 봅니다. (Supabase 는 가짜 서버 tests/_sb_mock.py)
확인하는 것: 정렬 단계에서 크기·위치가 한 번에 바뀜(PC·휴대폰) / ?intro=off 면 예전 화면(인트로 파일도 안 받음) / 기본은 인트로 → 새 로그인 화면(친구들 줄은 왼쪽·상자는 오른쪽, 휴대폰은 상자 아래 줄) / 인트로 중 칸 잠금 /
             건너뛰기(Esc·버튼) / 자동 로그인 사람은 인트로 없음 / 인트로 파일을 못 받으면 바로 로그인 화면 / 비밀번호 입력에 화면이 반응하지 않음 /
             움직임 줄이기 / 새 화면에서도 로그인이 그대로 됨 / 보안 정책(CSP) 아래에서 오류 없음 /
             친구들 마우스 반응(머무르면 반응·한 명만·방향·계속 머무르면 간격 두고 반복) / 키보드 반응(아이디 입력 = 화면 왼쪽부터 한 명씩 2.2초 간격·한글 조합 묶음,
             비밀번호 칸 = 여섯 모두 첫 프레임에 감은 눈·마우스 반응 없음·입력 글자 수와 무관, 움직임 줄이기, ?keys=off, 휴대폰 입력 중 배치 고정)
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

MOUSE = T.URL                       # 2026-10-19부터 마우스 반응 기본
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
    p.wait_for_timeout(3000); check(not ms(p, "giltong").get("act"), "커서가 그대로면 바로 반복하지는 않음")
    ok = False
    for _ in range(80):
        p.wait_for_timeout(100)
        if ms(p, "giltong").get("act"): ok = True; break
    check(ok, "커서를 계속 두면 끝나고 9초(간격 3초+6초) 뒤 한 번 더")
    p.mouse.move(cx + 600, cy); p.wait_for_timeout(700); p.wait_for_timeout(3000)
    p.mouse.move(cx + 600, cy); p.wait_for_timeout(300); p.mouse.move(cx + 20, cy); p.wait_for_timeout(1000)
    check(ms(p, "giltong").get("act"), "영역을 나갔다 들어오면(간격 3초 지남) 다시 시작")
    p.wait_for_timeout(300); p.mouse.move(cx + 600, cy); p.wait_for_timeout(120)
    check(not ms(p, "giltong").get("act"), "중간에 나가면 동작을 멈추고 복귀 시작")
    p.wait_for_timeout(500); st = ms(p, "giltong"); check(not st.get("ret"), f"0.42초 안에 기본으로 복귀: {st}")
    hid = p.evaluate("(()=>{const f=__ssIntro.info().last.giltong.fp;return [f.m_armChin.op,f.m_question.op,f.armL.op]})()")
    check(hid[0] < 0.01 and hid[1] < 0.01 and hid[2] > 0.99, f"복귀 뒤 추가 그림은 숨고 원래 팔: {hid}")

def t_mouse_blocked(b, ctx, m):
    """비밀번호 칸에 있으면 시선·반응 없음 / 아이디 입력 중이면 반응 안 함 / ?mouse=off 면 반응 기능 자체가 없음"""
    p = open_mouse(ctx, m); g = p.evaluate(GBOX, "giltong"); cx, cy = (g[0] + g[2]) / 2, g[1] + (g[3] - g[1]) * 0.35
    p.click("#ssP"); p.mouse.move(cx + 20, cy, steps=3); p.wait_for_timeout(1300)
    st = ms(p, "giltong"); check(not st.get("act") and abs(st.get("gx", 0)) < 0.05, f"비밀번호 칸에서는 반응·시선 없음: {st}")
    p.click("#ssU"); p.mouse.move(cx + 22, cy)
    for _ in range(8): p.keyboard.type("a"); p.wait_for_timeout(150)
    check(not ms(p, "giltong").get("act"), "아이디 입력 중에는 반응 안 함")
    q = ctx.new_page(); q.set_viewport_size({"width": 1400, "height": 900}); q.route("**/*", T.route); q.route(SBM.SB + "/**", m.handle)
    q.goto(T.URL + "?mouse=off"); q.wait_for_selector("#ssGate", state="attached", timeout=20000); wait_js(q, "!!(window.__ssIntro && __ssIntro.info().state === 'play')")
    check(q.evaluate("!!window.__ssMouse && __ssMouse.hover === false"), "?mouse=off 면 마우스 반응만 꺼짐(키보드 반응 때문에 파일은 받음)")
    q = ctx.new_page(); q.set_viewport_size({"width": 1400, "height": 900}); q.route("**/*", T.route); q.route(SBM.SB + "/**", m.handle)
    q.goto(T.URL + "?mouse=off&keys=off"); q.wait_for_selector("#ssGate", state="attached", timeout=20000); wait_js(q, "!!(window.__ssIntro && __ssIntro.info().state === 'play')")
    check(q.evaluate("!window.__ssMouse && !window.CharoLoginMouse"), "?mouse=off&keys=off 면 반응 파일을 받지 않음(인트로는 그대로)")

def t_mouse_all(b, ctx, m):
    """여섯 친구 모두: 그 친구 근처에 머무르면 그 친구가(한 명만) 반응, 커서 방향(왼쪽/오른쪽) 동작, 로그인 대기 얼굴(티라·타로타로 마우스용 눈, 도로덕 팻말 숨김)"""
    p = open_mouse(ctx, m)
    base = p.evaluate("""(()=>{const L=__ssIntro.info().last;return {tira:[L.tira.fp.m_eyeL.op,L.tira.fp.m_face.op,L.tira.fp.sign14.op],taro:[L.tarotaro.fp.m_eyeL.op,L.tarotaro.fp.eyes.op,L.tarotaro.fp.excl.op],duck:[L.doroduck.fp.sign.op,L.doroduck.fp.wingRf.op]}})()""")
    check(base["tira"][0] > 0.99 and base["tira"][1] > 0.99 and base["tira"][2] < 0.01, f"티라: 마우스용 얼굴 켜짐·팻말 숨김 {base['tira']}")
    check(base["taro"][0] > 0.99 and base["taro"][1] < 0.01 and base["taro"][2] < 0.01, f"타로타로: 점눈 켜짐·감은 눈/느낌표 숨김 {base['taro']}")
    check(base["duck"][0] < 0.01 and base["duck"][1] < 0.01, f"도로덕: 팻말·겹친 날개 숨김 {base['duck']}")
    for cid in ["chumdani", "tira", "tarotaro", "giltong", "charocharo", "doroduck"]:
        g = p.evaluate(GBOX, cid); cx, cy = (g[0] + g[2]) / 2, g[1] + (g[3] - g[1]) * 0.4
        for side in (-1, 1):
            p.mouse.move(700, 80); p.wait_for_timeout(500)
            p.mouse.move(cx + side * (g[2] - g[0]) * 0.3, cy, steps=4)
            ok = False
            for _ in range(20):
                p.wait_for_timeout(100)
                if p.evaluate("__ssMouse.state().__acting") == cid: ok = True; break
            check(ok, f"{cid}: 머무르면 반응해야 함({'왼' if side < 0 else '오른'}쪽)")
            st = p.evaluate("__ssMouse.state()")
            check(sum(1 for k, v in st.items() if k != "__acting" and v.get("act")) == 1, f"{cid}: 한 명만 반응 {st}")
            if cid != "giltong": check(st[cid]["dir"] == ("L" if side < 0 else "R"), f"{cid}: 커서 방향 동작 {st[cid]}")
            p.mouse.move(700, 80); p.wait_for_timeout(700)
            check(not p.evaluate("(id)=>__ssMouse.state()[id].act", cid), f"{cid}: 벗어나면 복귀")
            if cid == "giltong": break
            p.wait_for_timeout(6200 if side < 0 else 0)   # 같은 친구의 다음 시작은 간격(최대 6초) 뒤

ORDER = ["chumdani", "tira", "tarotaro", "giltong", "charocharo", "doroduck"]   # 화면 왼쪽부터
def kbs(p): return p.evaluate("(()=>{const s=__ssMouse.state(),o={};for(const k in s)if(k[0]!=='_')o[k]=s[k].kb;return o})()")
FACE = """(()=>{const L=__ssIntro.info().last,g=L.giltong.fp,c=L.charocharo.fp,t=L.tira.fp,ch=L.chumdani.fp,d=L.doroduck.fp,tt=L.tarotaro.fp;
  return {giltong:[g.eyeL.img,g.eyeR.img,+(g.k_armLTop.op>.5),+(g.k_armRTop.op>.5)],charocharo:[c.eyeL.img,c.eyeR.img],tira:[t.headImg.img,+(t.m_face.op>.5),+(t.m_eyeL.op>.5)],
    chumdani:[ch.eyeL.img,ch.eyeR.img],doroduck:[d.eyeL.img,d.eyeR.img],tarotaro:[tt.eyes.img,+(tt.eyes.op>.5),+(tt.m_eyeL.op>.5)]}})()"""
CLOSED = {"giltong": [1, 1, 1, 1], "charocharo": [2, 2], "tira": [1, 0, 0], "chumdani": [1, 1], "doroduck": [1, 1], "tarotaro": [0, 1, 0]}
OPEN = {"giltong": [0, 0, 0, 0], "charocharo": [0, 0], "tira": [0, 1, 1], "chumdani": [0, 0], "doroduck": [0, 0], "tarotaro": [0, 0, 1]}
def frames(p, n=2): p.evaluate("(n)=>new Promise(r=>{let i=0;(function f(){if(++i>n)r();else requestAnimationFrame(f)})()})", n)

def t_keys_type(b, ctx, m):
    """아이디 입력: 화면 왼쪽부터 한 명씩 타자(2.1초), 2.2초 간격으로 다음 친구, 동시에 큰 동작은 한 명, 작은 동조는 다른 한 명 / 키마다 다시 시작·쌓기 없음 / 멈추면 마무리만 / 한글 조합은 끝날 때 한 번"""
    p = open_mouse(ctx, m); p.mouse.move(700, 60)
    check(p.evaluate("__ssMouse.state().__keys.order") == ORDER, f"주연 순서는 화면 왼쪽부터: {p.evaluate('__ssMouse.state().__keys.order')}")
    p.click("#ssU"); p.keyboard.type("a"); frames(p)
    k = kbs(p); check(k["chumdani"] == "kb_type" and list(k.values()).count("kb_type") == 1, f"첫 입력: 맨 왼쪽 첨다니 한 명만 타자 {k}")
    check(list(k.values()).count("kb_echo") == 1 and k["tarotaro"] == "kb_echo", f"작은 동조는 다른 한 명 {k}")
    check(p.evaluate("__ssIntro.info().last.__order.slice(-1)[0]") == "chumdani", "타자하는 친구가 맨 앞")
    seen, maxtype = [], 0
    for i in range(50):                   # 약 6초 동안 빠르게 입력
        p.keyboard.type("b"); p.wait_for_timeout(110)
        k = kbs(p); ty = [c for c, v in k.items() if v == "kb_type"]; maxtype = max(maxtype, len(ty))
        for c in ty:
            if not seen or seen[-1] != c: seen.append(c)
    check(maxtype == 1, f"큰 타자 동작은 언제나 한 명: 최대 {maxtype}")
    check(seen[:3] == ORDER[:3], f"2.2초마다 다음 친구(왼쪽부터): {seen}")
    p.wait_for_timeout(2300); k = kbs(p)
    check(all(v is None for v in k.values()), f"입력을 멈추면 하던 것만 끝내고 더 이어지지 않음 {k}")
    # 한글 조합: 조합 중 input 은 무시, 조합이 끝날 때 한 번
    p.wait_for_timeout(200)
    p.evaluate("""(()=>{const u=document.getElementById('ssU');u.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
      for(let i=0;i<5;i++)u.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,data:'ㄱ'}))})()""")
    frames(p); k = kbs(p); check(all(v is None for v in k.values()), f"한글 조합 중에는 아직 반응 안 함 {k}")
    p.evaluate("document.getElementById('ssU').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'가'}))"); frames(p)
    k = kbs(p); check(list(k.values()).count("kb_type") == 1, f"조합이 끝나면 한 번 반응 {k}")

def t_keys_password(b, ctx, m):
    """비밀번호 칸: 첫 프레임에 여섯 모두 감은 눈(타자 도중이어도) → 3초 반복 자세 / 입력 글자 수와 무관 / 마우스 반응·시선 없음 / 나오면 0.65초 뒤 눈 뜸"""
    p = open_mouse(ctx, m); p.mouse.move(700, 60)
    check(p.evaluate(FACE) == OPEN, f"기본 얼굴(눈 뜸): {p.evaluate(FACE)}")
    p.click("#ssU"); p.keyboard.type("ab"); p.wait_for_timeout(400)
    p.focus("#ssP"); frames(p)
    k = kbs(p); check(set(k.values()) == {"kb_private_in"}, f"비밀번호 칸: 여섯 모두 '안 볼게' {k}")
    fc = p.evaluate(FACE); fc["giltong"][2:] = [1, 1]
    check(fc == CLOSED, f"첫 프레임부터 감은 눈 {p.evaluate(FACE)}")
    p.wait_for_timeout(900); check(set(kbs(p).values()) == {"kb_private_hold"}, "0.65초 뒤 조용히 기다리기(반복)")
    check(p.evaluate(FACE) == CLOSED, f"기다리는 동안 감은 눈·길통이 팔은 볼 앞 {p.evaluate(FACE)}")
    g = p.evaluate(GBOX, "giltong"); p.mouse.move((g[0] + g[2]) / 2 + 10, g[1] + (g[3] - g[1]) * 0.4, steps=3); p.wait_for_timeout(1300)
    st = ms(p, "giltong"); check(not st.get("act") and abs(st.get("gx", 0)) < 0.01, f"비밀번호 칸에서는 마우스 반응·시선 없음 {st}")
    check(p.evaluate(FACE) == CLOSED, "커서를 가까이 두어도 눈을 뜨지 않음")
    pose = "(()=>{const L=__ssIntro.info().last;return JSON.stringify(Object.keys(L).filter(k=>k[0]!=='_').map(k=>Object.values(L[k].fp).map(f=>[f.img,+f.op.toFixed(2)])))})()"
    p.mouse.move(700, 60); p.wait_for_timeout(300); a = p.evaluate(pose)
    p.keyboard.type("x"); p.wait_for_timeout(200); b1 = p.evaluate(pose)
    p.keyboard.type("aB3$ 긴비밀번호입력", delay=20); p.wait_for_timeout(200); b2 = p.evaluate(pose)
    check(a == b1 == b2 and set(kbs(p).values()) == {"kb_private_hold"}, "비밀번호 입력·글자 수에 따라 그림이 바뀌지 않음")
    p.click("#ssU"); frames(p); check(set(kbs(p).values()) == {"kb_private_out"}, "다른 칸으로 가면 0.65초 동안 돌아옴")
    check(p.evaluate(FACE)["charocharo"] == [2, 2], "돌아오는 동안은 아직 감은 눈")
    p.wait_for_timeout(900); check(all(v is None for v in kbs(p).values()), "돌아오기 끝")
    check(p.evaluate(FACE) == OPEN, f"끝나면 눈 뜸·볼 앞 팔 숨김 {p.evaluate(FACE)}")
    p.keyboard.type("z"); frames(p); check(list(kbs(p).values()).count("kb_type") == 1, "돌아온 뒤 아이디 입력에는 다시 반응")

def t_keys_reduced_off(b, ctx, m):
    """움직임 줄이기: 타자 동작 없음, 비밀번호 때 감은 눈(그림만, 자세는 그대로) / ?keys=off: 키보드 반응 없음(마우스는 그대로)"""
    rc = b.new_context(reduced_motion="reduce"); p = open_mouse(rc, m)
    p.click("#ssU"); p.keyboard.type("abc"); frames(p); check(all(v is None for v in kbs(p).values()), "움직임 줄이기: 타자 동작 없음")
    arm = "__ssIntro.info().last.giltong.fp.armL.rot"; r0 = p.evaluate(arm)
    p.focus("#ssP"); p.wait_for_timeout(900); fc = p.evaluate(FACE)
    check(fc["charocharo"] == [2, 2] and fc["giltong"] == [1, 1, 0, 0], f"움직임 줄이기: 감은 눈만(볼 앞 팔 없음) {fc}")
    check(abs(p.evaluate(arm) - r0) < 3, "움직임 줄이기: 팔 자세는 그대로")
    rc.close()
    p = ctx.new_page(); p.set_viewport_size({"width": 1440, "height": 900}); p.route("**/*", T.route); p.route(SBM.SB + "/**", m.handle)
    p.goto(T.URL + "?keys=off"); p.wait_for_selector("#ssGate", state="attached", timeout=20000)
    wait_js(p, "!!(window.__ssIntro && __ssIntro.info().state === 'play')"); p.keyboard.press("Escape"); wait_js(p, "__ssIntro.info().state === 'wait'", 4000); p.wait_for_timeout(300)
    p.click("#ssU"); p.keyboard.type("abc"); p.focus("#ssP"); p.wait_for_timeout(300)
    check(all(v is None for v in kbs(p).values()) and p.evaluate(FACE)["charocharo"] == [0, 0], "?keys=off 면 키보드 반응 없음")
    check(p.evaluate("__ssMouse.hover") is True, "?keys=off 여도 마우스 반응은 그대로")

def t_keys_mobile_lock(b, ctx, m):
    """휴대폰: 입력하는 동안 화면 높이가 바뀌어도(화면 키보드) 친구들 위치·크기를 다시 계산하지 않음, 입력이 끝나면 다시 맞춤 / 터치 기기에서도 키보드 반응"""
    mc = b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    p = mc.new_page(); p.on("pageerror", lambda e: errors.append(str(e))); p.route("**/*", T.route); p.route(SBM.SB + "/**", m.handle)
    p.goto(T.URL); p.wait_for_selector("#ssGate", state="attached", timeout=20000)
    wait_js(p, "!!(window.__ssIntro && __ssIntro.info().state === 'play')"); p.evaluate("__ssIntro.jump(5.15)"); wait_js(p, "__ssIntro.info().state === 'wait'", 4000); p.wait_for_timeout(1000)
    lay = "JSON.stringify(window.__ssLayout)"; L0 = p.evaluate(lay)
    p.tap("#ssU"); p.wait_for_timeout(300); p.keyboard.type("a"); frames(p)
    check(list(kbs(p).values()).count("kb_type") == 1, "터치 기기에서도 아이디 입력에 반응")
    p.set_viewport_size({"width": 390, "height": 500}); p.wait_for_timeout(500)
    check(p.evaluate(lay) == L0, "입력 중 화면 높이가 바뀌어도 배치 그대로")
    check(p.evaluate("document.getElementById('ssIntro').style.height") == "844px", "입력 중 친구들 무대 높이 고정")
    p.set_viewport_size({"width": 390, "height": 844}); p.evaluate("document.activeElement.blur()"); p.wait_for_timeout(600)
    check(p.evaluate("document.getElementById('ssIntro').style.height") == "", "입력이 끝나면 고정 풀림")
    check(p.evaluate(lay) == L0, "원래 크기로 돌아오면 같은 배치")
    mc.close()

TESTS = [t_off_switch, t_preview_intro_then_login, t_single_move, t_skip, t_auto_login_no_intro, t_intro_files_missing, t_loader_missing, t_password_no_reaction, t_reduced_motion, t_mouse_giltong, t_mouse_blocked, t_mouse_all, t_keys_type, t_keys_password, t_keys_reduced_off, t_keys_mobile_lock]
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
