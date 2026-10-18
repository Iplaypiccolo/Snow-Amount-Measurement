/* ============================================================
   login/intro-loader.js — 새 로그인 화면(겨울 색감) + 차로차로 친구들 인트로  [미리보기 전용]
   - 지금은 주소에 ?intro=preview 가 있을 때만 동작합니다. 없으면 아무것도 하지 않아 기존 로그인 화면 그대로입니다.
   - 로그인 판단(auth/auth.js·auth/gate.js)은 건드리지 않습니다. 화면 장식과 인트로만 얹습니다.
   - 자동 로그인으로 들어오는 사람(저장된 로그인 열쇠가 있는 경우)은 인트로를 보지 않습니다.
   - 인트로: 매번 재생. 건너뛰기 버튼·화면 아무 곳 클릭·Esc/Enter/Space 로 바로 로그인 화면(친구들은 곧바로 아래 줄 자리로).
     인트로는 화면 가운데에서 재생. 끝나면 친구들 줄이 왼쪽으로 옮겨 가 대기 동작을 이어 가고, 로그인 상자는 오른쪽에 나타남.
     휴대폰(760px 미만)은 상자가 위, 친구들 줄은 가운데에서 조금 아래. 로그인하면 친구들도 사라짐.
     그림을 5초 안에 다 불러오지 못하면 로그인 화면부터 보여 주고, 늦게라도 다 불러오면 친구들을 아래 줄에 바로 세움. 오류면 친구들 없이.
   - 인트로 동안 로그인 칸은 잠가 둡니다(inert) → 보이지 않는 칸에 글자가 입력되는 일이 없음.
   - 비밀번호 칸은 어떤 키·몇 글자를 입력하는지에 반응하지 않습니다(움직임 효과는 포인터 위치에만 반응).
   - 인트로 파일(login/intro/)은 tools/build_login_intro.py 가 차로차로 저장소에서 옮겨 옵니다. 아래 V 는 그 도구가 갱신하는 파일 지문.
   ============================================================ */
