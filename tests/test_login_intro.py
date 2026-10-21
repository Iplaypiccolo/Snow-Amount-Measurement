"""
로그인 인트로·새 로그인 화면(기본 화면, 비상용 ?intro=off) 자동 테스트 — 브라우저로 직접 열어 봅니다. (Supabase 는 가짜 서버 tests/_sb_mock.py)
확인하는 것: 정렬 단계에서 크기·위치가 한 번에 바뀜(PC·휴대폰) / ?intro=off 면 예전 화면(인트로 파일도 안 받음) / 기본은 인트로 → 새 로그인 화면(친구들 줄은 왼쪽·상자는 오른쪽, 휴대폰은 상자 아래 줄) / 인트로 중 칸 잠금 /
             건너뛰기(Esc·버튼) / 자동 로그인 사람은 인트로 없음 / 인트로 파일을 못 받으면 바로 로그인 화면 / 비밀번호 입력에 화면이 반응하지 않음 /
             움직임 줄이기 / 새 화면에서도 로그인이 그대로 됨 / 보안 정책(CSP) 아래에서 오류 없음 /
             친구들 마우스 반응(머무르면 반응·한 명만·방향·계속 머무르면 간격 두고 반복) / 키보드 반응(아이디 입력 = 친구마다 따로·대부분 작은 동조·가끔 큰 타자·한글 조합 묶음,
             비밀번호 칸 = 여섯 모두 첫 프레임에 감은 눈·마우스 반응 없음·입력 글자 수와 무관, 움직임 줄이기, ?keys=off, 휴대폰 입력 중 배치 고정) /
             터치 반응(톡 = 그 친구 큰 동작 한 번·친구마다 따로·같은 친구 연타 무시·쓸기/오래 누르기 취소·입력칸 무시·비밀번호 중 무시·첨다니 역회전 없음·움직임 줄이기·?tap=off)
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
    q.goto(T.URL + "?mouse=off&keys=off&tap=off"); q.wait_for_selector("#ssGate", state="attached", timeout=20000); wait_js(q, "!!(window.__ssIntro && __ssIntro.info().state === 'play')")
    check(q.evaluate("!window.__ssMouse && !window.CharoLoginMouse"), "?mouse=off&keys=off&tap=off 면 반응 파일을 받지 않음(인트로는 그대로)")

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
    """아이디 입력: 친구마다 따로 — 쉬고 있는 친구를 무작위로 골라 대부분 작은 동조, 가끔 큰 타자(동시 2명까지) → 여러 친구가 한꺼번에 움직임 /
       키마다 다시 시작·쌓기 없음 / 멈추면 마무리만 / 한글 조합은 끝날 때 한 번"""
    p = open_mouse(ctx, m); p.mouse.move(700, 60)
    check(sorted(p.evaluate("__ssMouse.state().__keys.order")) == sorted(ORDER), "여섯 친구 모두 후보")
    p.click("#ssU"); p.keyboard.type("a"); frames(p)
    k = kbs(p); check(sum(1 for v in k.values() if v) == 1, f"첫 입력: 한 친구가 반응 {k}")
    moved, maxtype, maxall, nt, ne, prev = set(), 0, 0, 0, 0, {}
    for i in range(55):                   # 약 6초 동안 빠르게 입력
        p.keyboard.type("b"); p.wait_for_timeout(110)
        k = kbs(p); act = {c: v for c, v in k.items() if v}
        maxtype = max(maxtype, sum(1 for v in act.values() if v == "kb_type")); maxall = max(maxall, len(act))
        for c, v in act.items():
            moved.add(c)
            if prev.get(c) != v: nt += v == "kb_type"; ne += v == "kb_echo"
        prev = k
    check(maxall >= 3, f"여러 친구가 한꺼번에 움직임(최대 {maxall}명)")
    check(maxtype <= 2, f"큰 타자는 동시에 2명까지(최대 {maxtype})")
    check(len(moved) == 6, f"여섯 모두 한 번은 움직임: {sorted(moved)}")
    check(ne > nt >= 1, f"작은 동조가 큰 타자보다 많음(작은 {ne}, 큰 {nt})")
    p.wait_for_timeout(2300); k = kbs(p)
    check(all(v is None for v in k.values()), f"입력을 멈추면 하던 것만 끝내고 더 이어지지 않음 {k}")
    p.evaluate("""(()=>{const u=document.getElementById('ssU');u.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
      for(let i=0;i<5;i++)u.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,data:'ㄱ'}))})()""")
    frames(p); k = kbs(p); check(all(v is None for v in k.values()), f"한글 조합 중에는 아직 반응 안 함 {k}")
    p.evaluate("document.getElementById('ssU').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'가'}))"); frames(p)
    k = kbs(p); check(sum(1 for v in k.values() if v) == 1, f"조합이 끝나면 한 번 반응 {k}")

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
    p.keyboard.type("z"); frames(p); check(any(kbs(p).values()), "돌아온 뒤 아이디 입력에는 다시 반응")

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
    check(any(kbs(p).values()), "터치 기기에서도 아이디 입력에 반응")
    p.set_viewport_size({"width": 390, "height": 500}); p.wait_for_timeout(500)
    check(p.evaluate(lay) == L0, "입력 중 화면 높이가 바뀌어도 배치 그대로")
    check(p.evaluate("document.getElementById('ssIntro').style.height") == "844px", "입력 중 친구들 무대 높이 고정")
    p.set_viewport_size({"width": 390, "height": 844}); p.evaluate("document.activeElement.blur()"); p.wait_for_timeout(600)
    check(p.evaluate("document.getElementById('ssIntro').style.height") == "", "입력이 끝나면 고정 풀림")
    check(p.evaluate(lay) == L0, "원래 크기로 돌아오면 같은 배치")
    mc.close()

def tsd(p): return p.evaluate("(()=>{const s=__ssMouse.state(),o={};for(const k in s)if(k[0]!=='_')o[k]=s[k].tap;return o})()")
def center(p, cid):
    g = p.evaluate(GBOX, cid); return (g[0] + g[2]) / 2, g[1] + (g[3] - g[1]) * 0.55

def t_tap_all(b, ctx, m):
    """휴대폰에서 여섯 친구를 하나씩 톡: 그 친구만 큰 동작, 끝나면 대기 / 작은 원 표시 / 첨다니 공중제비 뒤 거꾸로 돌지 않음"""
    mc = b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    p = mc.new_page(); p.on("pageerror", lambda e: errors.append(str(e))); p.route("**/*", T.route); p.route(SBM.SB + "/**", m.handle)
    p.goto(T.URL); p.wait_for_selector("#ssGate", state="attached", timeout=20000)
    wait_js(p, "!!(window.__ssIntro && __ssIntro.info().state === 'play')"); p.evaluate("__ssIntro.jump(5.15)"); wait_js(p, "__ssIntro.info().state === 'wait'", 4000); p.wait_for_timeout(1200)
    for cid in ORDER:
        x, y = center(p, cid); p.touchscreen.tap(x, y); frames(p)
        k = tsd(p); check(k[cid] == "mt_tap" and sum(1 for v in k.values() if v) == 1, f"{cid}: 톡 하면 그 친구만 큰 동작 {k}")
        check(p.locator(".ss-tap-dot").count() >= 1, f"{cid}: 작은 원 표시")
        check(p.evaluate("__ssIntro.info().last.__order.slice(-1)[0]") == cid, f"{cid}: 동작하는 친구가 맨 앞")
        if cid == "chumdani":
            rots = []
            for _ in range(90):
                rots.append(p.evaluate("[__ssIntro.info().last.chumdani.fp.flip.rot, __ssMouse.state().chumdani.tap]")); p.wait_for_timeout(45)
            mid = [r for r, t in rots if t] ; after = [r for r, t in rots if not t]
            check(max(mid) > 300, f"첨다니: 한 바퀴 돎(최대 {max(mid):.0f}도)")
            bad = [r for r in after if 20 < (r % 360) < 340]
            check(after and not bad, f"첨다니: 끝난 뒤 거꾸로 돌지 않음 {[round(r) for r in after[:8]]}")
        else:
            wait_js(p, f"!__ssMouse.state()['{cid}'].tap", 4500)
        p.wait_for_timeout(450)
    mc.close()

def t_tap_rules(b, ctx, m):
    """같은 친구 연타는 다시 시작·예약 없음, 다른 친구는 동시에 / 12px 넘게 쓸면 취소 / 오래 누르면 취소 / 입력칸 누르기는 무시 / 비밀번호 칸에 있으면 톡 무시 / ?tap=off"""
    p = open_mouse(ctx, m); p.mouse.move(700, 60)
    x, y = center(p, "giltong"); x2, y2 = center(p, "doroduck")
    p.mouse.click(x, y); frames(p); check(tsd(p)["giltong"] == "mt_tap", "클릭(톡)으로 큰 동작")
    t0 = p.evaluate("__ssMouse.state().giltong.tapT0")
    p.wait_for_timeout(300); p.mouse.click(x, y); p.wait_for_timeout(300); p.mouse.click(x2, y2); frames(p)
    k = tsd(p); check(k["giltong"] == "mt_tap" and p.evaluate("__ssMouse.state().giltong.tapT0") == t0, f"같은 친구를 다시 눌러도 다시 시작 안 함 {k}")
    check(k["doroduck"] == "mt_tap", f"다른 친구는 움직이는 중에도 바로 시작(친구마다 따로) {k}")
    wait_js(p, "!__ssMouse.state().giltong.tap && !__ssMouse.state().doroduck.tap && !__ssMouse.state().__tap.busy", 5000)
    check(all(v is None for v in tsd(p).values()), "끝난 뒤 쌓아 둔 동작 없음")
    p.mouse.move(x, y); p.mouse.down(); p.wait_for_timeout(200)
    check(tsd(p)["giltong"] == "mt_press", "누르고 있으면 준비 자세")
    p.mouse.move(x + 30, y, steps=3); frames(p, 3); check(tsd(p)["giltong"] in ("mt_cancel", None), "12px 넘게 쓸면 취소")
    p.mouse.up(); p.wait_for_timeout(400); check(all(v is None for v in tsd(p).values()), "쓸고 떼도 큰 동작 없음")
    p.mouse.move(x, y); p.mouse.down(); p.wait_for_timeout(700); p.mouse.up(); frames(p)
    check(tsd(p)["giltong"] != "mt_tap", "0.45초 넘게 누르면 큰 동작 없음")
    p.wait_for_timeout(400)
    p.click("#ssU"); frames(p); check(all(v is None for v in tsd(p).values()), "입력칸 누르기는 친구 톡이 아님")
    p.focus("#ssP"); p.wait_for_timeout(300); p.mouse.click(x, y); frames(p)
    check(all(v is None for v in tsd(p).values()) and p.evaluate(FACE)["giltong"][:2] == [1, 1], "비밀번호 칸에 있으면 톡 무시·눈 감은 그대로")
    p.click("#ssU"); p.wait_for_timeout(900)
    q = ctx.new_page(); q.set_viewport_size({"width": 1440, "height": 900}); q.route("**/*", T.route); q.route(SBM.SB + "/**", m.handle)
    q.goto(T.URL + "?tap=off"); q.wait_for_selector("#ssGate", state="attached", timeout=20000)
    wait_js(q, "!!(window.__ssIntro && __ssIntro.info().state === 'play')"); q.keyboard.press("Escape"); wait_js(q, "__ssIntro.info().state === 'wait'", 4000); q.wait_for_timeout(300)
    q.mouse.click(*center(q, "giltong")); frames(q); check(all(v is None for v in tsd(q).values()), "?tap=off 면 톡 반응 없음")

def t_tap_reduced(b, ctx, m):
    """움직임 줄이기: 톡 하면 작게만, 첨다니 공중제비 없음"""
    rc = b.new_context(reduced_motion="reduce"); p = open_mouse(rc, m); p.mouse.move(700, 60)
    p.mouse.click(*center(p, "chumdani")); frames(p); check(tsd(p)["chumdani"] == "mt_tap", "움직임 줄이기에도 톡 반응")
    rots = []
    for _ in range(30): rots.append(abs(p.evaluate("__ssIntro.info().last.chumdani.fp.flip.rot"))); p.wait_for_timeout(60)
    check(max(rots) < 1, f"움직임 줄이기: 공중제비 없음(최대 {max(rots):.1f}도)")
    rc.close()

def t_agent_preview(b, ctx, m):
    """비밀번호 요원 모드(미리보기 ?agent=preview, 여섯 친구 모두 45도 요원 그림): 비밀번호 칸 → 어두운 장면·사선 대형(앞→뒤 도로덕…길통이)·
       길통이 눈 감기 → 사선 머리·몸통 → 선글라스, 다른 친구는 눈 감기 / 입력과 무관 / 나오면 0.42초에 원래 자리·얼굴 / 다시 들어오면 이어 감 / 기본 주소는 그대로"""
    p = ctx.new_page(); p.set_viewport_size({"width": 1440, "height": 900}); p.on("pageerror", lambda e: errors.append(str(e)))
    p.route("**/*", T.route); p.route(SBM.SB + "/**", m.handle)
    p.goto(T.URL + "?agent=preview"); p.wait_for_selector("#ssGate", state="attached", timeout=20000)
    wait_js(p, "!!(window.__ssIntro && __ssIntro.info().state === 'play')"); p.keyboard.press("Escape"); wait_js(p, "__ssIntro.info().state === 'wait'", 4000); p.wait_for_timeout(400)
    p.mouse.move(5, 5)
    G0 = "(()=>{const f=__ssIntro.info().last.giltong.fp;return {head:f.head.img,body:f.body.img,mouth:+(f.mouth.op>.5),glass:+(f.k_agentGlasses.op>.5),eye:+(f.eyeL.op>.5),eyeImg:f.eyeL.img,arm:Math.round(f.armL.rot)}})()"
    C0 = "(()=>{const f=__ssIntro.info().last.charocharo.fp;return {body:f.body.img,glass:+(f.k_agentGlasses.op>.5),eye:+(f.eyeL.op>.5),eyeImg:f.eyeL.img,mouth:+(f.mouth.op>.5)}})()"
    box0 = {c: p.evaluate(GBOX, c) for c in ORDER}
    check(p.evaluate(G0)["glass"] == 0 and not p.evaluate("document.documentElement.classList.contains('ss-agent')"), "평소에는 선글라스·어두운 장면 없음")
    p.focus("#ssP"); frames(p)
    g = p.evaluate(G0); check(g["eyeImg"] == 0 and g["eye"] == 1 and g["mouth"] == 1 and g["glass"] == 0 and g["head"] == 0, f"첫 프레임: 눈 감기 없이 평소 얼굴 그대로(v5) {g}")
    check(p.evaluate("document.documentElement.classList.contains('ss-agent')"), "어두운 장면 켜짐")
    k = kbs(p); check(all(k[c] == "ag_in" for c in ORDER), f"여섯 모두 요원 동작 {k}")
    D0 = "(()=>{const f=__ssIntro.info().last.doroduck.fp;return [f.body.img,+(f.k_agentGlasses.op>.5),+(f.eyeL.op>.5),+(f.beak.op>.5),+(f.sign.op>.5),+(f.wingRf.op>.5)]})()"
    V0 = """(()=>{const L=__ssIntro.info().last,c=L.chumdani.fp,t=L.tarotaro.fp;return {ch:[c.body.img,+(c.k_agentGlasses.op>.5),+(c.eyeL.op>.5),+(c.wifi0.op>.5),+(c.m_sparkle.op>.5)],tt:[t.bodyImg.img,+(t.k_agentGlasses.op>.5),+(t.eyes.op>.5),+(t.m_eyeL.op>.5),+(t.excl.op>.5)]}})()"""
    T0 = "(()=>{const f=__ssIntro.info().last.tira.fp;return {head:+(f.headImg.op>.5),headImg:f.headImg.img,body:+(f.k_agentBody.op>.5),buried:+!!f.k_agentBuried,snow:+!!f.k_agentSnow,glass:+(f.k_agentGlasses.op>.5),face:+(f.m_face.op>.5),orig:+(f.body.op>.5)}})()"
    check(p.evaluate("(()=>{const a=__ssIntro.cast.find(c=>c.id==='tira').P.agent;return !a.bury&&!a.puffs&&a.version===4})()"), "티라: 머리 박기·눈가루 설정 없음(v4)")
    tt = p.evaluate(T0); check(tt["headImg"] == 0 and tt["face"] == 1 and tt["body"] == 0, f"티라 첫 프레임: 평소 얼굴(마우스 얼굴) 그대로, 감은 눈 아님 {tt}")
    cc = p.evaluate(C0); check(cc["eyeImg"] == 0 and cc["eye"] == 1 and cc["body"] == 0 and cc["glass"] == 0, f"차로차로 첫 프레임: 평소 눈 그대로(눈 감기 없음) {cc}")
    p.wait_for_timeout(1000); tt = p.evaluate(T0)
    check(tt["buried"] == 0 and tt["snow"] == 0 and tt["body"] == 1 and tt["glass"] == 1 and tt["orig"] == 0, f"티라 v3: 머리 박기 없이 선 채로 사선 몸체·선글라스 {tt}")
    p.wait_for_timeout(500); g = p.evaluate(G0)
    check(g["head"] == 2 and g["body"] == 2 and g["glass"] == 1 and g["eye"] == 0 and g["mouth"] == 0, f"길통이: 45도 머리(감은 눈·다문 입 포함)·몸통·선글라스, 원래 눈·입은 숨김 {g}")
    check(-94 <= g["arm"] <= -86, f"길통이 가까운 팔은 35도 자세 값(-90도, 원본 원통팔 그림) {g['arm']}")
    W0 = "(()=>{const f=__ssIntro.info().last.charocharo.fp;return [+(f.k_cameraWheelL.op>.5),+(f.k_cameraWheelR.op>.5),f.wingL.img,f.k_agentGlasses.img]})()"
    check(p.evaluate(W0) == [1, 1, 1, 1], f"차로차로 요원 바퀴·35도 날개·새 선글라스 {p.evaluate(W0)}")
    cc = p.evaluate(C0); check(cc["body"] == 2 and cc["glass"] == 1 and cc["eye"] == 0 and cc["mouth"] == 0, f"차로차로: 45도 몸통·선글라스, 원래 눈·입 숨김 {cc}")
    d = p.evaluate(D0); check(d == [2, 1, 0, 1, 0, 0], f"도로덕: 사선 몸통·선글라스·원본 부리, 원래 눈·팻말·앞 가림 날개 숨김 {d}")
    v = p.evaluate(V0); check(v["ch"] == [2, 1, 0, 1, 0] and v["tt"] == [3, 1, 0, 0, 0], f"첨다니(사선 트럭·선글라스·약한 신호)·타로타로(사선 차체·선글라스), 원래 눈 숨김 {v}")
    p.wait_for_timeout(700); tt = p.evaluate(T0)
    check(tt["body"] == 1 and tt["glass"] == 1 and tt["snow"] == 0 and tt["buried"] == 0 and tt["head"] == 0 and tt["orig"] == 0, f"티라: 사선 몸체·선글라스 유지 {tt}")
    check(p.evaluate("__ssIntro.cast.find(c=>c.id==='giltong').drawOrder.join()") == "cape,legR,legL,armR,body,armL,head,k_agentGlasses", "요원 그림일 때 앞뒤 순서(가까운 팔이 몸 앞)")
    check(p.evaluate("__ssMouse.state().__agent.p") == 1, "대형 이동 끝")
    bx = {c: p.evaluate(GBOX, c) for c in ORDER}
    fl = p.evaluate("['doroduck','charocharo','tira','chumdani','tarotaro','giltong'].map(k=>__ssMouse.floorNow(k))")   # v4: 수평 바닥(불투명 발·바퀴 아랫점)
    check(max(fl) - min(fl) < 3, f"여섯 모두 같은 수평 바닥 위 {[round(v) for v in fl]}")
    xs = [ (bx[c][0] + bx[c][2]) / 2 for c in ["doroduck", "charocharo", "tira", "chumdani", "tarotaro", "giltong"]]
    check(all(xs[i] < xs[i + 1] for i in range(5)), "앞에서 뒤로 왼쪽 → 오른쪽")
    order = p.evaluate("__ssIntro.info().last.__order")
    check(order.index("doroduck") > order.index("giltong"), "앞 친구(도로덕)가 뒤 친구(길통이)보다 앞에 그려짐")
    card = p.evaluate("(()=>{const r=document.querySelector('.ss-card').getBoundingClientRect();return [r.left,r.top,r.right,r.bottom]})()")
    check(all(bx[c][2] <= card[0] for c in ORDER), "대형이 로그인 상자를 침범하지 않음(PC)")
    pose = "JSON.stringify(Object.values(__ssIntro.info().last.giltong.fp).map(f=>[f.img,+f.op.toFixed(2)]))"
    a = p.evaluate(pose); p.keyboard.type("aB3$ 긴비밀번호", delay=20); p.wait_for_timeout(100); b2 = p.evaluate(pose)
    check(a == b2, "비밀번호 입력에 따라 그림이 바뀌지 않음")
    check(p.input_value("#ssP") == "aB3$ 긴비밀번호", "연출 중에도 비밀번호 입력이 됨")
    p.focus("#ssU"); frames(p); check(kbs(p)["giltong"] == "ag_out", "나오면 선글라스 거두기")
    p.wait_for_timeout(300); p.focus("#ssP"); frames(p)
    check(kbs(p)["giltong"] == "ag_hold", "나오는 중에 다시 들어오면 처음부터가 아니라 경계 자세로 이어 감")
    p.focus("#ssU"); p.wait_for_timeout(1000); g = p.evaluate(G0)
    check(g["head"] == 0 and g["body"] == 0 and g["glass"] == 0 and g["eye"] == 1 and g["eyeImg"] == 0 and g["mouth"] == 1, f"원래 얼굴·정면 {g}")
    cc = p.evaluate(C0); check(cc["body"] == 0 and cc["eye"] == 1 and cc["eyeImg"] == 0 and cc["glass"] == 0, f"차로차로 원래 얼굴 {cc}")
    w = p.evaluate(W0); check(w[0] == 0 and w[1] == 0 and w[2] == 0, f"차로차로: 요원 바퀴 숨김·원래 날개 {w}")
    check(p.evaluate("__ssIntro.cast.find(c=>c.id==='giltong').drawOrder") is None, "원래 앞뒤 순서")
    d = p.evaluate(D0); check(d[0] == 0 and d[1] == 0 and d[2] == 1 and d[3] == 1 and d[4] == 0, f"도로덕 원래 모습(팻말은 로그인 대기 때처럼 숨김) {d}")
    v = p.evaluate(V0); check(v["ch"][0] == 0 and v["ch"][1] == 0 and v["ch"][2] == 1 and v["tt"][0] == 0 and v["tt"][1] == 0 and v["tt"][3] == 1, f"첨다니·타로타로 원래 모습(타로타로 마우스용 점눈 포함) {v}")
    tt = p.evaluate(T0); check(tt["head"] == 1 and tt["headImg"] == 0 and tt["body"] == 0 and tt["orig"] == 1 and tt["face"] == 1, f"티라 원래 얼굴(마우스용 얼굴 포함) {tt}")
    bx = {c: p.evaluate(GBOX, c) for c in ORDER}
    SH = p.evaluate("__ssIntro.cast.map(c=>c.shift)")
    check(all(abs(bx[c][3] - box0[c][3]) < 3 and abs((bx[c][0] + bx[c][2]) - (box0[c][0] + box0[c][2])) / 2 < 12 for c in ORDER), f"원래 자리로 돌아옴 {[(c, [round(v) for v in box0[c]], [round(v) for v in bx[c]]) for c in ORDER]} {SH}")
    p.wait_for_timeout(700)
    check(not p.evaluate("document.documentElement.classList.contains('ss-agent')"), "어두운 장면 꺼짐")
    G.typed_login(p, "admin-01", SBM.ADMIN_PW); p.wait_for_selector(".topnav", state="visible")
    # 기본 주소에서는 요원 모드 없음
    q = open_mouse(ctx, m); q.focus("#ssP"); q.wait_for_timeout(1500)
    check(kbs(q)["giltong"] == "kb_private_hold" and not q.evaluate("document.documentElement.classList.contains('ss-agent')"), "기본 주소는 지금처럼(요원 모드 없음)")

def t_agent_reduced(b, ctx, m):
    """요원 모드 + 움직임 줄이기: 비밀번호 칸에 들어가면 완성 자세(선글라스·사선 대형)로 바로, 숫자는 멈춤"""
    rc = b.new_context(reduced_motion="reduce"); p = rc.new_page(); p.set_viewport_size({"width": 1440, "height": 900}); p.on("pageerror", lambda e: errors.append(str(e)))
    p.route("**/*", T.route); p.route(SBM.SB + "/**", m.handle)
    p.goto(T.URL + "?agent=preview"); p.wait_for_selector("#ssGate", state="attached", timeout=20000)
    wait_js(p, "!!(window.__ssIntro && __ssIntro.info().state === 'play')"); p.keyboard.press("Escape"); wait_js(p, "__ssIntro.info().state === 'wait'", 4000); p.wait_for_timeout(400)
    p.focus("#ssP"); frames(p, 3)
    f = p.evaluate("(()=>{const f=__ssIntro.info().last.giltong.fp;return [f.head.img,+(f.k_agentGlasses.op>.5),__ssMouse.state().__agent.p]})()")
    check(f == [2, 1, 1], f"움직임 줄이기: 바로 완성 자세(35도 머리 2번·선글라스·대형) {f}")
    rc.close()

TESTS = [t_off_switch, t_preview_intro_then_login, t_single_move, t_skip, t_auto_login_no_intro, t_intro_files_missing, t_loader_missing, t_password_no_reaction, t_reduced_motion, t_mouse_giltong, t_mouse_blocked, t_mouse_all, t_keys_type, t_keys_password, t_keys_reduced_off, t_keys_mobile_lock, t_tap_all, t_tap_rules, t_tap_reduced, t_agent_preview, t_agent_reduced]
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
