/* 관리자 콘솔 화면: 첫 관리자 설정 · 로그인 · 비밀번호 변경 · 계정 관리 · 접속 로그 · 수집 상태
   서버(/api/...)가 권한을 다시 검사하므로, 화면에서 버튼을 숨기는 것은 편의 기능입니다. */
(function () {
  'use strict';
  var app = document.getElementById('app'), who = document.getElementById('who'), logoutBtn = document.getElementById('logoutBtn');
  var S = { user: null, tab: 'users' };
  var ROLE = { admin: '관리자', branch: '피지원지사', equip: '지원장비' };

  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmt(iso) { if (!iso) return '-'; var d = new Date(iso); return isNaN(d) ? esc(iso) : d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }
  function p(n) { return String(n).padStart(2, '0'); }
  function msg(kind, text) { return '<div class="msg ' + kind + '" role="status">' + esc(text) + '</div>'; }

  function api(path, method, body) {
    return fetch(path, { method: method || 'GET', credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return { ok: false, message: '서버 응답을 읽을 수 없습니다.' }; }).then(function (j) { j.status = r.status; return j; }); });
  }

  function setHeader() {
    who.textContent = S.user ? S.user.display_name + ' (' + (ROLE[S.user.role] || S.user.role) + (S.user.branch ? ' · ' + S.user.branch : '') + ')' : '';
    logoutBtn.style.display = S.user ? '' : 'none';
  }

  /* ---------- 처음 화면 결정 ---------- */
  function start() {
    api('/api/me').then(function (r) {
      if (r.ok) { S.user = r.user; setHeader(); return S.user.must_change ? viewChangePw(true) : viewHome(); }
      S.user = null; setHeader();
      api('/api/setup').then(function (s) { s.needed ? viewSetup() : viewLogin(); }).catch(viewLogin);
    }).catch(function () { app.innerHTML = '<div class="card">' + msg('err', '서버에 연결할 수 없습니다.') + '</div>'; });
  }

  function viewSetup() {
    app.innerHTML = '<div class="card narrow"><h2>첫 관리자 만들기</h2><p class="hint">처음 한 번만 하는 설정입니다. Cloudflare에 넣어 둔 <b>설정 코드</b>가 필요합니다.</p><div id="m"></div>' +
      '<label>설정 코드<input id="t" type="password" autocomplete="off"></label><label>아이디 (영문 소문자·숫자, 3~32자)<input id="u" autocomplete="username"></label>' +
      '<label>표시 이름<input id="d" value="관리자"></label><label>비밀번호 (12자 이상)<input id="pw" type="password" autocomplete="new-password"></label>' +
      '<button class="primary" id="go">관리자 만들기</button></div>';
    document.getElementById('go').onclick = function () {
      api('/api/setup', 'POST', { token: v('t'), username: v('u'), display_name: v('d'), password: v('pw') }).then(function (r) {
        if (r.ok) { app.innerHTML = '<div class="card narrow">' + msg('ok', r.message) + '<button class="primary" id="gl">로그인 화면으로</button></div>'; document.getElementById('gl').onclick = start; }
        else document.getElementById('m').innerHTML = msg('err', r.message || '실패했습니다.');
      });
    };
  }
  function v(id) { return document.getElementById(id).value; }

  function viewLogin() {
    app.innerHTML = '<div class="card narrow"><h2>로그인</h2><div id="m"></div><form id="f"><label>아이디<input id="u" autocomplete="username" autofocus></label>' +
      '<label>비밀번호<input id="pw" type="password" autocomplete="current-password"></label><button class="primary" type="submit">로그인</button></form></div>';
    document.getElementById('f').onsubmit = function (e) {
      e.preventDefault();
      api('/api/login', 'POST', { username: v('u'), password: v('pw') }).then(function (r) {
        if (r.ok) { S.user = r.user; setHeader(); r.user.must_change ? viewChangePw(true) : viewHome(); }
        else document.getElementById('m').innerHTML = msg('err', r.message || '로그인에 실패했습니다.');
      });
    };
  }

  function viewChangePw(forced) {
    app.innerHTML = '<div class="card narrow"><h2>비밀번호 변경</h2>' + (forced ? '<p class="hint">임시 비밀번호로 로그인했습니다. 새 비밀번호를 정해야 계속 사용할 수 있습니다.</p>' : '') + '<div id="m"></div>' +
      '<label>현재 비밀번호<input id="c" type="password" autocomplete="current-password"></label><label>새 비밀번호 (12자 이상)<input id="n" type="password" autocomplete="new-password"></label>' +
      '<label>새 비밀번호 확인<input id="n2" type="password" autocomplete="new-password"></label><button class="primary" id="go">변경</button> ' + (forced ? '' : '<button id="bk">돌아가기</button>') + '</div>';
    if (!forced) document.getElementById('bk').onclick = viewHome;
    document.getElementById('go').onclick = function () {
      if (v('n') !== v('n2')) { document.getElementById('m').innerHTML = msg('err', '새 비밀번호 확인이 일치하지 않습니다.'); return; }
      api('/api/password', 'POST', { current: v('c'), next: v('n') }).then(function (r) {
        if (r.ok) { S.user.must_change = false; app.innerHTML = '<div class="card narrow">' + msg('ok', '비밀번호를 바꿨습니다.') + '<button class="primary" id="ok">계속</button></div>'; document.getElementById('ok').onclick = viewHome; }
        else document.getElementById('m').innerHTML = msg('err', r.message || '변경하지 못했습니다.');
      });
    };
  }

  /* ---------- 홈: 탭 ---------- */
  function viewHome() {
    var isAdmin = S.user.role === 'admin';
    var tabs = isAdmin ? [['users', '계정 관리'], ['audit', '접속 로그'], ['collector', '수집 상태'], ['me', '내 정보']] : [['me', '내 정보']];
    if (tabs.every(function (t) { return t[0] !== S.tab; })) S.tab = tabs[0][0];
    app.innerHTML = '<div class="tabs" role="tablist">' + tabs.map(function (t) { return '<button role="tab" data-t="' + t[0] + '" class="' + (S.tab === t[0] ? 'on' : '') + '">' + t[1] + '</button>'; }).join('') + '</div><div id="pane"></div>';
    app.querySelectorAll('.tabs button').forEach(function (b) { b.onclick = function () { S.tab = b.dataset.t; viewHome(); }; });
    ({ users: tabUsers, audit: tabAudit, collector: tabCollector, me: tabMe })[S.tab]();
  }
  var pane = function () { return document.getElementById('pane'); };

  function tabMe() {
    pane().innerHTML = '<div class="card"><h2>내 정보</h2><table><tr><th>아이디</th><td>' + esc(S.user.username) + '</td></tr><tr><th>이름</th><td>' + esc(S.user.display_name) + '</td></tr><tr><th>역할</th><td>' + esc(ROLE[S.user.role]) + (S.user.branch ? ' (' + esc(S.user.branch) + ')' : '') + '</td></tr></table><p><button id="cp">비밀번호 변경</button></p></div>';
    document.getElementById('cp').onclick = function () { viewChangePw(false); };
  }

  function tabUsers() {
    pane().innerHTML = '<div class="card"><h2>계정 만들기</h2><div id="m"></div><div class="row"><label>아이디<input id="nu" placeholder="예: daegwallyeong1"></label><label>표시 이름<input id="nd" placeholder="예: 대관령지사"></label>' +
      '<label>역할<select id="nr"><option value="branch">피지원지사</option><option value="equip">지원장비</option><option value="admin">관리자</option></select></label><label id="nbw">소속 지사<input id="nb" placeholder="예: 대관령"></label>' +
      '<button class="primary" id="mk">만들기</button></div><p class="hint">사람마다 개인 아이디를 만드세요. 임시 비밀번호가 한 번만 표시되고, 처음 로그인할 때 바꾸게 됩니다.</p></div>' +
      '<div class="card"><h2>계정 목록</h2><div class="tw" id="list">불러오는 중…</div></div>';
    var sync = function () { document.getElementById('nbw').style.display = v('nr') === 'branch' ? '' : 'none'; };
    document.getElementById('nr').onchange = sync; sync();
    document.getElementById('mk').onclick = function () {
      api('/api/admin/users', 'POST', { username: v('nu'), display_name: v('nd'), role: v('nr'), branch: v('nr') === 'branch' ? v('nb') : null }).then(function (r) {
        document.getElementById('m').innerHTML = r.ok ? msg('ok', '계정을 만들었습니다: ' + r.username) + tempBox(r.temp_password, r.message) : msg('err', r.message || '만들지 못했습니다.');
        if (r.ok) loadUsers();
      });
    };
    loadUsers();
  }
  function tempBox(pw, note) { return '<div class="temp">' + esc(pw) + '</div><div class="hint">' + esc(note) + '</div>'; }

  function loadUsers() {
    api('/api/admin/users').then(function (r) {
      var box = document.getElementById('list'); if (!box) return;
      if (!r.ok) { box.innerHTML = msg('err', r.message || '불러오지 못했습니다.'); return; }
      box.innerHTML = '<table><thead><tr><th>아이디</th><th>이름</th><th>역할</th><th>상태</th><th>마지막 로그인</th><th></th></tr></thead><tbody>' + r.users.map(function (u) {
        var st = u.disabled ? '<span class="tag bad">비활성</span>' : u.must_change ? '<span class="tag warn">비밀번호 변경 대기</span>' : '<span class="tag ok">사용 중</span>';
        return '<tr><td>' + esc(u.username) + '</td><td>' + esc(u.display_name) + '</td><td>' + esc(ROLE[u.role]) + (u.branch ? ' · ' + esc(u.branch) : '') + '</td><td>' + st + '</td><td>' + fmt(u.last_login_at) + '</td><td>' +
          '<button data-a="reset" data-id="' + esc(u.id) + '">비밀번호 초기화</button> ' + (u.disabled ? '<button data-a="enable" data-id="' + esc(u.id) + '">활성화</button>' : '<button class="danger" data-a="disable" data-id="' + esc(u.id) + '">비활성화</button>') + '</td></tr>';
      }).join('') + '</tbody></table>';
      box.querySelectorAll('button[data-a]').forEach(function (b) {
        b.onclick = function () {
          var a = b.dataset.a;
          if (a === 'disable' && !window.confirm('이 계정을 비활성화할까요? 즉시 로그아웃됩니다.')) return;
          if (a === 'reset' && !window.confirm('임시 비밀번호로 초기화할까요? 그 사용자의 모든 로그인이 끊깁니다.')) return;
          api('/api/admin/users/' + encodeURIComponent(b.dataset.id) + '/' + a, 'POST').then(function (x) {
            var m = document.getElementById('m');
            if (m) m.innerHTML = x.ok ? (x.temp_password ? msg('ok', '초기화했습니다: ' + x.username) + tempBox(x.temp_password, x.message) : msg('ok', '처리했습니다.')) : msg('err', x.message || '처리하지 못했습니다.');
            loadUsers();
          });
        };
      });
    });
  }

  function tabAudit() {
    pane().innerHTML = '<div class="card"><h2>접속 로그</h2><div class="row"><label>구분<select id="k"><option value="">전체</option><option>접속</option><option>접속실패</option><option>접속제한</option><option>로그아웃</option><option>계정생성</option><option>비밀번호변경</option><option>비밀번호초기화</option><option>계정비활성화</option><option>계정활성화</option><option>권한거부</option></select></label>' +
      '<label>아이디<input id="w" placeholder="전체"></label><button id="go">조회</button></div><p class="hint">기록은 서버가 남기며 이 화면에서 고치거나 지울 수 없습니다. IP는 서버가 직접 확인한 값입니다.</p><div class="tw" id="rows"></div></div>';
    var load = function () {
      var q = '?limit=200' + (v('k') ? '&kind=' + encodeURIComponent(v('k')) : '') + (v('w') ? '&username=' + encodeURIComponent(v('w').trim().toLowerCase()) : '');
      api('/api/admin/audit' + q).then(function (r) {
        var box = document.getElementById('rows');
        if (!r.ok) { box.innerHTML = msg('err', r.message || '불러오지 못했습니다.'); return; }
        box.innerHTML = '<table><thead><tr><th>일시</th><th>아이디</th><th>구분</th><th>대상</th><th>IP</th></tr></thead><tbody>' + (r.rows.map(function (x) {
          var cls = /실패|제한|거부/.test(x.kind) ? 'bad' : /접속|로그아웃/.test(x.kind) ? '' : 'warn';
          return '<tr><td>' + fmt(x.at) + '</td><td>' + esc(x.username || '-') + '</td><td><span class="tag ' + cls + '">' + esc(x.kind) + '</span></td><td>' + esc(x.target || '') + '</td><td class="mono">' + esc(x.ip || '') + '</td></tr>';
        }).join('') || '<tr><td colspan="5" class="hint">기록이 없습니다.</td></tr>') + '</tbody></table>';
      });
    };
    document.getElementById('go').onclick = load; load();
  }

  function tabCollector() {
    pane().innerHTML = '<div class="card"><h2>기상청 자료 수집 상태</h2><p class="hint">수집 Worker가 정해진 시각마다 기상청 API를 호출한 결과입니다. 성공(HTTP 200)이 계속 보이면 Cloudflare에서 기상청에 접속할 수 있다는 뜻입니다. 인증키는 가려서 표시됩니다.</p><div class="tw" id="runs">불러오는 중…</div></div>';
    api('/api/admin/collector').then(function (r) {
      var box = document.getElementById('runs');
      if (!r.ok) { box.innerHTML = msg('err', r.message || '불러오지 못했습니다.'); return; }
      box.innerHTML = '<table><thead><tr><th>시작</th><th>방식</th><th>결과</th><th>걸린 시간</th><th>응답 크기</th><th>응답 앞부분 / 오류</th></tr></thead><tbody>' + (r.runs.map(function (x) {
        return '<tr><td>' + fmt(x.started_at) + '</td><td>' + (x.source === 'cron' ? '자동' : '수동') + '</td><td><span class="tag ' + (x.ok ? 'ok' : 'bad') + '">' + (x.ok ? '성공' : '실패') + (x.http_status ? ' (' + x.http_status + ')' : '') + '</span></td><td>' + (x.ms == null ? '-' : x.ms + 'ms') + '</td><td>' + (x.bytes == null ? '-' : x.bytes + 'B') + '</td><td class="mono">' + esc(x.error || x.snippet || '') + '</td></tr>';
      }).join('') || '<tr><td colspan="6" class="hint">아직 수집 기록이 없습니다. (첫 자동 실행까지 최대 30분)</td></tr>') + '</tbody></table>';
    });
  }

  logoutBtn.onclick = function () { api('/api/logout', 'POST').then(function () { S.user = null; setHeader(); start(); }); };
  start();
})();
