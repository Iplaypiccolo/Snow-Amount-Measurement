/*!
 * 로그인 화면 마우스 반응 (charo-mouse.js) — 인트로가 끝나 친구들이 자리 잡은 뒤에만 동작
 * - 인트로 재생기(charo-intro.js)의 afterPose 연결 고리로 '대기 자세 위에' 덧붙입니다. 인트로 데이터·재생은 그대로.
 * - 캐릭터 파일의 p.mouse 설정을 읽음: { clip, dwell(초), gap(초), gaze: {파츠: 최대 이동 또는 [가로, 세로](원본 좌표)}, head, headMax(도), headShift:[가로,세로],
 *   body, bodyMax(도), lag:[{part, rot, x, y, tau}], blink:{parts, every:[최소,최대 초]}, base:{파츠:{op,img}}, dir }
 *   · 시선: 눈(과 눈썹)을 커서 쪽으로 조금, 머리는 최대 headMax 도. 시간 기반으로 부드럽게(화면 주사율과 무관)
 *   · 반응 동작: 친구 주변(0.25H 여유)에 커서가 dwell 초 머무르면 clip 을 한 번 재생(키가 있는 속성만 대기 자세 위에 덮어씀).
 *     dir:true 인 친구는 커서가 왼쪽이면 clip+'_L', 오른쪽이면 clip+'_R'(시작할 때 방향 고정, 가운데면 직전 방향, 처음이면 왼쪽).
 *   · 한 번 재생 후에는 영역을 나갔다 다시 들어와야 하고, 시작 간격은 gap 초 이상. 커서가 14px 넘게 움직이면 머무름을 다시 셈.
 *   · 동시에 한 명만. 영역이 겹치면 커서에 가장 가까운 친구. 반응 중인 친구는 맨 앞에 그림(depthBoost).
 *   · 영역을 벗어나면 현재 자세에서 0.42초 동안 기본으로 돌아옴(추가 그림은 먼저 빨리 사라짐).
 * - 막는 때: 인트로 중, 비밀번호 칸에 있을 때(시선도 끔), 아이디를 입력하는 중(1.2초), 로그인 확인 중, 터치 전용 기기.
 *   움직임 줄이기: 반응 동작 없이 작은 시선만.
 * - 키를 듣는 것은 '아이디 칸에서 입력 중인지' 여부뿐이고, 비밀번호 칸의 키·글자 수에는 전혀 반응하지 않습니다.
 * - 같은 자리에 커서를 계속 두면 반응이 끝나고 repeat 초(기본 gap+6초) 뒤 다시 한 번(2026-10-20, 너무 잦지 않게).
 *
 * 키보드 반응(opt.keys 가 false 가 아니면, 터치 기기에서도): 캐릭터 파일의 kb_ 클립 5개를 씀(add_keys.js 가 넣음)
 *   · 아이디 칸 'input' 신호(한글 조합은 compositionend 에 한 번)만 씀. 무슨 키·글자·길이인지는 읽지 않음.
 *   · 주연 한 명이 kb_type(2.1초). 신호가 이어지면 2.2초 간격으로 화면 왼쪽부터 차례로 넘기고, 그다음 친구 하나만 kb_echo(0.62초).
 *     키마다 처음부터 다시 하지 않고, 쌓아 두지도 않음(입력이 멈추면 하던 것만 마무리).
 *   · 비밀번호 칸에 있는 동안(포커스만 봄): 여섯 모두 kb_private_in(0.65초) → kb_private_hold(3초 반복), 나오면 kb_private_out(0.65초).
 *     다른 모든 반응보다 우선 — 첫 프레임에 감은 눈, 마우스 반응·시선·깜빡임·타자는 끔. 비밀번호 칸의 input/keydown 은 듣지 않음.
 *   · 전환은 직전 자세에서 0.16초 동안 이어 붙임(눈·입 그림은 바로 바뀜). 마우스용 얼굴(m_ 파츠)은 키보드 동작 중 숨기고 p.keys.unbase 로 원래 얼굴을 켬.
 *   · 움직임 줄이기: 타자 동작 없음, 비밀번호 때 감은 눈(그림만)만.
 *
 * 터치·클릭 반응(opt.tap 이 false 가 아니면, 2026-10-20): 캐릭터 파일의 mt_press·mt_tap·mt_cancel
 *   · 친구 그림(불투명한 부분, 손가락 여유 6px) 위에서 시작한 주 포인터 하나만. 입력칸·버튼·로그인 상자 위는 무시.
 *   · 0.08초 넘게 누르고 있으면 작은 준비 자세(mt_press), 0.45초 안에 12px 이하로 움직이고 떼면 큰 동작(mt_tap) 한 번.
 *     12px 넘게 쓸기·오래 누르기·pointercancel·두 번째 손가락·탭 숨김 → 취소(mt_cancel). 시간은 performance.now.
 *   · preventDefault 를 하지 않음(스크롤·확대는 브라우저 그대로). click 은 듣지 않으므로 두 번 재생되지 않음.
 *   · 큰 동작은 한 번에 한 친구만. 재생 중 다시 누르면 작은 원만(다시 시작·예약·높이 누적 없음).
 *   · 우선순위: 비밀번호 > 터치 > 아이디 타자 > 마우스·대기. 비밀번호 칸에 있는 동안 터치는 아무것도 하지 않음.
 *   · 첨다니 공중제비(360도)는 끝나고 돌아올 때 각도를 가까운 쪽으로 맞춰 거꾸로 돌지 않음.
 *   · 움직임 줄이기: 움직임을 12%로, 공중제비·불꽃 없음.
 */
