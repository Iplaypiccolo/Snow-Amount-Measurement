/*!
 * 로그인 화면 마우스 반응 (charo-mouse.js) — 인트로가 끝나 친구들이 자리 잡은 뒤에만 동작
 * - 인트로 재생기(charo-intro.js)의 afterPose 연결 고리로 '대기 자세 위에' 덧붙입니다. 인트로 데이터·재생은 그대로.
 * - 캐릭터 파일의 p.mouse 설정을 읽음: { clip, dwell(초), gap(초), gaze: {파츠: 최대 이동 또는 [가로, 세로](원본 좌표)}, head, headMax(도), headShift:[가로,세로],
 *   body, bodyMax(도), blink:{parts, every:[최소,최대 초]}, dir }
 *   · 시선: 눈(과 눈썹)을 커서 쪽으로 조금, 머리는 최대 headMax 도. 시간 기반으로 부드럽게(화면 주사율과 무관)
 *   · 반응 동작: 친구 주변(0.25H 여유)에 커서가 dwell 초 머무르면 clip 을 한 번 재생(키가 있는 속성만 대기 자세 위에 덮어씀).
 *     dir:true 인 친구는 커서가 왼쪽이면 clip+'_L', 오른쪽이면 clip+'_R'(시작할 때 방향 고정, 가운데면 직전 방향, 처음이면 왼쪽).
 *   · 한 번 재생 후에는 영역을 나갔다 다시 들어와야 하고, 시작 간격은 gap 초 이상. 커서가 14px 넘게 움직이면 머무름을 다시 셈.
 *   · 동시에 한 명만. 영역이 겹치면 커서에 가장 가까운 친구. 반응 중인 친구는 맨 앞에 그림(depthBoost).
 *   · 영역을 벗어나면 현재 자세에서 0.42초 동안 기본으로 돌아옴(추가 그림은 먼저 빨리 사라짐).
 * - 막는 때: 인트로 중, 비밀번호 칸에 있을 때(시선도 끔), 아이디를 입력하는 중(1.2초), 로그인 확인 중, 터치 전용 기기.
 *   움직임 줄이기: 반응 동작 없이 작은 시선만.
 * - 키를 듣는 것은 '아이디 칸에서 입력 중인지' 여부뿐이고, 비밀번호 칸의 키·글자 수에는 전혀 반응하지 않습니다.
 */
(function (global) {
  'use strict';
  var PROPS = ['x', 'y', 'rot', 'sx', 'sy', 'op'];
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function smooth(u) { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); }

  function create(opt) {
    var CP = global.CharoPet, doc = global.document, reduce = !!opt.reduce;
    var hover = true; try { hover = global.matchMedia('(hover: hover) and (pointer: fine)').matches; } catch (e) {}
    var ptr = { x: -1e4, y: -1e4, inside: false, t: 0 }, typingAt = -1e9, intro = null, frameAt = -1, frameNow = 0, acting = null, lastNow = 0;
    var st = {};   // 친구별 상태
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
    function blocked() {
      var a = doc.activeElement;
      return { gaze: !hover || !ptr.inside || (a && a.id === opt.passField), act: !hover || reduce || !ptr.inside || (a && a.id === opt.passField) ||
        now() - typingAt < 1.2 || (opt.busy && opt.busy()) };
    }
    function S(c) {
      if (!st[c.id]) st[c.id] = { gx: 0, gy: 0, hr: 0, hy: 0, br: 0, blinkAt: 0, dwellAt: 0, dwellX: 0, dwellY: 0, played: false, lastStart: -1e9, act: null, ret: null, dir: 'L', box: null };
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
      var dt = lastNow ? Math.min(0.1, t - lastNow) : 0; lastNow = t;
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
        if (!inZone) { s.played = false; s.dwellAt = 0; if (s.act) cancel(c, s, t); return; }
        if (s.act && B.act) { cancel(c, s, t); return; }
        if (Math.hypot(ptr.x - s.dwellX, ptr.y - s.dwellY) > 14 || !s.dwellAt) { s.dwellAt = t; s.dwellX = ptr.x; s.dwellY = ptr.y; }
        var d = Math.hypot(ptr.x - cx, ptr.y - (b.y0 + b.y1) / 2) / H;
        if (d < bestD) { bestD = d; best = c; }
      });
      if (acting) { var sa = S(acting); if (!sa.act && !sa.ret) acting = null; }
      if (!acting && best && !B.act) {
        var s = S(best), M = best.P.mouse;
        if (!s.played && t - s.dwellAt >= M.dwell && t - s.lastStart >= M.gap) {
          var b = s.box, cx = (b.x0 + b.x1) / 2, w = (b.x1 - b.x0) * 0.08;
          s.dir = ptr.x < cx - w ? 'L' : ptr.x > cx + w ? 'R' : (s.dir || 'L');
          var cl = clipFor(best, s);
          if (cl) { s.act = { clip: cl, t0: t, gx: s.dir === 'L' ? -0.8 : 0.8, gy: -0.2 }; s.ret = null; s.played = true; s.lastStart = t; acting = best; }
        }
      }
      list.forEach(function (c) { var s = S(c); c.depthBoost = (s.act || s.ret) ? 10 : 0; });
    }
    function cancel(c, s, t) { if (!s.act) return; s.ret = { t0: t, dur: 0.42, from: s.last }; s.act = null; }

    function apply(c, off, t) {
      var s = S(c), M = c.P.mouse, P = c.P;
      // 반응 동작
      if (s.act) {
        var tt = t - s.act.t0, cl = s.act.clip;
        if (tt >= cl.dur) { s.ret = { t0: t, dur: 0.16, from: s.last }; s.act = null; }
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
      for (var gp in g) { var og = off[gp]; if (!og) continue; var gv = g[gp], gxm = gv.length ? gv[0] : gv, gym = gv.length ? gv[1] : gv * 0.6; og.x += s.gx * gxm * red; og.y += s.gy * gym * red; }
      if (!reduce) {
        var oh = M.head && off[M.head];
        if (oh) { oh.rot += s.hr * (M.headMax || 0); if (M.headShift) { oh.x += s.hr * M.headShift[0]; oh.y += s.hy * M.headShift[1]; } }   // 머리: 커서 쪽으로 기울고 살짝 옮김
        var ob = M.body && off[M.body]; if (ob) ob.rot += s.br * (M.bodyMax || 0);                                                      // 몸: 더 늦게 조금
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
      state: function () { var o = {}; for (var k in st) o[k] = { act: !!st[k].act, ret: !!st[k].ret, played: st[k].played, gx: +st[k].gx.toFixed(3), dir: st[k].dir }; o.__acting = acting && acting.id; return o; },
      hover: hover
    };
    return api;
  }
  global.CharoLoginMouse = { create: create };
})(window);
