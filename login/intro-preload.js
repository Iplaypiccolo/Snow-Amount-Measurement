/* ============================================================
   login/intro-preload.js — 인트로 파일 미리 받기 (2026-11-01, "인트로가 뜨기까지 너무 오래 걸림")
   - <head> 에서 가장 먼저 실행: 인트로에 쓰는 스크립트·캐릭터·효과 그림을 페이지를 여는 순간 한꺼번에 받기 시작합니다.
     (예전에는 화면 스크립트 13개 → intro-loader.js → 인트로 스크립트 → 효과 목록 → 캐릭터 순서로 차례차례 받아서 인트로가 늦게 시작됨)
   - 받기만 하고 실행·표시는 하지 않습니다. 인트로 재생은 그대로 intro-loader.js 가 합니다(같은 주소라 브라우저가 받아 둔 것을 씀).
   - 자동 로그인으로 들어오는 사람(저장된 로그인 열쇠가 있음)과 ?intro=off 는 인트로를 안 보므로 받지 않습니다.
   - 아래 V(파일 지문)는 intro-loader.js 의 V 와 같아야 합니다 — tools/build_login_intro.py 가 두 파일을 함께 갱신합니다.
   ============================================================ */
(function (root) {
  'use strict';
  var doc = root.document;
  if (/[?&]intro=off(&|$)/.test(root.location.search)) return;
  try { if (root.sessionStorage.getItem('ss_session') || root.localStorage.getItem('ss_session')) return; } catch (e) {}
  var V = /*@@V@@*/{"charo-pet.js":"0f53decd","charo-intro.js":"f1d248ad","welcome-fx.js":"5ded5479","intro-cast.js":"9d32f06a","charo-mouse.js":"57485173","charocharo":"fae19817","chumdani":"dbcb1999","giltong":"23adfb93","tira":"73ad504b","tarotaro":"42411d0f","doroduck":"43b1c2c7","fx":"99ec5eb7"};
  var BASE = 'login/intro/';
  function pre(href, as) {
    var l = doc.createElement('link'); l.rel = 'preload'; l.href = href; l.as = as;
    if (as === 'fetch') l.crossOrigin = 'anonymous';                                   // fetch() 기본(같은 출처)과 맞춰야 받아 둔 것을 씀
    doc.head.appendChild(l);
  }
  ['charo-pet.js', 'charo-intro.js', 'welcome-fx.js', 'intro-cast.js', 'charo-mouse.js'].forEach(function (f) { pre(BASE + f + '?v=' + (V[f] || ''), 'script'); });
  pre(BASE + 'assets/fx-assets.json?v=' + (V.fx || ''), 'fetch');
  ['chumdani', 'giltong', 'tira', 'tarotaro', 'charocharo', 'doroduck'].forEach(function (c) { pre(BASE + 'chars/' + c + '.json?v=' + (V[c] || ''), 'fetch'); });
  ['bg', 'title', 'ray_y', 'ray_p', 'ray_s', 'conf_y', 'conf_p', 'conf_s'].forEach(function (n) { pre(BASE + 'assets/' + n + '.webp?v=' + (V.fx || ''), 'image'); });
})(window);
