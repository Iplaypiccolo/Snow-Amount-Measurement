/*!
 * 로그인 인트로 재생기 (charo-intro.js)
 * 여러 캐릭터를 하나의 공통 시간축(T초)으로 그립니다. charo-pet.js(CharoPet)가 먼저 로드돼 있어야 합니다.
 * - 시간: requestAnimationFrame 한 줄기만 사용(setTimeout으로 장면을 잇지 않음). 건너뛰기 = T를 끝으로 옮김 → 정상 종료와 같은 최종 자세.
 * - 변환 두 층: ① 바깥 층(이 파일) = 무대 위 위치·표시 크기(다가오기·대형·정렬 축소)
 *              ② 캐릭터 동작(clip) = 몸통 점프·기울기·날개·표정. 두 층을 곱해서 그림(render의 view 행렬).
 * - 캐릭터 파일의 파츠 구조(parent·pivot·rest·이미지 x/y/w/h)는 그대로 씀. CharoPet의 clipPose/offsetsFrom/finalPose/worldMatrices/render만 사용.
 * - Engine을 쓰지 않으므로 인트로 중에는 자동 깜빡임·무작위 동작·커서 따라보기·클릭/타자 반응이 끼어들 수 없음.
 * - 그림을 다 불러오지 못하면 시작하지 않음(빈 캐릭터로 재생하지 않음).
 * - 이 파일은 이벤트(마우스·키보드)를 듣지 않고, charo-pet.js처럼 스스로 화면에 붙지도 않음.
 */