(function (global) {
  'use strict';
  var PROPS = ['x', 'y', 'rot', 'sx', 'sy', 'op'];
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function smooth(u) { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); }

  function create(opt) {
    var CP = global.CharoPet, doc = global.document, reduce = !!opt.reduce;
    var hover = true; try { hover = global.matchMedia('(hover: hover) and (pointer: fine)').matches; } catch (e) {}
    if (opt.mouse === false) hover = false;   // 마우스 반응만 끔(키보드 반응은 그대로)
    var ptr = { x: -1e4, y: -1e4, inside: false, t: 0 }, typingAt = -1e9, intro = null, frameAt = -1, frameNow = 0, acting = null, lastNow = 0;
    var st = {};   // 친구별 상태
    var TAP = opt.tap !== false, tap = { ptr: null, busyUntil: -1e9, last: {} }, live = false, masks = {};
    var KEYS = opt.keys !== false, kbOn = false, composing = false, kb = { mode: 'idle', pwAt: -1e9, outAt: -1e9, lastHero: -1e9, lastEcho: -1e9, leader: 0, order: [] };
    function now() { return global.performance.now() / 1000; }
    function onMove(e) { if (e.pointerType && e.pointerType !== 'mouse') return; ptr.x = e.clientX; ptr.y = e.clientY; ptr.inside = true; ptr.t = now(); }
    function onOut(e) { if (!e.relatedTarget) ptr.inside = false; }
    function onKey(e) { var a = doc.activeElement; if (a && a.id === opt.userField) typingAt = now(); }   // 아이디 칸만(무슨 키인지는 보지 않음)
    if (hover) {
      global.addEventListener('pointermove', onMove, { passive: true });
      doc.addEventListener('mouseout', onOut);
      global.addEventListener('blur', function () { ptr.inside = false; });
      doc.addEventListener('keydown', onKey, true);
    }
    if (KEYS) {   // 아이디 칸의 '입력 있었음' 신호만. 비밀번호 칸은 포커스(activeElement)만 프레임마다 확인
      var isUser = function (e) { return e.target && e.target.id === opt.userField; };
      doc.addEventListener('compositionstart', function (e) { if (isUser(e)) composing = true; }, true);
      doc.addEventListener('compositionend', function (e) { if (isUser(e)) { composing = false; signal(); } }, true);
      doc.addEventListener('input', function (e) { if (isUser(e) && !composing && !e.isComposing) signal(); }, true);
    }
    function clipOf(c, id) { return c.P && CP.findClip(c.P, id); }
    // ── 터치·클릭 ──
    function maskOf(P, asset) {   // 그림의 불투명한 곳(작게 줄인 알파). 아직 안 불러왔으면 null(사각형으로 판정)
      if (masks[asset] !== undefined) return masks[asset];
      var im = CP.imgFor(P, asset); if (!im || !im.complete || !im.naturalWidth) return null;
      try {
        var k = Math.min(1, 96 / Math.max(im.naturalWidth, im.naturalHeight)), w = Math.max(1, Math.round(im.naturalWidth * k)), h = Math.max(1, Math.round(im.naturalHeight * k));
        var cv = doc.createElement('canvas'); cv.width = w; cv.height = h; var x = cv.getContext('2d'); x.drawImage(im, 0, 0, w, h);
        var d = x.getImageData(0, 0, w, h).data, a = new Uint8Array(w * h); for (var i = 0; i < w * h; i++) a[i] = d[i * 4 + 3];
        masks[asset] = { w: w, h: h, a: a };
      } catch (e) { masks[asset] = null; }
      return masks[asset];
    }
    function hitPart(c, L, px, py) {   // 캔버스 픽셀 좌표가 이 친구의 보이는 그림 위인지(맨 앞 파츠부터)
      var P = c.P, W = CP.worldMatrices(P, L.fp);
      for (var i = P.parts.length - 1; i >= 0; i--) {
        var pt = P.parts[i], f = L.fp[pt.id]; if (!f || f.op <= 0.05) continue; var v = pt.images[f.img] || pt.images[0]; if (!v) continue;
        var q = CP.apply(CP.inv(CP.mul(L.view, W[pt.id])), px, py), u = (q[0] - v.x) / v.w, w = (q[1] - v.y) / v.h;
        if (u < 0 || u >= 1 || w < 0 || w >= 1) continue;
        var m = maskOf(P, v.asset); if (!m) return true;
        if (m.a[Math.floor(w * m.h) * m.w + Math.floor(u * m.w)] > 40) return true;
      }
      return false;
    }
    function hitAt(x, y) {
      if (!intro) return null;
      var info = intro.info(), order = (info.last.__order || []).slice().reverse(), cv = opt.canvas, r = cv.getBoundingClientRect(), k = cv.clientWidth ? cv.width / cv.clientWidth : 1;
      var R = [[0, 0], [6, 0], [-6, 0], [0, 6], [0, -6]];   // 손가락 여유 6px
      for (var j = 0; j < R.length; j++) for (var i = 0; i < order.length; i++) {
        var c = intro.cast.filter(function (z) { return z.id === order[i]; })[0], L = info.last[order[i]];
        if (c && c.P && L && hitPart(c, L, (x + R[j][0] - r.left) * k, (y + R[j][1] - r.top) * k)) return c;
      }
      return null;
    }
    function dot(x, y) {   // 작은 원(눌렀다는 표시)
      var el = doc.createElement('div'); el.className = opt.dotClass || 'charo-tap-dot'; el.setAttribute('aria-hidden', 'true');
      el.style.left = x + 'px'; el.style.top = y + 'px'; doc.body.appendChild(el);
      global.setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 500);
    }
    function tapRunning(t) { return t < tap.busyUntil; }
    function cancelTap() {
      var p = tap.ptr; if (!p) return; tap.ptr = null;
      var s = S(p.c); if (p.pressed && s.tap && s.tap.hold) { var cl = clipOf(p.c, 'mt_cancel'); s.tap = cl ? { clip: cl, t0: now() } : null; }
    }
    function playTap(c) {
      var t = now(), s = S(c), cl = clipOf(c, 'mt_tap');
      if (!cl || tapRunning(t) || t - (tap.last[c.id] || -1e9) < 0.25) return false;
      s.tap = { clip: cl, t0: t }; s.kb = null; tap.last[c.id] = t; tap.busyUntil = t + cl.dur + 0.15; return true;
    }
    function interactive(el) { return el && el.closest && el.closest('input,button,select,textarea,a,label,[role=button],.ss-card,.ss-skip'); }
    if (TAP) {
      doc.addEventListener('pointerdown', function (e) {
        if (!e.isPrimary) { cancelTap(); return; }               // 두 번째 손가락
        if (!live || kb.mode === 'pw' || tap.ptr || (e.pointerType === 'mouse' && e.button !== 0) || interactive(e.target)) return;
        var c = hitAt(e.clientX, e.clientY); if (!c) return;
        dot(e.clientX, e.clientY);
        tap.ptr = { id: e.pointerId, c: c, x: e.clientX, y: e.clientY, w0: now(), pressed: false };
      }, { capture: true, passive: true });
      doc.addEventListener('pointermove', function (e) { var p = tap.ptr; if (p && p.id === e.pointerId && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 12) cancelTap(); }, { capture: true, passive: true });
      doc.addEventListener('pointerup', function (e) {
        var p = tap.ptr; if (!p || p.id !== e.pointerId) return;
        var ok = now() - p.w0 <= 0.45 && Math.hypot(e.clientX - p.x, e.clientY - p.y) <= 12 && kb.mode !== 'pw';
        if (ok && playTap(p.c)) { tap.ptr = null; return; }
        cancelTap();
      }, { capture: true, passive: true });
      doc.addEventListener('pointercancel', function (e) { if (tap.ptr && tap.ptr.id === e.pointerId) cancelTap(); }, true);
      doc.addEventListener('visibilitychange', function () { if (doc.hidden) cancelTap(); });
    }
    function signal() {
      var t = now(); typingAt = t;
      if (!kbOn || reduce || kb.mode === 'pw' || t - kb.outAt < 0.65 || (opt.busy && opt.busy())) return;
      var L = kb.order, n = L.length; if (!n) return;
      if (t - kb.lastHero >= 2.2) {
        var h = L[kb.leader % n], sh = S(h), cl = clipOf(h, 'kb_type');
        if (cl && !sh.tap) { sh.kb = { clip: cl, t0: t }; kb.lastHero = t; }
        kb.leader = (kb.leader + 1) % n;
      }
      if (t - kb.lastEcho > 0.7) {
        var e = L[(kb.leader + 1) % n], se = S(e), ce = clipOf(e, 'kb_echo');
        if (ce && !se.tap && !(se.kb && t - se.kb.t0 < se.kb.clip.dur)) se.kb = { clip: ce, t0: t };
        kb.lastEcho = t;
      }
    }
    function blocked() {
      var a = doc.activeElement;
      return { gaze: !hover || !ptr.inside || (a && a.id === opt.passField), act: !hover || reduce || !ptr.inside || (a && a.id === opt.passField) ||
        now() - typingAt < 1.2 || !!tap.ptr || tapRunning(now()) || kb.mode === 'pw' || now() - kb.outAt < 0.65 || (opt.busy && opt.busy()) };
    }
    function S(c) {
      if (!st[c.id]) st[c.id] = { gx: 0, gy: 0, hr: 0, hy: 0, br: 0, lag: [], blinkAt: 0, dwellAt: 0, dwellX: 0, dwellY: 0, played: false, lastStart: -1e9, act: null, ret: null, dir: 'L', box: null };
      return st[c.id];
    }
    // 화면(CSS px) 위 그림 범위: 지난 프레임의 자세·위치로 계산
    function boxOf(c) {
      var L = intro && intro.info().last[c.id]; if (!L) return null;
      var cv = opt.canvas, k = cv.clientWidth ? cv.width / cv.clientWidth : 1, r = cv.getBoundingClientRect();
      var W = CP.worldMatrices(c.P, L.fp), x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      c.P.parts.forEach(function (pt) {
        var f = L.fp[pt.id]; if (!f || f.op <= 0.01) return; var v = pt.images[f.img] || pt.images[0]; if (!v) return;
        var m = CP.mul(L.view, W[pt.id]);
        [[v.x, v.y], [v.x + v.w, v.y], [v.x, v.y + v.h], [v.x + v.w, v.y + v.h]].forEach(function (q) { var a = CP.apply(m, q[0], q[1]); x0 = Math.min(x0, a[0]); x1 = Math.max(x1, a[0]); y0 = Math.min(y0, a[1]); y1 = Math.max(y1, a[1]); });
      });
      if (x0 > x1) return null;
      return { x0: r.left + x0 / k, y0: r.top + y0 / k, x1: r.left + x1 / k, y1: r.top + y1 / k };
    }
    function clipFor(c, s) { var M = c.P.mouse; return CP.findClip(c.P, M.dir ? M.clip + '_' + s.dir : M.clip); }

    // 한 프레임에 한 번: 누가 반응할지 정함
    function tick(t, list) {
      var dt = lastNow ? Math.min(0.1, t - lastNow) : 0; lastNow = t; live = true;
      if (tap.ptr) {   // 누르는 중: 0.08초 뒤 준비 자세, 0.45초 넘으면 오래 누르기라 취소
        var tp = tap.ptr, sp = S(tp.c);
        if (t - tp.w0 > 0.45) cancelTap();
        else if (!tp.pressed && t - tp.w0 >= 0.08 && !tapRunning(t)) { var pc = clipOf(tp.c, 'mt_press'); if (pc) { sp.tap = { clip: pc, t0: t, hold: true }; sp.kb = null; } tp.pressed = true; }
      }
      if (KEYS) {   // 비밀번호 칸에 있는지(포커스만), 주연 순서(화면 왼쪽부터)
        kbOn = true;
        var ae = doc.activeElement, pw = !!(ae && ae.id === opt.passField);
        if (pw && kb.mode !== 'pw') { kb.mode = 'pw'; kb.pwAt = t; tap.ptr = null; tap.busyUntil = -1e9; list.forEach(function (c) { var s0 = S(c); s0.kb = null; s0.tap = null; if (s0.act) { s0.act = null; s0.ret = null; s0.endAt = t; } }); acting = null; }
        else if (!pw && kb.mode === 'pw') { kb.mode = 'idle'; kb.outAt = t; }
        kb.order = list.filter(function (c) { return S(c).box; }).sort(function (a, b) { var A = S(a).box, B2 = S(b).box; return (A.x0 + A.x1) - (B2.x0 + B2.x1); });
      }
      var B = blocked(), best = null, bestD = 1e9;
      list.forEach(function (c) {
        var s = S(c), b = s.box = boxOf(c); if (!b) return;
        var H = b.y1 - b.y0, m = 0.25 * H, inZone = ptr.inside && ptr.x >= b.x0 - m && ptr.x <= b.x1 + m && ptr.y >= b.y0 - m && ptr.y <= b.y1 + m;
        // 시선 목표(-1~1): 친구 가운데 기준, 범위는 친구 크기
        var cx = (b.x0 + b.x1) / 2, cy = b.y0 + H * 0.3, tx = 0, ty = 0;
        if (!B.gaze) { tx = clamp((ptr.x - cx) / Math.max(60, (b.x1 - b.x0) * 1.5), -1, 1); ty = clamp((ptr.y - cy) / Math.max(60, H * 1.2), -1, 1); }
        if (s.act) { tx = s.act.gx + tx * 0.35; ty = s.act.gy + ty * 0.35; }   // 반응 중에는 시작 방향 중심으로, 커서를 좁게만 따라감
        var a = 1 - Math.exp(-dt / 0.14), ah = 1 - Math.exp(-dt / 0.24);  // 눈 먼저, 머리는 조금 늦게
        var ab = 1 - Math.exp(-dt / 0.4);   // 몸은 더 늦게
        s.gx += (tx - s.gx) * a; s.gy += (ty - s.gy) * a; s.hr += ((s.act ? 0 : tx) - s.hr) * ah; s.hy += ((s.act ? 0 : ty) - s.hy) * ah; s.br += ((s.act ? 0 : tx) - s.br) * ab;
        (c.P.mouse.lag || []).forEach(function (L, i) { var al = 1 - Math.exp(-dt / (L.tau || 0.3)); s.lag[i] = (s.lag[i] || 0) + ((s.act ? 0 : tx) - (s.lag[i] || 0)) * al; });   // 귀·꼬리·안테나 등 늦게 따라오는 파츠
        if (!inZone) { s.played = false; s.dwellAt = 0; if (s.act) cancel(c, s, t); return; }
        if (s.act && B.act) { cancel(c, s, t); return; }
        if (Math.hypot(ptr.x - s.dwellX, ptr.y - s.dwellY) > 14 || !s.dwellAt) { s.dwellAt = t; s.dwellX = ptr.x; s.dwellY = ptr.y; }
        var d = Math.hypot(ptr.x - cx, ptr.y - (b.y0 + b.y1) / 2) / H;
        if (d < bestD) { bestD = d; best = c; }
      });
      if (acting) { var sa = S(acting); if (!sa.act && !sa.ret) acting = null; }
      if (!acting && best && !B.act) {
        var s = S(best), M = best.P.mouse;
        var again = s.played && s.endAt && t - s.endAt >= (M.repeat || M.gap + 6);   // 같은 자리에 계속 있으면 끝나고 repeat 초 뒤 한 번 더
        if ((!s.played || again) && t - s.dwellAt >= M.dwell && t - s.lastStart >= M.gap) {
          var b = s.box, cx = (b.x0 + b.x1) / 2, w = (b.x1 - b.x0) * 0.08;
          s.dir = ptr.x < cx - w ? 'L' : ptr.x > cx + w ? 'R' : (s.dir || 'L');
          var cl = clipFor(best, s);
          if (cl) { s.act = { clip: cl, t0: t, gx: s.dir === 'L' ? -0.8 : 0.8, gy: -0.2 }; s.ret = null; s.played = true; s.endAt = 0; s.lastStart = t; acting = best; }
        }
      }
      list.forEach(function (c) { var s = S(c); c.depthBoost = (s.act || s.ret || s.tap || (s.kb && s.kb.clip.id === 'kb_type' && t - s.kb.t0 < s.kb.clip.dur)) ? 10 : 0; });
    }
    function cancel(c, s, t) { if (!s.act) return; s.ret = { t0: t, dur: 0.42, from: s.last }; s.act = null; s.endAt = t; }

    // 키보드 동작: 지금 이 친구가 재생할 kb_ 클립과 그 안의 시각
    function kbNow(c, s, t) {
      var d;
      if (s.tap && kb.mode !== 'pw') {   // 터치(비밀번호 다음으로 우선)
        d = t - s.tap.t0;
        if (s.tap.hold) return { id: s.tap.clip.id, tt: Math.min(d, s.tap.clip.dur), key: 'press@' + s.tap.t0, tap: true };
        if (d < s.tap.clip.dur) return { id: s.tap.clip.id, tt: d, key: s.tap.clip.id + '@' + s.tap.t0, tap: true };
        s.tap = null;
      }
      if (!KEYS) return null;
      if (kb.mode === 'pw') { d = t - kb.pwAt; return d < 0.65 ? { id: 'kb_private_in', tt: d, key: 'in' } : { id: 'kb_private_hold', tt: (d - 0.65) % 3, key: 'hold' }; }
      d = t - kb.outAt; if (d < 0.65) return { id: 'kb_private_out', tt: d, key: 'out' };
      if (s.kb) { d = t - s.kb.t0; if (d < s.kb.clip.dur) return { id: s.kb.clip.id, tt: d, key: s.kb.clip.id + '@' + s.kb.t0 }; s.kb = null; }
      return null;
    }
    function snapAll(off) { var o = {}; for (var id in off) { var a = off[id], b = {}; PROPS.forEach(function (k) { b[k] = a[k]; }); o[id] = b; } return o; }
    function blendFrom(off, from, u) {   // 이전 자세에서 이어 붙이기(위치·회전·배율만, 투명도·그림은 바로)
      var e = smooth(u);
      for (var id in from) {
        var o = off[id], f = from[id]; if (!o) continue;
        ['x', 'y', 'sx', 'sy'].forEach(function (k) { o[k] = f[k] + (o[k] - f[k]) * e; });
        var fr = f.rot; while (fr - o.rot > 180) fr -= 360; while (o.rot - fr > 180) fr += 360;   // 360도(공중제비 끝) ↔ 0도: 가까운 쪽으로(거꾸로 돌지 않게)
        o.rot = fr + (o.rot - fr) * e;
      }
    }
    function applyKeys(c, s, off, t, K) {
      var P = c.P, cl = CP.findClip(P, K.id); if (!cl) return false;
      for (var id in off) if (/^m_/.test(id)) off[id].op = 0;   // 마우스용 얼굴 숨김
      var ub = (P.keys && P.keys.unbase) || {};
      for (var u in ub) { var ou = off[u]; if (!ou) continue; if (ub[u].op != null) ou.op = ub[u].op; if (ub[u].img != null) ou.img = { img: ub[u].img, prev: ub[u].img, mix: 1 }; }
      var pose = CP.clipPose(P, cl, K.tt);
      for (var pid in pose) {
        var o = off[pid]; if (!o) continue; var q = pose[pid];
        if (reduce && K.tap) {   // 움직임 줄이기(터치): 움직임 12%, 공중제비 없음, 새로 켜지는 그림(불꽃) 없음
          ['x', 'y', 'rot'].forEach(function (k) { if (q[k] != null && !(pid === 'flip' && k === 'rot')) o[k] += (q[k] - o[k]) * 0.12; });
          if (q.op != null && q.op < o.op) o.op = q.op; if (q.img) o.img = q.img; continue;
        }
        if (reduce) { if (q.img) o.img = q.img; continue; }   // 움직임 줄이기: 그림(감은 눈)만
        for (var j = 0; j < PROPS.length; j++) { var k = PROPS[j]; if (q[k] != null) o[k] = q[k]; }
        if (q.img) o.img = q.img;
      }
      if (reduce) for (var r in off) if (/^k_/.test(r)) off[r].op = 0;
      if (K.key !== s.kbKey) { s.kbTr = s.kbSnap ? { from: s.kbSnap, t0: t } : null; s.kbKey = K.key; s.kbId = K.id; }
      if (s.kbTr && !s.kbTr.back && (!reduce || K.tap)) { var uu = (t - s.kbTr.t0) / 0.16; if (uu < 1) blendFrom(off, s.kbTr.from, uu); else s.kbTr = null; }
      else s.kbTr = null;
      s.kbSnap = snapAll(off);
      return true;
    }

    function apply(c, off, t) {
      var s = S(c), M = c.P.mouse, P = c.P;
      // 로그인 대기 기본 상태(인트로가 끝난 뒤에만): 마우스용 얼굴 켜기·팻말 숨기기 등 { 파츠: {op, img} }
      if (M.base) for (var bp in M.base) { var ob0 = off[bp], bv = M.base[bp]; if (!ob0) continue; if (bv.op != null) ob0.op = bv.op; if (bv.img != null) ob0.img = { img: bv.img, prev: bv.img, mix: 1 }; }
      for (var kp in off) if (/^k_/.test(kp)) off[kp].op = 0;   // 키보드용 추가 파츠(길통이 볼 앞 팔)는 키보드 동작 때만
      // 키보드 반응이 가장 우선: 재생 중이면 마우스 반응·시선·깜빡임 없이 그것만
      var K = kbNow(c, s, t);
      if (K && applyKeys(c, s, off, t, K)) {
        if (s.act) s.endAt = t;
        s.act = null; s.ret = null; if (acting === c) acting = null;
        s.gx = s.gy = s.hr = s.hy = s.br = 0; s.lag = [];
        return off;
      }
      if (s.kbKey) { s.kbTr = s.kbSnap ? { from: s.kbSnap, t0: t, back: true } : null; s.kbKey = null; s.kbSnap = null; }   // 끝남 → 기본으로 이어 붙이기
      if (s.kbTr && s.kbTr.back) { var ub2 = (t - s.kbTr.t0) / 0.2; if (ub2 < 1) blendFrom(off, s.kbTr.from, ub2); else s.kbTr = null; }
      // 반응 동작
      if (s.act) {
        var tt = t - s.act.t0, cl = s.act.clip;
        if (tt >= cl.dur) { s.ret = { t0: t, dur: 0.16, from: s.last }; s.act = null; s.endAt = t; }
        else {
          var pose = CP.clipPose(P, cl, tt), u = smooth(tt / 0.16);
          for (var pid in pose) {
            var o = off[pid]; if (!o) continue; var q = pose[pid];
            for (var j = 0; j < PROPS.length; j++) { var k = PROPS[j]; if (q[k] != null) o[k] = tt < 0.16 && !/^m_/.test(pid) ? o[k] + (q[k] - o[k]) * u : q[k]; }
            if (q.img) o.img = q.img;
          }
          s.last = snapshot(off, pose);
        }
      }
      if (!s.act && s.ret) {   // 기본으로 돌아오기: 덮어썼던 속성만 그 순간 값에서 대기 자세로
        var u2 = (t - s.ret.t0) / s.ret.dur;
        if (u2 >= 1 || !s.ret.from) s.ret = null;
        else {
          var e = smooth(u2), F = s.ret.from;
          for (var id in F) {
            var o2 = off[id]; if (!o2) continue; var f = F[id], ee = /^m_/.test(id) ? smooth(u2 * 3.5) : e;   // 추가 그림(물음표 등)은 먼저 빨리 사라짐
            for (var j2 = 0; j2 < PROPS.length; j2++) { var k2 = PROPS[j2]; if (f[k2] != null) o2[k2] = f[k2] + (o2[k2] - f[k2]) * ee; }
            if (f.img && u2 < 0.3) o2.img = f.img;
          }
        }
      }
      // 시선(움직임 줄이기면 절반)
      // gaze 값: 숫자(가로 최대, 세로는 0.6배) 또는 [가로 최대, 세로 최대] — 원본 좌표
      var g = M.gaze || {}, red = reduce ? 0.5 : 1;
      for (var gp in g) { var og = off[gp]; if (!og) continue; var gv = g[gp], gxm = gv.length ? gv[0] : gv, gym = gv.length ? (gv.length > 2 && s.gy > 0 ? gv[2] : gv[1]) : gv * 0.6; og.x += s.gx * gxm * red; og.y += s.gy * gym * red; }   // [가로, 위(세로), 아래] 세 값이면 아래쪽은 따로(부리와 간격)
      if (!reduce) {
        var oh = M.head && off[M.head];
        if (oh) { oh.rot += s.hr * (M.headMax || 0); if (M.headShift) { oh.x += s.hr * M.headShift[0]; oh.y += s.hy * M.headShift[1]; } }   // 머리: 커서 쪽으로 기울고 살짝 옮김
        var ob = M.body && off[M.body]; if (ob) ob.rot += s.br * (M.bodyMax || 0);                                                      // 몸: 더 늦게 조금
        (M.lag || []).forEach(function (L, i) { var ol = off[L.part]; if (!ol) return; var v = s.lag[i] || 0; if (L.rot) ol.rot += v * L.rot; if (L.x) ol.x += v * L.x; if (L.y) ol.y += v * L.y; });
      }
      // 깜빡임(가끔, 0.14초): 눈 세로를 잠깐 눌렀다 폄. 반응 동작 중에는 동작의 눈을 그대로 둠
      if (M.blink && !s.act) {
        if (!s.blinkAt) s.blinkAt = t + 1 + Math.random() * 2;
        var bt = t - s.blinkAt;
        if (bt > 0.14) s.blinkAt = t + M.blink.every[0] + Math.random() * (M.blink.every[1] - M.blink.every[0]);
        else if (bt >= 0) { var sq = 1 - 0.88 * Math.sin(Math.PI * bt / 0.14); M.blink.parts.forEach(function (id) { if (off[id]) off[id].sy *= sq; }); }
      }
      return off;
    }
    function snapshot(off, pose) { var o = {}; for (var id in pose) if (off[id]) { var a = off[id], b = {}; PROPS.forEach(function (k) { if (pose[id][k] != null) b[k] = a[k]; }); if (pose[id].img) b.img = a.img; o[id] = b; } return o; }

    var api = {
      attach: function (it) { intro = it; },
      afterPose: function (c, off, T, after) {
        if (!after || !c.P || !c.P.mouse) { c.depthBoost = 0; return off; }
        if (T !== frameAt) { frameAt = T; frameNow = now(); tick(frameNow, intro ? intro.cast.filter(function (x) { return x.P && x.P.mouse; }) : []); }   // 한 프레임(같은 T)에 한 번
        return apply(c, off, frameNow);
      },
      state: function () { var o = {}; for (var k in st) o[k] = { act: !!st[k].act, ret: !!st[k].ret, played: st[k].played, gx: +st[k].gx.toFixed(3), dir: st[k].dir, kb: st[k].kbKey ? st[k].kbId : null, tap: st[k].tap ? st[k].tap.clip.id : null }; o.__acting = acting && acting.id; o.__keys = { mode: kb.mode, order: kb.order.map(function (c) { return c.id; }) }; o.__tap = { tracking: tap.ptr && tap.ptr.c.id, busy: tapRunning(now()) }; return o; },
      hover: hover
    };
    return api;
  }
  global.CharoLoginMouse = { create: create };
})(window);
