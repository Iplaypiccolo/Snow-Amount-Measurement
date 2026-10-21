/* ============================================================
   login/intro-loader.js — 새 로그인 화면(겨울 색감) + 차로차로 친구들 인트로  (2026-10-19 기본 화면으로 적용)
   - 주소에 ?intro=off 를 붙이면 아무것도 하지 않아 예전 로그인 화면이 나옵니다(문제가 생겼을 때의 비상용).
   - 로그인 판단(auth/auth.js·auth/gate.js)은 건드리지 않습니다. 화면 장식과 인트로만 얹습니다.
   - 자동 로그인으로 들어오는 사람(저장된 로그인 열쇠가 있는 경우)은 인트로를 보지 않습니다.
   - 인트로: 매번 재생. 건너뛰기 버튼·화면 아무 곳 클릭·Esc/Enter/Space 로 바로 로그인 화면.
     인트로는 화면 가운데에서 재생. 정렬 단계(5.15~5.85초)에 친구들이 작아지며 최종 자리(PC: 왼쪽 / 휴대폰: 상자 아래)로 한 번에 이동하고,
     그 순간 로그인 상자가 오른쪽(휴대폰: 위)에 나타남. 건너뛰면 정렬 단계부터 이어 재생. 로그인하면 친구들도 사라짐.
     그림을 5초 안에 다 불러오지 못하면 로그인 화면부터 보여 주고, 늦게라도 다 불러오면 친구들을 최종 자리에 바로 세움. 오류면 친구들 없이.
   - 인트로 동안 로그인 칸은 잠가 둡니다(inert) → 보이지 않는 칸에 글자가 입력되는 일이 없음.
   - 비밀번호 칸은 어떤 키·몇 글자를 입력하는지에 반응하지 않습니다(움직임 효과는 포인터 위치에만 반응).
   - 인트로 파일(login/intro/)은 tools/build_login_intro.py 가 차로차로 저장소에서 옮겨 옵니다. 아래 V 는 그 도구가 갱신하는 파일 지문.
   ============================================================ */