(function (global) {
  'use strict';
  var EASE = {
    linear: function (u) { return u; }, 'in': function (u) { return u * u; }, out: function (u) { return 1 - (1 - u) * (1 - u); },
    inout: function (u) { return u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2; }, step: function () { return 0; }
  };
  var PROPS = ['x', 'y', 'rot', 'sx', 'sy', 'op'];
  var BLEND = 0.16;   // 동작(clip)이 바뀔 때 앞 동작 끝 자세에서 넘어오는 시간(초)

  // 바깥 층 키: [t, x, y, h, ease, depth]  (x,y = 발 위치, h = 표시 키, 논리 좌표, depth = 앞뒤 순서(클수록 앞, 없으면 z))
  function samplePlace(keys, t) {
    if (t <= keys[0][0]) return keys[0];
    for (var i = 0; i < keys.length - 1; i++) {
      var a = keys[i], b = keys[i + 1];
      if (t < b[0]) {
        var u = (t - a[0]) / (b[0] - a[0]), f = (EASE[b[4]] || EASE.inout)(u);
        var da = a[5], db = b[5];
        return [t, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f, null, (da == null || db == null) ? (da != null ? da : db) : da + (db - da) * u];
      }
    }
    return keys[keys.length - 1];
  }

  function loadAll(CP, cast) {
    return Promise.all(cast.map(function (c) {
      var got = c.data ? Promise.resolve(c.data) : fetch(c.file, { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error(c.file + ' ' + r.status); return r.json(); });
      return got.then(function (p) {
        return CP.preload(p).then(function () {
          // preload는 실패해도 넘어가므로 여기서 그림이 실제로 열렸는지 확인
          var bad = [];
          p.parts.forEach(function (pt) { pt.images.forEach(function (v) { var im = CP.imgFor(p, v.asset); if (!im || !im.complete || !im.naturalWidth) bad.push(v.asset); }); });
          if (bad.length) throw new Error(c.id + ' 그림을 불러오지 못함: ' + bad.slice(0, 5).join(', '));
          c.P = p; return c;
        });
      });
    }));
  }

  function create(opt) {
    var CP = global.CharoPet;
    if (!CP || !CP.clipPose) throw new Error('charo-pet.js가 먼저 필요합니다');
    // 같은 페이지에 자동으로 붙는 차로차로(charo-pet.js data-src, charo-fly.js)가 있으면 캐릭터가 두 벌 생김 → 알림
    var dup = !!CP.site || !!document.querySelector('script[src*="charo-fly"]');
    if (dup && global.console) console.warn('[charo-intro] 자동 실행되는 차로차로(charo-pet.js data-src 또는 charo-fly.js)가 함께 있습니다. 인트로 페이지에서는 빼 주세요.');
    var cv = opt.canvas, ctx = cv.getContext('2d');
    var W = opt.width || 1000, Hh = opt.height || 600, DUR = opt.duration;
    var cast = opt.cast, reduce = !!opt.reduce;
    var welcomed = false, state = 'loading', T = 0, t0 = 0, endAt = 0, raf = 0, paused = false, ready = null, scale = 1, ox = 0, oy = 0, err = null;
    var center = !!opt.center;   // true: 그림판이 무대(1000×600)보다 넓거나 높으면 무대를 가운데에 놓고 남는 곳에도 그림(무대 밖 좌표도 보임)

    function fit() {
      var r = cv.getBoundingClientRect(), dpr = global.devicePixelRatio || 1;
      var w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      scale = Math.min(w / W, h / Hh);   // 창 크기가 바뀌어도 논리 좌표(1000×600)는 그대로 → 배치가 변하지 않음
      ox = center ? (w - W * scale) / 2 : 0; oy = center ? (h - Hh * scale) / 2 : 0;
    }

    function segsOf(c) { return (reduce && c.reducedSegs) ? c.reducedSegs : c.segs; }
    function placeOf(c) { return (reduce && c.reducedPlace) ? c.reducedPlace : c.place; }

    // 한 캐릭터의 T초 자세(바깥 층 제외): 해당 구간 동작의 자세. 구간 사이는 대기 동작 또는 붙잡기
    function offsetsAt(c, T, after) {
      var P = c.P, segs = segsOf(c), cur = null, prev = null;
      for (var i = 0; i < segs.length; i++) {
        var s = segs[i];
        if (T >= s.t0 - 1e-9 && T <= s.t1 + 1e-9) cur = s;
        if (s.t1 <= T + 1e-9) prev = s;
      }
      function pose(s, t) { var cl = CP.findClip(P, s.clip); return CP.offsetsFrom(P, CP.clipPose(P, cl, (s.from || 0) + Math.max(0, t - s.t0) * (s.rate || 1))); }
      var off, startAt = 0, from = null, lastSeg = segs.length ? segs[segs.length - 1] : null;
      if (after && c.hold && lastSeg) off = pose(lastSeg, lastSeg.t1);       // 끝난 뒤 마지막 자세 유지(예: 티라 팻말)
      else if (cur && !after) { off = pose(cur, T); startAt = cur.t0; var pi = segs.indexOf(cur) - 1; if (pi >= 0 && Math.abs(segs[pi].t1 - cur.t0) < 1e-6) from = pose(segs[pi], segs[pi].t1); }
      else {
        var idle = CP.findClip(P, c.idle), it = (after && lastSeg && lastSeg.t1 >= DUR - 1e-6) ? (T - DUR) : T;   // 대기 동작 시간은 끊기지 않게(끝까지 이어진 동작만 0초부터)
        off = CP.offsetsFrom(P, CP.clipPose(P, idle, ((it % idle.dur) + idle.dur) % idle.dur));
        if (prev && !after) { startAt = prev.t1; from = pose(prev, prev.t1); }
        if (after && lastSeg && lastSeg.t1 >= DUR - 1e-6) { startAt = 0; from = (c.endPose = c.endPose || pose(lastSeg, lastSeg.t1)); }   // 끝까지 이어진 동작이면 그 끝 자세에서 대기로
      }
      var since = after ? (T - DUR) : (T - startAt);
      if (from && since < BLEND) {           // 동작이 바뀌는 순간 튀지 않게 앞 자세에서 넘어옴
        var u = since / BLEND; u = u * u * (3 - 2 * u);
        for (var id in off) { var o = off[id], f = from[id]; if (!f) continue;
          for (var j = 0; j < PROPS.length; j++) { var k = PROPS[j]; o[k] = f[k] + (o[k] - f[k]) * u; } }
      }
      return off;
    }

    function viewOf(c, T) {
      var pl = samplePlace(placeOf(c), Math.min(T, DUR)), s = pl[3] / c.stageH * scale;
      return [s, 0, 0, s, (pl[1] - c.anchor[0] * pl[3] / c.stageH) * scale + ox, (pl[2] - c.anchor[1] * pl[3] / c.stageH) * scale + oy];
    }

    var last = {};
    function draw() {
      fit();
      var after = state === 'wait';
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height);
      if (opt.fx) { ctx.save(); ctx.setTransform(scale, 0, 0, scale, ox, oy); opt.fx.drawBack(ctx, after ? DUR : T, api); ctx.restore(); }
      if (opt.drawBack) { ctx.save(); ctx.setTransform(scale, 0, 0, scale, ox, oy); opt.drawBack(ctx, after ? DUR : T, api); ctx.restore(); }
      var tt = after ? DUR : T;   // 앞뒤 순서: 바깥 층 depth(원근에서 가까울수록 앞) → 없으면 고정 z
      function dep(c) { var pl = samplePlace(placeOf(c), Math.min(tt, DUR)); return pl[5] != null ? pl[5] : (c.z || 0); }
      var order = cast.slice().sort(function (a, b) { return dep(a) - dep(b) || (a.z || 0) - (b.z || 0); });
      last.__order = order.map(function (c) { return c.id; });   // 이번 프레임 그린 순서(뒤 → 앞), 검사용
      order.forEach(function (c) {
        var off = offsetsAt(c, T, after), fp = CP.finalPose(c.P, off, null), v = viewOf(c, after ? DUR : T);
        CP.render(ctx, c.P, fp, CP.worldMatrices(c.P, fp), v);
        last[c.id] = { fp: fp, view: v };
      });
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1;
      if (opt.fx) { ctx.save(); ctx.setTransform(scale, 0, 0, scale, ox, oy); opt.fx.drawFront(ctx, after ? DUR : T, api); ctx.restore(); }
      if (opt.drawFront) { ctx.save(); ctx.setTransform(scale, 0, 0, scale, ox, oy); opt.drawFront(ctx, after ? DUR : T, api); ctx.restore(); }
      if (opt.onWelcome && !welcomed && opt.fx && opt.fx.active(after ? DUR : T) && state === 'play') { welcomed = true; opt.onWelcome(api); }   // 화면 낭독용 알림 한 번
    }

    function loop(now) {
      raf = global.requestAnimationFrame(loop);
      if (state === 'play' && !paused) {
        T = (now - t0) / 1000;
        if (T >= DUR) { T = DUR; finish(now); }
      } else if (state === 'wait') { T = DUR + (now - endAt) / 1000; }
      draw();
    }
    function finish(now) {
      if (state === 'wait') return;
      state = 'wait'; endAt = now || global.performance.now(); T = DUR;
      cast.forEach(function (c) { c.endPose = null; });
      if (opt.onEnd) opt.onEnd(api);
    }

    var api = {
      ready: null,
      start: function () { return ready.then(function () { state = 'play'; paused = false; T = 0; welcomed = false; t0 = global.performance.now(); cast.forEach(function (c) { c.endPose = null; }); }); },
      skip: function () { if (state === 'loading' || state === 'error') return; finish(); },     // 정상 종료와 같은 자리·자세로
      restart: function () { return api.start(); },
      seek: function (t) { if (state === 'loading' || state === 'error') return; state = 'play'; paused = true; T = Math.max(0, Math.min(DUR, t)); },
      jump: function (t) { if (state === 'loading' || state === 'error' || state === 'wait') return; state = 'play'; paused = false; T = Math.max(0, Math.min(DUR, t)); t0 = global.performance.now() - T * 1000; },   // 그 시점부터 이어서 재생(건너뛰기 → 정렬 단계부터)
      resume: function () { if (paused) { paused = false; t0 = global.performance.now() - T * 1000; } },
      setReduce: function (r) { reduce = !!r; if (opt.fx && opt.fx.setReduce) opt.fx.setReduce(reduce); },
      destroy: function () { global.cancelAnimationFrame(raf); raf = 0; state = 'done'; },
      endState: function () {   // 끝난 직후(대기 0초) 자세와 바깥 층 행렬 — 정상 종료·건너뛰기 비교용
        var o = {}; cast.forEach(function (c) { var e = c.endPose; c.endPose = null; var off = offsetsAt(c, DUR, true); c.endPose = e;
          o[c.id] = { fp: CP.finalPose(c.P, off, null), view: viewOf(c, DUR).map(function (v, i) { return (i === 4 ? v - ox : i === 5 ? v - oy : v) / scale; }) }; }); return o; },
      info: function () { return { state: state, T: T, paused: paused, reduce: reduce, duplicate: dup, error: err && String(err.message || err), last: last, geom: [scale, ox, oy] }; },   // geom: 무대 1단위 = scale 픽셀(그림판 기준), 무대 원점 = (ox, oy)
      phase: function (t) { var ph = opt.phases || [], x = ''; ph.forEach(function (p) { if (t >= p[0]) x = p[1]; }); return x; },
      cast: cast
    };
    ready = Promise.all([loadAll(CP, cast), opt.fx ? opt.fx.ready : null]).then(function () { state = 'idle'; fit(); raf = global.requestAnimationFrame(loop); },
                                   function (e) { state = 'error'; err = e; if (opt.onError) opt.onError(e); throw e; });
    api.ready = ready;
    return api;
  }
  global.CharoIntro = { create: create, samplePlace: samplePlace };
})(window);
