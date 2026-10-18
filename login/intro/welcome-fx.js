/*!
 * 환영 슬로모션 효과 (welcome-fx.js): 겨울 배경 · '환영합니다!' 문구 · 폭죽 2개 · 색종이
 * - 인트로 재생기(charo-intro.js)의 공통 시간 T를 받아 그림. 효과 시간 = 슬로모션 구간 안의 로컬 시간(0~1.6초)이고,
 *   슬로모션 길이가 바뀌면 비율대로 늘거나 줄어듦(별도 슬로모션을 또 곱하지 않음).
 * - 입자(폭죽 조각·색종이)의 위치·색·회전 속도는 만들 때 고정된 씨앗(seed)으로 한 번만 정함 → 매 프레임 무작위로 튀지 않음.
 * - 위치는 시간 T만으로 계산(타이머 없음) → 건너뛰기·재시작·되감기·창 크기 변경에도 잔상이 남지 않음.
 * - 좌표는 인트로 무대 논리 좌표(1000×600). 그림 크기는 PNG 전체가 아니라 보이는 그림(잘라낸 영역) 기준.
 */
(function (global) {
  'use strict';
  function rng(seed) { var s = seed >>> 0; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function easeOut(u) { u = clamp(u, 0, 1); return 1 - (1 - u) * (1 - u); }
  function smooth(u) { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); }

  function create(opt) {
    var M = opt.meta, base = opt.base || '', W = opt.width || 1000, H = opt.height || 600;
    var S0 = opt.slow[0], S1 = opt.slow[1], K = (S1 - S0) / 1.6;   // 기준 1.6초 → 실제 슬로모션 길이 비율
    var reduce = !!opt.reduce, mobile = !!opt.mobile;
    var IM = {}, failed = [];
    var keys = ['bg', 'title', 'ray_y', 'ray_p', 'ray_s', 'conf_y', 'conf_p', 'conf_s'];
    var ready = Promise.all(keys.map(function (k) {
      return new Promise(function (res) {
        var im = new Image(); im.onload = function () { IM[k] = im; res(); }; im.onerror = function () { failed.push(k); res(); };
        im.src = (opt.data && opt.data[k]) || (base + M[k].file);
      });
    })).then(function () { if (IM.title == null) throw new Error('환영 문구 그림을 불러오지 못함'); });   // 배경·입자가 없으면 그것만 생략

    // ── 배치(무대 정규화 좌표 → 논리 좌표) ──
    var TITLE = { cx: 0.505 * W, cy: 0.25 * H, w: 0.56 * W };                 // 보이는 문구 폭 = 무대 폭 56%
    var BG = { x: 0, w: W, h: W / (M.bg.w / M.bg.h) }; BG.y = (H - BG.h) / 2;  // 배경: 무대 폭에 맞춤(가장자리는 그림 자체가 투명)
    var BURSTS = [{ cx: 0.17 * W, cy: 0.36 * H, t0: 0.08, t1: 0.65, seed: 11 }, { cx: 0.84 * W, cy: 0.35 * H, t0: 0.20, t1: 0.75, seed: 23 }];
    var RAYK = ['ray_y', 'ray_p', 'ray_s'], CONFK = ['conf_y', 'conf_p', 'conf_s'];
    BURSTS.forEach(function (b) {          // 조각 11개: 세 색 고르게, 각도·길이·지연을 조금씩 다르게
      var r = rng(b.seed); b.rays = [];
      for (var i = 0; i < 11; i++) b.rays.push({ k: RAYK[(i + b.seed) % 3], a: (i / 11) * Math.PI * 2 + (r() - 0.5) * 0.28, len: 28 * (0.85 + r() * 0.3), d: r() * 0.04, out: 0.9 + r() * 0.25 });
    });
    // 색종이: 무대 양옆·문구 바깥 여백에서 출발(얼굴·문구·팻말 금지 구역은 출발점 선택에서 제외), 대부분 캐릭터 뒤 층
    var N = reduce ? 0 : (mobile ? 10 : 18), conf = [], r2 = rng(97);
    var ZONES = [[30, 60, 230, 280], [770, 60, 970, 280], [150, 20, 240, 70], [760, 20, 860, 70]];
    for (var i = 0; i < N; i++) {
      var z = ZONES[i % ZONES.length];
      conf.push({ k: CONFK[i % 3], x: z[0] + r2() * (z[2] - z[0]), y: z[1] + r2() * (z[3] - z[1]), up: 30 + r2() * 40, tu: 0.25 + r2() * 0.15,
        fall: 70 + r2() * 60, sway: 6 + r2() * 10, sw: 3 + r2() * 3, ph: r2() * 6.28, spin: (r2() - 0.5) * 6, a0: r2() * 6.28,
        flip: 5 + r2() * 6, fph: r2() * 6.28, len: 0.010 * W + r2() * 0.008 * W, dx: (z[0] < W / 2 ? -1 : 1) * (8 + r2() * 14),
        front: i % 6 === 5 && (z[0] < 200 || z[0] > 900) });
    }
    function local(T) { return (T - S0) / K; }             // 기준 1.6초 축의 로컬 시간
    function fadeAll(t) { return Math.min(smooth(t / 0.2), 1 - smooth((t - 1.35) / 0.25)); }   // 0~0.2 나타남, 1.35~1.6 정리

    function drawImg(ctx, k, x, y, w, h) { if (IM[k]) ctx.drawImage(IM[k], x, y, w, h); }
    function drawConf(ctx, t, front) {
      conf.forEach(function (c) {
        if (c.front !== front || !IM[c.k]) return;
        var y = t < c.tu ? c.y - c.up * (t / c.tu) * (2 - t / c.tu) : c.y - c.up + c.fall * Math.pow(t - c.tu, 1.15);   // 솟았다 천천히 낙하
        var x = c.x + c.dx * easeOut(t / 0.5) + c.sway * Math.sin(c.sw * t + c.ph);
        var fl = Math.cos(c.flip * t + c.fph), wsc = Math.max(0.15, Math.abs(fl));                   // 뒤집힘: 가로폭을 cos로(앞뒤 같은 색)
        var im = M[c.k], s = c.len / im.h;
        ctx.save(); ctx.translate(x, y); ctx.rotate(c.a0 + c.spin * t); ctx.scale(wsc * s, s);
        ctx.drawImage(IM[c.k], -im.anchor[0], -im.anchor[1], im.w, im.h); ctx.restore();
      });
    }
    var layers = { bg: true, title: true, bursts: true, confetti: true };   // 보기용 켜고 끄기(인트로 보기 탭)
    var api = {
      layers: layers,
      timeline: function () { var g = function (t) { return S0 + t * K; }; return [['배경', g(0), g(1.6)], ['문구 펼침', g(0), g(0.32)], ['문구', g(0.32), g(1.6)], ['폭죽 왼쪽', g(0.08), g(0.65)], ['폭죽 오른쪽', g(0.20), g(0.75)], ['색종이', g(0), g(1.6)], ['정리(사라짐)', g(1.35), g(1.6)]]; },
      ready: ready, failed: failed, active: function (T) { var t = local(T); return t >= 0 && t <= 1.6; },
      drawBack: function (ctx, T) {
        var t = local(T); if (t < 0 || t > 1.6) return;
        var a = fadeAll(t);
        if (layers.bg) { ctx.save(); ctx.globalAlpha = a; drawImg(ctx, 'bg', BG.x, BG.y, BG.w, BG.h); ctx.restore(); }
        if (reduce) return;
        if (layers.bursts) BURSTS.forEach(function (b) {
          b.rays.forEach(function (ry) {
            var tt = t - b.t0 - ry.d, life = b.t1 - b.t0; if (tt < 0 || tt > life || !IM[ry.k]) return;
            var u = tt / 0.5, rin = 4 + 26 * easeOut(u) * ry.out + 6 * Math.max(0, tt - 0.5), grow = 0.35 + 0.65 * easeOut(tt / 0.18);
            var al = 1 - smooth((tt - (life - 0.25)) / 0.25), droop = 10 * Math.pow(Math.max(0, u - 0.6), 2);
            var im = M[ry.k], s = ry.len * grow / im.h;
            ctx.save(); ctx.globalAlpha = al * a;
            ctx.translate(b.cx + Math.cos(ry.a) * rin, b.cy + Math.sin(ry.a) * rin + droop);
            ctx.rotate(ry.a + Math.PI / 2);                          // 원본: 뾰족한 끝(기준점)이 아래 → 끝이 중심을 향하게
            ctx.scale(s, s); ctx.drawImage(IM[ry.k], -im.anchor[0], -im.anchor[1], im.w, im.h); ctx.restore();
          });
        });
        if (layers.confetti) { ctx.save(); ctx.globalAlpha = a; drawConf(ctx, t, false); ctx.restore(); }
      },
      drawFront: function (ctx, T) {
        var t = local(T); if (t < 0 || t > 1.6 || !IM.title) return;
        if (!layers.title) { if (!reduce && layers.confetti) { ctx.save(); ctx.globalAlpha = 1 - smooth((t - 1.35) / 0.25); drawConf(ctx, t, true); ctx.restore(); } return; }
        var a = 1 - smooth((t - 1.35) / 0.25), im = M.title;
        var sc = reduce ? 1 : (t < 0.2 ? 0.88 + 0.16 * smooth(t / 0.2) : 1.04 - 0.04 * smooth((t - 0.2) / 0.12));   // 0.88 → 1.04 → 1.0 한 번만
        var w = TITLE.w * sc, h = w * im.h / im.w, x = TITLE.cx - w / 2, y = TITLE.cy - h / 2;
        var rv = reduce ? 1 : easeOut(t / 0.32);                     // 왼쪽 → 오른쪽으로 펼쳐 보이기(0.32초)
        ctx.save(); ctx.globalAlpha = reduce ? Math.min(a, smooth(t / 0.2)) : a;
        ctx.beginPath(); ctx.rect(x - 4, y - 4, (w + 8) * rv, h + 8); ctx.clip();
        ctx.drawImage(IM.title, x, y, w, h); ctx.restore();
        if (!reduce && layers.confetti) { ctx.save(); ctx.globalAlpha = a; drawConf(ctx, t, true); ctx.restore(); }
      },
      boxes: function () { var h = TITLE.w * M.title.h / M.title.w; return { title: [TITLE.cx - TITLE.w / 2, TITLE.cy - h / 2, TITLE.cx + TITLE.w / 2, TITLE.cy + h / 2], bg: [BG.x, BG.y, BG.x + BG.w, BG.y + BG.h], bursts: BURSTS.map(function (b) { return [b.cx, b.cy]; }) }; },
      setReduce: function (r) { reduce = !!r; }
    };
    return api;
  }
  global.CharoWelcomeFX = { create: create };
})(window);