(function (root) {
  'use strict';
  var doc = root.document, html = doc.documentElement;
  if (!/[?&]intro=preview(&|$)/.test(root.location.search)) return;
  var V = /*@@V@@*/{"charo-pet.js":"3751917b","charo-intro.js":"8b9feee5","welcome-fx.js":"5ded5479","intro-cast.js":"9d864092","charocharo":"d1d52d02","chumdani":"828cfe2c","giltong":"78da0fa0","tira":"677a53d8","tarotaro":"9de44863","doroduck":"742a9c73","fx":"99ec5eb7"};
  var BASE = 'login/intro/', LOAD_LIMIT = 5000;
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
    ov.innerHTML = '<div class="ss-intro-stage"><canvas role="img" aria-label="차로차로 친구들이 달려와 환영하는 인트로"></canvas></div>' +
      '<button type="button" class="ss-skip">건너뛰기 <kbd>Esc</kbd></button><p class="ss-sr" aria-live="polite"></p>';
    doc.body.appendChild(ov);
    var done = false, started = false, intro = null, timer = root.setTimeout(function () { finish(); }, LOAD_LIMIT);
    function finish() {          // 로그인 화면으로: 친구들은 아래 줄에 남김(인트로 중이면 끝 자리로 바로)
      if (done) return; done = true; root.clearTimeout(timer);
      root.removeEventListener('keydown', onKey, true); ov.removeEventListener('click', finish);
      if (started && intro) intro.skip();
      ov.classList.add('rest'); reveal(); place();
    }
    // 끝난 뒤 친구들 줄의 자리: 무대(1000×600) 안 줄의 범위 LINE 을 화면의 빈 곳에 맞춰 옮기고 키움(무대 전체를 transform)
    var LINE = [222, 498, 788, 587];   // 정렬한 친구 6명의 보이는 그림 범위(논리 좌표, intro-cast.js 정렬 값 기준·여유 4px)
    function place() {
      var st = ov.querySelector('.ss-intro-stage'), card = doc.querySelector('#ssGate .ss-card');
      if (!st || !ov.classList.contains('rest')) return;
      var k = st.offsetWidth / 1000, lw = (LINE[2] - LINE[0]) * k, lh = (LINE[3] - LINE[1]) * k, vw = root.innerWidth, vh = root.innerHeight;
      var cb = card ? card.offsetTop + card.offsetHeight : 0, cl = card ? card.offsetLeft : vw, s, cx, cy;
      if (vw < 761) {                 // 휴대폰: 상자 아래, 화면 가운데보다 조금 아래
        s = Math.min((vw - 32) / lw, 2.2); cx = vw / 2; cy = Math.max(vh * 0.62, cb + 28 + lh * s / 2); cy = Math.min(cy, vh - 16 - lh * s / 2);
      } else {                        // PC: 상자 왼쪽 빈 곳의 가운데
        var left = Math.max(24, vw * 0.04), right = cl - Math.max(32, vw * 0.04);
        s = Math.min((right - left) / lw, (vh * 0.5) / lh, 2.6); cx = (left + right) / 2; cy = vh * 0.52;
      }
      var x0 = st.offsetLeft + LINE[0] * k, y0 = st.offsetTop + LINE[1] * k;   // 줄 왼쪽 위(옮기기 전 화면 위치)
      var tx = cx - lw * s / 2 - st.offsetLeft - (x0 - st.offsetLeft) * s, ty = cy - lh * s / 2 - st.offsetTop - (y0 - st.offsetTop) * s;
      st.style.transform = 'translate(' + tx.toFixed(1) + 'px,' + ty.toFixed(1) + 'px) scale(' + s.toFixed(3) + ')';
    }
    root.addEventListener('resize', function () { root.requestAnimationFrame(place); });
    function drop() { root.clearTimeout(timer); if (intro) intro.destroy(); if (ov.parentNode) ov.parentNode.removeChild(ov); }
    // 로그인하면 친구들도 정리(화면 아래 그리기를 멈춤)
    new root.MutationObserver(function (l, ob) { if (doc.body.classList.contains('authed')) { ob.disconnect(); drop(); } }).observe(doc.body, { attributes: true, attributeFilter: ['class'] });
    function onKey(e) { if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); finish(); } }
    root.addEventListener('keydown', onKey, true);
    ov.addEventListener('click', finish);
    load(['charo-pet.js', 'charo-intro.js', 'welcome-fx.js', 'intro-cast.js']).then(function () {
      return fetch(BASE + 'assets/fx-assets.json?v=' + (V.fx || ''), { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw new Error('fx ' + r.status); return r.json(); });
    }).then(function (meta) {
      if (done) return;
      var C = root.CharoIntroCast;
      C.cast.forEach(function (c) { c.file = BASE + 'chars/' + c.id + '.json?v=' + (V[c.id] || ''); });
      Object.keys(meta).forEach(function (k) { if (meta[k] && meta[k].file) meta[k].file += '?v=' + (V.fx || ''); });
      var fx = root.CharoWelcomeFX.create({ meta: meta, base: BASE, slow: C.slow, reduce: reduce, mobile: mobile });
      intro = root.CharoIntro.create({
        canvas: ov.querySelector('canvas'), duration: C.duration, cast: C.cast, phases: C.phases, reduce: reduce, fx: fx,
        onWelcome: function () { ov.querySelector('.ss-sr').textContent = '환영합니다!'; },
        onEnd: function () { root.setTimeout(finish, 350); },
        onError: function () { finish(); drop(); }
      });
      root.__ssIntro = intro;
      return intro.ready.then(function () {
        if (!ov.parentNode) return;
        root.clearTimeout(timer); ov.classList.add('on'); started = true;
        return intro.start().then(function () { if (done) intro.skip(); });   // 이미 로그인 화면이면(늦게 불러옴) 바로 끝 자리
      });
    }).catch(function () { finish(); drop(); });
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