(function (root) {
  'use strict';
  var doc = root.document, html = doc.documentElement;
  html.classList.add('ss-ready');   // 이 파일이 실행됨 → login-v2.css 의 '잠깐 가리기'를 품(아래 CSS 설명)
  if (/[?&]intro=off(&|$)/.test(root.location.search)) return;   // 비상용: 주소 끝에 ?intro=off 를 붙이면 예전 로그인 화면(인트로 없음)
  var V = /*@@V@@*/{"charo-pet.js":"c4a84919","charo-intro.js":"cbe717c1","welcome-fx.js":"5ded5479","intro-cast.js":"9d32f06a","charo-mouse.js":"8147e7c6","charocharo":"a997d393","chumdani":"1ab99e1f","giltong":"f2526c6e","tira":"3f992a31","tarotaro":"598a985d","doroduck":"b0640986","fx":"99ec5eb7"};
  var BASE = 'login/intro/', LOAD_LIMIT = 5000;
  var MOUSE = !/[?&]mouse=off(&|$)/.test(root.location.search);   // 친구들 마우스 반응: 2026-10-19 기본으로 켬. 비상용 ?mouse=off 면 끔
  var KEYS = !/[?&]keys=off(&|$)/.test(root.location.search);     // 친구들 키보드 반응(아이디 입력·비밀번호 칸): 2026-10-20. 비상용 ?keys=off 면 끔
  var AGENT = /[?&]agent=preview(&|$)/.test(root.location.search); // 비밀번호 요원 모드(2026-10-21, 길통이만 요원 그림): 미리보기 주소에서만
  var TAP = !/[?&]tap=off(&|$)/.test(root.location.search);       // 친구 터치·클릭 반응(톡 하면 큰 동작): 2026-10-20. 비상용 ?tap=off 면 끔
  var reduce = false; try { reduce = root.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
  var mobile = Math.min(root.innerWidth, (root.screen && root.screen.width) || 9999) < 700;
  html.classList.add('ss-v2');

  // ── 배경 장면: 눈 내리는 하늘 (장식이라 화면 낭독기에서는 숨김) ──
  var scene = doc.createElement('div'); scene.id = 'ssScene'; scene.setAttribute('aria-hidden', 'true');
  scene.innerHTML =
    '<canvas class="ss-snow"></canvas>';
  doc.body.insertBefore(scene, doc.body.firstChild);
  snow(scene.querySelector('.ss-snow'));
  pointerFx();

  var gate = doc.getElementById('ssGate');
  if (!gate || !root.SSAuth || root.SSAuth.hasSession()) { reveal(); return; }   // 자동 로그인 사람은 인트로 없이
  playIntro();

  function reveal() {
    html.classList.remove('ss-intro-on');
    void html.offsetWidth;                         // 등장 움직임을 처음부터 다시
    html.classList.add('ss-reveal');
    if (gate) {
      gate.inert = false; gate.removeAttribute('inert');
      var f = doc.getElementById('ssU'), p = doc.getElementById('ssP');
      if (f && p) (f.value ? p : f).focus({ preventScroll: true });
    }
  }

  function playIntro() {
    html.classList.add('ss-intro-on');
    gate.inert = true; gate.setAttribute('inert', '');
    var ov = doc.createElement('div'); ov.id = 'ssIntro'; ov.className = 'ss-intro';
    ov.innerHTML = '<canvas role="img" aria-label="차로차로 친구들이 달려와 환영하는 인트로"></canvas>' +
      '<button type="button" class="ss-skip">건너뛰기 <kbd>Esc</kbd></button><p class="ss-sr" aria-live="polite"></p>';
    doc.body.appendChild(ov);
    var done = false, started = false, intro = null, C = null, timer = root.setTimeout(showLogin, LOAD_LIMIT);
    // 로그인 상자 보이기: 친구들이 정렬 이동을 시작하는 순간(5.15초)에. 친구들은 그대로 최종 자리까지 한 번에 이동
    function showLogin() {
      if (done) return; done = true; root.clearTimeout(timer);
      root.removeEventListener('keydown', onKey, true); ov.removeEventListener('click', skip);
      ov.classList.add('rest'); reveal();
    }
    // 건너뛰기: 정렬 이동 전이면 그 단계(5.15초)로 바로 가서 이어 재생 → 친구들은 한 번에 미끄러지듯 최종 자리로
    function skip() {
      if (!done && started && intro && intro.info().T < C.lineupT[0]) intro.jump(C.lineupT[0]);
      showLogin();
    }
    function watch() {
      if (done || !intro) return;
      var i = intro.info(); if (i.state === 'wait' || (i.state === 'play' && i.T >= C.lineupT[0])) { showLogin(); return; }
      root.requestAnimationFrame(watch);
    }
    // 최종 자리: 인트로 정렬 단계의 도착점(정렬 키)을 화면의 빈 곳으로 바꿔 넣음(크기·위치가 한 번에 바뀌게).
    // ROWB = 원래 도착점에서 친구 6명의 보이는 그림 범위(무대 좌표, 여유 3px). 무대는 화면 가운데(1000×600을 화면에 맞춤).
    var ROWB = [236, 439, 774, 588], lay = null;
    // 비밀번호 요원 대형(v3, 2026-10-21 사용자 요청): 영화처럼 '일렬로 선 친구들을 약간 사선에서 본' 구도.
    // 모두 같은 지면(발이 한 직선 위) — 그 직선이 화면 왼쪽 아래(앞, 도로덕) → 오른쪽 위(뒤, 길통이)로 완만하게(약 11도) 멀어짐.
    // 원근: 앞 친구는 조금 크게, 뒤로 갈수록 조금 작게(1.12 → 0.88). 몸통은 옆 친구와 30% 정도 겹치고, 뒤 친구가 위에 있어 얼굴은 보임.
    // 전체를 영역(PC: 로그인 상자 왼쪽 빈 곳, 휴대폰: 상자 아래)에 맞게 줄여 가운데에. 돌려주는 값: 무대 좌표 이동량(발 기준)·배율 s·앞뒤 rank
    var SLOT = ['doroduck', 'charocharo', 'tira', 'chumdani', 'tarotaro', 'giltong'];
    var AR = { doroduck: 1.0, charocharo: 1.0, tira: 1.0, chumdani: 1.07, tarotaro: 0.9, giltong: 0.73 };   // 요원 자세의 가로/세로(측정값)
    var LINE = { slope: Math.tan(11 * Math.PI / 180), near: 1.12, far: 0.88, overlap: 0.3 };
    var FACE = { doroduck: 0.6, charocharo: 0.55, tira: 0.6, chumdani: 0.55, tarotaro: 0.5, giltong: 0.68 };   // 얼굴 가운데 높이(키에 대한 비율, 시험용)
    function slots() {
      if (!lay || !C) return null;
      var vw = root.innerWidth, vh = root.innerHeight, sc = Math.min(vw / 1000, vh / 600), ox = (vw - 1000 * sc) / 2, oy = (vh - 600 * sc) / 2;
      var card = doc.querySelector('#ssGate .ss-card'), R, zoom;
      if (vw < 761) { var top = card ? card.offsetTop + card.offsetHeight + 16 : vh * 0.5; R = [10, top, vw - 10, vh - 10]; zoom = 1.6; }   // 휴대폰: 가능한 크게(영역에 맞춰 아래 fit 이 줄임)
      else { var right = card ? card.offsetLeft - Math.max(32, vw * 0.04) : vw * 0.6; R = [Math.max(24, vw * 0.04), vh * 0.14, right, vh * 0.9]; zoom = 1.35; }
      var Rs = [(R[0] - ox) / sc, (R[1] - oy) / sc, (R[2] - ox) / sc, (R[3] - oy) / sc];   // 무대 좌표
      // 발 위치(앞 친구 발 = 0,0 기준)
      var P = [], x = 0;
      SLOT.forEach(function (id, k) {
        var sk = zoom * (LINE.near + (LINE.far - LINE.near) * k / (SLOT.length - 1)), h = C.lineupH[id] * lay.s * sk, w = AR[id] * h;
        if (k) x += (1 - (vw < 761 ? LINE.overlap + 0.12 : LINE.overlap)) * (P[k - 1].w + w) / 2;   // 휴대폰은 폭이 좁아 조금 더 겹쳐 크게
        P.push({ id: id, x: x, y: -x * LINE.slope, s: sk, h: h, w: w });
      });
      var bx0 = 1e9, bx1 = -1e9, by0 = 1e9, by1 = -1e9;
      P.forEach(function (q) { bx0 = Math.min(bx0, q.x - q.w / 2); bx1 = Math.max(bx1, q.x + q.w / 2); by0 = Math.min(by0, q.y - q.h); by1 = Math.max(by1, q.y); });
      var fit = Math.min(1, (Rs[2] - Rs[0]) / (bx1 - bx0), (Rs[3] - Rs[1]) / (by1 - by0));
      var cx = (Rs[0] + Rs[2]) / 2 - (bx0 + bx1) / 2 * fit, cy = (Rs[1] + Rs[3]) / 2 - (by0 + by1) / 2 * fit;
      var o = {};
      P.forEach(function (q, k) {
        var x0 = lay.tx + (C.lineupX[q.id] - lay.rx) * lay.s, y0 = lay.ty + (C.lineupRow - lay.ry) * lay.s;
        o[q.id] = { x: cx + q.x * fit - x0, y: cy + q.y * fit - y0, s: q.s * fit, rank: k, dur: 0.7 };
      });
      return o;
    }
    function relayout() {
      if (!C) return;
      var vw = root.innerWidth, vh = root.innerHeight, sc = Math.min(vw / 1000, vh / 600), ox = (vw - 1000 * sc) / 2, oy = (vh - 600 * sc) / 2;
      var lw = (ROWB[2] - ROWB[0]) * sc, lh = (ROWB[3] - ROWB[1]) * sc, CAP = 0.92 / C.lineupRatio;   // CAP: 모두가 슬로모션 때 키보다 조금 작게 끝나도록
      var card = doc.querySelector('#ssGate .ss-card'), cb = card ? card.offsetTop + card.offsetHeight : 0, cl = card ? card.offsetLeft : vw, s, cx, cy;
      if (vw < 761) {                 // 휴대폰: 상자 아래 빈 곳의 60% 높이, 상자와 48px 이상 떨어뜨림, 폭은 화면의 85%
        var top = cb + 48, avail = vh - 16 - top;
        s = Math.min(vw * 0.85 / lw, CAP); if (lh * s > avail) s = Math.max(0.3, avail / lh);
        cx = vw / 2; cy = top + Math.max(lh * s / 2, Math.min(avail - lh * s / 2, avail * 0.6));
      } else {                        // PC: 상자 왼쪽 빈 곳의 가운데
        var left = Math.max(24, vw * 0.04), right = cl - Math.max(32, vw * 0.04);
        s = Math.min((right - left) / lw, vh * 0.5 / lh, CAP); cx = (left + right) / 2; cy = vh * 0.52;
      }
      var tx = (cx - ox) / sc, ty = (cy - oy) / sc, rx = (ROWB[0] + ROWB[2]) / 2, ry = (ROWB[1] + ROWB[3]) / 2, L1 = C.lineupT[1];
      C.cast.forEach(function (c) {
        var x = tx + (C.lineupX[c.id] - rx) * s, y = ty + (C.lineupRow - ry) * s, h = C.lineupH[c.id] * s;
        [c.place, c.reducedPlace].forEach(function (keys) { (keys || []).forEach(function (k) { if (k[0] >= L1 - 1e-6) { k[1] = x; k[2] = y; k[3] = h; } }); });
      });
      root.__ssLayout = { s: s, cx: cx, cy: cy, lw: lw * s, lh: lh * s };   // 시험용
      lay = { tx: tx, ty: ty, s: s, rx: rx, ry: ry };
    }
    // 휴대폰에서 입력하는 동안(화면 키보드가 올라와 있음)은 친구들 무대 크기를 고정하고 다시 배치하지 않음 → 줄이 갑자기 움직이지 않음.
    // 키보드에 가려지면 가려진 대로 둠(입력칸·버튼은 친구들보다 앞이라 가려지지 않음). 입력이 끝나면 다시 맞춤.
    var touch = true; try { touch = !root.matchMedia('(hover: hover) and (pointer: fine)').matches; } catch (e) {}
    var locked = false;
    function isField(a) { return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA'); }
    doc.addEventListener('focusin', function (e) {
      if (!touch || locked || !isField(e.target) || !ov.parentNode) return;
      locked = true; ov.style.height = ov.clientHeight + 'px'; ov.style.bottom = 'auto';
    });
    doc.addEventListener('focusout', function () {
      root.setTimeout(function () {
        if (!locked || isField(doc.activeElement)) return;
        locked = false; ov.style.height = ''; ov.style.bottom = ''; root.requestAnimationFrame(relayout);
      }, 250);
    });
    root.addEventListener('resize', function () { if (!locked) root.requestAnimationFrame(relayout); });
    if (AGENT && KEYS) agentScene(ov);
    function drop() { root.clearTimeout(timer); if (intro) intro.destroy(); if (ov.parentNode) ov.parentNode.removeChild(ov); }
    // 로그인하면 친구들도 정리(그리기를 멈춤)
    new root.MutationObserver(function (l, ob) { if (doc.body.classList.contains('authed')) { ob.disconnect(); drop(); } }).observe(doc.body, { attributes: true, attributeFilter: ['class'] });
    function onKey(e) { if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); skip(); } }
    root.addEventListener('keydown', onKey, true);
    ov.addEventListener('click', skip);
    load(['charo-pet.js', 'charo-intro.js', 'welcome-fx.js', 'intro-cast.js'].concat(MOUSE || KEYS || TAP ? ['charo-mouse.js'] : [])).then(function () {
      return fetch(BASE + 'assets/fx-assets.json?v=' + (V.fx || ''), { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error('fx ' + r.status); return r.json(); });
    }).then(function (meta) {
      C = root.CharoIntroCast;
      C.cast.forEach(function (c) { c.file = BASE + 'chars/' + c.id + '.json?v=' + (V[c.id] || ''); });
      Object.keys(meta).forEach(function (k) { if (meta[k] && meta[k].file) meta[k].file += '?v=' + (V.fx || ''); });
      var fx = root.CharoWelcomeFX.create({ meta: meta, base: BASE, slow: C.slow, reduce: reduce, mobile: mobile });
      var mouse = (MOUSE || KEYS || TAP) && root.CharoLoginMouse ? root.CharoLoginMouse.create({ canvas: ov.querySelector('canvas'), reduce: reduce, userField: 'ssU', passField: 'ssP', mouse: MOUSE, keys: KEYS, tap: TAP, dotClass: 'ss-tap-dot', agent: AGENT && KEYS, slots: slots,
        busy: function () { var b = doc.getElementById('ssGo'); return !!(b && b.disabled); } }) : null;   // 로그인 확인 중이면 반응 안 함
      intro = root.CharoIntro.create({
        canvas: ov.querySelector('canvas'), center: true, duration: C.duration, cast: C.cast, phases: C.phases, reduce: reduce, fx: fx,
        afterPose: mouse ? mouse.afterPose : null, drawFront: mouse && AGENT ? mouse.drawFront : null,   // 요원 모드 효과(티라 반짝·눈가루)
        onWelcome: function () { ov.querySelector('.ss-sr').textContent = '환영합니다!'; },
        onError: function () { showLogin(); drop(); }
      });
      root.__ssIntro = intro; if (mouse) { mouse.attach(intro); root.__ssMouse = mouse; }
      return intro.ready.then(function () {
        if (!ov.parentNode) return;
        root.clearTimeout(timer); relayout(); ov.classList.add('on'); started = true;
        return intro.start().then(function () { if (done) intro.skip(); else watch(); });   // 이미 로그인 화면이면(늦게 불러옴) 친구들은 바로 최종 자리
      });
    }).catch(function () { showLogin(); drop(); });
  }

  // ── 비밀번호 요원 장면: 비밀번호 칸에 있는 동안(인트로가 끝난 뒤) 배경이 어두워지고 장식용 초록 숫자가 아래에서 위로 흐름 ──
  // 숫자는 고정 시드의 장식일 뿐 비밀번호의 값·키·길이와 무관(칸에 있는지만 봄). 클릭을 막지 않음. 움직임 줄이기면 멈춘 숫자.
  function agentScene(ov) {
    var bg = doc.createElement('div'); bg.className = 'ss-agent-bg'; bg.innerHTML = '<canvas></canvas>';
    scene.appendChild(bg);
    var cv = bg.querySelector('canvas'), ctx = cv.getContext('2d'), raf = 0, on = false, offAt = 0, cols = [], w = 0, h = 0, dpr = 1, t0 = 0, seed = 11;
    function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
    function fit() {
      dpr = Math.min(2, root.devicePixelRatio || 1); w = cv.clientWidth; h = cv.clientHeight; cv.width = w * dpr; cv.height = h * dpr; cols = []; seed = 11;
      for (var x = 8; x < w; x += 22) cols.push({ x: x, y: rnd() * h, v: 26 + rnd() * 46, n: 6 + Math.floor(rnd() * 12), d: [] });
      cols.forEach(function (c) { for (var i = 0; i < 24; i++) c.d.push(Math.floor(rnd() * 10)); });
    }
    function draw(dt) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h); ctx.font = '600 14px ui-monospace,Consolas,monospace'; ctx.textAlign = 'center';
      cols.forEach(function (c) {
        c.y -= c.v * dt; if (c.y < -c.n * 18) c.y = h + 20;
        for (var i = 0; i < c.n; i++) { var a = i === 0 ? 0.85 : 0.55 * (1 - i / c.n); ctx.fillStyle = 'rgba(' + (i ? '64,200,120,' : '170,255,200,') + a.toFixed(3) + ')'; ctx.fillText(c.d[((i + Math.floor(c.y / 18)) % 24 + 24) % 24], c.x, c.y + i * 18); }
      });
    }
    function frame(now) {
      var dt = t0 ? Math.min(0.05, (now - t0) / 1000) : 0; t0 = now;
      if (!on && now - offAt > 600) { raf = 0; t0 = 0; return; }
      if (!doc.hidden) draw(dt);
      raf = root.requestAnimationFrame(frame);
    }
    function set(v) {
      if (v === on) return; on = v;
      html.classList.toggle('ss-agent', v);
      if (v) { if (!w) fit(); if (reduce) draw(0); else if (!raf) raf = root.requestAnimationFrame(frame); } else offAt = root.performance.now();
    }
    function check() { var a = doc.activeElement; set(!!(a && a.id === 'ssP') && ov.classList.contains('rest') && !doc.body.classList.contains('authed')); }
    doc.addEventListener('focusin', check); doc.addEventListener('focusout', function () { root.setTimeout(check, 0); });
    root.addEventListener('resize', function () { if (w) { fit(); if (reduce && on) draw(0); } });
  }

  function load(files) {
    return Promise.all(files.map(function (f) {
      return new Promise(function (res, rej) {
        var s = doc.createElement('script'); s.src = BASE + f + '?v=' + (V[f] || ''); s.async = false;
        s.onload = res; s.onerror = function () { rej(new Error(f)); }; doc.body.appendChild(s);
      });
    }));
  }

  // ── 눈송이: 세 겹(멀리·중간·가까이)이 다른 속도로. 탭이 안 보이거나 로그인하면 멈춤 ──
  function snow(cv) {
    var ctx = cv.getContext('2d'), flakes = [], w = 0, h = 0, dpr = 1, raf = 0, t0 = 0;
    var N = reduce ? 0 : (mobile ? 45 : 110), seed = 7;
    function rnd() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
    for (var i = 0; i < N; i++) { var z = i % 3; flakes.push({ x: rnd(), y: rnd(), z: z, r: [1.1, 1.8, 2.8][z] * (0.8 + rnd() * 0.5), v: [14, 26, 44][z] * (0.8 + rnd() * 0.4), sw: 6 + rnd() * 16, ph: rnd() * 6.28 }); }
    function fit() { dpr = Math.min(2, root.devicePixelRatio || 1); w = cv.clientWidth; h = cv.clientHeight; cv.width = w * dpr; cv.height = h * dpr; }
    function frame(now) {
      if (doc.body.classList.contains('authed')) { root.cancelAnimationFrame(raf); return; }
      raf = root.requestAnimationFrame(frame);
      if (doc.hidden) return;
      var dt = t0 ? Math.min(0.05, (now - t0) / 1000) : 0; t0 = now;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
      for (var i = 0; i < flakes.length; i++) {
        var f = flakes[i]; f.y += f.v * dt / h; if (f.y > 1.02) { f.y = -0.02; f.x = rnd(); }
        var x = f.x * w + Math.sin(now / 1000 * 0.6 + f.ph) * f.sw, y = f.y * h;
        ctx.fillStyle = COL[f.z]; ctx.beginPath(); ctx.arc(x, y, f.r, 0, 6.2832); ctx.fill();
      }
    }
    var COL = ['rgba(150,174,193,.38)', 'rgba(137,163,184,.5)', 'rgba(255,255,255,.95)'];   // 멀리는 흐린 얼음색, 가까이는 흰 눈(아래 그림자로 윤곽)
    fit(); root.addEventListener('resize', fit);
    if (N) raf = root.requestAnimationFrame(frame);
  }

  // ── 포인터 효과: 장면이 아주 조금 따라 움직임(시차) · 로그인 버튼이 포인터 쪽으로 살짝 끌려옴(자석) ──
  //    포인터 위치에만 반응하고, 키 입력에는 반응하지 않습니다.
  function pointerFx() {
    if (reduce) return;
    var px = 0, py = 0, pend = false;
    root.addEventListener('pointermove', function (e) {
      px = e.clientX; py = e.clientY; if (pend) return; pend = true;
      root.requestAnimationFrame(function () {
        pend = false;
        html.style.setProperty('--px', ((px / root.innerWidth) - 0.5).toFixed(3));
        html.style.setProperty('--py', ((py / root.innerHeight) - 0.5).toFixed(3));
        var b = doc.getElementById('ssGo'); if (!b || b.disabled) return;
        var r = b.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2, dx = px - cx, dy = py - cy;
        var near = Math.abs(dx) < r.width / 2 + 60 && Math.abs(dy) < r.height / 2 + 50;
        b.style.setProperty('--mx', near ? (dx * 0.12).toFixed(1) + 'px' : '0px');
        b.style.setProperty('--my', near ? (dy * 0.22).toFixed(1) + 'px' : '0px');
        b.style.setProperty('--gx', ((px - r.left) / r.width * 100).toFixed(1) + '%');
      });
    }, { passive: true });
  }
})(window);
