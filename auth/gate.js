/* ============================================================
   auth/gate.js — 첫 화면 로그인 잠금
   - 로그인하기 전에는 화면과 자료를 불러오지 않고, 로그인 화면만 보여 줍니다.
   - 사용: SSGate.start({ onReady: function (me) { ...앱 시작... } })
   - ⚠ 이 잠금은 "화면을 가리는 것"입니다. 이 사이트의 데이터 파일(data/*.json)은 공개 저장소에 있어서 주소를 알면 누구나 받을 수 있습니다.
     자료 자체를 보호하려면 자료를 Supabase 로 옮겨야 합니다(다음 단계). 자세한 설명: docs/login-gate.md
   ============================================================ */
(function (root) {
  'use strict';
  var A = root.SSAuth, doc = root.document, el, me = null, adminUrl = 'admin/';
  var ROLE = { admin: '관리자', branch: '피지원지사', equip: '지원장비', hq: '지역본부', viewer: '보기 전용' };
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(id) { return doc.getElementById(id); }

  function build() {
    el = doc.createElement('div'); el.id = 'ssGate'; el.className = 'ss-gate'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-label', '로그인');
    doc.body.appendChild(el);
  }
  function card(inner) { el.hidden = false; el.innerHTML = '<div class="ss-card"><span class="ss-badge">EX-SNOW-NET</span><h1>제설 업무 시스템</h1>' + inner + '</div>'; }
  function checking() { card('<p class="ss-sub"><span class="ss-spin"></span>로그인 상태를 확인하는 중…</p>'); }

  function loginView(note, noteKind) {
    var saved = A.savedUser();
    card((note ? '<div class="ss-msg ' + (noteKind || 'warn') + '" role="alert">' + esc(note) + '</div>' : '') +
      '<form id="ssForm" autocomplete="on">' +
      '<label>아이디<input id="ssU" type="text" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" value="' + esc(saved) + '"></label>' +
      '<label>비밀번호<input id="ssP" type="password" name="password" autocomplete="current-password"></label>' +
      '<label class="ss-chk"><input type="checkbox" id="ssRemember"' + (saved ? ' checked' : '') + '> 아이디 저장</label>' +
      '<label class="ss-chk"><input type="checkbox" id="ssAuto"> <span>자동 로그인</span></label>' +
      '<button class="ss-btn" id="ssGo" type="submit">로그인</button></form>');
    (saved ? $('ssP') : $('ssU')).focus();
    $('ssForm').onsubmit = function (e) {
      e.preventDefault(); var u = $('ssU').value.trim(), pw = $('ssP').value; if (!u || !pw) { loginView('아이디와 비밀번호를 입력하세요.', 'err'); return; }
      var remember = $('ssRemember').checked, auto = $('ssAuto').checked; $('ssGo').disabled = true; $('ssGo').textContent = '확인하는 중…';
      A.login(u, pw, { remember: remember, auto: auto }).then(function (r) {
        if (r.ok) return pass(r.me);
        loginView(r.message, r.reason === 'bad' ? 'err' : 'warn');
        if (remember) { $('ssRemember').checked = true; $('ssU').value = u; $('ssP').focus(); }
      });
    };
  }
  function mustChangeView() {
    card('<p class="ss-sub"><b>' + esc(me.display_name) + '</b>님, 임시 비밀번호로 로그인했습니다.</p>' +
      '<a class="ss-btn" style="display:block;text-align:center;text-decoration:none;box-sizing:border-box" href="' + adminUrl + '">새 비밀번호 정하기</a><button class="ss-btn alt" type="button" id="ssOther">다른 계정으로 로그인</button>');
    $('ssOther').onclick = function () { A.logout().then(function () { loginView(); }); };
  }
  function netView(msg) {
    card('<p class="ss-sub">서버에 연결하지 못했습니다.</p><div class="ss-msg warn">' + esc(msg) + '</div><button class="ss-btn" type="button" id="ssRetry">다시 시도</button><button class="ss-btn alt" type="button" id="ssOther" style="margin-top:8px">다른 계정으로 로그인</button>');
    $('ssRetry').onclick = function () { checking(); begin(); };
    $('ssOther').onclick = function () { A.logout().then(function () { loginView(); }); };
  }

  var onReady = null, started = false;
  function pass(profile) {
    me = profile; root.SS_ME = profile;
    root.SS_CAN = function (perm) { return A.can(me, perm); };
    if (profile.must_change) return mustChangeView();
    el.hidden = true; el.innerHTML = ''; doc.body.classList.add('authed');
    var box = $('ssUser');
    if (box) {
      box.hidden = false;
      box.innerHTML = '<span><b>' + esc(profile.display_name) + '</b> (' + esc(ROLE[profile.role] || profile.role) + ')</span>' + (profile.role === 'admin' ? '<a href="' + adminUrl + '">관리</a>' : '') + '<button type="button" id="ssLogout">로그아웃</button>';
      $('ssLogout').onclick = function () { A.logout().then(function () { root.location.replace(root.location.pathname + root.location.search); }); };   // 다시 로그인하면 첫 화면부터
    }
    if (!started) { started = true; if (onReady) onReady(profile); }
  }
  function begin() {
    if (!A.hasSession()) return loginView();
    A.restore().then(function (r) {
      if (r.ok) return pass(r.me);
      if (r.reason === 'network') return netView(r.message);
      loginView(r.message, 'warn');
    });
  }
  function start(opt) {
    opt = opt || {}; onReady = opt.onReady; if (opt.adminUrl) adminUrl = opt.adminUrl;
    build(); checking(); begin();
    // 다른 탭에서 로그아웃하면 이 탭도 로그인 화면으로
    root.addEventListener('storage', function (e) { if (e.key === 'ss_session' && !e.newValue && started) root.location.reload(); });
  }
  root.SSGate = { start: start, me: function () { return me; } };
})(window);
